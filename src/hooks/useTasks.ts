import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useOfficeRole } from '@/hooks/useOffice'
import { leaderboardKeys } from '@/hooks/useLeaderboard'
import type { OfficeTask, OfficeTaskEvent, OfficeTaskFile } from '@/types/database'

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
  files: (taskId: string) => ['tasks', 'files', taskId] as const,
}

/* ------------------------------------------------- proof images (0013) */

/** What the proof picker accepts: the bucket's own limits (0013), checked before uploading. */
export const PROOF_MAX_FILES = 5
export const PROOF_MAX_BYTES = 10 * 1024 * 1024
export const PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const TYPE_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

function extension(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase() ?? ''
  return /^[a-z0-9]{1,5}$/.test(fromName) ? fromName : 'img'
}

/**
 * The image type to upload with: what the browser says, or, when it says
 * nothing (some browsers leave it empty), what the extension says. Null when
 * the file is not one of the accepted images.
 */
export function proofType(file: File): string | null {
  if (PROOF_TYPES.includes(file.type)) return file.type
  if (file.type) return null
  return TYPE_BY_EXTENSION[extension(file)] ?? null
}

export interface TaskImage extends OfficeTaskFile {
  /** A signed URL, good for ten minutes; null if it could not be made. */
  url: string | null
}

/**
 * A task's proof images, with short-lived signed URLs (the bucket is
 * private). "Not available" before 0013, so the picker stays hidden.
 */
export function useTaskFiles(taskId: string | null) {
  return useQuery({
    queryKey: taskKeys.files(taskId ?? ''),
    enabled: !!taskId,
    queryFn: async (): Promise<{ available: boolean; rows: TaskImage[] }> => {
      const { data, error } = await supabase
        .from('office_task_files')
        .select('*')
        .eq('task_id', taskId!)
        .order('created_at')
        .limit(50)
      if (error?.code && MISSING.has(error.code)) return { available: false, rows: [] }
      if (error) throw error
      const rows = (data ?? []) as OfficeTaskFile[]
      if (!rows.length) return { available: true, rows: [] }
      const { data: signed, error: signError } = await supabase.storage
        .from('task-proof')
        .createSignedUrls(rows.map((r) => r.storage_path), 600)
      // Thrown, not cached as "could not be loaded" for minutes.
      if (signError) throw signError
      const urls = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
      return { available: true, rows: rows.map((r) => ({ ...r, url: urls.get(r.storage_path) ?? null })) }
    },
    // Signed URLs last ten minutes: signed again every four while the task
    // stays open, so a thumbnail never points at an expired link.
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    refetchIntervalInBackground: false,
  })
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
        // Marked stale, not refetched: the board is read again when next shown.
        void queryClient.invalidateQueries({ queryKey: leaderboardKeys.all, refetchType: 'none' })
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
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: taskKeys.all }),
        // Approving and rating move points (0012).
        queryClient.invalidateQueries({ queryKey: leaderboardKeys.all }),
      ]),
  })
}

/** A task for someone else is emailed to them; one for yourself (0015) is not. */
export const useCreateTask = () => {
  const userId = useAuthStore((s) => s.profile?.id)
  return useTaskRpc(
    (i: { to: string; title: string; details: string; dueOn: string }) =>
      supabase.rpc('create_task', { p_to: i.to, p_title: i.title, p_details: i.details || null, p_due: i.dueOn || null }),
    (i) => i.to !== userId,
  )
}

/**
 * Fix a task (0015): the whole new title, details and due date, and who it is
 * for when that changes. The assignee is emailed (the route holds it to one
 * edit email per task every 30 minutes); a personal task emails nobody.
 */
export const useEditTask = () =>
  useTaskRpc(
    (i: { id: string; title: string; details: string; dueOn: string; to: string | null; personal: boolean }) =>
      supabase.rpc('edit_task', {
        p_id: i.id,
        p_title: i.title,
        p_details: i.details || null,
        p_due: i.dueOn || null,
        p_to: i.to,
      }),
    (i) => !i.personal,
  )

export const useStartTask = () => useTaskRpc((id: string) => supabase.rpc('start_task', { p_id: id }), () => false)

/**
 * Mark done, with any proof images (0013): each is uploaded into the task's
 * folder first, one at a time, then complete_task checks and records them.
 * With no images the call is the one from before 0013, so it works on either.
 */
export const useCompleteTask = () => {
  const userId = useAuthStore((s) => s.profile?.id)
  // Images already uploaded in this dialog: a retry (a refused link, a failed
  // hand-in) reuses them instead of uploading the same image again.
  const uploadedRef = useRef(new WeakMap<File, string>())
  return useTaskRpc(
    async (i: { id: string; note: string; link: string; files: File[]; personal: boolean }) => {
      if (!i.files.length) {
        return supabase.rpc('complete_task', { p_id: i.id, p_note: i.note || null, p_link: i.link || null })
      }
      if (!userId) return { data: null, error: { message: 'Sign in again and retry.' } }
      // Checked before any upload: the server would refuse it after them.
      if (i.link && !/^https?:\/\/\S+$/i.test(i.link)) {
        return { data: null, error: { message: 'The link must start with http:// or https://.' } }
      }
      const uploaded: { path: string; name: string }[] = []
      for (const file of i.files) {
        let path = uploadedRef.current.get(file)
        if (!path) {
          const type = proofType(file)
          if (!type) return { data: null, error: { message: `${file.name} is not an image (PNG, JPEG, WebP or GIF).` } }
          const next = `${i.id}/${userId}/${crypto.randomUUID()}.${extension(file)}`
          const { error } = await supabase.storage.from('task-proof').upload(next, file, { contentType: type, upsert: false })
          if (error) return { data: null, error: { message: `${file.name} did not upload: ${error.message}` } }
          uploadedRef.current.set(file, next)
          path = next
        }
        uploaded.push({ path, name: file.name })
      }
      return supabase.rpc('complete_task', { p_id: i.id, p_note: i.note || null, p_link: i.link || null, p_files: uploaded })
    },
    // A personal task (0015) is closed by being done: nobody to tell.
    (i) => !i.personal,
  )
}

/** Approve (no email: the assignee sees it in the office), or send back (emailed). */
export const useReviewTask = () =>
  useTaskRpc(
    (i: { id: string; approve: boolean; note: string }) =>
      supabase.rpc('review_task', { p_id: i.id, p_approve: i.approve, p_note: i.note || null }),
    (i) => !i.approve,
  )

/** 1 to 5 stars on an approved task (0012), emailed to the assignee. */
export const useRateTask = () =>
  useTaskRpc(
    (i: { id: string; stars: number; note: string }) =>
      supabase.rpc('rate_task', { p_id: i.id, p_stars: i.stars, p_note: i.note || null }),
    () => true,
  )

export const useCancelTask = () =>
  useTaskRpc((i: { id: string; note: string }) => supabase.rpc('cancel_task', { p_id: i.id, p_note: i.note || null }), () => false)
