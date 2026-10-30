import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, EmptyState, Skeleton } from '@/components/ui/primitives'
import { supabase } from '@/lib/supabase'
import { officeKeys, useOfficeAbsences } from '@/hooks/useOffice'
import { useTimeSummary } from '@/hooks/useOfficeActivity'
import { useNow } from '@/hooks/useNow'
import { fmtHours, fmtMinutes, isShortDay, workingMinutes } from '@/lib/activity'
import { REPORT_KINDS } from '@/lib/office'
import { addDays, localParts, weekdayOf } from '@/lib/timezones'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import type { OfficeSettings, OfficeTimeDay, ReportKind, ReportTiming } from '@/types/database'

/**
 * One person's month (0009, 0010): a calendar of their days with the sign-in
 * on time, late or missed, how many of the three reports were filed, and the
 * working time the server worked out. A day with a sign-in but less working
 * time than Mr Tito's "short day" setting is marked short. A guide for a
 * conversation, read with the reports and the notes: nothing here is a flag.
 * Mr Tito sees anyone's month; a member only their own (the database decides).
 */

interface Timing {
  work_date: string
  kind: ReportKind
  timing: ReportTiming
}

/** Only the timings: the month needs no report text and no proof. */
function useMonthReports(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: [...officeKeys.all, 'month-reports', userId, from, to],
    enabled: !!userId,
    queryFn: async (): Promise<Timing[]> => {
      const { data, error } = await supabase
        .from('office_reports')
        .select('work_date, kind, timing')
        .eq('user_id', userId)
        .gte('work_date', from)
        .lte('work_date', to)
      if (error) throw error
      return (data ?? []) as Timing[]
    },
  })
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`
function monthEnd(first: string): string {
  const [y, m] = first.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return addDays(next, -1)
}
const monthLabel = (first: string) =>
  new Date(`${first}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

type SignIn = 'on_time' | 'late' | 'missed' | 'pending'

export function AttendanceMonth({ settings, userId, name }: { settings: OfficeSettings; userId: string; name: string }) {
  const id = useId()
  const today = localParts(settings.timezone, useNow(60_000))
  const [first, setFirst] = useState(() => monthStart(today.date))
  const last = monthEnd(first)
  const { data: summary, isLoading, isError } = useTimeSummary(first, last, !!userId)
  // Until the timings are in, every past day would read "missed": wait for both.
  const { data: reports, isLoading: reportsLoading, isError: reportsError } = useMonthReports(userId, first, last)
  const { data: absences } = useOfficeAbsences()
  const shortMinutes = settings.short_day_minutes ?? null

  if (summary && !summary.available) return null
  const days = (summary?.rows ?? []).filter((t) => t.user_id === userId)
  const dayOf = (date: string): OfficeTimeDay | undefined => days.find((t) => t.work_date === date)
  const filed = (date: string) => (reports ?? []).filter((r) => r.work_date === date)
  const signIn = (date: string): SignIn => {
    const r = filed(date).find((x) => x.kind === 'signin')
    if (r) return r.timing === 'late' ? 'late' : 'on_time'
    // Today's sign-in is still fileable (late) until midnight.
    return date < today.date ? 'missed' : 'pending'
  }
  const absence = (date: string) =>
    absences?.find((a) => (a.user_id === null || a.user_id === userId) && a.starts_on <= date && date <= a.ends_on)?.reason ?? null

  // The calendar: Monday-first weeks covering the month.
  const lead = (weekdayOf(first) + 6) % 7
  const cells: (string | null)[] = [...Array(lead).fill(null)]
  for (let d = first; d <= last; d = addDays(d, 1)) cells.push(d)
  while (cells.length % 7) cells.push(null)
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))

  // Today is still going: it can be late or missed, but not yet short.
  const short = (t: OfficeTimeDay) => t.work_date < today.date && isShortDay(t, shortMinutes)
  const due = days.filter((t) => t.expected)
  const counts = {
    due: due.length,
    onTime: due.filter((t) => signIn(t.work_date) === 'on_time').length,
    late: due.filter((t) => signIn(t.work_date) === 'late').length,
    missed: due.filter((t) => signIn(t.work_date) === 'missed').length,
    short: due.filter(short).length,
    working: due.reduce((n, t) => n + workingMinutes(t), 0),
  }

  const describe = (date: string): string => {
    const t = dayOf(date)
    const label = date === today.date ? `${dayLabel(date)}, today` : dayLabel(date)
    if (!t) return `${label}: not yet`
    if (!t.expected) return `${label}: ${absence(date) ? `away, ${absence(date)}` : 'not a workday'}`
    const s = signIn(date)
    const parts = [
      s === 'on_time' ? 'sign-in on time' : s === 'late' ? 'sign-in late' : s === 'missed' ? 'no sign-in' : 'sign-in not yet filed',
      `${filed(date).length} of ${REPORT_KINDS.length} reports`,
      `${fmtMinutes(workingMinutes(t))} working`,
    ]
    if (short(t)) parts.push('short day')
    return `${label}: ${parts.join(', ')}`
  }

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-h`} className="mr-auto text-[15px] font-medium text-text-primary">
          {name}, {monthLabel(first)}
        </h2>
        <Button variant="ghost" size="sm" className={TOUCH} aria-label="Previous month" onClick={() => setFirst(monthStart(addDays(first, -1)))}>
          <ChevronLeft size={15} />
        </Button>
        {/* aria-disabled, not disabled: stepping into this month would drop focus. */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(TOUCH, addDays(last, 1) > today.date && 'opacity-40')}
          aria-label="Next month"
          aria-disabled={addDays(last, 1) > today.date || undefined}
          onClick={() => addDays(last, 1) <= today.date && setFirst(addDays(last, 1))}
        >
          <ChevronRight size={15} />
        </Button>
      </div>

      {isError || reportsError ? (
        <EmptyState title="Could not load the month" body="Try again in a moment." />
      ) : isLoading || reportsLoading || !reports ? (
        <Skeleton className="h-[260px]" />
      ) : !days.length ? (
        <EmptyState title="Nothing recorded this month" body="Days appear here once they have started." />
      ) : (
        <>
          <p aria-live="polite" className="tnum flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-secondary">
            <span>{counts.due} days due</span>
            <span>{counts.onTime} sign-ins on time</span>
            <span>{counts.late} late</span>
            <span>{counts.missed} missed</span>
            {shortMinutes ? <span>{counts.short} short</span> : null}
            <span>{fmtMinutes(counts.working)} working in all</span>
          </p>
          {/* Focusable and named, so a keyboard can scroll it sideways. */}
          <div
            role="region"
            aria-label={`${name}’s days, ${monthLabel(first)}`}
            tabIndex={0}
            className="hairline relative overflow-x-auto rounded-[14px] bg-surface-raised shadow-[var(--shadow-sm)]"
          >
            <table className="w-full min-w-[340px] table-fixed text-[12px]">
              <caption className="sr-only">
                {name}’s days in {monthLabel(first)}
              </caption>
              <thead>
                <tr className="hairline-b text-[11px] tracking-[0.06em] text-text-muted uppercase">
                  {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => (
                    <th key={d} scope="col" abbr={d} className="py-2 font-medium">
                      <abbr title={d} className="no-underline">
                        {d.slice(0, 3)}
                      </abbr>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((w, i) => (
                  <tr key={i} className="hairline-b last:border-b-0">
                    {w.map((date, j) => {
                      if (!date) return <td key={j} />
                      const t = dayOf(date)
                      const s = t?.expected ? signIn(date) : null
                      const isShort = !!t && short(t)
                      return (
                        <td key={date} aria-current={date === today.date ? 'date' : undefined} className="h-[76px] p-1 align-top max-sm:p-0.5">
                          <div
                            className={cn(
                              'flex h-full flex-col rounded-[10px] px-1.5 py-1 max-sm:px-1',
                              (!t || !t.expected) && 'text-text-muted',
                              s === 'missed' && 'bg-tint-danger',
                              s === 'late' && 'bg-tint-warning',
                              date === today.date && 'ring-1 ring-[var(--tint-accent-line)]',
                            )}
                          >
                            <span aria-hidden className={cn('tnum font-medium', t?.expected ? 'text-text-primary' : 'text-text-muted')}>
                              {Number(date.slice(8))}
                            </span>
                            {/* Words as well as colour: red and amber alone say nothing to some eyes. */}
                            {s === 'missed' || s === 'late' ? (
                              <span aria-hidden className={cn('truncate text-[11px] font-medium max-sm:tracking-tight', s === 'missed' ? 'text-state-danger' : 'text-text-primary')}>
                                {s === 'missed' ? 'missed' : 'late'}
                              </span>
                            ) : null}
                            {t?.expected ? (
                              <span aria-hidden className="tnum mt-auto flex flex-wrap items-baseline gap-x-1 text-text-secondary">
                                {fmtHours(workingMinutes(t))}
                                {isShort ? (
                                  <span className="text-[11px] font-medium text-text-primary underline decoration-[var(--color-state-warning)] decoration-2 underline-offset-2">
                                    short
                                  </span>
                                ) : null}
                              </span>
                            ) : t && absence(date) ? (
                              <span aria-hidden className="mt-auto truncate">
                                Away
                              </span>
                            ) : null}
                            <span className="sr-only">{describe(date)}</span>
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-text-muted">
            The figure is working time (active, do not disturb and working elsewhere) between{' '}
            {settings.signin_reminder.slice(0, 5)} and {settings.eod_deadline.slice(0, 5)}, on the server’s clock.
            {shortMinutes ? ` “Short” is a signed-in day under ${fmtMinutes(shortMinutes)}.` : ''} A guide, not a verdict: read it with the reports and the notes.
          </p>
        </>
      )}
    </section>
  )
}
