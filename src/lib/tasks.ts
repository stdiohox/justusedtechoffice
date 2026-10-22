import type { OfficeTask, TaskEventKind, TaskStatus } from '@/types/database'

/** Tasks (0011): what the screens call each state and step. */

/**
 * A task someone gave themselves (0015): no check, no stars, no points. Done
 * closes it (status 'approved'), and only its owner acts on it.
 */
export const isPersonal = (t: OfficeTask) => t.assigned_by === t.assigned_to

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'To do',
  in_progress: 'In progress',
  done: 'Waiting for check',
  approved: 'Approved',
  cancelled: 'Cancelled',
}

export const EVENT_LABEL: Record<TaskEventKind, string> = {
  assigned: 'gave the task',
  started: 'started it',
  done: 'marked it done',
  approved: 'approved it',
  returned: 'sent it back',
  cancelled: 'cancelled it',
  rated: 'rated it',
  edited: 'edited it',
}

/** The status as shown: a personal task that is closed by being done reads "Done". */
export const statusLabel = (t: OfficeTask) => (isPersonal(t) && t.status === 'approved' ? 'Done' : STATUS_LABEL[t.status])

export const isClosed = (t: OfficeTask) => t.status === 'approved' || t.status === 'cancelled'

/** Past its due date (office calendar) and not yet handed in. */
export const isOverdue = (t: OfficeTask, today: string) =>
  !!t.due_on && t.due_on < today && (t.status === 'open' || t.status === 'in_progress')

/**
 * Waiting on this person: a task they were given and have not started, or one
 * they gave that is done and waiting for their check. The badge counts these.
 */
export const needsMe = (t: OfficeTask, userId: string) =>
  !isPersonal(t) && ((t.assigned_to === userId && t.status === 'open') || (t.assigned_by === userId && t.status === 'done'))

/** Who may check (approve or send back) a done task: the giver or an admin, never the assignee. */
export const canReview = (t: OfficeTask, userId: string, admin: boolean) =>
  t.status === 'done' && t.assigned_to !== userId && (t.assigned_by === userId || admin)

/**
 * Who may act on a task as its giver (0015's edit_task and cancel_task): the
 * giver or an admin, never the assignee; a personal task, only its owner.
 */
const givesIt = (t: OfficeTask, userId: string, admin: boolean) =>
  isPersonal(t) ? t.assigned_to === userId : t.assigned_to !== userId && (t.assigned_by === userId || admin)

/** Who may cancel an open task. */
export const canCancel = (t: OfficeTask, userId: string, admin: boolean) => !isClosed(t) && givesIt(t, userId, admin)

/** Who may edit a task: as for cancelling, while it is To do or In progress (0015). */
export const canEdit = (t: OfficeTask, userId: string, admin: boolean) =>
  (t.status === 'open' || t.status === 'in_progress') && givesIt(t, userId, admin)

/** Ratings close this long after a task is approved (0012's rate_task). */
const RATING_DAYS = 7

/**
 * Who may rate (0012): an approved task, by the giver or an admin, never the
 * assignee, for 7 days after it was approved; never a personal one (0015). `now` is passed in so a render
 * stays pure.
 */
export const canRate = (t: OfficeTask, userId: string, admin: boolean, now: number) =>
  t.status === 'approved' &&
  !isPersonal(t) &&
  t.assigned_to !== userId &&
  (t.assigned_by === userId || admin) &&
  !!t.closed_at &&
  Date.parse(t.closed_at) > now - RATING_DAYS * 86_400_000

/** "Mon 3 Nov", for a 'YYYY-MM-DD' calendar date. */
export function dueLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

/**
 * The order a list reads in: what needs you first, then live tasks by due
 * date (undated last), then closed ones, newest first.
 */
export function sortTasks(rows: OfficeTask[], userId: string): OfficeTask[] {
  const rank = (t: OfficeTask) => (needsMe(t, userId) ? 0 : isClosed(t) ? 2 : 1)
  return [...rows].sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r) return r
    if (rank(a) === 1) {
      const da = a.due_on ?? '9999-12-31'
      const db = b.due_on ?? '9999-12-31'
      if (da !== db) return da < db ? -1 : 1
    }
    return b.updated_at.localeCompare(a.updated_at)
  })
}
