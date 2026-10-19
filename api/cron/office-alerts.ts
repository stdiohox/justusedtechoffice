import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Resend } from 'resend'
import { isRefusal, officeEnv, serviceClient } from '../_lib/server.js'
import {
  officeAlerts,
  officeDigest,
  officeMissedNudge,
  officeReminder,
  type Email,
  type OfficeAlertLine,
} from '../_lib/templates.js'
import { REPORT_KINDS, REPORT_LABEL, checkpointWindow, hhmm, isWorkday, needsProof } from '../../src/lib/office.js'
import { localParts } from '../../src/lib/timezones.js'
import { fmtMinutes, isShortDay } from '../../src/lib/activity.js'
import type {
  OfficeFlag,
  OfficeReport,
  OfficeRosterDay,
  OfficeSettings,
  OfficeTimeDay,
  ReportKind,
} from '../../src/types/database.js'

/**
 * The office's email alerts, sent through Resend from OFFICE_FROM_EMAIL.
 *
 * Called every five minutes by pg_cron through pg_net (0003), with
 * `Authorization: Bearer $CRON_SECRET`. GET works too, for a Vercel Cron.
 * Flags themselves are raised in SQL by office-raise-flags (0002), so a
 * Resend or Vercel outage loses emails, never the record.
 *
 * Everyone is emailed at their login address (profiles.email). Mr Tito
 * is office_settings.manager_id; his alerts and summary go to
 * OFFICE_MANAGER_EMAIL instead when that is set (his login stays as it is).
 *
 * ONE CALL, IN ORDER
 *   1. Flags not yet sent (missed, late, reused proof): one email to Mr Tito
 *      listing them, then notified_at. A missed checkpoint also emails the
 *      person who missed it.
 *   2. Reminders, once per checkpoint per day, to everyone due who has not
 *      filed: sign-in at 09:00, midday when it opens at 13:00, EOD at 17:00.
 *   3. The day's summary to Mr Tito, once, after the EOD deadline. Once
 *      enforcement is on (office_settings.enforce_activity, 0008), each
 *      person's active time, sign-outs and missed check-ins for the day are
 *      in it too (office_time_summary, 0009). In trial mode they are not, and
 *      no separate email is ever sent about them.
 *   4. The 90-day proof purge, once a day, through the Storage API.
 *
 * Steps 2-4 each claim a row in office_alert_log first, so overlapping runs
 * cannot send twice; a claim whose send failed is released for the next run
 * (for reminders: if any one person's failed). A missed-checkpoint email to
 * the member is sent once, after Mr Tito's alert; if it fails it is reported,
 * not retried.
 * Every email also carries a Resend idempotency key, so a retry after a
 * timeout returns the first send instead of sending again. Any failure turns
 * the response 500 with the reason, which pg_net records.
 */

/** Flags older than this are marked sent without sending: news, not history. */
const FLAG_MAX_AGE_HOURS = 12
const PURGE_BATCH = 500
/** Batches per run; the backlog after the first day is a few files a day. */
const PURGE_MAX_BATCHES = 10

const FLAG_LABEL: Record<OfficeFlag['flag'], string> = {
  missed: 'Not filed',
  late: 'Filed late',
  reused_proof: 'Proof reused',
}

/** Timing-safe, and length-safe: hashing first makes both sides 32 bytes. */
function secretMatches(given: string | undefined, secret: string): boolean {
  const a = createHash('sha256').update(given ?? '').digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

interface Member {
  user_id: string
  active: boolean
  user: { full_name: string; email: string; deactivated_at: string | null } | null
}

interface Person {
  name: string
  email: string
}

interface Ctx {
  db: SupabaseClient
  resend: Resend
  settings: OfficeSettings
  date: string
  time: string
  reportsUrl: string
  /** OFFICE_FROM_EMAIL, checked when the run starts. */
  from: string
  names: Map<string, string>
  /** Active, not deactivated office members. Only they are emailed. */
  people: Map<string, Person>
  manager: Person | null
  problems: string[]
  sent: string[]
}

/** True if this run won the claim. A duplicate key means another run did. */
async function claim(db: SupabaseClient, key: string): Promise<boolean> {
  const { error } = await db.from('office_alert_log').insert({ key })
  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(`claim ${key} failed: ${error.message}`)
}

async function release(db: SupabaseClient, key: string): Promise<void> {
  await db.from('office_alert_log').delete().eq('key', key)
}

/** Never throws: a failure is recorded and reported as false. */
async function send(ctx: Ctx, to: Person, email: Email, idempotencyKey: string): Promise<boolean> {
  try {
    const { error } = await ctx.resend.emails.send(
      { from: ctx.from, to: to.email, subject: email.subject, html: email.html, text: email.text },
      { idempotencyKey },
    )
    if (error) {
      ctx.problems.push(`${idempotencyKey} -> ${to.name}: ${error.message}`)
      return false
    }
  } catch (err) {
    ctx.problems.push(`${idempotencyKey} -> ${to.name}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  ctx.sent.push(`${idempotencyKey} -> ${to.name}`)
  return true
}

async function toManager(ctx: Ctx, email: Email, key: string): Promise<boolean> {
  if (!ctx.manager) {
    ctx.problems.push(`${key}: no manager to email (set office_settings.manager_id to Mr Tito)`)
    return false
  }
  return send(ctx, ctx.manager, email, key)
}

/**
 * A member who is paused, deactivated or gone is skipped, not an error.
 * False only when a send to someone who should get it failed.
 */
async function toMember(ctx: Ctx, userId: string, email: Email, key: string): Promise<boolean> {
  const person = ctx.people.get(userId)
  return person ? send(ctx, person, email, key) : true
}

async function roster(ctx: Ctx): Promise<OfficeRosterDay[]> {
  const { data, error } = await ctx.db.rpc('office_roster', { p_from: ctx.date, p_to: ctx.date })
  if (error) throw new Error(`roster failed: ${error.message}`)
  return (data ?? []) as OfficeRosterDay[]
}

async function todaysReports(ctx: Ctx): Promise<OfficeReport[]> {
  const { data, error } = await ctx.db.from('office_reports').select('*').eq('work_date', ctx.date)
  if (error) throw new Error(`reports query failed: ${error.message}`)
  return (data ?? []) as OfficeReport[]
}

/* ------------------------------------------------------------- 1. flags */

async function sendFlags(ctx: Ctx): Promise<void> {
  const since = new Date(Date.now() - FLAG_MAX_AGE_HOURS * 3_600_000).toISOString()
  const { error: oldErr } = await ctx.db
    .from('office_flags')
    .update({ notified_at: new Date().toISOString() })
    .is('notified_at', null)
    .lt('raised_at', since)
  if (oldErr) throw new Error(`stale flag sweep failed: ${oldErr.message}`)

  const { data, error } = await ctx.db
    .from('office_flags')
    .select('*')
    .is('notified_at', null)
    .order('raised_at')
  if (error) throw new Error(`flag query failed: ${error.message}`)
  const flags = (data ?? []) as OfficeFlag[]
  if (!flags.length) return

  const lines: OfficeAlertLine[] = flags.map((f) => {
    const what = REPORT_LABEL[f.kind].toLowerCase()
    const detail =
      f.flag === 'late' && f.detail ? ` at ${f.detail}` : f.flag === 'reused_proof' && f.detail ? ` (${f.detail})` : ''
    return { label: FLAG_LABEL[f.flag], who: ctx.names.get(f.user_id) ?? 'Someone', what: `${what}${detail}` }
  })
  // One key per exact set of flags: a retry of this batch is the same email.
  const batch = createHash('sha256').update(flags.map((f) => f.id).sort().join(',')).digest('hex').slice(0, 32)
  const ok = await toManager(ctx, officeAlerts({ lines, reportsUrl: ctx.reportsUrl }), `office-flags/${batch}`)
  if (!ok) return

  const { error: markErr } = await ctx.db
    .from('office_flags')
    .update({ notified_at: new Date().toISOString() })
    .in('id', flags.map((f) => f.id))
  if (markErr) throw new Error(`marking flags sent failed: ${markErr.message}`)

  for (const f of flags.filter((f) => f.flag === 'missed')) {
    const name = ctx.names.get(f.user_id) ?? ''
    await toMember(
      ctx,
      f.user_id,
      officeMissedNudge({
        name,
        what: REPORT_LABEL[f.kind].toLowerCase(),
        deadline: checkpointWindow(ctx.settings, f.kind).deadline,
        reportsUrl: ctx.reportsUrl,
      }),
      `office-nudge/${f.id}`,
    )
  }
}

/* --------------------------------------------------------- 2. reminders */

async function sendReminders(ctx: Ctx, due: OfficeRosterDay[], reports: OfficeReport[]): Promise<void> {
  const at: Record<ReportKind, string> = {
    signin: hhmm(ctx.settings.signin_reminder),
    midday: hhmm(ctx.settings.midday_opens),
    eod: hhmm(ctx.settings.eod_opens),
  }
  for (const kind of REPORT_KINDS) {
    const { deadline } = checkpointWindow(ctx.settings, kind)
    if (ctx.time < at[kind] || ctx.time > deadline) continue
    const key = `remind:${kind}:${ctx.date}`
    if (!(await claim(ctx.db, key))) continue

    const pending = due.filter((d) => !reports.some((r) => r.user_id === d.user_id && r.kind === kind))
    let allSent = true
    for (const d of pending) {
      const ok = await toMember(
        ctx,
        d.user_id,
        officeReminder({
          name: ctx.names.get(d.user_id) ?? '',
          what: REPORT_LABEL[kind].toLowerCase(),
          deadline,
          needsProof: needsProof(kind),
          reportsUrl: ctx.reportsUrl,
        }),
        `office-remind/${kind}/${ctx.date}/${d.user_id}`,
      )
      allSent = allSent && ok
    }
    // Retry the round next run if anyone's failed (a rate limit, a timeout).
    // People already emailed are not emailed twice: their idempotency key
    // makes Resend return the first send.
    if (!allSent) await release(ctx.db, key)
  }
}

/* ------------------------------------------------------------ 3. digest */

/** Codes for "that function does not exist yet" (0009 not applied). */
const MISSING_FUNCTION = new Set(['42883', 'PGRST202'])

/**
 * The day's activity per person, once enforcement is on; null in trial mode.
 * If it cannot be read, the summary still goes without it and the run reports
 * why (a missing 0009 is reported too: enforcement is on without it).
 */
async function dayActivity(ctx: Ctx): Promise<Map<string, OfficeTimeDay> | null> {
  if (ctx.settings.enforce_activity !== true) return null
  let data: unknown
  let error: { code?: string; message: string } | null
  try {
    ;({ data, error } = await ctx.db.rpc('office_time_summary', { p_from: ctx.date, p_to: ctx.date }))
  } catch (err) {
    // Thrown, not returned (a network failure): the summary must still go.
    error = { message: err instanceof Error ? err.message : String(err) }
  }
  if (error) {
    ctx.problems.push(
      MISSING_FUNCTION.has(error.code ?? '')
        ? 'digest: enforcement is on but office_time_summary is missing (apply 0009); sent without activity'
        : `digest: activity not read (${error.message}); sent without it`,
    )
    return null
  }
  return new Map(((data ?? []) as OfficeTimeDay[]).map((t) => [t.user_id, t]))
}

async function sendDigest(ctx: Ctx, due: OfficeRosterDay[], reports: OfficeReport[]): Promise<void> {
  if (ctx.time <= hhmm(ctx.settings.eod_deadline)) return
  const key = `digest:${ctx.date}`
  if (!(await claim(ctx.db, key))) return
  const activity = await dayActivity(ctx)

  const cell = (r: OfficeReport | undefined) =>
    !r ? 'not filed' : r.timing === 'late' ? `late ${localParts(ctx.settings.timezone, new Date(r.submitted_at)).time}` : 'on time'
  const rows = due.map((d) => {
    const [signin, midday, eod] = REPORT_KINDS.map((k) => cell(reports.find((r) => r.user_id === d.user_id && r.kind === k)))
    const t = activity?.get(d.user_id)
    return {
      name: ctx.names.get(d.user_id) ?? 'Someone',
      signin,
      midday,
      eod,
      // Someone with no row at all (never in) still gets a line: nothing recorded.
      activity: activity
        ? {
            active: fmtMinutes(t?.active_min ?? 0),
            signouts: t?.signouts ?? 0,
            missed: t?.checkins_missed ?? 0,
            // 0010: only when Mr Tito has set a short day; absent otherwise, and the column with it.
            short: ctx.settings.short_day_minutes ? (t ? isShortDay(t, ctx.settings.short_day_minutes) : false) : undefined,
          }
        : undefined,
    }
  })
  const complete = due.filter((d) => REPORT_KINDS.every((k) => reports.some((r) => r.user_id === d.user_id && r.kind === k)))
  const email = officeDigest({
    date: ctx.date,
    due: due.length,
    complete: complete.length,
    rows,
    reportsUrl: ctx.reportsUrl,
    shortDayMinutes: ctx.settings.short_day_minutes ?? null,
  })

  if (!(await toManager(ctx, email, `office-digest/${ctx.date}`))) await release(ctx.db, key)
}

/* ------------------------------------------------------------- 4. purge */

async function purgeProof(ctx: Ctx): Promise<void> {
  const key = `purge:${ctx.date}`
  if (!(await claim(ctx.db, key))) return
  try {
    let removed = 0
    for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
      const { data, error } = await ctx.db.rpc('office_proof_due_for_purge', { p_limit: PURGE_BATCH })
      if (error) throw new Error(error.message)
      const paths = (data ?? []) as string[]
      if (!paths.length) break
      const { error: rmErr } = await ctx.db.storage.from('proof').remove(paths)
      if (rmErr) throw new Error(rmErr.message)
      removed += paths.length
      if (paths.length < PURGE_BATCH) break
    }
    // Marks every file whose object is gone, including any an earlier run
    // removed but failed to mark.
    const { data: marked, error: markErr } = await ctx.db.rpc('office_mark_purged')
    if (markErr) throw new Error(markErr.message)
    if (removed || marked) ctx.sent.push(`purged ${removed} proof files, marked ${marked ?? 0}`)
  } catch (err) {
    await release(ctx.db, key)
    ctx.problems.push(`purge: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/* ----------------------------------------------------------------- run */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured. Refusing to run.' })
  }
  if (!secretMatches(req.headers.authorization, secret)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Refused rather than defaulted: every email's one call to action is a
  // link back into the office, and a link nobody can open is worse than none.
  const env = officeEnv()
  if (isRefusal(env)) return res.status(env.status).json({ error: env.error })
  const { url, serviceKey, resendKey, from, base } = env
  // Optional. Refused rather than ignored when malformed, so a typo cannot
  // quietly send Mr Tito's alerts back to his login address.
  const managerEmail = process.env.OFFICE_MANAGER_EMAIL?.trim() || null
  if (managerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) {
    return res.status(500).json({ error: 'OFFICE_MANAGER_EMAIL is not an email address. Refusing to run.' })
  }
  const db = serviceClient(url, serviceKey)

  try {
    const { data: settings, error: sErr } = await db.from('office_settings').select('*').eq('id', 1).single()
    if (sErr || !settings) throw new Error(`settings: ${sErr?.message ?? 'no row'}`)
    const s = settings as OfficeSettings

    // Everyone, paused included, so a paused person's flag still has a name.
    const { data: memberRows, error: mErr } = await db
      .from('office_members')
      .select('user_id, active, user:profiles!office_members_user_id_fkey (full_name, email, deactivated_at)')
    if (mErr) throw new Error(`members: ${mErr.message}`)
    const members = (memberRows ?? []) as unknown as Member[]

    // Mr Tito by his login, whether or not he is also an office member,
    // at OFFICE_MANAGER_EMAIL when that is set.
    let manager: Person | null = null
    if (s.manager_id) {
      const { data: m, error: e } = await db
        .from('profiles')
        .select('full_name, email, deactivated_at')
        .eq('id', s.manager_id)
        .maybeSingle()
      if (e) throw new Error(`manager: ${e.message}`)
      if (m?.email && !m.deactivated_at) manager = { name: m.full_name, email: managerEmail ?? m.email }
    }

    const now = localParts(s.timezone, new Date())
    const ctx: Ctx = {
      db,
      resend: new Resend(resendKey),
      settings: s,
      date: now.date,
      time: now.time,
      reportsUrl: `${base}/reports`,
      from,
      names: new Map(members.map((m) => [m.user_id, m.user?.full_name ?? 'Someone'])),
      people: new Map(
        members
          .filter((m) => m.active && m.user?.email && !m.user.deactivated_at)
          .map((m) => [m.user_id, { name: m.user!.full_name, email: m.user!.email }]),
      ),
      manager,
      problems: [],
      sent: [],
    }

    await sendFlags(ctx)

    if (isWorkday(s, ctx.date)) {
      const due = (await roster(ctx)).filter((d) => d.expected)
      const reports = await todaysReports(ctx)
      await sendReminders(ctx, due, reports)
      await sendDigest(ctx, due, reports)
    }

    await purgeProof(ctx)

    const status = ctx.problems.length ? 500 : 200
    return res.status(status).json({ ok: status === 200, at: `${ctx.date} ${ctx.time}`, sent: ctx.sent, problems: ctx.problems })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
