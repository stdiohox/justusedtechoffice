import { useEffect, useId, useRef, useState } from 'react'
import { CalendarClock, Clock3, Loader2, PenLine } from 'lucide-react'
import { Button, FieldError, Input, Label } from '@/components/ui/primitives'
import { useSetOfficeStatus } from '@/hooks/useOfficeStatus'
import { BACK_REASONS, backAtPicks, outLabel, type DoorView } from '@/lib/door'
import { addDays } from '@/lib/timezones'
import { cn } from '@/lib/utils'
import { TOUCH } from '@/lib/touch'

/**
 * What is written on a door (0006, 0010): "working on", "back at", "out until"
 * and a reason. Presentation and the one form; the rules for what shows on
 * which day live in lib/door.
 */


/* ------------------------------------------------------- on the floor */

/** " · Lunch", after whichever of back at / out until / back soon shows. */
const withReason = (view: DoorView) => (view.reason ? ` · ${view.reason}` : '')

export function DoorNote({ view, today }: { view: DoorView; today: string }) {
  if (!view.workingOn && !view.backAt && !view.outUntil && !view.backSoon) return null
  // The reason goes on the one chip that is about being away: back at first.
  const reasonOn = view.backAt ? 'back' : view.outUntil ? 'out' : 'soon'
  return (
    <div className="mt-3 space-y-2">
      {view.workingOn ? (
        <p className="line-clamp-2 text-[13px] leading-snug text-[rgba(246,250,247,0.85)]">
          <span className="sr-only">Working on: </span>
          <span aria-hidden className="text-gold">“</span>
          {view.workingOn}
          <span aria-hidden className="text-gold">”</span>
        </p>
      ) : null}
      {view.backAt || view.outUntil || view.backSoon ? (
        <p className="flex flex-wrap gap-1.5">
          {view.backAt ? (
            <span className="inline-flex items-center gap-1 rounded-[8px] bg-[rgba(255,217,102,0.08)] px-1.5 py-0.5 text-[12px] text-gold">
              <Clock3 size={12} strokeWidth={1.75} aria-hidden />
              Back at <span className="tnum">{view.backAt}</span>
              {reasonOn === 'back' ? withReason(view) : ''}
            </span>
          ) : null}
          {view.outUntil ? (
            <span className="inline-flex items-center gap-1 rounded-[8px] bg-[rgba(255,217,102,0.08)] px-1.5 py-0.5 text-[12px] text-gold">
              <CalendarClock size={12} strokeWidth={1.75} aria-hidden />
              {outLabel(view.outUntil, today)}
              {reasonOn === 'out' ? withReason(view) : ''}
            </span>
          ) : null}
          {view.backSoon ? (
            <span className="inline-flex items-center gap-1 rounded-[8px] bg-[rgba(255,217,102,0.08)] px-1.5 py-0.5 text-[12px] text-gold">
              <Clock3 size={12} strokeWidth={1.75} aria-hidden />
              Back soon{withReason(view)}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------- on your desk */

/**
 * Your own door: what you are on, when you are back, or that you are out.
 * Opens as a small form under "Your desk"; focus goes back to the toggle
 * when it closes, so a keyboard user is not dropped on <body>.
 */
export function DeskEditor({
  view,
  today,
  nowTime,
  reasons = false,
}: {
  view: DoorView
  today: string
  nowTime: string
  /** 0010 is in: a reason beside "back at" / "out until", or "back soon". */
  reasons?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [workingOn, setWorkingOn] = useState('')
  const [backAt, setBackAt] = useState('')
  const [outUntil, setOutUntil] = useState('')
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const save = useSetOfficeStatus()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const firstField = useRef<HTMLInputElement>(null)
  const hasAny = !!(view.workingOn || view.backAt || view.outUntil || view.backSoon)
  const picks = backAtPicks(nowTime)

  useEffect(() => {
    if (open) firstField.current?.focus()
  }, [open])

  const begin = () => {
    setWorkingOn(view.workingOn ?? '')
    setBackAt(view.backAt ?? '')
    setOutUntil(view.outUntil ?? '')
    setReason(view.reason ?? '')
    setProblem(null)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    requestAnimationFrame(() => toggleRef.current?.focus())
  }
  const submit = (values: { workingOn: string; backAt: string; outUntil: string; backReason: string }) => {
    if (save.isPending) return
    // "Back at" belongs to today, so a time already gone would save and then
    // never show. Say so instead of appearing to do nothing.
    if (values.backAt && values.backAt <= nowTime) {
      setProblem(`Back at must be later than now (${nowTime}).`)
      return
    }
    setProblem(null)
    save.mutate(values, {
      onSuccess: close,
      onError: (err) => setProblem(err instanceof Error ? err.message : 'Not saved. Try again.'),
    })
  }
  const away = view.backAt ? `Back at ${view.backAt}` : view.backSoon ? 'Back soon' : null

  return (
    <div className="basis-full">
      {!open ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="min-w-0 text-[13px] text-text-secondary">
            {view.workingOn ? (
              <>
                <span className="text-text-muted">On your door: </span>
                <span className="text-text-primary">{view.workingOn}</span>
              </>
            ) : (
              <span className="text-text-muted">Nothing on your door yet.</span>
            )}
            {away ? <span className="tnum text-text-muted"> · {away}</span> : null}
            {view.outUntil ? <span className="text-text-muted"> · {outLabel(view.outUntil, today)}</span> : null}
            {view.reason ? <span className="text-text-muted"> ({view.reason})</span> : null}
          </p>
          <Button
            ref={toggleRef}
            variant="ghost"
            size="sm"
            icon={<PenLine size={14} strokeWidth={1.75} />}
            className={TOUCH}
            onClick={begin}
          >
            {hasAny ? 'Edit your door' : 'Say what you’re on'}
          </Button>
        </div>
      ) : (
        <form
          id={`${id}-form`}
          aria-label="Your door"
          className="hairline-t mt-1 grid gap-3 pt-3 sm:grid-cols-[minmax(0,1fr)_140px_170px]"
          onSubmit={(e) => {
            e.preventDefault()
            submit({ workingOn, backAt, outUntil, backReason: reason })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !save.isPending) {
              e.preventDefault()
              close()
            }
          }}
        >
          <div>
            <Label htmlFor={`${id}-on`}>Working on</Label>
            <Input
              ref={firstField}
              id={`${id}-on`}
              maxLength={120}
              placeholder="Replying to partner emails"
              value={workingOn}
              onChange={(e) => setWorkingOn(e.target.value)}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${id}-err` : undefined}
              className={TOUCH}
            />
          </div>
          <div>
            <Label htmlFor={`${id}-back`}>Back at (optional)</Label>
            <Input
              id={`${id}-back`}
              type="time"
              value={backAt}
              onChange={(e) => setBackAt(e.target.value)}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${id}-err` : undefined}
              className={TOUCH}
            />
          </div>
          <div>
            <Label htmlFor={`${id}-out`}>Out until (optional)</Label>
            <Input
              id={`${id}-out`}
              type="date"
              min={today}
              max={addDays(today, 60)}
              value={outUntil}
              onChange={(e) => setOutUntil(e.target.value)}
              className={TOUCH}
            />
          </div>
          {picks.length ? (
            <div className="flex flex-wrap items-center gap-1.5 sm:col-span-3" role="group" aria-label="Back at, quick picks">
              <span className="text-[12px] text-text-muted">Back at:</span>
              {picks.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={backAt === t}
                  onClick={() => setBackAt(t)}
                  className={cn(
                    'press tnum rounded-[8px] border border-line px-2 py-0.5 text-[12px] text-text-secondary hover:bg-hover hover:text-text-primary',
                    backAt === t && 'border-[var(--tint-accent-line)] bg-tint-accent text-text-primary',
                    TOUCH,
                    'max-sm:px-3',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          ) : null}
          {reasons ? (
            <div className="sm:col-span-3">
              <p id={`${id}-why-l`} className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">
                Reason (optional)
              </p>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-labelledby={`${id}-why-l`}>
                {BACK_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={reason === r}
                    onClick={() => setReason(reason === r ? '' : r)}
                    className={cn(
                      'press rounded-[8px] border border-line px-2 py-0.5 text-[12px] text-text-secondary hover:bg-hover hover:text-text-primary',
                      reason === r && 'border-[var(--tint-accent-line)] bg-tint-accent text-text-primary',
                      TOUCH,
                      'max-sm:px-3',
                    )}
                  >
                    {r}
                  </button>
                ))}
                <label htmlFor={`${id}-why`} className="sr-only">
                  Or write a reason
                </label>
                <Input
                  id={`${id}-why`}
                  maxLength={50}
                  placeholder="Or write one"
                  value={(BACK_REASONS as readonly string[]).includes(reason) ? '' : reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={cn('h-8 w-[180px] text-[13px]', TOUCH)}
                />
              </div>
              <p className="mt-1 text-[12px] text-text-muted">
                A reason with no time shows as “Back soon”. Only a “Back at” time keeps a break from counting as away.
              </p>
            </div>
          ) : null}
          <p className="text-[12px] text-text-muted sm:col-span-3">
            Everyone in the office sees this on your door. You don’t have to give a reason. “Working on” and “Back at”
            clear themselves tomorrow. Being out here is not leave: ask Mr Tito to add days away so you are not flagged.
          </p>
          <div id={`${id}-err`} className="sm:col-span-3">
            <FieldError>{problem}</FieldError>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            {/* aria-disabled, not disabled: disabling the focused button would
                drop keyboard focus to <body> while it saves. */}
            <Button
              type="submit"
              size="sm"
              aria-disabled={save.isPending || undefined}
              aria-busy={save.isPending || undefined}
              icon={save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : undefined}
              className={TOUCH}
            >
              Save
            </Button>
            {hasAny ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-disabled={save.isPending || undefined}
                className={TOUCH}
                onClick={() => submit({ workingOn: '', backAt: '', outUntil: '', backReason: '' })}
              >
                Clear your door
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" className={TOUCH} onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
