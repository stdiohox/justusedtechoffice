-- JustUsedTech office (ported from tito-crm), 0008: office activity (OFFICE-ACTIVITY-PLAN.md, migration A):
-- time-boxed do not disturb, "working away from the office" with "still there?"
-- check-ins, auto sign-out with "I'm back", day notes, and trial mode.
--
-- APPLY AFTER 0004 (office_presence, office_heartbeat) and 0006 (office_status,
-- for "back at"). Checked at the start; a missing base stops the run before
-- anything changes. Then apply 0009 (the time summary). Steps: VIRTUAL-OFFICE-APPLY.md section 7.
--
-- ============================================================================
-- TRIAL MODE (office_settings.enforce_activity, false by default)
-- ============================================================================
-- Everything is recorded from the moment this is applied: sign-outs (with
-- their reason), missed check-ins, "I'm back". Nothing acts on it until Mr
-- Tito turns enforcement on in Settings (set_office_enforcement()):
--
--                                   trial (default)        enforced
--   signed out after 30 min away    recorded; back in by   recorded; the office
--                                   itself on next input   refuses heartbeats
--                                                          until "I'm back"
--   end-of-day report filed         recorded as a sign-out same, "I'm back" to
--                                                          return
--   missed "still there?"           recorded; "outside     recorded; "outside
--                                   the office" carries on    the office" ends (away)
--   "Sign out of the office"        the person's choice:   same
--   (office_leave)                  "I'm back" to return
--
-- No flag and no separate email is raised for any of it: office_flags is
-- untouched. Mr Tito sees it in the time summary (0009), next to the
-- reports, and, once enforced, in his 18:30 summary email (the alerts route
-- reads 0009); in trial mode, not by email at all.
--
-- These apply to the time-boxes in both modes (they are the gap fixes, not
-- part of the trial):
--   do not disturb  30, 60 or 90 minutes (busy_max_minutes). A 'busy' beat
--                   past the box is recorded as 'away'. When it ends, a
--                   "still heads-down?" check-in offers 30 minutes more.
--   away from the office up to 2 hours (outside_max_minutes), then chosen again.
--                   An 'outside' beat past the box is recorded as 'away'.
--
-- ============================================================================
-- THE CLOCK
-- ============================================================================
-- Every time here is the database's: entries, check-ins, deadlines, boxes.
-- office_activity_sweep() runs every minute (pg_cron): it expires check-ins,
-- issues new ones, signs out whoever has been away 30 minutes or silent 30
-- minutes, and closes yesterday's entries. Closing the tab cannot escape it.
--
-- Entries (office_entries) exist only for people a report is due from that
-- day (office_expects_report): the first opens when the sign-in is filed. Mr
-- Tito, weekends and days away have none, and are never signed out.
--
-- A sign-out is skipped while the person has a "back at" time ahead (0006)
-- or passed it less than 15 minutes ago (a break). Nothing else protects
-- idle time: tito-crm also spared the 15 minutes after a WhatsApp draft or an
-- email sent from its CRM; this office has no CRM.
--
-- ============================================================================
-- ERROR CODES THE SCREENS RELY ON (not the wording, which may change)
-- ============================================================================
--   OFC01  no sign-in filed today: file it to enter the office
--   OFC02  signed out of the office: "I'm back" to come in again
-- Everything else keeps Postgres's own codes (42501 not allowed, 22023 bad
-- input).
--
-- ============================================================================
-- WHO SEES WHAT
-- ============================================================================
-- Entries, check-ins, modes and day notes: the person, and Mr Tito
-- (office_settings.manager_id). Nobody else. No write policies anywhere: the
-- functions below are the only writers, and inserts, updates and deletes are
-- also revoked from the API roles.
--
-- Kept as long as proof and presence (proof_retention_days, 90 days).

begin;

-- office_presence's check is swapped below (a brief exclusive lock): fail fast
-- rather than queue the app behind a long query. Just rerun if it times out.
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.office_heartbeat(text)') is null
     or to_regclass('public.office_presence') is null then
    raise exception '0008 needs 0004 (office presence). Apply 0004 first.';
  end if;
  if to_regclass('public.office_status') is null then
    raise exception '0008 needs 0006 (office_status, for "back at"). Apply 0006 first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.office_settings
  add column if not exists away_signout_minutes   int     not null default 30,
  add column if not exists checkin_every_minutes  int     not null default 30,
  add column if not exists checkin_answer_minutes int     not null default 5,
  add column if not exists busy_max_minutes       int     not null default 90,
  add column if not exists outside_max_minutes    int     not null default 120,
  add column if not exists enforce_activity       boolean not null default false;

alter table public.office_settings drop constraint if exists office_settings_activity_check;
alter table public.office_settings add constraint office_settings_activity_check check (
  away_signout_minutes between 10 and 240
  -- The check-in interval is jittered by up to 5 minutes either way.
  and checkin_every_minutes between 15 and 120
  and checkin_answer_minutes between 2 and 15
  and busy_max_minutes between 30 and 240
  and outside_max_minutes between 30 and 480
);

-- ---------------------------------------------------------------------------
-- 2. Presence learns 'outside'
-- ---------------------------------------------------------------------------
alter table public.office_presence drop constraint if exists office_presence_status_check;
alter table public.office_presence add constraint office_presence_status_check
  check (status in ('online', 'away', 'busy', 'outside'));

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
-- Each person's current mode. One row, created the first time the office
-- screens of this version load (office_my_state()). A row means the boxes
-- apply to 'busy' beats; a browser from before 0008 has none and beats as
-- it always did.
create table if not exists public.office_activity_state (
  user_id           uuid primary key references public.profiles(id) on delete cascade,
  busy_until        timestamptz,
  -- The busy_until a "still heads-down?" check-in was issued for (once per box).
  busy_prompted_for timestamptz,
  outside_until     timestamptz,
  next_checkin_at   timestamptz,
  updated_at        timestamptz not null default now(),
  check (busy_until is null or outside_until is null)
);

-- Each stay in the office. One open entry (left_at null) at most per person.
create table if not exists public.office_entries (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  work_date   date not null,
  entered_at  timestamptz not null default now(),
  -- signin: filing the sign-in; back: "I'm back"; auto: trial mode, back by
  -- input after an idle or silent sign-out.
  entered_by  text not null check (entered_by in ('signin', 'back', 'auto')),
  back_note   text check (back_note is null or char_length(back_note) between 1 and 200),
  left_at     timestamptz,
  -- idle: away 30 min; gone: no heartbeat 30 min; eod: end-of-day report
  -- filed; left: "Sign out of the office"; day_end: still open at midnight.
  left_reason text check (left_reason in ('idle', 'gone', 'eod', 'left', 'day_end')),
  check ((left_at is null) = (left_reason is null)),
  check (left_at is null or left_at >= entered_at)
);

create unique index if not exists office_entries_one_open on public.office_entries (user_id) where left_at is null;
create index if not exists office_entries_user_date_idx on public.office_entries (user_id, work_date);

create table if not exists public.office_checkins (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles(id) on delete cascade,
  -- outside: "still there?" while working away from the office;
  -- busy_end: "still heads-down?" when do not disturb runs out.
  kind      text not null check (kind in ('outside', 'busy_end')),
  issued_at timestamptz not null default now(),
  due_at    timestamptz not null,
  outcome   text not null default 'pending' check (outcome in ('pending', 'answered', 'missed', 'cancelled')),
  closed_at timestamptz,
  check ((outcome = 'pending') = (closed_at is null)),
  check (due_at > issued_at)
);

create unique index if not exists office_checkins_one_pending on public.office_checkins (user_id) where outcome = 'pending';
create index if not exists office_checkins_user_issued_idx on public.office_checkins (user_id, issued_at);

-- What a person adds to their own day ("11:10 to 12:00, on a call with the Q4
-- leads"). Shown beside the figures; it changes no number. Add-only.
create table if not exists public.office_day_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  work_date  date not null,
  body       text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);

create index if not exists office_day_notes_user_date_idx on public.office_day_notes (user_id, work_date);

alter table public.office_activity_state enable row level security;
alter table public.office_entries        enable row level security;
alter table public.office_checkins       enable row level security;
alter table public.office_day_notes      enable row level security;

drop policy if exists "Own activity state, or the manager" on public.office_activity_state;
create policy "Own activity state, or the manager"
  on public.office_activity_state for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));
drop policy if exists "Own entries, or the manager" on public.office_entries;
create policy "Own entries, or the manager"
  on public.office_entries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));
drop policy if exists "Own check-ins, or the manager" on public.office_checkins;
create policy "Own check-ins, or the manager"
  on public.office_checkins for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));
drop policy if exists "Own day notes, or the manager" on public.office_day_notes;
create policy "Own day notes, or the manager"
  on public.office_day_notes for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));

-- RLS already refuses writes (no write policies); TRUNCATE is not covered by
-- RLS, so the grants go too.
revoke insert, update, delete, truncate on public.office_activity_state, public.office_entries,
  public.office_checkins, public.office_day_notes from anon, authenticated;
revoke all on public.office_activity_state, public.office_entries,
  public.office_checkins, public.office_day_notes from anon;
revoke usage on sequence public.office_entries_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Helpers (not callable from the browser)
-- ---------------------------------------------------------------------------
-- The next "still there?", jittered so it cannot be pre-empted.
create or replace function public.office_next_checkin()
returns timestamptz
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select now()
       + make_interval(mins => (select checkin_every_minutes from public.office_settings where id = 1))
       + (random() * 10 - 5) * interval '1 minute'
$$;

-- Cancel whatever check-in is pending for this person (their mode changed).
create or replace function public.office_cancel_checkins(p_user uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.office_checkins
     set outcome = 'cancelled', closed_at = now()
   where user_id = p_user and outcome = 'pending'
$$;

-- Open a stay for this person today, if none is open. A stay left open from
-- an earlier day (a sign-in filed just after midnight, before the sweep) is
-- closed at that day's midnight first. Two tabs, a double click or the sweep
-- racing this all end with one open stay: the unique index decides, quietly.
create or replace function public.office_open_entry(p_user uuid, p_by text, p_note text, p_at timestamptz)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.office_entries
     set left_at = greatest(entered_at, least(now(),
                     (work_date + 1)::timestamp at time zone (select timezone from public.office_settings where id = 1))),
         left_reason = 'day_end'
   where user_id = p_user and left_at is null and work_date < public.office_today();
  insert into public.office_entries (user_id, work_date, entered_at, entered_by, back_note)
  values (p_user, public.office_today(), coalesce(p_at, now()), p_by, p_note)
  on conflict (user_id) where left_at is null do nothing;
$$;

-- Close this person's open stay, if any.
create or replace function public.office_close_entry(p_user uuid, p_reason text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.office_entries
     set left_at = greatest(now(), entered_at), left_reason = p_reason
   where user_id = p_user and left_at is null
$$;

revoke execute on function public.office_next_checkin()                              from public, anon, authenticated;
revoke execute on function public.office_cancel_checkins(uuid)                       from public, anon, authenticated;
revoke execute on function public.office_open_entry(uuid, text, text, timestamptz)    from public, anon, authenticated;
revoke execute on function public.office_close_entry(uuid, text)                     from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Filing the sign-in opens the day's first stay; filing end of day closes it
-- ---------------------------------------------------------------------------
create or replace function public.office_reports_entries()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.office_expects_report(NEW.user_id, NEW.work_date) or NEW.work_date <> public.office_today() then
    return NEW;
  end if;
  if NEW.kind = 'signin' then
    perform public.office_open_entry(NEW.user_id, 'signin', null, NEW.submitted_at);
  elsif NEW.kind = 'eod' then
    perform public.office_close_entry(NEW.user_id, 'eod');
  end if;
  return NEW;
end;
$$;

revoke execute on function public.office_reports_entries() from public, anon, authenticated;

drop trigger if exists office_reports_entries on public.office_reports;
create trigger office_reports_entries
  after insert on public.office_reports
  for each row execute function public.office_reports_entries();

-- Anyone who filed today's sign-in before this was applied is in already.
insert into public.office_entries (user_id, work_date, entered_at, entered_by)
select r.user_id, r.work_date, r.submitted_at, 'signin'
  from public.office_reports r
 where r.kind = 'signin'
   and r.work_date = public.office_today()
   and public.office_expects_report(r.user_id, r.work_date)
   and not exists (select 1 from public.office_reports e
                    where e.user_id = r.user_id and e.work_date = r.work_date and e.kind = 'eod')
   and not exists (select 1 from public.office_entries x where x.user_id = r.user_id and x.left_at is null);

-- ---------------------------------------------------------------------------
-- 6. The gate and the heartbeat
-- ---------------------------------------------------------------------------
-- In the office now? Trial mode keeps 0004's rule (sign-in filed) except
-- after the person's own "Sign out of the office"; enforced, an open stay is
-- needed too. Kept under its 0004 name for screens from before 0008.
create or replace function public.office_signed_in_today()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (
    select public.office_today() as d,
           (select enforce_activity from public.office_settings where id = 1) as enforce
  )
  select not public.office_expects_report(auth.uid(), t.d)
      or (exists (select 1 from public.office_reports
                   where user_id = auth.uid() and kind = 'signin' and work_date = t.d)
          and (exists (select 1 from public.office_entries where user_id = auth.uid() and left_at is null)
               or (not t.enforce
                   and coalesce((select e.left_reason from public.office_entries e
                                  where e.user_id = auth.uid() and e.work_date = t.d
                                  order by e.id desc limit 1), '') <> 'left')))
    from t
$$;

create or replace function public.office_heartbeat(p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_status  text := p_status;
  v_today   date;
  v_enforce boolean;
  v_last    public.office_presence%rowtype;
  v_state   public.office_activity_state%rowtype;
  v_left    text;
  v_busymax int;
  v_daystart timestamptz;
begin
  if v_uid is null or not public.is_office_member() then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('online', 'away', 'busy', 'outside') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  v_today := public.office_today();
  select enforce_activity, busy_max_minutes, v_today::timestamp at time zone timezone
    into v_enforce, v_busymax, v_daystart
    from public.office_settings where id = 1;

  if public.office_expects_report(v_uid, v_today) then
    if not exists (select 1 from public.office_reports
                    where user_id = v_uid and kind = 'signin' and work_date = v_today) then
      raise exception 'File your sign-in to enter the office.' using errcode = 'OFC01';
    end if;
    if not exists (select 1 from public.office_entries where user_id = v_uid and left_at is null) then
      select left_reason into v_left from public.office_entries
       where user_id = v_uid and work_date = v_today order by id desc limit 1;
      if v_enforce or v_left = 'left' then
        raise exception 'You are signed out of the office. Press "I''m back" to come in again.' using errcode = 'OFC02';
      end if;
      -- Trial: back by itself on input after an idle or silent sign-out.
      if v_status <> 'away' and v_left in ('idle', 'gone') then
        perform public.office_open_entry(v_uid, 'auto', null, null);
      end if;
    end if;
  end if;

  -- The boxes. A browser of this version always has a state row (made by
  -- office_my_state on load). One from before 0008 has none: its do not
  -- disturb is a plain toggle, so it is boxed here instead, at busy_max
  -- minutes a day in all.
  select * into v_state from public.office_activity_state where user_id = v_uid;
  if found then
    if v_status = 'busy' and not coalesce(v_state.busy_until > now(), false) then
      v_status := 'away';
    end if;
  elsif v_status = 'busy'
        and (select coalesce(sum(extract(epoch from p.last_seen_at - greatest(p.started_at, v_daystart))), 0)
               from public.office_presence p
              where p.user_id = v_uid and p.status = 'busy' and p.last_seen_at > v_daystart) >= v_busymax * 60 then
    v_status := 'away';
  end if;
  if v_status = 'outside' and not coalesce(v_state.outside_until > now(), false) then
    v_status := 'away';
  end if;

  -- From here on, 0004's record keeping, unchanged.
  -- Lock this person's latest stretch, so two tabs beating at once extend
  -- one row instead of starting two.
  select * into v_last from public.office_presence
   where user_id = v_uid order by started_at desc limit 1 for update;

  if found and v_last.last_seen_at > now() - interval '5 minutes' then
    if v_last.status = v_status then
      -- Throttled: a beat inside 20 s of the last one changes nothing.
      if v_last.last_seen_at < now() - interval '20 seconds' then
        update public.office_presence set last_seen_at = now() where id = v_last.id;
      end if;
      return;
    end if;
    -- A status that flipped within 20 s of starting rewrites that stretch
    -- instead of starting another.
    if v_last.started_at > now() - interval '20 seconds' then
      update public.office_presence set status = v_status, last_seen_at = now() where id = v_last.id;
      return;
    end if;
  end if;

  -- At most 300 stretches a day each: past that, extend the last one.
  if found and (select count(*) from public.office_presence
                 where user_id = v_uid and started_at > now() - interval '1 day') >= 300 then
    update public.office_presence set last_seen_at = now() where id = v_last.id;
    return;
  end if;

  insert into public.office_presence (user_id, status) values (v_uid, v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. What the screens call
-- ---------------------------------------------------------------------------
-- Caller must be in the office and not deactivated.
create or replace function public.office_assert_member()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_office_member()
     or not exists (select 1 from public.profiles where id = v_uid and deactivated_at is null) then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke execute on function public.office_assert_member() from public, anon, authenticated;

-- Everything the caller's own screens need, in one call, with the server's
-- clock (now) so the browser can correct its own. Creates the caller's state
-- row the first time, which is what makes the boxes apply to them.
create or replace function public.office_my_state()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := public.office_assert_member();
  v_today   date := public.office_today();
  v_s       public.office_settings%rowtype;
  v_state   public.office_activity_state%rowtype;
  v_entry   public.office_entries%rowtype;
  v_check   public.office_checkins%rowtype;
  v_expects boolean;
begin
  select * into v_s from public.office_settings where id = 1;
  insert into public.office_activity_state (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into v_state from public.office_activity_state where user_id = v_uid;
  select * into v_entry from public.office_entries
   where user_id = v_uid and work_date = v_today order by id desc limit 1;
  select * into v_check from public.office_checkins where user_id = v_uid and outcome = 'pending';
  v_expects := public.office_expects_report(v_uid, v_today);
  return jsonb_build_object(
    'now',           now(),
    'enforce',       v_s.enforce_activity,
    'expects',       v_expects,
    'signed_in',     exists (select 1 from public.office_reports
                              where user_id = v_uid and kind = 'signin' and work_date = v_today),
    'in',            public.office_signed_in_today(),
    'entry',         case when v_entry.id is null then null else jsonb_build_object(
                       'entered_at', v_entry.entered_at, 'entered_by', v_entry.entered_by,
                       'left_at', v_entry.left_at, 'left_reason', v_entry.left_reason) end,
    'busy_until',    case when v_state.busy_until > now() then v_state.busy_until end,
    'outside_until', case when v_state.outside_until > now() then v_state.outside_until end,
    'checkin',       case when v_check.id is null then null else jsonb_build_object(
                       'id', v_check.id, 'kind', v_check.kind,
                       'issued_at', v_check.issued_at, 'due_at', v_check.due_at) end
  );
end;
$$;

-- p_mode: 'busy' (p_minutes 30, 60 or 90, up to busy_max_minutes),
-- 'outside' (working away from the office, for outside_max_minutes), or 'none'.
create or replace function public.set_office_mode(p_mode text, p_minutes int default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.office_assert_member();
  v_s   public.office_settings%rowtype;
begin
  select * into v_s from public.office_settings where id = 1;
  if p_mode is null or p_mode not in ('busy', 'outside', 'none') then
    raise exception 'Unknown mode.' using errcode = '22023';
  end if;
  if p_mode <> 'none' and not public.office_signed_in_today() then
    raise exception 'Come into the office first.' using errcode = 'OFC02';
  end if;
  if p_mode = 'busy' and (p_minutes is null or p_minutes not in (30, 60, 90) or p_minutes > v_s.busy_max_minutes) then
    raise exception 'Do not disturb lasts 30, 60 or 90 minutes, up to % minutes.', v_s.busy_max_minutes using errcode = '22023';
  end if;

  insert into public.office_activity_state (user_id) values (v_uid) on conflict (user_id) do nothing;
  -- Choosing "outside" again changes nothing: it neither renews the box nor
  -- moves the next "still there?".
  if p_mode = 'outside' and exists (select 1 from public.office_activity_state
                                     where user_id = v_uid and outside_until > now()) then
    return public.office_my_state();
  end if;
  -- A choice made in the office shows the person is there: it answers a pending
  -- check-in (one past its deadline is left for the sweep to mark missed).
  update public.office_checkins set outcome = 'answered', closed_at = now()
   where user_id = v_uid and outcome = 'pending' and due_at >= now();
  update public.office_activity_state
     set busy_until        = case when p_mode = 'busy' then now() + make_interval(mins => p_minutes) end,
         busy_prompted_for = null,
         outside_until     = case when p_mode = 'outside' then now() + make_interval(mins => v_s.outside_max_minutes) end,
         next_checkin_at   = case when p_mode = 'outside' then public.office_next_checkin() end,
         updated_at        = now()
   where user_id = v_uid;
  return public.office_my_state();
end;
$$;

-- Answer a check-in before its deadline. p_continue: stay away from the office (or
-- keep do not disturb 30 minutes more); false ends that mode.
create or replace function public.answer_checkin(p_id uuid, p_continue boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.office_assert_member();
  v_c   public.office_checkins%rowtype;
begin
  select * into v_c from public.office_checkins where id = p_id and user_id = v_uid for update;
  if not found then
    raise exception 'No such check-in.' using errcode = '22023';
  end if;
  if v_c.outcome <> 'pending' or v_c.due_at < now() then
    raise exception 'Too late: that check-in has closed.' using errcode = '22023';
  end if;

  update public.office_checkins set outcome = 'answered', closed_at = now() where id = p_id;
  if v_c.kind = 'outside' then
    update public.office_activity_state
       set next_checkin_at = case when p_continue and outside_until > now() then public.office_next_checkin() end,
           outside_until   = case when p_continue then outside_until end,
           updated_at      = now()
     where user_id = v_uid;
  else
    update public.office_activity_state
       set busy_until = case when coalesce(p_continue, false) then
                          now() + make_interval(mins => least(30, (select busy_max_minutes from public.office_settings where id = 1)))
                        end,
           busy_prompted_for = null,
           updated_at = now()
     where user_id = v_uid;
  end if;
  return public.office_my_state();
end;
$$;

-- "I'm back": a new stay, after any sign-out. p_note is optional (200 chars).
create or replace function public.office_rejoin(p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := public.office_assert_member();
  v_today date := public.office_today();
  v_note  text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), '');
begin
  if not public.office_expects_report(v_uid, v_today) then
    return public.office_my_state();
  end if;
  if not exists (select 1 from public.office_reports where user_id = v_uid and kind = 'signin' and work_date = v_today) then
    raise exception 'File your sign-in to enter the office.' using errcode = 'OFC01';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'Keep the note to 200 characters.' using errcode = '22023';
  end if;
  perform public.office_open_entry(v_uid, 'back', v_note, null);
  return public.office_my_state();
end;
$$;

-- "Sign out of the office" (lunch, end of day). Ends any mode too.
create or replace function public.office_leave()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.office_assert_member();
begin
  perform public.office_close_entry(v_uid, 'left');
  perform public.office_cancel_checkins(v_uid);
  update public.office_activity_state
     set busy_until = null, busy_prompted_for = null, outside_until = null, next_checkin_at = null, updated_at = now()
   where user_id = v_uid;
  return public.office_my_state();
end;
$$;

-- A note on your own day: today or up to 13 days back, 20 a day at most.
create or replace function public.add_day_note(p_date date, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := public.office_assert_member();
  v_today date := public.office_today();
  v_body  text := nullif(btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')), '');
begin
  if p_date is null or p_date > v_today or p_date < v_today - 13 then
    raise exception 'Notes are for today or the last two weeks.' using errcode = '22023';
  end if;
  if v_body is null or char_length(v_body) > 300 then
    raise exception 'Write a note of up to 300 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.office_day_notes where user_id = v_uid and work_date = p_date) >= 20 then
    raise exception 'That day has 20 notes already.' using errcode = '22023';
  end if;
  insert into public.office_day_notes (user_id, work_date, body) values (v_uid, p_date, v_body);
end;
$$;

-- Trial or enforced: Mr Tito only, from Settings.
create or replace function public.set_office_enforcement(p_on boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_on is null then
    raise exception 'Say on or off.' using errcode = '22023';
  end if;
  if not public.is_office_manager()
     or not exists (select 1 from public.profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Only Mr Tito can change this.' using errcode = '42501';
  end if;
  update public.office_settings set enforce_activity = p_on where id = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. The sweep, every minute
-- ---------------------------------------------------------------------------
create or replace function public.office_activity_sweep()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s     public.office_settings%rowtype;
  v_today date;
  v_local time;
  r       record;
  v_last  public.office_presence%rowtype;
  v_id    bigint;
  v_seen  timestamptz;
begin
  select * into v_s from public.office_settings where id = 1;
  if not found then
    return;
  end if;
  v_today := public.office_today();
  v_local := (now() at time zone v_s.timezone)::time;

  -- 1. Yesterday's stays that nobody closed end at that day's midnight.
  update public.office_entries
     set left_at = greatest(entered_at, least(now(), (work_date + 1)::timestamp at time zone v_s.timezone)),
         left_reason = 'day_end'
   where left_at is null and work_date < v_today;

  -- 2. Check-ins past their deadline are missed. Enforced, a missed
  --    "still there?" ends working away from the office; in trial it carries on.
  for r in
    update public.office_checkins
       set outcome = 'missed', closed_at = now()
     where outcome = 'pending' and due_at < now()
    returning user_id, kind
  loop
    if r.kind = 'outside' then
      update public.office_activity_state
         set outside_until   = case when v_s.enforce_activity then null else outside_until end,
             next_checkin_at = case when v_s.enforce_activity or not coalesce(outside_until > now(), false) then null
                                    else public.office_next_checkin() end,
             updated_at      = now()
       where user_id = r.user_id;
    end if;
  end loop;

  -- 3. Do not disturb that just ran out: one "still heads-down?" per box.
  for r in
    select st.user_id, st.busy_until
      from public.office_activity_state st
      join public.office_members m on m.user_id = st.user_id and m.active
      join public.profiles u on u.id = st.user_id and u.deactivated_at is null
     where st.busy_until <= now()
       and st.busy_until > now() - interval '15 minutes'
       and st.busy_prompted_for is distinct from st.busy_until
       and not exists (select 1 from public.office_checkins c where c.user_id = st.user_id and c.outcome = 'pending')
     -- A row someone is changing right now (a new mode) is left for next minute.
     for update of st skip locked
  loop
    insert into public.office_checkins (user_id, kind, due_at)
    values (r.user_id, 'busy_end', now() + make_interval(mins => v_s.checkin_answer_minutes));
    update public.office_activity_state set busy_prompted_for = r.busy_until, updated_at = now()
     where user_id = r.user_id;
  end loop;

  -- 4. "Still there?" for those working away from the office. Someone who worked
  --    in the office in the last 15 minutes (a logged action), or whose tab
  --    reports input right now, has shown they are there: later.
  update public.office_activity_state
     set next_checkin_at = null, updated_at = now()
   where outside_until <= now() and next_checkin_at is not null;
  for r in
    select st.user_id
      from public.office_activity_state st
      join public.office_members m on m.user_id = st.user_id and m.active
      join public.profiles u on u.id = st.user_id and u.deactivated_at is null
     where st.outside_until > now()
       and st.next_checkin_at <= now()
       and not exists (select 1 from public.office_checkins c where c.user_id = st.user_id and c.outcome = 'pending')
     for update of st skip locked
  loop
    if exists (select 1 from public.office_presence p
                   where p.user_id = r.user_id and p.status = 'online'
                     and p.last_seen_at > now() - interval '3 minutes') then
      update public.office_activity_state set next_checkin_at = now() + interval '15 minutes', updated_at = now()
       where user_id = r.user_id;
    else
      insert into public.office_checkins (user_id, kind, due_at)
      values (r.user_id, 'outside', now() + make_interval(mins => v_s.checkin_answer_minutes));
      update public.office_activity_state set next_checkin_at = null, updated_at = now()
       where user_id = r.user_id;
    end if;
  end loop;

  -- 5. Sign-outs: away 30 minutes, or no heartbeat for 30 minutes.
  --    The latest stretch is locked (skipping anyone whose heartbeat is
  --    landing right now), so a beat cannot slip in between the look and
  --    the sign-out.
  for r in
    select e.id, e.user_id, e.entered_at
      from public.office_entries e
     where e.left_at is null and e.work_date = v_today
  loop
    -- A break: "back at" still ahead, or passed under 15 minutes ago.
    if exists (select 1 from public.office_status s
                where s.user_id = r.user_id and s.set_on = v_today and s.back_at is not null
                  and v_local < s.back_at + interval '15 minutes') then
      continue;
    end if;
    v_last := null;
    v_id := (select p.id from public.office_presence p
              where p.user_id = r.user_id order by p.started_at desc limit 1);
    if v_id is not null then
      select * into v_last from public.office_presence where id = v_id for update skip locked;
      if not found then
        continue;
      end if;
    end if;
    v_seen := greatest(coalesce(v_last.last_seen_at, r.entered_at), r.entered_at);

    if v_seen <= now() - make_interval(mins => v_s.away_signout_minutes) then
      -- No heartbeat at all: the office is closed. Nothing protects that.
      perform public.office_close_entry(r.user_id, 'gone');
    elsif v_last.id is not null and v_last.status = 'away'
          and greatest(v_last.started_at, r.entered_at) <= now() - make_interval(mins => v_s.away_signout_minutes) then
      perform public.office_close_entry(r.user_id, 'idle');
    else
      continue;
    end if;

    -- Enforced, a sign-out also ends any mode. In trial the mode stays, so
    -- the person comes back by themselves exactly as they left.
    if v_s.enforce_activity then
      perform public.office_cancel_checkins(r.user_id);
      update public.office_activity_state
         set busy_until = null, busy_prompted_for = null, outside_until = null, next_checkin_at = null, updated_at = now()
       where user_id = r.user_id;
    end if;
  end loop;
end;
$$;

revoke execute on function public.office_activity_sweep() from public, anon, authenticated;

revoke execute on function public.office_signed_in_today()        from public, anon, authenticated;
revoke execute on function public.office_heartbeat(text)          from public, anon, authenticated;
revoke execute on function public.office_my_state()               from public, anon, authenticated;
revoke execute on function public.set_office_mode(text, int)      from public, anon, authenticated;
revoke execute on function public.answer_checkin(uuid, boolean)   from public, anon, authenticated;
revoke execute on function public.office_rejoin(text)             from public, anon, authenticated;
revoke execute on function public.office_leave()                  from public, anon, authenticated;
revoke execute on function public.add_day_note(date, text)        from public, anon, authenticated;
revoke execute on function public.set_office_enforcement(boolean) from public, anon, authenticated;
grant  execute on function public.office_signed_in_today()        to authenticated;
grant  execute on function public.office_heartbeat(text)          to authenticated;
grant  execute on function public.office_my_state()               to authenticated;
grant  execute on function public.set_office_mode(text, int)      to authenticated;
grant  execute on function public.answer_checkin(uuid, boolean)   to authenticated;
grant  execute on function public.office_rejoin(text)             to authenticated;
grant  execute on function public.office_leave()                  to authenticated;
grant  execute on function public.add_day_note(date, text)        to authenticated;
grant  execute on function public.set_office_enforcement(boolean) to authenticated;

-- TO STOP IT: select cron.unschedule('office-activity-sweep');
select cron.schedule('office-activity-sweep', '* * * * *', $job$select public.office_activity_sweep()$job$);

-- Retention: the same days as proof and presence.
-- TO STOP IT: select cron.unschedule('office-activity-prune');
-- The sweep's own run log (1,440 rows a day) is kept a week.
select cron.schedule('office-activity-prune', '27 3 * * *', $job$
  delete from public.office_entries
   where work_date < (now() - make_interval(days => (select proof_retention_days from public.office_settings where id = 1)))::date;
  delete from public.office_checkins
   where issued_at < now() - make_interval(days => (select proof_retention_days from public.office_settings where id = 1));
  delete from public.office_day_notes
   where work_date < (now() - make_interval(days => (select proof_retention_days from public.office_settings where id = 1)))::date;
  delete from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'office-activity-sweep')
     and end_time < now() - interval '7 days';
$job$);

-- The person's own check-ins reach their screen as they are issued (RLS
-- applies to Realtime: nobody else is sent them, Mr Tito aside).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_checkins') then
    alter publication supabase_realtime add table public.office_checkins;
  end if;
end $$;

-- Self-check: the migration refuses to finish half-right.
do $$
begin
  if to_regclass('public.office_activity_state') is null
     or to_regclass('public.office_entries') is null
     or to_regclass('public.office_checkins') is null
     or to_regclass('public.office_day_notes') is null
     or to_regprocedure('public.office_my_state()') is null
     or to_regprocedure('public.office_activity_sweep()') is null
     or not exists (select 1 from cron.job where jobname = 'office-activity-sweep')
     or not exists (select 1 from pg_trigger where tgname = 'office_reports_entries' and not tgisinternal) then
    raise exception '0008: something is missing.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('office_activity_state', 'office_entries', 'office_checkins', 'office_day_notes')
              and cmd <> 'SELECT') then
    raise exception '0008: these tables must have no write policy.';
  end if;
  if (select enforce_activity from public.office_settings where id = 1) then
    raise exception '0008: trial mode must be the default.';
  end if;
end $$;

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand after applying.
-- ===========================================================================
-- -- V1. Trial or enforced, and the timings.
-- select enforce_activity, away_signout_minutes, checkin_every_minutes, checkin_answer_minutes,
--        busy_max_minutes, outside_max_minutes from public.office_settings;
-- -- V2. Today's stays.
-- select u.full_name, e.entered_at, e.entered_by, e.left_at, e.left_reason, e.back_note
--   from public.office_entries e join public.profiles u on u.id = e.user_id
--  where e.work_date = public.office_today() order by e.entered_at;
-- -- V3. Today's check-ins.
-- select u.full_name, c.kind, c.issued_at, c.due_at, c.outcome, c.closed_at
--   from public.office_checkins c join public.profiles u on u.id = c.user_id
--  where c.issued_at > now() - interval '1 day' order by c.issued_at;
-- -- V4. The sweep runs every minute without errors.
-- select start_time, status, return_message from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'office-activity-sweep')
--  order by start_time desc limit 5;
