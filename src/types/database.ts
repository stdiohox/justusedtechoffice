/**
 * The office's tables, as the screens read them. Hand-written to match the
 * migrations in supabase/migrations (0001 to 0011).
 */

/** manager: Mr Tito. member: everyone else (0001). */
export type Role = 'manager' | 'member'

/** profiles (0001, 0007): one per person on the team. */
export interface Profile {
  id: string
  email: string
  full_name: string
  role: Role
  deactivated_at: string | null
  /** 0007: their photo in the private avatars bucket, or null. */
  avatar_path?: string | null
  created_at: string
}

/** invites (0001): an email waiting for its login. */
export interface Invite {
  email: string
  full_name: string
  role: Role
  invited_by: string | null
  created_at: string
}

/* ------------------------------------------------------------- office */

export type ReportKind = 'signin' | 'midday' | 'eod'
export type ReportTiming = 'on_time' | 'late'
export type OfficeFlagKind = 'missed' | 'late' | 'reused_proof'

/** Times are Postgres `time` values, 'HH:MM:SS', on the office's clock. */
export interface OfficeSettings {
  timezone: string
  /** ISO day numbers, 1 = Monday. */
  workdays: number[]
  signin_reminder: string
  signin_deadline: string
  midday_opens: string
  midday_deadline: string
  eod_opens: string
  eod_deadline: string
  proof_retention_days: number
  manager_id: string | null
  // 0008. Absent until it is applied.
  away_signout_minutes?: number
  checkin_every_minutes?: number
  checkin_answer_minutes?: number
  busy_max_minutes?: number
  outside_max_minutes?: number
  /** false: trial, recording only. true: sign-outs and missed check-ins act. */
  enforce_activity?: boolean
  /** 0010. Working minutes under which a signed-in day is "short"; null is off. Absent until applied. */
  short_day_minutes?: number | null
}

/** office_onboarding_status() (0010): one member's first steps. */
export interface OfficeOnboardingRow {
  user_id: string
  photo: boolean
  signin: boolean
  door: boolean
  knock: boolean
  notifications: boolean
  /** The latest staff-notice version they acknowledged, or null. */
  notice_version: number | null
  /** When they acknowledged the version asked about (the one on screen), or null. */
  notice_acked_at: string | null
}

/* ------------------------------------------------- office activity (0008) */

export type EntryLeftReason = 'idle' | 'gone' | 'eod' | 'left' | 'day_end'
export type CheckinKind = 'outside' | 'busy_end'

/** office_my_state(): the caller's own office state, on the server's clock. */
export interface OfficeMyState {
  /** The server's clock when this was read. */
  now: string
  enforce: boolean
  /** A report is due from this person today (they have stays). */
  expects: boolean
  signed_in: boolean
  /** In the office now (the gate). */
  in: boolean
  entry: {
    entered_at: string
    entered_by: 'signin' | 'back' | 'auto'
    left_at: string | null
    left_reason: EntryLeftReason | null
  } | null
  busy_until: string | null
  outside_until: string | null
  checkin: { id: string; kind: CheckinKind; issued_at: string; due_at: string } | null
}

export interface OfficeEntry {
  id: number
  user_id: string
  work_date: string
  entered_at: string
  entered_by: 'signin' | 'back' | 'auto'
  back_note: string | null
  left_at: string | null
  left_reason: EntryLeftReason | null
}

export interface OfficeDayNote {
  id: string
  user_id: string
  work_date: string
  body: string
  created_at: string
}

/** One row of office_time_summary() (0009): one person, one day. */
export interface OfficeTimeDay {
  user_id: string
  work_date: string
  expected: boolean
  active_min: number
  busy_min: number
  outside_min: number
  away_min: number
  signed_out_min: number
  offline_min: number
  extra_min: number
  checkins_answered: number
  checkins_missed: number
  signouts: number
  first_in: string | null
  last_seen: string | null
}

export interface OfficeMember {
  user_id: string
  active: boolean
  added_at: string
}

export interface OfficeReport {
  id: string
  user_id: string
  /** 'YYYY-MM-DD' on the office's clock. */
  work_date: string
  kind: ReportKind
  body: string | null
  link: string | null
  submitted_at: string
  timing: ReportTiming
}

export interface OfficeReportFile {
  id: string
  report_id: string
  user_id: string
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  sha256: string
  uploaded_at: string
  purged_at: string | null
}

export interface OfficeFlag {
  id: string
  user_id: string
  work_date: string
  kind: ReportKind
  flag: OfficeFlagKind
  detail: string | null
  raised_at: string
  resolved_at: string | null
  notified_at: string | null
}

/** What a person says on their door (0006). Written only by set_office_status(). */
export interface OfficeStatus {
  user_id: string
  working_on: string | null
  /** 'HH:MM:SS' on the office clock, for set_on only. */
  back_at: string | null
  /** 'YYYY-MM-DD', the last day out. */
  out_until: string | null
  /** The office day working_on and back_at belong to. */
  set_on: string
  updated_at: string
  /** 0010: "Lunch", "Errand"... beside back_at / out_until, or alone ("back soon"). */
  back_reason?: string | null
}

export interface OfficeAbsence {
  id: string
  /** null = the whole team (a public holiday). */
  user_id: string | null
  starts_on: string
  ends_on: string
  reason: string
}

export interface OfficeRosterDay {
  user_id: string
  work_date: string
  expected: boolean
  absence: string | null
}

/* ------------------------------------------------------------ tasks (0011) */

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'approved' | 'cancelled'
export type TaskEventKind = 'assigned' | 'started' | 'done' | 'approved' | 'returned' | 'cancelled' | 'rated'

/** office_tasks: one task one person gave another. Changed only through the 0011 functions. */
export interface OfficeTask {
  id: string
  title: string
  details: string | null
  assigned_by: string
  assigned_to: string
  /** The office's calendar date, 'YYYY-MM-DD', or null. */
  due_on: string | null
  status: TaskStatus
  done_note: string | null
  done_link: string | null
  done_at: string | null
  closed_at: string | null
  closed_by: string | null
  created_at: string
  updated_at: string
  /** 0012: 1 to 5 stars on an approved task, and the comment with them. Absent before it. */
  rating?: number | null
  rating_note?: string | null
  rated_by?: string | null
  rated_at?: string | null
}

/** office_task_files (0013): an image handed in as proof of a task. */
export interface OfficeTaskFile {
  id: string
  task_id: string
  uploaded_by: string | null
  /** Path inside the private task-proof bucket: <task id>/<uploader>/<file>. */
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  created_at: string
}

/** office_leaderboard() (0012, tasks and reports only): one person's week. */
export interface LeaderboardRow {
  user_id: string
  full_name: string
  tasks_done: number
  task_points: number
  ratings: number
  /** Average stars on the week's approved tasks, or null if none was rated. */
  avg_rating: number | null
  reports_on_time: number
  points: number
  starts_at: string
  ends_at: string
}

/** office_task_events: a task's history, one row per step. */
export interface OfficeTaskEvent {
  id: string
  task_id: string
  actor: string | null
  kind: TaskEventKind
  note: string | null
  created_at: string
}
