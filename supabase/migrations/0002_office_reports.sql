-- JustUsedTech office (ported from tito-crm), 0002: the office's daily reports (VIRTUAL-OFFICE-PLAN Phase 1).
--
-- APPLY AFTER 0001. Safe to apply before the frontend ships: nothing existing
-- reads these tables. Then, BY HAND, once:
--
--   1. Say who the manager is (Mr Tito). He sees every report; nobody else does.
--        update public.office_settings
--           set manager_id = (select id from public.profiles where email = '<his email>')
--         where id = 1;
--   2. Add him to the office (people who join later are added by themselves,
--      section 14):
--        insert into public.office_members (user_id)
--          select id from public.profiles where email = '<his email>'
--        on conflict do nothing;
--   3. Make sure public signups are off (0001's header).
--
-- This file also hands the office manager the team: he may deactivate people
-- and change their role (section 14); 0001 lets everyone change only their name.
--
-- ============================================================================
-- THE DAY (all times Africa/Lagos, Monday to Friday, from office_settings)
-- ============================================================================
--   sign-in   any time that day; on time up to 09:15
--   midday    opens 13:00; on time up to 14:00            proof required
--   EOD       opens 17:00; on time up to 18:30            proof required
-- "Up to 09:15" means through 09:15:59, as the Telegram tracker counted it.
-- A report filed after its deadline is accepted and marked late. Filing is
-- possible until midnight; after that the day is closed.
--
-- ============================================================================
-- WHO DECIDES WHAT
-- ============================================================================
-- The browser never writes a report row. It uploads proof into its own folder
-- of the private `proof` bucket, then calls submit_report(), which:
--   - takes the date and time from Postgres's clock, never from the client,
--     so on-time vs late cannot be claimed;
--   - checks each named file really is in storage, in the caller's folder for
--     today and this checkpoint, within type and size limits;
--   - refuses midday and EOD without proof, and refuses a second filing.
-- Flags (missed, late, reused proof) are raised only by the database. Missing
-- checkpoints are flagged by raise_report_flags(), run by pg_cron every five
-- minutes from this migration; Telegram delivery is a separate job (0003).
--
-- Proof is kept 90 days (office_settings.proof_retention_days). The purge runs
-- in the alerts route through the Storage API, because deleting rows from
-- storage.objects in SQL would leave the files behind.

create extension if not exists pg_cron with schema pg_catalog;

begin;

-- ---------------------------------------------------------------------------
-- 1. Settings: one row
-- ---------------------------------------------------------------------------
create table if not exists public.office_settings (
  id                   smallint primary key default 1 check (id = 1),
  timezone             text not null default 'Africa/Lagos',
  -- ISO day numbers: 1 = Monday.
  workdays             smallint[] not null default '{1,2,3,4,5}',
  signin_reminder      time not null default '09:00',
  signin_deadline      time not null default '09:15',
  midday_opens         time not null default '13:00',
  midday_deadline      time not null default '14:00',
  eod_opens            time not null default '17:00',
  eod_deadline         time not null default '18:30',
  proof_retention_days int  not null default 90 check (proof_retention_days >= 1),
  -- Mr Tito. The only person who reads other people's reports. Set by hand.
  manager_id           uuid references public.profiles(id) on delete set null,
  check (signin_reminder <= signin_deadline
     and signin_deadline < midday_opens
     and midday_opens < midday_deadline
     and midday_deadline <= eod_opens
     and eod_opens < eod_deadline
     -- On-time runs to the end of the deadline minute; 23:59 would wrap.
     and eod_deadline < '23:59')
);

insert into public.office_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Who is in the office
-- ---------------------------------------------------------------------------
-- A subset of profiles, chosen by the manager. Everyone here except the
-- manager files reports. Readable by the whole team (the office shows names).
create table if not exists public.office_members (
  user_id  uuid primary key references public.profiles(id) on delete cascade,
  active   boolean not null default true,
  added_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Reports and their proof
-- ---------------------------------------------------------------------------
create table if not exists public.office_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  -- The office's calendar date (Africa/Lagos), not UTC.
  work_date    date not null,
  kind         text not null check (kind in ('signin', 'midday', 'eod')),
  body         text check (char_length(body) <= 4000),
  link         text check (char_length(link) <= 2000 and link ~* '^https?://\S+$'),
  submitted_at timestamptz not null default now(),
  timing       text not null check (timing in ('on_time', 'late')),
  unique (user_id, work_date, kind)
);

create index if not exists office_reports_date_idx on public.office_reports (work_date);

create table if not exists public.office_report_files (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid not null references public.office_reports(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  -- Path inside the `proof` bucket: <user id>/<work date>/<kind>/<file>.
  storage_path text not null unique,
  file_name    text not null check (char_length(file_name) <= 200),
  mime_type    text not null,
  size_bytes   bigint not null,
  -- Hashed in the browser. A signal, not proof: it catches the same
  -- screenshot handed in twice, by the same person or by two colleagues,
  -- which is the usual way this gets gamed.
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at  timestamptz not null default now(),
  -- Set when the 90-day purge removes the file. The row stays as the record.
  purged_at    timestamptz
);

create index if not exists office_report_files_report_idx on public.office_report_files (report_id);
create index if not exists office_report_files_user_idx on public.office_report_files (user_id);
create index if not exists office_report_files_hash_idx on public.office_report_files (sha256);

-- ---------------------------------------------------------------------------
-- 4. Flags, raised only by the database
-- ---------------------------------------------------------------------------
--   missed        deadline passed with nothing filed (resolved_at is set if
--                 the report comes in later that day)
--   late          filed after the deadline; detail is the local time
--   reused_proof  a file with the same hash as one handed in before
-- notified_at is set once Mr Tito's Telegram alert for it has gone.
create table if not exists public.office_flags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  work_date   date not null,
  kind        text not null check (kind in ('signin', 'midday', 'eod')),
  flag        text not null check (flag in ('missed', 'late', 'reused_proof')),
  detail      text,
  raised_at   timestamptz not null default now(),
  resolved_at timestamptz,
  notified_at timestamptz,
  unique (user_id, work_date, kind, flag)
);

create index if not exists office_flags_unnotified_idx on public.office_flags (raised_at) where notified_at is null;
create index if not exists office_flags_date_idx on public.office_flags (work_date);

-- ---------------------------------------------------------------------------
-- 5. Days nobody should be flagged for
-- ---------------------------------------------------------------------------
-- user_id null = everyone (a public holiday).
create table if not exists public.office_absences (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  reason     text not null check (char_length(reason) between 1 and 200),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

create index if not exists office_absences_user_idx on public.office_absences (user_id);

-- ---------------------------------------------------------------------------
-- 6. Latches for the alerts route (one reminder, one digest, one purge a day)
-- ---------------------------------------------------------------------------
create table if not exists public.office_alert_log (
  key     text primary key,
  sent_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. Helpers
-- ---------------------------------------------------------------------------
-- Today on the office's clock.
create or replace function public.office_today()
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone (select timezone from public.office_settings where id = 1))::date
$$;

create or replace function public.is_office_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.office_settings where id = 1 and manager_id = auth.uid()
  )
$$;

create or replace function public.is_office_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_office_manager()
      or exists (
           select 1 from public.office_members m
             join public.profiles u on u.id = m.user_id
            where m.user_id = auth.uid() and m.active and u.deactivated_at is null
         )
$$;

-- Is a report due from this person on this date? The one copy of the rule.
create or replace function public.office_expects_report(p_user uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.office_members m
             join public.profiles u on u.id = m.user_id
            where m.user_id = p_user and m.active and u.deactivated_at is null
         )
     and p_user is distinct from (select manager_id from public.office_settings where id = 1)
     -- coalesce makes the subquery an array expression; bare, = any () would
     -- compare against a set of arrays.
     and extract(isodow from p_date)::smallint = any (coalesce((select workdays from public.office_settings where id = 1), '{}'))
     and not exists (
           select 1 from public.office_absences a
            where (a.user_id = p_user or a.user_id is null)
              and p_date between a.starts_on and a.ends_on
         )
$$;

-- For the manager's board and history: who was due, per member per day, and
-- why not when they were not.
create or replace function public.office_roster(p_from date, p_to date)
returns table (user_id uuid, work_date date, expected boolean, absence text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_office_manager() and auth.role() is distinct from 'service_role' then
    raise exception 'Only the office manager can see the team''s reports.' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 62 then
    raise exception 'Pick a range of up to 63 days.' using errcode = '22023';
  end if;

  return query
  select m.user_id,
         d::date,
         public.office_expects_report(m.user_id, d::date),
         (select a.reason from public.office_absences a
           where (a.user_id = m.user_id or a.user_id is null)
             and d::date between a.starts_on and a.ends_on
           order by a.user_id nulls last limit 1)
    from public.office_members m
    cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
   where m.user_id is distinct from (select manager_id from public.office_settings where id = 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Filing a report
-- ---------------------------------------------------------------------------
-- p_files: [{ "path": "<uid>/<date>/<kind>/<name>", "name": "...", "sha256": "..." }]
create or replace function public.submit_report(
  p_kind  text,
  p_body  text,
  p_link  text,
  p_files jsonb
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
  v_link     text := nullif(btrim(coalesce(p_link, '')), '');
  v_files    jsonb := coalesce(p_files, '[]'::jsonb);
  v_id       uuid;
  f          jsonb;
  v_path     text;
  v_sha      text;
  v_name     text;
  v_mime     text;
  v_size     bigint;
  v_found    boolean;
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

  if not public.office_expects_report(v_uid, v_date) then
    raise exception 'No report is due from you today.' using errcode = '42501';
  end if;

  v_opens := case p_kind when 'midday' then s.midday_opens when 'eod' then s.eod_opens end;
  v_deadline := case p_kind
    when 'signin' then s.signin_deadline
    when 'midday' then s.midday_deadline
    else s.eod_deadline
  end;
  if v_opens is not null and v_time < v_opens then
    raise exception 'This report opens at %.', to_char(v_opens, 'HH24:MI') using errcode = '22023';
  end if;
  v_timing := case when v_time < v_deadline + interval '1 minute' then 'on_time' else 'late' end;

  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Files must be a list.' using errcode = '22023';
  end if;
  if p_kind <> 'signin' and v_body is null then
    raise exception 'Say what you worked on.' using errcode = '22023';
  end if;
  if p_kind <> 'signin' and jsonb_array_length(v_files) = 0 then
    raise exception 'Attach proof of work: a screenshot or a file.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_files) > 5 then
    raise exception 'Attach up to 5 files.' using errcode = '22023';
  end if;
  if v_link is not null and v_link !~* '^https?://\S+$' then
    raise exception 'The link must start with http:// or https://.' using errcode = '22023';
  end if;

  begin
    insert into public.office_reports (user_id, work_date, kind, body, link, timing)
    values (v_uid, v_date, p_kind, v_body, v_link, v_timing)
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

  if v_timing = 'late' then
    insert into public.office_flags (user_id, work_date, kind, flag, detail)
    values (v_uid, v_date, p_kind, 'late', to_char(v_time, 'HH24:MI'))
    on conflict do nothing;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The flag job
-- ---------------------------------------------------------------------------
-- Idempotent: the unique key makes a second run in the same minute a no-op.
create or replace function public.raise_report_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  s       public.office_settings%rowtype;
  v_local timestamp;
  v_n     integer;
begin
  select * into s from public.office_settings where id = 1;
  v_local := now() at time zone s.timezone;

  insert into public.office_flags (user_id, work_date, kind, flag)
  select m.user_id, v_local::date, k.kind, 'missed'
    from public.office_members m
   cross join (values ('signin', s.signin_deadline),
                      ('midday', s.midday_deadline),
                      ('eod',    s.eod_deadline)) as k(kind, deadline)
   where v_local::time >= k.deadline + interval '1 minute'
     and public.office_expects_report(m.user_id, v_local::date)
     and not exists (
           select 1 from public.office_reports r
            where r.user_id = m.user_id and r.work_date = v_local::date and r.kind = k.kind
         )
  on conflict do nothing;

  get diagnostics v_n = row_count;

  -- A report committed while this ran (both under READ COMMITTED) can leave
  -- a missed flag that submit_report() had nothing to resolve. Close those.
  update public.office_flags f
     set resolved_at = now()
   where f.flag = 'missed' and f.resolved_at is null and f.work_date = v_local::date
     and exists (select 1 from public.office_reports r
                  where r.user_id = f.user_id and r.work_date = f.work_date and r.kind = f.kind);

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Purge helpers, for the alerts route (service_role)
-- ---------------------------------------------------------------------------
create or replace function public.office_proof_due_for_purge(p_limit int)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'proof'
     and o.created_at < now() - make_interval(days => (select proof_retention_days from public.office_settings where id = 1))
   order by o.created_at
   limit greatest(1, least(p_limit, 1000))
$$;

-- Marks every file whose object is gone. Run after a Storage removal; it
-- also catches a removal whose marking failed on an earlier run.
create or replace function public.office_mark_purged()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.office_report_files f set purged_at = now()
   where f.purged_at is null
     and not exists (select 1 from storage.objects o where o.bucket_id = 'proof' and o.name = f.storage_path);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Grants (0030: revoke from public, anon AND authenticated, then grant)
-- ---------------------------------------------------------------------------
revoke execute on function public.office_today()                         from public, anon, authenticated;
revoke execute on function public.is_office_manager()                    from public, anon, authenticated;
revoke execute on function public.is_office_member()                     from public, anon, authenticated;
revoke execute on function public.office_expects_report(uuid, date)      from public, anon, authenticated;
revoke execute on function public.office_roster(date, date)              from public, anon, authenticated;
revoke execute on function public.submit_report(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.raise_report_flags()                   from public, anon, authenticated;
revoke execute on function public.office_proof_due_for_purge(int)        from public, anon, authenticated;
revoke execute on function public.office_mark_purged()             from public, anon, authenticated;

grant execute on function public.office_today()                         to authenticated;
grant execute on function public.is_office_manager()                    to authenticated;
grant execute on function public.is_office_member()                     to authenticated;
grant execute on function public.office_roster(date, date)              to authenticated, service_role;
grant execute on function public.submit_report(text, text, text, jsonb) to authenticated;
grant execute on function public.raise_report_flags()                   to service_role;
grant execute on function public.office_proof_due_for_purge(int)        to service_role;
grant execute on function public.office_mark_purged()             to service_role;

-- ---------------------------------------------------------------------------
-- 12. Row level security
-- ---------------------------------------------------------------------------
alter table public.office_settings     enable row level security;
alter table public.office_members      enable row level security;
alter table public.office_reports      enable row level security;
alter table public.office_report_files enable row level security;
alter table public.office_flags        enable row level security;
alter table public.office_absences     enable row level security;
alter table public.office_alert_log    enable row level security;

-- Every check is wrapped as (select fn()) so it runs once per statement, not
-- once per row. Each policy is dropped first so the file re-runs.

-- Settings: readable by the team (the screens show the times). Changed by hand.
drop policy if exists "Team can read office settings" on public.office_settings;
create policy "Team can read office settings"
  on public.office_settings for select to authenticated using ((select public.is_team_member()));

-- Members: the team sees who is in the office; the manager decides.
drop policy if exists "Team can read office members" on public.office_members;
create policy "Team can read office members"
  on public.office_members for select to authenticated using ((select public.is_team_member()));
drop policy if exists "Manager adds office members" on public.office_members;
create policy "Manager adds office members"
  on public.office_members for insert to authenticated with check ((select public.is_office_manager()));
drop policy if exists "Manager updates office members" on public.office_members;
create policy "Manager updates office members"
  on public.office_members for update to authenticated
  using ((select public.is_office_manager())) with check ((select public.is_office_manager()));
drop policy if exists "Manager removes office members" on public.office_members;
create policy "Manager removes office members"
  on public.office_members for delete to authenticated using ((select public.is_office_manager()));

-- Reports, proof and flags: your own, or all of them if you are the manager.
-- No write policies: reports are written only by submit_report(), flags only
-- by the database, and nothing is ever edited or deleted from the browser.
drop policy if exists "Own reports, or the manager" on public.office_reports;
create policy "Own reports, or the manager"
  on public.office_reports for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));
drop policy if exists "Own report files, or the manager" on public.office_report_files;
create policy "Own report files, or the manager"
  on public.office_report_files for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));
drop policy if exists "Own flags, or the manager" on public.office_flags;
create policy "Own flags, or the manager"
  on public.office_flags for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));

-- Absences: a member sees their own and the team-wide ones; the manager all.
drop policy if exists "Own and team absences, or the manager" on public.office_absences;
create policy "Own and team absences, or the manager"
  on public.office_absences for select to authenticated
  using (user_id = (select auth.uid()) or user_id is null or (select public.is_office_manager()));
drop policy if exists "Manager records absences" on public.office_absences;
create policy "Manager records absences"
  on public.office_absences for insert to authenticated with check ((select public.is_office_manager()));
drop policy if exists "Manager removes absences" on public.office_absences;
create policy "Manager removes absences"
  on public.office_absences for delete to authenticated using ((select public.is_office_manager()));

-- office_alert_log: no policies. Only the service role touches it.

-- ---------------------------------------------------------------------------
-- 13. The proof bucket
-- ---------------------------------------------------------------------------
-- Private: files are only ever served through short-lived signed URLs. The
-- size and type limits are enforced by Storage itself, and again by
-- submit_report().
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proof', 'proof', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Upload only into your own folder for today and a real checkpoint
-- (<uid>/<today>/<kind>/...), only while in the office, so the bucket cannot
-- be used as general storage. No update and no delete policy: a handed-in
-- file cannot be swapped afterwards.
drop policy if exists "Office members upload their own proof" on storage.objects;
create policy "Office members upload their own proof"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'proof'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] = (select public.office_today())::text
    and (storage.foldername(name))[3] in ('signin', 'midday', 'eod')
    and (select public.is_office_member())
  );

drop policy if exists "Proof readable by its owner and the office manager" on storage.objects;
create policy "Proof readable by its owner and the office manager"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'proof'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_office_manager()))
  );

-- ---------------------------------------------------------------------------
-- 14. Realtime: the manager's board updates as reports arrive
-- ---------------------------------------------------------------------------
-- Realtime applies the select policies above, so a member is sent only their
-- own rows.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_reports') then
    alter publication supabase_realtime add table public.office_reports;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_flags') then
    alter publication supabase_realtime add table public.office_flags;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 15. The flag clock: every five minutes, in SQL, no HTTP involved
-- ---------------------------------------------------------------------------
-- cron.schedule with an existing name replaces the job, so re-running is safe.
-- TO STOP IT: select cron.unschedule('office-raise-flags');
select cron.schedule('office-raise-flags', '*/5 * * * *', $job$ select public.raise_report_flags() $job$);


-- ---------------------------------------------------------------------------
-- 14. The office manager runs the team (profiles, from 0001)
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return NEW;
  end if;
  if NEW.email is distinct from OLD.email then
    raise exception 'The email belongs to the login and cannot change here.' using errcode = '42501';
  end if;
  if NEW.role is distinct from OLD.role or NEW.deactivated_at is distinct from OLD.deactivated_at then
    if not public.is_office_manager()
       or not exists (select 1 from public.profiles where id = auth.uid() and deactivated_at is null) then
      raise exception 'Only the office manager can change that.' using errcode = '42501';
    end if;
    if NEW.id = auth.uid() and NEW.deactivated_at is not null then
      raise exception 'You cannot deactivate your own account.' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

revoke execute on function public.profiles_guard() from public, anon, authenticated;

drop policy if exists "The manager updates the team" on public.profiles;
create policy "The manager updates the team"
  on public.profiles for update to authenticated
  using ((select public.is_office_manager()) and (select public.is_team_member()))
  with check ((select public.is_office_manager()));

-- Everyone who joins the team joins the office: a new profile (0001's
-- handle_new_user) becomes an office member at once, so an invite is one
-- step. Mr Tito can still pause or remove someone in Reports > Team.
create or replace function public.profiles_join_office()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.office_members (user_id) values (NEW.id) on conflict (user_id) do nothing;
  return NEW;
end;
$$;

revoke execute on function public.profiles_join_office() from public, anon, authenticated;

drop trigger if exists profiles_join_office on public.profiles;
create trigger profiles_join_office
  after insert on public.profiles
  for each row execute function public.profiles_join_office();

-- The invites waiting for a login: the manager reads them and can withdraw
-- one. They are written by the invite route (service role).
grant select, delete on public.invites to authenticated;
drop policy if exists "The manager reads invites" on public.invites;
create policy "The manager reads invites"
  on public.invites for select to authenticated using ((select public.is_office_manager()));
drop policy if exists "The manager withdraws invites" on public.invites;
create policy "The manager withdraws invites"
  on public.invites for delete to authenticated using ((select public.is_office_manager()));

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand after applying.
-- ===========================================================================
--
-- -- V1. Settings row, with the manager set (step 1 of the header).
-- select * from public.office_settings;
--
-- -- V2. The bucket is private with the 10 MB cap.
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'proof';
--
-- -- V3. The flag job exists and runs.
-- select jobname, schedule, active from cron.job where jobname = 'office-raise-flags';
-- select start_time, status, return_message from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'office-raise-flags')
--  order by start_time desc limit 5;
