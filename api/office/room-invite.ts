import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Resend } from 'resend'
import { isRefusal, officeEnv, serviceClient, verifiedUserId } from '../_lib/server.js'
import { officeRoomInvite } from '../_lib/templates.js'

/**
 * "Come into the Boardroom", by email, for an invite the caller has just made (0022).
 * The body names one invite and nothing else: who it is from comes from the verified
 * token, who it goes to from the invite's own row. The update below is the whole
 * authorisation: it only matches an invite the caller sent, still waiting, never emailed.
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

  const inviteId = typeof req.body?.inviteId === 'string' ? req.body.inviteId : ''
  if (!/^[0-9a-f-]{36}$/i.test(inviteId)) return res.status(400).json({ error: 'Which invite?' })

  const { data: claimed, error } = await db
    .from('office_room_invites')
    .update({ emailed_at: new Date().toISOString() })
    .eq('id', inviteId)
    .eq('from_user', userId)
    .eq('status', 'pending')
    .is('emailed_at', null)
    .select('to_user, room_id')
  if (error) {
    console.error('room-invite claim:', error.message)
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const invite = (claimed as { to_user: string; room_id: string }[] | null)?.[0]
  if (!invite) return res.status(200).json({ sent: false })

  const [{ data: to }, { data: from }, { data: room }] = await Promise.all([
    db.from('profiles').select('full_name, email, deactivated_at').eq('id', invite.to_user).maybeSingle(),
    db.from('profiles').select('full_name').eq('id', userId).maybeSingle(),
    db.from('office_rooms').select('name').eq('id', invite.room_id).maybeSingle(),
  ])
  const recipient = to as { full_name: string; email: string | null; deactivated_at: string | null } | null
  if (!recipient?.email || recipient.deactivated_at) return res.status(200).json({ sent: false })

  const email = officeRoomInvite({
    recipientName: recipient.full_name,
    fromName: (from as { full_name?: string } | null)?.full_name ?? 'Someone',
    roomName: (room as { name?: string } | null)?.name ?? 'a room',
    roomsUrl: `${base}/rooms`,
  })
  const { error: sendErr } = await new Resend(resendKey).emails.send({ from: FROM, to: recipient.email, subject: email.subject, html: email.html, text: email.text })
  if (sendErr) {
    console.error('room-invite email:', sendErr.message)
    await db.from('office_room_invites').update({ emailed_at: null }).eq('id', inviteId)
    return res.status(502).json({ error: 'Could not send the email.' })
  }
  return res.status(200).json({ sent: true })
}
