import { useEffect, useRef } from 'react'
import { useTeam } from '@/hooks/useTeam'
import { useTasks, useTasksRealtime } from '@/hooks/useTasks'
import { isPersonal } from '@/lib/tasks'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'

/** What an edit (0015) can change: title, details, due date. */
const textOf = (t: { title: string; details: string | null; due_on: string | null }) =>
  `${t.title}\u0000${t.details ?? ''}\u0000${t.due_on ?? ''}`

/**
 * Tasks, wherever you are in the office (0011). Mounted once in the shell,
 * like knocks. Says so when a task is given to you, when one you gave is done
 * and waits for your check, and when one of yours is sent back, approved or
 * cancelled, or edited (0015). Only the other person's steps reach you: your
 * own you just did. A personal task (0015) is all your own steps: never said.
 */
export function TaskLayer() {
  const userId = useAuthStore((s) => s.profile?.id)
  const { data } = useTasks()
  const { data: team } = useTeam()
  const showToast = useToastStore((s) => s.showToast)
  useTasksRealtime(!!data?.available)

  // The first load only records state, so opening the office does not replay
  // old news; after that, only a change since the last run says anything.
  // Status, stars (0012) and the edited text (0015) per task: neither changes the status.
  // And who has it (0015): an admin already sees every task, so a task moved to one is not new to the list.
  const known = useRef<Map<string, { status: string; rating: number | null; text: string; to: string }> | null>(null)
  useEffect(() => {
    // Names need the team: wait for it, so a toast never says "Someone" for good.
    if (!data?.available || !userId || !team) return
    const nameOf = (id: string) => team?.find((p) => p.id === id)?.full_name ?? 'Someone'
    const before = known.current
    known.current = new Map(data.rows.map((t) => [t.id, { status: t.status, rating: t.rating ?? null, text: textOf(t), to: t.assigned_to }]))
    if (!before) return
    // The toast holds one message: several changes at once become one line.
    const news: { message: string; type: 'info' | 'success' }[] = []
    const say = (message: string, type: 'info' | 'success' = 'info') => news.push({ message, type })
    for (const t of data.rows) {
      if (isPersonal(t)) continue
      const prev = before.get(t.id)
      const was = prev?.status
      const rating = t.rating ?? null
      if (prev && t.assigned_to === userId && rating !== null && rating !== prev.rating) {
        say(`${nameOf(t.rated_by ?? '')} rated ${t.title.length > 60 ? `“${t.title.slice(0, 59)}…”` : `“${t.title}”`} ${rating} of 5 stars`, 'success')
      }
      const title = `“${t.title.length > 60 ? `${t.title.slice(0, 59)}…` : t.title}”`
      if (prev && t.assigned_to === userId && prev.to !== userId) {
        say(`${nameOf(t.assigned_by)}'s task ${title} was passed to you`)
        continue
      }
      if (prev && t.assigned_to === userId && prev.text !== textOf(t)) say(`${title} was edited`)
      if (was === t.status) continue
      if (t.assigned_to === userId) {
        if (!was && t.status === 'open') say(`${nameOf(t.assigned_by)} gave you a task: ${title}`)
        else if (was === 'done' && t.status === 'in_progress') say(`${title} was sent back to you`)
        else if (was && t.status === 'approved') say(`${title} was approved`, 'success')
        else if (was && t.status === 'cancelled') say(`${title} was cancelled`)
      } else if (t.assigned_by === userId && t.status === 'done' && was) {
        say(`${nameOf(t.assigned_to)} finished ${title}. It is waiting for your check.`)
      }
    }
    if (news.length === 1) showToast(news[0].message, news[0].type)
    else if (news.length > 1) showToast(`${news.length} changes to your tasks. Open Tasks to see them.`, 'info')
  }, [data, userId, team, showToast])

  return null
}
