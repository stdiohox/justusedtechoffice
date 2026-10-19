import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Resend } from 'resend'
import { isRefusal, officeEnv, serviceClient, verifiedUserId } from '../_lib/server.js'
import { officeKnock } from '../_lib/templates.js'

/**
 * "Someone is knocking", by email to their login address, for a person who
 * is not on the site when the knock lands (0005). Called by the knocker's
 * browser, which is the only side that can see the other person is offline.
 *
 * The body names one knock and nothing else. Who is knocking comes from the
 * verified token; who is pinged, and what the message says, come from the
 * knock's own row and the recipient's profile. The update below is the
 * whole authorisation: it only
 * matches a knock the caller sent, still pending, never emailed, and setting
 * pinged_at in the same statement makes it once-only under any concurrency.
 *
 * The link comes from OFFICE_BASE_URL, never from the request's Host header,
 * which the caller controls: otherwise the office's own address could be made
 * to send a colleague a link to anywhere.
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const env = officeEnv()
  if (isRefusal(env)) {
    // The detail is for the function log; any signed-in browser can call this.
    console.error('knock-ping:', env.error)
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const { url, serviceKey, resendKey, from: FROM, base } = env
  const db = serviceClient(url, serviceKey)

  const userId = await verifiedUserId(req, db)
  if (isRefusal(userId)) return res.status(userId.status).json({ error: userId.error })

  // Switched off (0001): the token may still be valid, the person is not.
  const { data: caller } = await db.from('profiles').select('deactivated_at').eq('id', userId).maybeSingle()
  if (!caller || caller.deactivated_at) return res.status(403).json({ error: 'You are not in the office.' })

  const knockId = typeof req.body?.knockId === 'string' ? req.body.knockId : ''
  if (!/^[0-9a-f-]{36}$/i.test(knockId)) return res.status(400).json({ error: 'Which knock?' })

  const { data: claimed, error } = await db
    .from('office_knocks')
    .update({ pinged_at: new Date().toISOString() })
    .eq('id', knockId)
    .eq('from_user', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .is('pinged_at', null)
    .select('to_user')
  // Details go to the function log, never to the caller: database text and
  // the mail provider's errors (which can describe a colleague's address) are
  // not the knocker's business.
  if (error) {
    console.error('knock-ping lookup:', error.message)
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const toUser = (claimed as { to_user: string }[] | null)?.[0]?.to_user
  if (!toUser) return res.status(409).json({ error: 'That knock is not waiting, or was already sent.' })
  const release = () => db.from('office_knocks').update({ pinged_at: null }).eq('id', knockId)

  // At most one ping per pair in 30 minutes, whatever happens to the knocks.
  const since = new Date(Date.now() - 30 * 60_000).toISOString()
  const { count, error: countErr } = await db
    .from('office_knocks')
    .select('id', { count: 'exact', head: true })
    .eq('from_user', userId)
    .eq('to_user', toUser)
    .neq('id', knockId)
    .gt('pinged_at', since)
  // Fails closed: if the throttle cannot be checked, nothing is sent.
  if (countErr) {
    console.error('knock-ping throttle:', countErr.message)
    await release()
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  if (count) {
    await release()
    return res.status(200).json({ sent: false })
  }

  const [{ data: to, error: toErr }, { data: from }] = await Promise.all([
    db.from('profiles').select('full_name, email, deactivated_at').eq('id', toUser).maybeSingle(),
    db.from('profiles').select('full_name').eq('id', userId).maybeSingle(),
  ])
  if (toErr) {
    console.error('knock-ping recipient:', toErr.message)
    await release()
    return res.status(500).json({ error: 'Could not send the email.' })
  }
  const recipient = to as { full_name: string; email: string | null; deactivated_at: string | null } | null
  // Nothing sent, so pinged_at must not say otherwise.
  if (!recipient?.email || recipient.deactivated_at) {
    await release()
    return res.status(200).json({ sent: false })
  }

  const email = officeKnock({
    recipientName: recipient.full_name,
    fromName: (from as { full_name?: string } | null)?.full_name ?? 'Someone',
    officeUrl: `${base}/office`,
  })
  // A thrown send is treated like a refused one, so the latch is released.
  const sendErr = await new Resend(resendKey).emails
    .send(
      { from: FROM, to: recipient.email, subject: email.subject, html: email.html, text: email.text },
      { idempotencyKey: `office-knock/${knockId}` },
    )
    .then(
      (r) => r.error,
      (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
    )
  if (sendErr) {
    console.error('knock-ping email:', sendErr.message)
    // Let the knocker try again if the send failed for a passing reason.
    await release()
    return res.status(502).json({ error: 'Could not send the email.' })
  }
  return res.status(200).json({ sent: true })
}
