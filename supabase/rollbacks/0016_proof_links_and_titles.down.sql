-- Rollback of 0016: proof required again on midday and end of day, one link,
-- no job titles, and the invites back to Mr Tito alone.
--
-- Keeps what it can: a report or task handed in with several links keeps its
-- FIRST link in the single-link column (link, done_link); the others, and
-- every job title, are lost. Reports already filed without proof stay.

begin;

update public.office_reports set link = links[1] where link is null and links is not null;
update public.office_tasks set done_link = done_links[1] where done_link is null and done_links is not null;

drop function if exists public.submit_report(text, text, text, jsonb, text[]);
drop function if exists public.complete_task(uuid, text, text, jsonb, text[]);

-- 0002's submit_report
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

-- 0015's complete_task
create or replace function public.complete_task(
  p_id    uuid,
  p_note  text default null,
  p_link  text default null,
  p_files jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := public.office_task_actor();
  v_note  text := public.office_task_text(p_note, 2000, 'The note');
  v_link  text := public.office_task_text(p_link, 2000, 'The link');
  v_files jsonb := coalesce(p_files, '[]'::jsonb);
  v_own   boolean;
  f       jsonb;
  v_path  text;
  v_name  text;
  v_found boolean;
  v_mime  text;
  v_size  bigint;
begin
  if v_link is not null and v_link !~* '^https?://\S+$' then
    raise exception 'The link must start with http:// or https://.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_files) <> 'array' or jsonb_array_length(v_files) > 5 then
    raise exception 'Attach up to 5 images.' using errcode = '22023';
  end if;
  update public.office_tasks
     set status     = case when assigned_by = assigned_to then 'approved' else 'done' end,
         closed_at  = case when assigned_by = assigned_to then now() end,
         closed_by  = case when assigned_by = assigned_to then v_uid end,
         done_note = v_note, done_link = v_link, done_at = now(), updated_at = now()
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

-- 0015's edit_task
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
  -- (a task sent back keeps its note and link until it is done again).
  update public.office_tasks
     set title = v_title, details = v_details, due_on = p_due, assigned_to = v_to,
         status = 'open', done_note = null, done_link = null, done_at = null, updated_at = now()
   where id = p_id;
  return public.office_task_event(p_id, 'assigned', left(array_to_string(
    format('Moved from %s', coalesce((select full_name from public.profiles where id = v_task.assigned_to), 'someone')) || v_changes,
    '; '), 2000));
end;
$$;

-- 0001's handle_new_user
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
  insert into public.profiles (id, email, full_name, role)
  values (NEW.id, lower(NEW.email), btrim(inv.full_name), inv.role)
  on conflict (id) do nothing;
  delete from public.invites where email = inv.email;
  return NEW;
end;
$$;

-- 0002's profiles_guard
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

revoke execute on function public.submit_report(text, text, text, jsonb)       from public, anon, authenticated;
revoke execute on function public.complete_task(uuid, text, text, jsonb)       from public, anon, authenticated;
revoke execute on function public.edit_task(uuid, text, text, date, uuid)      from public, anon, authenticated;
revoke execute on function public.handle_new_user()                            from public, anon, authenticated;
revoke execute on function public.profiles_guard()                             from public, anon, authenticated;
grant  execute on function public.submit_report(text, text, text, jsonb)       to authenticated;
grant  execute on function public.complete_task(uuid, text, text, jsonb)       to authenticated;
grant  execute on function public.edit_task(uuid, text, text, date, uuid)      to authenticated;

drop policy if exists "Admins set roles" on public.profiles;
revoke update (job_title) on public.profiles from authenticated;

drop policy if exists "The admins read invites" on public.invites;
drop policy if exists "The admins withdraw invites" on public.invites;
create policy "The manager reads invites"
  on public.invites for select to authenticated using ((select public.is_office_manager()));
create policy "The manager withdraws invites"
  on public.invites for delete to authenticated using ((select public.is_office_manager()));

alter table public.profiles drop column if exists job_title;
alter table public.invites drop column if exists job_title;
alter table public.office_reports drop column if exists links;
alter table public.office_tasks drop column if exists done_links;

drop function if exists public.office_links(text, text[]);
drop function if exists public.office_links_ok(text[]);

commit;
