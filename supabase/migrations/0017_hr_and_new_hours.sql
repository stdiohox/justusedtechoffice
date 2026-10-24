-- JustUsedTech office, 0017: the day's new hours, and HR (Emmanuella).
--
-- APPLY AFTER 0016, then deploy straight after (the screens read the times
-- from office_settings, and HR's screens come with the deploy). Safe before
-- the deploy: nothing an open tab calls changes shape.
--
-- Asked 2026-10-24:
--
-- 1. THE DAY: sign-in from 09:00 (on time until 11:00), the midday report as
--    it was (15:00 to 16:00), the end-of-day report from 17:00 (on time until
--    19:00). Reminders, the time figures (09:00 to 19:00), Mr Tito's daily
--    summary (after 19:00), a start said before sign-in (before 09:00) and the
--    leaderboard week (closes Friday 19:00) all follow, as they read these
--    settings. The first week after this counts from Friday 23 Oct 19:00, so
--    anything between 19:00 and 20:30 that Friday counts in both weeks once.
--
-- 2. HR: a third access level, profiles.role = 'hr', for Emmanuella
--    (hr@justusedtech.org). She sees what Mr Tito sees and runs the people:
--    every report, proof file, time figure, note, flag and task; invites,
--    pausing and removing people, days away, photos, switching people off and
--    on, names and job titles. She still files her own reports (only
--    office_settings.manager_id is exempt) and is on the leaderboard. The
--    alerts route copies Mr Tito's alert and summary emails to her.
--
--    How: is_office_manager(), the one check behind every "Mr Tito sees it"
--    policy and function, now means Mr Tito OR an active HR person (not
--    switched off, not paused in the office). is_office_head() is Mr Tito
--    alone, and keeps what stays his:
--      - the office's rules: trial or enforced, and the short day;
--      - his own account and office place (HR cannot switch him off, rename
--        him, pause or remove him), and her own office place (she cannot
--        pause or remove herself, which would lock her out);
--      - who has which access: only Mr Tito (or the SQL editor) changes
--        profiles.role. The manager seat itself is changed by hand, as before.
--    Nobody is invited as HR: she is invited as a member, then made HR by the
--    update in section 3 (it is in this file, and does nothing until her
--    login exists; rerun it after she joins if she had not).

begin;

-- ---------------------------------------------------------------------------
-- 1. The day's hours
-- ---------------------------------------------------------------------------
update public.office_settings
   set signin_reminder = '09:00',
       signin_deadline = '11:00',
       midday_opens    = '15:00',
       midday_deadline = '16:00',
       eod_opens       = '17:00',
       eod_deadline    = '19:00'
 where id = 1;

-- ---------------------------------------------------------------------------
-- 2. HR
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('manager', 'hr', 'member'));

-- Mr Tito alone (0002's is_office_manager, renamed).
create or replace function public.is_office_head()
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

-- Mr Tito, or an HR person who is active on the team and in the office.
-- Every policy and function that asks "is this Mr Tito" now lets HR in.
create or replace function public.is_office_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_office_head()
      or exists (
           select 1 from public.profiles u
             join public.office_members m on m.user_id = u.id
            where u.id = auth.uid() and u.role = 'hr' and u.deactivated_at is null and m.active
         )
$$;

revoke execute on function public.is_office_head() from public, anon, authenticated;
grant  execute on function public.is_office_head() to authenticated;

-- The office's rules stay Mr Tito's (0008, 0010, with is_office_head()).
create or replace function public.set_office_enforcement(p_on boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_on is null then
    raise exception 'Say on or off.' using errcode = '22023';
  end if;
  if not public.is_office_head()
     or not exists (select 1 from public.profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Only Mr Tito can change this.' using errcode = '42501';
  end if;
  update public.office_settings set enforce_activity = p_on where id = 1;
end;
$$;

create or replace function public.set_short_day(p_minutes int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_office_head()
     or not exists (select 1 from public.profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Only Mr Tito can change this.' using errcode = '42501';
  end if;
  if p_minutes is not null and p_minutes not between 60 and 480 then
    raise exception 'A short day is set between 1 and 8 hours.' using errcode = '22023';
  end if;
  update public.office_settings set short_day_minutes = p_minutes where id = 1;
end;
$$;

-- 0016's profiles_guard, plus: access levels, and Mr Tito's own account, are his.
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_head boolean;
  v_tito uuid;
begin
  if auth.uid() is null then
    return NEW;
  end if;
  v_head := public.is_office_head();
  v_tito := (select manager_id from public.office_settings where id = 1);
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
    if NEW.role is distinct from OLD.role and not v_head then
      raise exception 'Only Mr Tito changes who has which access.' using errcode = '42501';
    end if;
    if NEW.id = v_tito and not v_head then
      raise exception 'Only Mr Tito can change that on his own account.' using errcode = '42501';
    end if;
  end if;
  if NEW.job_title is distinct from OLD.job_title and not public.is_task_admin() then
    raise exception 'Only Mr Tito or an admin can change a role.' using errcode = '42501';
  end if;
  if NEW.id <> auth.uid() and NEW.full_name is distinct from OLD.full_name
     and (not public.is_office_manager() or (NEW.id = v_tito and not v_head)) then
    raise exception 'Only the person, Mr Tito or HR can change a name.' using errcode = '42501';
  end if;
  NEW.job_title := nullif(btrim(NEW.job_title), '');
  return NEW;
end;
$$;

revoke execute on function public.profiles_guard() from public, anon, authenticated;

-- Pausing and removing people (0002): HR too, but not Mr Tito's place, nor her own.
drop policy if exists "Manager updates office members" on public.office_members;
create policy "Manager updates office members"
  on public.office_members for update to authenticated
  using ((select public.is_office_manager())
         and ((select public.is_office_head())
              or (user_id is distinct from (select s.manager_id from public.office_settings s where s.id = 1)
                  and user_id <> (select auth.uid()))))
  with check ((select public.is_office_manager())
         and ((select public.is_office_head())
              or (user_id is distinct from (select s.manager_id from public.office_settings s where s.id = 1)
                  and user_id <> (select auth.uid()))));
drop policy if exists "Manager removes office members" on public.office_members;
create policy "Manager removes office members"
  on public.office_members for delete to authenticated
  using ((select public.is_office_manager())
         and ((select public.is_office_head())
              or (user_id is distinct from (select s.manager_id from public.office_settings s where s.id = 1)
                  and user_id <> (select auth.uid()))));

-- ---------------------------------------------------------------------------
-- 3. Emmanuella. Nothing happens if her login does not exist yet.
-- ---------------------------------------------------------------------------
update public.profiles set role = 'hr' where email = 'hr@justusedtech.org';

do $$
begin
  if exists (select 1 from public.office_settings where id = 1
              and (signin_reminder, signin_deadline, midday_opens, midday_deadline, eod_opens, eod_deadline)
                  is distinct from (time '09:00', time '11:00', time '15:00', time '16:00', time '17:00', time '19:00'))
     or to_regprocedure('public.is_office_head()') is null
     or (select prosrc from pg_proc where oid = 'public.is_office_manager()'::regprocedure) not like '%''hr''%'
     or (select prosrc from pg_proc where oid = 'public.set_office_enforcement(boolean)'::regprocedure) not like '%is_office_head()%'
     or (select prosrc from pg_proc where oid = 'public.set_short_day(integer)'::regprocedure) not like '%is_office_head()%'
     or (select prosrc from pg_proc where oid = 'public.profiles_guard()'::regprocedure) not like '%who has which access%'
     or not exists (select 1 from pg_constraint where conname = 'profiles_role_check'
                     and pg_get_constraintdef(oid) like '%hr%') then
    raise exception '0017: something is missing.';
  end if;
  if has_function_privilege('anon', 'public.is_office_head()', 'execute') then
    raise exception '0017: the wrong role can call a function.';
  end if;
end $$;

commit;

-- After it runs:
--   select email, role from public.profiles where role in ('manager', 'hr');
-- Emmanuella shows as hr once she has signed in for the first time. If she
-- had not joined yet when this ran, invite her (Settings), and after she has
-- signed in run:
--   update public.profiles set role = 'hr' where email = 'hr@justusedtech.org';
