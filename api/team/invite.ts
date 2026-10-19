import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Resend } from 'resend'
import { randomBytes } from 'node:crypto'
import { isRefusal, officeEnv, parseBody, serverErrorBody, serviceClient, setPasswordLink, verifiedUserId } from '../_lib/server.js'
import { officeInvite } from '../_lib/templates.js'

/**
 * Mr Tito invites someone (Settings > Invite someone). Office manager only:
 * the caller must be office_settings.manager_id and an active profile.
 *
 *   1. The invite is recorded in public.invites (0001), name and email.
 *   2. A one-time token is made with the Auth admin API (service role) and
 *      emailed through Resend from OFFICE_FROM_EMAIL, as a link to our own
 *      /set-password. Pressing Continue there exchanges it (verifyOtp), which
 *      confirms the email, which makes the profile from the invite (0001's
 *      trigger), who then joins the office (0002); then they choose a password.
 *
 * "Send again" calls this with the same email: a login that exists but was
 * never confirmed gets a fresh sign-in link instead (Auth refuses a second
 * invite for it), and its password is first replaced with a random one, so a
 * login someone else created for that address cannot be taken over. A login that is already confirmed but has no profile (made
 * by hand before the invite) is given the profile here, and a link to set a
 * password. Someone already on the team is refused.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const env = officeEnv()
  if (isRefusal(env)) {
    console.error('invite:', env.error)
    return res.status(500).json({ error: 'The office is not set up to send email yet.' })
  }
  const db = serviceClient(env.url, env.serviceKey)

  const userId = await verifiedUserId(req, db)
  if (isRefusal(userId)) return res.status(userId.status).json({ error: userId.error })

  const body = parseBody<{ email?: unknown; fullName?: unknown }>(req)
  if (isRefusal(body)) return res.status(body.status).json({ error: body.error })
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const fullName = typeof body.fullName === 'string' ? body.fullName.replace(/\s+/g, ' ').trim() : ''
  if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: 'Give an email address they read.' })
  if (!fullName || fullName.length > 120) return res.status(400).json({ error: 'Give their name (up to 120 characters).' })

  try {
    // The office manager, and only while active.
    const [{ data: settings }, { data: me }] = await Promise.all([
      db.from('office_settings').select('manager_id').eq('id', 1).maybeSingle(),
      db.from('profiles').select('full_name, deactivated_at').eq('id', userId).maybeSingle(),
    ])
    if (!settings?.manager_id || settings.manager_id !== userId || !me || me.deactivated_at) {
      return res.status(403).json({ error: 'Only the office manager can invite people.' })
    }

    const { data: existing } = await db.from('profiles').select('id').eq('email', email).maybeSingle()
    if (existing) return res.status(409).json({ error: 'That email is already on the team.' })

    const { error: invErr } = await db
      .from('invites')
      .upsert({ email, full_name: fullName, role: 'member', invited_by: userId }, { onConflict: 'email' })
    if (invErr) throw new Error(`invite row: ${invErr.message}`)

    const redirectTo = `${env.base}/set-password`
    let link: string | null = null
    const first = await db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } })
    if (!first.error) {
      link = setPasswordLink(env.base, first.data.properties)
    } else {
      // The login exists already: find out whether it was ever confirmed.
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const user = list?.users.find((u) => u.email?.toLowerCase() === email)
      if (!user) throw new Error(`generateLink invite: ${first.error.message}`)
      if (user.email_confirmed_at) {
        // Confirmed but with no profile (made by hand): make it now from the invite.
        const { error: pErr } = await db.from('profiles').insert({ id: user.id, email, full_name: fullName, role: 'member' })
        if (pErr) throw new Error(`profile: ${pErr.message}`)
        await db.from('invites').delete().eq('email', email)
        const rec = await db.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } })
        if (rec.error) throw new Error(`generateLink recovery: ${rec.error.message}`)
        link = setPasswordLink(env.base, rec.data.properties)
      } else {
        // Never confirmed: whoever set its password does not own the inbox.
        const { error: pwErr } = await db.auth.admin.updateUserById(user.id, { password: randomBytes(32).toString('base64url') })
        if (pwErr) throw new Error(`reset unconfirmed password: ${pwErr.message}`)
        const magic = await db.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } })
        if (magic.error) throw new Error(`generateLink magiclink: ${magic.error.message}`)
        link = setPasswordLink(env.base, magic.data.properties)
      }
    }
    if (!link) throw new Error('no action link returned')

    const mail = officeInvite({ name: fullName, inviterName: me.full_name, link })
    const { error: sendErr } = await new Resend(env.resendKey).emails.send({
      from: env.from,
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
    if (sendErr) {
      console.error('invite email:', sendErr.message)
      return res.status(502).json({ error: 'The invite is saved, but the email did not go out. Try "Send again".' })
    }
    return res.status(200).json({ sent: true })
  } catch (err) {
    return res.status(500).json(serverErrorBody(err))
  }
}
