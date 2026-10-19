-- JustUsedTech office, 0001: the team. Who can sign in, and as whom.
--
-- APPLY FIRST, on a new Supabase project. Then 0002 to 0010 in order.
--
-- ============================================================================
-- HOW PEOPLE GET IN
-- ============================================================================
-- Nobody signs themselves up (turn public signups OFF in Authentication >
-- Sign In / Providers). A login only becomes a person in the office when its
-- email was invited first:
--   1. Mr Tito invites an email in Settings (api/team/invite). That writes a
--      row here in public.invites and emails a link to set a password.
--   2. When the login's email is confirmed (the link does that), the trigger
--      below creates the profile from the invite and deletes the invite.
-- A login with no invite gets no profile: it can read nothing, and the app
-- signs it out.
--
-- The very first person (Mr Tito) has nobody to invite him. By hand, once:
--   insert into public.invites (email, full_name, role) values ('<his email>', 'Titobi Oreolorun', 'manager');
--   then Authentication > Users > Add user > Create new user, that email, a
--   password, "Auto Confirm User" ticked. Then 0002's header: make him the
--   office manager.
--
-- ============================================================================
-- WHO CHANGES WHAT
-- ============================================================================
--   profiles   everyone on the team reads the team (names and photos on the
--              doors). A person may change their own name; only the office
--              manager (office_settings.manager_id, 0002) changes a role or
--              deactivates someone, and nobody deactivates themselves.
--              Emails never change here (they are the login's).
--   invites    the office manager only (read and delete); written by the
--              invite route with the service role.

begin;

create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null unique check (email = lower(email)),
  full_name      text not null check (char_length(btrim(full_name)) between 1 and 120),
  -- manager: Mr Tito. member: everyone else. The office's manager is still
  -- office_settings.manager_id (0002); this is how the screens label people.
  role           text not null default 'member' check (role in ('manager', 'member')),
  deactivated_at timestamptz,
  created_at     timestamptz not null default now()
);

create table if not exists public.invites (
  email      text primary key check (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  full_name  text not null check (char_length(btrim(full_name)) between 1 and 120),
  role       text not null default 'member' check (role in ('manager', 'member')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- An active person on the team. Every read policy in the office rests on it.
create or replace function public.is_team_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and deactivated_at is null)
$$;

-- Make the profile from the invite, once the login's email is confirmed.
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

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Created already confirmed (Auto Confirm in the dashboard) ...
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
-- ... or confirmed later (the invite link).
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (OLD.email_confirmed_at is null and NEW.email_confirmed_at is not null)
  execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.invites  enable row level security;

drop policy if exists "The team reads the team" on public.profiles;
create policy "The team reads the team"
  on public.profiles for select to authenticated
  using ((select public.is_team_member()));

-- Updates: your own row, or anyone's for the manager. What may change is the
-- guard's business (below); the manager check needs 0002's settings table, so
-- the policy that names it is in 0002.
drop policy if exists "Update your own profile" on public.profiles;
create policy "Update your own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()) and (select public.is_team_member()))
  with check (id = (select auth.uid()));

revoke insert, update, delete, truncate on public.profiles from anon, authenticated;
-- Updatable columns only; who may change which is the guard's business.
grant update (full_name, role, deactivated_at) on public.profiles to authenticated;
revoke all on public.invites from anon, authenticated;
revoke all on public.profiles from anon;

-- What a person may change about themselves: their name. Role, email and
-- deactivation are the manager's (0002 replaces this with the manager check
-- once office_settings exists); the service role and SQL editor are not limited.
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
    raise exception 'Only the office manager can change that.' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

revoke execute on function public.profiles_guard() from public, anon, authenticated;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.invites') is null
     or to_regprocedure('public.is_team_member()') is null
     or not exists (select 1 from pg_trigger where tgname = 'on_auth_user_created')
     or not exists (select 1 from pg_trigger where tgname = 'on_auth_user_confirmed') then
    raise exception '0001: something is missing.';
  end if;
end $$;

commit;
