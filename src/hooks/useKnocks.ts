import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/**
 * Knocking (0005): a request to come into someone's office, answered with
 * yes or no; yes opens a short text chat between the two. Every change goes
 * through an RPC; reads are RLS-limited to the two people involved.
 */

export type KnockStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'

export interface Knock {
  id: string
  from_user: string
  to_user: string
  status: KnockStatus
  created_at: string
  expires_at: string
  responded_at: string | null
  ended_at: string | null
  pinged_at: string | null
  /** 0010: what came with "not now" ("On a call"). Absent before it. */
  reply?: string | null
}

export interface ChatMessage {
  id: number
  knock_id: string
  sender: string
  body: string
  created_at: string
}

/** A chat closes itself this long after it opened (0005). */
export const CHAT_MINUTES = 60

export const knockKeys = {
  all: ['knocks'] as const,
  mine: (userId: string) => ['knocks', 'mine', userId] as const,
  missed: (userId: string, since: string) => ['knocks', 'missed', userId, since] as const,
  chat: (knockId: string) => ['knocks', 'chat', knockId] as const,
}

export const isWaiting = (k: Knock, now: number) => k.status === 'pending' && Date.parse(k.expires_at) > now

/** Nobody answered: still pending past its deadline, or marked lapsed when the knocker tried again. */
export const isMissed = (k: Knock, now: number) =>
  k.status === 'expired' || (k.status === 'pending' && Date.parse(k.expires_at) <= now)

export const isChatOpen = (k: Knock, now: number) =>
  k.status === 'accepted' && !k.ended_at && !!k.responded_at && Date.parse(k.responded_at) + CHAT_MINUTES * 60_000 > now

/** The last two hours of knocks to or from me: enough for anything still live. */
export function useMyKnocks(enabled: boolean) {
  const userId = useAuthStore((s) => s.profile?.id)
  return useQuery({
    queryKey: knockKeys.mine(userId ?? ''),
    enabled: enabled && !!userId,
    queryFn: async (): Promise<Knock[]> => {
      const since = new Date(Date.now() - 2 * 3_600_000).toISOString()
      const { data, error } = await supabase
        .from('office_knocks')
        .select('*')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      return (data ?? []) as Knock[]
    },
  })
}

/** One subscription for the session, mounted with the knock layer. */
export function useKnocksRealtime(enabled: boolean) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    // A fresh name each time: supabase.channel() hands back a same-named
    // channel that is still being removed (StrictMode, a quick gate flip).
    const channel = supabase
      .channel(`office-knocks-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_knocks' }, () => {
        void queryClient.invalidateQueries({ queryKey: knockKeys.all })
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, queryClient])
}

function useKnockRpc<T>(fn: (input: T) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => {
      const { data, error } = await fn(input)
      if (error) throw new Error(error.message)
      return data
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: knockKeys.all })
    },
  })
}

/**
 * Knock, and if the other person is not in the office, ask the server to
 * email them. The email is best effort: the knock stands either way.
 */
export function useKnock() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ to, offline }: { to: string; offline: boolean }) => {
      const { data, error } = await supabase.rpc('knock', { p_to: to })
      if (error) throw new Error(error.message)
      if (!offline) return { pinged: false }
      const { data: session } = await supabase.auth.getSession()
      const accessToken = session.session?.access_token
      if (!accessToken) return { pinged: false }
      const res = await fetch('/api/office/knock-ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ knockId: data }),
      }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { sent?: boolean } | null
      return { pinged: !!res?.ok && body?.sent === true }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: knockKeys.all })
      // A first knock is a first step (0010). ['office', 'onboarding'], kept literal: no import cycle.
      void queryClient.invalidateQueries({ queryKey: ['office', 'onboarding'] })
    },
  })
}

/** PostgREST / Postgres: "no function with those arguments" (0010 not applied). */
const NO_FUNCTION = new Set(['42883', 'PGRST202'])

/**
 * Let in or not now, with an optional reply on "not now" (0010). The reply is
 * only sent when there is one; a database without 0010 refuses it, and the
 * answer then goes without it rather than not at all.
 */
export const useRespondKnock = () =>
  useKnockRpc(async ({ id, accept, reply }: { id: string; accept: boolean; reply?: string }) => {
    if (!reply) return supabase.rpc('respond_knock', { p_id: id, p_accept: accept })
    const first = await supabase.rpc('respond_knock', { p_id: id, p_accept: accept, p_reply: reply })
    if (first.error?.code && NO_FUNCTION.has(first.error.code)) {
      return supabase.rpc('respond_knock', { p_id: id, p_accept: accept })
    }
    return first
  })

/**
 * Knocks on my door today that nobody answered, newest first. Read from the
 * start of the office day (`since`), so it outlasts the two hours of
 * useMyKnocks. RLS: knocks I sent or received only.
 */
export function useMissedKnocks(since: string, enabled: boolean) {
  const userId = useAuthStore((s) => s.profile?.id)
  return useQuery({
    queryKey: knockKeys.missed(userId ?? '', since),
    enabled: enabled && !!userId,
    queryFn: async (): Promise<Knock[]> => {
      const { data, error } = await supabase
        .from('office_knocks')
        .select('*')
        .eq('to_user', userId!)
        .in('status', ['pending', 'expired'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw error
      const now = Date.now()
      return ((data ?? []) as Knock[]).filter((k) => isMissed(k, now))
    },
    // A knock lapses on its own clock, with nothing written: look again now and then.
    refetchInterval: 60_000,
  })
}

export const useCancelKnock = () => useKnockRpc((id: string) => supabase.rpc('cancel_knock', { p_id: id }))

export const useEndChat = () => useKnockRpc((id: string) => supabase.rpc('end_knock_chat', { p_id: id }))

/* ----------------------------------------------------------------- chat */

export function useChatMessages(knockId: string | null) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: knockKeys.chat(knockId ?? ''),
    enabled: !!knockId,
    queryFn: async (): Promise<ChatMessage[]> => {
      const { data, error } = await supabase
        .from('office_chat_messages')
        .select('*')
        .eq('knock_id', knockId!)
        .order('id')
        .limit(500)
      if (error) throw error
      return (data ?? []) as ChatMessage[]
    },
  })

  useEffect(() => {
    if (!knockId) return
    const channel = supabase
      .channel(`office-chat-${knockId}-${crypto.randomUUID()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'office_chat_messages', filter: `knock_id=eq.${knockId}` },
        () => void queryClient.invalidateQueries({ queryKey: knockKeys.chat(knockId) }),
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [knockId, queryClient])

  return query
}

export function useSendMessage(knockId: string) {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.profile?.id)
  return useMutation({
    mutationFn: async (body: string) => {
      const { error } = await supabase
        .from('office_chat_messages')
        .insert({ knock_id: knockId, sender: userId, body: body.trim() })
      if (error) {
        // The insert policy refuses a closed chat; say that, not "RLS".
        throw new Error(error.code === '42501' ? 'This chat has closed.' : error.message)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: knockKeys.chat(knockId) })
      void queryClient.invalidateQueries({ queryKey: knockKeys.all })
    },
  })
}
