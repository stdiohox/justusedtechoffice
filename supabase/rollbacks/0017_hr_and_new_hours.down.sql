-- ROLLBACK of 0017. Run by hand, newest first: this one before 0016's.
-- Puts the day back to 0014's 11:00/11:15, 15:00-16:00, 19:00/20:30, turns
-- every HR person back into a member, and leaves Mr Tito the only one who sees
-- the team.
begin;

update public.office_settings
   set signin_reminder = '11:00',
       signin_deadline = '11:15',
       midday_opens    = '15:00',
       midday_deadline = '16:00',
       eod_opens       = '19:00',
       eod_deadline    = '20:30'
 where id = 1;

update public.profiles set role = 'member' where role = 'hr';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('manager', 'member'));

-- 0002's.
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

-- 0008's and 0010's (is_office_manager() is Mr Tito alone again).
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
  if not public.is_office_manager()
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
  if not public.is_office_manager()
     or not exists (select 1 from public.profiles where id = auth.uid() and deactivated_at is null) then
    raise exception 'Only Mr Tito can change this.' using errcode = '42501';
  end if;
  if p_minutes is not null and p_minutes not between 60 and 480 then
    raise exception 'A short day is set between 1 and 8 hours.' using errcode = '22023';
  end if;
  update public.office_settings set short_day_minutes = p_minutes where id = 1;
end;
$$;

-- 0016's.
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

-- 0002's.
drop policy if exists "Manager updates office members" on public.office_members;
create policy "Manager updates office members"
  on public.office_members for update to authenticated
  using ((select public.is_office_manager())) with check ((select public.is_office_manager()));
drop policy if exists "Manager removes office members" on public.office_members;
create policy "Manager removes office members"
  on public.office_members for delete to authenticated using ((select public.is_office_manager()));

drop function if exists public.is_office_head();

commit;
