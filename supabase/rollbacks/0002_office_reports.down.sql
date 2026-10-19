-- ROLLBACK of 0002 (daily reports). Run after 0003's and 0004's rollbacks.
-- DESTRUCTIVE: every report, flag, absence and office member is
-- deleted. Export the office_* tables first if they should be kept.
--
-- THE PROOF BUCKET IS NOT REMOVED HERE. Supabase refuses direct SQL deletes
-- on storage tables (files would be orphaned). After this runs: Storage >
-- `proof` > select all > delete, then delete the bucket, in the dashboard.
begin;

do $$
begin
  if to_regclass('public.office_presence') is not null then
    raise exception 'Roll back 0004 first (office_presence still exists).';
  end if;
  if exists (select 1 from cron.job where jobname = 'office-alerts') then
    raise exception 'Roll back 0003 first (the office-alerts job is still scheduled).';
  end if;
end $$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'office-raise-flags') then
    perform cron.unschedule('office-raise-flags');
  end if;
end $$;

drop policy if exists "Office members upload their own proof" on storage.objects;
drop policy if exists "Proof readable by its owner and the office manager" on storage.objects;

drop table if exists public.office_report_files;
drop table if exists public.office_flags;
drop table if exists public.office_reports;
drop table if exists public.office_absences;
drop table if exists public.office_alert_log;
drop table if exists public.office_members;
drop table if exists public.office_settings;

-- Section 14: the team goes back to 0001's rules (names only; no manager yet).
drop trigger if exists profiles_join_office on public.profiles;
drop function if exists public.profiles_join_office();
drop policy if exists "The manager updates the team" on public.profiles;
drop policy if exists "The manager reads invites" on public.invites;
drop policy if exists "The manager withdraws invites" on public.invites;
revoke select, delete on public.invites from authenticated;
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

drop function if exists public.office_mark_purged();
drop function if exists public.office_proof_due_for_purge(int);
drop function if exists public.raise_report_flags();
drop function if exists public.submit_report(text, text, text, jsonb);
drop function if exists public.office_roster(date, date);
drop function if exists public.office_expects_report(uuid, date);
drop function if exists public.is_office_member();
drop function if exists public.is_office_manager();
drop function if exists public.office_today();

commit;
