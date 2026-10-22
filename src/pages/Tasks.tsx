import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, ImagePlus, ListChecks, Pencil, Plus, Star, X } from 'lucide-react'
import { Button, EmptyState, FieldError, Input, Label, Select, Skeleton, Textarea } from '@/components/ui/primitives'
import { Modal } from '@/components/ui/Modal'
import { Photo } from '@/components/ui/Photo'
import { useTeam } from '@/hooks/useTeam'
import { useOfficeSettings } from '@/hooks/useOffice'
import { useNow } from '@/hooks/useNow'
import {
  useCancelTask,
  useRateTask,
  useTaskFiles,
  PROOF_MAX_BYTES,
  PROOF_MAX_FILES,
  proofType,
  type TaskImage,
  useCompleteTask,
  useCreateTask,
  useEditTask,
  useIsTaskAdmin,
  useReviewTask,
  useStartTask,
  useTaskEvents,
  useTasks,
} from '@/hooks/useTasks'
import { useAuthStore } from '@/stores/authStore'
import { useHasColumn } from '@/hooks/useHasColumn'
import { LinkList, LinksField } from '@/components/office/Links'
import { linksOf, linksProblem } from '@/lib/links'
import { useToastStore } from '@/stores/toastStore'
import { localParts } from '@/lib/timezones'
import { TOUCH } from '@/lib/touch'
import { absoluteTime, cn, initials, relativeTime } from '@/lib/utils'
import {
  EVENT_LABEL,
  canCancel,
  canEdit,
  canRate,
  canReview,
  dueLabel,
  isClosed,
  isOverdue,
  isPersonal,
  needsMe,
  sortTasks,
  statusLabel,
} from '@/lib/tasks'
import type { OfficeTask, OfficeTaskEvent, TaskStatus } from '@/types/database'

/**
 * Tasks (0011). Anyone on the team gives anyone else a task; the assignee
 * starts it and marks it done; the person who gave it (or an admin: Mr Tito,
 * Hazel) checks it and approves it or sends it back. Anyone can also give
 * themselves a personal task (0015): no check, no stars, no points. The giver
 * (or an admin) can edit a task until it is handed in. What each person may
 * see and do is decided by RLS and the 0011/0015 functions; this screen only
 * offers what they would allow.
 */

type Tab = 'mine' | 'personal' | 'given' | 'all'
/** Four tabs fit a 390px phone at 84px each; three keep the wider 92px. */
const tabWidth = (n: number) => (n > 3 ? 84 : 92)

const CHIP = 'inline-flex items-center rounded-[8px] px-2 py-[3px] text-[11px] font-medium whitespace-nowrap'

const STATUS_TONE: Record<TaskStatus, string> = {
  open: 'bg-surface-sunken text-text-secondary',
  in_progress: 'bg-tint-accent text-text-primary',
  // Primary text on the warning tint: warning on its own tint is under 4.5:1 at 11px.
  done: 'bg-tint-warning text-text-primary',
  approved: 'bg-tint-brand text-state-success',
  cancelled: 'bg-surface-sunken text-text-muted',
}

function StatusChip({ task }: { task: OfficeTask }) {
  return <span className={cn(CHIP, STATUS_TONE[task.status])}>{statusLabel(task)}</span>
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

/* ----------------------------------------------------------------- stars (0012) */

/**
 * Filled stars in the dark gold (state-warning): the brand gold is under 3:1
 * on the light surface, and the stars are the information, not decoration.
 */
function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          strokeWidth={1.75}
          aria-hidden
          className={n <= value ? 'fill-[var(--color-state-warning)] text-state-warning' : 'text-text-muted'}
        />
      ))}
    </span>
  )
}

/** Five radio buttons drawn as stars: arrow keys move between them, as for any radio group. */
function StarPicker({
  value,
  onChange,
  name,
  errorId,
}: {
  value: number
  onChange: (n: number) => void
  name: string
  /** The error under the group, when there is one. */
  errorId?: string
}) {
  return (
    <fieldset aria-describedby={errorId}>
      <legend className="mb-1.5 block text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">Stars</legend>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <label
            key={n}
            className="press cursor-pointer rounded-[8px] p-1 transition-colors duration-150 hover:bg-[var(--hover)] has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand has-[input:focus-visible]:ring-offset-2 has-[input:focus-visible]:ring-offset-surface-sunken max-sm:p-2"
          >
            {/* Focus lands on the chosen star, or the first, when the form opens. */}
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              autoFocus={value ? value === n : n === 1}
              className="sr-only"
            />
            <Star
              size={26}
              strokeWidth={1.75}
              aria-hidden
              className={n <= value ? 'fill-[var(--color-state-warning)] text-state-warning' : 'text-text-muted'}
            />
            <span className="sr-only">
              {n} {n === 1 ? 'star' : 'stars'}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * The rating on an approved task: shown to everyone who can see the task;
 * given or changed by the giver or an admin for 7 days (0012's rate_task).
 */
function RatingBlock({
  task,
  editable,
  who,
  onSaved,
}: {
  task: OfficeTask
  editable: boolean
  who: (id: string | null) => string
  onSaved: (message: string) => void
}) {
  const rate = useRateTask()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [stars, setStars] = useState(task.rating ?? 0)
  const [note, setNote] = useState(task.rating_note ?? '')
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rating = task.rating ?? null
  const rated = rating !== null
  if (!rated && !editable) return null

  // Opening starts from the saved rating, never from an edit that was abandoned.
  const openForm = () => {
    setStars(task.rating ?? 0)
    setNote(task.rating_note ?? '')
    setError(null)
    setOpen(true)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!stars) return setError('Choose 1 to 5 stars.')
    setError(null)
    // Awaited rather than per-call callbacks: saving changes rated_at, which
    // remounts this block (its key), and the message must still be said.
    try {
      await rate.mutateAsync({ id: task.id, stars, note: note.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The rating was not saved. Try again.')
      return
    }
    setOpen(false)
    onSaved(`Rated ${stars} of 5. ${who(task.assigned_to)} will see it.`)
  }

  return (
    <section aria-labelledby={`${id}-rating`} className="rounded-[12px] bg-surface-sunken p-3 text-sm">
      <h3 ref={headingRef} tabIndex={-1} id={`${id}-rating`} className="rounded-[6px] text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">
        Rating
      </h3>
      {rated && !open ? (
        <div className="mt-1.5 space-y-1">
          <Stars value={rating ?? 0} size={16} />
          {task.rating_note ? <p className="whitespace-pre-wrap text-text-primary">{task.rating_note}</p> : null}
          <p className="text-[12px] text-text-muted">From {who(task.rated_by ?? null)}</p>
        </div>
      ) : null}
      {editable && !open ? (
        <Button size="sm" variant="secondary" className={cn('mt-2', TOUCH)} onClick={openForm}>
          {rated ? 'Change rating' : 'Rate this task'}
        </Button>
      ) : null}
      {open ? (
        <form onSubmit={(e) => void save(e)} aria-label="Rate this task" className="mt-2 space-y-3" noValidate>
          <StarPicker
            errorId={error ? `${id}-error` : undefined}
            value={stars}
            onChange={(n) => {
              setStars(n)
              setError(null)
            }}
            name={`${id}-stars`}
          />
          <div>
            <Label htmlFor={`${id}-note`}>Comment (optional)</Label>
            <Input id={`${id}-note`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className={TOUCH} />
          </div>
          <div id={`${id}-error`}>
            <FieldError>{error}</FieldError>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              className={TOUCH}
              onClick={() => {
                setOpen(false)
                setError(null)
                // The form is gone; its heading keeps the keyboard's place.
                requestAnimationFrame(() => headingRef.current?.focus())
              }}
            >
              Back
            </Button>
            <Button type="submit" loading={rate.isPending} className={TOUCH}>
              Save rating
            </Button>
          </div>
        </form>
      ) : null}
    </section>
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
  const personal = isPersonal(task)
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
          <StatusChip task={task} />
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-text-secondary">
          {personal ? (
            // Personal (0015): one person, no From and To. On the Personal tab it is always you.
            tab === 'personal' ? null : (
              <span className="inline-flex items-center gap-1.5">
                <Person id={task.assigned_to} name={task.assigned_to === userId ? 'You' : nameOf(task.assigned_to)} />
                <span className={cn(CHIP, 'bg-surface-sunken text-text-secondary')}>
                  <span className="sr-only">, a </span>Personal<span className="sr-only"> task</span>
                </span>
              </span>
            )
          ) : tab !== 'given' ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-text-muted">From</span>
              <Person id={task.assigned_by} name={task.assigned_by === userId ? 'You' : nameOf(task.assigned_by)} />
            </span>
          ) : null}
          {!personal && tab !== 'mine' ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-text-muted">To</span>
              <Person id={task.assigned_to} name={task.assigned_to === userId ? 'You' : nameOf(task.assigned_to)} />
            </span>
          ) : null}
          <DueChip task={task} today={today} />
          {typeof task.rating === 'number' ? <Stars value={task.rating} size={12} /> : null}
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

function NewTask({
  open,
  onOpenChange,
  today,
  forMe,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  today: string
  /** Opened from the Personal tab: "Myself" is chosen to start with. */
  forMe: boolean
}) {
  const userId = useAuthStore((s) => s.profile?.id) ?? ''
  const { data: team } = useTeam()
  const create = useCreateTask()
  const showToast = useToastStore((s) => s.showToast)
  // Null until a choice is made, so the opening default follows the tab.
  const [chosen, setChosen] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [error, setError] = useState<{ text: string; field: 'to' | 'title' | null } | null>(null)
  const id = useId()
  const toRef = useRef<HTMLSelectElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const people = (team ?? []).filter((p) => !p.deactivated_at && p.id !== userId)
  const to = chosen ?? (forMe ? userId : '')
  const personal = !!to && to === userId

  const reset = () => {
    setChosen(null)
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
          showToast(personal ? 'Added to your personal tasks' : `Task given to ${name}`, 'success')
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
      title={personal ? 'Add a personal task' : 'Give a task'}
      description={
        personal
          ? 'Your own work, to keep on your list and track. Only you and the admins see it. Done closes it: no check, no stars, no points.'
          : 'They are told in the office and by email. When they mark it done, you check it.'
      }
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
            onChange={(e) => setChosen(e.target.value)}
            className={cn(TOUCH, error?.field === 'to' && 'border-state-danger')}
          >
            <option value="">Choose who it is for</option>
            {userId ? <option value={userId}>Myself (a personal task)</option> : null}
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
            placeholder={personal ? 'Update my trade-in price notes' : 'Photograph the new laptops'}
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
            {personal ? 'Add task' : 'Give task'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/* -------------------------------------------------------------- editing (0015) */

/**
 * Fixing a task while it is To do or In progress: title, details, due date,
 * and (not for a personal task) who it is for. The person it was given to is
 * told; moving it starts it again as To do for the new person.
 */
function EditTask({
  task,
  today,
  onSaved,
  onBack,
}: {
  task: OfficeTask
  today: string
  onSaved: (message: string) => void
  onBack: () => void
}) {
  const { data: team } = useTeam()
  const edit = useEditTask()
  const personal = isPersonal(task)
  // The task as it was when the form opened: edit_task takes whole values, so
  // a change made meanwhile (realtime) must be seen before it is overwritten.
  const [base, setBase] = useState(task)
  const [title, setTitle] = useState(task.title)
  const [details, setDetails] = useState(task.details ?? '')
  const [dueOn, setDueOn] = useState(task.due_on ?? '')
  // Null until the person is changed here: a move made meanwhile is never undone by saving.
  const [to, setTo] = useState<string | null>(null)
  const [error, setError] = useState<{ text: string; field: 'title' | 'due' | null } | null>(null)
  const id = useId()
  const titleRef = useRef<HTMLInputElement>(null)
  const dueRef = useRef<HTMLInputElement>(null)
  const stale = task.updated_at !== base.updated_at
  const current = to ?? task.assigned_to
  // Anyone active but the person who gave it; whoever has it now stays listed even if they have left.
  const people = (team ?? []).filter((p) => p.id !== task.assigned_by && (!p.deactivated_at || p.id === task.assigned_to))
  const moving = current !== task.assigned_to
  const nameOf = (pid: string) => team?.find((p) => p.id === pid)?.full_name ?? 'them'
  // A due date already past may stay as it is; a new one starts from today.
  const minDue = task.due_on && task.due_on < today ? task.due_on : today

  const useLatest = () => {
    setBase(task)
    setTitle(task.title)
    setDetails(task.details ?? '')
    setDueOn(task.due_on ?? '')
    setTo(null)
    setError(null)
    requestAnimationFrame(() => titleRef.current?.focus())
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (stale) return
    if (!title.trim()) {
      setError({ text: 'Give the task a title.', field: 'title' })
      return titleRef.current?.focus()
    }
    if (dueOn && dueOn !== (task.due_on ?? '') && dueOn < today) {
      setError({ text: 'The due date has already passed.', field: 'due' })
      return dueRef.current?.focus()
    }
    setError(null)
    edit.mutate(
      { id: task.id, title: title.trim(), details: details.trim(), dueOn, to: moving ? current : null, personal },
      {
        onSuccess: (data) =>
          onSaved(!data ? 'Nothing changed' : moving ? `Moved to ${nameOf(current)}. They are told.` : personal ? 'Task updated' : `Task updated. ${nameOf(task.assigned_to)} is told.`),
        onError: (err) => setError({ text: err.message, field: null }),
      },
    )
  }
  const errorId = `${id}-error`
  const invalid = (field: 'title' | 'due') =>
    error?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {}

  return (
    <form onSubmit={submit} aria-label="Edit this task" className="hairline-t space-y-3 pt-4" noValidate>
      {stale ? (
        <div role="alert" className="rounded-[8px] bg-tint-warning p-3 text-[13px] text-text-primary">
          This task changed while you were editing it.{' '}
          <button type="button" onClick={useLatest} className={cn('font-semibold text-brand underline underline-offset-2', TOUCH)}>
            Start again from the latest
          </button>
        </div>
      ) : null}
      <div>
        <Label htmlFor={`${id}-title`}>Task</Label>
        <Input
          ref={titleRef}
          id={`${id}-title`}
          autoFocus
          aria-required
          invalid={error?.field === 'title'}
          {...invalid('title')}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          className={TOUCH}
        />
      </div>
      <div>
        <Label htmlFor={`${id}-details`}>Details (optional)</Label>
        <Textarea id={`${id}-details`} value={details} maxLength={4000} rows={3} onChange={(e) => setDetails(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-3">
        <div>
          <Label htmlFor={`${id}-due`}>Due (optional)</Label>
          <Input
            ref={dueRef}
            id={`${id}-due`}
            type="date"
            value={dueOn}
            min={minDue}
            invalid={error?.field === 'due'}
            {...invalid('due')}
            onChange={(e) => setDueOn(e.target.value)}
            className={cn('w-[180px]', TOUCH)}
          />
        </div>
        {!personal ? (
          <div className="min-w-[200px] flex-1">
            <Label htmlFor={`${id}-to`}>For</Label>
            <Select id={`${id}-to`} value={current} aria-describedby={`${id}-moving`} onChange={(e) => setTo(e.target.value)} className={TOUCH}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </Select>
            {/* Always there, so the change is said as it happens, not only on focus. */}
            <p id={`${id}-moving`} role="status" className="mt-1 text-[12px] text-text-muted">
              {moving ? `${nameOf(current)} gets it as a new task, To do. ${nameOf(task.assigned_to)} no longer sees it.` : ''}
            </p>
          </div>
        ) : null}
      </div>
      <div id={errorId}>
        <FieldError>{error?.text}</FieldError>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" className={TOUCH} disabled={edit.isPending} onClick={onBack}>
          Back
        </Button>
        <Button type="submit" loading={edit.isPending} disabled={stale} className={TOUCH}>
          Save changes
        </Button>
      </div>
    </form>
  )
}

/** One step in a task's history, as read: a move (0015) reads "passed it on", a personal task's start "added it". */
function stepLabel(ev: OfficeTaskEvent, task: OfficeTask) {
  if (ev.kind === 'assigned' && isPersonal(task)) return 'added it'
  if (ev.kind === 'assigned' && ev.note) return 'passed it on'
  return EVENT_LABEL[ev.kind]
}

/* ----------------------------------------------------------- proof images (0013) */

/** The images handed in with a task: thumbnails, each opening full size in a new tab. */
function ProofImages({ images }: { images: TaskImage[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Images handed in">
      {images.map((img) => (
        <li key={img.id}>
          {img.url ? (
            <a
              href={img.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-[8px] hairline transition-opacity duration-150 hover:opacity-90"
              title={`${img.file_name} (opens full size)`}
            >
              <img src={img.url} alt={img.file_name} loading="lazy" className="size-24 object-cover" />
            </a>
          ) : (
            <span className="flex size-24 items-center justify-center rounded-[8px] hairline px-2 text-center text-[11px] text-text-muted">
              {img.file_name} could not be loaded
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** One chosen image's preview: its object URL is made and let go of with it. */
function Preview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url ? (
    <img src={url} alt={file.name} className="size-16 rounded-[8px] object-cover hairline" />
  ) : (
    <span className="block size-16 rounded-[8px] hairline" />
  )
}

/**
 * Choosing images to hand in: checked here against the bucket's limits so a
 * too-big or wrong file is said at once, not after an upload fails.
 */
function ProofPicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  // The same image picked twice: same name and same size.
  const same = (a: File, b: File) => a.name === b.name && a.size === b.size

  const add = (picked: FileList | null) => {
    if (!picked?.length) return
    const next = [...files]
    const issues: string[] = []
    let added = 0
    for (const f of Array.from(picked)) {
      if (!proofType(f)) issues.push(`${f.name} is not an image (PNG, JPEG, WebP or GIF).`)
      else if (f.size > PROOF_MAX_BYTES) issues.push(`${f.name} is over 10 MB.`)
      else if (next.some((x) => same(x, f))) issues.push(`${f.name} is already added.`)
      else if (next.length >= PROOF_MAX_FILES) issues.push(`Up to ${PROOF_MAX_FILES} images: ${f.name} was left out.`)
      else {
        next.push(f)
        added++
      }
    }
    setProblem(issues.length ? issues.join(' ') : null)
    setSaid(added ? `${added} ${added === 1 ? 'image' : 'images'} added, ${next.length} in all.` : '')
    onChange(next)
    if (inputRef.current) inputRef.current.value = ''
  }

  const remove = (k: number) => {
    setProblem(null)
    setSaid(`${files[k].name} removed.`)
    onChange(files.filter((_, j) => j !== k))
    // The button it was on has gone: keep the keyboard in the picker.
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-remove]')
      ;(buttons?.[Math.min(k, (buttons?.length ?? 1) - 1)] ?? inputRef.current)?.focus()
    })
  }

  return (
    <div>
      <p id={`${id}-label`} className="mb-1.5 block text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">
        Images (optional)
      </p>
      <div ref={listRef} className="flex flex-wrap items-center gap-2">
        {files.map((f, k) => (
          <span key={`${f.name}-${f.size}-${f.lastModified}`} className="relative">
            <Preview file={f} />
            <button
              type="button"
              data-remove=""
              onClick={() => remove(k)}
              aria-label={`Remove image ${k + 1}, ${f.name}`}
              className="press absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-surface-raised text-text-primary shadow-[var(--shadow-sm)] hairline max-sm:size-10"
            >
              <X size={13} strokeWidth={2} aria-hidden />
            </button>
          </span>
        ))}
        {files.length < PROOF_MAX_FILES ? (
          <label className="press flex h-16 cursor-pointer items-center gap-2 rounded-[8px] border border-dashed border-line px-3 text-[13px] text-text-secondary transition-colors duration-150 hover:bg-[var(--hover)] has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand">
            <ImagePlus size={16} strokeWidth={1.75} aria-hidden />
            <span id={`${id}-add`}>Add images</span>
            <input
              ref={inputRef}
              id={`${id}-files`}
              type="file"
              accept={[...PROOF_TYPES_ACCEPT].join(',')}
              multiple
              onChange={(e) => add(e.target.files)}
              aria-labelledby={`${id}-label ${id}-add`}
              aria-describedby={`${id}-files-hint${problem ? ` ${id}-files-error` : ''}`}
              className="sr-only"
            />
          </label>
        ) : null}
      </div>
      <p id={`${id}-files-hint`} className="mt-1 text-[12px] text-text-muted">
        Up to {PROOF_MAX_FILES} images, 10 MB each. Only the people on this task, and the admins, can see them.
      </p>
      <p role="status" className="sr-only">
        {said}
      </p>
      <div id={`${id}-files-error`}>
        <FieldError>{problem}</FieldError>
      </div>
    </div>
  )
}

/** What the file chooser offers: the accepted types, and their extensions for browsers that need them. */
const PROOF_TYPES_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', '.png', '.jpg', '.jpeg', '.webp', '.gif']

/* ------------------------------------------------------------ one task open */

type Draft = { kind: 'done' | 'return' | 'cancel'; note: string; links: string[]; files: File[] } | null

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
  // Proof images (0013): shown to everyone who can see the task; the picker only once 0013 is in.
  const { data: filesData } = useTaskFiles(task.id)
  const images = filesData?.rows ?? []
  // Several links once 0016 is in; one box before.
  const multiLinks = useHasColumn('office_tasks', 'done_links')
  const handedLinks = linksOf(task.done_links, task.done_link)
  const start = useStartTask()
  const complete = useCompleteTask()
  const review = useReviewTask()
  const cancel = useCancelTask()
  const showToast = useToastStore((s) => s.showToast)
  const [draft, setDraft] = useState<Draft>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Said inside the dialog: the toast lives outside it, where a screen reader
  // is told not to look while the dialog is open.
  const [announce, setAnnounce] = useState('')
  // Where focus goes when the control it was on disappears (an action done, a
  // form closed): the task's status, so the keyboard keeps its place.
  const statusRef = useRef<HTMLDivElement>(null)
  const refocus = () => requestAnimationFrame(() => statusRef.current?.focus())
  const editRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  const assignee = task.assigned_to === userId
  const personal = isPersonal(task)
  // When the dialog opened: canRate's 7-day window is judged against it, so a render stays pure.
  const [openedAt] = useState(() => Date.now())
  const busy = start.isPending || complete.isPending || review.isPending || cancel.isPending
  const who = (pid: string | null) => (!pid ? 'Someone' : pid === userId ? 'You' : nameOf(pid))
  const fail = (err: Error) => {
    setError(err.message)
    refocus()
  }
  const openDraft = (kind: NonNullable<Draft>['kind']) => {
    setError(null)
    setDraft({ kind, note: '', links: [''], files: [] })
  }
  const done = (message: string) => {
    setDraft(null)
    setEditing(false)
    setError(null)
    // Cleared first: the same words twice (two saves) must still be said.
    setAnnounce('')
    requestAnimationFrame(() => setAnnounce(message))
    showToast(message, 'success')
    refocus()
  }

  const actions: ReactNode[] = []
  if (canEdit(task, userId, admin) && !draft && !editing) {
    actions.push(
      <Button
        key="edit"
        ref={editRef}
        variant="secondary"
        icon={<Pencil size={14} strokeWidth={1.75} aria-hidden />}
        disabled={busy}
        className={TOUCH}
        onClick={() => {
          setError(null)
          setEditing(true)
        }}
      >
        Edit
      </Button>,
    )
  }
  if (assignee && task.status === 'open' && !draft && !editing) {
    actions.push(
      <Button key="start" variant="secondary" loading={start.isPending} disabled={busy} className={TOUCH} onClick={() => start.mutate(task.id, { onSuccess: () => done('Started'), onError: fail })}>
        Start
      </Button>,
    )
  }
  if (assignee && (task.status === 'open' || task.status === 'in_progress') && !draft && !editing) {
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
        { id: task.id, note: draft.note.trim(), links: draft.links, multi: multiLinks, files: draft.files, personal },
        { onSuccess: () => done(personal ? 'Done' : `Done. ${who(task.assigned_by)} will check it.`), onError: fail },
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
      // Not while images are uploading: closing would lose the result, and the
      // task could be handed in twice.
      onOpenChange={(o) => !o && !complete.isPending && onClose()}
      onCloseAutoFocus={onCloseAutoFocus}
      title={task.title}
      description={
        personal
          ? assignee
            ? 'Your personal task. Only you and the admins see it.'
            : `${who(task.assigned_to)}'s personal task`
          : `${who(task.assigned_by)} gave this to ${who(task.assigned_to).replace(/^You$/, 'you')}`
      }
    >
      <div className="space-y-4">
        <p role="status" className="sr-only">
          {announce}
        </p>
        <div ref={statusRef} tabIndex={-1} role="group" aria-label={`Status: ${statusLabel(task)}`} className="flex flex-wrap items-center gap-2 rounded-[8px]">
          <StatusChip task={task} />
          <DueChip task={task} today={today} />
        </div>

        {task.details ? <p className="text-sm whitespace-pre-wrap text-text-primary">{task.details}</p> : null}

        {(task.status === 'done' || task.status === 'approved') && (task.done_note || handedLinks.length > 0 || images.length > 0) ? (
          <div className="rounded-[12px] bg-surface-sunken p-3 text-sm">
            <p className="text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">Handed in</p>
            {task.done_note ? <p className="mt-1 whitespace-pre-wrap text-text-primary">{task.done_note}</p> : null}
            {/* The database allows only http(s) links; checked again where each becomes an href. */}
            <LinkList links={handedLinks} />
            {images.length ? <ProofImages images={images} /> : null}
          </div>
        ) : null}

        {task.status === 'approved' ? (
          <RatingBlock key={task.rated_at ?? 'unrated'} task={task} editable={canRate(task, userId, admin, openedAt)} who={who} onSaved={done} />
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
                  <span className="font-medium text-text-primary">{who(ev.actor)}</span> {stepLabel(ev, task)}
                  <span className="text-text-muted" title={absoluteTime(ev.created_at)}>
                    {' '}
                    · {relativeTime(ev.created_at)}
                  </span>
                  {/* An edit or a move (0015) says what changed: the system's words, not a quote. */}
                  {ev.note ? (
                    ev.kind === 'edited' || ev.kind === 'assigned' ? (
                      <span className="mt-0.5 block whitespace-pre-wrap text-text-secondary">{ev.note}</span>
                    ) : (
                      <span className="mt-0.5 block whitespace-pre-wrap text-text-primary">“{ev.note}”</span>
                    )
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>

        {editing ? (
          <EditTask
            task={task}
            today={today}
            onSaved={done}
            onBack={() => {
              setEditing(false)
              setError(null)
              // Back to the button that opened the form.
              requestAnimationFrame(() => editRef.current?.focus())
            }}
          />
        ) : draft ? (
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
                <LinksField
                  id={id}
                  links={draft.links}
                  onChange={(links) => setDraft({ ...draft, links })}
                  multi={multiLinks}
                  errorId={error && linksProblem(draft.links) ? `${id}-task-err` : undefined}
                />
                {/* Hidden only when 0013 is not applied; a failed read still offers it. */}
                {filesData?.available !== false ? (
                  <ProofPicker files={draft.files} onChange={(files) => setDraft({ ...draft, files })} />
                ) : null}
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
            <div id={`${id}-task-err`}>
              <FieldError>{error}</FieldError>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                className={TOUCH}
                disabled={busy}
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
  const width = tabWidth(tabs.length)
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
        style={{ width, transform: `translateX(${i * width}px)` }}
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
          style={{ width }}
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
  // For the Personal tab's "last 7 days": a clock, so a tab left open does not go stale.
  const loadedAt = useNow(10 * 60_000).getTime()
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
    { id: 'personal', label: 'Personal' },
    { id: 'given', label: 'I gave' },
    ...(admin ? [{ id: 'all' as const, label: 'Everyone' }] : []),
  ]
  const current = tabs.some((t) => t.id === tab) ? tab : 'mine'
  // Personal tasks (0015) have their own tab: For me and I gave hold tasks between two people.
  const inTab = data.rows.filter((t) =>
    current === 'mine' ? t.assigned_to === userId && !isPersonal(t)
    : current === 'personal' ? t.assigned_to === userId && isPersonal(t)
    : current === 'given' ? t.assigned_by === userId && !isPersonal(t)
    : true,
  )
  const progress =
    current === 'personal'
      ? {
          todo: inTab.filter((t) => t.status === 'open').length,
          doing: inTab.filter((t) => t.status === 'in_progress').length,
          done: inTab.filter((t) => t.status === 'approved' && !!t.closed_at && Date.parse(t.closed_at) > loadedAt - 7 * 86_400_000).length,
        }
      : null
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
      : current === 'personal'
        ? { title: 'No personal tasks', body: 'Add a task for yourself to keep your own work on the list and see it through.' }
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
          {current === 'personal' ? 'Add a task' : 'Give a task'}
        </Button>
      </div>

      <div id="tasks-panel" role="tabpanel" tabIndex={0} aria-labelledby={`tasks-tab-${current}`} className="mx-auto max-w-[820px] p-4 sm:p-6">
        {progress && (progress.todo || progress.doing || progress.done) ? (
          <p className="mb-4 text-[13px] text-text-secondary">
            <span className="font-semibold text-text-primary">{progress.todo}</span> to do ·{' '}
            <span className="font-semibold text-text-primary">{progress.doing}</span> in progress ·{' '}
            <span className="font-semibold text-text-primary">{progress.done}</span> done in the last 7 days
          </p>
        ) : null}
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
              {showClosed ? 'Hide' : 'Show'} {current === 'personal' ? 'done' : 'approved'} and cancelled ({closed.length})
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

      <NewTask open={creating} onOpenChange={setCreating} today={today} forMe={current === 'personal'} />
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
