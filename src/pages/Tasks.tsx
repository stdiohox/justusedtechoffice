import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, ExternalLink, ListChecks, Plus } from 'lucide-react'
import { Button, EmptyState, FieldError, Input, Label, Select, Skeleton, Textarea } from '@/components/ui/primitives'
import { Modal } from '@/components/ui/Modal'
import { Photo } from '@/components/ui/Photo'
import { useTeam } from '@/hooks/useTeam'
import { useOfficeSettings } from '@/hooks/useOffice'
import {
  useCancelTask,
  useCompleteTask,
  useCreateTask,
  useIsTaskAdmin,
  useReviewTask,
  useStartTask,
  useTaskEvents,
  useTasks,
} from '@/hooks/useTasks'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { localParts } from '@/lib/timezones'
import { TOUCH } from '@/lib/touch'
import { absoluteTime, cn, initials, relativeTime } from '@/lib/utils'
import {
  EVENT_LABEL,
  STATUS_LABEL,
  canCancel,
  canReview,
  dueLabel,
  isClosed,
  isOverdue,
  needsMe,
  sortTasks,
} from '@/lib/tasks'
import type { OfficeTask, TaskStatus } from '@/types/database'

/**
 * Tasks (0011). Anyone on the team gives anyone else a task; the assignee
 * starts it and marks it done; the person who gave it (or an admin: Mr Tito,
 * Hazel) checks it and approves it or sends it back. What each person may
 * see and do is decided by RLS and the 0011 functions; this screen only
 * offers what they would allow.
 */

type Tab = 'mine' | 'given' | 'all'
const TAB_WIDTH = 92

const CHIP = 'inline-flex items-center rounded-[8px] px-2 py-[3px] text-[11px] font-medium whitespace-nowrap'

const STATUS_TONE: Record<TaskStatus, string> = {
  open: 'bg-surface-sunken text-text-secondary',
  in_progress: 'bg-tint-accent text-text-primary',
  // Primary text on the warning tint: warning on its own tint is under 4.5:1 at 11px.
  done: 'bg-tint-warning text-text-primary',
  approved: 'bg-tint-brand text-state-success',
  cancelled: 'bg-surface-sunken text-text-muted',
}

function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={cn(CHIP, STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
}

function DueChip({ task, today }: { task: OfficeTask; today: string }) {
  if (!task.due_on || isClosed(task)) return null
  const overdue = isOverdue(task, today)
  return (
    <span className={cn(CHIP, 'gap-1', overdue ? 'bg-tint-danger text-state-danger' : 'bg-surface-sunken text-text-secondary')}>
      <CalendarDays size={12} strokeWidth={1.75} aria-hidden />
      {overdue ? `Overdue, was due ${dueLabel(task.due_on)}` : task.due_on === today ? 'Due today' : `Due ${dueLabel(task.due_on)}`}
    </span>
  )
}

function Person({ id, name }: { id: string; name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-[9px] font-bold text-surface">
        <Photo userId={id} className="size-5">
          {initials(name)}
        </Photo>
      </span>
      <span className="truncate">{name}</span>
    </span>
  )
}

/* ---------------------------------------------------------------- the list */

function TaskRow({
  task,
  today,
  userId,
  tab,
  nameOf,
  onOpen,
}: {
  task: OfficeTask
  today: string
  userId: string
  tab: Tab
  nameOf: (id: string) => string
  onOpen: () => void
}) {
  const mine = needsMe(task, userId)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-task-id={task.id}
        className={cn(
          'hairline row-in press w-full rounded-[14px] bg-surface-raised p-4 text-left transition-shadow duration-200 hover:shadow-[var(--shadow-md)]',
          mine && 'shadow-[var(--shadow-sm)] ring-1 ring-[var(--tint-accent-line)]',
          // Closed rows sit on the sunken surface; text keeps full contrast.
          isClosed(task) && 'bg-surface-sunken',
        )}
      >
        <span className="flex flex-wrap items-start gap-2">
          <span className="mr-auto min-w-0 flex-1 basis-[200px] text-[15px] font-medium break-words text-text-primary">{task.title}</span>
          <StatusChip status={task.status} />
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-text-secondary">
          {tab !== 'given' ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-text-muted">From</span>
              <Person id={task.assigned_by} name={task.assigned_by === userId ? 'You' : nameOf(task.assigned_by)} />
            </span>
          ) : null}
          {tab !== 'mine' ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-text-muted">To</span>
              <Person id={task.assigned_to} name={task.assigned_to === userId ? 'You' : nameOf(task.assigned_to)} />
            </span>
          ) : null}
          <DueChip task={task} today={today} />
          {mine ? (
            <span className="font-semibold text-text-primary">{task.status === 'done' ? 'Needs your check' : 'New for you'}</span>
          ) : null}
          <span className="ml-auto text-text-muted" title={absoluteTime(task.updated_at)}>
            {relativeTime(task.updated_at)}
          </span>
        </span>
      </button>
    </li>
  )
}

/* --------------------------------------------------------------- new task */

function NewTask({ open, onOpenChange, today }: { open: boolean; onOpenChange: (o: boolean) => void; today: string }) {
  const userId = useAuthStore((s) => s.profile?.id)
  const { data: team } = useTeam()
  const create = useCreateTask()
  const showToast = useToastStore((s) => s.showToast)
  const [to, setTo] = useState('')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [error, setError] = useState<{ text: string; field: 'to' | 'title' | null } | null>(null)
  const id = useId()
  const toRef = useRef<HTMLSelectElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const people = (team ?? []).filter((p) => !p.deactivated_at && p.id !== userId)

  const reset = () => {
    setTo('')
    setTitle('')
    setDetails('')
    setDueOn('')
    setError(null)
    create.reset()
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!to) {
      setError({ text: 'Choose who the task is for.', field: 'to' })
      return toRef.current?.focus()
    }
    if (!title.trim()) {
      setError({ text: 'Give the task a title.', field: 'title' })
      return titleRef.current?.focus()
    }
    setError(null)
    create.mutate(
      { to, title: title.trim(), details: details.trim(), dueOn },
      {
        onSuccess: () => {
          const name = people.find((p) => p.id === to)?.full_name ?? 'them'
          showToast(`Task given to ${name}`, 'success')
          onOpenChange(false)
          reset()
        },
        onError: (err) => setError({ text: err.message, field: null }),
      },
    )
  }
  const errorId = `${id}-error`
  const invalid = (field: 'to' | 'title') =>
    error?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {}

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
      title="Give a task"
      description="They are told in the office and by email. When they mark it done, you check it."
    >
      <form id={`${id}-form`} onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <Label htmlFor={`${id}-to`}>For</Label>
          <Select
            ref={toRef}
            id={`${id}-to`}
            value={to}
            aria-required
            {...invalid('to')}
            onChange={(e) => setTo(e.target.value)}
            className={cn(TOUCH, error?.field === 'to' && 'border-state-danger')}
          >
            <option value="">Choose a teammate</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor={`${id}-title`}>Task</Label>
          <Input
            ref={titleRef}
            id={`${id}-title`}
            aria-required
            invalid={error?.field === 'title'}
            {...invalid('title')}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Photograph the new laptops"
            className={TOUCH}
          />
        </div>
        <div>
          <Label htmlFor={`${id}-details`}>Details (optional)</Label>
          <Textarea id={`${id}-details`} value={details} maxLength={4000} rows={3} onChange={(e) => setDetails(e.target.value)} />
        </div>
        <div>
          <Label htmlFor={`${id}-due`}>Due (optional)</Label>
          <Input id={`${id}-due`} type="date" value={dueOn} min={today} onChange={(e) => setDueOn(e.target.value)} className={cn('w-[180px]', TOUCH)} />
        </div>
        <div id={errorId}>
          <FieldError>{error?.text}</FieldError>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            className={TOUCH}
            onClick={() => {
              onOpenChange(false)
              reset()
            }}
          >
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending} className={TOUCH}>
            Give task
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/* ------------------------------------------------------------ one task open */

type Draft = { kind: 'done' | 'return' | 'cancel'; note: string; link: string } | null

function TaskDetail({
  task,
  today,
  nameOf,
  onClose,
  onCloseAutoFocus,
}: {
  task: OfficeTask
  today: string
  nameOf: (id: string) => string
  onClose: () => void
  onCloseAutoFocus: (event: Event) => void
}) {
  const userId = useAuthStore((s) => s.profile?.id) ?? ''
  const admin = useIsTaskAdmin()
  const { data: events, isLoading: eventsLoading } = useTaskEvents(task.id)
  const start = useStartTask()
  const complete = useCompleteTask()
  const review = useReviewTask()
  const cancel = useCancelTask()
  const showToast = useToastStore((s) => s.showToast)
  const [draft, setDraft] = useState<Draft>(null)
  const [error, setError] = useState<string | null>(null)
  // Said inside the dialog: the toast lives outside it, where a screen reader
  // is told not to look while the dialog is open.
  const [announce, setAnnounce] = useState('')
  // Where focus goes when the control it was on disappears (an action done, a
  // form closed): the task's status, so the keyboard keeps its place.
  const statusRef = useRef<HTMLDivElement>(null)
  const refocus = () => requestAnimationFrame(() => statusRef.current?.focus())
  const id = useId()

  const assignee = task.assigned_to === userId
  const busy = start.isPending || complete.isPending || review.isPending || cancel.isPending
  const who = (pid: string | null) => (!pid ? 'Someone' : pid === userId ? 'You' : nameOf(pid))
  const fail = (err: Error) => {
    setError(err.message)
    refocus()
  }
  const openDraft = (kind: NonNullable<Draft>['kind']) => {
    setError(null)
    setDraft({ kind, note: '', link: '' })
  }
  const done = (message: string) => {
    setDraft(null)
    setError(null)
    setAnnounce(message)
    showToast(message, 'success')
    refocus()
  }

  const actions: ReactNode[] = []
  if (assignee && task.status === 'open' && !draft) {
    actions.push(
      <Button key="start" variant="secondary" loading={start.isPending} disabled={busy} className={TOUCH} onClick={() => start.mutate(task.id, { onSuccess: () => done('Started'), onError: fail })}>
        Start
      </Button>,
    )
  }
  if (assignee && (task.status === 'open' || task.status === 'in_progress') && !draft) {
    actions.push(
      <Button key="done" disabled={busy} className={TOUCH} onClick={() => openDraft('done')}>
        Mark done
      </Button>,
    )
  }
  if (canReview(task, userId, admin) && !draft) {
    actions.push(
      <Button key="return" variant="secondary" disabled={busy} className={TOUCH} onClick={() => openDraft('return')}>
        Send back
      </Button>,
      <Button
        key="approve"
        loading={review.isPending}
        disabled={busy}
        className={TOUCH}
        onClick={() => review.mutate({ id: task.id, approve: true, note: '' }, { onSuccess: () => done('Approved'), onError: fail })}
      >
        Approve
      </Button>,
    )
  }

  const submitDraft = (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    if (draft.kind === 'done') {
      complete.mutate(
        { id: task.id, note: draft.note.trim(), link: draft.link.trim() },
        { onSuccess: () => done(`Done. ${who(task.assigned_by)} will check it.`), onError: fail },
      )
    } else if (draft.kind === 'return') {
      if (!draft.note.trim()) return setError('Say what still needs doing.')
      review.mutate({ id: task.id, approve: false, note: draft.note.trim() }, { onSuccess: () => done('Sent back'), onError: fail })
    } else {
      cancel.mutate({ id: task.id, note: draft.note.trim() }, { onSuccess: () => done('Task cancelled'), onError: fail })
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      onCloseAutoFocus={onCloseAutoFocus}
      title={task.title}
      description={`${who(task.assigned_by)} gave this to ${who(task.assigned_to).replace(/^You$/, 'you')}`}
    >
      <div className="space-y-4">
        <p role="status" className="sr-only">
          {announce}
        </p>
        <div ref={statusRef} tabIndex={-1} aria-label={`Status: ${STATUS_LABEL[task.status]}`} className="flex flex-wrap items-center gap-2 rounded-[8px]">
          <StatusChip status={task.status} />
          <DueChip task={task} today={today} />
        </div>

        {task.details ? <p className="text-sm whitespace-pre-wrap text-text-primary">{task.details}</p> : null}

        {(task.status === 'done' || task.status === 'approved') && (task.done_note || task.done_link) ? (
          <div className="rounded-[12px] bg-surface-sunken p-3 text-sm">
            <p className="text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">Handed in</p>
            {task.done_note ? <p className="mt-1 whitespace-pre-wrap text-text-primary">{task.done_note}</p> : null}
            {/* The database allows only http(s) links; checked again here, where it becomes an href. */}
            {task.done_link && /^https?:\/\//i.test(task.done_link) ? (
              <a
                href={task.done_link}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex max-w-full items-center gap-1 font-semibold break-all text-brand underline-offset-2 hover:underline"
              >
                <ExternalLink size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />
                {task.done_link}
              </a>
            ) : null}
          </div>
        ) : null}

        <section aria-labelledby={`${id}-history`}>
          <h3 id={`${id}-history`} className="text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">
            History
          </h3>
          {eventsLoading ? (
            <Skeleton className="mt-2 h-12" />
          ) : (
            <ol className="mt-2 space-y-2">
              {(events ?? []).map((ev) => (
                <li key={ev.id} className="text-[13px] text-text-secondary">
                  <span className="font-medium text-text-primary">{who(ev.actor)}</span> {EVENT_LABEL[ev.kind]}
                  <span className="text-text-muted" title={absoluteTime(ev.created_at)}>
                    {' '}
                    · {relativeTime(ev.created_at)}
                  </span>
                  {ev.note ? <span className="mt-0.5 block whitespace-pre-wrap text-text-primary">“{ev.note}”</span> : null}
                </li>
              ))}
            </ol>
          )}
        </section>

        {draft ? (
          <form
            onSubmit={submitDraft}
            aria-label={draft.kind === 'done' ? 'Mark this task done' : draft.kind === 'return' ? 'Send this task back' : 'Cancel this task'}
            className="hairline-t space-y-3 pt-4"
            noValidate
          >
            {draft.kind === 'done' ? (
              <>
                <div>
                  <Label htmlFor={`${id}-note`}>Note (optional)</Label>
                  <Textarea
                    id={`${id}-note`}
                    autoFocus
                    rows={3}
                    maxLength={2000}
                    value={draft.note}
                    onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    placeholder="What you did, or where to find it"
                  />
                </div>
                <div>
                  <Label htmlFor={`${id}-link`}>Link (optional)</Label>
                  <Input
                    id={`${id}-link`}
                    type="url"
                    inputMode="url"
                    maxLength={2000}
                    value={draft.link}
                    onChange={(e) => setDraft({ ...draft, link: e.target.value })}
                    placeholder="https://"
                    className={TOUCH}
                  />
                </div>
              </>
            ) : (
              <div>
                <Label htmlFor={`${id}-note`}>{draft.kind === 'return' ? 'What still needs doing' : 'Why (optional)'}</Label>
                <Textarea
                  id={`${id}-note`}
                  autoFocus
                  rows={3}
                  maxLength={2000}
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </div>
            )}
            <FieldError>{error}</FieldError>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                className={TOUCH}
                onClick={() => {
                  setDraft(null)
                  setError(null)
                  refocus()
                }}
              >
                Back
              </Button>
              <Button type="submit" variant={draft.kind === 'cancel' ? 'danger' : 'primary'} loading={busy} className={TOUCH}>
                {draft.kind === 'done' ? 'Mark done' : draft.kind === 'return' ? 'Send back' : 'Cancel the task'}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <FieldError>{error}</FieldError>
            {actions.length || canCancel(task, userId, admin) ? (
              <div className="hairline-t flex flex-wrap items-center justify-end gap-2 pt-4">
                {canCancel(task, userId, admin) ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    className={cn('mr-auto text-state-danger', TOUCH)}
                    onClick={() => openDraft('cancel')}
                  >
                    Cancel task
                  </Button>
                ) : null}
                {actions}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------------- page */

function Tabs({ tabs, tab, onTab }: { tabs: { id: Tab; label: string }[]; tab: Tab; onTab: (t: Tab) => void }) {
  const i = tabs.findIndex((t) => t.id === tab)
  return (
    <div
      role="tablist"
      aria-label="Which tasks"
      className="relative flex h-9 rounded-[14px] border border-line bg-surface-sunken p-[3px] max-sm:h-[52px]"
      onKeyDown={(e) => {
        // The ARIA tab pattern: arrows move between tabs, Home/End jump.
        const next =
          e.key === 'ArrowRight' ? (i + 1) % tabs.length
          : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home' ? 0
          : e.key === 'End' ? tabs.length - 1
          : -1
        if (next < 0) return
        e.preventDefault()
        onTab(tabs[next].id)
        document.getElementById(`tasks-tab-${tabs[next].id}`)?.focus()
      }}
    >
      <span
        aria-hidden
        className="seg-thumb absolute top-[3px] bottom-[3px] left-[3px] rounded-[10px] bg-surface-raised shadow-[var(--shadow-sm)]"
        style={{ width: TAB_WIDTH, transform: `translateX(${i * TAB_WIDTH}px)` }}
      />
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tasks-tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls="tasks-panel"
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onTab(t.id)}
          style={{ width: TAB_WIDTH }}
          className={cn(
            'relative rounded-[10px] text-[13px] font-medium transition-colors duration-150',
            tab === t.id ? 'font-semibold text-text-primary' : 'text-text-muted hover:text-text-primary',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Closing a task hands focus back to its row. If the row has gone (approved
 * or cancelled into the folded list, or the task was opened from a link),
 * focus goes to "Give a task" instead of falling to <body>.
 */
function returnFocus(e: Event, taskId: string, fallback: RefObject<HTMLButtonElement | null>) {
  const row = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`)
  e.preventDefault()
  ;(row ?? fallback.current)?.focus()
}

export function Tasks() {
  const userId = useAuthStore((s) => s.profile?.id) ?? ''
  const admin = useIsTaskAdmin()
  const { data, isLoading, isError, error } = useTasks()
  const { data: team } = useTeam()
  const { data: settings } = useOfficeSettings()
  const [tab, setTab] = useState<Tab>('mine')
  const [showClosed, setShowClosed] = useState(false)
  const [creating, setCreating] = useState(false)
  const giveRef = useRef<HTMLButtonElement>(null)
  // ?task=<id> opens one task: the pop-ups link here.
  const [params, setParams] = useSearchParams()
  const openId = params.get('task')

  const today = localParts(settings?.timezone ?? 'Africa/Lagos', new Date()).date
  // "…" until the team is in, so nobody shows as a former member for a moment.
  const nameOf = (id: string) => {
    if (!team) return '…'
    const p = team.find((x) => x.id === id)
    return !p ? 'Former member' : p.deactivated_at ? `${p.full_name} (left)` : p.full_name
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[820px] space-y-3 p-5">
        <Skeleton className="h-[46px] w-[220px]" />
        <Skeleton className="h-[88px]" />
        <Skeleton className="h-[88px]" />
      </div>
    )
  }
  if (isError || !data) {
    return <EmptyState title="Could not load tasks" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
  }
  if (!data.available) {
    return (
      <EmptyState
        icon={<ListChecks size={22} strokeWidth={1.5} />}
        title="Tasks are not switched on yet"
        body="Ask Mr Tito: the office's database needs one more update (migration 0011)."
      />
    )
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'mine', label: 'For me' },
    { id: 'given', label: 'I gave' },
    ...(admin ? [{ id: 'all' as const, label: 'Everyone' }] : []),
  ]
  const current = tabs.some((t) => t.id === tab) ? tab : 'mine'
  const inTab = data.rows.filter((t) =>
    current === 'mine' ? t.assigned_to === userId : current === 'given' ? t.assigned_by === userId : true,
  )
  const live = sortTasks(inTab.filter((t) => !isClosed(t)), userId)
  const closed = sortTasks(inTab.filter(isClosed), userId)
  const waitingOnMe = data.rows.filter((t) => needsMe(t, userId)).length
  const opened = openId ? data.rows.find((t) => t.id === openId) : undefined
  const open = (id: string | null) =>
    setParams(
      (p) => {
        if (id) p.set('task', id)
        else p.delete('task')
        return p
      },
      { replace: true },
    )

  const empty =
    current === 'mine'
      ? { title: 'Nothing on your list', body: 'When a teammate gives you a task, it shows here.' }
      : current === 'given'
        ? { title: 'You have not given any tasks', body: 'Give a teammate a task, and check it here when they are done.' }
        : { title: 'No tasks yet', body: 'Tasks anyone gives anyone show here.' }

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 flex flex-wrap items-end gap-3 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <div className="mr-auto">
          <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">Tasks</h1>
          <p className="mt-1.5 text-[13px] text-text-muted" aria-live="polite">
            {waitingOnMe ? `${waitingOnMe} waiting on you` : 'Nothing waiting on you'}
          </p>
        </div>
        <Tabs tabs={tabs} tab={current} onTab={setTab} />
        <Button ref={giveRef} icon={<Plus size={16} strokeWidth={2} aria-hidden />} className={TOUCH} onClick={() => setCreating(true)}>
          Give a task
        </Button>
      </div>

      <div id="tasks-panel" role="tabpanel" tabIndex={0} aria-labelledby={`tasks-tab-${current}`} className="mx-auto max-w-[820px] p-4 sm:p-6">
        {live.length ? (
          <ul className="space-y-3">
            {live.map((t) => (
              <TaskRow key={t.id} task={t} today={today} userId={userId} tab={current} nameOf={nameOf} onOpen={() => open(t.id)} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<ListChecks size={22} strokeWidth={1.5} />} title={empty.title} body={empty.body} />
        )}

        {closed.length ? (
          <div className="mt-6">
            <button
              type="button"
              aria-expanded={showClosed}
              onClick={() => setShowClosed((s) => !s)}
              className={cn('text-[13px] font-medium text-text-secondary hover:text-text-primary', TOUCH)}
            >
              {showClosed ? 'Hide' : 'Show'} approved and cancelled ({closed.length})
            </button>
            {showClosed ? (
              <ul className="mt-3 space-y-3">
                {closed.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} userId={userId} tab={current} nameOf={nameOf} onOpen={() => open(t.id)} />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <NewTask open={creating} onOpenChange={setCreating} today={today} />
      {opened ? (
        <TaskDetail
          key={opened.id}
          task={opened}
          today={today}
          nameOf={nameOf}
          onClose={() => open(null)}
          onCloseAutoFocus={(e) => returnFocus(e, opened.id, giveRef)}
        />
      ) : null}
    </div>
  )
}
