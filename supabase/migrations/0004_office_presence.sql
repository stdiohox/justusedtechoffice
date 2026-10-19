-- JustUsedTech office (ported from tito-crm), 0004: the office map's presence (VIRTUAL-OFFICE-PLAN Phase 2).
--
-- APPLY AFTER 0002. Safe before the frontend ships.
--
-- ============================================================================
-- TWO LAYERS
-- ============================================================================
-- LIVE: Supabase Realtime Presence on the private channel `office`. Each open
-- office tab of an office member tracks { status } there; the map reads it.
-- Nothing is stored. The policies below on realtime.messages are what make
-- the channel private: only office members (and Mr Tito) may join, read or
-- track. The client opens it with { private: true }, and Realtime keeps
-- private and public channels of the same name apart (it keys the internal
-- topic as "<tenant>-private:office" vs "<tenant>:office"), so a public
-- joiner of "office" can neither see nor fake this presence.
--
-- LEAVE Supabase > Realtime > Settings > "Allow public access" ON. Turning it
-- off rejects every non-private channel, which would break Realtime's live
-- new-lead feed and the office's live updates (all public channels).
--
-- HISTORY: office_presence, one row per stretch of one status, written only by
-- office_heartbeat(). The browser calls it when its status changes and every
-- two minutes while open. A heartbeat that matches the current stretch (same
-- status, last seen under five minutes ago) extends it; anything else starts a
-- new stretch. Gaps between stretches are time offline. The clock is the
-- database's, so "first in" and "last seen" cannot be claimed. Beats are
-- throttled (20 s), a quick flip of status rewrites the stretch it is in, and
-- a person has at most 300 stretches a day, so nobody can flood the table or
-- push colleagues out of Mr Tito's day view. Kept 90 days, like the proof.
--
-- Presence is client-reported and therefore indicative: a tab left open reads
-- as online, and a determined member could show a colleague on the live map
-- (the channel trusts the presence key the browser sends). The record in
-- office_presence cannot be forged; the reports (0002) remain the
-- accountability record.
--
-- THE SIGN-IN GATE: on a day a report is due from you, the office does not
-- show you as in until you have filed your sign-in. office_heartbeat() refuses
-- before that, and the map shows you as not yet signed in.

begin;

create table if not exists public.office_presence (
  id           bigserial primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  status       text not null check (status in ('online', 'away', 'busy')),
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists office_presence_user_idx on public.office_presence (user_id, started_at desc);
create index if not exists office_presence_started_idx on public.office_presence (started_at);

-- Has the caller cleared the sign-in gate today? No argument on purpose: a
-- colleague's sign-in is in their reports, which RLS keeps from you.
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

alter table public.office_presence enable row level security;

-- Written only through office_heartbeat(). Read: your own, or Mr Tito all.
drop policy if exists "Own presence, or the manager" on public.office_presence;
create policy "Own presence, or the manager"
  on public.office_presence for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));

-- ---------------------------------------------------------------------------
-- The private Realtime channel `office`
-- ---------------------------------------------------------------------------
drop policy if exists "Office members read the office channel" on realtime.messages;
create policy "Office members read the office channel"
  on realtime.messages for select to authenticated
  using (realtime.topic() = 'office' and (select public.is_office_member()));

drop policy if exists "Office members track presence in the office channel" on realtime.messages;
create policy "Office members track presence in the office channel"
  on realtime.messages for insert to authenticated
  with check (realtime.topic() = 'office' and extension = 'presence' and (select public.is_office_member()));

-- ---------------------------------------------------------------------------
-- Retention: the same 90 days as the proof (office_settings).
-- ---------------------------------------------------------------------------
-- TO STOP IT: select cron.unschedule('office-presence-prune');
select cron.schedule('office-presence-prune', '23 3 * * *', $job$
  delete from public.office_presence
   where started_at < now() - make_interval(days => (select proof_retention_days from public.office_settings where id = 1))
$job$);

commit;

-- ===========================================================================
-- VERIFICATION. Run by hand after applying.
-- ===========================================================================
-- -- V1. Today's stretches, newest first.
-- select u.full_name, p.status, p.started_at, p.last_seen_at
--   from public.office_presence p join public.profiles u on u.id = p.user_id
--  where p.started_at > now() - interval '1 day' order by p.started_at desc;
