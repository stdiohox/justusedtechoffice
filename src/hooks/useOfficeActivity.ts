import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { officeKeys } from '@/hooks/useOffice'
import { useAuthStore } from '@/stores/authStore'
import type { OfficeDayNote, OfficeEntry, OfficeMyState, OfficeTimeDay } from '@/types/database'

/**
 * Office activity (0008, 0009): the person's own state (gate, do not
 * disturb, working elsewhere, check-ins), "I'm back", day notes, the time
 * summary and Mr Tito's switch from trial to enforced. Every read degrades
 * to "not available" while the migration is not applied, so this frontend
 * can ship first and the office keeps working as before.
 */

/** PostgREST / Postgres codes for "that table or function does not exist". */
const MISSING = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])
const isMissing = (error: { code?: string } | null) => !!error?.code && MISSING.has(error.code)

export const activityKeys = {
  state: (userId: string) => [...officeKeys.all, 'activity', 'state', userId] as const,
  summary: (from: string, to: string) => [...officeKeys.all, 'activity', 'summary', from, to] as const,
  notes: (from: string, to: string) => [...officeKeys.all, 'activity', 'notes', from, to] as const,
  entries: (date: string) => [...officeKeys.all, 'activity', 'entries', date] as const,
}

export type MyState = { available: false } | ({ available: true; skew: number } & OfficeMyState)

/**
 * The server's state for the signed-in person. `skew` is the server's clock
 * minus this browser's, so deadlines can be shown on this clock.
 */
export function useMyOfficeState(userId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: activityKeys.state(userId ?? ''),
    enabled: enabled && !!userId,
    queryFn: async (): Promise<MyState> => {
      const asked = Date.now()
      const { data, error } = await supabase.rpc('office_my_state')
      if (isMissing(error)) return { available: false }
      if (error) throw error
      const before = queryClient.getQueryData<MyState>(activityKeys.state(userId ?? ''))
      return toState(data, asked, before?.available ? before.skew : undefined)
    },
    // Midnight, a sign-out by the sweep, a check-in issued: all server-side.
    refetchInterval: 60_000,
  })
}

/**
 * The server's state, with `skew` (server clock minus this browser's) to the
 * nearest second. A new reading within two seconds of the last one keeps the
 * last: round-trip jitter would otherwise move every deadline a little on
 * each refetch and restart every timer that depends on them.
 */
function toState(data: unknown, asked: number, previousSkew: number | undefined): MyState {
  const raw = data as OfficeMyState | null
  if (!raw || typeof raw.now !== 'string') throw new Error('The office answered in an unexpected shape. Reload the page.')
  // The midpoint of the round trip is the best guess at "when the server read now".
  const measured = Date.parse(raw.now) - (asked + Date.now()) / 2
  const fresh = Number.isFinite(measured) ? Math.round(measured / 1000) * 1000 : 0
  const skew = previousSkew !== undefined && Math.abs(fresh - previousSkew) < 2000 ? previousSkew : fresh
  return { ...raw, available: true, skew }
}

/** The person's own check-ins arrive as they are issued (RLS: own rows only). */
export function useCheckinRealtime(userId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled || !userId) return
    // A fresh name per mount, as for the doors (useOfficeStatus).
    const channel = supabase
      .channel(`office-checkins-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_checkins', filter: `user_id=eq.${userId}` }, () => {
        void queryClient.invalidateQueries({ queryKey: activityKeys.state(userId) })
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, userId, queryClient])
}

/**
 * A write that answers with the new state, which replaces the cached one.
 * Whose state it is, is fixed when the write is sent: a sign-out and a new
 * sign-in on this browser mid-write cannot file it under the next person.
 */
function useStateWrite<T>(call: (input: T) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => {
      const userId = useAuthStore.getState().profile?.id
      const asked = Date.now()
      const { data, error } = await call(input)
      if (error) throw new Error(error.message)
      const before = userId ? queryClient.getQueryData<MyState>(activityKeys.state(userId)) : undefined
      return { userId, state: toState(data, asked, before?.available ? before.skew : undefined) }
    },
    onSuccess: ({ userId, state }) => {
      if (userId) queryClient.setQueryData(activityKeys.state(userId), state)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [...officeKeys.all, 'activity'] })
    },
  })
}

export type ModeInput = { mode: 'busy'; minutes: number } | { mode: 'outside' } | { mode: 'none' }

export const useSetOfficeMode = () =>
  useStateWrite((m: ModeInput) =>
    supabase.rpc('set_office_mode', { p_mode: m.mode, p_minutes: m.mode === 'busy' ? m.minutes : null }),
  )

export const useAnswerCheckin = () =>
  useStateWrite(({ id, keepGoing }: { id: string; keepGoing: boolean }) =>
    supabase.rpc('answer_checkin', { p_id: id, p_continue: keepGoing }),
  )

export const useRejoinOffice = () =>
  useStateWrite((note: string) => supabase.rpc('office_rejoin', { p_note: note.trim() || null }))

export const useLeaveOffice = () => useStateWrite((_: void) => supabase.rpc('office_leave'))

/* ------------------------------------------------------- time summary */

export interface Available<T> {
  available: boolean
  rows: T[]
}

/**
 * office_time_summary(): Mr Tito gets every member but himself, anyone else
 * only their own days. Figures are worked out on the server.
 */
export function useTimeSummary(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: activityKeys.summary(from, to),
    enabled,
    queryFn: async (): Promise<Available<OfficeTimeDay>> => {
      const { data, error } = await supabase.rpc('office_time_summary', { p_from: from, p_to: to })
      if (isMissing(error)) return { available: false, rows: [] }
      if (error) throw error
      return { available: true, rows: (data ?? []) as OfficeTimeDay[] }
    },
    // Today's figures move; past days do not, but one refetch a minute is cheap.
    refetchInterval: 60_000,
  })
}

/** Day notes in a range (RLS: own, or everyone's for Mr Tito). */
export function useDayNotes(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: activityKeys.notes(from, to),
    enabled,
    queryFn: async (): Promise<Available<OfficeDayNote>> => {
      const { data, error } = await supabase
        .from('office_day_notes')
        .select('id, user_id, work_date, body, created_at')
        .gte('work_date', from)
        .lte('work_date', to)
        .order('created_at')
      if (isMissing(error)) return { available: false, rows: [] }
      if (error) throw error
      return { available: true, rows: (data ?? []) as OfficeDayNote[] }
    },
  })
}

export function useAddDayNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ date, body }: { date: string; body: string }) => {
      const { error } = await supabase.rpc('add_day_note', { p_date: date, p_body: body })
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [...officeKeys.all, 'activity', 'notes'] })
    },
  })
}

/** One day's stays (RLS: own, or everyone's for Mr Tito). */
export function useEntries(date: string, enabled: boolean) {
  return useQuery({
    queryKey: activityKeys.entries(date),
    enabled,
    queryFn: async (): Promise<Available<OfficeEntry>> => {
      const { data, error } = await supabase
        .from('office_entries')
        .select('id, user_id, work_date, entered_at, entered_by, back_note, left_at, left_reason')
        .eq('work_date', date)
        .order('id')
      if (isMissing(error)) return { available: false, rows: [] }
      if (error) throw error
      return { available: true, rows: (data ?? []) as OfficeEntry[] }
    },
    refetchInterval: 60_000,
  })
}

/** Trial or enforced. Mr Tito only; the function refuses anyone else. */
export function useSetEnforcement() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (on: boolean) => {
      const { error } = await supabase.rpc('set_office_enforcement', { p_on: on })
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: officeKeys.all })
    },
  })
}

/** Short day (0010): working minutes under which a signed-in day reads "short"; null is off. Mr Tito only. */
export function useSetShortDay() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (minutes: number | null) => {
      const { error } = await supabase.rpc('set_short_day', { p_minutes: minutes })
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: officeKeys.settings() })
    },
  })
}
