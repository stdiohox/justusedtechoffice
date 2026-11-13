import { useEffect } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/**
 * Notices, time off, rooms, team chat and insights (0021). Every read here
 * waits for useExtrasAvailable(): until the migration is applied the pages
 * and their nav entries stay hidden, so this frontend can ship first.
 */

export const extrasKeys = {
  all: ['extras'] as const,
  // Not under `all`: a chat message landing must not re-run the probe.
  available: ['extras-available'] as const,
}

/** Postgres / PostgREST codes for "no such table". */
const MISSING = new Set(['42P01', 'PGRST205'])

/**
 * Whether 0021 is applied: true, false, or undefined while unknown. Checked
 * once per sign-in and kept a while, like the other "is it applied" reads.
 */
export function useExtrasAvailable(): boolean | undefined {
  const signedIn = useAuthStore((s) => !!s.profile)
  const { data } = useQuery({
    queryKey: extrasKeys.available,
    enabled: signedIn,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<boolean> => {
      const { error } = await supabase.from('office_rooms').select('id').limit(0)
      if (error?.code && MISSING.has(error.code)) return false
      if (error) throw new Error(error.message)
      return true
    },
  })
  return data
}

interface ReadOptions {
  enabled?: boolean
  /** Poll as a fallback for a dropped Realtime channel. Only while the tab is visible. */
  live?: boolean
  /** Keep the old rows up while a new parameter's rows load (a date range, a day count). Never for a chat. */
  keep?: boolean
}

function useExtra<T>(name: string, read: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, { enabled = true, live = false, keep = false }: ReadOptions = {}) {
  const signedIn = useAuthStore((s) => !!s.profile)
  const on = useExtrasAvailable()
  return useQuery({
    queryKey: [...extrasKeys.all, name],
    enabled: signedIn && on === true && enabled,
    staleTime: 15_000,
    refetchInterval: live ? 60_000 : false,
    placeholderData: keep ? keepPreviousData : undefined,
    queryFn: async () => {
      const { data, error } = await read()
      if (error) throw new Error(error.message)
      return data as T
    },
  })
}

function useCall<T>(call: (input: T) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => {
      const { data, error } = await call(input)
      if (error) throw new Error(error.message)
      return data
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: extrasKeys.all }),
  })
}

/** Which reads a change to each table can move. */
const TABLE_KEYS: Record<string, string[]> = {
  office_notices: ['notices'],
  office_notice_reads: ['notices'],
  office_leave_requests: ['leave', 'off', 'insights-'],
  office_bookings: ['bookings-'],
  office_room_occupants: ['occupants', 'room-code-', 'room-messages'],
  office_room_messages: ['room-messages'],
  office_room_invites: ['room-invites'],
  office_channel_messages: ['chat-'],
}

const channelName = () =>
  `office-extras-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`

/**
 * One channel for all of 0021's tables: any change a person may see
 * (Realtime applies the same policies as a read) refreshes the reads that
 * table feeds. Mounted once, in the shell, while the person is signed in.
 */
export function useExtrasRealtime() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.profile?.id)
  const on = useExtrasAvailable()
  useEffect(() => {
    if (!userId || !on) return
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const prefixes = [...pending]
      pending.clear()
      void queryClient.invalidateQueries({
        queryKey: extrasKeys.all,
        predicate: (q) => {
          const name = q.queryKey[1]
          return typeof name === 'string' && prefixes.some((p) => name.startsWith(p))
        },
      })
    }
    const refresh = (prefixes: string[]) => {
      // Several rows land together (a room emptying): one refetch, not five.
      for (const p of prefixes) pending.add(p)
      if (!timer) timer = setTimeout(flush, 250)
    }
    // A fresh name each time: supabase.channel() hands back a same-named
    // channel that is still tearing down.
    let channel = supabase.channel(channelName())
    for (const [table, prefixes] of Object.entries(TABLE_KEYS)) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => refresh(prefixes))
    }
    channel.subscribe((status) => {
      // Joined, or joined again after a drop: anything that landed in the gap is fetched now.
      if (status === 'SUBSCRIBED') refresh(Object.values(TABLE_KEYS).flat())
    })
    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [userId, on, queryClient])
}

/* notices */
export interface Notice {
  id: string
  title: string
  body: string
  pinned: boolean
  needs_read: boolean
  author: string
  created_at: string
  reads: { user_id: string; read_at: string }[]
}
export const useNotices = () =>
  useExtra<Notice[]>('notices', () =>
    supabase.from('office_notices').select('*, reads:office_notice_reads (user_id, read_at)').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(200),
  )
export const usePostNotice = () =>
  useCall((i: { title: string; body: string; pinned: boolean; needs_read: boolean; author: string }) => supabase.from('office_notices').insert(i))
/** Already marked from another tab: that is fine, not an error. */
export const useReadNotice = () =>
  useCall((i: { notice_id: string; user_id: string }) => supabase.from('office_notice_reads').upsert(i, { onConflict: 'notice_id,user_id', ignoreDuplicates: true }))
export const useRemoveNotice = () => useCall((id: string) => supabase.from('office_notices').delete().eq('id', id))

/* time off */
export type LeaveKind = 'annual' | 'sick' | 'personal'
export interface LeaveRequest {
  id: string
  user_id: string
  kind: LeaveKind
  starts_on: string
  ends_on: string
  note: string | null
  status: 'pending' | 'approved' | 'declined' | 'cancelled'
  decided_by: string | null
  decision_note: string | null
  created_at: string
}
export const useLeave = (enabled = true) =>
  useExtra<LeaveRequest[]>('leave', () => supabase.from('office_leave_requests').select('*').order('starts_on', { ascending: false }).limit(300), { enabled })
export interface WhoIsOff {
  user_id: string
  starts_on: string
  ends_on: string
}
export const useWhoIsOff = () => useExtra<WhoIsOff[]>('off', () => supabase.rpc('office_who_is_off'))
export const useRequestLeave = () =>
  useCall((i: { kind: LeaveKind; from: string; to: string; note: string }) =>
    supabase.rpc('request_leave', { p_kind: i.kind, p_from: i.from, p_to: i.to, p_note: i.note || null }),
  )
export const useDecideLeave = () =>
  useCall((i: { id: string; approve: boolean; note?: string }) => supabase.rpc('decide_leave', { p_id: i.id, p_approve: i.approve, p_note: i.note || null }))
export const useCancelLeave = () => useCall((id: string) => supabase.rpc('cancel_leave', { p_id: id }))

/* rooms */
export interface Room {
  id: string
  name: string
  capacity: number
  purpose: string
}
export interface Booking {
  id: string
  room_id: string
  title: string
  starts_at: string
  ends_at: string
  booked_by: string
}
export interface Occupant {
  user_id: string
  room_id: string
  joined_at: string
}
export const useRooms = () => useExtra<Room[]>('rooms', () => supabase.from('office_rooms').select('*').order('capacity', { ascending: false }))
export const useBookings = (since: string) =>
  useExtra<Booking[]>(`bookings-${since}`, () => supabase.from('office_bookings').select('*').gte('ends_at', since).order('starts_at').limit(200), { keep: true })
export const useOccupants = () => useExtra<Occupant[]>('occupants', () => supabase.from('office_room_occupants').select('user_id, room_id, joined_at'), { live: true })
export const useBookRoom = () =>
  useCall((i: { room: string; title: string; start: string; end: string }) =>
    supabase.rpc('book_room', { p_room: i.room, p_title: i.title, p_start: i.start, p_end: i.end }),
  )
export const useCancelBooking = () => useCall((id: string) => supabase.rpc('cancel_booking', { p_id: id }))
export type EnterAnswer = 'in' | 'out' | 'needs_code' | 'wrong_code' | 'locked'
const ANSWERS = new Set<string>(['in', 'out', 'needs_code', 'wrong_code', 'locked'])
/** Step in (with a code if asked) or, with room null, out. Out also forgets the room's words and code here. */
export function useEnterRoom() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (i: { room: string | null; code?: string }): Promise<EnterAnswer> => {
      const { data, error } = await supabase.rpc('enter_room', { p_room: i.room, p_code: i.code ?? null })
      if (error) throw new Error(error.message)
      if (typeof data !== 'string' || !ANSWERS.has(data)) throw new Error('The door gave an unexpected answer. Reload and try again.')
      return data as EnterAnswer
    },
    onSuccess: (answer) => {
      if (answer !== 'out') return
      // Readable only while inside: nothing of the room stays in this browser's cache.
      void queryClient.removeQueries({
        queryKey: extrasKeys.all,
        predicate: (q) => typeof q.queryKey[1] === 'string' && (q.queryKey[1] === 'room-messages' || q.queryKey[1].startsWith('room-code-')),
      })
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: extrasKeys.all }),
  })
}
/** "Still here", while the room is open on screen (the server sweeps anyone unseen for 10 minutes). */
export const useTouchRoom = () => useCall(() => supabase.rpc('touch_room'))
/** Readable only from inside the room. */
export const useRoomCode = (room: string) =>
  useExtra<{ code: string } | null>(`room-code-${room}`, () => supabase.from('office_room_codes').select('code').eq('room_id', room).maybeSingle())

/* talking in a room, and asking people in */
export interface RoomMessage {
  id: number
  room_id: string
  sender: string
  body: string
  created_at: string
}
export interface RoomInvite {
  id: string
  room_id: string
  from_user: string
  to_user: string
  status: 'pending' | 'accepted' | 'declined'
  created_at: string
  expires_at: string
}
/** The latest 300, oldest first. No previous data: one room's words must never show, even for a moment, in another. */
export function useRoomMessages(room: string | null) {
  const signedIn = useAuthStore((s) => !!s.profile)
  const on = useExtrasAvailable()
  return useQuery({
    queryKey: [...extrasKeys.all, 'room-messages', room],
    enabled: signedIn && on === true && !!room,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('office_room_messages')
        .select('*')
        .eq('room_id', room!)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(300)
      if (error) throw new Error(error.message)
      return ((data ?? []) as RoomMessage[]).reverse()
    },
  })
}
export const usePostRoomMessage = () =>
  useCall((i: { room_id: string; body: string; sender: string }) => supabase.from('office_room_messages').insert(i))
export const useRoomInvites = () =>
  useExtra<RoomInvite[]>('room-invites', () => supabase.from('office_room_invites').select('*').order('created_at', { ascending: false }).limit(100), { live: true })
export const useRespondRoomInvite = () =>
  useCall((i: { id: string; accept: boolean }) => supabase.rpc('respond_room_invite', { p_id: i.id, p_accept: i.accept }))
/** Invite, then ask the server to email. The email is best effort: the invite stands either way. */
export const useInviteToRoom = () =>
  useCall(async (to: string) => {
    const made = await supabase.rpc('invite_to_room', { p_to: to })
    if (made.error) return made
    const { data: session } = await supabase.auth.getSession()
    const token = session.session?.access_token
    if (token) {
      await fetch('/api/office/room-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inviteId: made.data }),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null)
    }
    return made
  })

/* team chat */
export type Channel = 'general' | 'wins' | 'help'
export interface ChannelMessage {
  id: number
  channel: Channel
  sender: string
  body: string
  created_at: string
}
export const useChannel = (channel: Channel) =>
  useExtra<ChannelMessage[]>(
    `chat-${channel}`,
    () => supabase.from('office_channel_messages').select('*').eq('channel', channel).order('created_at', { ascending: false }).limit(100),
    { live: true },
  )
export const usePostMessage = () =>
  useCall((i: { channel: Channel; body: string; sender: string }) => supabase.from('office_channel_messages').insert(i))

/* insights */
export interface InsightsDay {
  day: string
  due: number
  on_time: number
  late: number
  missed: number
  tasks_approved: number
}
export interface InsightsPerson {
  user_id: string
  full_name: string
  job_title: string | null
  due: number
  filed: number
  on_time: number
  late: number
  missed: number
  tasks_approved: number
  tasks_overdue: number
  avg_stars: number | null
}
export interface Insights {
  from: string
  to: string
  days: number
  totals: { due: number; on_time: number; late: number; missed: number; tasks_approved: number; tasks_overdue: number; avg_stars: number | null }
  open_tasks: number
  waiting_review: number
  pending_leave: number
  by_day: InsightsDay[]
  by_person: InsightsPerson[]
}
export const useInsights = (days: number, enabled: boolean) =>
  useExtra<Insights>(`insights-${days}`, () => supabase.rpc('office_insights', { p_days: days }), { enabled, keep: true })
