/**
 * The office map's presence (0004), as pure functions so the rules can be
 * read and tested apart from the Realtime plumbing in useOfficePresence.
 */

export type PresenceStatus = 'online' | 'away' | 'busy' | 'outside'
export type MapStatus = PresenceStatus | 'offline'

/**
 * No key, click or scroll in an office tab for this long reads as away. Mouse
 * movement does not count (tito-crm's OFFICE-ACTIVITY-PLAN 4.1): a jiggler does nothing.
 */
export const AWAY_AFTER_MS = 10 * 60_000
/** Do not disturb, chosen for one of these (0008: the server refuses others). */
export const BUSY_CHOICES = [30, 60, 90] as const
/**
 * Someone who drops out of the channel stays as they were for this long
 * before showing offline. A laptop lid, a tab reload or a Lagos power cut
 * and back should not flicker the map.
 */
export const OFFLINE_GRACE_MS = 60_000
/** How often an open tab tells the database it is still here. */
export const HEARTBEAT_MS = 2 * 60_000

export const STATUS_LABEL: Record<MapStatus, string> = {
  online: 'Online',
  away: 'Away',
  busy: 'Do not disturb',
  outside: 'Working elsewhere',
  offline: 'Offline',
}

/** The person's chosen mode, as instants on this browser's clock (ms). */
export interface Modes {
  busyUntil: number | null
  outsideUntil: number | null
}

export const NO_MODES: Modes = { busyUntil: null, outsideUntil: null }

/**
 * This tab's own status. Do not disturb wins while its box lasts. Otherwise
 * input is online; idle is "working elsewhere" while that mode lasts, and
 * away after it.
 */
export function localStatus(modes: Modes, lastActivity: number, now: number): PresenceStatus {
  if (modes.busyUntil !== null && now < modes.busyUntil) return 'busy'
  const idle = now - lastActivity >= AWAY_AFTER_MS
  if (!idle) return 'online'
  if (modes.outsideUntil !== null && now < modes.outsideUntil) return 'outside'
  return 'away'
}

/**
 * One person, several tabs: the most present one wins. Busy is a choice the
 * person made, so it outranks an idle second tab reading away; a tab with
 * input outranks one idling working elsewhere.
 */
export function mergeTabs(statuses: PresenceStatus[]): PresenceStatus | null {
  if (!statuses.length) return null
  if (statuses.includes('busy')) return 'busy'
  if (statuses.includes('online')) return 'online'
  if (statuses.includes('outside')) return 'outside'
  return 'away'
}

export interface Seen {
  status: PresenceStatus
  /** When this person was last in the channel (ms). */
  at: number
}

/** What the map shows for one person, given the channel now and memory. */
export function mapStatus(present: PresenceStatus | null, seen: Seen | undefined, now: number): MapStatus {
  if (present) return present
  if (seen && now - seen.at < OFFLINE_GRACE_MS) return seen.status
  return 'offline'
}

export interface Stretch {
  status: PresenceStatus
  started_at: string
  last_seen_at: string
}

export interface DaySummary {
  /** First stretch's start and last stretch's end, ms; null if never in. */
  first: number | null
  last: number | null
  minutes: Record<PresenceStatus, number>
}

/** Totals for one person's day, clipped to [dayStart, dayEnd). */
export function summarizeDay(stretches: Stretch[], dayStart: number, dayEnd: number): DaySummary {
  const minutes: Record<PresenceStatus, number> = { online: 0, away: 0, busy: 0, outside: 0 }
  let first: number | null = null
  let last: number | null = null
  for (const s of stretches) {
    const a = Math.max(Date.parse(s.started_at), dayStart)
    const b = Math.min(Date.parse(s.last_seen_at), dayEnd)
    if (b < a) continue
    minutes[s.status] += (b - a) / 60_000
    first = first === null ? a : Math.min(first, a)
    last = last === null ? b : Math.max(last, b)
  }
  return { first, last, minutes }
}
