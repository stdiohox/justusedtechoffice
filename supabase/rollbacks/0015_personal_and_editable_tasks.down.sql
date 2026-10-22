-- Rollback of 0015: back to tasks always given to someone else, and never edited.
--
-- DELETES every personal task (given to yourself), with its history and
-- image records: 0011's rule (assigned_by <> assigned_to) cannot come back
-- while they exist. Their image files stay in the task-proof bucket until the
-- daily orphan sweep (0013) removes them. Edit steps are deleted from the
-- history (the edits themselves stay: the tasks keep their corrected text).

begin;

-- No personal task may be added between the delete and the check below.
lock table public.office_tasks in share row exclusive mode;

drop function if exists public.edit_task(uuid, text, text, date, uuid);

delete from public.office_tasks where assigned_by = assigned_to;
delete from public.office_task_events where kind = 'edited';

alter table public.office_tasks drop constraint if exists office_tasks_check;
alter table public.office_tasks add constraint office_tasks_check check (assigned_by <> assigned_to);

alter table public.office_task_events drop constraint if exists office_task_events_kind_check;
alter table public.office_task_events add constraint office_task_events_kind_check
  check (kind in ('assigned', 'started', 'done', 'approved', 'returned', 'cancelled', 'rated'));

-- 0011's create_task
create or replace function public.create_task(p_to uuid, p_title text, p_details text default null, p_due date default null)
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
  v_id      uuid;
begin
  if v_title is null then
    raise exception 'Give the task a title.' using errcode = '22023';
  end if;
  if p_to is null or p_to = v_uid then
    raise exception 'Give the task to someone else.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_to and deactivated_at is null) then
    raise exception 'That person is not on the team.' using errcode = '22023';
  end if;
  if p_due is not null and p_due < v_today then
    raise exception 'The due date has already passed.' using errcode = '22023';
  end if;
  -- Serialise one person's tasks, so parallel calls cannot slip past the cap.
  perform pg_advisory_xact_lock(hashtext('office_task:' || v_uid::text));
  if (select count(*) from public.office_tasks
       where assigned_by = v_uid and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'That is a lot of tasks in one hour. Wait a little.' using errcode = '22023';
  end if;
  insert into public.office_tasks (title, details, assigned_by, assigned_to, due_on)
  values (v_title, v_details, v_uid, p_to, p_due)
  returning id into v_id;
  return public.office_task_event(v_id, 'assigned', null);
end;
$$;

-- 0013's complete_task
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

-- 0011's cancel_task
create or replace function public.cancel_task(p_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := public.office_task_actor();
  v_note text := public.office_task_text(p_note, 2000, 'The note');
  v_task public.office_tasks%rowtype;
begin
  select * into v_task from public.office_tasks where id = p_id for update;
  if not found or v_task.status not in ('open', 'in_progress', 'done') then
    raise exception 'That task is already closed.' using errcode = '22023';
  end if;
  -- As with checking: nobody cancels a task they were given, admin or not.
  if v_task.assigned_to = v_uid or not (v_task.assigned_by = v_uid or public.is_task_admin()) then
    raise exception 'Only the person who gave the task, or an admin, cancels it.' using errcode = '42501';
  end if;
  update public.office_tasks set status = 'cancelled', closed_at = now(), closed_by = v_uid, updated_at = now()
   where id = p_id;
  return public.office_task_event(p_id, 'cancelled', v_note);
end;
$$;

-- 0012's rate_task
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

-- 0012's leaderboard
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

revoke execute on function public.create_task(uuid, text, text, date)    from public, anon, authenticated;
revoke execute on function public.complete_task(uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.cancel_task(uuid, text)                from public, anon, authenticated;
revoke execute on function public.rate_task(uuid, int, text)             from public, anon, authenticated;
revoke execute on function public.office_leaderboard(int)                from public, anon, authenticated;
grant  execute on function public.create_task(uuid, text, text, date)    to authenticated;
grant  execute on function public.complete_task(uuid, text, text, jsonb) to authenticated;
grant  execute on function public.cancel_task(uuid, text)                to authenticated;
grant  execute on function public.rate_task(uuid, int, text)             to authenticated;
grant  execute on function public.office_leaderboard(int)                to authenticated, service_role;

commit;
