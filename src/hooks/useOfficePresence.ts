import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { officeKeys, useOfficeRole } from '@/hooks/useOffice'
import { activityKeys, useCheckinRealtime, useMyOfficeState, useSetOfficeMode } from '@/hooks/useOfficeActivity'
import {
  AWAY_AFTER_MS,
  HEARTBEAT_MS,
  NO_MODES,
  localStatus,
  mergeTabs,
  type Modes,
  type PresenceStatus,
  type Seen,
} from '@/lib/presence'
import { useAuthStore } from '@/stores/authStore'

/**
 * Presence in the office (0004, 0008). Mounted once, in the shell, so a rep
 * working in Leads is still in the office. Two halves:
 *
 *   LIVE   the private Realtime channel `office`: this tab tracks its status
 *          there, and every member's tabs are read back into `present`.
 *   RECORD office_heartbeat() on each change and every two minutes, which is
 *          what Mr Tito's day view reads. The database's clock, not ours.
 *
 * The gate (office_my_state, 0008): on a day a report is due from you, you
 * are not in the office (nothing is tracked or recorded) until your sign-in
 * is filed, nor while you are signed out (by yourself, or by the sweep once
 * Mr Tito has turned enforcement on). Before 0008 is applied, the gate is
 * 0004's office_signed_in_today() and do not disturb is boxed here only.
 */

type Gate = 'off' | 'needs_signin' | 'signed_out' | 'in'

/** Per user: whoever signs in next on a shared machine starts fresh. */
const busyKey = (userId: string) => `tito-office-busy-until:${userId}`

/**
 * supabase.channel('office') returns the existing instance while a previous
 * one is still unsubscribing (StrictMode's double effect, or a quick in, out,
 * in at the gate). Every join waits for the last removal to finish.
 */
let pendingRemoval: Promise<unknown> = Promise.resolve()

interface PresenceState {
  /** Who is in the channel right now, merged across their tabs. */
  present: Record<string, PresenceStatus>
  /** When each person was last in the channel, for the offline grace. */
  seen: Record<string, Seen>
  /** This person's status, or null while outside the office. */
  mine: PresenceStatus | null
  /** Do not disturb and working elsewhere, on this browser's clock. */
  modes: Modes
  gate: Gate
  /**
   * Back after a long spell away (0010): from the last input to now, so the
   * person can say where they were in a day note. Null once answered or dismissed.
   */
  awayReturn: { from: number; to: number } | null
}

/** Away this long or more (10 minutes idle, then 15 away) earns a "where were you?". */
export const RETURN_PROMPT_MS = AWAY_AFTER_MS + 15 * 60_000

export const usePresence = create<PresenceState>(() => ({
  present: {},
  seen: {},
  mine: null,
  modes: NO_MODES,
  gate: 'off',
  awayReturn: null,
}))

function readLocalBusy(userId: string): number | null {
  try {
    const until = Number(localStorage.getItem(busyKey(userId)))
    return until > Date.now() ? until : null
  } catch {
    // Private mode: starts off.
    return null
  }
}

function writeLocalBusy(userId: string, until: number | null) {
  try {
    if (until) localStorage.setItem(busyKey(userId), String(until))
    else localStorage.removeItem(busyKey(userId))
  } catch {
    // Private mode: the choice lasts for this tab only.
  }
}

/**
 * Do not disturb (30, 60 or 90 minutes), working elsewhere, or neither.
 * With 0008 the server holds the boxes; before it, do not disturb is boxed in
 * this browser and "working elsewhere" is not offered.
 */
export function useOfficeModes() {
  const userId = useAuthStore((s) => s.profile?.id)
  const { isMember } = useOfficeRole()
  const state = useMyOfficeState(userId, isMember)
  const modes = usePresence((s) => s.modes)
  const write = useSetOfficeMode()
  const available = state.data?.available === true
  // Not yet known (loading, or the read failed): a choice made now would
  // land in the wrong place and vanish when the state arrives.
  const unknown = state.data === undefined
  const notYet = () => Promise.reject(new Error('The office is still loading. Try again in a moment.'))
  const local = (until: number | null) => {
    if (!userId) return
    writeLocalBusy(userId, until)
    usePresence.setState({ modes: { busyUntil: until, outsideUntil: null } })
  }
  return {
    modes,
    /** "Working elsewhere" needs 0008 (its check-ins live there). */
    outsideAvailable: available,
    pending: write.isPending,
    error: write.error,
    setBusy: (minutes: number) =>
      unknown ? notYet() : available ? write.mutateAsync({ mode: 'busy', minutes }) : Promise.resolve(local(Date.now() + minutes * 60_000)),
    setOutside: () => (unknown ? notYet() : available ? write.mutateAsync({ mode: 'outside' }) : Promise.resolve()),
    clear: () => (unknown ? notYet() : available ? write.mutateAsync({ mode: 'none' }) : Promise.resolve(local(null))),
  }
}

/** 0004's gate, for a database without 0008. */
function useSignedInToday(userId: string | undefined, enabled: boolean) {
  return useQuery({
    // Keyed by user: a cached "signed in" must never carry over to the next
    // person to sign in on the same browser.
    queryKey: [...officeKeys.all, 'gate', userId],
    enabled: enabled && !!userId,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc('office_signed_in_today')
      if (error) throw error
      return data === true
    },
    // Midnight closes the door again without a reload.
    refetchInterval: 5 * 60_000,
  })
}

/**
 * The codes office_heartbeat() refuses with at the gate. 0008: OFC01 no
 * sign-in yet, OFC02 signed out. A database without 0008 (0004) refuses with
 * 42501 only. Matched by code, never by the message's wording.
 */
const GATE_REFUSALS = new Set(['OFC01', 'OFC02', '42501'])

function heartbeat(status: PresenceStatus, queryClient: QueryClient, userId: string) {
  void supabase.rpc('office_heartbeat', { p_status: status }).then(({ error }) => {
    if (!error) return
    // Refused at the gate: signed out (by the sweep, enforced) or no sign-in.
    // Re-read the state so the screen says so; otherwise (offline) the next
    // beat simply tries again.
    if (error.code && GATE_REFUSALS.has(error.code)) {
      void queryClient.invalidateQueries({ queryKey: activityKeys.state(userId) })
      void queryClient.invalidateQueries({ queryKey: [...officeKeys.all, 'gate', userId] })
    }
    if (import.meta.env.DEV) console.warn('office heartbeat:', error.message)
  })
}

export function useOfficePresence() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.profile?.id)
  const { isMember } = useOfficeRole()
  const state = useMyOfficeState(userId, isMember)
  const available = state.data?.available === true
  const legacy = useSignedInToday(userId, isMember && state.data?.available === false)
  useCheckinRealtime(userId, isMember && available)
  const modes = usePresence((s) => s.modes)
  const mine = usePresence((s) => s.mine)

  // Unknown (first load, or a failed check with nothing cached) is 'off', not
  // 'needs_signin': no prompt flashes, and an error never throws anyone out.
  let gate: Gate = 'off'
  if (isMember && userId) {
    if (state.data?.available) {
      const s = state.data
      gate = s.in ? 'in' : s.expects && !s.signed_in ? 'needs_signin' : 'signed_out'
    } else if (state.data && legacy.data !== undefined) {
      gate = legacy.data ? 'in' : 'needs_signin'
    }
  }
  const channelRef = useRef<RealtimeChannel | null>(null)
  const lastActivity = useRef(Date.now())

  useEffect(() => {
    usePresence.setState({ gate })
    // Out of the office (signed out, a new day's gate): no stale "were you working?".
    if (gate !== 'in') usePresence.setState({ awayReturn: null })
  }, [gate])

  // A new person on this browser starts with no modes, no status and fresh
  // activity. Declared before the effect below, so on a
  // switch it clears first and the new person's modes land after.
  useEffect(() => {
    lastActivity.current = Date.now()
    usePresence.setState({ modes: NO_MODES, mine: null, awayReturn: null })
  }, [userId])

  // The modes: the server's (on this browser's clock), or this browser's own
  // do-not-disturb box before 0008.
  const serverBusy = state.data?.available ? state.data.busy_until : undefined
  const serverOutside = state.data?.available ? state.data.outside_until : undefined
  const skew = state.data?.available ? state.data.skew : 0
  useEffect(() => {
    if (!userId) return
    if (serverBusy !== undefined) {
      usePresence.setState({
        modes: {
          busyUntil: serverBusy ? Date.parse(serverBusy) - skew : null,
          outsideUntil: serverOutside ? Date.parse(serverOutside) - skew : null,
        },
      })
    } else if (state.data?.available === false) {
      usePresence.setState({ modes: { busyUntil: readLocalBusy(userId), outsideUntil: null } })
    }
  }, [userId, serverBusy, serverOutside, skew, state.data?.available])

  // Keys, clicks and scrolling count as activity, and coming back to the tab.
  // Mouse movement does not: a jiggler moves the mouse, a person clicks.
  // 'wheel', not 'scroll': only a person makes one (the app scrolls itself).
  useEffect(() => {
    if (gate !== 'in') return
    // Coming in (filing the sign-in, "I'm back") is itself input: the clicks
    // that did it happened before these listeners were here.
    lastActivity.current = Date.now()
    let lastWheel = 0
    const active = () => {
      const before = lastActivity.current
      lastActivity.current = Date.now()
      // Back from away: say so now, not at the next 30-second tick.
      const p = usePresence.getState()
      if (p.mine === 'away') {
        const now = Date.now()
        usePresence.setState({
          mine: localStatus(p.modes, lastActivity.current, now),
          // Long enough to be worth a note (0010). Only the last spell is offered.
          ...(now - before >= RETURN_PROMPT_MS ? { awayReturn: { from: before, to: now } } : {}),
        })
      }
    }
    const wheel = () => {
      const now = Date.now()
      if (now - lastWheel > 5_000) {
        lastWheel = now
        lastActivity.current = now
      }
    }
    const visible = () => {
      if (document.visibilityState === 'visible') active()
    }
    window.addEventListener('keydown', active)
    window.addEventListener('pointerdown', active)
    window.addEventListener('wheel', wheel, { passive: true })
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('keydown', active)
      window.removeEventListener('pointerdown', active)
      window.removeEventListener('wheel', wheel)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [gate])

  // This tab's status, re-read every 30 seconds and whenever a mode changes.
  const { busyUntil, outsideUntil } = modes
  useEffect(() => {
    if (gate !== 'in') {
      usePresence.setState({ mine: null })
      return
    }
    const tick = () =>
      usePresence.setState({
        mine: localStatus({ busyUntil, outsideUntil }, lastActivity.current, Date.now()),
      })
    tick()
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
    // userId: a new person on this browser is re-read at once.
  }, [gate, busyUntil, outsideUntil, userId])

  // The channel: joined while in the office, left otherwise.
  useEffect(() => {
    if (gate !== 'in' || !userId) return
    let cancelled = false
    let channel: RealtimeChannel | null = null
    void pendingRemoval.then(() => {
      if (cancelled) return
      channel = supabase.channel('office', { config: { private: true, presence: { key: userId } } })
      join(channel)
      channelRef.current = channel
    })
    return () => {
      cancelled = true
      channelRef.current = null
      if (channel) pendingRemoval = supabase.removeChannel(channel)
      usePresence.setState({ present: {}, seen: {} })
    }
  }, [gate, userId])

  // Each change goes to the channel (if joined; otherwise the join tracks it)
  // and to the record. Also beat on waking up and on reconnecting, which a
  // throttled background timer would otherwise delay.
  useEffect(() => {
    if (!mine || !userId) return
    const channel = channelRef.current
    if (channel?.state === 'joined') void channel.track({ status: mine })
    heartbeat(mine, queryClient, userId)
    const beat = () => {
      if (document.visibilityState === 'visible') heartbeat(mine, queryClient, userId)
    }
    const t = setInterval(() => heartbeat(mine, queryClient, userId), HEARTBEAT_MS)
    window.addEventListener('online', beat)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(t)
      window.removeEventListener('online', beat)
      document.removeEventListener('visibilitychange', beat)
    }
  }, [mine, userId, queryClient])

  // When nobody is in the office on this browser, nothing of theirs remains.
  useEffect(() => {
    if (gate === 'off') usePresence.setState({ present: {}, seen: {}, mine: null })
  }, [gate])
}

function join(channel: RealtimeChannel) {
  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<{ status: PresenceStatus }>()
      const now = Date.now()
      const present: Record<string, PresenceStatus> = {}
      for (const [id, metas] of Object.entries(state)) {
        const merged = mergeTabs(metas.map((m) => m.status))
        if (merged) present[id] = merged
      }
      const seen = { ...usePresence.getState().seen }
      for (const [id, status] of Object.entries(present)) seen[id] = { status, at: now }
      usePresence.setState({ present, seen })
    })
    .subscribe((status, err) => {
      // The one place a fresh join announces itself; later changes are
      // tracked by the status effect once the channel is joined.
      const current = usePresence.getState().mine
      if (status === 'SUBSCRIBED' && current) void channel.track({ status: current })
      // Refused by realtime.messages RLS (0004), or the socket gave up. The
      // map then shows only this person; the record still beats.
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && import.meta.env.DEV) {
        console.warn('office channel:', status, err?.message ?? '')
      }
    })
}
