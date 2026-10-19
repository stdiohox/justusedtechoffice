/**
 * Wall-clock arithmetic on the office's timezone (office_settings.timezone,
 * Africa/Lagos). Dates are 'YYYY-MM-DD' strings and times 'HH:mm', so day
 * maths is calendar maths and never drifts across DST.
 */

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export interface LocalParts {
  /** 'YYYY-MM-DD' */
  date: string
  /** 'HH:mm', 24-hour */
  time: string
  hour: number
  /** 0 = Sunday */
  weekday: number
}

/** What a clock in `zone` reads at the instant `at`. */
export function localParts(zone: string, at: Date): LocalParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    hour: Number(get('hour')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  }
}

/** 'YYYY-MM-DD' plus n calendar days. Calendar arithmetic, so DST cannot skew it. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export const weekdayOf = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/**
 * The instant a wall-clock time in `zone` refers to, for display and for
 * asking the database about "today" from its start. `exact` is false when the
 * time does not exist in that zone on that date (a skipped DST hour).
 */
export function wallTimeToInstant(date: string, time: string, zone: string): { instant: Date; exact: boolean } {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const offsetAt = (t: number) => {
    const p = localParts(zone, new Date(t))
    const [py, pm, pd] = p.date.split('-').map(Number)
    const [ph, pmin] = p.time.split(':').map(Number)
    return Date.UTC(py, pm - 1, pd, ph, pmin) - Math.floor(t / 60_000) * 60_000
  }
  // Two passes: the second corrects the offset when the first guess landed on
  // the other side of a DST change.
  let t = guess - offsetAt(guess)
  t = guess - offsetAt(t)
  const back = localParts(zone, new Date(t))
  return { instant: new Date(t), exact: back.date === date && back.time === time }
}
