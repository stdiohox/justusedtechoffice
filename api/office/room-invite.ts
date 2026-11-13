import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Resend } from 'resend'
import { isRefusal, officeEnv, serviceClient, verifiedUserId } from '../_lib/server.js'
import { officeRoomInvite } from '../_lib/templates.js'

/**
 * "Come into the Boardroom", by email, for an invite the caller has just made (0021).
 * Like knock-ping: the body names one invite and nothing else. Who it is from comes
 * from the verified token, who it goes to from the invite's own row. The update
 * below is the whole authorisation: it only matches an invite the caller sent,
 * still waiting, not lapsed, never emailed, and setting emailed_at in the same
 * statement makes it once-only under any concurrency. At most one email per pair
 * in 30 minutes, whatever happens to the invites.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const env = officeEnv()
  if (isRefusal(env)) {
    console.error('room-invite:', env.error)
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const { url, serviceKey, resendKey, from: FROM, base } = env
  const db = serviceClient(url, serviceKey)

  const userId = await verifiedUserId(req, db)
  if (isRefusal(userId)) return res.status(userId.status).json({ error: userId.error })

  // Switched off (0001): the token may still be valid, the person is not.
  const { data: caller } = await db.from('profiles').select('deactivated_at').eq('id', userId).maybeSingle()
  if (!caller || caller.deactivated_at) return res.status(403).json({ error: 'You are not in the office.' })

  const inviteId = typeof req.body?.inviteId === 'string' ? req.body.inviteId : ''
  if (!/^[0-9a-f-]{36}$/i.test(inviteId)) return res.status(400).json({ error: 'Which invite?' })

  const nowIso = new Date().toISOString()
  const { data: claimed, error } = await db
    .from('office_room_invites')
    .update({ emailed_at: nowIso })
    .eq('id', inviteId)
    .eq('from_user', userId)
    .eq('status', 'pending')
    .gt('expires_at', nowIso)
    .is('emailed_at', null)
    .select('to_user, room_id')
  // Details go to the function log, never to the caller.
  if (error) {
    console.error('room-invite claim:', error.message)
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const invite = (claimed as { to_user: string; room_id: string }[] | null)?.[0]
  if (!invite) return res.status(200).json({ sent: false })
  const release = () => db.from('office_room_invites').update({ emailed_at: null }).eq('id', inviteId)

  // One email per pair in 30 minutes: an invite can be made, declined and made
  // again, and the office's address must not become a way to pester someone.
  const since = new Date(Date.now() - 30 * 60_000).toISOString()
  const { count, error: countErr } = await db
    .from('office_room_invites')
    .select('id', { count: 'exact', head: true })
    .eq('from_user', userId)
    .eq('to_user', invite.to_user)
    .neq('id', inviteId)
    .gt('emailed_at', since)
  // Fails closed: if the throttle cannot be checked, nothing is sent.
  if (countErr) {
    console.error('room-invite throttle:', countErr.message)
    await release()
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  // Throttled: the claim stands, so this invite is not retried. The invite itself holds.
  if (count) return res.status(200).json({ sent: false })

  const [{ data: to, error: toErr }, { data: from }, { data: room }] = await Promise.all([
    db.from('profiles').select('full_name, email, deactivated_at').eq('id', invite.to_user).maybeSingle(),
    db.from('profiles').select('full_name').eq('id', userId).maybeSingle(),
    db.from('office_rooms').select('name').eq('id', invite.room_id).maybeSingle(),
  ])
  if (toErr) {
    console.error('room-invite recipient:', toErr.message)
    await release()
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const recipient = to as { full_name: string; email: string | null; deactivated_at: string | null } | null
  if (!recipient?.email || recipient.deactivated_at) return res.status(200).json({ sent: false })

  const email = officeRoomInvite({
    recipientName: recipient.full_name,
    fromName: (from as { full_name?: string } | null)?.full_name ?? 'Someone',
    roomName: (room as { name?: string } | null)?.name ?? 'a room',
    roomsUrl: `${base}/rooms`,
  })
  // A thrown send is treated like a refused one, so the claim is released.
  const sendErr = await new Resend(resendKey).emails
    .send(
      { from: FROM, to: recipient.email, subject: email.subject, html: email.html, text: email.text },
      { idempotencyKey: `office-room-invite/${inviteId}` },
    )
    .then(
      (r) => r.error,
      (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
    )
  if (sendErr) {
    console.error('room-invite email:', sendErr.message)
    await release()
    return res.status(502).json({ error: 'Could not send the email.' })
  }
  return res.status(200).json({ sent: true })
}
