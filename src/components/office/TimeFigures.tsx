import { Fragment, useId, useState } from 'react'
import { Button, FieldError, Input, Label } from '@/components/ui/primitives'
import { useAddDayNote } from '@/hooks/useOfficeActivity'
import { TIME_FIGURES, checkinsLabel, fmtMinutes, type TimeTotals } from '@/lib/activity'
import { addDays } from '@/lib/timezones'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/toastStore'
import type { OfficeDayNote } from '@/types/database'

/**
 * Time in the office (0009), as the server worked it out, always next to the
 * check-ins and the reports: no figure is shown on its own.
 */

/** One colour per figure; the words beside them carry the meaning. */
const SWATCH: Record<(typeof TIME_FIGURES)[number]['key'], string> = {
  active_min: 'var(--color-state-success)',
  busy_min: 'var(--color-state-danger)',
  outside_min: 'var(--color-state-info)',
  away_min: 'var(--color-state-warning)',
  signed_out_min: 'var(--line-strong-role)',
  offline_min: 'transparent',
}

/** The working window split by figure. Decoration: the numbers are printed. */
export function TimeBar({ t, className }: { t: TimeTotals; className?: string }) {
  const total = TIME_FIGURES.reduce((n, f) => n + t[f.key], 0)
  if (!total) return null
  return (
    <span aria-hidden className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken shadow-[inset_0_0_0_1px_var(--line)]', className)}>
      {TIME_FIGURES.map((f) =>
        t[f.key] ? <span key={f.key} style={{ width: `${(t[f.key] / total) * 100}%`, background: SWATCH[f.key] }} /> : null,
      )}
    </span>
  )
}

/**
 * "Active 3h 30m · Away 1h · …" and, on the next line, the
 * check-ins beside it. Zero figures are left out, active never is.
 */
export function TimeLine({ t, className }: { t: TimeTotals; className?: string }) {
  const figures = TIME_FIGURES.filter((f) => f.key === 'active_min' || t[f.key] >= 3)
  const beside = [
    checkinsLabel(t),
    t.signouts ? `${t.signouts} ${t.signouts === 1 ? 'sign-out' : 'sign-outs'} after inactivity` : null,
    t.extra_min >= 3 ? `+${fmtMinutes(t.extra_min)} outside hours` : null,
  ].filter(Boolean)
  return (
    <div className={cn('space-y-1.5', className)}>
      <TimeBar t={t} />
      {/* role="list": a styled flex list loses its list semantics in Safari. */}
      <ul role="list" className="tnum flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-text-secondary">
        {figures.map((f) => (
          <li key={f.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={f.key === 'offline_min' ? { boxShadow: 'inset 0 0 0 1px var(--line-strong-role)' } : { background: SWATCH[f.key] }}
            />
            {f.label} <span className="font-medium text-text-primary">{fmtMinutes(t[f.key])}</span>
          </li>
        ))}
      </ul>
      <p className="tnum text-[12px] text-text-muted">{beside.join(' · ')}</p>
    </div>
  )
}

/** What each figure means, printed (not a tooltip), once per screen. */
export function TimeLegend({ className }: { className?: string }) {
  return (
    <dl className={cn('grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-[max-content_1fr]', className)}>
      {TIME_FIGURES.map((f) => (
        <Fragment key={f.key}>
          <dt className="flex items-center gap-1.5 text-text-secondary">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={f.key === 'offline_min' ? { boxShadow: 'inset 0 0 0 1px var(--line-strong-role)' } : { background: SWATCH[f.key] }}
            />
            {f.label}
          </dt>
          <dd className="text-text-muted max-sm:mb-1 max-sm:pl-3.5">{f.hint}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** What the person added to their day. */
export function DayNotes({ notes, zone, label }: { notes: OfficeDayNote[]; zone: string; label?: string }) {
  if (!notes.length) return null
  return (
    <div className="mt-2">
      {label ? <p className="text-[11px] font-medium tracking-[0.08em] text-text-muted uppercase">{label}</p> : null}
      <ul role="list" className="mt-1 space-y-1">
        {notes.map((n) => (
          <li key={n.id} className="text-[13px] text-text-primary">
            <span className="break-words">{n.body}</span>
            <span className="tnum ml-2 text-[12px] text-text-muted">
              added {new Date(n.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Add a note to your own day: today or up to 13 days back (0008's limit). */
export function AddDayNote({ today }: { today: string }) {
  const id = useId()
  const add = useAddDayNote()
  const showToast = useToastStore((s) => s.showToast)
  const [date, setDate] = useState(today)
  const [body, setBody] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!body.trim()) return setProblem('Write the note first.')
        setProblem(null)
        add.mutate(
          { date, body },
          {
            onSuccess: () => {
              setBody('')
              showToast('Note added', 'success')
            },
            onError: (err) => setProblem(err instanceof Error ? err.message : 'That did not go through.'),
          },
        )
      }}
    >
      <div className="min-w-[220px] flex-1">
        <Label htmlFor={`${id}-body`}>Add a note to your day</Label>
        <Input
          id={`${id}-body`}
          value={body}
          maxLength={300}
          placeholder="11:10 to 12:00, on a call with a partner"
          onChange={(e) => setBody(e.target.value)}
          className={TOUCH}
        />
      </div>
      <div className="w-[160px]">
        <Label htmlFor={`${id}-date`}>Day</Label>
        <Input
          id={`${id}-date`}
          type="date"
          value={date}
          min={addDays(today, -13)}
          max={today}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className={TOUCH}
        />
      </div>
      <Button type="submit" variant="secondary" loading={add.isPending} className={TOUCH}>
        Add note
      </Button>
      <div className="basis-full">
        <FieldError>{problem}</FieldError>
        <p className="text-[12px] text-text-muted">Notes sit beside your figures for Mr Tito to read. They change no number and cannot be edited.</p>
      </div>
    </form>
  )
}
