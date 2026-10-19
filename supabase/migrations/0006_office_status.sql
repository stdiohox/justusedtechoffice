-- JustUsedTech office (ported from tito-crm), 0006: "working on", "back at" / "out until".
--
-- APPLY AFTER 0002 (it uses office_today(), is_office_member() and
-- is_office_manager()). One new table, one function, one table added to the
-- Realtime publication. (tito-crm's 0042 also had a work feed from the CRM's
-- activity log; this office has no CRM, so it is left out.)
--
-- ============================================================================
-- 1. office_status: what each person says about their day
-- ============================================================================
-- One row per person, written only through set_office_status().
--   working_on  a short line on their door ("Calling the Q4 retirement leads")
--   back_at     "back at 14:30", on the office clock
--   out_until   "out until Thursday", the last day they are out
--   set_on      the office day the row was written. working_on and back_at
--               belong to that day only: the screens ignore them from the next
--               day, so nothing has to run at midnight to clear them.
--               out_until spans days and is shown while today <= out_until.
-- The person says it; nothing is tracked. It is not leave: flags and
-- reminders still follow office_absences, which only Mr Tito sets.
--
-- Readable by everyone in the office (it is what is written on their door),
-- and by nobody else. (Realtime does not filter DELETE events by RLS; a
-- delete carries only the primary key, so a subscriber outside the office
-- could at most learn that some user_id cleared a door.) No insert/update/delete policies: the function is the
-- only writer, so the date, the length limits and the 60-day cap on
-- out_until cannot be bypassed.
--

begin;

do $$
begin
  if to_regprocedure('public.is_office_member()') is null
     or to_regprocedure('public.office_today()') is null then
    raise exception '0006 needs 0002 (the office tables and functions). Apply 0002 first.';
  end if;
end $$;


create table if not exists public.office_status (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  working_on text check (working_on is null or char_length(working_on) between 1 and 120),
  back_at    time,
  out_until  date,
  set_on     date not null,
  updated_at timestamptz not null default now()
);

comment on table public.office_status is
  'What each office member says on their door (0006). working_on and back_at are for set_on only; out_until spans days. Written only by set_office_status().';

alter table public.office_status enable row level security;

drop policy if exists "Office members read the office's doors" on public.office_status;
create policy "Office members read the office's doors"
  on public.office_status for select to authenticated
  using ((select public.is_office_member()));

create or replace function public.set_office_status(
  p_working_on text,
  p_back_at    time,
  p_out_until  date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date;
  v_line  text := nullif(btrim(regexp_replace(coalesce(p_working_on, ''), '\s+', ' ', 'g')), '');
begin
  if v_uid is null or not public.is_office_member()
     or not exists (select 1 from public.profiles where id = v_uid and deactivated_at is null) then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  v_today := public.office_today();
  if v_line is not null and char_length(v_line) > 120 then
    raise exception 'Keep it to 120 characters.' using errcode = '22023';
  end if;
  if p_out_until is not null and (p_out_until < v_today or p_out_until > v_today + 60) then
    raise exception 'Out until must be today or within the next 60 days.' using errcode = '22023';
  end if;

  -- All three empty: clear the door.
  if v_line is null and p_back_at is null and p_out_until is null then
    delete from public.office_status where user_id = v_uid;
    return;
  end if;

  insert into public.office_status (user_id, working_on, back_at, out_until, set_on, updated_at)
  values (v_uid, v_line, p_back_at, p_out_until, v_today, now())
  on conflict (user_id) do update
     set working_on = excluded.working_on,
         back_at    = excluded.back_at,
         out_until  = excluded.out_until,
         set_on     = excluded.set_on,
         updated_at = excluded.updated_at;
end;
$$;

revoke execute on function public.set_office_status(text, time, date) from public, anon, authenticated;
grant  execute on function public.set_office_status(text, time, date) to authenticated;

-- Doors update live for everyone in the office (RLS applies to Realtime).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_status') then
    alter publication supabase_realtime add table public.office_status;
  end if;
end $$;

-- Self-check: the migration refuses to finish half-right.
do $$
begin
  if to_regclass('public.office_status') is null
     or to_regprocedure('public.set_office_status(text,time,date)') is null then
    raise exception '0006: something is missing.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'office_status' and cmd <> 'SELECT') then
    raise exception '0006: office_status must have no write policy.';
  end if;
end $$;

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand after applying.
-- ===========================================================================
-- -- V1. Everyone's door today.
-- select u.full_name, s.working_on, s.back_at, s.out_until, s.set_on
--   from public.office_status s join public.profiles u on u.id = s.user_id;
-- -- V2. Realtime carries it.
-- select tablename from pg_publication_tables
--  where pubname = 'supabase_realtime' and tablename = 'office_status';
