-- JustUsedTech office, 0019: optional weekend reports.
--
-- APPLY AFTER 0018. Safe before or after the deploy: nothing an open tab calls
-- changes shape, and the screens offer weekend reports only once
-- office_settings.weekend_reports exists (it is added here).
--
-- Asked 2026-11-01: some staff work on weekends, and should be able to file
-- their reports then, but nobody has to. Now, on a day that is not in
-- office_settings.workdays (Saturday and Sunday):
--
-- 1. FILING: any office member who files reports (not Mr Tito) and is not
--    marked away may file the three reports, with the weekday times: sign-in
--    from 09:00 (late after 11:00), midday 15:00 to 16:00 (late after), end of
--    day 17:00 to 19:00 (closed after). office_may_report() is the rule.
-- 2. NOTHING IS DUE: office_expects_report() is unchanged, so a weekend has no
--    reminders, no "missed" flags, no office entries or sign-outs, and no time
--    figures. A late weekend report says "late" on the report but raises no
--    flag: Mr Tito and HR are not alerted to it.
-- 3. THE LEADERBOARD counts on-time reports on workdays only, so weekend work
--    earns no report points (staff notice version 7 says so).
--
-- To switch weekend filing off: update office_settings set weekend_reports = false.

begin;

-- ---------------------------------------------------------------------------
-- 1. The switch
-- ---------------------------------------------------------------------------
alter table public.office_settings
  add column if not exists weekend_reports boolean not null default true;

-- ---------------------------------------------------------------------------
-- 2. Who may file on a given day
-- ---------------------------------------------------------------------------
-- Due that day (office_expects_report), or, with weekend_reports on, the same
-- person on a day off: an active member, not Mr Tito, not away.
create or replace function public.office_may_report(p_user uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.office_expects_report(p_user, p_date)
      or (coalesce((select weekend_reports from public.office_settings where id = 1), false)
          and extract(isodow from p_date)::smallint <> all (coalesce((select workdays from public.office_settings where id = 1), '{}'))
          and exists (
                select 1 from public.office_members m
                  join public.profiles u on u.id = m.user_id
                 where m.user_id = p_user and m.active and u.deactivated_at is null
              )
          and p_user is distinct from (select manager_id from public.office_settings where id = 1)
          and not exists (
                select 1 from public.office_absences a
                 where (a.user_id = p_user or a.user_id is null)
                   and p_date between a.starts_on and a.ends_on
              ))
$$;

revoke execute on function public.office_may_report(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Filing: 0018's submit_report, with the two changes above. Same
--    arguments, so its grants are kept.
-- ---------------------------------------------------------------------------
create or replace function public.submit_report(
  p_kind  text,
  p_body  text,
  p_link  text,
  p_files jsonb,
  p_links text[] default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s          public.office_settings%rowtype;
  v_uid      uuid := auth.uid();
  v_local    timestamp;
  v_date     date;
  v_time     time;
  v_opens    time;
  v_deadline time;
  v_timing   text;
  v_body     text := nullif(btrim(coalesce(p_body, '')), '');
  v_links    text[];
  v_files    jsonb := coalesce(p_files, '[]'::jsonb);
  v_id       uuid;
  f          jsonb;
  v_path     text;
  v_sha      text;
  v_name     text;
  v_mime     text;
  v_size     bigint;
  v_found    boolean;
  v_due      boolean;
begin
  if v_uid is null then
    raise exception 'Sign in again and retry.' using errcode = '42501';
  end if;
  if p_kind not in ('signin', 'midday', 'eod') then
    raise exception 'Unknown report.' using errcode = '22023';
  end if;

  select * into s from public.office_settings where id = 1;
  v_local := now() at time zone s.timezone;
  v_date  := v_local::date;
  v_time  := v_local::time;

  -- 0019: due today, or free to file on a day off (a weekend).
  v_due := public.office_expects_report(v_uid, v_date);
  if not v_due and not public.office_may_report(v_uid, v_date) then
    raise exception 'No report is due from you today.' using errcode = '42501';
  end if;

  v_opens := case p_kind when 'signin' then s.signin_reminder when 'midday' then s.midday_opens else s.eod_opens end;
  v_deadline := case p_kind
    when 'signin' then s.signin_deadline
    when 'midday' then s.midday_deadline
    else s.eod_deadline
  end;
  if v_time < v_opens then
    raise exception '% opens at %.', case p_kind when 'signin' then 'Sign-in' else 'This report' end, to_char(v_opens, 'HH24:MI') using errcode = '22023';
  end if;
  v_timing := case when v_time < v_deadline + interval '1 minute' then 'on_time' else 'late' end;
  -- 0018: the end-of-day report closes at its deadline (to the minute, as
  -- on time is counted). After that it stays missed.
  if p_kind = 'eod' and v_timing = 'late' then
    raise exception 'The end-of-day report closed at %. It can no longer be filed today.', to_char(v_deadline, 'HH24:MI') using errcode = '22023';
  end if;

  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Files must be a list.' using errcode = '22023';
  end if;
  if p_kind <> 'signin' and v_body is null then
    raise exception 'Say what you worked on.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_files) > 5 then
    raise exception 'Attach up to 5 files.' using errcode = '22023';
  end if;
  v_links := public.office_links(p_link, p_links);

  begin
    insert into public.office_reports (user_id, work_date, kind, body, links, timing)
    values (v_uid, v_date, p_kind, v_body, v_links, v_timing)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'You have already filed this report today.' using errcode = '23505';
  end;

  for f in select value from jsonb_array_elements(v_files) loop
    v_path := f ->> 'path';
    v_sha  := lower(coalesce(f ->> 'sha256', ''));
    v_name := left(coalesce(nullif(btrim(f ->> 'name'), ''), 'file'), 200);

    if v_path is null or v_path not like v_uid::text || '/' || v_date::text || '/' || p_kind || '/%' then
      raise exception 'A file is not in your folder for this report.' using errcode = '42501';
    end if;
    if v_sha !~ '^[0-9a-f]{64}$' then
      raise exception 'A file is missing its fingerprint. Attach it again.' using errcode = '22023';
    end if;

    select true, o.metadata ->> 'mimetype', (o.metadata ->> 'size')::bigint
      into v_found, v_mime, v_size
      from storage.objects o
     where o.bucket_id = 'proof' and o.name = v_path;
    if v_found is not true then
      raise exception 'An upload did not finish. Attach the file again.' using errcode = '22023';
    end if;
    if v_mime is null or (v_mime not like 'image/%' and v_mime <> 'application/pdf') then
      raise exception 'Proof must be an image or a PDF.' using errcode = '22023';
    end if;
    if v_size is null or v_size > 10485760 then
      raise exception 'Each file must be 10 MB or smaller.' using errcode = '22023';
    end if;

    if exists (select 1 from public.office_report_files where sha256 = v_sha) then
      insert into public.office_flags (user_id, work_date, kind, flag, detail)
      values (v_uid, v_date, p_kind, 'reused_proof', v_name)
      on conflict do nothing;
    end if;

    insert into public.office_report_files (report_id, user_id, storage_path, file_name, mime_type, size_bytes, sha256)
    values (v_id, v_uid, v_path, v_name, v_mime, v_size, v_sha);
  end loop;

  update public.office_flags
     set resolved_at = now()
   where user_id = v_uid and work_date = v_date and kind = p_kind
     and flag = 'missed' and resolved_at is null;

  -- 0019: a late report on a day off is marked late, never flagged.
  if v_timing = 'late' and v_due then
    insert into public.office_flags (user_id, work_date, kind, flag, detail)
    values (v_uid, v_date, p_kind, 'late', to_char(v_time, 'HH24:MI'))
    on conflict do nothing;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The leaderboard: 0015's, counting workday reports only
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
       and t.assigned_by <> t.assigned_to
     group by 1
  ),
  filed as (
    select r.user_id as uid, count(*)::int as n
      from public.office_reports r
     where r.timing = 'on_time' and r.submitted_at >= v_from and r.submitted_at < v_to
       -- 0019: workdays only; a weekend report is optional and scores nothing.
       and extract(isodow from r.work_date)::smallint = any (coalesce((select s.workdays from public.office_settings s where s.id = 1), '{}'))
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

do $$
declare
  v_sub text := (select prosrc from pg_proc
                  where oid = 'public.submit_report(text, text, text, jsonb, text[])'::regprocedure);
  v_lb  text := (select prosrc from pg_proc where oid = 'public.office_leaderboard(int)'::regprocedure);
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'office_settings' and column_name = 'weekend_reports')
     or v_sub not like '%office_may_report(v_uid, v_date)%'
     or v_sub not like '%v_timing = ''late'' and v_due%'
     or v_sub not like '%It can no longer be filed today%'
     or v_lb not like '%extract(isodow from r.work_date)%'
     or not exists (select 1 from pg_proc where oid = to_regprocedure('public.office_may_report(uuid, date)') and prosecdef) then
    raise exception '0019: something is missing.';
  end if;
  if has_function_privilege('anon', 'public.submit_report(text, text, text, jsonb, text[])', 'execute')
     or not has_function_privilege('authenticated', 'public.submit_report(text, text, text, jsonb, text[])', 'execute')
     or has_function_privilege('authenticated', 'public.office_may_report(uuid, date)', 'execute')
     or has_function_privilege('anon', 'public.office_may_report(uuid, date)', 'execute')
     or has_function_privilege('anon', 'public.office_leaderboard(int)', 'execute')
     or not has_function_privilege('authenticated', 'public.office_leaderboard(int)', 'execute') then
    raise exception '0019: the wrong role can call a function.';
  end if;
end $$;

commit;
