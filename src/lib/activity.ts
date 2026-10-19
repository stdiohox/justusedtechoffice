/**
 * Office activity (0008/0009), as pure functions: how the server's figures
 * and stays read on screen. Nothing here computes a figure; the database does
 * (office_time_summary). This only rounds and words them.
 */
// Relative, not '@/': the alerts route (api/) imports this file too.
import type { CheckinKind, EntryLeftReason, OfficeTimeDay } from '../types/database.js'

/**
 * Good to about 2 minutes (a beat every 2, merged within 5), so shown to the
 * nearest 5: finer would only pretend to be precise.
 */
export function roundTo5(minutes: number): number {
  return Math.round(minutes / 5) * 5
}

/** "3h 25m", "45m", "0m". */
export function fmtMinutes(minutes: number): string {
  const m = roundTo5(Math.max(0, minutes))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (!h) return `${rest}m`
  return rest ? `${h}h ${rest}m` : `${h}h`
}

export const TIME_FIGURES = [
  { key: 'active_min', label: 'Active', hint: 'A key, click or scroll in the office' },
  { key: 'busy_min', label: 'Do not disturb', hint: 'Inside its time-box' },
  { key: 'outside_min', label: 'Working elsewhere', hint: 'Said so, and answering check-ins' },
  { key: 'away_min', label: 'Away', hint: 'Idle, or after a missed check-in' },
  { key: 'signed_out_min', label: 'Signed out', hint: 'Between stays in the office' },
  { key: 'offline_min', label: 'Offline', hint: 'No record at all' },
] as const satisfies readonly { key: keyof OfficeTimeDay; label: string; hint: string }[]

export type TimeTotals = Pick<
  OfficeTimeDay,
  | 'active_min'
  | 'busy_min'
  | 'outside_min'
  | 'away_min'
  | 'signed_out_min'
  | 'offline_min'
  | 'extra_min'
  | 'checkins_answered'
  | 'checkins_missed'
  | 'signouts'
>

const ZERO: TimeTotals = {
  active_min: 0,
  busy_min: 0,
  outside_min: 0,
  away_min: 0,
  signed_out_min: 0,
  offline_min: 0,
  extra_min: 0,
  checkins_answered: 0,
  checkins_missed: 0,
  signouts: 0,
}

/** A week's totals: the days added up as they came from the server. */
export function sumDays(days: OfficeTimeDay[]): TimeTotals {
  return days.reduce<TimeTotals>(
    (t, d) => ({
      active_min: t.active_min + d.active_min,
      busy_min: t.busy_min + d.busy_min,
      outside_min: t.outside_min + d.outside_min,
      away_min: t.away_min + d.away_min,
      signed_out_min: t.signed_out_min + d.signed_out_min,
      offline_min: t.offline_min + d.offline_min,
      extra_min: t.extra_min + d.extra_min,
      checkins_answered: t.checkins_answered + d.checkins_answered,
      checkins_missed: t.checkins_missed + d.checkins_missed,
      signouts: t.signouts + d.signouts,
    }),
    ZERO,
  )
}

/** Working time: active, do not disturb and working elsewhere. */
export const workingMinutes = (t: Pick<TimeTotals, 'active_min' | 'busy_min' | 'outside_min'>): number =>
  t.active_min + t.busy_min + t.outside_min

/**
 * A short day (0010): signed in (some record that day), but less working time
 * than `minutes`. Off (false) when the setting is null or missing. A guide for
 * a conversation, never a flag.
 */
export function isShortDay(
  t: Pick<OfficeTimeDay, 'expected' | 'first_in' | 'active_min' | 'busy_min' | 'outside_min'>,
  minutes: number | null | undefined,
): boolean {
  return !!minutes && t.expected && !!t.first_in && workingMinutes(t) < minutes
}

/** "6.2h": a month cell has room for one short figure. */
export function fmtHours(minutes: number): string {
  return `${(roundTo5(Math.max(0, minutes)) / 60).toFixed(1).replace(/\.0$/, '')}h`
}

/** "Check-ins 3 of 4", or null when there were none. */
export function checkinsLabel(t: Pick<TimeTotals, 'checkins_answered' | 'checkins_missed'>): string | null {
  const total = t.checkins_answered + t.checkins_missed
  return total ? `Check-ins ${t.checkins_answered} of ${total}` : null
}

export const LEFT_REASON: Record<EntryLeftReason, string> = {
  idle: 'away 30 minutes',
  gone: 'no sign of the office for 30 minutes',
  eod: 'end-of-day report filed',
  left: 'you signed out',
  day_end: 'the day ended',
}

/** How a stay ended, for Mr Tito: "Signed out 11:42 (idle)". */
export const LEFT_SHORT: Record<EntryLeftReason, string> = {
  idle: 'idle',
  gone: 'no signal',
  eod: 'end of day',
  left: 'signed out',
  day_end: 'day ended',
}

export const CHECKIN_COPY: Record<CheckinKind, { title: string; body: string; yes: string; no: string }> = {
  outside: {
    title: 'Still there?',
    body: 'You said you are working elsewhere. Answer to stay in.',
    yes: 'Yes, still working',
    no: 'I’m back in the office',
  },
  busy_end: {
    title: 'Still heads-down?',
    body: 'Your do not disturb has run out.',
    yes: '30 more minutes',
    no: 'Turn it off',
  },
}

/** "4:05" left until `due` (ms), never negative. */
export function countdown(due: number, now: number): string {
  const s = Math.max(0, Math.ceil((due - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
