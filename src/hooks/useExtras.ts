import { useEffect } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/**
 * Notices, time off, rooms, team chat and insights (0021). Every read here
 * waits for useExtrasAvailable(): until the migration is applied the pages
 * and their nav entries stay hidden, so this frontend can ship first.
 */

export const extrasKeys = { all: ['extras'] as const, available: ['extras', 'available'] as const }

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

function useExtra<T>(name: string, read: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, enabled = true, live = false) {
  const signedIn = useAuthStore((s) => !!s.profile)
  const on = useExtrasAvailable()
  return useQuery({
    queryKey: [...extrasKeys.all, name],
    enabled: signedIn && on === true && enabled,
    staleTime: 15_000,
    // Realtime (useExtrasRealtime) is how a change usually arrives; this is
    // the fallback for a channel that dropped. Only while the tab is visible.
    refetchInterval: live ? 20_000 : false,
    // A new date range keeps the old rows up until the new ones land.
    placeholderData: keepPreviousData,
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

/**
 * One channel for all of 0021's tables: any change a person may see
 * (Realtime applies the same policies as a read) refreshes these screens.
 * Mounted once, in the shell, while the person is signed in.
 */
export function useExtrasRealtime() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.profile?.id)
  const on = useExtrasAvailable()
  useEffect(() => {
    if (!userId || !on) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      // Several rows land together (a room emptying): one refetch, not five.
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void queryClient.invalidateQueries({ queryKey: extrasKeys.all })
      }, 250)
    }
    // A fresh name each time: supabase.channel() hands back a same-named
    // channel that is still tearing down.
    let channel = supabase.channel(`office-extras-${crypto.randomUUID()}`)
    for (const table of [
      'office_notices',
      'office_notice_reads',
      'office_leave_requests',
      'office_bookings',
      'office_room_occupants',
      'office_room_messages',
      'office_room_invites',
      'office_channel_messages',
    ]) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
    }
    channel.subscribe()
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
export const useReadNotice = () =>
  useCall((i: { notice_id: string; user_id: string }) => supabase.from('office_notice_reads').insert(i))
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
export const useLeave = () => useExtra<LeaveRequest[]>('leave', () => supabase.from('office_leave_requests').select('*').order('starts_on', { ascending: false }).limit(300))
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
  useExtra<Booking[]>(`bookings-${since}`, () => supabase.from('office_bookings').select('*').gte('ends_at', since).order('starts_at').limit(200))
export const useOccupants = () => useExtra<Occupant[]>('occupants', () => supabase.from('office_room_occupants').select('*'), true, true)
export const useBookRoom = () =>
  useCall((i: { room: string; title: string; start: string; end: string }) =>
    supabase.rpc('book_room', { p_room: i.room, p_title: i.title, p_start: i.start, p_end: i.end }),
  )
export const useCancelBooking = () => useCall((id: string) => supabase.rpc('cancel_booking', { p_id: id }))
export type EnterAnswer = 'in' | 'out' | 'needs_code' | 'wrong_code' | 'locked'
export const useEnterRoom = () =>
  useCall((i: { room: string | null; code?: string }) => supabase.rpc('enter_room', { p_room: i.room, p_code: i.code ?? null }))
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
/** No previous data here: one room's words must never show, even for a moment, in another. */
export function useRoomMessages(room: string | null) {
  const signedIn = useAuthStore((s) => !!s.profile)
  const on = useExtrasAvailable()
  return useQuery({
    queryKey: [...extrasKeys.all, 'room-messages', room],
    enabled: signedIn && on === true && !!room,
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('office_room_messages').select('*').eq('room_id', room!).order('created_at').order('id').limit(300)
      if (error) throw new Error(error.message)
      return (data ?? []) as RoomMessage[]
    },
  })
}
export const usePostRoomMessage = () =>
  useCall((i: { room_id: string; body: string; sender: string }) => supabase.from('office_room_messages').insert(i))
export const useRoomInvites = () =>
  useExtra<RoomInvite[]>('room-invites', () => supabase.from('office_room_invites').select('*').order('created_at', { ascending: false }).limit(100), true, true)
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
    true,
    true,
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
  useExtra<Insights>(`insights-${days}`, () => supabase.rpc('office_insights', { p_days: days }), enabled)
