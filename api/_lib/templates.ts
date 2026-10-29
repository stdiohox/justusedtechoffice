/**
 * The office's emails: reminders, alerts and the daily summary (0003's clock,
 * api/cron/office-alerts), the knock email (api/office/knock-ping), and the
 * invite and new-password links (api/team/invite, api/auth/recover).
 *
 * Under `api/_lib/` because Vercel turns every file in `api/` into a route
 * unless the path has an underscore-prefixed segment.
 *
 * TEXT-FORWARD, NOT DESIGNED: these are notifications, read on a phone. One
 * green accent line is the whole visual budget. Every rule is inline (Gmail
 * strips <style>), the layout is presentation tables (Outlook renders through
 * Word), and every template returns a text part as well as HTML.
 *
 * No remote logo: the wordmark is text, so nothing can fail to load.
 */

const GREEN = '#007A37'
const BRIGHT = '#00A652'
const INK = '#0B1A12'
const MUTED = '#59665E'
const RULE = 'rgba(0,122,55,0.16)'
const PAGE = '#F6FAF7'
const CARD = '#ffffff'

export interface Email {
  subject: string
  html: string
  text: string
}

/** Escapes anything interpolated into the HTML. Names are typed by people. */
const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** One frame, so every email looks like the same office sent it. */
function shell(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>JUSTUSED Office</title></head>
<body style="margin:0;padding:0;background:${PAGE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="width:560px;max-width:100%;background:${CARD};border:1px solid ${RULE};border-radius:16px;">
          <tr>
            <td style="padding:28px;font-family:Nunito,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${INK};">
              <p style="margin:0 0 22px;border-left:4px solid ${BRIGHT};padding-left:12px;font-size:14px;letter-spacing:0.06em;text-transform:uppercase;color:${GREEN};font-weight:800;">
                JUSTUSED <span style="font-weight:600;">Office</span>
              </p>
${bodyHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>`
}

const p = (s: string) => `    <p style="margin:0 0 14px;">${s}</p>`

const DANGER = '#8C2F22'
const WARNING = '#7A5C10'

const link = (url: string, label: string) =>
  `    <p style="margin:0 0 14px;"><a href="${esc(url)}" style="color:${GREEN};font-weight:700;">${esc(label)}</a></p>`

const firstNameOf = (full: string) => cleanName(full).split(' ')[0] || cleanName(full)

/**
 * Names are self-editable (profiles.full_name), so one that reaches an email
 * from the office's own address is cleaned first: line breaks and control
 * characters become spaces (a subject must stay one line), invisible and
 * direction-changing characters are dropped, and it is cut to 60 characters
 * so nobody can turn their name into a message. Task titles and notes (0011)
 * go through the same cleaning, with a longer limit.
 */
const cleanName = (s: string, max = 60) => {
  const controls = Array.from(s, (c) => {
    const n = c.charCodeAt(0)
    return n < 32 || n === 127 || n === 0x2028 || n === 0x2029 ? ' ' : c
  }).join('')
  const one = controls
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Cut by code points, so an emoji is never split into half a surrogate pair.
  const chars = Array.from(one)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one
}

export interface OfficeReminderInput {
  name: string
  /** "midday report" */
  what: string
  /** "14:00", office time */
  deadline: string
  takesProof: boolean
  reportsUrl: string
}

/** "Time for your midday report", to someone who has not filed it yet. */
export function officeReminder(i: OfficeReminderInput): Email {
  const proof = i.takesProof ? ' Add a screenshot, a file or links as proof of work if you have them.' : ''
  return {
    subject: `Time for your ${i.what}`,
    html: shell(
      p(`Hi ${esc(firstNameOf(i.name))},`) +
        p(`Your ${esc(i.what)} is open. It is on time until ${esc(i.deadline)}.${esc(proof)}`) +
        link(i.reportsUrl, `File your ${i.what}`),
    ),
    text: [
      `Hi ${firstNameOf(i.name)},`,
      '',
      `Your ${i.what} is open. It is on time until ${i.deadline}.${proof}`,
      '',
      `File it: ${i.reportsUrl}`,
    ].join('\n'),
  }
}

/** "Your sign-in was due by 09:15", to the person who missed it. */
export function officeMissedNudge(i: Omit<OfficeReminderInput, 'takesProof'>): Email {
  return {
    subject: `Your ${i.what} has not been filed`,
    html: shell(
      p(`Hi ${esc(firstNameOf(i.name))},`) +
        p(`Your ${esc(i.what)} was due by ${esc(i.deadline)} and has not been filed. You can still file it today; it will be marked late.`) +
        link(i.reportsUrl, `File your ${i.what}`),
    ),
    text: [
      `Hi ${firstNameOf(i.name)},`,
      '',
      `Your ${i.what} was due by ${i.deadline} and has not been filed. You can still file it today; it will be marked late.`,
      '',
      `File it: ${i.reportsUrl}`,
    ].join('\n'),
  }
}

export interface OfficeAlertLine {
  /** "Not filed", "Filed late", "Proof reused" */
  label: string
  who: string
  /** "sign-in", "midday report at 14:20" */
  what: string
}

/** Missed, late and reused-proof alerts, batched into one email to HR (Mr Tito has them weekly). */
export function officeAlerts(i: { lines: OfficeAlertLine[]; reportsUrl: string }): Email {
  i = { ...i, lines: i.lines.map((l) => ({ ...l, who: cleanName(l.who) })) }
  const n = i.lines.length
  return {
    subject: n === 1 ? `Office: ${i.lines[0].who}, ${i.lines[0].label.toLowerCase()}` : `Office: ${n} report alerts`,
    html: shell(
      i.lines
        .map((l) => p(`<strong>${esc(l.label)}:</strong> ${esc(l.who)}, ${esc(l.what)}`))
        .join('\n') +
        '\n' +
        link(i.reportsUrl, 'Open today in Reports'),
    ),
    text: [...i.lines.map((l) => `${l.label}: ${l.who}, ${l.what}`), '', `Open today in Reports: ${i.reportsUrl}`].join('\n'),
  }
}

export interface OfficeDigestRow {
  name: string
  /** Per checkpoint: "on time", "late 14:20" or "not filed". */
  signin: string
  midday: string
  eod: string
  /**
   * The day's office activity (0009), only once enforcement is on: time with
   * input in the office ("3h 25m"), sign-outs after inactivity, missed
   * check-ins. Absent in trial mode, and the columns with it.
   */
  activity?: { active: string; signouts: number; missed: number; short?: boolean }
  /** 0014: "started 07:40, said by them (first work seen 07:52)", or absent. */
  early?: string
}

/** The day's summary for HR, after the EOD deadline (Mr Tito has the week on Friday). */
export function officeDigest(i: {
  /** The working window, "11:00 and 20:30" (office_settings). */
  hours: string
  date: string
  due: number
  complete: number
  rows: OfficeDigestRow[]
  reportsUrl: string
  /** 0010: the short-day setting, for the note under the table. */
  shortDayMinutes?: number | null
}): Email {
  i = { ...i, rows: i.rows.map((r) => ({ ...r, name: cleanName(r.name) })) }
  const head = i.due
    ? `${i.complete} of ${i.due} filed everything today.`
    : 'Nobody was due to report today.'
  const cell = (s: string) =>
    `<td style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};font-size:14px;${
      s === 'not filed' ? `color:${DANGER};font-weight:600;` : s.startsWith('late') ? `color:${WARNING};` : ''
    }">${esc(s)}</td>`
  const withActivity = i.rows.some((r) => r.activity)
  const withShort = i.rows.some((r) => r.activity?.short !== undefined)
  // Plain, not red: these are a guide for a conversation, not a verdict.
  const count = (n: number | undefined) =>
    `<td style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};font-size:14px;">${n === undefined ? '-' : esc(String(n))}</td>`
  const activityCells = (r: OfficeDigestRow) =>
    withActivity
      ? `<td style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};font-size:14px;">${esc(r.activity?.active ?? '-')}</td>${count(r.activity?.signouts)}${count(r.activity?.missed)}${
          withShort ? `<td style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};font-size:14px;">${r.activity?.short ? 'short' : ''}</td>` : ''
        }`
      : ''
  const table = i.rows.length
    ? `    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-collapse:collapse;">
      <tr>${['', 'Sign-in', 'Midday', 'End of day', ...(withActivity ? ['Active', 'Sign-outs', 'Missed check-ins'] : []), ...(withShort ? ['Short day'] : [])]
        .map((h) => `<td style="padding:0 10px 6px 0;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.06em;">${h}</td>`)
        .join('')}</tr>
${i.rows
  .map((r) => `      <tr><td style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};font-size:14px;font-weight:600;">${esc(r.name)}${r.early ? `<br><span style="font-weight:400;font-size:12px;color:${MUTED};">${esc(r.early)}</span>` : ''}</td>${cell(r.signin)}${cell(r.midday)}${cell(r.eod)}${activityCells(r)}</tr>`)
  .join('\n')}
    </table>\n`
    : ''
  const shortHours = i.shortDayMinutes ? `${Math.round((i.shortDayMinutes / 60) * 10) / 10} hours` : null
  const activityNote = withActivity
    ? `Active is time with input in the office between ${i.hours}. Sign-outs count those after 30 minutes away or with the office closed.${
        withShort && shortHours ? ` A short day is a signed-in day with under ${shortHours} of working time (active, do not disturb and working elsewhere).` : ''
      } Time working elsewhere, do not disturb and the notes people added are in Reports.`
    : null
  const activityText = (r: OfficeDigestRow) =>
    r.activity
      ? ` · active ${r.activity.active} · ${r.activity.signouts} ${r.activity.signouts === 1 ? 'sign-out' : 'sign-outs'} · ${r.activity.missed} missed ${r.activity.missed === 1 ? 'check-in' : 'check-ins'}${r.activity.short ? ' · short day' : ''}`
      : ''
  return {
    subject: `Daily report, ${i.date}: ${i.complete} of ${i.due} complete`,
    html: shell(p(esc(head)) + table + (activityNote ? p(esc(activityNote)) : '') + link(i.reportsUrl, 'Open the day in Reports')),
    text: [
      head,
      '',
      ...i.rows.map((r) => `${r.name}: sign-in ${r.signin} · midday ${r.midday} · end of day ${r.eod}${activityText(r)}${r.early ? ` · ${r.early}` : ''}`),
      ...(activityNote ? ['', activityNote] : []),
      '',
      `Open the day in Reports: ${i.reportsUrl}`,
    ].join('\n'),
  }
}

/* ------------------------------------------------- the leaderboard (0012) */

/** ★★★★☆ for 4: the stars are the message, the number beside them says it in words. */
const starLine = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n)

export interface BoardRow {
  name: string
  points: number
  tasks: number
  /** Average stars on this week's approved tasks, or null if none was rated. */
  avgRating: number | null
  reports: number
}

export interface RatingLine {
  title: string
  stars: number
  note: string | null
  by: string
}

const BOARD_HEAD = ['', '', 'Points', 'Tasks approved', 'Reports on time']

const boardCell = (s: string, strong = false) =>
  `<td style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};font-size:14px;${strong ? 'font-weight:600;' : ''}">${esc(s)}</td>`

const tasksCell = (r: BoardRow) => (r.avgRating === null ? String(r.tasks) : `${r.tasks} (${r.avgRating.toFixed(1)}★)`)

/** The whole table, or its first rows; `me` is set in bold gold. */
function boardTable(rows: BoardRow[], me?: string): string {
  return `    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-collapse:collapse;">
      <tr>${BOARD_HEAD.map((h) => `<td style="padding:0 10px 6px 0;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.06em;">${h}</td>`).join('')}</tr>
${rows
  .map((r, k) => {
    const mine = me !== undefined && r.name === me
    return `      <tr${mine ? ` style="background:#FBF6E7;"` : ''}>${boardCell(`${k + 1}.`)}${boardCell(r.name, true)}${boardCell(String(r.points), true)}${boardCell(tasksCell(r))}${boardCell(String(r.reports))}</tr>`
  })
  .join('\n')}
    </table>\n`
}

const boardText = (rows: BoardRow[]) =>
  rows.map((r, k) => `${k + 1}. ${r.name}: ${r.points} points (tasks approved ${tasksCell(r)}, reports on time ${r.reports})`)

const POINTS_NOTE =
  'Points: 5 plus its stars for each task approved (3 if not rated), up to 80 a week, whoever gave the task; 1 for each report filed on time.'

/**
 * Friday, to each person on the board: their place, their numbers, the stars
 * they were given, and the top three. The winner gets the same with a
 * different opening (and subject): `winner`.
 */
export function leaderboardPersonal(i: {
  name: string
  rank: number
  of: number
  row: BoardRow
  top: BoardRow[]
  ratings: RatingLine[]
  week: string
  boardUrl: string
  winner: boolean
}): Email {
  const row = { ...i.row, name: cleanName(i.row.name) }
  const top = i.top.map((r) => ({ ...r, name: cleanName(r.name) }))
  const ratings = i.ratings.map((r) => ({ ...r, title: cleanName(r.title, 120), note: r.note ? cleanName(r.note, 300) : null, by: cleanName(r.by) }))
  const first = firstNameOf(i.name)
  const opening = i.winner
    ? `You finished first on the JustUsedTech leaderboard this week, with ${row.points} points. Congratulations, and thank you.`
    : row.points > 0
      ? `You finished ${i.rank} of ${i.of} this week, with ${row.points} points.`
      : 'A quiet week on the leaderboard. Next week starts now.'
  const mine = [`Tasks approved: ${tasksCell(row)}`, `Reports on time: ${row.reports}`]
  const ratingsHtml = ratings.length
    ? p('<strong>Stars you were given</strong>') +
      ratings
        .map((r) => p(`${esc(starLine(r.stars))} <strong>${esc(r.title)}</strong>, from ${esc(r.by)}${r.note ? `<br><span style="color:${MUTED};">${esc(r.note)}</span>` : ''}`))
        .join('')
    : ''
  const banner = i.winner
    ? `    <p style="margin:0 0 18px;padding:14px 16px;background:${INK};color:#FFD966;border-radius:8px;font-size:18px;font-weight:600;">Top of the team this week</p>\n`
    : ''
  return {
    subject: i.winner ? 'You topped the JustUsedTech leaderboard this week' : `Your week: ${row.points} points, ${i.rank} of ${i.of}`,
    html: shell(
      banner +
        p(`Hi ${esc(first)},`) +
        p(esc(opening)) +
        p(`<span style="color:${MUTED};">${esc(i.week)}</span>`) +
        p(mine.map(esc).join('<br>')) +
        ratingsHtml +
        p('<strong>Top of the table</strong>') +
        boardTable(top, row.name) +
        p(`<span style="color:${MUTED};font-size:13px;">${esc(POINTS_NOTE)}</span>`) +
        link(i.boardUrl, 'See the whole leaderboard'),
    ),
    text: [
      ...(i.winner ? ['TOP OF THE TEAM THIS WEEK', ''] : []),
      `Hi ${first},`,
      '',
      opening,
      i.week,
      '',
      ...mine,
      ...(ratings.length ? ['', 'Stars you were given:', ...ratings.map((r) => `${starLine(r.stars)} ${r.title}, from ${r.by}${r.note ? `: ${r.note}` : ''}`)] : []),
      '',
      'Top of the table:',
      ...boardText(top),
      '',
      POINTS_NOTE,
      '',
      `See the whole leaderboard: ${i.boardUrl}`,
    ].join('\n'),
  }
}

/** Friday, to the managers and HR: the whole table (Mr Tito's is in his weekly summary). */
export function leaderboardTable(i: { name: string; rows: BoardRow[]; week: string; boardUrl: string }): Email {
  const rows = i.rows.map((r) => ({ ...r, name: cleanName(r.name) }))
  const winner = rows[0] && rows[0].points > 0 ? rows[0] : null
  const head = winner ? `${winner.name} topped the leaderboard this week with ${winner.points} points.` : 'Nobody scored this week.'
  return {
    // A fixed subject: names are self-edited, and this goes out from the office's address.
    subject: "This week's JustUsedTech leaderboard",
    html: shell(
      p(`Hi ${esc(firstNameOf(i.name))},`) +
        p(esc(head)) +
        p(`<span style="color:${MUTED};">${esc(i.week)}</span>`) +
        (rows.length ? boardTable(rows) : '') +
        p(`<span style="color:${MUTED};font-size:13px;">${esc(POINTS_NOTE)} Everyone on the team sees this table.</span>`) +
        link(i.boardUrl, 'Open the leaderboard'),
    ),
    text: [
      `Hi ${firstNameOf(i.name)},`,
      '',
      head,
      i.week,
      '',
      ...boardText(rows),
      '',
      `${POINTS_NOTE} Everyone on the team sees this table.`,
      '',
      `Open the leaderboard: ${i.boardUrl}`,
    ].join('\n'),
  }
}

/* ------------------------------------------------- Mr Tito's week (Friday) */

/** "Hazel", or "Mr Tito" when the name starts with a title. */
const greetingName = (full: string) => {
  const parts = cleanName(full).split(' ')
  return /^(mr|mrs|ms|miss|dr|engr|chief|prof)\.?$/i.test(parts[0] ?? '') && parts[1] ? `${parts[0]} ${parts[1]}` : firstNameOf(full)
}

/** One person's week: their reports, and their activity once enforced. */
export interface WeekOfficeRow {
  name: string
  onTime: number
  late: number
  notFiled: number
  /** short: short days (0010), only when Mr Tito has set a short day. */
  activity?: { active: string; signouts: number; missed: number; short?: number }
}

/**
 * Mr Tito's only scheduled email: once a week, Friday after the end-of-day
 * deadline. It replaces the report alerts, the day's summary and his copy of
 * the leaderboard (HR still gets the alerts and the day's summary). Sent even
 * on a quiet week: a system that goes quiet cannot be told from a broken one.
 */
export function weeklySummary(i: {
  name: string
  /** "Sat 24 Oct to Fri 30 Oct" */
  week: string
  /** The working window, "09:00 and 19:00" (office_settings). */
  hours: string
  rows: WeekOfficeRow[]
  reusedProof: string[]
  /** The week's leaderboard, or null when it could not be read. */
  board: BoardRow[] | null
  /** Problems met while building it, so none is silent. */
  problems: string[]
  reportsUrl: string
  boardUrl: string
  shortDayMinutes?: number | null
}): Email {
  const rows = i.rows.map((r) => ({ ...r, name: cleanName(r.name) }))
  const board = i.board?.map((r) => ({ ...r, name: cleanName(r.name) })) ?? null
  const reused = i.reusedProof.map((s) => cleanName(s, 160))
  const heading = (t: string, tone = INK) =>
    `    <p style="margin:24px 0 8px;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:${tone};font-weight:800;">${esc(t)}</p>\n`
  const list = (items: string[]) =>
    `    <ul style="margin:0 0 8px;padding-left:18px;">${items.map((s) => `<li style="margin:0 0 4px;">${esc(s)}</li>`).join('')}</ul>\n`

  const filed = rows.reduce((n, r) => n + r.onTime + r.late, 0)
  const due = rows.reduce((n, r) => n + r.onTime + r.late + r.notFiled, 0)
  const head = due ? `${filed} of ${due} reports filed this week.` : 'Nobody was due to report this week.'
  const withActivity = rows.some((r) => r.activity)
  const withShort = rows.some((r) => r.activity?.short !== undefined)
  const td = (s: string, style = '') => `<td style="padding:6px 10px 6px 0;border-top:1px solid ${RULE};font-size:14px;${style}">${esc(s)}</td>`
  const num = (n: number | undefined) => td(n === undefined ? '-' : String(n))
  const table = rows.length
    ? `    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-collapse:collapse;">
      <tr>${['', 'On time', 'Late', 'Not filed', ...(withActivity ? ['Active', 'Sign-outs', 'Missed check-ins'] : []), ...(withShort ? ['Short days'] : [])]
        .map((h) => `<td style="padding:0 10px 6px 0;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.06em;">${h}</td>`)
        .join('')}</tr>
${rows
  .map(
    (r) =>
      `      <tr>${td(r.name, 'font-weight:600;')}${td(String(r.onTime))}${td(String(r.late), r.late ? `color:${WARNING};` : '')}${td(String(r.notFiled), r.notFiled ? `color:${DANGER};font-weight:600;` : '')}${
        withActivity ? `${td(r.activity?.active ?? '-')}${num(r.activity?.signouts)}${num(r.activity?.missed)}` : ''
      }${withShort ? num(r.activity?.short) : ''}</tr>`,
  )
  .join('\n')}
    </table>\n`
    : ''
  const shortHours = i.shortDayMinutes ? `${Math.round((i.shortDayMinutes / 60) * 10) / 10} hours` : null
  const activityNote = withActivity
    ? `Active is time with input in the office between ${i.hours}, added up over the week. Sign-outs count those after 30 minutes away or with the office closed.${
        withShort && shortHours ? ` A short day is a signed-in day with under ${shortHours} of working time.` : ''
      } The day by day detail is in Reports.`
    : null
  const winner = board?.[0] && board[0].points > 0 ? board[0] : null
  const boardHead = !board ? null : winner ? `${winner.name} topped the leaderboard with ${winner.points} points.` : 'Nobody scored this week.'

  const html =
    p(`Hi ${esc(greetingName(i.name))},`) +
    p(`Here is the week at JustUsedTech, ${esc(i.week)}.`) +
    heading('Reports') +
    p(esc(head)) +
    table +
    (activityNote ? p(`<span style="color:${MUTED};font-size:13px;">${esc(activityNote)}</span>`) : '') +
    (reused.length ? heading(`Proof reused (${reused.length})`, WARNING) + list(reused) : '') +
    link(i.reportsUrl, 'Open Reports') +
    (board ? heading('Leaderboard') + p(esc(boardHead!)) + (board.length ? boardTable(board) : '') + link(i.boardUrl, 'Open the leaderboard') : '') +
    (i.problems.length ? heading(`Problems to look at (${i.problems.length})`, DANGER) + list(i.problems) : '')

  const activityText = (r: WeekOfficeRow) =>
    r.activity
      ? ` · active ${r.activity.active} · ${r.activity.signouts} ${r.activity.signouts === 1 ? 'sign-out' : 'sign-outs'} · ${r.activity.missed} missed ${r.activity.missed === 1 ? 'check-in' : 'check-ins'}${r.activity.short !== undefined ? ` · ${r.activity.short} short ${r.activity.short === 1 ? 'day' : 'days'}` : ''}`
      : ''
  return {
    // A fixed subject: names are self-edited, and this goes out from the office's address.
    subject: `JustUsedTech this week, ${i.week}`,
    html: shell(html),
    text: [
      `Hi ${greetingName(i.name)},`,
      '',
      `Here is the week at JustUsedTech, ${i.week}.`,
      '',
      'REPORTS',
      head,
      ...rows.map((r) => `${r.name}: on time ${r.onTime} · late ${r.late} · not filed ${r.notFiled}${activityText(r)}`),
      ...(activityNote ? ['', activityNote] : []),
      ...(reused.length ? ['', `Proof reused (${reused.length}):`, ...reused.map((s) => `  - ${s}`)] : []),
      '',
      `Open Reports: ${i.reportsUrl}`,
      ...(board ? ['', 'LEADERBOARD', boardHead!, ...boardText(board), '', `Open the leaderboard: ${i.boardUrl}`] : []),
      ...(i.problems.length ? ['', `Problems to look at (${i.problems.length}):`, ...i.problems.map((s) => `  - ${s}`)] : []),
    ].join('\n'),
  }
}

/** Someone knocked while you were not on the site. */
export function officeKnock(i: { recipientName: string; fromName: string; officeUrl: string }): Email {
  i = { ...i, fromName: cleanName(i.fromName) || 'Someone' }
  return {
    subject: `${i.fromName} is knocking on your office`,
    html: shell(
      p(`Hi ${esc(firstNameOf(i.recipientName))},`) +
        p(`<strong>${esc(i.fromName)}</strong> knocked on your office. The knock lapses after 10 minutes.`) +
        link(i.officeUrl, 'Open the office to answer'),
    ),
    text: [
      `Hi ${firstNameOf(i.recipientName)},`,
      '',
      `${i.fromName} knocked on your office. The knock lapses after 10 minutes.`,
      '',
      `Open the office to answer: ${i.officeUrl}`,
    ].join('\n'),
  }
}

export type TaskEmailKind = 'assigned' | 'done' | 'returned' | 'rated' | 'edited'

/**
 * A task step (0011), to the other person: a new task to the assignee, "done,
 * please check" to the giver, "sent back" to the assignee, and (0015) "edited"
 * to the assignee, with what changed and the task as it now reads. The title and the
 * note are typed by people, so both are cleaned like names (one line, cut short).
 */
export function officeTask(i: {
  kind: TaskEmailKind
  recipientName: string
  actorName: string
  title: string
  /** 'YYYY-MM-DD' or null. */
  dueOn: string | null
  note: string | null
  /** 'rated' (0012): the stars given, 1 to 5. */
  stars?: number | null
  /** 'done' (0013): how many images were handed in with it. */
  images?: number
  tasksUrl: string
}): Email {
  const actor = cleanName(i.actorName) || 'Someone'
  const title = cleanName(i.title, 120) || 'A task'
  const note = i.note ? cleanName(i.note, 300) : ''
  const due = i.dueOn
    ? new Date(`${i.dueOn}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    : ''
  const n = Math.min(5, Math.max(1, Math.round(i.stars ?? 0)))
  const lead =
    i.kind === 'assigned' ? `${actor} gave you a task${due ? `, due ${due}` : ''}:`
    : i.kind === 'done' ? `${actor} has finished a task you gave them. It is waiting for your check:`
    : i.kind === 'rated' ? `${actor} rated your task ${starLine(n)} (${n} of 5):`
    : i.kind === 'edited' ? `${actor} edited a task you were given${due ? `. It is due ${due}` : ''}. It now reads:`
    : `${actor} sent a task back to you:`
  const noteLabel =
    i.kind === 'returned' ? 'What still needs doing'
    : i.kind === 'rated' ? 'Their comment'
    : i.kind === 'edited' ? 'What changed'
    // 'assigned' has a note only when a task was moved (0015): "Moved from …", said as it is.
    : i.kind === 'assigned' ? ''
    : 'Their note'
  const subject =
    i.kind === 'assigned' ? `New task from ${actor}: ${title}`
    : i.kind === 'done' ? `Done, please check: ${title}`
    : i.kind === 'rated' ? `${n} of 5 stars: ${title}`
    : i.kind === 'edited' ? `Task edited: ${title}`
    : `Sent back: ${title}`
  const linkLabel = i.kind === 'done' ? 'Open Tasks to check it' : 'Open Tasks'
  const imagesLine = i.kind === 'done' && i.images ? `${i.images} ${i.images === 1 ? 'image' : 'images'} attached.` : ''
  return {
    subject: cleanName(subject, 150),
    html: shell(
      p(`Hi ${esc(firstNameOf(i.recipientName))},`) +
        p(esc(lead)) +
        p(`<strong>${esc(title)}</strong>`) +
        (note ? p(noteLabel ? `<span style="color:${MUTED};">${esc(noteLabel)}:</span> ${esc(note)}` : `<span style="color:${MUTED};">${esc(note)}</span>`) : '') +
        (imagesLine ? p(esc(imagesLine)) : '') +
        link(i.tasksUrl, linkLabel),
    ),
    text: [
      `Hi ${firstNameOf(i.recipientName)},`,
      '',
      lead,
      title,
      ...(note ? ['', noteLabel ? `${noteLabel}: ${note}` : note] : []),
      ...(imagesLine ? ['', imagesLine] : []),
      '',
      `${linkLabel}: ${i.tasksUrl}`,
    ].join('\n'),
  }
}


/** A button-like link for the one action in an account email. */
const action = (url: string, label: string) =>
  `    <p style="margin:6px 0 18px;"><a href="${esc(url)}" style="display:inline-block;background:${GREEN};color:#ffffff;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px;">${esc(label)}</a></p>`

/** "You're invited": the link sets a password and opens the office. */
export function officeInvite(i: { name: string; inviterName: string; link: string }): Email {
  const inviter = cleanName(i.inviterName) || 'Mr Tito'
  return {
    subject: `${inviter} invited you to the JustUsedTech office`,
    html: shell(
      p(`Hi ${esc(firstNameOf(i.name))},`) +
        p(`${esc(inviter)} has invited you to the JustUsedTech office: where the team sees who is in, knocks on doors and files the day’s three reports.`) +
        p('Choose a password to come in. The link works once, for one hour; if it has run out, ask Mr Tito to send it again.') +
        action(i.link, 'Choose a password') +
        p(`<span style="color:${MUTED};font-size:13px;">Not expecting this? You can ignore it; nothing happens unless you use the link.</span>`),
    ),
    text: [
      `Hi ${firstNameOf(i.name)},`,
      '',
      `${inviter} has invited you to the JustUsedTech office: where the team sees who is in, knocks on doors and files the day's three reports.`,
      '',
      'Choose a password to come in. The link works once, for one hour; if it has run out, ask Mr Tito to send it again:',
      i.link,
      '',
      'Not expecting this? You can ignore it; nothing happens unless you use the link.',
    ].join('\n'),
  }
}

/** "Set a new password": asked for on the sign-in page. */
export function officeRecovery(i: { name: string; link: string }): Email {
  return {
    subject: 'Your link to set a new password',
    html: shell(
      p(`Hi ${esc(firstNameOf(i.name))},`) +
        p('Someone asked to set a new password for your JustUsedTech office login. If it was you, use the link below. It works once, for one hour.') +
        action(i.link, 'Set a new password') +
        p(`<span style="color:${MUTED};font-size:13px;">Not you? Ignore this email; your password stays as it is.</span>`),
    ),
    text: [
      `Hi ${firstNameOf(i.name)},`,
      '',
      'Someone asked to set a new password for your JustUsedTech office login. If it was you, use this link. It works once, for one hour:',
      i.link,
      '',
      'Not you? Ignore this email; your password stays as it is.',
    ].join('\n'),
  }
}
