-- JustUsedTech office, 0012: star ratings on tasks, and the weekly leaderboard
-- (ported from Tito Finance's CRM, 0050 and 0051).
--
-- APPLY AFTER 0011. Safe before the frontend ships: nothing reads the new
-- columns or functions until it does; the Leaderboard and the stars stay
-- hidden until they exist. Not on a Friday after 17:00 if the frontend is not
-- deployed straight after (the first Friday email would be sent then).
--
-- RATINGS: 1 to 5 stars and an optional comment on an APPROVED task, by the
-- person who gave it or a task admin (0011), never by the person it was given
-- to. Changeable for 7 days, and final once the task's week has closed. Each
-- rating writes a 'rated' event, emailed to the assignee (once a day at most).
--
-- THE LEADERBOARD: Friday 17:00 to Friday 17:00, office time. Everyone earns
-- points the same two ways, whatever their job:
--   task approved        5 + its stars (3 if not rated), at most 80 a week
--   report filed on time 1 each
-- Any task counts, whoever gave it. Stars count in the week the task was
-- approved, if given before that week closed. Time in the office, sign-in
-- times and activity are NOT scored. On the board: everyone active except the
-- office manager (Mr Tito), who runs it; everyone on the team sees the whole
-- table. The Friday emails go from api/cron/office-alerts on the alerts clock
-- (0003): each person their week (the winner a "Top of the team" version), Mr
-- Tito and the admins the whole table.

begin;

-- ---------------------------------------------------------------------------
-- 1. Ratings
-- ---------------------------------------------------------------------------
alter table public.office_tasks
  add column if not exists rating      smallint check (rating between 1 and 5),
  add column if not exists rating_note text check (char_length(rating_note) <= 500),
  add column if not exists rated_by    uuid references public.profiles(id) on delete set null,
  add column if not exists rated_at    timestamptz;

alter table public.office_task_events drop constraint if exists office_task_events_kind_check;
alter table public.office_task_events add constraint office_task_events_kind_check
  check (kind in ('assigned', 'started', 'done', 'approved', 'returned', 'cancelled', 'rated'));

create or replace function public.rate_task(p_id uuid, p_stars int, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := public.office_task_actor();
  v_note text := public.office_task_text(p_note, 500, 'The comment');
  v_task public.office_tasks%rowtype;
begin
  if p_stars is null or p_stars not between 1 and 5 then
    raise exception 'Choose 1 to 5 stars.' using errcode = '22023';
  end if;
  select * into v_task from public.office_tasks where id = p_id for update;
  if not found or v_task.status <> 'approved' then
    raise exception 'Only an approved task can be rated.' using errcode = '22023';
  end if;
  if v_task.assigned_to = v_uid or not (v_task.assigned_by = v_uid or public.is_task_admin()) then
    raise exception 'Only the person who gave the task, or an admin, rates it.' using errcode = '42501';
  end if;
  if v_task.closed_at < now() - interval '7 days' then
    raise exception 'Ratings close 7 days after a task is approved.' using errcode = '22023';
  end if;
  if v_task.rating is not null
     and v_task.closed_at < (select w.starts_at from public.office_week_window(0) w) then
    raise exception 'That week has closed: its rating is final.' using errcode = '22023';
  end if;
  -- Saving the same rating again changes nothing, and emails nobody.
  if v_task.rating = p_stars and v_task.rating_note is not distinct from v_note then
    return null;
  end if;
  update public.office_tasks
     set rating = p_stars, rating_note = v_note, rated_by = v_uid, rated_at = now(), updated_at = now()
   where id = p_id;
  return public.office_task_event(p_id, 'rated', format('%s/5%s', p_stars, coalesce(': ' || v_note, '')));
end;
$$;

revoke execute on function public.rate_task(uuid, int, text) from public, anon, authenticated;
grant  execute on function public.rate_task(uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The week
-- ---------------------------------------------------------------------------
create or replace function public.office_week_window(p_weeks_ago int default 0)
returns table (starts_at timestamptz, ends_at timestamptz, closed boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz     text := (select timezone from public.office_settings where id = 1);
  v_local  timestamp := now() at time zone v_tz;
  v_anchor timestamp;
begin
  if v_tz is null then
    raise exception 'The office has no settings row (0002).' using errcode = '55000';
  end if;
  if p_weeks_ago is null or p_weeks_ago not between 0 and 52 then
    raise exception 'Weeks ago runs from 0 to 52.' using errcode = '22023';
  end if;
  -- The most recent Friday 17:00 at or before now, office time (ISO 5 = Friday).
  v_anchor := date_trunc('day', v_local)
              - make_interval(days => (extract(isodow from v_local)::int - 5 + 7) % 7)
              + time '17:00';
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

-- ---------------------------------------------------------------------------
-- 3. The board
-- ---------------------------------------------------------------------------
create or replace function public.office_leaderboard(p_weeks_ago int default 0)
returns table (
  user_id         uuid,
  full_name       text,
  tasks_done      int,
  task_points     int,
  ratings         int,
  avg_rating      numeric,
  reports_on_time int,
  points          int,
  starts_at       timestamptz,
  ends_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz;
  v_to   timestamptz;
begin
  if not public.is_team_member() and auth.role() is distinct from 'service_role' then
    raise exception 'You are not on the team.' using errcode = '42501';
  end if;
  select w.starts_at, w.ends_at into v_from, v_to from public.office_week_window(p_weeks_ago) w;

  return query
  with players as (
    select u.id, u.full_name from public.profiles u
     where u.deactivated_at is null
       and u.id is distinct from (select s.manager_id from public.office_settings s where s.id = 1)
  ),
  done as (
    -- A rating given after the week closed does not count in it.
    select t.assigned_to as uid,
           count(*)::int as n,
           sum(5 + case when t.rated_at < v_to then t.rating else 3 end)::int as pts,
           count(*) filter (where t.rated_at < v_to)::int as rated,
           round(avg(t.rating) filter (where t.rated_at < v_to), 1) as avg_rating
      from public.office_tasks t
     where t.status = 'approved' and t.closed_at >= v_from and t.closed_at < v_to
     group by 1
  ),
  filed as (
    select r.user_id as uid, count(*)::int as n
      from public.office_reports r
     where r.timing = 'on_time' and r.submitted_at >= v_from and r.submitted_at < v_to
     group by 1
  ),
  board as (
    select p.id, p.full_name,
           coalesce(d.n, 0)     as td,
           coalesce(d.pts, 0)   as tp,
           coalesce(d.rated, 0) as rc,
           d.avg_rating         as ar,
           coalesce(f.n, 0)     as rep
      from players p
      left join done d on d.uid = p.id
      left join filed f on f.uid = p.id
  )
  select b.id, b.full_name, b.td, b.tp, b.rc, b.ar, b.rep,
         (least(b.tp, 80) + b.rep)::int,
         v_from, v_to
    from board b
   order by 8 desc, 2;
end;
$$;

revoke execute on function public.office_leaderboard(int) from public, anon, authenticated;
grant  execute on function public.office_leaderboard(int) to authenticated, service_role;

revoke execute on function public.office_week_window(int) from public, anon, authenticated;
grant  execute on function public.office_week_window(int) to authenticated, service_role;

do $$
begin
  if to_regprocedure('public.rate_task(uuid, integer, text)') is null
     or to_regprocedure('public.office_week_window(integer)') is null
     or to_regprocedure('public.office_leaderboard(integer)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'office_tasks' and column_name = 'rating') then
    raise exception '0012: something is missing.';
  end if;
  if has_table_privilege('authenticated', 'public.office_tasks', 'insert, update, delete') then
    raise exception '0012: the browser can write tasks.';
  end if;
end $$;

commit;
