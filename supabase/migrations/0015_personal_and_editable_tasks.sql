-- JustUsedTech office, 0015: personal tasks, and tasks that can be edited (Tito Finance 0054).
--
-- APPLY AFTER 0014. Safe before the frontend ships: nothing that is open now
-- changes behaviour. The "Myself" choice, the Personal tab and the Edit
-- button appear with the deploy.
--
-- 1. PERSONAL TASKS (asked 2026-10-21): anyone can give a task to themselves,
--    to keep their own work on the list and track it: To do, In progress,
--    Done. Marking one done closes it at once (status 'approved', closed by
--    its owner): nobody checks it, nobody rates it, and it earns no
--    leaderboard points, so nobody can score by giving themselves work. It is
--    seen by its owner and the task admins (0011's RLS, unchanged); its owner
--    alone starts, finishes, edits or cancels it, and nobody is emailed.
--
-- 2. EDITING: edit_task(id, title, details, due, to) fixes a typo, wrong
--    details, the due date, or who it is for, while the task is To do or In
--    progress. The person who gave it, or an admin, edits it (never the person
--    it was given to); a personal task, only its owner. Each edit is one
--    'edited' step in the history saying what changed, and the assignee is
--    emailed (at most one edit email per task every 30 minutes, in
--    /api/office/task-notify). Moving it to someone else starts it afresh for
--    them (To do, with no earlier hand-in note or link) and is one 'assigned'
--    step, "Moved from …" plus anything else changed, emailed to them as a
--    new task.

begin;

-- ---------------------------------------------------------------------------
-- 1. A task may now be given to yourself
-- ---------------------------------------------------------------------------
-- 0011's unnamed check (assigned_by <> assigned_to), found by its definition.
do $$
declare
  c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.office_tasks'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ~ 'assigned_by <> assigned_to'
  loop
    execute format('alter table public.office_tasks drop constraint %I', c);
  end loop;
end $$;

alter table public.office_task_events drop constraint if exists office_task_events_kind_check;
alter table public.office_task_events add constraint office_task_events_kind_check
  check (kind in ('assigned', 'started', 'done', 'approved', 'returned', 'cancelled', 'rated', 'edited'));

-- 0011's create_task, allowing yourself.
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
  if p_to is null then
    raise exception 'Choose who the task is for.' using errcode = '22023';
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

-- 0013's complete_task: a personal task closes when it is done.
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

-- 0011's cancel_task: a personal task, by its owner only.
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
  if v_task.assigned_by = v_task.assigned_to then
    if v_task.assigned_to <> v_uid then
      raise exception 'Only its owner cancels a personal task.' using errcode = '42501';
    end if;
  -- As with checking: nobody cancels a task they were given, admin or not.
  elsif v_task.assigned_to = v_uid or not (v_task.assigned_by = v_uid or public.is_task_admin()) then
    raise exception 'Only the person who gave the task, or an admin, cancels it.' using errcode = '42501';
  end if;
  update public.office_tasks set status = 'cancelled', closed_at = now(), closed_by = v_uid, updated_at = now()
   where id = p_id;
  return public.office_task_event(p_id, 'cancelled', v_note);
end;
$$;

-- 0012's rate_task: a personal task is never rated.
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
  if v_task.assigned_by = v_task.assigned_to then
    raise exception 'A personal task is not rated.' using errcode = '22023';
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

-- 0012's leaderboard: personal tasks score nothing.
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

-- ---------------------------------------------------------------------------
-- 2. Editing a task
-- ---------------------------------------------------------------------------
-- The new title, details and due date (null clears details or due), and who
-- it is for (null: unchanged). Returns the one step it writes, to email:
-- 'assigned' when it moved (saying from whom, and what else changed), else
-- 'edited'; null when nothing changed.
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

revoke execute on function public.create_task(uuid, text, text, date)            from public, anon, authenticated;
revoke execute on function public.complete_task(uuid, text, text, jsonb)         from public, anon, authenticated;
revoke execute on function public.cancel_task(uuid, text)                        from public, anon, authenticated;
revoke execute on function public.rate_task(uuid, int, text)                     from public, anon, authenticated;
revoke execute on function public.office_leaderboard(int)                        from public, anon, authenticated;
revoke execute on function public.edit_task(uuid, text, text, date, uuid)        from public, anon, authenticated;
grant  execute on function public.create_task(uuid, text, text, date)            to authenticated;
grant  execute on function public.complete_task(uuid, text, text, jsonb)         to authenticated;
grant  execute on function public.cancel_task(uuid, text)                        to authenticated;
grant  execute on function public.rate_task(uuid, int, text)                     to authenticated;
grant  execute on function public.office_leaderboard(int)                        to authenticated, service_role;
grant  execute on function public.edit_task(uuid, text, text, date, uuid)        to authenticated;

do $$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.office_tasks'::regclass and contype = 'c'
                and pg_get_constraintdef(oid) ~ 'assigned_by <> assigned_to')
     or to_regprocedure('public.edit_task(uuid, text, text, date, uuid)') is null
     or not exists (select 1 from pg_constraint
                     where conname = 'office_task_events_kind_check'
                       and pg_get_constraintdef(oid) like '%edited%') then
    raise exception '0015: something is missing.';
  end if;
  if has_function_privilege('anon', 'public.edit_task(uuid, text, text, date, uuid)', 'execute') then
    raise exception '0015: anon can edit tasks.';
  end if;
end $$;

commit;
