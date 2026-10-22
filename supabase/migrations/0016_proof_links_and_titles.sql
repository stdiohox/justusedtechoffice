-- JustUsedTech office, 0016: proof is optional, several links, job titles,
-- and Hazel adds people.
--
-- APPLY AFTER 0015. Safe before the frontend ships: an open tab keeps calling
-- submit_report(kind, body, link, files) and complete_task(id, note, link,
-- files), which still resolve (the new links argument has a default), and its
-- one link is kept as a list of one. The extra link boxes, the Role field and
-- Hazel's Settings appear with the deploy.
--
-- Asked 2026-10-22:
--
-- 1. PROOF IS OPTIONAL. Midday and end of day still need a few words on what
--    was worked on; a screenshot or file is now optional, like the link. The
--    file checks (your folder, image or PDF, 10 MB, up to 5) and the
--    reused-proof flag are unchanged.
--
-- 2. SEVERAL LINKS, up to 5, on a report (office_reports.links) and on a task
--    handed in (office_tasks.done_links). The single-link columns (link,
--    done_link) stay for what was filed before; new filings leave them empty.
--    Each link must start with http:// or https://; blanks are dropped and a
--    link given twice is kept once.
--
-- 3. JOB TITLES ("Role" on screen: Mr Tito, CEO; Hazel, Operations Manager).
--    profiles.job_title and invites.job_title, up to 80 characters, or none.
--    Given when someone is invited, copied to their profile when they join,
--    and changed by the office admins (Mr Tito, and anyone whose
--    profiles.role is 'manager': Hazel). Nobody else, themselves included.
--    It is a label: it gives no access. Access stays profiles.role and
--    office_settings.manager_id.
--
-- 4. HAZEL ADDS PEOPLE. The office admins (is_task_admin(), 0011) read and
--    withdraw the invites waiting to join; the invite route (api/team/invite)
--    lets them send one. An invite is always for a member: nobody is invited
--    as an admin. Switching people off, photos, reports and the office
--    settings stay Mr Tito's. An admin who can change a title may change only
--    the title on someone else's profile.

begin;

-- ---------------------------------------------------------------------------
-- 0. Links: the check, and the tidy-up shared by both functions
-- ---------------------------------------------------------------------------
-- A list of 1 to 5 http(s) links of up to 2000 characters, or none.
create or replace function public.office_links_ok(p text[])
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p is null
      or (cardinality(p) between 1 and 5
          and array_ndims(p) = 1
          and not exists (select 1 from unnest(p) u
                           where u is null or char_length(u) > 2000 or u !~* '^https?://\S+$'))
$$;

-- The single link (from an open tab) and the list, as one tidy list: trimmed,
-- blanks dropped, repeats kept once, in the order given. Null when empty.
create or replace function public.office_links(p_link text, p_links text[])
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text[] := '{}';
  u text;
begin
  foreach u in array array_prepend(p_link, coalesce(p_links, '{}'::text[])) loop
    u := nullif(btrim(u), '');
    if u is null or u = any (v) then
      continue;
    end if;
    if char_length(u) > 2000 then
      raise exception 'A link is too long (2000 characters at most).' using errcode = '22023';
    end if;
    if u !~* '^https?://\S+$' then
      raise exception 'Each link must start with http:// or https://.' using errcode = '22023';
    end if;
    v := v || u;
  end loop;
  if cardinality(v) > 5 then
    raise exception 'Add up to 5 links.' using errcode = '22023';
  end if;
  return nullif(v, '{}');
end;
$$;

revoke execute on function public.office_links_ok(text[])     from public, anon, authenticated;
revoke execute on function public.office_links(text, text[])  from public, anon, authenticated;

alter table public.office_reports add column if not exists links text[]
  constraint office_reports_links_check check (public.office_links_ok(links));
alter table public.office_tasks add column if not exists done_links text[]
  constraint office_tasks_done_links_check check (public.office_links_ok(done_links));

-- ---------------------------------------------------------------------------
-- 1 and 2. Filing a report: proof optional, several links
-- ---------------------------------------------------------------------------
-- 0002's submit_report, with a fifth argument. The 4-argument version goes,
-- so a call without p_links (an open tab) resolves to this one.
drop function if exists public.submit_report(text, text, text, jsonb);

-- p_files: [{ "path": "<uid>/<date>/<kind>/<name>", "name": "...", "sha256": "..." }]
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

  if v_timing = 'late' then
    insert into public.office_flags (user_id, work_date, kind, flag, detail)
    values (v_uid, v_date, p_kind, 'late', to_char(v_time, 'HH24:MI'))
    on conflict do nothing;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A task handed in with several links
-- ---------------------------------------------------------------------------
-- 0015's complete_task, with a fifth argument (the 4-argument version goes,
-- as above).
drop function if exists public.complete_task(uuid, text, text, jsonb);

create or replace function public.complete_task(
  p_id    uuid,
  p_note  text default null,
  p_link  text default null,
  p_files jsonb default '[]'::jsonb,
  p_links text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := public.office_task_actor();
  v_note  text := public.office_task_text(p_note, 2000, 'The note');
  v_links text[] := public.office_links(p_link, p_links);
  v_files jsonb := coalesce(p_files, '[]'::jsonb);
  v_own   boolean;
  f       jsonb;
  v_path  text;
  v_name  text;
  v_found boolean;
  v_mime  text;
  v_size  bigint;
begin
  if jsonb_typeof(v_files) <> 'array' or jsonb_array_length(v_files) > 5 then
    raise exception 'Attach up to 5 images.' using errcode = '22023';
  end if;
  update public.office_tasks
     set status     = case when assigned_by = assigned_to then 'approved' else 'done' end,
         closed_at  = case when assigned_by = assigned_to then now() end,
         closed_by  = case when assigned_by = assigned_to then v_uid end,
         done_note = v_note, done_link = null, done_links = v_links, done_at = now(), updated_at = now()
   where id = p_id and assigned_to = v_uid and status in ('open', 'in_progress')
  returning assigned_by = assigned_to into v_own;
  if not found then
    raise exception 'That task is not open.' using errcode = '22023';
  end if;

  for f in select value from jsonb_array_elements(v_files) loop
    v_path := f ->> 'path';
    v_name := left(coalesce(nullif(btrim(f ->> 'name'), ''), 'image'), 200);
    if v_path is null or v_path not like p_id::text || '/' || v_uid::text || '/%' then
      raise exception 'An image is not in your folder for this task.' using errcode = '42501';
    end if;
    v_found := null;
    select true, o.metadata ->> 'mimetype', (o.metadata ->> 'size')::bigint
      into v_found, v_mime, v_size
      from storage.objects o
     where o.bucket_id = 'task-proof' and o.name = v_path;
    if v_found is not true then
      raise exception 'An upload did not finish. Attach the image again.' using errcode = '22023';
    end if;
    if v_mime is null or v_mime not like 'image/%' then
      raise exception 'Proof must be an image.' using errcode = '22023';
    end if;
    if v_size is null or v_size > 10485760 then
      raise exception 'Each image must be 10 MB or smaller.' using errcode = '22023';
    end if;
    insert into public.office_task_files (task_id, uploaded_by, storage_path, file_name, mime_type, size_bytes)
    values (p_id, v_uid, v_path, v_name, v_mime, v_size)
    on conflict (storage_path) do nothing;
  end loop;

  return public.office_task_event(p_id, 'done', v_note);
end;
$$;

-- 0015's edit_task: a task moved to someone else drops the links too.
create or replace function public.edit_task(
  p_id      uuid,
  p_title   text,
  p_details text default null,
  p_due     date default null,
  p_to      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := public.office_task_actor();
  v_title   text := public.office_task_text(p_title, 200, 'The title');
  v_details text := public.office_task_text(p_details, 4000, 'The details');
  v_today   date := (now() at time zone (select timezone from public.office_settings where id = 1))::date;
  v_task    public.office_tasks%rowtype;
  v_to      uuid;
  v_changes text[] := '{}';
  q         constant text := '“';
  qe        constant text := '”';
begin
  if v_title is null then
    raise exception 'Give the task a title.' using errcode = '22023';
  end if;
  select * into v_task from public.office_tasks where id = p_id for update;
  if not found or v_task.status not in ('open', 'in_progress') then
    raise exception 'Only a task still to do or in progress can be edited.' using errcode = '22023';
  end if;
  if v_task.assigned_by = v_task.assigned_to then
    if v_task.assigned_to <> v_uid then
      raise exception 'Only its owner edits a personal task.' using errcode = '42501';
    end if;
  elsif v_task.assigned_to = v_uid or not (v_task.assigned_by = v_uid or public.is_task_admin()) then
    raise exception 'Only the person who gave the task, or an admin, edits it.' using errcode = '42501';
  end if;

  v_to := coalesce(p_to, v_task.assigned_to);
  if v_to <> v_task.assigned_to then
    if v_task.assigned_by = v_task.assigned_to then
      raise exception 'A personal task stays yours. Give a new task instead.' using errcode = '22023';
    end if;
    if v_to = v_task.assigned_by then
      raise exception 'Give the task to someone other than the person who gave it.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles where id = v_to and deactivated_at is null) then
      raise exception 'That person is not on the team.' using errcode = '22023';
    end if;
  end if;
  -- A due date already past may stay; a new one may not be in the past.
  if p_due is distinct from v_task.due_on and p_due is not null and p_due < v_today then
    raise exception 'The due date has already passed.' using errcode = '22023';
  end if;

  if v_title is distinct from v_task.title then
    v_changes := v_changes || format('Title was %s%s%s', q, left(v_task.title, 120), qe);
  end if;
  if v_details is distinct from v_task.details then
    v_changes := v_changes || case when v_task.details is null then 'Details added'
                                   when v_details is null then 'Details removed'
                                   else 'Details changed' end;
  end if;
  if p_due is distinct from v_task.due_on then
    v_changes := v_changes || format('Due %s, was %s',
      coalesce(to_char(p_due, 'Dy FMDD Mon'), 'date removed'),
      coalesce(to_char(v_task.due_on, 'Dy FMDD Mon'), 'none'));
  end if;
  if cardinality(v_changes) = 0 and v_to = v_task.assigned_to then
    return null;
  end if;

  if v_to = v_task.assigned_to then
    update public.office_tasks
       set title = v_title, details = v_details, due_on = p_due, updated_at = now()
     where id = p_id;
    return public.office_task_event(p_id, 'edited', left(array_to_string(v_changes, '; '), 2000));
  end if;

  -- Moved: a fresh start for the new person, without the last one's hand-in
  -- (a task sent back keeps its note and links until it is done again).
  update public.office_tasks
     set title = v_title, details = v_details, due_on = p_due, assigned_to = v_to,
         status = 'open', done_note = null, done_link = null, done_links = null, done_at = null, updated_at = now()
   where id = p_id;
  return public.office_task_event(p_id, 'assigned', left(array_to_string(
    format('Moved from %s', coalesce((select full_name from public.profiles where id = v_task.assigned_to), 'someone')) || v_changes,
    '; '), 2000));
end;
$$;

revoke execute on function public.submit_report(text, text, text, jsonb, text[])   from public, anon, authenticated;
revoke execute on function public.complete_task(uuid, text, text, jsonb, text[])   from public, anon, authenticated;
revoke execute on function public.edit_task(uuid, text, text, date, uuid)          from public, anon, authenticated;
grant  execute on function public.submit_report(text, text, text, jsonb, text[])   to authenticated;
grant  execute on function public.complete_task(uuid, text, text, jsonb, text[])   to authenticated;
grant  execute on function public.edit_task(uuid, text, text, date, uuid)          to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Job titles
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists job_title text
  constraint profiles_job_title_check check (job_title is null or char_length(btrim(job_title)) between 1 and 80);
alter table public.invites add column if not exists job_title text
  constraint invites_job_title_check check (job_title is null or char_length(btrim(job_title)) between 1 and 80);

-- 0001's handle_new_user, copying the title from the invite.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inv public.invites%rowtype;
begin
  if NEW.email_confirmed_at is null then
    return NEW;
  end if;
  select * into inv from public.invites where email = lower(NEW.email);
  if not found then
    return NEW;
  end if;
  insert into public.profiles (id, email, full_name, role, job_title)
  values (NEW.id, lower(NEW.email), btrim(inv.full_name), inv.role, nullif(btrim(inv.job_title), ''))
  on conflict (id) do nothing;
  delete from public.invites where email = inv.email;
  return NEW;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- 0002's profiles_guard, plus: a title is the admins' to change, and an
-- admin who is not the office manager changes nothing else on someone else.
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
  if NEW.job_title is distinct from OLD.job_title and not public.is_task_admin() then
    raise exception 'Only Mr Tito or an admin can change a role.' using errcode = '42501';
  end if;
  if NEW.id <> auth.uid() and not public.is_office_manager()
     and NEW.full_name is distinct from OLD.full_name then
    raise exception 'Only the person or Mr Tito can change a name.' using errcode = '42501';
  end if;
  NEW.job_title := nullif(btrim(NEW.job_title), '');
  return NEW;
end;
$$;

revoke execute on function public.profiles_guard() from public, anon, authenticated;

grant update (job_title) on public.profiles to authenticated;

drop policy if exists "Admins set roles" on public.profiles;
create policy "Admins set roles"
  on public.profiles for update to authenticated
  using ((select public.is_task_admin()))
  with check ((select public.is_task_admin()));

-- ---------------------------------------------------------------------------
-- 4. The admins see and withdraw the invites waiting to join
-- ---------------------------------------------------------------------------
drop policy if exists "The manager reads invites" on public.invites;
drop policy if exists "The admins read invites" on public.invites;
create policy "The admins read invites"
  on public.invites for select to authenticated using ((select public.is_task_admin()));
drop policy if exists "The manager withdraws invites" on public.invites;
drop policy if exists "The admins withdraw invites" on public.invites;
create policy "The admins withdraw invites"
  on public.invites for delete to authenticated using ((select public.is_task_admin()));

do $$
begin
  if to_regprocedure('public.submit_report(text, text, text, jsonb, text[])') is null
     or to_regprocedure('public.submit_report(text, text, text, jsonb)') is not null
     or to_regprocedure('public.complete_task(uuid, text, text, jsonb, text[])') is null
     or to_regprocedure('public.complete_task(uuid, text, text, jsonb)') is not null
     or (select prosrc from pg_proc where oid = 'public.submit_report(text, text, text, jsonb, text[])'::regprocedure)
        like '%Attach proof of work%'
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'office_reports' and column_name = 'links')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'office_tasks' and column_name = 'done_links')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'profiles' and column_name = 'job_title')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'invites' and column_name = 'job_title')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invites'
                     and policyname = 'The admins read invites') then
    raise exception '0016: something is missing.';
  end if;
  if has_function_privilege('anon', 'public.submit_report(text, text, text, jsonb, text[])', 'execute')
     or has_function_privilege('anon', 'public.complete_task(uuid, text, text, jsonb, text[])', 'execute')
     or has_function_privilege('authenticated', 'public.office_links(text, text[])', 'execute') then
    raise exception '0016: the wrong role can call a function.';
  end if;
end $$;

commit;
