-- JustUsedTech office (ported from tito-crm), 0003: the clock that sends the office's email alerts.
--
-- APPLY LAST of all (after 0010), once the app is deployed on Vercel with its
-- secrets (CRON_SECRET, RESEND_API_KEY, OFFICE_BASE_URL, ...) and the route
-- has been called once by hand (V3 below). From the moment this commits,
-- Postgres calls the route every five minutes and the office emails start.
-- It is numbered 0003 because it belongs with the reports; it only needs 0002.
--
-- ============================================================================
-- BEFORE RUNNING: TWO VALUES IN SUPABASE VAULT, BY HAND
-- ============================================================================
--   select vault.create_secret('<the same value as CRON_SECRET in Vercel>', 'cron_secret',
--     'Bearer secret for the office alerts route');
--   select vault.create_secret('https://<the office domain>/api/cron/office-alerts', 'office_alerts_url',
--     'Where pg_cron sends the five-minute office alerts call');
--
-- TO STOP IT:   select cron.unschedule('office-alerts');
-- Nothing is lost by stopping: unsent flags keep notified_at null and are
-- picked up by the next run (for up to 12 hours), and the day's reports are
-- in the office regardless.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

begin;

do $$
declare
  v_secret text;
  v_url    text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'office_alerts_url';

  if v_secret is null or v_url is null then
    raise exception '0003: cron_secret and office_alerts_url must both be in Supabase Vault (see the header). Nothing was scheduled.';
  end if;
  if not exists (select 1 from cron.job where jobname = 'office-raise-flags') then
    raise exception '0003: apply 0002 first (its office-raise-flags job is missing).';
  end if;
  if v_secret <> btrim(v_secret, E' \t\r\n') or length(v_secret) < 16 then
    raise exception '0003: cron_secret looks wrong (whitespace, or under 16 characters).';
  end if;
  if v_url <> btrim(v_url, E' \t\r\n') then
    raise exception '0003: office_alerts_url has leading or trailing whitespace; re-create it without.';
  end if;
  if v_url not like 'https://%/api/cron/office-alerts' then
    raise exception '0003: office_alerts_url must be the https URL of /api/cron/office-alerts, got %', v_url;
  end if;
end $$;

-- Five minutes, offset by one so it runs just after office-raise-flags
-- (0002, on the five) has raised the flags it will report.
select cron.schedule(
  'office-alerts',
  '1-56/5 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'office_alerts_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);

do $$
declare
  v_cmd    text;
  v_secret text;
begin
  select command into v_cmd from cron.job where jobname = 'office-alerts';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_cmd is null then
    raise exception '0003: the office-alerts job was not scheduled.';
  end if;
  if position('vault.decrypted_secrets' in v_cmd) = 0 or position(v_secret in v_cmd) > 0 then
    raise exception '0003: the job command embeds the secret instead of reading it from Vault.';
  end if;
  raise notice '0003: office-alerts runs every five minutes. Watch net._http_response.';
end $$;

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand.
-- ===========================================================================
--
-- -- V1. The job exists.
-- select jobname, schedule, active from cron.job where jobname = 'office-alerts';
--
-- -- V2. What the route answered. 200 = clean; 500 = the body says what failed
-- --     (Resend refusing a send, no manager set, the purge); 401 = the
-- --     Vault secret does not match CRON_SECRET in Vercel.
-- select status_code, timed_out, left(content::text, 300) as body, created
--   from net._http_response order by created desc limit 10;
--
-- -- V3. Before applying, call the route once by hand from a terminal:
-- --   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<the office domain>/api/cron/office-alerts
