-- JustUsedTech office (ported from tito-crm), 0007: profile photos.
--
-- APPLY AFTER 0002 (it uses is_office_manager()) and 0001 (is_team_member()).
-- Additive only: one new nullable column, one trigger, one private storage
-- bucket and its policies. Nothing existing changes. Safe to apply before or
-- after the frontend that goes with it: until it is applied, the screens show
-- initials and hide the photo controls; once applied, today's main frontend
-- simply never reads the new column.
--
-- ============================================================================
-- WHERE A PHOTO LIVES
-- ============================================================================
-- In the PRIVATE bucket `avatars`, at <user id>/<random id>.<webp|jpg|png>,
-- at most 2 MB. The browser crops it to a square, resizes it to 512 px and
-- compresses it before uploading, so a real file is ~30-80 KB. Its path is on
-- the person's profile, profiles.avatar_path (profiles.avatar_url from
-- 0001 is left alone: it was never used, and a path is not a URL).
--
-- ============================================================================
-- WHO MAY DO WHAT
-- ============================================================================
--   Files          at most five in a person's folder (the app keeps one).
--   See photos     anyone on the team (is_team_member(): an active
--                  profiles row, staff included). The browser gets
--                  15-minute signed links; nobody outside the team can list
--                  or fetch the bucket.
--   Change a photo the person themself, or Mr Tito (office_settings.
--                  manager_id) for anyone. Enforced twice:
--                  - storage: uploads and deletes only in your own folder,
--                    or in any team member's folder for the manager;
--                  - profiles: a trigger refuses a new avatar_path unless the
--                    caller is that person or the manager, the file is in that
--                    person's folder, and it really exists in the bucket.
--                  The existing profiles update policies still decide who may
--                  update the row at all (yourself, or an admin, which is what
--                  Mr Tito is). A direct SQL editor session (no signed-in user)
--                  is not restricted.

begin;

alter table public.profiles
  add column if not exists avatar_path text
  constraint profiles_avatar_path_check
    check (avatar_path is null or avatar_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|png)$');

-- 0001 makes only named columns updatable: add this one (the guard below
-- decides whose photo may change).
grant update (avatar_path) on public.profiles to authenticated;

create or replace function public.profiles_avatar_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text := case when TG_OP = 'UPDATE' then OLD.avatar_path end;
begin
  if NEW.avatar_path is not distinct from v_old then
    return NEW;
  end if;

  if auth.uid() is not null and auth.uid() <> NEW.id and not public.is_office_manager() then
    raise exception 'Only the person or Mr Tito can change this photo.' using errcode = '42501';
  end if;

  if NEW.avatar_path is not null then
    if split_part(NEW.avatar_path, '/', 1) <> NEW.id::text then
      raise exception 'A photo must be in its owner''s folder.' using errcode = '42501';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'avatars' and name = NEW.avatar_path) then
      raise exception 'That photo has not finished uploading. Try again.' using errcode = '22023';
    end if;
  end if;

  return NEW;
end;
$$;

revoke execute on function public.profiles_avatar_guard() from public, anon, authenticated;

drop trigger if exists profiles_avatar_guard on public.profiles;
-- Insert too, although profiles are only created by handle_new_user() (0001)
-- with no photo: a future insert path cannot skip the guard.
create trigger profiles_avatar_guard
  before insert or update of avatar_path on public.profiles
  for each row execute function public.profiles_avatar_guard();

-- How many files a folder holds, for the upload policy's cap. A function, not
-- a subquery: a policy on storage.objects that reads storage.objects is
-- refused by Postgres as infinite recursion. It tells a team member no more
-- than a count of files in a folder.
create or replace function public.avatar_folder_count(p_folder text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from storage.objects
   where bucket_id = 'avatars' and (storage.foldername(name))[1] = p_folder;
$$;

revoke execute on function public.avatar_folder_count(text) from public, anon, authenticated;
grant execute on function public.avatar_folder_count(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Team members see profile photos" on storage.objects;
create policy "Team members see profile photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (select public.is_team_member()));

-- Your own folder, or (for the manager) any team member's, and at most five
-- files in a folder, so nobody can fill the bucket (the app keeps one: it
-- removes the rest of the folder after each change). No update policy: a new
-- photo is a new file, so a link handed out for the old one can never show the
-- new one by accident.
drop policy if exists "Upload your own profile photo" on storage.objects;
create policy "Upload your own profile photo"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (select public.is_team_member())
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_office_manager()))
    and exists (select 1 from public.profiles u where u.id::text = (storage.foldername(name))[1])
    and public.avatar_folder_count((storage.foldername(name))[1]) < 5
  );

drop policy if exists "Remove your own profile photo" on storage.objects;
create policy "Remove your own profile photo"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (select public.is_team_member())
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_office_manager()))
  );

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand after applying.
-- ===========================================================================
--
-- -- V1. The column, the trigger and the bucket.
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'profiles' and column_name = 'avatar_path';
-- select tgname from pg_trigger where tgname = 'profiles_avatar_guard';
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatars';
--
-- -- V2. Who has a photo.
-- select full_name, avatar_path from public.profiles where avatar_path is not null;
