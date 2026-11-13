import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { CalendarDays } from 'lucide-react'
import { Button, EmptyState, FieldError, Input, Label, Select, Skeleton, Textarea } from '@/components/ui/primitives'
import { useOfficeMembers, useOfficeRole, useOfficeSettings } from '@/hooks/useOffice'
import { useCancelLeave, useDecideLeave, useExtrasAvailable, useLeave, useRequestLeave, useWhoIsOff, type LeaveKind, type LeaveRequest } from '@/hooks/useExtras'
import { ExtrasOff } from '@/components/office/ExtrasOff'
import { useNow } from '@/hooks/useNow'
import { useToastStore } from '@/stores/toastStore'
import { useAuthStore } from '@/stores/authStore'
import { localParts } from '@/lib/timezones'
import { cn } from '@/lib/utils'

/**
 * Time off (0021). Ask, a manager or HR decides, and approval becomes a day away:
 * reports stop being due and the door says so, without anyone entering it twice.
 */
const KINDS: Record<LeaveKind, string> = { annual: 'Annual leave', sick: 'Sick leave', personal: 'Personal leave' }
const STATUS: Record<LeaveRequest['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting for a decision', tone: 'bg-[var(--tint-warning)] text-state-warning' },
  approved: { label: 'Approved', tone: 'bg-[var(--tint-brand)] text-state-success' },
  declined: { label: 'Declined', tone: 'bg-[var(--tint-danger)] text-state-danger' },
  cancelled: { label: 'Cancelled', tone: 'bg-surface-sunken text-text-muted' },
}

const fmt = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const range = (r: { starts_on: string; ends_on: string }) => (r.starts_on === r.ends_on ? fmt(r.starts_on) : `${fmt(r.starts_on)} to ${fmt(r.ends_on)}`)

function workdays(from: string, to: string) {
  let n = 0
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (![0, 6].includes(d.getUTCDay())) n++
  }
  return n
}

export function TimeOff() {
  const id = useId()
  const me = useAuthStore((s) => s.profile?.id) ?? ''
  const { seesTeam } = useOfficeRole()
  const { data: settings } = useOfficeSettings()
  const { data: members } = useOfficeMembers()
  const on = useExtrasAvailable()
  const { data, isLoading, isError } = useLeave()
  const ask = useRequestLeave()
  const decide = useDecideLeave()
  const cancel = useCancelLeave()
  const now = useNow()
  const showToast = useToastStore((s) => s.showToast)
  const fail = (e: Error) => showToast(e.message, 'error')
  const { data: offRows } = useWhoIsOff()
  const today = localParts(settings?.timezone ?? 'Africa/Lagos', now).date
  const [kind, setKind] = useState<LeaveKind>('annual')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const waitHeading = useRef<HTMLHeadingElement>(null)
  const mineHeading = useRef<HTMLHeadingElement>(null)
  const pending = on === undefined || isLoading

  const names = useMemo(() => new Map((members ?? []).map((m) => [m.user_id, m.user?.full_name ?? 'Someone'])), [members])
  const nameOf = (uid: string | null) => (uid && names.get(uid)) || 'Someone'
  const rows = data ?? []
  const mine = rows.filter((r) => r.user_id === me)
  const waiting = rows.filter((r) => r.status === 'pending' && r.user_id !== me)
  const off = offRows ?? []
  // Approved annual leave this calendar year, in working days. The office has no
  // allowance on file, so this is a count, not a balance.
  const year = today.slice(0, 4)
  const used = mine
    .filter((r) => r.kind === 'annual' && r.status === 'approved' && r.starts_on.slice(0, 4) === year)
    .reduce((n, r) => n + workdays(r.starts_on, r.ends_on), 0)
  /** Pending, or approved and not yet begun: the database refuses the rest. */
  const canCancel = (r: LeaveRequest) => r.status === 'pending' || (r.status === 'approved' && r.starts_on >= today)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!from) return setProblem('Choose the first day.')
    setProblem(null)
    ask.mutate(
      { kind, from, to: to || from, note: note.trim() },
      {
        onSuccess: () => {
          setFrom('')
          setTo('')
          setNote('')
          showToast('Request sent', 'success')
        },
        onError: (err) => setProblem(err.message),
      },
    )
  }
  // The row goes with the decision; focus stays with the list.
  const decided = (approve: boolean) => {
    showToast(approve ? 'Approved. Their reports pause for those days.' : 'Declined', approve ? 'success' : 'info')
    waitHeading.current?.focus({ preventScroll: true })
  }

  if (on === false) return <ExtrasOff icon={<CalendarDays size={22} strokeWidth={1.5} />} what="Time off" />

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">Time off</h1>
        <p className="mt-1.5 text-[13px] text-text-muted">Approved time off pauses your reports and shows on your door.</p>
      </div>
      <div className="mx-auto grid max-w-[1000px] gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {seesTeam ? (
            <section aria-labelledby={`${id}-wait`} className="space-y-2">
              <h2 id={`${id}-wait`} ref={waitHeading} tabIndex={-1} className="text-[15px] font-bold text-text-primary outline-none">
                Waiting for your decision
              </h2>
              {pending ? <Skeleton className="h-16" /> : !waiting.length ? <p className="text-[13px] text-text-muted">Nothing waiting.</p> : null}
              <ul className="space-y-2">
                {waiting.map((r) => {
                  const who = nameOf(r.user_id)
                  const days = workdays(r.starts_on, r.ends_on)
                  return (
                    <li key={r.id} className="hairline flex flex-wrap items-center gap-3 rounded-[14px] bg-surface-raised p-4">
                      <div className="mr-auto min-w-0">
                        <p className="text-[14px] font-semibold text-text-primary">{who}</p>
                        <p className="text-[13px] text-text-secondary">
                          {KINDS[r.kind]}, {range(r)} ({days} working {days === 1 ? 'day' : 'days'})
                        </p>
                        {r.note ? <p className="mt-1 text-[13px] text-text-muted">{r.note}</p> : null}
                      </div>
                      <Button
                        size="sm"
                        className="max-sm:h-11"
                        variant="secondary"
                        aria-label={`Decline ${who}, ${range(r)}`}
                        onClick={() => decide.mutate({ id: r.id, approve: false }, { onSuccess: () => decided(false), onError: fail })}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        className="max-sm:h-11"
                        aria-label={`Approve ${who}, ${range(r)}`}
                        onClick={() => decide.mutate({ id: r.id, approve: true }, { onSuccess: () => decided(true), onError: fail })}
                      >
                        Approve
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby={`${id}-mine`} className="space-y-2">
            <h2 id={`${id}-mine`} ref={mineHeading} tabIndex={-1} className="text-[15px] font-bold text-text-primary outline-none">
              My requests
            </h2>
            {pending ? <Skeleton className="h-24" /> : null}
            {isError ? <EmptyState title="Could not load time off" body="Try again in a moment." /> : null}
            {!pending && !isError && !mine.length ? <p className="text-[13px] text-text-muted">You have not asked for any time off yet.</p> : null}
            <ul className="space-y-2">
              {mine.map((r) => (
                <li key={r.id} className="hairline flex flex-wrap items-center gap-3 rounded-[14px] bg-surface-raised p-4">
                  <div className="mr-auto min-w-0">
                    <p className="text-[14px] font-semibold text-text-primary">
                      {KINDS[r.kind]}, {range(r)}
                    </p>
                    {r.decision_note ? (
                      <p className="mt-1 text-[13px] text-text-secondary">
                        {nameOf(r.decided_by)}: {r.decision_note}
                      </p>
                    ) : null}
                  </div>
                  <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-semibold', STATUS[r.status].tone)}>{STATUS[r.status].label}</span>
                  {canCancel(r) ? (
                    <Button
                      size="sm"
                      className="max-sm:h-11"
                      variant="ghost"
                      aria-label={`Cancel ${KINDS[r.kind]}, ${range(r)}`}
                      onClick={() => cancel.mutate(r.id, { onSuccess: () => mineHeading.current?.focus({ preventScroll: true }), onError: fail })}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby={`${id}-off`} className="space-y-2">
            <h2 id={`${id}-off`} className="text-[15px] font-bold text-text-primary">
              Who is off
            </h2>
            {!off.length ? <p className="text-[13px] text-text-muted">{pending ? 'Loading.' : 'Everyone is in for the foreseeable future.'}</p> : null}
            <ul className="space-y-1">
              {off.map((r) => (
                <li key={`${r.user_id}-${r.starts_on}`} className="flex flex-wrap justify-between gap-x-4 text-[14px]">
                  <span className="font-medium text-text-primary">{nameOf(r.user_id)}</span>
                  <span className="text-text-secondary">{range(r)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="rounded-[14px] bg-[var(--sidebar-bg)] p-4 text-white">
            <CalendarDays size={18} strokeWidth={1.75} aria-hidden className="text-accent" />
            <p className="tnum mt-2 text-[32px] leading-none font-extrabold">{used}</p>
            <p className="mt-1 text-[13px] text-[var(--on-dark-muted)]">
              {used === 1 ? 'working day' : 'working days'} of annual leave approved in {year}
            </p>
          </div>
          <form onSubmit={submit} className="hairline space-y-3 rounded-[14px] bg-surface-raised p-4" noValidate>
            <h2 className="text-[15px] font-bold text-text-primary">Ask for time off</h2>
            <div>
              <Label htmlFor={`${id}-kind`}>Type</Label>
              <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as LeaveKind)}>
                {Object.entries(KINDS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor={`${id}-from`}>First day</Label>
                <Input id={`${id}-from`} type="date" min={today} value={from} aria-invalid={problem ? true : undefined} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label htmlFor={`${id}-to`}>Last day</Label>
                <Input id={`${id}-to`} type="date" min={from || today} value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor={`${id}-note`}>Note (optional)</Label>
              <Textarea id={`${id}-note`} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <FieldError>{problem}</FieldError>
            <Button type="submit" loading={ask.isPending} className="w-full">
              Send the request
            </Button>
          </form>
        </aside>
      </div>
    </div>
  )
}
