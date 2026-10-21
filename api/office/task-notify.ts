import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Resend } from 'resend'
import { isRefusal, officeEnv, parseBody, serviceClient, verifiedUserId } from '../_lib/server.js'
import { officeTask, type TaskEmailKind } from '../_lib/templates.js'

/**
 * A task step by email (0011): a new task to the assignee, "done, please
 * check" to the giver, "sent back" to the assignee, and (0012) the stars a
 * task was given, to the assignee. Called by the actor's
 * browser right after the step.
 *
 * The body names one event and nothing else. The update below is the whole
 * authorisation: it only matches an event of an emailing kind, made by the
 * caller in the last hour, never emailed; setting emailed_at in the same
 * statement makes it once-only under any concurrency. Who receives it, and
 * what it says, come from the task's own row, never from the request.
 *
 * The link comes from OFFICE_BASE_URL, never from the Host header.
 */

const EMAILING: TaskEmailKind[] = ['assigned', 'done', 'returned', 'rated']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const env = officeEnv()
  if (isRefusal(env)) {
    console.error('task-notify:', env.error)
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const { url, serviceKey, resendKey, from: FROM, base } = env
  const db = serviceClient(url, serviceKey)

  const userId = await verifiedUserId(req, db)
  if (isRefusal(userId)) return res.status(userId.status).json({ error: userId.error })

  const { data: caller } = await db.from('profiles').select('full_name, deactivated_at').eq('id', userId).maybeSingle()
  if (!caller || caller.deactivated_at) return res.status(403).json({ error: 'You are not on the team.' })

  const body = parseBody<{ eventId?: unknown }>(req)
  if (isRefusal(body)) return res.status(body.status).json({ error: body.error })
  const eventId = typeof body.eventId === 'string' ? body.eventId : ''
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return res.status(400).json({ error: 'Which task step?' })

  const now = new Date()
  const { data: claimed, error } = await db
    .from('office_task_events')
    .update({ emailed_at: now.toISOString() })
    .eq('id', eventId)
    .eq('actor', userId)
    .in('kind', EMAILING)
    .is('emailed_at', null)
    .gt('created_at', new Date(now.getTime() - 3_600_000).toISOString())
    .select('task_id, kind, note, created_at')
  if (error) {
    console.error('task-notify claim:', error.message)
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const event = (claimed as { task_id: string; kind: TaskEmailKind; note: string | null; created_at: string }[] | null)?.[0]
  if (!event) return res.status(409).json({ error: 'That step was already emailed, or is not yours.' })
  const release = () => db.from('office_task_events').update({ emailed_at: null }).eq('id', eventId)

  const { data: task, error: taskErr } = await db
    .from('office_tasks')
    .select('title, due_on, status, assigned_by, assigned_to')
    .eq('id', event.task_id)
    .maybeSingle()
  if (taskErr || !task) {
    if (taskErr) console.error('task-notify task:', taskErr.message)
    await release()
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const t = task as { title: string; due_on: string | null; status: string; assigned_by: string; assigned_to: string }
  // Cancelled since, or a "please check" already checked: nothing to tell anyone. The latch stays set.
  if (t.status === 'cancelled' || (event.kind === 'done' && t.status !== 'done')) return res.status(200).json({ sent: false })

  // At most 10 task emails an hour from one person, whatever the steps: a
  // done / send-back loop must not turn the office's address into a megaphone.
  const { count, error: countErr } = await db
    .from('office_task_events')
    .select('id', { count: 'exact', head: true })
    .eq('actor', userId)
    .neq('id', eventId)
    .gt('emailed_at', new Date(now.getTime() - 3_600_000).toISOString())
  // Fails closed: if the cap cannot be checked, nothing is sent.
  if (countErr) {
    console.error('task-notify throttle:', countErr.message)
    await release()
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  if ((count ?? 0) >= 10) {
    await release()
    return res.status(200).json({ sent: false })
  }

  const recipientId = event.kind === 'done' ? t.assigned_by : t.assigned_to
  const { data: to, error: toErr } = await db
    .from('profiles')
    .select('full_name, email, deactivated_at')
    .eq('id', recipientId)
    .maybeSingle()
  if (toErr) {
    console.error('task-notify recipient:', toErr.message)
    await release()
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const recipient = to as { full_name: string; email: string | null; deactivated_at: string | null } | null
  // Nothing sent, so emailed_at must not say otherwise.
  if (!recipient?.email || recipient.deactivated_at || recipientId === userId) {
    await release()
    return res.status(200).json({ sent: false })
  }

  // Only a 'rated' step needs the stars, and only 0012 has them: read them
  // separately, so the other steps keep working on a database without 0012.
  let stars: number | null = null
  let comment: string | null = event.note
  if (event.kind === 'rated') {
    // One rating email per task a day: changing the stars again is not news
    // worth another email. The latch stays set; nothing is sent.
    const { count: recent, error: recentErr } = await db
      .from('office_task_events')
      .select('id', { count: 'exact', head: true })
      .eq('task_id', event.task_id)
      .eq('kind', 'rated')
      .neq('id', eventId)
      .gt('emailed_at', new Date(now.getTime() - 86_400_000).toISOString())
    if (recentErr) {
      console.error('task-notify rating throttle:', recentErr.message)
      await release()
      return res.status(500).json({ error: 'Could not send the email.' })
    }
    if (recent) return res.status(200).json({ sent: false })
    const { data: rated, error: ratedErr } = await db.from('office_tasks').select('rating, rating_note').eq('id', event.task_id).maybeSingle()
    const r = rated as { rating: number | null; rating_note: string | null } | null
    if (ratedErr || !r?.rating) {
      if (ratedErr) console.error('task-notify rating:', ratedErr.message)
      await release()
      return res.status(500).json({ error: 'Could not send the email.' })
    }
    stars = r.rating
    comment = r.rating_note
  }

  // 'done' (0013): how many images came with it. Best effort: before 0013,
  // or on any error, the email simply does not mention them.
  let images = 0
  if (event.kind === 'done') {
    // This hand-in's images only: complete_task records them in the same
    // transaction as the 'done' event, so they share its time.
    const { count: n } = await db
      .from('office_task_files')
      .select('id', { count: 'exact', head: true })
      .eq('task_id', event.task_id)
      .gte('created_at', event.created_at)
    images = n ?? 0
  }

  const email = officeTask({
    kind: event.kind,
    recipientName: recipient.full_name,
    actorName: (caller as { full_name?: string }).full_name ?? 'Someone',
    title: t.title,
    dueOn: event.kind === 'assigned' ? t.due_on : null,
    note: comment,
    stars,
    images,
    tasksUrl: `${base}/tasks`,
  })
  const sendErr = await new Resend(resendKey).emails
    .send(
      { from: FROM, to: recipient.email, subject: email.subject, html: email.html, text: email.text },
      { idempotencyKey: `office-task/${eventId}` },
    )
    .then(
      (r) => r.error,
      (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
    )
  if (sendErr) {
    console.error('task-notify email:', sendErr.message)
    await release()
    return res.status(502).json({ error: 'Could not send the email.' })
  }
  return res.status(200).json({ sent: true })
}
