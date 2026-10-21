import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useOfficeRole } from '@/hooks/useOffice'
import type { OfficeTask, OfficeTaskEvent } from '@/types/database'

/**
 * Tasks the team gives each other (0011). Reads go straight to the tables,
 * which RLS narrows to tasks you gave or got, or every task for an admin.
 * Every change is an RPC. They degrade to "not available" while 0011 is not
 * applied, so this frontend can ship first: the Tasks screen stays hidden.
 */

/** PostgREST / Postgres codes for "that table or function does not exist". */
const MISSING = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])

export const taskKeys = {
  all: ['tasks'] as const,
  list: (userId: string) => ['tasks', 'list', userId] as const,
  events: (taskId: string) => ['tasks', 'events', taskId] as const,
}

/** Closed tasks drop off the lists after this long; open ones never do. */
const CLOSED_KEEP_DAYS = 60

export function useTasks() {
  const userId = useAuthStore((s) => s.profile?.id)
  return useQuery({
    queryKey: taskKeys.list(userId ?? ''),
    enabled: !!userId,
    queryFn: async (): Promise<{ available: boolean; rows: OfficeTask[] }> => {
      const since = new Date(Date.now() - CLOSED_KEEP_DAYS * 86_400_000).toISOString()
      const { data, error } = await supabase
        .from('office_tasks')
        .select('*')
        .or(`closed_at.is.null,closed_at.gte.${since}`)
        // Most recently changed first, so the cap never cuts a live task before an old closed one.
        .order('updated_at', { ascending: false })
        .limit(1000)
      if (error?.code && MISSING.has(error.code)) return { available: false, rows: [] }
      if (error) throw error
      return { available: true, rows: (data ?? []) as OfficeTask[] }
    },
    staleTime: 60_000,
  })
}

/** One subscription for the session, mounted with the task layer. */
export function useTasksRealtime(enabled: boolean) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    // A fresh name each time: supabase.channel() hands back a same-named
    // channel that is still being removed (StrictMode, a quick remount).
    const channel = supabase
      .channel(`office-tasks-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_tasks' }, () => {
        void queryClient.invalidateQueries({ queryKey: taskKeys.all })
      })
      // Anything that changed while the channel was joining, or the laptop
      // slept, arrives with no event: read again on every (re)join.
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void queryClient.invalidateQueries({ queryKey: taskKeys.all })
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, queryClient])
}

/** A task's history, oldest first. Fetched when the task is opened. */
export function useTaskEvents(taskId: string | null) {
  return useQuery({
    queryKey: taskKeys.events(taskId ?? ''),
    enabled: !!taskId,
    queryFn: async (): Promise<OfficeTaskEvent[]> => {
      const { data, error } = await supabase
        .from('office_task_events')
        .select('id, task_id, actor, kind, note, created_at')
        .eq('task_id', taskId!)
        .order('created_at')
        .limit(200)
      if (error) throw error
      return (data ?? []) as OfficeTaskEvent[]
    },
  })
}

/**
 * An admin sees and checks every task: the office manager, or anyone labelled
 * manager (0011's is_task_admin). Display only: the database decides.
 */
export function useIsTaskAdmin(): boolean {
  const role = useAuthStore((s) => s.profile?.role)
  const { isManager } = useOfficeRole()
  return isManager || role === 'manager'
}

/**
 * Ask the server to email the other person about this step. Best effort: the
 * step stands either way, and the route sends each step once at most.
 */
async function notify(eventId: unknown) {
  if (typeof eventId !== 'string') return
  try {
    const { data: session } = await supabase.auth.getSession()
    const token = session.session?.access_token
    if (!token) return
    // keepalive: the request outlives the tab if it is closed straight after.
    await fetch('/api/office/task-notify', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId }),
    })
  } catch {
    // Best effort, as above.
  }
}

function useTaskRpc<T>(
  call: (input: T) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  emails: (input: T) => boolean,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => {
      const { data, error } = await call(input)
      if (error) throw new Error(error.message)
      // Not awaited: the email must not hold up the screen.
      if (emails(input)) void notify(data)
      return data
    },
    // Returned, so the mutation stays pending until the fresh list is in: the
    // screen never offers an action on a task that has already moved on.
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  })
}

export const useCreateTask = () =>
  useTaskRpc(
    (i: { to: string; title: string; details: string; dueOn: string }) =>
      supabase.rpc('create_task', { p_to: i.to, p_title: i.title, p_details: i.details || null, p_due: i.dueOn || null }),
    () => true,
  )

export const useStartTask = () => useTaskRpc((id: string) => supabase.rpc('start_task', { p_id: id }), () => false)

export const useCompleteTask = () =>
  useTaskRpc(
    (i: { id: string; note: string; link: string }) =>
      supabase.rpc('complete_task', { p_id: i.id, p_note: i.note || null, p_link: i.link || null }),
    () => true,
  )

/** Approve (no email: the assignee sees it in the office), or send back (emailed). */
export const useReviewTask = () =>
  useTaskRpc(
    (i: { id: string; approve: boolean; note: string }) =>
      supabase.rpc('review_task', { p_id: i.id, p_approve: i.approve, p_note: i.note || null }),
    (i) => !i.approve,
  )

export const useCancelTask = () =>
  useTaskRpc((i: { id: string; note: string }) => supabase.rpc('cancel_task', { p_id: i.id, p_note: i.note || null }), () => false)
