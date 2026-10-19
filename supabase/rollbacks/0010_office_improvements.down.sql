-- ROLLBACK of 0010 (office improvements). Run first (newest first); nothing
-- depends on it. DESTRUCTIVE for what 0010 added only: replies to knocks,
-- reasons on doors, onboarding steps, notice acknowledgements and the
-- short-day setting. knock(), respond_knock() and set_office_status() go back
-- to 0005's and 0006's exactly. The screens fall back by themselves.
begin;

-- It drops columns (a brief exclusive lock): fail fast rather than queue.
set local lock_timeout = '5s';

drop function if exists public.set_short_day(int);
drop function if exists public.office_onboarding_status(int);
drop function if exists public.ack_office_notice(int);
drop function if exists public.complete_onboarding_task(text);

-- 0006's set_office_status().
drop function if exists public.set_office_status(text, time, date, text);
create or replace function public.set_office_status(
  p_working_on text,
  p_back_at    time,
  p_out_until  date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date;
  v_line  text := nullif(btrim(regexp_replace(coalesce(p_working_on, ''), '\s+', ' ', 'g')), '');
begin
  if v_uid is null or not public.is_office_member()
     or not exists (select 1 from public.profiles where id = v_uid and deactivated_at is null) then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  v_today := public.office_today();
  if v_line is not null and char_length(v_line) > 120 then
    raise exception 'Keep it to 120 characters.' using errcode = '22023';
  end if;
  if p_out_until is not null and (p_out_until < v_today or p_out_until > v_today + 60) then
    raise exception 'Out until must be today or within the next 60 days.' using errcode = '22023';
  end if;

  -- All three empty: clear the door.
  if v_line is null and p_back_at is null and p_out_until is null then
    delete from public.office_status where user_id = v_uid;
    return;
  end if;

  insert into public.office_status (user_id, working_on, back_at, out_until, set_on, updated_at)
  values (v_uid, v_line, p_back_at, p_out_until, v_today, now())
  on conflict (user_id) do update
     set working_on = excluded.working_on,
         back_at    = excluded.back_at,
         out_until  = excluded.out_until,
         set_on     = excluded.set_on,
         updated_at = excluded.updated_at;
end;
$$;
revoke execute on function public.set_office_status(text, time, date) from public, anon, authenticated;
grant  execute on function public.set_office_status(text, time, date) to authenticated;

-- 0005's respond_knock().
drop function if exists public.respond_knock(uuid, boolean, text);
create or replace function public.respond_knock(p_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_office_member() then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  update public.office_knocks
     set status = case when p_accept then 'accepted' else 'declined' end,
         responded_at = now()
   where id = p_id and to_user = auth.uid() and status = 'pending' and expires_at > now();
  if not found then
    raise exception 'That knock is no longer waiting.' using errcode = '22023';
  end if;
end;
$$;
revoke execute on function public.respond_knock(uuid, boolean) from public, anon, authenticated;
grant  execute on function public.respond_knock(uuid, boolean) to authenticated;

-- 0005's knock().
create or replace function public.knock(p_to uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or not public.is_office_member() or not public.office_signed_in_today() then
    raise exception 'You need to be in the office to knock.' using errcode = '42501';
  end if;
  if p_to = v_uid then
    raise exception 'That is your own office.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.office_members m join public.profiles u on u.id = m.user_id
     where m.user_id = p_to and m.active and u.deactivated_at is null
  ) then
    raise exception 'That person is not in the office.' using errcode = '22023';
  end if;
  -- Serialise one person's knocks, so parallel calls cannot slip past the caps.
  perform pg_advisory_xact_lock(hashtext('office_knock:' || v_uid::text));
  if (select count(*) from public.office_knocks
       where from_user = v_uid and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many knocks. Wait a few minutes.' using errcode = '22023';
  end if;
  if (select count(*) from public.office_knocks
       where from_user = v_uid and to_user = p_to and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'You have knocked on that door three times this hour. Try again later.' using errcode = '22023';
  end if;

  -- A lapsed knock no longer blocks a new one.
  update public.office_knocks set status = 'expired'
   where from_user = v_uid and to_user = p_to and status = 'pending' and expires_at <= now();

  begin
    insert into public.office_knocks (from_user, to_user) values (v_uid, p_to) returning id into v_id;
  exception when unique_violation then
    raise exception 'You are already knocking on that office.' using errcode = '23505';
  end;
  return v_id;
end;
$$;
revoke execute on function public.knock(uuid) from public, anon, authenticated;
grant  execute on function public.knock(uuid) to authenticated;

drop table if exists public.office_notice_acks;  -- also drops its policy
drop table if exists public.office_onboarding;
alter table public.office_settings drop column if exists short_day_minutes;
alter table public.office_status   drop column if exists back_reason;
alter table public.office_knocks   drop column if exists reply;
drop function if exists public.office_clean_line(text);

notify pgrst, 'reload schema';

commit;
