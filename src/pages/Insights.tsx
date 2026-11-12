import { useState } from 'react'
import { AlertTriangle, BarChart3, CheckCircle2, Star } from 'lucide-react'
import { EmptyState, Skeleton } from '@/components/ui/primitives'
import { useOfficeRole } from '@/hooks/useOffice'
import { useExtrasAvailable, useInsights, type Insights as Data, type InsightsDay } from '@/hooks/useExtras'
import { ExtrasOff } from '@/components/office/ExtrasOff'
import { cn } from '@/lib/utils'

/**
 * Insights (0021): the office's own records, added up for Mr Tito and HR. Every
 * number comes from office_insights(). A guide for a conversation, not a verdict:
 * nothing here acts on anyone.
 */
const RANGES = [
  { days: 5, label: '5 days' },
  { days: 10, label: '10 days' },
  { days: 20, label: '20 days' },
]
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0)
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="hairline rounded-[14px] bg-surface-raised p-4">
      <p className="text-[12px] font-semibold text-text-muted">{label}</p>
      <p className="tnum mt-1 text-[28px] leading-none font-extrabold text-text-primary">{value}</p>
      <p className="mt-1.5 text-[12px] text-text-secondary">{note}</p>
    </div>
  )
}

const SERIES = [
  { key: 'on_time', label: 'On time', fill: 'var(--chart-on-time)' },
  { key: 'late', label: 'Late', fill: 'var(--chart-late)' },
  { key: 'missed', label: 'Missed', fill: 'var(--chart-missed)' },
] as const

function Chart({ days }: { days: InsightsDay[] }) {
  const [hover, setHover] = useState<InsightsDay | null>(null)
  const max = Math.max(1, ...days.map((d) => d.due))
  return (
    <figure className="hairline rounded-[14px] bg-surface-raised p-4">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="mr-auto text-[15px] font-bold text-text-primary">Reports each day</span>
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary">
            <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: s.fill }} /> {s.label}
          </span>
        ))}
      </figcaption>
      <p aria-hidden className="tnum mt-1 h-5 text-[12px] text-text-secondary">
        {hover ? `${dayLabel(hover.day)}: ${hover.on_time} on time, ${hover.late} late, ${hover.missed} missed` : 'Hover or tap a day for its figures.'}
      </p>
      <div aria-hidden className="mt-2 flex h-[180px] items-end gap-[2px] border-b border-line sm:gap-1.5">
        {days.map((d) => (
          <button
            key={d.day}
            type="button"
            tabIndex={-1}
            onMouseEnter={() => setHover(d)}
            onMouseLeave={() => setHover(null)}
            onClick={() => setHover(d)}
            className="flex h-full min-w-0 flex-1 flex-col-reverse gap-[2px] rounded-t-[4px] hover:bg-[var(--hover)]"
          >
            {SERIES.map((s) =>
              d[s.key] ? (
                <span
                  key={s.key}
                  className="mx-auto block w-full max-w-[28px] last:rounded-t-[4px]"
                  style={{ height: `${(d[s.key] / max) * 100}%`, background: s.fill }}
                />
              ) : null,
            )}
          </button>
        ))}
      </div>
      <div aria-hidden className="tnum mt-1 flex justify-between text-[11px] text-text-muted">
        <span>{days[0] ? dayLabel(days[0].day) : ''}</span>
        <span>{days.length ? dayLabel(days[days.length - 1].day) : ''}</span>
      </div>
      <details className="mt-3 text-[13px]">
        <summary className="cursor-pointer font-medium text-text-secondary hover:text-text-primary max-sm:min-h-11 max-sm:py-3">See the figures as a table</summary>
        <div className="relative mt-2 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-text-muted">
              <tr>
                <th scope="col" className="py-1 font-medium">Day</th>
                <th scope="col" className="py-1 text-right font-medium">On time</th>
                <th scope="col" className="py-1 text-right font-medium">Late</th>
                <th scope="col" className="py-1 text-right font-medium">Missed</th>
                <th scope="col" className="py-1 text-right font-medium">Tasks approved</th>
              </tr>
            </thead>
            <tbody className="tnum text-text-secondary">
              {days.map((d) => (
                <tr key={d.day}>
                  <th scope="row" className="py-0.5 font-normal">{dayLabel(d.day)}</th>
                  <td className="py-0.5 text-right">{d.on_time}</td>
                  <td className="py-0.5 text-right">{d.late}</td>
                  <td className="py-0.5 text-right">{d.missed}</td>
                  <td className="py-0.5 text-right">{d.tasks_approved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

/** The week in plain words, written from the figures by rule, so it can never say what they do not. */
function brief(d: Data): string[] {
  const out: string[] = []
  const filed = d.totals.on_time + d.totals.late
  out.push(`${pct(d.totals.on_time, d.totals.due)}% of the ${d.totals.due} reports due came in on time, and ${pct(filed, d.totals.due)}% came in at all.`)
  const slip = d.by_person.filter((p) => p.missed + p.late >= 3)
  if (slip.length) out.push(`${slip.map((p) => p.full_name).join(' and ')} ${slip.length > 1 ? 'have' : 'has'} three or more late or missed reports. Worth asking how things are going.`)
  else out.push('Nobody has more than two late or missed reports.')
  const best = [...d.by_person].sort((a, b) => b.tasks_approved - a.tasks_approved)[0]
  if (best?.tasks_approved) out.push(`${best.full_name} had the most tasks approved: ${best.tasks_approved}.`)
  if (d.waiting_review) out.push(`${d.waiting_review} finished ${d.waiting_review === 1 ? 'task is' : 'tasks are'} waiting for someone to check ${d.waiting_review === 1 ? 'it' : 'them'}.`)
  if (d.totals.tasks_overdue) out.push(`${d.totals.tasks_overdue} ${d.totals.tasks_overdue === 1 ? 'task is' : 'tasks are'} past due.`)
  if (d.pending_leave) out.push(`${d.pending_leave} time off ${d.pending_leave === 1 ? 'request is' : 'requests are'} waiting for a decision.`)
  return out
}

export function Insights() {
  const { seesTeam, loading } = useOfficeRole()
  const [days, setDays] = useState(10)
  const { data, isLoading, isError, error } = useInsights(days, seesTeam)
  const on = useExtrasAvailable()

  if (on === false) return <ExtrasOff icon={<BarChart3 size={22} strokeWidth={1.5} />} what="Insights" />
  if (!loading && !seesTeam) {
    return <EmptyState icon={<BarChart3 size={22} strokeWidth={1.5} />} title="This page is for Mr Tito and HR" body="You see your own figures under Reports." />
  }

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 flex flex-wrap items-end gap-3 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <div className="mr-auto">
          <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">Insights</h1>
          <p className="mt-1.5 text-[13px] text-text-muted">{data ? `${dayLabel(data.from)} to ${dayLabel(data.to)}. A guide for a conversation, not a verdict.` : 'A guide for a conversation, not a verdict.'}</p>
        </div>
        <div role="group" aria-label="How many workdays" className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
              className={cn(
                'press rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 max-sm:py-2.5',
                days === r.days ? 'bg-forest text-ivory' : 'hairline bg-surface-raised text-text-secondary hover:bg-surface-sunken',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mx-auto max-w-[1100px] space-y-5 p-4 sm:p-6">
        {isLoading ? <Skeleton className="h-[420px]" /> : null}
        {isError ? <EmptyState title="Could not load the insights" body={error instanceof Error ? error.message : 'Try again in a moment.'} /> : null}
        {data ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Reports on time" value={`${pct(data.totals.on_time, data.totals.due)}%`} note={`${data.totals.on_time} of ${data.totals.due} due`} />
              <Tile label="Missed" value={String(data.totals.missed)} note={`${data.totals.late} more came in late`} />
              <Tile label="Tasks approved" value={String(data.totals.tasks_approved)} note={`${data.open_tasks} open, ${data.waiting_review} to check`} />
              <Tile label="Average stars" value={data.totals.avg_stars != null ? String(data.totals.avg_stars) : 'None'} note="Out of 5, on rated tasks" />
            </div>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0">
                <Chart days={data.by_day} />
              </div>
              <section aria-label="In plain words" className="rounded-[14px] bg-[var(--sidebar-bg)] p-4 text-white">
                <h2 className="text-[15px] font-bold text-accent">In plain words</h2>
                <ul className="mt-2 space-y-2 text-[14px] leading-snug text-[var(--on-dark-muted)]">
                  {brief(data).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            </div>
            <section aria-labelledby="insights-people" className="hairline rounded-[14px] bg-surface-raised">
              <h2 id="insights-people" className="px-4 pt-4 text-[15px] font-bold text-text-primary">
                Person by person
              </h2>
              <div className="relative overflow-x-auto p-4 pt-2">
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead className="text-text-muted">
                    <tr className="hairline-b">
                      <th scope="col" className="py-2 font-medium">Name</th>
                      <th scope="col" className="py-2 text-right font-medium">On time</th>
                      <th scope="col" className="py-2 text-right font-medium">Late</th>
                      <th scope="col" className="py-2 text-right font-medium">Missed</th>
                      <th scope="col" className="py-2 text-right font-medium">Tasks approved</th>
                      <th scope="col" className="py-2 text-right font-medium">Past due</th>
                      <th scope="col" className="py-2 text-right font-medium">Stars</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {data.by_person.map((p) => (
                      <tr key={p.user_id} className="hairline-b last:border-0">
                        <th scope="row" className="py-2 pr-3 font-normal">
                          <span className="font-semibold text-text-primary">{p.full_name}</span>
                          {p.job_title ? <span className="block text-[12px] text-text-muted">{p.job_title}</span> : null}
                        </th>
                        <td className="py-2 text-right text-text-secondary">
                          {p.on_time}/{p.due} <span className="text-text-muted">({pct(p.on_time, p.due)}%)</span>
                        </td>
                        <td className="py-2 text-right text-text-secondary">{p.late}</td>
                        <td className="py-2 text-right">
                          {p.missed >= 3 ? (
                            <span className="inline-flex items-center gap-1 font-semibold text-state-danger">
                              <AlertTriangle size={12} aria-hidden /> {p.missed}
                              <span className="sr-only"> (worth a conversation)</span>
                            </span>
                          ) : (
                            <span className="text-text-secondary">{p.missed}</span>
                          )}
                        </td>
                        <td className="py-2 text-right text-text-secondary">
                          <span className="inline-flex items-center gap-1">
                            {p.tasks_approved > 0 ? <CheckCircle2 size={12} aria-hidden className="text-state-success" /> : null} {p.tasks_approved}
                          </span>
                        </td>
                        <td className="py-2 text-right text-text-secondary">{p.tasks_overdue}</td>
                        <td className="py-2 text-right text-text-secondary">
                          {p.avg_stars != null ? (
                            <span className="inline-flex items-center gap-1">
                              <Star size={12} aria-hidden /> {p.avg_stars}
                            </span>
                          ) : (
                            'None'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  )
}
