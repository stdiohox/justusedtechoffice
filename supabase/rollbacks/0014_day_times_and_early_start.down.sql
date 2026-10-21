-- ROLLBACK of 0014. Run by hand, newest first: this one before 0013's.
-- Puts the day back to 09:00/09:15, 13:00-14:00, 17:00-18:30, deletes every
-- declared early start, and closes the leaderboard week at Friday 17:00 again.
begin;

update public.office_settings
   set signin_reminder = '09:00',
       signin_deadline = '09:15',
       midday_opens    = '13:00',
       midday_deadline = '14:00',
       eod_opens       = '17:00',
       eod_deadline    = '18:30'
 where id = 1;

drop function if exists public.office_day_starts_range(date, date);
drop function if exists public.declare_day_start(time, text);
drop table if exists public.office_day_starts;

-- 0012's week (a fixed Friday 17:00).
create or replace function public.office_week_window(p_weeks_ago int default 0)
returns table (starts_at timestamptz, ends_at timestamptz, closed boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz     text := (select timezone from public.office_settings where id = 1);
  v_local  timestamp := now() at time zone v_tz;
  v_anchor timestamp;
begin
  if v_tz is null then
    raise exception 'The office has no settings row (0002).' using errcode = '55000';
  end if;
  if p_weeks_ago is null or p_weeks_ago not between 0 and 52 then
    raise exception 'Weeks ago runs from 0 to 52.' using errcode = '22023';
  end if;
  -- The most recent Friday 17:00 at or before now, office time (ISO 5 = Friday).
  v_anchor := date_trunc('day', v_local)
              - make_interval(days => (extract(isodow from v_local)::int - 5 + 7) % 7)
              + time '17:00';
  if v_anchor > v_local then
    v_anchor := v_anchor - interval '7 days';
  end if;
  starts_at := (v_anchor - make_interval(days => 7 * p_weeks_ago)) at time zone v_tz;
  ends_at   := case when p_weeks_ago = 0 then now()
                    else (v_anchor - make_interval(days => 7 * (p_weeks_ago - 1))) at time zone v_tz end;
  closed    := p_weeks_ago > 0;
  return next;
end;
$$;

commit;
