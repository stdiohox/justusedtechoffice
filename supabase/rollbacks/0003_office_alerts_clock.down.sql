-- ROLLBACK of 0003 (the office alerts clock). Stops the five-minute call to
-- /api/cron/office-alerts. No data is touched. Safe on its own.
begin;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'office-alerts') then
    perform cron.unschedule('office-alerts');
  end if;
end $$;

commit;

-- Optional, by hand: the Vault entry 0003 asked for is no longer needed.
--   delete from vault.secrets where name = 'office_alerts_url';
-- The cron_secret Vault value can stay or go; nothing else reads it.
