import type { OfficeTask, TaskEventKind, TaskStatus } from '@/types/database'

/** Tasks (0011): what the screens call each state and step. */

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
}

export const isClosed = (t: OfficeTask) => t.status === 'approved' || t.status === 'cancelled'

/** Past its due date (office calendar) and not yet handed in. */
export const isOverdue = (t: OfficeTask, today: string) =>
  !!t.due_on && t.due_on < today && (t.status === 'open' || t.status === 'in_progress')

/**
 * Waiting on this person: a task they were given and have not started, or one
 * they gave that is done and waiting for their check. The badge counts these.
 */
export const needsMe = (t: OfficeTask, userId: string) =>
  (t.assigned_to === userId && t.status === 'open') || (t.assigned_by === userId && t.status === 'done')

/** Who may check (approve or send back) a done task: the giver or an admin, never the assignee. */
export const canReview = (t: OfficeTask, userId: string, admin: boolean) =>
  t.status === 'done' && t.assigned_to !== userId && (t.assigned_by === userId || admin)

/** Who may cancel an open task: the giver or an admin, never the assignee. */
export const canCancel = (t: OfficeTask, userId: string, admin: boolean) =>
  !isClosed(t) && t.assigned_to !== userId && (t.assigned_by === userId || admin)

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
