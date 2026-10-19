-- ROLLBACK of 0007 (profile photos). Independent of every other office
-- migration: run it on its own, any time.
--
-- DESTRUCTIVE for the links only: every profile's avatar_path is dropped
-- with the column, so the screens fall back to initials. THE PHOTO FILES ARE
-- NOT REMOVED HERE: Supabase refuses SQL deletes on storage tables. After
-- this runs: Storage > `avatars` > select all > delete, then delete the
-- bucket, in the dashboard.
begin;

drop trigger if exists profiles_avatar_guard on public.profiles;
drop function if exists public.profiles_avatar_guard();

drop policy if exists "Team members see profile photos" on storage.objects;
drop policy if exists "Upload your own profile photo" on storage.objects;
drop policy if exists "Remove your own profile photo" on storage.objects;
drop function if exists public.avatar_folder_count(text);

alter table public.profiles drop column if exists avatar_path;

commit;
