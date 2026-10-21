-- JustUsedTech office, 0014: the day's new times, and work started before sign-in.
--
-- APPLY AFTER 0013, then deploy straight after (the screens read the new
-- times from office_settings; the early-start box appears once this is in).
-- Not on a Friday between 17:00 and 19:00 before the deploy: the week's close
-- moves from 17:00 to 19:00 (section 3).
--
-- 1. THE DAY (asked 2026-10-21): sign-in at 11:00 (on time until 11:15),
--    midday report 15:00 to 16:00, end-of-day report from 19:00 (on time until
--    20:30). Mr Tito's daily summary goes after 20:30, the time figures cover
--    11:00 to 20:30, and reminders follow (they all read these settings).
--
-- 2. WORK STARTED BEFORE SIGN-IN: the office records nothing before the
--    sign-in report is filed (0008's gate), on purpose. Someone who began
--    earlier says so: declare_day_start(time, note), for today only, a time
--    before the official start and before now. Mr Tito sees it beside their
--    day as said by them, with the evidence the office already has: the time
--    of their first task step, knock or chat message that day. Nothing new is
--    tracked; the staff notice (v4) says so.
--
-- 3. THE LEADERBOARD WEEK closes on Friday when the end-of-day report opens
--    (office_settings.eod_opens, 19:00 here), not at a fixed 17:00.

begin;

-- ---------------------------------------------------------------------------
-- 1. The day's times
-- ---------------------------------------------------------------------------
update public.office_settings
   set signin_reminder = '11:00',
       signin_deadline = '11:15',
       midday_opens    = '15:00',
       midday_deadline = '16:00',
       eod_opens       = '19:00',
       eod_deadline    = '20:30'
 where id = 1;

-- ---------------------------------------------------------------------------
-- 2. Work started before sign-in
-- ---------------------------------------------------------------------------
create table if not exists public.office_day_starts (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  work_date   date not null,
  -- When they say they began, on the office's clock.
  started_at  timestamptz not null,
  note        text check (char_length(note) <= 300),
  declared_at timestamptz not null default now(),
  primary key (user_id, work_date)
);

alter table public.office_day_starts enable row level security;
revoke all on public.office_day_starts from anon, authenticated;
grant select on public.office_day_starts to authenticated;

drop policy if exists "Own day starts, or the manager" on public.office_day_starts;
create policy "Own day starts, or the manager"
  on public.office_day_starts for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));

-- Today only; a time before the official start and before now; null clears it.
create or replace function public.declare_day_start(p_time time, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  s       public.office_settings%rowtype;
  v_today date;
  v_at    timestamptz;
  v_note  text := nullif(btrim(p_note), '');
begin
  if v_uid is null or not public.is_office_member() then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  select * into s from public.office_settings where id = 1;
  v_today := (now() at time zone s.timezone)::date;
  if p_time is null then
    delete from public.office_day_starts where user_id = v_uid and work_date = v_today;
    return;
  end if;
  if char_length(v_note) > 300 then
    raise exception 'Keep the note to 300 characters.' using errcode = '22023';
  end if;
  if p_time < time '04:00' then
    raise exception 'A start before 04:00 is not a working start.' using errcode = '22023';
  end if;
  if p_time >= s.signin_reminder then
    raise exception 'That is not before the start of the day (%).', to_char(s.signin_reminder, 'HH24:MI') using errcode = '22023';
  end if;
  v_at := (v_today + p_time) at time zone s.timezone;
  if v_at > now() then
    raise exception 'That time has not come yet.' using errcode = '22023';
  end if;
  insert into public.office_day_starts (user_id, work_date, started_at, note)
  values (v_uid, v_today, v_at, v_note)
  on conflict (user_id, work_date) do update
    set started_at = excluded.started_at, note = excluded.note, declared_at = now();
end;
$$;

-- What was said, beside the evidence: the first task step, knock or chat
-- message by that person that day. Mr Tito (and the alerts route): everyone
-- in the office but himself; anyone else: themselves. Up to 63 days.
create or replace function public.office_day_starts_range(p_from date, p_to date)
returns table (user_id uuid, work_date date, started_at timestamptz, note text, first_work_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_mgr boolean := auth.role() is not distinct from 'service_role' or public.is_office_manager();
  s     public.office_settings%rowtype;
begin
  if not v_mgr and (v_uid is null or not public.is_office_member()) then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Pick a range of up to 63 days.' using errcode = '22023';
  end if;
  select * into s from public.office_settings where id = 1;

  return query
  with people as (
    select m.user_id from public.office_members m
     where case when v_mgr then m.user_id is distinct from s.manager_id else m.user_id = v_uid end
  ),
  days as (
    select p.user_id, d::date as work_date,
           (d::date)::timestamp at time zone s.timezone       as d_start,
           ((d::date + 1)::timestamp) at time zone s.timezone as d_end
      from people p
      cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  )
  select d.user_id, d.work_date, ds.started_at, ds.note,
         least(
           (select min(e.created_at) from public.office_task_events e
             where e.actor = d.user_id and e.created_at >= d.d_start and e.created_at < d.d_end),
           (select min(k.created_at) from public.office_knocks k
             where k.from_user = d.user_id and k.created_at >= d.d_start and k.created_at < d.d_end),
           (select min(c.created_at) from public.office_chat_messages c
             where c.sender = d.user_id and c.created_at >= d.d_start and c.created_at < d.d_end)
         )
    from days d
    left join public.office_day_starts ds on ds.user_id = d.user_id and ds.work_date = d.work_date
   where ds.user_id is not null
      or exists (select 1 from public.office_task_events e
                  where e.actor = d.user_id and e.created_at >= d.d_start and e.created_at < d.d_end)
      or exists (select 1 from public.office_knocks k
                  where k.from_user = d.user_id and k.created_at >= d.d_start and k.created_at < d.d_end)
      or exists (select 1 from public.office_chat_messages c
                  where c.sender = d.user_id and c.created_at >= d.d_start and c.created_at < d.d_end)
   order by d.work_date, d.user_id;
end;
$$;

revoke execute on function public.declare_day_start(time, text) from public, anon, authenticated;
revoke execute on function public.office_day_starts_range(date, date) from public, anon, authenticated;
grant  execute on function public.declare_day_start(time, text) to authenticated;
grant  execute on function public.office_day_starts_range(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The leaderboard week closes when the end-of-day report opens
-- ---------------------------------------------------------------------------
create or replace function public.office_week_window(p_weeks_ago int default 0)
returns table (starts_at timestamptz, ends_at timestamptz, closed boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz     text;
  v_close  time;
  v_local  timestamp;
  v_anchor timestamp;
begin
  select s.timezone, s.eod_opens into v_tz, v_close from public.office_settings s where s.id = 1;
  if v_tz is null then
    raise exception 'The office has no settings row (0002).' using errcode = '55000';
  end if;
  if p_weeks_ago is null or p_weeks_ago not between 0 and 52 then
    raise exception 'Weeks ago runs from 0 to 52.' using errcode = '22023';
  end if;
  v_local := now() at time zone v_tz;
  -- The most recent Friday at the end-of-day time, at or before now (ISO 5 = Friday).
  v_anchor := date_trunc('day', v_local)
              - make_interval(days => (extract(isodow from v_local)::int - 5 + 7) % 7)
              + v_close;
  if v_anchor > v_local then
    v_anchor := v_anchor - interval '7 days';
  end if;
  starts_at := (v_anchor - make_interval(days => 7 * p_weeks_ago)) at time zone v_tz;
  ends_at   := case when p_weeks_ago = 0 then now()
                    else (v_anchor - make_interval(days => 7 * (p_weeks_ago - 1))) at time zone v_tz end;
  closed    := p_weeks_ago > 0;
  return next;
end;
$$;

do $$
begin
  if not exists (select 1 from public.office_settings
                  where id = 1 and signin_reminder = '11:00' and eod_deadline = '20:30')
     or to_regclass('public.office_day_starts') is null
     or to_regprocedure('public.declare_day_start(time without time zone, text)') is null
     or to_regprocedure('public.office_day_starts_range(date, date)') is null then
    raise exception '0014: something is missing.';
  end if;
  if has_table_privilege('authenticated', 'public.office_day_starts', 'insert, update, delete') then
    raise exception '0014: the browser can write day starts directly.';
  end if;
end $$;

commit;
