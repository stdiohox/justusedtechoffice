-- ROLLBACK of 0004 (presence). Run after 0005's rollback. DESTRUCTIVE: the
-- presence history (office_presence) is deleted.
begin;

do $$
begin
  if to_regclass('public.office_knocks') is not null then
    raise exception 'Roll back 0005 first (office_knocks still exists).';
  end if;
end $$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'office-presence-prune') then
    perform cron.unschedule('office-presence-prune');
  end if;
end $$;

drop policy if exists "Office members read the office channel" on realtime.messages;
drop policy if exists "Office members track presence in the office channel" on realtime.messages;

drop table if exists public.office_presence;
drop function if exists public.office_heartbeat(text);
drop function if exists public.office_signed_in_today();

commit;
