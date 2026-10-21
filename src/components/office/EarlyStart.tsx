import { useId, useRef, useState, type FormEvent } from 'react'
import { Sunrise } from 'lucide-react'
import { Button, FieldError, Input, Label } from '@/components/ui/primitives'
import { useDayStarts, useDeclareStart, type DayStart } from '@/hooks/useDayStarts'
import { useAuthStore } from '@/stores/authStore'
import { hhmm } from '@/lib/office'
import { localParts } from '@/lib/timezones'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import type { OfficeSettings } from '@/types/database'

/**
 * Work started before sign-in (0014), on your own day. The office records
 * nothing before the sign-in report; this is where you say you began earlier.
 * Today only, a time before the official start. Mr Tito sees it beside your
 * day as said by you, with the time of your first task step that day.
 */
export function EarlyStart({ settings, date }: { settings: OfficeSettings; date: string }) {
  const userId = useAuthStore((s) => s.profile?.id)
  const { data } = useDayStarts(date, date)
  const declare = useDeclareStart()
  const id = useId()
  const timeRef = useRef<HTMLInputElement>(null)
  const start = hhmm(settings.signin_reminder)
  const mine = data?.rows.find((r) => r.user_id === userId && r.work_date === date)
  const said = mine?.started_at ? localParts(settings.timezone, new Date(mine.started_at)).time : null
  const [open, setOpen] = useState(false)
  const [time, setTime] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const now = localParts(settings.timezone, new Date()).time

  // Before 0014, or a day whose official start has not come yet: nothing to say.
  if (!data?.available || now < '04:00') return null

  const openForm = () => {
    setTime(said ?? '')
    setNote(mine?.note ?? '')
    setProblem(null)
    setOpen(true)
    requestAnimationFrame(() => timeRef.current?.focus())
  }
  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!time) return setProblem('Choose the time you started.')
    if (time >= start) return setProblem(`That is not before ${start}.`)
    if (time > now) return setProblem('That time has not come yet.')
    setProblem(null)
    declare.mutate({ time, note }, { onSuccess: () => setOpen(false), onError: (err) => setProblem(err.message) })
  }

  return (
    <div className="hairline-t mt-4 pt-3">
      {said && !open ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-primary">
          <Sunrise size={15} strokeWidth={1.75} aria-hidden className="text-text-muted" />
          You said you started at <span className="tnum font-medium">{said}</span>
          {mine?.note ? <span className="text-text-secondary">({mine.note})</span> : null}
          <Button variant="ghost" size="sm" className={TOUCH} onClick={openForm}>
            Change
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn('text-state-danger', TOUCH)}
            loading={declare.isPending}
            onClick={() => declare.mutate({ time: null, note: '' })}
          >
            Remove
          </Button>
        </p>
      ) : null}
      {!said && !open ? (
        <Button variant="secondary" size="sm" className={TOUCH} icon={<Sunrise size={14} strokeWidth={1.75} />} onClick={openForm}>
          I started before {start}
        </Button>
      ) : null}
      {open ? (
        <form onSubmit={save} aria-label="When you started today" className="space-y-3" noValidate>
          <p className="text-[13px] text-text-secondary">
            Began before {start}? Say when. Mr Tito sees it beside your day, as said by you.
          </p>
          <div className="flex flex-wrap gap-3">
            <div>
              <Label htmlFor={`${id}-time`}>Started at</Label>
              <Input
                ref={timeRef}
                id={`${id}-time`}
                type="time"
                min="04:00"
                max={start}
                step={300}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={cn('w-[140px]', TOUCH)}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <Label htmlFor={`${id}-note`}>What on (optional)</Label>
              <Input id={`${id}-note`} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className={TOUCH} />
            </div>
          </div>
          <FieldError>{problem}</FieldError>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className={TOUCH} loading={declare.isPending}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" className={TOUCH} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

/**
 * On Mr Tito's day: what the person said about an early start, beside the
 * evidence (their first task step, knock or chat that day). Says nothing when
 * there is nothing before the official start to tell.
 */
export function StartLine({ start, zone, officialStart }: { start: DayStart | undefined; zone: string; officialStart: string }) {
  if (!start) return null
  const at = (iso: string) => localParts(zone, new Date(iso)).time
  const said = start.started_at ? at(start.started_at) : null
  const first = start.first_work_at ? at(start.first_work_at) : null
  const early = first && first < officialStart ? first : null
  if (!said && !early) return null
  return (
    <p className="tnum mt-0.5 flex items-center gap-1.5 text-[12px] text-text-secondary">
      <Sunrise size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-muted" />
      <span>
        {said ? `Started ${said}, said by them${start.note ? `: ${start.note}` : ''}` : 'Said nothing about an early start'}
        {early ? ` · first work seen ${early}` : ''}
      </span>
    </p>
  )
}
