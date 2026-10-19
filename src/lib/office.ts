/**
 * The office day, read from office_settings (0002). Pure and dependency-free
 * because api/cron/office-alerts imports it too; relative imports only.
 *
 * DISPLAY ONLY. Whether a report is on time is decided by submit_report() on
 * Postgres's clock. These helpers only say what the screen should show.
 */
import type { OfficeSettings, ReportKind, ReportTiming } from '../types/database.js'
import { localParts, weekdayOf } from './timezones.js'

export const REPORT_KINDS: ReportKind[] = ['signin', 'midday', 'eod']

export const REPORT_LABEL: Record<ReportKind, string> = {
  signin: 'Sign-in',
  midday: 'Midday report',
  eod: 'End-of-day report',
}

/** Postgres `time` 'HH:MM:SS' to 'HH:MM'. */
export const hhmm = (t: string): string => t.slice(0, 5)

/** When a checkpoint opens (null: any time that day) and its on-time limit. */
export function checkpointWindow(s: OfficeSettings, kind: ReportKind): { opens: string | null; deadline: string } {
  if (kind === 'signin') return { opens: null, deadline: hhmm(s.signin_deadline) }
  if (kind === 'midday') return { opens: hhmm(s.midday_opens), deadline: hhmm(s.midday_deadline) }
  return { opens: hhmm(s.eod_opens), deadline: hhmm(s.eod_deadline) }
}

/** "09:02", on the office's clock rather than the viewer's. */
export const officeClock = (zone: string, iso: string): string => localParts(zone, new Date(iso)).time

/** Proof is required for midday and EOD (tito-crm's VIRTUAL-OFFICE-PLAN decisions). */
export const needsProof = (kind: ReportKind): boolean => kind !== 'signin'

export function isWorkday(s: OfficeSettings, date: string): boolean {
  const d = weekdayOf(date)
  return s.workdays.includes(d === 0 ? 7 : d)
}

export type CheckpointState =
  | { state: 'filed'; timing: ReportTiming }
  | { state: 'upcoming'; opens: string }
  | { state: 'open'; deadline: string }
  // Past the deadline, nothing filed. Still fileable (late) until midnight.
  | { state: 'overdue'; deadline: string }
  // A past day with nothing filed.
  | { state: 'missed' }

/**
 * `time` is 'HH:MM' on the office clock now, or null for a day that is over.
 * The deadline is inclusive to the minute, as submit_report() counts it.
 */
export function checkpointState(
  s: OfficeSettings,
  kind: ReportKind,
  filed: ReportTiming | null,
  time: string | null,
): CheckpointState {
  if (filed) return { state: 'filed', timing: filed }
  if (time === null) return { state: 'missed' }
  const { opens, deadline } = checkpointWindow(s, kind)
  if (opens && time < opens) return { state: 'upcoming', opens }
  if (time <= deadline) return { state: 'open', deadline }
  return { state: 'overdue', deadline }
}
