import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Resend } from 'resend'
import { isRefusal, officeEnv, serviceClient } from '../_lib/server.js'
import {
  leaderboardPersonal,
  leaderboardTable,
  officeAlerts,
  officeDigest,
  officeMissedNudge,
  officeReminder,
  type BoardRow,
  type Email,
  type OfficeAlertLine,
  type RatingLine,
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
 *      filed: at the sign-in reminder, when midday opens, when EOD opens
 *      (office_settings; 11:00, 15:00 and 19:00 since 0014).
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
  /** 0012: the Friday leaderboard emails link here. */
  boardUrl: string
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

/**
 * Work started before sign-in (0014), for the summary: what each person said,
 * beside their first task step, knock or chat that day. Best effort: before
 * 0014, or on any error, the summary goes without it.
 */
async function dayStarts(ctx: Ctx): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { data, error } = await ctx.db.rpc('office_day_starts_range', { p_from: ctx.date, p_to: ctx.date })
  if (error) {
    if (!(error.code && NO_FUNCTION.has(error.code))) ctx.problems.push(`digest: early starts not read (${error.message}); sent without them`)
    return out
  }
  const start = hhmm(ctx.settings.signin_reminder)
  const at = (iso: string) => localParts(ctx.settings.timezone, new Date(iso)).time
  for (const r of (data ?? []) as { user_id: string; started_at: string | null; note: string | null; first_work_at: string | null }[]) {
    const said = r.started_at ? at(r.started_at) : null
    const first = r.first_work_at ? at(r.first_work_at) : null
    const early = first && first < start ? first : null
    if (said) out.set(r.user_id, `started ${said}, said by them${early ? ` (first work seen ${early})` : ''}`)
    else if (early) out.set(r.user_id, `first work seen ${early}, before ${start}`)
  }
  return out
}

async function sendDigest(ctx: Ctx, due: OfficeRosterDay[], reports: OfficeReport[]): Promise<void> {
  if (ctx.time <= hhmm(ctx.settings.eod_deadline)) return
  const key = `digest:${ctx.date}`
  if (!(await claim(ctx.db, key))) return
  const activity = await dayActivity(ctx)
  const early = await dayStarts(ctx)

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
      early: early.get(d.user_id),
    }
  })
  const complete = due.filter((d) => REPORT_KINDS.every((k) => reports.some((r) => r.user_id === d.user_id && r.kind === k)))
  const email = officeDigest({
    hours: `${hhmm(ctx.settings.signin_reminder)} and ${hhmm(ctx.settings.eod_deadline)}`,
    date: ctx.date,
    due: due.length,
    complete: complete.length,
    rows,
    reportsUrl: ctx.reportsUrl,
    shortDayMinutes: ctx.settings.short_day_minutes ?? null,
  })

  if (!(await toManager(ctx, email, `office-digest/${ctx.date}`))) await release(ctx.db, key)
}

/* ------------------------------------------------------- 4. leaderboard */

interface BoardDbRow {
  user_id: string
  full_name: string
  tasks_done: number
  avg_rating: number | string | null
  reports_on_time: number
  points: number
  starts_at: string
  ends_at: string
}

/** PostgREST / Postgres: "no function with those arguments" (0012 not applied). */
const NO_FUNCTION = new Set(['42883', 'PGRST202'])

/** "Fri 16 Oct, 17:00 to Fri 23 Oct, 17:00", office time. */
function weekLabel(zone: string, from: string, to: string): string {
  const one = (iso: string) => {
    const d = new Date(iso)
    const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone })
    return `${day}, ${localParts(zone, d).time}`
  }
  return `${one(from)} to ${one(to)}`
}

/**
 * The week that just closed (Friday 17:00 to Friday 17:00, 0012; scored on
 * tasks and reports), once, on
 * Friday from the end-of-day time (eod_opens): each person on the board gets their place,
 * their numbers, the stars they were given and the top three (the winner, a
 * version that says so); Mr Tito and every admin get the whole table.
 * Read before claiming: without 0012 there is nothing to send, and nothing
 * is claimed. A failed send releases the claim for the next run; Resend's
 * idempotency keys stop the people already emailed getting it twice.
 */
async function sendLeaderboard(ctx: Ctx): Promise<void> {
  const now = localParts(ctx.settings.timezone, new Date())
  // The week closes when the end-of-day report opens (0014: 19:00 here).
  if (now.weekday !== 5 || now.time < hhmm(ctx.settings.eod_opens)) return
  const key = `leaderboard:${ctx.date}`

  const { data, error } = await ctx.db.rpc('office_leaderboard', { p_weeks_ago: 1 })
  if (error) {
    if (!(error.code && NO_FUNCTION.has(error.code))) ctx.problems.push(`leaderboard: ${error.message}`)
    return
  }
  const board = (data ?? []) as BoardDbRow[]
  if (!board.length) return
  if (!(await claim(ctx.db, key))) return

  try {
    const from = board[0].starts_at
    const to = board[0].ends_at
    const week = weekLabel(ctx.settings.timezone, from, to)
    const rows: BoardRow[] = board.map((r) => ({
      name: r.full_name,
      points: r.points,
      tasks: r.tasks_done,
      avgRating: r.avg_rating === null ? null : Number(r.avg_rating),
      reports: r.reports_on_time,
    }))

    // Addresses: everyone on the board, and every admin (the table).
    const { data: users, error: uErr } = await ctx.db
      .from('profiles')
      .select('id, full_name, email, role, deactivated_at')
      .is('deactivated_at', null)
    if (uErr) throw new Error(`users: ${uErr.message}`)
    const byId = new Map(((users ?? []) as { id: string; full_name: string; email: string; role: string }[]).map((u) => [u.id, u]))

    // The stars that counted this week: the same rule as the points (0012),
    // tasks approved in the week and rated before it closed.
    const { data: rated, error: rErr } = await ctx.db
      .from('office_tasks')
      .select('title, rating, rating_note, rated_by, assigned_to')
      .eq('status', 'approved')
      .not('rating', 'is', null)
      .gte('closed_at', from)
      .lt('closed_at', to)
      .lt('rated_at', to)
    if (rErr) throw new Error(`ratings: ${rErr.message}`)
    const ratingsFor = (uid: string): RatingLine[] =>
      ((rated ?? []) as { title: string; rating: number; rating_note: string | null; rated_by: string | null; assigned_to: string }[])
        .filter((t) => t.assigned_to === uid)
        .map((t) => ({ title: t.title, stars: t.rating, note: t.rating_note, by: (t.rated_by && byId.get(t.rated_by)?.full_name) || 'Someone' }))

    const top = rows.slice(0, 3)
    const best = rows[0].points
    let ok = true
    const sentBefore = ctx.sent.length
    for (const [k, r] of board.entries()) {
      const u = byId.get(r.user_id)
      if (!u?.email) continue
      const rank = 1 + rows.filter((x) => x.points > r.points).length
      const email = leaderboardPersonal({
        name: u.full_name,
        rank,
        of: rows.length,
        row: rows[k],
        top,
        ratings: ratingsFor(r.user_id),
        week,
        boardUrl: ctx.boardUrl,
        winner: best > 0 && r.points === best,
      })
      ok = (await send(ctx, { name: u.full_name, email: u.email }, email, `leaderboard/${ctx.date}/${r.user_id}`)) && ok
    }

    // The whole table: Mr Tito (at OFFICE_MANAGER_EMAIL when set), then every other admin.
    if (ctx.manager) {
      ok = (await send(ctx, ctx.manager, leaderboardTable({ name: ctx.manager.name, rows, week, boardUrl: ctx.boardUrl }), `leaderboard-table/${ctx.date}/manager`)) && ok
    }
    for (const u of byId.values()) {
      if (u.role !== 'manager' || u.id === ctx.settings.manager_id || !u.email) continue
      ok = (await send(ctx, { name: u.full_name, email: u.email }, leaderboardTable({ name: u.full_name, rows, week, boardUrl: ctx.boardUrl }), `leaderboard-table/${ctx.date}/${u.id}`)) && ok
    }
    // Nothing went: try again on the next run. Some went: keep the claim, so
    // the people already emailed are not emailed again, and report the rest.
    if (!ok && ctx.sent.length === sentBefore) await release(ctx.db, key)
  } catch (err) {
    await release(ctx.db, key)
    ctx.problems.push(`leaderboard: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/* ---------------------------------------------- 5. task proof clean-up */

/**
 * Images uploaded as task proof but never handed in (0013), once a day: an
 * upload that was abandoned, a hand-in that failed, or a task that was
 * deleted. The list comes from office_task_proof_orphans(); the files go
 * through the Storage API, which SQL cannot do. Before 0013, nothing to do.
 */
async function purgeTaskProof(ctx: Ctx): Promise<void> {
  const key = `task-proof-purge:${ctx.date}`
  const { data, error } = await ctx.db.rpc('office_task_proof_orphans', { p_limit: 500 })
  if (error) {
    if (!(error.code && NO_FUNCTION.has(error.code))) ctx.problems.push(`task proof: ${error.message}`)
    return
  }
  const paths = (data ?? []) as string[]
  if (!paths.length) return
  if (!(await claim(ctx.db, key))) return
  const { error: rmErr } = await ctx.db.storage.from('task-proof').remove(paths)
  if (rmErr) {
    await release(ctx.db, key)
    ctx.problems.push(`task proof: ${rmErr.message}`)
    return
  }
  ctx.sent.push(`removed ${paths.length} task proof images never handed in`)
}

/* ------------------------------------------------------------- 6. purge */

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
      boardUrl: `${base}/leaderboard`,
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

    await sendLeaderboard(ctx)
    await purgeTaskProof(ctx)
    await purgeProof(ctx)

    const status = ctx.problems.length ? 500 : 200
    return res.status(status).json({ ok: status === 200, at: `${ctx.date} ${ctx.time}`, sent: ctx.sent, problems: ctx.problems })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
