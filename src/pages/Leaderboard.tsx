import { useEffect, useState } from 'react'
import { Star, Trophy } from 'lucide-react'
import { EmptyState, Skeleton } from '@/components/ui/primitives'
import { Photo } from '@/components/ui/Photo'
import { useLeaderboard } from '@/hooks/useLeaderboard'
import { useOfficeSettings } from '@/hooks/useOffice'
import { useAuthStore } from '@/stores/authStore'
import { localParts } from '@/lib/timezones'
import { cn, initials } from '@/lib/utils'
import type { LeaderboardRow } from '@/types/database'

/**
 * The weekly leaderboard (0012). Everyone earns points the same two
 * ways, whatever their job: tasks approved (with their stars), whoever gave
 * them, and reports filed on time. Time in the office is not scored: it
 * rewards a tab left open, not work done. Everyone on the team sees the
 * whole table; the office manager runs
 * it and is not on it. The week closes on Friday when the end-of-day report opens, when
 * everyone is emailed their week and the winner a special one.
 */

type Week = 0 | 1
const WEEKS: { id: Week; label: string }[] = [
  { id: 0, label: 'This week' },
  { id: 1, label: 'Last week' },
]
const TAB_WIDTH = 104

const POINTS: [string, string][] = [
  ['Task approved', '5 plus its stars (3 if not rated), up to 80 points a week'],
  ['Report filed on time', '1 each'],
]

/** "Fri 16 Oct, 17:00", office time. */
function when(iso: string, zone: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone })}, ${localParts(zone, d).time}`
}

/** Places that share points share a rank: 1, 1, 3. */
const rankOf = (rows: LeaderboardRow[], r: LeaderboardRow) => 1 + rows.filter((x) => x.points > r.points).length

function Medal({ rank, points }: { rank: number; points: number }) {
  if (points <= 0 || rank > 3) {
    return (
      <span className="tnum text-text-muted">
        <span className="sr-only">Place </span>
        {rank}
      </span>
    )
  }
  // The surface colour on the dark gold: light text in the light theme, dark in the dark one.
  const tone = rank === 1 ? 'bg-[var(--color-state-warning)] text-surface' : 'bg-surface-sunken text-text-primary hairline'
  return (
    <span className={cn('tnum inline-flex size-6 items-center justify-center rounded-full text-[12px] font-semibold', tone)}>
      <span className="sr-only">Place </span>
      {rank}
    </span>
  )
}

function Table({ rows, me, caption }: { rows: LeaderboardRow[]; me: string; caption: string }) {
  const num = 'tnum px-3 py-2.5 text-right'
  return (
    <div className="hairline overflow-x-auto rounded-[14px] bg-surface-raised" role="region" aria-label="Leaderboard table (scrolls sideways)" tabIndex={0}>
      <table className="w-full min-w-[480px] text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="hairline-b text-[11px] tracking-[0.08em] text-text-muted uppercase">
            <th scope="col" className="w-12 px-3 py-2 text-left font-medium">
              <span aria-hidden>#</span>
              <span className="sr-only">Rank</span>
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Name</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Points</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Tasks approved</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Reports on time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const mine = r.user_id === me
            return (
              <tr key={r.user_id} className={cn('hairline-b last:border-0', mine && 'bg-[var(--tint-accent)]')}>
                <td className="px-3 py-2.5">
                  <Medal rank={rankOf(rows, r)} points={r.points} />
                </td>
                <th scope="row" className="px-3 py-2.5 text-left font-medium text-text-primary">
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-surface">
                      <Photo userId={r.user_id} className="size-6">
                        {initials(r.full_name)}
                      </Photo>
                    </span>
                    {r.full_name}
                    {mine ? <span className="text-[12px] font-normal text-text-muted">(you)</span> : null}
                  </span>
                </th>
                <td className={cn(num, 'text-[15px] font-semibold text-text-primary')}>{r.points}</td>
                <td className={num}>
                  {r.tasks_done}
                  {/* Past the weekly cap: say so on the row, not only in "How points work". */}
                  {r.task_points > 80 ? <span className="text-text-muted"> (80 points counted)</span> : null}
                  {r.avg_rating !== null ? (
                    <span className="ml-1 inline-flex items-center gap-0.5 text-text-muted">
                      <Star size={11} strokeWidth={1.75} aria-hidden className="fill-[var(--color-state-warning)] text-state-warning" />
                      <span className="sr-only">, average rating </span>
                      {r.avg_rating.toFixed(1)}
                    </span>
                  ) : null}
                </td>
                <td className={num}>{r.reports_on_time}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function Leaderboard() {
  const me = useAuthStore((s) => s.profile?.id) ?? ''
  const [week, setWeek] = useState<Week>(0)
  const { data, isLoading, isError, error } = useLeaderboard(week)
  const { data: settings } = useOfficeSettings()
  const zone = settings?.timezone ?? 'Africa/Lagos'
  // The week closes when the end-of-day report opens (0014).
  const weekClose = settings ? settings.eod_opens.slice(0, 5) : '17:00'
  const i = WEEKS.findIndex((w) => w.id === week)

  const rows = data?.rows ?? []
  const top = rows[0] && rows[0].points > 0 ? rows.filter((r) => r.points === rows[0].points) : []
  const range = rows[0] ? `${when(rows[0].starts_at, zone)} to ${week === 0 ? 'now' : when(rows[0].ends_at, zone)}` : ''

  // Said when the week changes and its table has loaded: focus stays on the tab.
  const [said, setSaid] = useState('')
  const leader = top.length
    ? `${new Intl.ListFormat('en-GB', { type: 'conjunction' }).format(top.map((r) => r.full_name))} ${top.length > 1 ? 'lead' : 'leads'} with ${top[0].points} points`
    : 'No points yet'
  useEffect(() => {
    if (!isLoading && data?.available) setSaid(`${week === 0 ? 'This week' : 'Last week'}: ${leader}.`)
  }, [week, isLoading, data?.available, leader])

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 flex flex-wrap items-end gap-3 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <div className="mr-auto">
          <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">Leaderboard</h1>
          <p className="mt-1.5 text-[13px] text-text-muted">{range || `The week closes on Friday at ${weekClose}.`}</p>
        </div>
        <div
          role="tablist"
          aria-label="Which week"
          className="relative flex h-9 rounded-[14px] border border-line bg-surface-sunken p-[3px] max-sm:h-[52px]"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
            e.preventDefault()
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : ((i + 1) % 2) as Week
            setWeek(WEEKS[next].id)
            document.getElementById(`board-tab-${WEEKS[next].id}`)?.focus()
          }}
        >
          <span
            aria-hidden
            className="seg-thumb absolute top-[3px] bottom-[3px] left-[3px] rounded-[10px] bg-surface-raised shadow-[var(--shadow-sm)]"
            style={{ width: TAB_WIDTH, transform: `translateX(${i * TAB_WIDTH}px)` }}
          />
          {WEEKS.map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              id={`board-tab-${w.id}`}
              aria-selected={week === w.id}
              aria-controls="board-panel"
              tabIndex={week === w.id ? 0 : -1}
              onClick={() => setWeek(w.id)}
              style={{ width: TAB_WIDTH }}
              className={cn(
                'relative rounded-[10px] text-[13px] font-medium transition-colors duration-150',
                week === w.id ? 'font-semibold text-text-primary' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <p role="status" className="sr-only">
        {said}
      </p>
      <div id="board-panel" role="tabpanel" aria-labelledby={`board-tab-${week}`} className="mx-auto max-w-[1000px] space-y-5 p-4 sm:p-6">
        {isLoading ? (
          <Skeleton className="h-[320px]" />
        ) : isError || !data ? (
          <EmptyState title="Could not load the leaderboard" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
        ) : !data.available ? (
          <EmptyState
            icon={<Trophy size={22} strokeWidth={1.5} />}
            title="The leaderboard is not switched on yet"
            body="Ask Mr Tito: the office's database needs one more update (migration 0012)."
          />
        ) : !rows.length ? (
          <EmptyState icon={<Trophy size={22} strokeWidth={1.5} />} title="Nobody on the board yet" body="Everyone on the team except Mr Tito appears here." />
        ) : (
          <>
            {top.length ? (
              <div className="flex items-center gap-3 rounded-[14px] bg-[var(--sidebar-bg)] p-4 text-white">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--on-dark-fill)] text-accent">
                  <Trophy size={20} strokeWidth={1.75} aria-hidden />
                </span>
                <p className="text-[15px]">
                  <span className="text-accent">{week === 0 ? 'Leading so far' : 'Top of the team last week'}:</span>{' '}
                  <span className="font-semibold">{new Intl.ListFormat('en-GB', { type: 'conjunction' }).format(top.map((r) => r.full_name))}</span>, {top[0].points} points
                </p>
              </div>
            ) : (
              <p className="text-[13px] text-text-muted">No points yet this week.</p>
            )}
            <Table rows={rows} me={me} caption={`Points ${week === 0 ? 'this week so far' : 'last week'}, ${range}, highest first`} />
            <details className="text-[13px]">
              <summary className="cursor-pointer font-medium text-text-secondary hover:text-text-primary max-sm:min-h-11 max-sm:py-3">
                How points work
              </summary>
              <dl className="mt-2 grid max-w-[620px] grid-cols-[auto_1fr] gap-x-6 gap-y-1">
                {POINTS.map(([what, pts]) => (
                  <div key={what} className="contents">
                    <dt className="text-text-secondary">{what}</dt>
                    <dd className="tnum text-text-primary">{pts}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 max-w-[620px] text-text-muted">
                Everyone earns points the same way, whatever their job: any task counts, whoever gave it, once the person who gave it
                approves it. They can give it 1 to 5 stars. Stars count in the week the task was approved, if given before that week
                closed. Time in the office and sign-in times are not scored. People who have left the team are not shown. The week
                closes on Friday at {weekClose}; everyone gets their week by email, and the top of the table a special one.
              </p>
            </details>
          </>
        )}
      </div>
    </div>
  )
}
