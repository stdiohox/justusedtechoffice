-- JustUsedTech office (ported from tito-crm), 0010: office improvements from the competitor research
-- (docs/virtual-office-competitor-research.md, sections 3 and 4).
--
-- APPLY AFTER 0005 (knocks), 0006 (doors), 0007 (photos) and 0008 (activity).
-- Checked at the start; a missing base stops the run before anything changes.
-- Steps: VIRTUAL-OFFICE-APPLY.md section 8.
--
-- ============================================================================
-- WHAT CHANGES
-- ============================================================================
--   1. Knocks      "Not now" can carry a short reply ("On a call"), shown to
--                  the knocker. One live outgoing knock at a time: a second
--                  door while the first is still knocking is refused.
--                  respond_knock() gains p_reply (default null), so screens
--                  from before this keep working unchanged.
--   2. Doors       A reason beside "back at" / "out until" ("Lunch"), or on
--                  its own as "back soon" for the day it was set.
--                  set_office_status() gains p_back_reason (default null).
--                  "Back soon" protects nothing: 0008's break protection
--                  still reads back_at only.
--   3. Onboarding  A new member's first steps, worked out from what already
--                  exists (photo, first sign-in, a door line, a knock) plus
--                  two things only the person can do here: answering the
--                  notifications question, and acknowledging the staff
--                  notice ("I've read how the office records my time").
--                  The notice text lives in the repo (src/lib/officeNotice.ts)
--                  with a version number; the database keeps who
--                  acknowledged which version, and when. Acknowledging is not
--                  consent: the lawful basis stays legitimate interest (NDPA
--                  s.25, OFFICE-FEATURES-PLAN.md 2.3).
--   4. Short day   office_settings.short_day_minutes (null = off): a day with
--                  a sign-in but less working time than this is marked
--                  "short" on the month view and, once enforcement is on, in
--                  Mr Tito's 18:30 summary. No flag and no separate email.
--
-- Nothing is tracked that was not already: every new column or table holds
-- something the person or Mr Tito chose to write.
--
-- WHO SEES WHAT
--   office_onboarding, office_notice_acks: the person, and Mr Tito. Written
--   only through the functions below (no write policies, writes revoked).
--   A knock's reply: the two people in the knock (0005's policy).
--   A door's reason: everyone in the office (0006's policy), like the door.
--
-- RETENTION
--   Acknowledgements are not pruned: they are the record that people were
--   told, kept while the person is in the office (removed with the person).
--   Onboarding steps are a handful of rows per person, kept the same way.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.knock(uuid)') is null
     or (to_regprocedure('public.respond_knock(uuid,boolean)') is null and to_regprocedure('public.respond_knock(uuid,boolean,text)') is null) then
    raise exception '0010 needs 0005 (knocks). Apply 0005 first.';
  end if;
  if to_regprocedure('public.set_office_status(text,time,date)') is null
     and to_regprocedure('public.set_office_status(text,time,date,text)') is null then
    raise exception '0010 needs 0006 (doors). Apply 0006 first.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'profiles' and column_name = 'avatar_path') then
    raise exception '0010 needs 0007 (profile photos). Apply 0007 first.';
  end if;
  if to_regprocedure('public.office_assert_member()') is null then
    raise exception '0010 needs 0008 (office activity). Apply 0008 first.';
  end if;
end $$;

-- One line of text someone else will read: control and direction-override
-- characters out (they could make a reply read differently from what was
-- typed), runs of space as one, trimmed; empty is null.
create or replace function public.office_clean_line(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(coalesce(p, ''), '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2066-\u2069]', '', 'g'),
           '\s+', ' ', 'g')), '')
$$;
revoke execute on function public.office_clean_line(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Knocks: a reply with "not now", one live knock at a time
-- ---------------------------------------------------------------------------
alter table public.office_knocks
  add column if not exists reply text
  constraint office_knocks_reply_check check (reply is null or char_length(reply) between 1 and 80);

-- 0005's knock(), with one rule added: a live knock on another door blocks a
-- new one. Everything else is as it was.
create or replace function public.knock(p_to uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or not public.is_office_member() or not public.office_signed_in_today() then
    raise exception 'You need to be in the office to knock.' using errcode = '42501';
  end if;
  if p_to = v_uid then
    raise exception 'That is your own office.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.office_members m join public.profiles u on u.id = m.user_id
     where m.user_id = p_to and m.active and u.deactivated_at is null
  ) then
    raise exception 'That person is not in the office.' using errcode = '22023';
  end if;
  -- Serialise one person's knocks, so parallel calls cannot slip past the caps.
  perform pg_advisory_xact_lock(hashtext('office_knock:' || v_uid::text));
  if (select count(*) from public.office_knocks
       where from_user = v_uid and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many knocks. Wait a few minutes.' using errcode = '22023';
  end if;
  if (select count(*) from public.office_knocks
       where from_user = v_uid and to_user = p_to and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'You have knocked on that door three times this hour. Try again later.' using errcode = '22023';
  end if;
  -- 0010: one door at a time.
  if exists (select 1 from public.office_knocks
              where from_user = v_uid and to_user <> p_to and status = 'pending' and expires_at > now()) then
    raise exception 'You are already knocking on another door. Cancel that knock first.' using errcode = '22023';
  end if;

  -- A lapsed knock no longer blocks a new one.
  update public.office_knocks set status = 'expired'
   where from_user = v_uid and to_user = p_to and status = 'pending' and expires_at <= now();

  begin
    insert into public.office_knocks (from_user, to_user) values (v_uid, p_to) returning id into v_id;
  exception when unique_violation then
    raise exception 'You are already knocking on that office.' using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- Dropped first: with both signatures present, PostgREST could not choose
-- between them for a two-argument call.
drop function if exists public.respond_knock(uuid, boolean);
create or replace function public.respond_knock(p_id uuid, p_accept boolean, p_reply text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reply text := public.office_clean_line(p_reply);
begin
  if not public.is_office_member() then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  if p_accept is null then
    raise exception 'Say yes or no.' using errcode = '22023';
  end if;
  if v_reply is not null and p_accept then
    raise exception 'A reply goes with "not now".' using errcode = '22023';
  end if;
  if v_reply is not null and char_length(v_reply) > 80 then
    raise exception 'Keep the reply to 80 characters.' using errcode = '22023';
  end if;
  update public.office_knocks
     set status = case when p_accept then 'accepted' else 'declined' end,
         responded_at = now(),
         reply = v_reply
   where id = p_id and to_user = auth.uid() and status = 'pending' and expires_at > now();
  if not found then
    raise exception 'That knock is no longer waiting.' using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.knock(uuid)                        from public, anon, authenticated;
revoke execute on function public.respond_knock(uuid, boolean, text) from public, anon, authenticated;
grant  execute on function public.knock(uuid)                        to authenticated;
grant  execute on function public.respond_knock(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Onboarding tables (before the door function, which writes one step)
-- ---------------------------------------------------------------------------
-- Steps the database cannot see for itself. 'door' is written by
-- set_office_status() (a cleared door deletes its row, so it cannot be worked
-- out later); 'notifications' by the person, once they have answered the
-- browser's question either way.
create table if not exists public.office_onboarding (
  user_id uuid not null references public.profiles(id) on delete cascade,
  task    text not null check (task in ('door', 'notifications')),
  done_at timestamptz not null default now(),
  primary key (user_id, task)
);

-- Who acknowledged which version of the staff notice, and when.
create table if not exists public.office_notice_acks (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  version  int  not null check (version between 1 and 1000),
  acked_at timestamptz not null default now(),
  primary key (user_id, version)
);

alter table public.office_onboarding  enable row level security;
alter table public.office_notice_acks enable row level security;

drop policy if exists "Own onboarding, or the manager" on public.office_onboarding;
create policy "Own onboarding, or the manager"
  on public.office_onboarding for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));
drop policy if exists "Own notice acknowledgements, or the manager" on public.office_notice_acks;
create policy "Own notice acknowledgements, or the manager"
  on public.office_notice_acks for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));

-- Read-only to the API: the functions below are the only writers.
revoke all on public.office_onboarding, public.office_notice_acks from anon, authenticated;
grant select on public.office_onboarding, public.office_notice_acks to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Doors: a reason beside "back at" / "out until", or "back soon"
-- ---------------------------------------------------------------------------
alter table public.office_status
  add column if not exists back_reason text
  constraint office_status_back_reason_check check (back_reason is null or char_length(back_reason) between 1 and 50);

-- Dropped first, as for respond_knock().
drop function if exists public.set_office_status(text, time, date);
create or replace function public.set_office_status(
  p_working_on  text,
  p_back_at     time,
  p_out_until   date,
  p_back_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date;
  v_line   text := nullif(btrim(regexp_replace(coalesce(p_working_on, ''), '\s+', ' ', 'g')), '');
  v_reason text := public.office_clean_line(p_back_reason);
begin
  if v_uid is null or not public.is_office_member()
     or not exists (select 1 from public.profiles where id = v_uid and deactivated_at is null) then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  v_today := public.office_today();
  if v_line is not null and char_length(v_line) > 120 then
    raise exception 'Keep it to 120 characters.' using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) > 50 then
    raise exception 'Keep the reason to 50 characters.' using errcode = '22023';
  end if;
  if p_out_until is not null and (p_out_until < v_today or p_out_until > v_today + 60) then
    raise exception 'Out until must be today or within the next 60 days.' using errcode = '22023';
  end if;

  -- All empty: clear the door.
  if v_line is null and p_back_at is null and p_out_until is null and v_reason is null then
    delete from public.office_status where user_id = v_uid;
    return;
  end if;

  insert into public.office_status (user_id, working_on, back_at, out_until, back_reason, set_on, updated_at)
  values (v_uid, v_line, p_back_at, p_out_until, v_reason, v_today, now())
  on conflict (user_id) do update
     set working_on  = excluded.working_on,
         back_at     = excluded.back_at,
         out_until   = excluded.out_until,
         back_reason = excluded.back_reason,
         set_on      = excluded.set_on,
         updated_at  = excluded.updated_at;

  -- Onboarding: they have written on their door at least once.
  insert into public.office_onboarding (user_id, task) values (v_uid, 'door') on conflict do nothing;
end;
$$;

revoke execute on function public.set_office_status(text, time, date, text) from public, anon, authenticated;
grant  execute on function public.set_office_status(text, time, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Onboarding: the steps, the notice, and Mr Tito's view of both
-- ---------------------------------------------------------------------------
create or replace function public.complete_onboarding_task(p_task text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.office_assert_member();
begin
  -- 'door' is the database's to record (set_office_status).
  if p_task is null or p_task <> 'notifications' then
    raise exception 'Unknown step.' using errcode = '22023';
  end if;
  insert into public.office_onboarding (user_id, task) values (v_uid, p_task) on conflict do nothing;
end;
$$;

create or replace function public.ack_office_notice(p_version int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.office_assert_member();
begin
  if p_version is null or p_version not between 1 and 1000 then
    raise exception 'Unknown notice version.' using errcode = '22023';
  end if;
  insert into public.office_notice_acks (user_id, version) values (v_uid, p_version) on conflict do nothing;
end;
$$;

-- One row per active member who files reports (not Mr Tito): which first
-- steps are done, and the latest notice version they acknowledged. Mr Tito
-- gets everyone; a member only themselves; anyone else nothing.
--
-- p_notice_version is the version the screens show (src/lib/officeNotice.ts):
-- notice_acked_at is when that exact version was acknowledged, so a row
-- recorded for some other version never counts for this one.
create or replace function public.office_onboarding_status(p_notice_version int)
returns table (
  user_id         uuid,
  photo           boolean,
  signin          boolean,
  door            boolean,
  knock           boolean,
  notifications   boolean,
  notice_version  integer,
  notice_acked_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.user_id,
         u.avatar_path is not null,
         exists (select 1 from public.office_reports r where r.user_id = m.user_id and r.kind = 'signin'),
         exists (select 1 from public.office_onboarding o where o.user_id = m.user_id and o.task = 'door')
           or exists (select 1 from public.office_status s where s.user_id = m.user_id),
         exists (select 1 from public.office_knocks k where k.from_user = m.user_id),
         exists (select 1 from public.office_onboarding o where o.user_id = m.user_id and o.task = 'notifications'),
         (select max(a.version) from public.office_notice_acks a where a.user_id = m.user_id),
         (select a.acked_at from public.office_notice_acks a where a.user_id = m.user_id and a.version = p_notice_version)
    from public.office_members m
    join public.profiles u on u.id = m.user_id
   where m.active and u.deactivated_at is null
     and m.user_id is distinct from (select s.manager_id from public.office_settings s where s.id = 1)
     -- Each (select ...) runs once per call, not once per row.
     and (select exists (select 1 from public.profiles c where c.id = auth.uid() and c.deactivated_at is null))
     and ((select public.is_office_manager()) or (m.user_id = (select auth.uid()) and (select public.is_office_member())))
   order by u.full_name
$$;

-- ---------------------------------------------------------------------------
-- 5. Short day
-- ---------------------------------------------------------------------------
alter table public.office_settings
  add column if not exists short_day_minutes int
  constraint office_settings_short_day_check check (short_day_minutes is null or short_day_minutes between 60 and 480);

-- Mr Tito only, from Settings. Null turns it off.
create or replace function public.set_short_day(p_minutes int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_office_manager()
     or not exists (select 1 from public.profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Only Mr Tito can change this.' using errcode = '42501';
  end if;
  if p_minutes is not null and p_minutes not between 60 and 480 then
    raise exception 'A short day is set between 1 and 8 hours.' using errcode = '22023';
  end if;
  update public.office_settings set short_day_minutes = p_minutes where id = 1;
end;
$$;

revoke execute on function public.complete_onboarding_task(text) from public, anon, authenticated;
revoke execute on function public.ack_office_notice(int)         from public, anon, authenticated;
revoke execute on function public.office_onboarding_status(int)  from public, anon, authenticated;
revoke execute on function public.set_short_day(int)             from public, anon, authenticated;
grant  execute on function public.complete_onboarding_task(text) to authenticated;
grant  execute on function public.ack_office_notice(int)         to authenticated;
grant  execute on function public.office_onboarding_status(int)  to authenticated;
grant  execute on function public.set_short_day(int)             to authenticated;

-- Self-check: the migration refuses to finish half-right.
do $$
begin
  if to_regprocedure('public.respond_knock(uuid,boolean,text)') is null
     or to_regprocedure('public.respond_knock(uuid,boolean)') is not null
     or to_regprocedure('public.set_office_status(text,time,date,text)') is null
     or to_regprocedure('public.set_office_status(text,time,date)') is not null
     or to_regprocedure('public.office_onboarding_status(integer)') is null
     or to_regprocedure('public.ack_office_notice(integer)') is null
     or to_regprocedure('public.complete_onboarding_task(text)') is null
     or to_regprocedure('public.set_short_day(integer)') is null
     or to_regclass('public.office_onboarding') is null
     or to_regclass('public.office_notice_acks') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'office_knocks' and column_name = 'reply')
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'office_status' and column_name = 'back_reason')
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'office_settings' and column_name = 'short_day_minutes')
     or not exists (select 1 from pg_proc where proname = 'knock' and pronamespace = 'public'::regnamespace
                     and prosrc like '%another door%') then
    raise exception '0010: something is missing.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('office_onboarding', 'office_notice_acks') and cmd <> 'SELECT') then
    raise exception '0010: these tables must have no write policy.';
  end if;
end $$;

-- The API's schema cache: the new signatures are visible at once.
notify pgrst, 'reload schema';

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand after applying.
-- ===========================================================================
-- -- V1. Each member's first steps and the notice version they acknowledged
-- --     (the SQL editor is nobody, so run as Mr Tito through the app, or:)
-- select u.full_name, o.task, o.done_at from public.office_onboarding o
--   join public.profiles u on u.id = o.user_id order by 1, 2;
-- select u.full_name, a.version, a.acked_at from public.office_notice_acks a
--   join public.profiles u on u.id = a.user_id order by 1, 2;
-- -- V2. Today's replies to knocks.
-- select k.created_at, k.status, k.reply from public.office_knocks k
--  where k.created_at > now() - interval '1 day' and k.reply is not null;
-- -- V3. The short-day setting.
-- select short_day_minutes from public.office_settings where id = 1;
