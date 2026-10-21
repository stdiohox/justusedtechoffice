-- JustUsedTech office, 0011: tasks the team gives each other.
--
-- APPLY AFTER 0010. Safe before the frontend ships: nothing existing reads
-- these tables, and the Tasks screen stays hidden until they exist. Then, BY
-- HAND, once: make Hazel an office admin (Mr Tito is one already, as the
-- office manager):
--   update public.profiles set role = 'manager' where email = 'operations@justusedtech.org';
-- Her label on screen becomes "Manager". It gives her the tasks only: reports,
-- time figures and Settings stay Mr Tito's (office_settings.manager_id).
--
-- BEFORE APPLYING, check who is labelled manager already: every one of them
-- becomes a task admin and reads every task. The staff notice names only
-- Mr Tito and Hazel, so anyone else is set back to member first:
--   select email, full_name from public.profiles where role = 'manager';
--
-- ============================================================================
-- THE FLOW
-- ============================================================================
--   create_task(to, title, details, due)   anyone on the team gives a task to
--                       anyone else on the team. At most 30 an hour.
--   start_task(id)      the assignee: To do -> In progress.
--   complete_task(id, note, link)
--                       the assignee: done, with an optional note and link.
--                       It now waits for a check.
--   review_task(id, approve, note)
--                       the giver, or an admin: approve it, or send it back
--                       with a note saying what is missing (In progress again).
--                       Nobody checks a task they were given.
--   cancel_task(id, note)
--                       the giver, or an admin, while it is not yet approved.
--                       Never the assignee.
-- Each step writes one row to office_task_events: the task's history, and the
-- latch for its email. After assigned, done and returned, the actor's browser
-- asks /api/office/task-notify to email the other person, once per event
-- (emailed_at). The route checks the caller is the event's actor.
--
-- ============================================================================
-- WHO SEES WHAT
-- ============================================================================
-- A task and its history: the giver, the assignee, and the office admins
-- (the office manager, and anyone whose profiles.role is 'manager'). Rows
-- change only through the functions above. Realtime carries the changes
-- (RLS applies to Realtime too).

begin;

-- An office admin: the office manager, or a team member labelled manager.
create or replace function public.is_task_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_team_member()
     and (public.is_office_manager()
          or exists (select 1 from public.profiles where id = auth.uid() and role = 'manager'))
$$;

create table if not exists public.office_tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(btrim(title)) between 1 and 200),
  details     text check (char_length(details) <= 4000),
  assigned_by uuid not null references public.profiles(id) on delete cascade,
  assigned_to uuid not null references public.profiles(id) on delete cascade,
  -- The office's calendar date (Africa/Lagos), or none.
  due_on      date,
  status      text not null default 'open'
              check (status in ('open', 'in_progress', 'done', 'approved', 'cancelled')),
  -- What the assignee handed in with "done". Replaced if it is sent back and done again.
  done_note   text check (char_length(done_note) <= 2000),
  done_link   text check (char_length(done_link) <= 2000 and done_link ~* '^https?://\S+$'),
  done_at     timestamptz,
  -- Approved or cancelled: when, and by whom.
  closed_at   timestamptz,
  closed_by   uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (assigned_by <> assigned_to)
);

create index if not exists office_tasks_to_idx on public.office_tasks (assigned_to, status);
create index if not exists office_tasks_by_idx on public.office_tasks (assigned_by, status);
create index if not exists office_tasks_created_idx on public.office_tasks (created_at desc);

create table if not exists public.office_task_events (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.office_tasks(id) on delete cascade,
  actor      uuid references public.profiles(id) on delete set null,
  kind       text not null check (kind in ('assigned', 'started', 'done', 'approved', 'returned', 'cancelled')),
  note       text check (char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  -- Set once by /api/office/task-notify when the email for this step is sent.
  emailed_at timestamptz
);

create index if not exists office_task_events_task_idx on public.office_task_events (task_id, created_at);

-- The caller, if they are an active member of the team.
create or replace function public.office_task_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_team_member() then
    raise exception 'You are not on the team.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- An empty note is no note.
create or replace function public.office_task_text(p text, p_max int, p_what text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := nullif(btrim(p), '');
begin
  if char_length(v) > p_max then
    raise exception '% is too long (% characters at most).', p_what, p_max using errcode = '22023';
  end if;
  return v;
end;
$$;

create or replace function public.office_task_event(p_task uuid, p_kind text, p_note text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.office_task_events (task_id, actor, kind, note)
  values (p_task, auth.uid(), p_kind, p_note)
  returning id
$$;

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

create or replace function public.start_task(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.office_task_actor();
begin
  update public.office_tasks set status = 'in_progress', updated_at = now()
   where id = p_id and assigned_to = v_uid and status = 'open';
  if not found then
    raise exception 'That task is not waiting to be started.' using errcode = '22023';
  end if;
  return public.office_task_event(p_id, 'started', null);
end;
$$;

create or replace function public.complete_task(p_id uuid, p_note text default null, p_link text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := public.office_task_actor();
  v_note text := public.office_task_text(p_note, 2000, 'The note');
  v_link text := public.office_task_text(p_link, 2000, 'The link');
begin
  if v_link is not null and v_link !~* '^https?://\S+$' then
    raise exception 'The link must start with http:// or https://.' using errcode = '22023';
  end if;
  update public.office_tasks
     set status = 'done', done_note = v_note, done_link = v_link, done_at = now(), updated_at = now()
   where id = p_id and assigned_to = v_uid and status in ('open', 'in_progress');
  if not found then
    raise exception 'That task is not open.' using errcode = '22023';
  end if;
  return public.office_task_event(p_id, 'done', v_note);
end;
$$;

create or replace function public.review_task(p_id uuid, p_approve boolean, p_note text default null)
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
  if p_approve is null then
    raise exception 'Approve it or send it back.' using errcode = '22023';
  end if;
  select * into v_task from public.office_tasks where id = p_id for update;
  if not found or v_task.status <> 'done' then
    raise exception 'That task is not waiting for a check.' using errcode = '22023';
  end if;
  if v_task.assigned_to = v_uid or not (v_task.assigned_by = v_uid or public.is_task_admin()) then
    raise exception 'Only the person who gave the task, or an admin, checks it.' using errcode = '42501';
  end if;
  if p_approve then
    update public.office_tasks set status = 'approved', closed_at = now(), closed_by = v_uid, updated_at = now()
     where id = p_id;
    return public.office_task_event(p_id, 'approved', v_note);
  end if;
  if v_note is null then
    raise exception 'Say what still needs doing.' using errcode = '22023';
  end if;
  update public.office_tasks set status = 'in_progress', done_at = null, updated_at = now() where id = p_id;
  return public.office_task_event(p_id, 'returned', v_note);
end;
$$;

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

revoke execute on function public.is_task_admin()                          from public, anon, authenticated;
revoke execute on function public.office_task_actor()                      from public, anon, authenticated;
revoke execute on function public.office_task_text(text, int, text)        from public, anon, authenticated;
revoke execute on function public.office_task_event(uuid, text, text)      from public, anon, authenticated;
revoke execute on function public.create_task(uuid, text, text, date)      from public, anon, authenticated;
revoke execute on function public.start_task(uuid)                         from public, anon, authenticated;
revoke execute on function public.complete_task(uuid, text, text)          from public, anon, authenticated;
revoke execute on function public.review_task(uuid, boolean, text)         from public, anon, authenticated;
revoke execute on function public.cancel_task(uuid, text)                  from public, anon, authenticated;
grant  execute on function public.is_task_admin()                          to authenticated;
grant  execute on function public.create_task(uuid, text, text, date)      to authenticated;
grant  execute on function public.start_task(uuid)                         to authenticated;
grant  execute on function public.complete_task(uuid, text, text)          to authenticated;
grant  execute on function public.review_task(uuid, boolean, text)         to authenticated;
grant  execute on function public.cancel_task(uuid, text)                  to authenticated;

alter table public.office_tasks       enable row level security;
alter table public.office_task_events enable row level security;

revoke all on public.office_tasks, public.office_task_events from anon, authenticated;
grant select on public.office_tasks, public.office_task_events to authenticated;

drop policy if exists "Tasks you gave or got, or every task for an admin" on public.office_tasks;
create policy "Tasks you gave or got, or every task for an admin"
  on public.office_tasks for select to authenticated
  using (
    ((select auth.uid()) in (assigned_by, assigned_to) and (select public.is_team_member()))
    or (select public.is_task_admin())
  );

drop policy if exists "The history of tasks you can see" on public.office_task_events;
create policy "The history of tasks you can see"
  on public.office_task_events for select to authenticated
  using (exists (select 1 from public.office_tasks t where t.id = task_id));

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_tasks') then
    alter publication supabase_realtime add table public.office_tasks;
  end if;
end $$;

do $$
begin
  if to_regclass('public.office_tasks') is null or to_regclass('public.office_task_events') is null
     or to_regprocedure('public.is_task_admin()') is null
     or to_regprocedure('public.create_task(uuid, text, text, date)') is null
     or to_regprocedure('public.start_task(uuid)') is null
     or to_regprocedure('public.complete_task(uuid, text, text)') is null
     or to_regprocedure('public.review_task(uuid, boolean, text)') is null
     or to_regprocedure('public.cancel_task(uuid, text)') is null
     or not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_tasks') then
    raise exception '0011: something is missing.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('office_tasks', 'office_task_events') and cmd <> 'SELECT') then
    raise exception '0011: tasks change only through the functions.';
  end if;
  if not (select bool_and(relrowsecurity) from pg_class
           where oid in ('public.office_tasks'::regclass, 'public.office_task_events'::regclass)) then
    raise exception '0011: row level security is off.';
  end if;
  if has_table_privilege('authenticated', 'public.office_tasks', 'insert, update, delete')
     or has_table_privilege('authenticated', 'public.office_task_events', 'insert, update, delete')
     or has_function_privilege('authenticated', 'public.office_task_actor()', 'execute')
     or has_function_privilege('authenticated', 'public.office_task_event(uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.office_task_text(text, integer, text)', 'execute') then
    raise exception '0011: the browser can write tasks or call an internal function.';
  end if;
end $$;

commit;
