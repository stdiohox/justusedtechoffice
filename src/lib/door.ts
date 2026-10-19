/**
 * What a door says (0006, 0010), as pure functions so the day rules are
 * readable and testable apart from React.
 *
 *   working_on, back_at  belong to the office day they were set (set_on); from
 *                        the next day they are ignored, so nothing has to run
 *                        at midnight to clear them.
 *   back_at              also disappears once that time has passed.
 *   out_until            spans days: shown while today <= out_until.
 *   back_reason (0010)   goes with whichever of back_at / out_until shows. Set
 *                        alone, it is "back soon" for the day it was set. It
 *                        disappears with the "back at" it went with.
 */
import { hhmm } from './office.js'

export interface DoorRow {
  working_on: string | null
  back_at: string | null
  out_until: string | null
  set_on: string
  back_reason?: string | null
}

export interface DoorView {
  workingOn: string | null
  /** 'HH:MM', only while it is still ahead. */
  backAt: string | null
  /** 'YYYY-MM-DD', only while today <= it. */
  outUntil: string | null
  /** "Lunch", shown beside backAt / outUntil, or with backSoon. */
  reason: string | null
  /** Stepped out today with a reason and no time. */
  backSoon: boolean
}

export const EMPTY_DOOR: DoorView = { workingOn: null, backAt: null, outUntil: null, reason: null, backSoon: false }

/** `today` is the office clock now: date 'YYYY-MM-DD', time 'HH:MM'. */
export function doorView(row: DoorRow | undefined, today: { date: string; time: string }): DoorView {
  if (!row) return EMPTY_DOOR
  const sameDay = row.set_on === today.date
  const back = sameDay && row.back_at ? hhmm(row.back_at) : null
  const backAt = back && back > today.time ? back : null
  const outUntil = row.out_until && row.out_until >= today.date ? row.out_until : null
  const reasonSet = row.back_reason ?? null
  // Alone (no time, no date) it is "back soon", for the day it was set.
  const backSoon = !!reasonSet && sameDay && !row.back_at && !row.out_until
  const reason = reasonSet && (backAt || outUntil || backSoon) ? reasonSet : null
  return {
    workingOn: sameDay ? row.working_on : null,
    backAt,
    outUntil,
    reason,
    backSoon,
  }
}

/** Stepped out on purpose: a knock should reach them by email. */
export const steppedOut = (v: DoorView): boolean => !!v.backAt || !!v.outUntil || v.backSoon

/** "Out today" / "Out until Thu 16 Oct". */
export function outLabel(outUntil: string, todayDate: string): string {
  if (outUntil === todayDate) return 'Out today'
  const d = new Date(`${outUntil}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `Out until ${d}`
}

/** The reasons offered first. Nothing sensitive: everyone in the office reads them. */
export const BACK_REASONS = ['Lunch', 'Errand', 'Meeting outside'] as const

/**
 * "Back at" quick picks: about 15, 30, 60 and 120 minutes from now, rounded up
 * to the next quarter hour (so always at least 15 minutes ahead), never past
 * 23:45 (a time of day cannot cross midnight). Distinct and in order.
 */
export function backAtPicks(nowTime: string): string[] {
  const [h, m] = nowTime.split(':').map(Number)
  const now = h * 60 + m
  const picks = new Set<string>()
  for (const ahead of [15, 30, 60, 120]) {
    const t = Math.ceil((now + ahead) / 15) * 15
    if (t > 23 * 60 + 45) break
    picks.add(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`)
  }
  return [...picks]
}
