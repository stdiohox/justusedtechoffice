import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Resend } from 'resend'
import { isRefusal, officeEnv, parseBody, serviceClient, setPasswordLink } from '../_lib/server.js'
import { officeRecovery } from '../_lib/templates.js'

/**
 * "Forgot your password?" from the sign-in page. Anyone may call it, so:
 *   - it answers the same ({ ok: true }) whether or not the email is on the
 *     team, and also when sending fails (logged), so it cannot be used to
 *     find out who is;
 *   - a link goes only to an active profile's email (0001);
 *   - at most one request per email per hour, claimed in office_alert_log
 *     (0002's once-only log, service role only) under recover:<email>:<hour>.
 * The link is made with the Auth admin API and sent through Resend, so the
 * office does not depend on Supabase's own email sender.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const env = officeEnv()
  if (isRefusal(env)) {
    console.error('recover:', env.error)
    return res.status(500).json({ error: 'The office is not set up to send email yet.' })
  }
  const body = parseBody<{ email?: unknown }>(req)
  if (isRefusal(body)) return res.status(body.status).json({ error: body.error })
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter the email you sign in with.' })

  const db = serviceClient(env.url, env.serviceKey)
  try {
    const hour = new Date().toISOString().slice(0, 13)
    const { error: claimErr } = await db.from('office_alert_log').insert({ key: `recover:${email}:${hour}` })
    if (claimErr?.code === '23505') return res.status(429).json({ error: 'A link went out a moment ago.' })
    if (claimErr) throw new Error(`claim: ${claimErr.message}`)

    const { data: person } = await db
      .from('profiles')
      .select('full_name, deactivated_at')
      .eq('email', email)
      .maybeSingle()
    if (!person || person.deactivated_at) return res.status(200).json({ ok: true })

    const { data, error } = await db.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: `${env.base}/set-password` },
    })
    const link = setPasswordLink(env.base, data?.properties)
    if (error || !link) throw new Error(`generateLink recovery: ${error?.message ?? 'no link'}`)

    const mail = officeRecovery({ name: person.full_name, link })
    const { error: sendErr } = await new Resend(env.resendKey).emails.send({
      from: env.from,
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
    if (sendErr) throw new Error(`recovery email: ${sendErr.message}`)
    return res.status(200).json({ ok: true })
  } catch (err) {
    // Logged for us; the caller gets the same answer as for an unknown email,
    // so a failure cannot reveal that the address is on the team.
    console.error('recover:', err)
    return res.status(200).json({ ok: true })
  }
}
