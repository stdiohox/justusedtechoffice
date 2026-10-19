-- JustUsedTech office (ported from tito-crm), 0009: active minutes per person per day, worked out on the
-- server (OFFICE-ACTIVITY-PLAN.md section 4, migration B).
--
-- APPLY AFTER 0008. Additive only: two functions. Nothing is stored; every
-- figure is computed from rows whose times the database set itself
-- (office_presence, office_entries, office_checkins), so the
-- browser receives finished minutes and adds nothing up.
--
-- ============================================================================
-- THE FIGURES, per person per day
-- ============================================================================
-- Counted inside the working window, office_settings.signin_reminder to
-- eod_deadline (09:00 to 18:30 Lagos), and never past now:
--   active        heartbeat 'online' (input in an office tab)
--   busy          'busy' inside its box (0008 records it as away past it)
--   outside       'outside' inside its box, except after a missed "still
--                 there?" until the person next answers one or is active in
--                 the office: that stretch counts as away, whatever the browser
--                 said
--   away          'away', plus the doubted 'outside' above
--   signed_out    from the day's first entry on, time not inside an entry and
--                 not working (signed out but still working counts as work)
--   offline       the rest of the window: no record at all. Only on days a
--                 report is due; 0 on weekends and days away.
--   extra         working minutes (active, busy, outside) outside the window
-- Beside them:
--   checkins_answered, checkins_missed   issued that day
--   signouts           entries closed as idle or gone that day
--   first_in, last_seen   the day's first and last heartbeat
--
-- A heartbeat every 2 minutes and 0004's 5-minute merge make each figure good
-- to about 2 minutes. The screens round to 5. A stretch is looked for up to 7
-- days before the day it touches (the index can then stop early); a single
-- unbroken stretch longer than that (a tab left open for a week) is cut off.
--
-- WHO: Mr Tito, every office member but himself. Anyone else in the office:
-- only themselves. The alerts route (service role) gets what Mr Tito gets,
-- for his 18:30 summary once enforcement is on, like office_roster(). Up to
-- 63 days per call.

begin;

do $$
begin
  if to_regclass('public.office_entries') is null or to_regclass('public.office_checkins') is null then
    raise exception '0009 needs 0008 (office entries and check-ins). Apply 0008 first.';
  end if;
end $$;

-- Minutes in a multirange, which must be bounded.
create or replace function public.office_minutes(p tstzmultirange)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(round(sum(extract(epoch from upper(r) - lower(r))) / 60)::int, 0)
    from unnest(p) r
$$;

revoke execute on function public.office_minutes(tstzmultirange) from public, anon, authenticated;

create or replace function public.office_time_summary(p_from date, p_to date)
returns table (
  user_id           uuid,
  work_date         date,
  expected          boolean,
  active_min        integer,
  busy_min          integer,
  outside_min       integer,
  away_min          integer,
  signed_out_min    integer,
  offline_min       integer,
  extra_min         integer,
  checkins_answered integer,
  checkins_missed   integer,
  signouts          integer,
  first_in          timestamptz,
  last_seen         timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
-- The output columns share names with table columns; every reference below
-- is qualified, and this makes any slip resolve to the column.
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_svc boolean := auth.role() is not distinct from 'service_role';
  v_mgr boolean;
  s     public.office_settings%rowtype;
begin
  if not v_svc and (v_uid is null or not public.is_office_member()
     or not exists (select 1 from public.profiles where id = v_uid and deactivated_at is null)) then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Pick a range of up to 63 days.' using errcode = '22023';
  end if;
  v_mgr := v_svc or public.is_office_manager();
  select * into s from public.office_settings where id = 1;

  return query
  with people as (
    select m.user_id from public.office_members m
     where case when v_mgr then m.user_id is distinct from s.manager_id else m.user_id = v_uid end
  ),
  days as (
    select p.user_id,
           d::date                                                                   as work_date,
           public.office_expects_report(p.user_id, d::date)                          as expected,
           (d::date)::timestamp at time zone s.timezone                              as d_start,
           least(((d::date + 1)::timestamp at time zone s.timezone), now())          as d_end,
           (d::date + s.signin_reminder) at time zone s.timezone                     as w_start,
           least((d::date + s.eod_deadline) at time zone s.timezone, now())          as w_end
      from people p
      cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
     -- Days that have not started have nothing to say.
     where (d::date)::timestamp at time zone s.timezone < now()
  ),
  raw as (
    select d.*,
      (select coalesce(range_agg(tstzrange(greatest(x.started_at, d.d_start), least(x.last_seen_at, d.d_end))), '{}')
         from public.office_presence x
        where x.user_id = d.user_id and x.status = 'online' and x.started_at < d.d_end and x.last_seen_at > d.d_start
          and x.started_at > d.d_start - interval '7 days') as online_mr,
      (select coalesce(range_agg(tstzrange(greatest(x.started_at, d.d_start), least(x.last_seen_at, d.d_end))), '{}')
         from public.office_presence x
        where x.user_id = d.user_id and x.status = 'busy' and x.started_at < d.d_end and x.last_seen_at > d.d_start
          and x.started_at > d.d_start - interval '7 days') as busy_mr,
      (select coalesce(range_agg(tstzrange(greatest(x.started_at, d.d_start), least(x.last_seen_at, d.d_end))), '{}')
         from public.office_presence x
        where x.user_id = d.user_id and x.status = 'outside' and x.started_at < d.d_end and x.last_seen_at > d.d_start
          and x.started_at > d.d_start - interval '7 days') as outside_mr,
      (select coalesce(range_agg(tstzrange(greatest(x.started_at, d.d_start), least(x.last_seen_at, d.d_end))), '{}')
         from public.office_presence x
        where x.user_id = d.user_id and x.status = 'away' and x.started_at < d.d_end and x.last_seen_at > d.d_start
          and x.started_at > d.d_start - interval '7 days') as away_mr,
      -- After each missed "still there?": until the next answered one, or the
      -- next stretch of input in the office (or do not disturb, which is chosen).
      (select coalesce(range_agg(tstzrange(c.due_at, coalesce(least(
                (select min(a.closed_at) from public.office_checkins a
                  where a.user_id = c.user_id and a.issued_at >= c.issued_at and a.outcome = 'answered' and a.closed_at > c.due_at),
                (select min(y.started_at) from public.office_presence y
                  where y.user_id = c.user_id and y.status in ('online', 'busy') and y.started_at > c.due_at)),
              'infinity'))), '{}')
         from public.office_checkins c
        where c.user_id = d.user_id and c.kind = 'outside' and c.outcome = 'missed'
          and c.due_at < d.d_end and c.due_at > d.d_start - interval '1 day') as doubt_mr,
      (select coalesce(range_agg(tstzrange(greatest(e.entered_at, d.d_start), least(coalesce(e.left_at, 'infinity'), d.d_end))), '{}')
         from public.office_entries e
        where e.user_id = d.user_id and e.entered_at < d.d_end and coalesce(e.left_at, 'infinity') > d.d_start) as in_mr,
      (select min(e.entered_at) from public.office_entries e
        where e.user_id = d.user_id and e.work_date = d.work_date) as first_entry
      from days d
  ),
  sets as (
    select r.*,
      tstzmultirange(tstzrange(r.w_start, greatest(r.w_start, r.w_end)))  as window_mr,
      tstzmultirange(tstzrange(r.d_start, greatest(r.d_start, r.d_end)))  as day_mr,
      r.outside_mr - r.doubt_mr                                            as outside_ok,
      r.online_mr + r.busy_mr + (r.outside_mr - r.doubt_mr)                as working_mr
      from raw r
  ),
  sets2 as (
    select t.*,
      case when t.expected and t.first_entry is not null and t.first_entry < t.d_end
           then tstzmultirange(tstzrange(greatest(t.first_entry, t.d_start), t.d_end)) - t.in_mr - t.working_mr
           else '{}'::tstzmultirange end                                   as signed_out_mr
      from sets t
  ),
  sets3 as (
    select t.*,
      (t.away_mr + (t.outside_mr * t.doubt_mr)) - t.working_mr - t.signed_out_mr as away_eff
      from sets2 t
  )
  select t.user_id,
         t.work_date,
         t.expected,
         public.office_minutes(t.online_mr * t.window_mr),
         public.office_minutes(t.busy_mr * t.window_mr),
         public.office_minutes(t.outside_ok * t.window_mr),
         public.office_minutes(t.away_eff * t.window_mr),
         public.office_minutes(t.signed_out_mr * t.window_mr),
         case when t.expected
              then public.office_minutes(t.window_mr - t.working_mr - t.away_eff - t.signed_out_mr)
              else 0 end,
         public.office_minutes((t.working_mr * t.day_mr) - t.window_mr),
         (select count(*)::int from public.office_checkins c
           where c.user_id = t.user_id and c.outcome = 'answered' and c.issued_at >= t.d_start and c.issued_at < t.d_end),
         (select count(*)::int from public.office_checkins c
           where c.user_id = t.user_id and c.outcome = 'missed' and c.issued_at >= t.d_start and c.issued_at < t.d_end),
         (select count(*)::int from public.office_entries e
           where e.user_id = t.user_id and e.work_date = t.work_date and e.left_reason in ('idle', 'gone')),
         (select min(x.started_at) from public.office_presence x
           where x.user_id = t.user_id and x.started_at < t.d_end and x.last_seen_at > t.d_start
             and x.started_at > t.d_start - interval '7 days'),
         (select max(x.last_seen_at) from public.office_presence x
           where x.user_id = t.user_id and x.started_at < t.d_end and x.last_seen_at > t.d_start
             and x.started_at > t.d_start - interval '7 days')
    from sets3 t
   order by t.user_id, t.work_date;
end;
$$;

revoke execute on function public.office_time_summary(date, date) from public, anon, authenticated;
grant  execute on function public.office_time_summary(date, date) to authenticated, service_role;

do $$
begin
  if to_regprocedure('public.office_time_summary(date,date)') is null
     or to_regprocedure('public.office_minutes(tstzmultirange)') is null then
    raise exception '0009: something is missing.';
  end if;
end $$;

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand after applying, signed in as nobody (the SQL
-- editor): the function refuses, which is right. To see figures, use the
-- Reports screen as Mr Tito, or impersonate him in the editor:
-- ===========================================================================
-- -- V1. The function exists and refuses a caller who is not in the office.
-- select public.office_time_summary(public.office_today(), public.office_today());
-- --   expect: ERROR  You are not in the office.
