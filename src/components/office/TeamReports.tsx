import { useState } from 'react'
import { ChevronLeft, ChevronRight, Users } from 'lucide-react'
import { Button, EmptyState, Input, Select, Skeleton } from '@/components/ui/primitives'
import { ReportDetail, StatusChip } from '@/components/office/ReportBits'
import { useOfficePresenceDay, useOfficeRange, type OfficeMemberWithUser, type OfficeRange, type PresenceDay } from '@/hooks/useOffice'
import { summarizeDay } from '@/lib/presence'
import { useNow } from '@/hooks/useNow'
import { REPORT_KINDS, REPORT_LABEL, checkpointState, hhmm, officeClock, type CheckpointState } from '@/lib/office'
import { StartLine } from '@/components/office/EarlyStart'
import { useDayStarts } from '@/hooks/useDayStarts'
import { addDays, localParts, weekdayOf } from '@/lib/timezones'
import type { OfficeSettings, ReportKind } from '@/types/database'
import { Avatar, Pips } from '@/components/office/OfficeVisuals'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { useDayNotes, useTimeSummary } from '@/hooks/useOfficeActivity'
import { DayNotes, TimeLegend, TimeLine } from '@/components/office/TimeFigures'
import { TIME_FIGURES, checkinsLabel, fmtMinutes, sumDays } from '@/lib/activity'
import type { OfficeDayNote, OfficeTimeDay } from '@/types/database'

/**
 * Mr Tito's view of the reports (0002 RLS: nobody else can read them).
 * Day: everyone, one card each, with what they wrote and their proof, and
 * their time in the office (0009).
 * Week: one person, seven days, with the on-time count and the week's time.
 */

/** A checkpoint's state on any date, as seen from now. Null for a day not yet come. */
function stateOn(
  settings: OfficeSettings,
  range: OfficeRange,
  userId: string,
  date: string,
  kind: ReportKind,
  today: { date: string; time: string },
): CheckpointState | null {
  if (date > today.date) return null
  const report = range.reports.find((r) => r.user_id === userId && r.work_date === date && r.kind === kind)
  return checkpointState(settings, kind, report?.timing ?? null, date === today.date ? today.time : null)
}

function Chip({ state }: { state: CheckpointState | null }) {
  return state ? (
    <StatusChip state={state} />
  ) : (
    <span className="text-text-muted" aria-label="Not yet due">
      -
    </span>
  )
}

const isMissing = (s: CheckpointState | null) => s?.state === 'missed' || s?.state === 'overdue'

/**
 * "In 09:02-17:45 · away 35 min", from the heartbeat record (0004). Only
 * until 0009 is applied; then the server's figures replace it.
 */
function PresenceLine({ day, userId, zone }: { day: PresenceDay | undefined; userId: string; zone: string }) {
  if (!day) return null
  const s = summarizeDay(day.stretches.filter((x) => x.user_id === userId), day.start, day.end)
  if (s.first === null || s.last === null) {
    return <p className="mt-0.5 text-[12px] text-text-muted">Not in the office</p>
  }
  const at = (ms: number) => localParts(zone, new Date(ms)).time
  const parts = [`In ${at(s.first)} to ${at(s.last)}`]
  if (s.minutes.away >= 1) parts.push(`away ${Math.round(s.minutes.away)} min`)
  if (s.minutes.busy >= 1) parts.push(`do not disturb ${Math.round(s.minutes.busy)} min`)
  return <p className="tnum mt-0.5 text-[12px] text-text-muted">{parts.join(' · ')}</p>
}

/** "In 09:02 to 17:45", from the server's summary (first and last heartbeat). */
function InOut({ t, zone }: { t: OfficeTimeDay | undefined; zone: string }) {
  if (!t?.first_in || !t.last_seen) return <p className="mt-0.5 text-[12px] text-text-muted">Not in the office</p>
  const at = (iso: string) => localParts(zone, new Date(iso)).time
  return (
    <p className="tnum mt-0.5 text-[12px] text-text-muted">
      In {at(t.first_in)} to {at(t.last_seen)}
    </p>
  )
}

function useToday(settings: OfficeSettings) {
  return localParts(settings.timezone, useNow())
}

export function TeamDay({
  settings,
  members,
  date,
  onDate,
}: {
  settings: OfficeSettings
  members: OfficeMemberWithUser[]
  date: string
  onDate: (d: string) => void
}) {
  const today = useToday(settings)
  const { data, isLoading, isError, error } = useOfficeRange(date, date, true)
  // Work started before sign-in (0014): what each person said, and the evidence.
  const { data: starts } = useDayStarts(date, date)
  const startOf = (id: string) => starts?.rows.find((s) => s.user_id === id && s.work_date === date)
  const { data: presence } = useOfficePresenceDay(settings, date)
  const { data: summary } = useTimeSummary(date, date, true)
  const { data: notes } = useDayNotes(date, date, true)
  const name = (id: string) => members.find((m) => m.user_id === id)?.user?.full_name ?? 'Former member'
  const timeOf = (id: string): OfficeTimeDay | undefined => summary?.rows.find((t) => t.user_id === id)
  const notesOf = (id: string): OfficeDayNote[] => (notes?.rows ?? []).filter((n) => n.user_id === id)

  const due = data?.roster.filter((r) => r.expected) ?? []
  const counts = REPORT_KINDS.map((k) => ({
    kind: k,
    filed: due.filter((r) => data?.reports.some((p) => p.user_id === r.user_id && p.kind === k)).length,
  }))

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className={TOUCH} aria-label="Previous day" onClick={() => onDate(addDays(date, -1))}>
          <ChevronLeft size={15} />
        </Button>
        <label htmlFor="office-day" className="sr-only">
          Day
        </label>
        <Input id="office-day" type="date" value={date} max={today.date} onChange={(e) => e.target.value && onDate(e.target.value)} className="h-8 w-[160px] text-[13px] max-sm:h-11" />
        <Button variant="ghost" size="sm" className={TOUCH} aria-label="Next day" disabled={date >= today.date} onClick={() => onDate(addDays(date, 1))}>
          <ChevronRight size={15} />
        </Button>
        {date !== today.date ? (
          <Button variant="secondary" size="sm" className={TOUCH} onClick={() => onDate(today.date)}>
            Today
          </Button>
        ) : null}
        {data && due.length ? (
          <p className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-text-secondary">
            {counts.map((c) => (
              <span key={c.kind} className="flex items-center gap-2">
                {REPORT_LABEL[c.kind].replace(' report', '')}
                <Pips filled={c.filed} total={due.length} />
                <span className="tnum text-text-muted">
                  {c.filed}/{due.length}
                </span>
              </span>
            ))}
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <Skeleton className="h-[160px]" />
      ) : isError ? (
        <EmptyState title="Could not load the reports" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
      ) : !data?.roster.length ? (
        <EmptyState
          icon={<Users size={22} strokeWidth={1.5} />}
          title="Nobody is in the office yet"
          body="Add the team in the Team tab."
        />
      ) : (
        data.roster.map((r) => {
          const reused = data.flags.filter((f) => f.user_id === r.user_id && f.flag === 'reused_proof')
          return (
            <section key={r.user_id} aria-labelledby={`day-${r.user_id}`} className="hairline row-in rounded-[14px] bg-surface-raised p-4 shadow-[var(--shadow-sm)] sm:p-5">
              <div className="flex items-center gap-3">
                <Avatar name={name(r.user_id)} userId={r.user_id} size="sm" />
                <div className="min-w-0">
                  <h2 id={`day-${r.user_id}`} className="truncate text-[15px] font-medium text-text-primary">
                    {name(r.user_id)}
                  </h2>
                  {summary?.available ? (
                    <InOut t={timeOf(r.user_id)} zone={settings.timezone} />
                  ) : (
                    <PresenceLine day={presence} userId={r.user_id} zone={settings.timezone} />
                  )}
                  <StartLine start={startOf(r.user_id)} zone={settings.timezone} officialStart={hhmm(settings.signin_reminder)} />
                </div>
              </div>
              {summary?.available && timeOf(r.user_id) ? <TimeLine t={timeOf(r.user_id)!} className="mt-3" /> : null}
              <DayNotes notes={notesOf(r.user_id)} zone={settings.timezone} label="Their notes on this day" />
              {!r.expected ? (
                <p className="mt-1 text-[13px] text-text-muted">{r.absence ? `Away: ${r.absence}` : 'Not a workday'}</p>
              ) : (
                <div className="hairline-t mt-4 grid gap-4 pt-4 md:grid-cols-3 md:gap-0 md:divide-x md:divide-[var(--line)]">
                  {REPORT_KINDS.map((k) => {
                    const report = data.reports.find((p) => p.user_id === r.user_id && p.kind === k)
                    return (
                      <div key={k} className="min-w-0 md:px-4 md:first:pl-0 md:last:pr-0">
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="text-[12px] font-medium tracking-[0.06em] text-text-secondary uppercase">
                            {REPORT_LABEL[k].replace(' report', '')}
                          </span>
                          <Chip state={stateOn(settings, data, r.user_id, date, k, today)} />
                        </div>
                        {report ? <ReportDetail report={report} zone={settings.timezone} /> : null}
                      </div>
                    )
                  })}
                </div>
              )}
              {reused.length ? (
                <p className="mt-3 text-[13px] text-state-warning">
                  Proof matches a file handed in before: {reused.map((f) => `${f.detail ?? 'a file'} (${f.kind})`).join(', ')}
                </p>
              ) : null}
            </section>
          )
        })
      )}
    </div>
  )
}

/** Monday of the week containing `date`. */
const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7))

export function MemberWeek({
  settings,
  members,
  onOpenDay,
}: {
  settings: OfficeSettings
  members: OfficeMemberWithUser[]
  onOpenDay: (d: string) => void
}) {
  const today = useToday(settings)
  const reporters = members.filter((m) => m.user_id !== settings.manager_id)
  const [picked, setPicked] = useState(reporters[0]?.user_id ?? '')
  // The roster refreshes live; if the picked person leaves it, fall back
  // rather than show one name over another person's week.
  const userId = reporters.some((m) => m.user_id === picked) ? picked : (reporters[0]?.user_id ?? '')
  const [monday, setMonday] = useState(() => mondayOf(today.date))
  const sunday = addDays(monday, 6)
  const { data, isLoading, isError, error } = useOfficeRange(monday, sunday, !!userId)
  const { data: summary } = useTimeSummary(monday, sunday, !!userId)
  const { data: notes } = useDayNotes(monday, sunday, !!userId)
  const weekTime = (summary?.rows ?? []).filter((t) => t.user_id === userId)
  const weekNotes = (notes?.rows ?? []).filter((n) => n.user_id === userId)

  if (!reporters.length) {
    return <EmptyState icon={<Users size={22} strokeWidth={1.5} />} title="Nobody is in the office yet" body="Add the team in the Team tab." />
  }

  const days = (data?.roster ?? [])
    .filter((r) => r.user_id === userId)
    .sort((a, b) => a.work_date.localeCompare(b.work_date))
  const states = days
    .filter((d) => d.expected)
    .flatMap((d) => REPORT_KINDS.map((k) => stateOn(settings, data!, userId, d.work_date, k, today)))
  const onTime = states.filter((s) => s?.state === 'filed' && s.timing === 'on_time').length
  const late = states.filter((s) => s?.state === 'filed' && s.timing === 'late').length
  const missing = states.filter(isMissing).length

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[200px]">
          <label htmlFor="office-member" className="sr-only">
            Team member
          </label>
          <Select id="office-member" value={userId} onChange={(e) => setPicked(e.target.value)} className="h-8 text-[13px] max-sm:h-11">
            {reporters.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.user?.full_name ?? 'Former member'}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="ghost" size="sm" className={TOUCH} aria-label="Previous week" onClick={() => setMonday(addDays(monday, -7))}>
          <ChevronLeft size={15} />
        </Button>
        <span className="tnum text-[13px] text-text-primary">
          Week of {monday}
        </span>
        <Button variant="ghost" size="sm" className={TOUCH} aria-label="Next week" disabled={addDays(monday, 7) > today.date} onClick={() => setMonday(addDays(monday, 7))}>
          <ChevronRight size={15} />
        </Button>
        {data ? (
          <p className="tnum ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-text-secondary">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-state-success" />
              {onTime} on time
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-[var(--color-state-warning)]" />
              {late} late
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-state-danger" />
              {missing} not filed
            </span>
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <Skeleton className="h-[220px]" />
      ) : isError ? (
        <EmptyState title="Could not load the week" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
      ) : (
        <div className="hairline relative overflow-x-auto rounded-[14px] bg-surface-raised shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead>
              <tr className="hairline-b bg-surface-sunken/60 text-[11px] tracking-[0.08em] text-text-muted uppercase">
                <th scope="col" className="py-2.5 pr-4 pl-4 font-medium">Day</th>
                {REPORT_KINDS.map((k) => (
                  <th key={k} scope="col" className="py-2.5 pr-4 font-medium">
                    {REPORT_LABEL[k].replace(' report', '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.work_date} className="hairline-b align-top transition-colors duration-150 last:border-b-0 hover:bg-[var(--hover)]">
                  <th scope="row" className="py-3 pr-4 pl-4 font-normal">
                    <button
                      type="button"
                      onClick={() => onOpenDay(d.work_date)}
                      className="tnum text-left text-text-primary hover:underline focus-visible:underline max-sm:min-h-11"
                    >
                      {new Date(`${d.work_date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
                      <span className="sr-only"> (open this day)</span>
                    </button>
                  </th>
                  {!d.expected ? (
                    <td colSpan={3} className="py-3 text-text-muted">
                      {d.absence ? `Away: ${d.absence}` : 'Not a workday'}
                    </td>
                  ) : (
                    REPORT_KINDS.map((k) => {
                      const report = data!.reports.find((r) => r.user_id === userId && r.work_date === d.work_date && r.kind === k)
                      return (
                        <td key={k} className="py-3 pr-4">
                          <Chip state={stateOn(settings, data!, userId, d.work_date, k, today)} />
                          {report ? (
                            <span className="tnum ml-2 text-text-muted">{officeClock(settings.timezone, report.submitted_at)}</span>
                          ) : null}
                        </td>
                      )
                    })
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary?.available && !isLoading ? (
        <WeekTime
          days={days.map((d) => d.work_date)}
          rows={weekTime}
          notes={weekNotes}
          zone={settings.timezone}
          hours={`${hhmm(settings.signin_reminder)} to ${hhmm(settings.eod_deadline)}`}
        />
      ) : null}
    </div>
  )
}

/** A day not yet come: a dash to the eye, words to a screen reader. */
function NoData() {
  return (
    <>
      <span aria-hidden>-</span>
      <span className="sr-only">no data</span>
    </>
  )
}

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * The week's time in the office (0009), day by day and in total, with the
 * check-ins in the same rows.
 */
function WeekTime({
  days,
  rows,
  notes,
  zone,
  hours,
}: {
  days: string[]
  rows: OfficeTimeDay[]
  notes: OfficeDayNote[]
  zone: string
  /** "11:00 to 20:30", from office_settings. */
  hours: string
}) {
  const total = sumDays(rows)
  const cell = 'py-2.5 pr-4 text-right'
  return (
    <section aria-labelledby="week-time-h" className="space-y-2">
      <h2 id="week-time-h" className="text-[15px] font-medium text-text-primary">
        Time in the office
      </h2>
      <p className="text-[12px] text-text-muted">
        Worked out on the server's clock, inside {hours} office time, to the nearest 5 minutes. A guide, not a verdict: read it with the reports and the notes.
      </p>
      {/* Focusable and named, so a keyboard can scroll it sideways on a phone. */}
      <div
        role="region"
        aria-labelledby="week-time-h"
        tabIndex={0}
        className="hairline relative overflow-x-auto rounded-[14px] bg-surface-raised shadow-[var(--shadow-sm)]"
      >
        <table aria-labelledby="week-time-h" className="tnum w-full min-w-[760px] text-left text-[13px]">
          <thead>
            <tr className="hairline-b bg-surface-sunken/60 text-[11px] tracking-[0.08em] text-text-muted uppercase">
              <th scope="col" className="py-2.5 pr-4 pl-4 font-medium">Day</th>
              {TIME_FIGURES.map((f) => (
                <th key={f.key} scope="col" className="py-2.5 pr-4 text-right font-medium">
                  {f.label}
                </th>
              ))}
              <th scope="col" className="py-2.5 pr-4 font-medium">Check-ins</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const t = rows.find((r) => r.work_date === d)
              return (
                <tr key={d} className="hairline-b align-top last:border-b-0">
                  <th scope="row" className="py-2.5 pr-4 pl-4 font-normal text-text-primary">
                    {dayLabel(d)}
                  </th>
                  {TIME_FIGURES.map((f) => (
                    <td key={f.key} className={cn(cell, !t && 'text-text-muted')}>
                      {t ? fmtMinutes(t[f.key]) : <NoData />}
                    </td>
                  ))}
                  <td className="py-2.5 pr-4 text-text-secondary">{t ? (checkinsLabel(t)?.replace('Check-ins ', '') ?? 'none') : <NoData />}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="hairline-t bg-surface-sunken/40 font-medium">
              <th scope="row" className="py-2.5 pr-4 pl-4 text-left">Week</th>
              {TIME_FIGURES.map((f) => (
                <td key={f.key} className={cell}>
                  {fmtMinutes(total[f.key])}
                </td>
              ))}
              <td className="py-2.5 pr-4">{checkinsLabel(total)?.replace('Check-ins ', '') ?? 'none'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <TimeLegend />
      {notes.length ? (
        <div className="hairline rounded-[14px] bg-surface-raised p-4">
          {days
            .filter((d) => notes.some((n) => n.work_date === d))
            .map((d) => (
              <DayNotes key={d} notes={notes.filter((n) => n.work_date === d)} zone={zone} label={`Notes, ${dayLabel(d)}`} />
            ))}
        </div>
      ) : null}
    </section>
  )
}
