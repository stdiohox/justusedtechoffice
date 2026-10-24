import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, CalendarOff, Check, Paperclip, X } from 'lucide-react'
import { Button, EmptyState, FieldError, Label, Skeleton, Textarea } from '@/components/ui/primitives'
import { ReportDetail, StatusChip } from '@/components/office/ReportBits'
import {
  MAX_FILES,
  PROOF_TYPES,
  fileProblem,
  useMyReports,
  useOfficeAbsences,
  useSubmitReport,
  type ReportWithFiles,
} from '@/hooks/useOffice'
import { useNow } from '@/hooks/useNow'
import { REPORT_KINDS, REPORT_LABEL, checkpointState, checkpointWindow, hhmm, isWorkday, takesProof } from '@/lib/office'
import { EarlyStart } from '@/components/office/EarlyStart'
import { localParts } from '@/lib/timezones'
import { useAuthStore } from '@/stores/authStore'
import type { OfficeSettings, ReportKind } from '@/types/database'
import { cn } from '@/lib/utils'
import { Pips } from '@/components/office/OfficeVisuals'
import { TOUCH } from '@/lib/touch'
import type { CheckpointState } from '@/lib/office'
import { useDayNotes, useTimeSummary } from '@/hooks/useOfficeActivity'
import { AddDayNote, DayNotes, TimeLegend, TimeLine } from '@/components/office/TimeFigures'
import { sumDays } from '@/lib/activity'
import { addDays, weekdayOf } from '@/lib/timezones'
import { AttendanceMonth } from '@/components/office/AttendanceMonth'
import { NoticeLink } from '@/components/office/Onboarding'
import { LinksField } from '@/components/office/Links'
import { linksProblem } from '@/lib/links'
import { useHasColumn } from '@/hooks/useHasColumn'

/**
 * A member's day: sign-in, midday, end of day. Each card opens at its time and
 * stays fileable, marked late, after its deadline until midnight. Nothing here
 * decides on-time or late; submit_report() does, on the server's clock.
 */

const PROMPT: Record<ReportKind, string> = {
  signin: 'Anything to note for today? (optional)',
  midday: 'What are you working on?',
  eod: 'What did you finish today?',
}

function ReportForm({ kind, date, overdue }: { kind: ReportKind; date: string; overdue: boolean }) {
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [body, setBody] = useState('')
  const [links, setLinks] = useState<string[]>([''])
  // Several links once 0016 is in; one box before.
  const multi = useHasColumn('office_reports', 'links')
  const [files, setFiles] = useState<File[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const submit = useSubmitReport()
  const proof = takesProof(kind)

  const addFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? [])
    const bad = picked.map(fileProblem).find(Boolean)
    if (bad) return setProblem(bad)
    const next = [...files, ...picked]
    if (next.length > MAX_FILES) return setProblem(`Attach up to ${MAX_FILES} files.`)
    setProblem(null)
    setFiles(next)
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (proof && !body.trim()) return setProblem('Say what you worked on.')
    const linkProblem = linksProblem(links)
    if (linkProblem) return setProblem(linkProblem)
    setProblem(null)
    submit.mutate(
      { kind, date, body, links, multi, files },
      { onError: (err) => setProblem(err instanceof Error ? err.message : 'That did not go through. Try again.') },
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3" noValidate>
      {overdue ? (
        <p className="text-[13px] text-state-danger">Past the deadline. You can still file it; it will be marked late.</p>
      ) : null}
      <div>
        <Label htmlFor={`${id}-body`}>{PROMPT[kind]}</Label>
        <Textarea id={`${id}-body`} rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      {proof ? (
        <div>
          <p id={`${id}-proof-label`} className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">
            Proof of work (optional)
          </p>
          {/* Out of the tab order: the button below is the one control. */}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={PROOF_TYPES.join(',')}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={TOUCH}
            icon={<Paperclip size={14} strokeWidth={1.75} />}
            aria-describedby={`${id}-proof-label ${id}-proof-hint`}
            onClick={() => fileInput.current?.click()}
          >
            Attach screenshot or file
          </Button>
          <p id={`${id}-proof-hint`} className="mt-1 text-[12px] text-text-muted">
            PNG, JPEG, WebP, GIF, HEIC or PDF, up to 10 MB each, {MAX_FILES} at most.
          </p>
          <p role="status" className="sr-only">
            {files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'} attached` : ''}
          </p>
          {files.length ? (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-[13px] text-text-primary">
                  <span className="truncate">{f.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="press flex size-8 items-center justify-center rounded-[8px] text-text-muted hover:bg-hover hover:text-text-primary max-sm:size-11"
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {proof ? (
        <LinksField id={id} links={links} onChange={setLinks} multi={multi} errorId={problem && linksProblem(links) ? `${id}-err` : undefined} />
      ) : null}

      <div id={`${id}-err`}>
        <FieldError>{problem}</FieldError>
      </div>
      <Button type="submit" className={TOUCH} loading={submit.isPending}>
        {submit.isPending && files.length ? 'Uploading' : `File ${REPORT_LABEL[kind].toLowerCase()}`}
      </Button>
    </form>
  )
}

/** The checkpoint's marker on the day rail. Decoration: the chip says it in words. */
function Node({ state }: { state: CheckpointState }) {
  const base = 'absolute top-[17px] left-0 z-[1] flex size-[23px] items-center justify-center rounded-full'
  if (state.state === 'filed')
    return (
      <span aria-hidden className={cn(base, state.timing === 'on_time' ? 'bg-brand text-surface-raised' : 'bg-tint-warning text-[var(--color-state-warning)] shadow-[inset_0_0_0_1.5px_var(--color-state-warning)]')}>
        <Check size={13} strokeWidth={2.5} />
      </span>
    )
  if (state.state === 'open')
    return (
      <span aria-hidden className={cn(base, 'bg-gold shadow-[0_0_0_4px_var(--tint-accent)]')}>
        <span className="size-[7px] rounded-full bg-ink" />
      </span>
    )
  if (state.state === 'overdue' || state.state === 'missed')
    return (
      <span aria-hidden className={cn(base, 'bg-tint-danger text-state-danger shadow-[inset_0_0_0_1.5px_var(--color-state-danger)]')}>
        <AlertCircle size={13} strokeWidth={2} />
      </span>
    )
  return <span aria-hidden className={cn(base, 'bg-surface-raised shadow-[inset_0_0_0_1.5px_var(--line-strong-role)]')} />
}

function Checkpoint({
  settings,
  kind,
  date,
  time,
  report,
}: {
  settings: OfficeSettings
  kind: ReportKind
  date: string
  time: string
  report: ReportWithFiles | undefined
}) {
  const state = checkpointState(settings, kind, report?.timing ?? null, time)
  const { opens, deadline } = checkpointWindow(settings, kind)
  // When a filing lands, the form it came from is replaced by the report.
  // Move focus there instead of letting it fall to <body>.
  const filedRef = useRef<HTMLDivElement>(null)
  const hadReport = useRef(!!report)
  useEffect(() => {
    if (report && !hadReport.current) filedRef.current?.focus()
    hadReport.current = !!report
  }, [report])
  const current = state.state === 'open' || state.state === 'overdue'
  return (
    <div className="relative pl-9">
      <Node state={state} />
    <section
      aria-labelledby={`cp-${kind}`}
      className={cn(
        'hairline row-in rounded-[14px] bg-surface-raised p-4 transition-shadow duration-200 sm:p-5',
        current && 'shadow-[var(--shadow-md)] ring-1 ring-[var(--tint-accent-line)]',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`cp-${kind}`} className="mr-auto text-[15px] font-medium text-text-primary">
          {REPORT_LABEL[kind]}
        </h2>
        <span className="tnum text-[12px] text-text-muted">{opens ? `${opens} to ${deadline}` : `By ${deadline}`}</span>
        <StatusChip state={state} />
      </div>
      {report ? (
        <div ref={filedRef} tabIndex={-1} className="mt-3 outline-none">
          <ReportDetail report={report} zone={settings.timezone} />
        </div>
      ) : state.state === 'open' || state.state === 'overdue' ? (
        <ReportForm kind={kind} date={date} overdue={state.state === 'overdue'} />
      ) : null}
    </section>
    </div>
  )
}

/**
 * Your own time (0009): exactly the figures Mr Tito sees about you, today and
 * this week so far, and the notes you add beside them.
 */
function YourTime({ settings, date }: { settings: OfficeSettings; date: string }) {
  const userId = useAuthStore((s) => s.profile?.id)
  const [monthOpened, setMonthOpened] = useState(false)
  const monday = addDays(date, -((weekdayOf(date) + 6) % 7))
  const { data: summary } = useTimeSummary(monday, date, true)
  const { data: notes } = useDayNotes(addDays(date, -13), date, true)
  if (!summary?.available) return null
  // Yours only: HR (0017) is given everyone's rows by the same calls.
  const rows = summary.rows.filter((r) => r.user_id === userId)
  const today = rows.find((r) => r.work_date === date)
  const week = sumDays(rows)
  return (
    <section aria-labelledby="your-time-h" className="hairline rounded-[14px] bg-surface-raised p-4 shadow-[var(--shadow-sm)] sm:p-5">
      <h2 id="your-time-h" className="text-[15px] font-medium text-text-primary">
        Your time in the office
      </h2>
      <p className="mt-0.5 text-[12px] text-text-muted">
        On the server's clock, {hhmm(settings.signin_reminder)} to {hhmm(settings.eod_deadline)}, to the nearest 5 minutes. Mr Tito and HR see exactly these figures, with your reports and your notes.
      </p>
      <h3 className="mt-4 text-[12px] font-medium tracking-[0.06em] text-text-secondary uppercase">Today</h3>
      {today ? <TimeLine t={today} className="mt-1.5" /> : <p className="mt-1 text-[13px] text-text-muted">Nothing recorded yet today.</p>}
      {rows.length > 1 ? (
        <>
          <h3 className="mt-4 text-[12px] font-medium tracking-[0.06em] text-text-secondary uppercase">This week so far</h3>
          <TimeLine t={week} className="mt-1.5" />
        </>
      ) : null}
      <details className="mt-3 text-[12px]">
        <summary className="cursor-pointer text-text-secondary max-sm:min-h-11 max-sm:py-3">What the figures mean</summary>
        <TimeLegend className="mt-2" />
      </details>
      <NoticeLink className="mt-1 block" />
      <EarlyStart settings={settings} date={date} />
      {notes?.available ? (
        <>
          <DayNotes notes={notes.rows.filter((n) => n.user_id === userId && n.work_date === date)} zone={settings.timezone} label="Your notes today" />
          <AddDayNote today={date} />
        </>
      ) : null}
      {userId ? (
        <details className="hairline-t mt-4 pt-3" onToggle={(e) => e.currentTarget.open && setMonthOpened(true)}>
          <summary className="cursor-pointer text-[13px] font-medium text-text-primary max-sm:min-h-11 max-sm:py-3">Your month</summary>
          {/* Fetched only once opened: most visits never look. */}
          {monthOpened ? (
            <div className="mt-3">
              <AttendanceMonth settings={settings} userId={userId} name="You" />
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  )
}

export function MyDay({ settings }: { settings: OfficeSettings }) {
  const now = useNow()
  const { date, time } = localParts(settings.timezone, now)
  const userId = useAuthStore((s) => s.profile?.id)
  const { data: reports, isLoading, isError, error } = useMyReports(date)
  const { data: absences } = useOfficeAbsences()
  const away = absences?.find(
    (a) => (a.user_id === null || a.user_id === userId) && a.starts_on <= date && date <= a.ends_on,
  )

  if (!isWorkday(settings, date)) {
    return (
      <EmptyState
        icon={<CalendarOff size={22} strokeWidth={1.5} />}
        title="No reports today"
        body="Reports are due on workdays, Monday to Friday."
      />
    )
  }
  if (away) {
    return (
      <EmptyState
        icon={<CalendarOff size={22} strokeWidth={1.5} />}
        title="No reports due today"
        body={`You are marked away: ${away.reason}.`}
      />
    )
  }
  if (isError) {
    return <EmptyState title="Could not load your reports" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
  }

  const filed = reports?.length ?? 0
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
  return (
    <div className="mx-auto max-w-[720px] space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <p className="font-display text-[26px] leading-tight font-medium text-text-primary">{weekday}</p>
          <p className="tnum mt-1 text-[12px] text-text-muted">
            {date}, {time} office time ({settings.timezone})
          </p>
        </div>
        {!isLoading ? (
          <p className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Pips filled={filed} total={REPORT_KINDS.length} />
            <span className="tnum">
              {filed} of {REPORT_KINDS.length} filed
            </span>
          </p>
        ) : null}
      </div>
      <div className="day-rail space-y-3">
      {isLoading
        ? REPORT_KINDS.map((k) => <Skeleton key={k} className="ml-9 h-[88px]" />)
        : REPORT_KINDS.map((k) => (
            <Checkpoint
              key={k}
              settings={settings}
              kind={k}
              date={date}
              time={time}
              report={reports?.find((r) => r.kind === k)}
            />
          ))}
      </div>
      <YourTime settings={settings} date={date} />
    </div>
  )
}
