-- ROLLBACK of 0008 (office activity). Run after 0009's rollback (newest
-- first); refuses while 0009 is still applied. 
-- DESTRUCTIVE: every stay in the office (entries), check-in, mode and day
-- note, and the activity timings in office_settings. Presence stretches
-- recorded as 'outside' become 'online' (0004 has no 'outside'). The
-- heartbeat and the sign-in gate go back to 0004's exactly.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.office_time_summary(date,date)') is not null then
    raise exception 'Roll back 0009 first (supabase/rollbacks/0045_office_time_summary.down.sql).';
  end if;
end $$;

select cron.unschedule(jobname) from cron.job where jobname in ('office-activity-sweep', 'office-activity-prune');

do $$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_checkins') then
    alter publication supabase_realtime drop table public.office_checkins;
  end if;
end $$;

drop trigger if exists office_reports_entries on public.office_reports;

drop function if exists public.office_activity_sweep();
drop function if exists public.set_office_enforcement(boolean);
drop function if exists public.add_day_note(date, text);
drop function if exists public.office_leave();
drop function if exists public.office_rejoin(text);
drop function if exists public.answer_checkin(uuid, boolean);
drop function if exists public.set_office_mode(text, int);
drop function if exists public.office_my_state();
drop function if exists public.office_assert_member();
drop function if exists public.office_reports_entries();
drop function if exists public.office_close_entry(uuid, text);
drop function if exists public.office_open_entry(uuid, text, text, timestamptz);
drop function if exists public.office_cancel_checkins(uuid);
drop function if exists public.office_next_checkin();

drop table if exists public.office_day_notes;       -- also drops their policies
drop table if exists public.office_checkins;
drop table if exists public.office_entries;
drop table if exists public.office_activity_state;

update public.office_presence set status = 'online' where status = 'outside';
alter table public.office_presence drop constraint if exists office_presence_status_check;
alter table public.office_presence add constraint office_presence_status_check
  check (status in ('online', 'away', 'busy'));

alter table public.office_settings drop constraint if exists office_settings_activity_check;
alter table public.office_settings
  drop column if exists away_signout_minutes,
  drop column if exists checkin_every_minutes,
  drop column if exists checkin_answer_minutes,
  drop column if exists busy_max_minutes,
  drop column if exists outside_max_minutes,
  drop column if exists enforce_activity;

-- 0004's gate and heartbeat, exactly.
create or replace function public.office_signed_in_today()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not public.office_expects_report(
           auth.uid(), (now() at time zone (select timezone from public.office_settings where id = 1))::date)
      or exists (
           select 1 from public.office_reports
            where user_id = auth.uid() and kind = 'signin'
              and work_date = (now() at time zone (select timezone from public.office_settings where id = 1))::date
         )
$$;

create or replace function public.office_heartbeat(p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_last public.office_presence%rowtype;
begin
  if v_uid is null or not public.is_office_member() then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  if p_status not in ('online', 'away', 'busy') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if not public.office_signed_in_today() then
    raise exception 'File your sign-in to enter the office.' using errcode = '42501';
  end if;

  -- Lock this person's latest stretch, so two tabs beating at once extend
  -- one row instead of starting two.
  select * into v_last from public.office_presence
   where user_id = v_uid order by started_at desc limit 1 for update;

  if found and v_last.last_seen_at > now() - interval '5 minutes' then
    if v_last.status = p_status then
      -- Throttled: a beat inside 20 s of the last one changes nothing.
      if v_last.last_seen_at < now() - interval '20 seconds' then
        update public.office_presence set last_seen_at = now() where id = v_last.id;
      end if;
      return;
    end if;
    -- A status that flipped within 20 s of starting rewrites that stretch
    -- instead of starting another.
    if v_last.started_at > now() - interval '20 seconds' then
      update public.office_presence set status = p_status, last_seen_at = now() where id = v_last.id;
      return;
    end if;
  end if;

  -- At most 300 stretches a day each: past that, extend the last one.
  if found and (select count(*) from public.office_presence
                 where user_id = v_uid and started_at > now() - interval '1 day') >= 300 then
    update public.office_presence set last_seen_at = now() where id = v_last.id;
    return;
  end if;

  insert into public.office_presence (user_id, status) values (v_uid, p_status);
end;
$$;

revoke execute on function public.office_signed_in_today() from public, anon, authenticated;
revoke execute on function public.office_heartbeat(text)       from public, anon, authenticated;
grant  execute on function public.office_signed_in_today() to authenticated;
grant  execute on function public.office_heartbeat(text)       to authenticated;

commit;
