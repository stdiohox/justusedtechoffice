-- JustUsedTech office, 0013: images as proof of work on a task (ported from
-- Tito Finance's CRM, 0052).
--
-- APPLY AFTER 0012. Safe before the frontend ships: the office tabs already open
-- keep calling complete_task(id, note, link) and still work (the new files
-- argument has a default); the image picker appears once this is applied.
--
-- WHAT IT DOES (asked 2026-10-21): when someone marks a task done they can
-- attach up to 5 images (PNG, JPEG, WebP or GIF, 10 MB each) beside the
-- note and the link. They show under "Handed in" to everyone who can see the
-- task, and nobody else. (Asked for JustUsedTech 2026-10-21.)
--
-- HOW, the same way as report proof (0002):
--   - a private bucket, `task-proof`; files are only ever served through
--     short-lived signed URLs. Storage enforces the size and type, and
--     complete_task checks them again;
--   - a file goes to <task id>/<uploader>/<random name>. Only the person the
--     task was given to uploads, only while it is To do or In progress, and
--     only into that task's folder, so the bucket is not general storage;
--   - no update and no delete policy: a handed-in image cannot be swapped;
--   - complete_task(id, note, link, files) records each file in
--     office_task_files after checking it is really there, in the caller's
--     folder for that task, an image, and within the size limit.
-- Sent back and done again: the new images are added; the earlier ones stay,
-- as the task's record.
--
-- HOUSEKEEPING (security review, 2026-10-21):
--   - at most 15 uploads per person per task (5 a hand-in, room for retries);
--   - an image uploaded but never handed in is visible only to its uploader;
--   - office_task_proof_orphans() lists those older than a day, and the alerts
--     route (api/cron/office-alerts, on 0003's clock) removes them once a day
--     through the Storage API (SQL cannot delete a stored file).
-- No HEIC: most browsers cannot show it; an iPhone sends JPEG instead.

begin;

-- ---------------------------------------------------------------------------
-- 1. The record of each image (first: the bucket's read policy names it)
-- ---------------------------------------------------------------------------
create table if not exists public.office_task_files (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.office_tasks(id) on delete cascade,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  -- Path inside the task-proof bucket: <task id>/<uploader>/<file>.
  storage_path text not null unique,
  file_name    text not null check (char_length(file_name) <= 200),
  mime_type    text not null,
  size_bytes   bigint not null,
  created_at   timestamptz not null default now()
);

create index if not exists office_task_files_task_idx on public.office_task_files (task_id, created_at);

alter table public.office_task_files enable row level security;
revoke all on public.office_task_files from anon, authenticated;
grant select on public.office_task_files to authenticated;

drop policy if exists "Images of tasks you can see" on public.office_task_files;
create policy "Images of tasks you can see"
  on public.office_task_files for select to authenticated
  using (exists (select 1 from public.office_tasks t where t.id = task_id));

-- ---------------------------------------------------------------------------
-- 2. The bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-proof', 'task-proof', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- How many images the caller has uploaded to one task. A function, because a
-- storage.objects policy cannot query storage.objects itself (Postgres refuses
-- the recursion); security definer reads past RLS, and only counts.
create or replace function public.task_proof_upload_count(p_task text)
returns int
language sql
stable
security definer
set search_path = public, storage, pg_temp
as $$
  select count(*)::int
    from storage.objects o
   where o.bucket_id = 'task-proof'
     and o.name like p_task || '/' || auth.uid()::text || '/%'
$$;

revoke execute on function public.task_proof_upload_count(text) from public, anon, authenticated;
grant  execute on function public.task_proof_upload_count(text) to authenticated;

drop policy if exists "Task proof uploaded by the assignee of an open task" on storage.objects;
create policy "Task proof uploaded by the assignee of an open task"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'task-proof'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and exists (
      select 1 from public.office_tasks t
       where t.id::text = (storage.foldername(name))[1]
         and t.assigned_to = (select auth.uid())
         and t.status in ('open', 'in_progress')
    )
    and public.task_proof_upload_count((storage.foldername(name))[1]) < 15
    and (select public.is_team_member())
  );

-- Readable by whoever can see the task (office_tasks' own RLS, 0011), once
-- it has been handed in; before that, only by the person who uploaded it.
drop policy if exists "Task proof readable with its task" on storage.objects;
create policy "Task proof readable with its task"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'task-proof'
    and exists (select 1 from public.office_tasks t where t.id::text = (storage.foldername(name))[1])
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or exists (select 1 from public.office_task_files f where f.storage_path = name)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Marking a task done, with images
-- ---------------------------------------------------------------------------
-- The 3-argument version is replaced by one with a 4th, defaulted argument,
-- so a call without files (an older open tab) still resolves to it.
drop function if exists public.complete_task(uuid, text, text);

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
     set status = 'done', done_note = v_note, done_link = v_link, done_at = now(), updated_at = now()
   where id = p_id and assigned_to = v_uid and status in ('open', 'in_progress');
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

revoke execute on function public.complete_task(uuid, text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.complete_task(uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Images never handed in
-- ---------------------------------------------------------------------------
-- Uploaded more than a day ago and not recorded by complete_task (an upload
-- that was abandoned, or a hand-in that failed), or left by a task that was
-- deleted. The alerts route removes them through the Storage API.
create or replace function public.office_task_proof_orphans(p_limit int default 100)
returns setof text
language sql
stable
security definer
set search_path = public, storage, pg_temp
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'task-proof'
     and o.created_at < now() - interval '1 day'
     and not exists (select 1 from public.office_task_files f where f.storage_path = o.name)
   order by o.created_at
   limit greatest(1, least(coalesce(p_limit, 100), 1000))
$$;

revoke execute on function public.office_task_proof_orphans(int) from public, anon, authenticated;
grant  execute on function public.office_task_proof_orphans(int) to service_role;

do $$
begin
  if to_regclass('public.office_task_files') is null
     or to_regprocedure('public.complete_task(uuid, text, text, jsonb)') is null
     or to_regprocedure('public.complete_task(uuid, text, text)') is not null
     or to_regprocedure('public.office_task_proof_orphans(integer)') is null
     or not exists (select 1 from storage.buckets where id = 'task-proof' and public = false)
     or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                     and policyname = 'Task proof uploaded by the assignee of an open task') then
    raise exception '0013: something is missing.';
  end if;
  if has_table_privilege('authenticated', 'public.office_task_files', 'insert, update, delete') then
    raise exception '0013: the browser can write the file records.';
  end if;
end $$;

commit;
