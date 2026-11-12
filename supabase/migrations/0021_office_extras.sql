-- JustUsedTech office, 0021: notices, time off, meeting rooms, team chat, insights.
--
-- APPLY AFTER 0020. Safe before or after the deploy: nothing an open tab calls
-- changes shape, and the screens show the new pages only once office_rooms
-- exists (it is created here). Ported from the Brightwork demo (stdiohox/TheOffice,
-- its 0021 to 0023), which was built on this office's own schema.
--
-- 1. NOTICES. Mr Tito, Emmanuella (HR) and the admins (Hazel) post; everyone reads.
--    A notice that must be read shows who has pressed "I have read this".
-- 2. TIME OFF. Anyone asks for annual, sick or personal leave; Mr Tito or HR
--    decides. Approval writes a day away (office_absences), so reports stop being
--    due and the door says so. Everyone sees the dates of approved leave; the kind
--    and the note are seen only by the person and whoever decides.
-- 3. ROOMS. Three meeting rooms. Book a slot (two bookings of a room never
--    overlap, four hours at most). Step in and the team sees who is in a room.
--    The first person into an empty room gets a new six-digit code on the door;
--    anyone else needs that code, or an invite from someone inside. Nobody is
--    exempt, Mr Tito included. Five wrong tries lock that person out of that room
--    for 10 minutes. What is said in a room is readable only by the people in it,
--    and is deleted when the last person leaves. Invites lapse after 30 minutes;
--    the invite email is sent by api/office/room-invite.
-- 4. TEAM CHAT. Three open channels (general, wins, help) everyone in the office
--    reads. Knock chats stay between two people as before.
-- 5. INSIGHTS. office_insights(): the last N workdays of what the office already
--    records (reports on time, late, missed; tasks approved, overdue, stars),
--    for Mr Tito and HR only. A guide for a conversation, not a verdict.
--
-- Staff notice version 8 describes all of this (src/lib/officeNotice.ts).
-- Rollback: supabase/rollbacks/0021_office_extras.down.sql.

begin;

do $$
begin
  if to_regclass('public.office_tasks') is null or to_regprocedure('public.is_office_manager()') is null
     or to_regprocedure('public.office_today()') is null or to_regprocedure('public.office_expects_report(uuid, date)') is null then
    raise exception '0021: apply 0002 to 0020 first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Notice board
-- ---------------------------------------------------------------------------
create table public.office_notices (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(btrim(title)) between 1 and 120),
  body       text not null check (char_length(btrim(body)) between 1 and 4000),
  pinned     boolean not null default false,
  needs_read boolean not null default false,
  author     uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index office_notices_order on public.office_notices (pinned desc, created_at desc);

create table public.office_notice_reads (
  notice_id uuid not null references public.office_notices(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (notice_id, user_id)
);
create index office_notice_reads_user on public.office_notice_reads (user_id);

-- Who posts: Mr Tito, HR (is_office_manager, 0017) and anyone labelled manager (Hazel).
create or replace function public.is_notice_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_office_manager()
      or exists (select 1 from public.profiles where id = auth.uid() and role = 'manager' and deactivated_at is null)
$$;

alter table public.office_notices enable row level security;
alter table public.office_notice_reads enable row level security;
create policy "Team reads notices" on public.office_notices for select to authenticated using ((select public.is_team_member()));
create policy "Admins post notices" on public.office_notices for insert to authenticated
  with check ((select public.is_notice_admin()) and author = (select auth.uid()));
create policy "Admins change notices" on public.office_notices for update to authenticated using ((select public.is_notice_admin()));
create policy "Admins remove notices" on public.office_notices for delete to authenticated using ((select public.is_notice_admin()));
create policy "Team sees who has read" on public.office_notice_reads for select to authenticated using ((select public.is_team_member()));
create policy "You mark your own read" on public.office_notice_reads for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_team_member()));

-- ---------------------------------------------------------------------------
-- 2. Time off
-- ---------------------------------------------------------------------------
create table public.office_leave_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('annual', 'sick', 'personal')),
  starts_on     date not null,
  ends_on       date not null,
  note          text check (char_length(note) <= 300),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (char_length(decision_note) <= 300),
  absence_id    uuid references public.office_absences(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index office_leave_requests_user on public.office_leave_requests (user_id, status);
create index office_leave_requests_pending on public.office_leave_requests (status) where status = 'pending';

alter table public.office_leave_requests enable row level security;
create policy "See your own requests; managers see all" on public.office_leave_requests for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));

-- Who is off, for everyone: the dates only.
create or replace function public.office_who_is_off()
returns table (user_id uuid, starts_on date, ends_on date)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.user_id, r.starts_on, r.ends_on from public.office_leave_requests r
   where r.status = 'approved' and r.ends_on >= public.office_today()
     and public.is_team_member()
   order by r.starts_on
$$;

create or replace function public.request_leave(p_kind text, p_from date, p_to date, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  if not exists (select 1 from public.office_members where user_id = auth.uid() and active) then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  if p_kind not in ('annual', 'sick', 'personal') then raise exception 'Unknown kind of leave.' using errcode = '22023'; end if;
  if p_to < p_from then raise exception 'The last day is before the first.' using errcode = '22023'; end if;
  if p_from < public.office_today() then raise exception 'Choose today or a later day.' using errcode = '22023'; end if;
  if p_to - p_from > 60 then raise exception 'Ask for up to 60 days at a time.' using errcode = '22023'; end if;
  if exists (select 1 from public.office_leave_requests where user_id = auth.uid() and status in ('pending', 'approved')
              and daterange(starts_on, ends_on, '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'You already have a request for those days.' using errcode = '22023';
  end if;
  insert into public.office_leave_requests (user_id, kind, starts_on, ends_on, note)
  values (auth.uid(), p_kind, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.decide_leave(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_leave_requests%rowtype; v_absence uuid;
begin
  if not public.is_office_manager() then raise exception 'Only Mr Tito or HR can decide this.' using errcode = '42501'; end if;
  select * into r from public.office_leave_requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception 'That request has already been decided.' using errcode = '22023'; end if;
  if r.user_id = auth.uid() then raise exception 'Someone else decides your own request.' using errcode = '42501'; end if;
  if p_approve then
    insert into public.office_absences (user_id, starts_on, ends_on, reason, created_by)
    values (r.user_id, r.starts_on, r.ends_on, initcap(r.kind) || ' leave', auth.uid())
    returning id into v_absence;
  end if;
  update public.office_leave_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), absence_id = v_absence
   where id = p_id;
end $$;

create or replace function public.cancel_leave(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_leave_requests%rowtype;
begin
  select * into r from public.office_leave_requests where id = p_id for update;
  if not found or r.user_id <> auth.uid() then raise exception 'That is not your request.' using errcode = '42501'; end if;
  if r.status not in ('pending', 'approved') then raise exception 'That request is already closed.' using errcode = '22023'; end if;
  if r.absence_id is not null then delete from public.office_absences where id = r.absence_id; end if;
  update public.office_leave_requests set status = 'cancelled', absence_id = null where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Meeting rooms: bookings, who is in, the code on the door, the conversation,
--    and invites
-- ---------------------------------------------------------------------------
create table public.office_rooms (
  id       text primary key,
  name     text not null,
  capacity int not null check (capacity between 1 and 100),
  purpose  text not null
);
create table public.office_bookings (
  id         uuid primary key default gen_random_uuid(),
  room_id    text not null references public.office_rooms(id),
  title      text not null check (char_length(btrim(title)) between 1 and 120),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  booked_by  uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index office_bookings_room_time on public.office_bookings (room_id, starts_at);
create index office_bookings_ends on public.office_bookings (ends_at);

create table public.office_room_occupants (
  user_id   uuid primary key references public.profiles(id) on delete cascade,
  room_id   text not null references public.office_rooms(id),
  joined_at timestamptz not null default now()
);
create index office_room_occupants_room on public.office_room_occupants (room_id);

create table public.office_room_messages (
  id         bigint generated always as identity primary key,
  room_id    text not null references public.office_rooms(id) on delete cascade,
  sender     uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index office_room_messages_room_created on public.office_room_messages (room_id, created_at);

create table public.office_room_invites (
  id           uuid primary key default gen_random_uuid(),
  room_id      text not null references public.office_rooms(id) on delete cascade,
  from_user    uuid not null references public.profiles(id) on delete cascade,
  to_user      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 minutes',
  responded_at timestamptz,
  emailed_at   timestamptz,
  check (from_user <> to_user)
);
create index office_room_invites_to on public.office_room_invites (to_user, status);
create index office_room_invites_from on public.office_room_invites (from_user, room_id, status);

create table public.office_room_codes (
  room_id    text primary key references public.office_rooms(id) on delete cascade,
  code       text not null check (code ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now()
);

-- No policy: written and read by enter_room only. Kept 10 minutes.
create table public.office_room_code_tries (
  user_id uuid not null references public.profiles(id) on delete cascade,
  room_id text not null references public.office_rooms(id) on delete cascade,
  at      timestamptz not null default now()
);
create index office_room_code_tries_who on public.office_room_code_tries (user_id, room_id, at);

create or replace function public.is_in_room(p_room text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_team_member()
     and exists (select 1 from public.office_room_occupants where user_id = auth.uid() and room_id = p_room)
$$;

alter table public.office_rooms enable row level security;
alter table public.office_bookings enable row level security;
alter table public.office_room_occupants enable row level security;
alter table public.office_room_messages enable row level security;
alter table public.office_room_invites enable row level security;
alter table public.office_room_codes enable row level security;
alter table public.office_room_code_tries enable row level security;
create policy "Team sees rooms" on public.office_rooms for select to authenticated using ((select public.is_team_member()));
create policy "Team sees bookings" on public.office_bookings for select to authenticated using ((select public.is_team_member()));
create policy "Team sees who is in a room" on public.office_room_occupants for select to authenticated using ((select public.is_team_member()));
create policy "Only people in the room read it" on public.office_room_messages for select to authenticated
  using ((select public.is_in_room(room_id)));
create policy "Only people in the room write in it" on public.office_room_messages for insert to authenticated
  with check (sender = (select auth.uid()) and (select public.is_in_room(room_id)));
create policy "See invites you sent or got" on public.office_room_invites for select to authenticated
  using (to_user = (select auth.uid()) or from_user = (select auth.uid()));
create policy "Only people in the room see its code" on public.office_room_codes for select to authenticated
  using ((select public.is_in_room(room_id)));

create or replace function public.book_room(p_room text, p_title text, p_start timestamptz, p_end timestamptz)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  if not exists (select 1 from public.office_rooms where id = p_room) then raise exception 'No such room.' using errcode = '22023'; end if;
  if p_end <= p_start then raise exception 'The meeting ends before it starts.' using errcode = '22023'; end if;
  if p_end - p_start > interval '4 hours' then raise exception 'Book up to four hours at a time.' using errcode = '22023'; end if;
  if p_end < now() then raise exception 'That time has passed.' using errcode = '22023'; end if;
  if p_start > now() + interval '90 days' then raise exception 'Book up to 90 days ahead.' using errcode = '22023'; end if;
  -- One booking at a time per room: two people booking the same slot at once
  -- would both see it free.
  perform 1 from public.office_rooms where id = p_room for update;
  if exists (select 1 from public.office_bookings where room_id = p_room and tstzrange(starts_at, ends_at) && tstzrange(p_start, p_end)) then
    raise exception 'That room is taken then. Try another time or room.' using errcode = '23505';
  end if;
  insert into public.office_bookings (room_id, title, starts_at, ends_at, booked_by)
  values (p_room, btrim(p_title), p_start, p_end, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.cancel_booking(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.office_bookings where id = p_id and (booked_by = auth.uid() or public.is_notice_admin());
  if not found then raise exception 'Only whoever booked it, or an admin, can cancel this.' using errcode = '42501'; end if;
end $$;

-- Going in, once it is settled that you may. Not callable from outside.
create or replace function public.office_room_place(p_room text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- One person at a time through a door: two at once could both count an empty
  -- room, or come in as the last person leaves and lose the code under them.
  perform 1 from public.office_rooms
   where id = p_room or id = (select room_id from public.office_room_occupants where user_id = auth.uid())
   order by id for update;
  if (select count(*) from public.office_room_occupants where room_id = p_room and user_id <> auth.uid())
     >= (select capacity from public.office_rooms where id = p_room) then
    raise exception 'That room is full.' using errcode = '22023';
  end if;
  -- Nobody else here: a new code for a new conversation. Six digits from the
  -- random bits of a v4 uuid (core Postgres, no extension).
  if not exists (select 1 from public.office_room_occupants where room_id = p_room and user_id <> auth.uid()) then
    insert into public.office_room_codes (room_id, code)
    values (p_room, lpad(((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0'))
    on conflict (room_id) do update set code = excluded.code, created_at = now();
  end if;
  insert into public.office_room_occupants (user_id, room_id) values (auth.uid(), p_room)
  on conflict (user_id) do update set room_id = excluded.room_id, joined_at = now();
  update public.office_room_invites set status = 'accepted', responded_at = now()
   where to_user = auth.uid() and room_id = p_room and status = 'pending' and expires_at > now();
end $$;

-- The answer comes back as a word, not an exception: an exception would undo
-- the record of a wrong try, and the limit would count nothing.
--   in  out  needs_code  wrong_code  locked
create or replace function public.enter_room(p_room text, p_code text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
  v_tries int;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  if p_room is null then
    perform 1 from public.office_rooms where id = (select room_id from public.office_room_occupants where user_id = auth.uid()) for update;
    delete from public.office_room_occupants where user_id = auth.uid();
    return 'out';
  end if;
  if not exists (select 1 from public.office_rooms where id = p_room) then raise exception 'No such room.' using errcode = '22023'; end if;
  if exists (select 1 from public.office_room_occupants where user_id = auth.uid() and room_id = p_room) then
    return 'in';
  end if;
  -- In use: the code, or an invite still waiting.
  if exists (select 1 from public.office_room_occupants where room_id = p_room)
     and not exists (select 1 from public.office_room_invites where to_user = auth.uid() and room_id = p_room and status = 'pending' and expires_at > now()) then
    delete from public.office_room_code_tries where at < now() - interval '10 minutes';
    select count(*) into v_tries from public.office_room_code_tries where user_id = auth.uid() and room_id = p_room;
    if v_tries >= 5 then return 'locked'; end if;
    if nullif(btrim(coalesce(p_code, '')), '') is null then return 'needs_code'; end if;
    select code into v_code from public.office_room_codes where room_id = p_room;
    if v_code is distinct from btrim(p_code) then
      insert into public.office_room_code_tries (user_id, room_id) values (auth.uid(), p_room);
      return case when v_tries + 1 >= 5 then 'locked' else 'wrong_code' end;
    end if;
    delete from public.office_room_code_tries where user_id = auth.uid() and room_id = p_room;
  end if;
  perform public.office_room_place(p_room);
  return 'in';
end $$;

-- Someone in a room asks a colleague in. Written by this function only.
create or replace function public.invite_to_room(p_to uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room text; v_id uuid;
begin
  select room_id into v_room from public.office_room_occupants where user_id = auth.uid();
  if v_room is null then raise exception 'Step into a room first.' using errcode = '22023'; end if;
  if p_to = auth.uid() then raise exception 'You are already here.' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles p join public.office_members m on m.user_id = p.id
                  where p.id = p_to and m.active and p.deactivated_at is null) then
    raise exception 'That person is not in the office.' using errcode = '22023';
  end if;
  if exists (select 1 from public.office_absences a where (a.user_id = p_to or a.user_id is null)
              and public.office_today() between a.starts_on and a.ends_on) then
    raise exception 'They are away today.' using errcode = '22023';
  end if;
  if exists (select 1 from public.office_room_occupants where user_id = p_to and room_id = v_room) then
    raise exception 'They are already in this room.' using errcode = '22023';
  end if;
  -- Already asked and still waiting: no second email.
  select id into v_id from public.office_room_invites
   where room_id = v_room and from_user = auth.uid() and to_user = p_to and status = 'pending' and expires_at > now();
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.office_room_invites where from_user = auth.uid() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'That is a lot of invites. Try again in a while.' using errcode = '22023';
  end if;
  insert into public.office_room_invites (room_id, from_user, to_user) values (v_room, auth.uid(), p_to) returning id into v_id;
  return v_id;
end $$;

-- An invite is the pass: joining from one takes no code.
create or replace function public.respond_room_invite(p_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_room_invites%rowtype;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  select * into r from public.office_room_invites where id = p_id and to_user = auth.uid() for update;
  if not found then raise exception 'That invite is not yours.' using errcode = '42501'; end if;
  if r.status <> 'pending' or r.expires_at <= now() then raise exception 'That invite has lapsed.' using errcode = '22023'; end if;
  if p_accept then
    perform public.office_room_place(r.room_id);
  else
    update public.office_room_invites set status = 'declined', responded_at = now() where id = p_id;
  end if;
end $$;

-- The last one out: the conversation, the code and the open invites go with them.
create or replace function public.office_room_emptied() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or NEW.room_id is distinct from OLD.room_id then
    if not exists (select 1 from public.office_room_occupants where room_id = OLD.room_id) then
      delete from public.office_room_messages where room_id = OLD.room_id;
      delete from public.office_room_codes where room_id = OLD.room_id;
      update public.office_room_invites set status = 'declined', responded_at = now()
       where room_id = OLD.room_id and status = 'pending';
    end if;
  end if;
  return null;
end $$;
create trigger office_room_emptied after update or delete on public.office_room_occupants
  for each row execute function public.office_room_emptied();

-- Switched off while in a room: out of it.
create or replace function public.office_room_person_off() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if NEW.deactivated_at is not null and OLD.deactivated_at is null then
    delete from public.office_room_occupants where user_id = NEW.id;
  end if;
  return null;
end $$;
create trigger office_room_person_off after update of deactivated_at on public.profiles
  for each row execute function public.office_room_person_off();

insert into public.office_rooms (id, name, capacity, purpose) values
  ('boardroom', 'Boardroom', 12, 'Team meetings and reviews'),
  ('focus', 'Focus room', 4, 'Small working sessions'),
  ('corner', 'Corner room', 2, 'One-to-ones and quiet chats');

-- ---------------------------------------------------------------------------
-- 4. Team chat
-- ---------------------------------------------------------------------------
create table public.office_channel_messages (
  id         bigint generated always as identity primary key,
  channel    text not null check (channel in ('general', 'wins', 'help')),
  sender     uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index office_channel_messages_channel_created on public.office_channel_messages (channel, created_at desc);
alter table public.office_channel_messages enable row level security;
create policy "Team reads the channels" on public.office_channel_messages for select to authenticated using ((select public.is_team_member()));
create policy "Team writes as themselves" on public.office_channel_messages for insert to authenticated
  with check (sender = (select auth.uid()) and (select public.is_team_member()));
create policy "You remove your own" on public.office_channel_messages for delete to authenticated
  using (sender = (select auth.uid()) or (select public.is_notice_admin()));

-- ---------------------------------------------------------------------------
-- 5. Insights: the last N workdays, from what the office already records.
-- ---------------------------------------------------------------------------
create or replace function public.office_insights(p_days int default 10)
returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s public.office_settings%rowtype;
  v_today date;
  v_from date;
  v_out json;
begin
  if not public.is_office_manager() then raise exception 'Only Mr Tito or HR can see this.' using errcode = '42501'; end if;
  select * into s from public.office_settings where id = 1;
  v_today := (now() at time zone s.timezone)::date;
  -- The last p_days workdays, today included.
  v_from := (select min(d) from (select d::date from generate_series(v_today - 90, v_today, interval '1 day') d
              where extract(isodow from d)::int = any(s.workdays) order by d desc limit least(greatest(p_days, 1), 60)) x);

  with people as (
    select p.id, p.full_name, p.job_title from public.profiles p
    join public.office_members m on m.user_id = p.id and m.active
    where p.deactivated_at is null and p.id is distinct from s.manager_id
  ), days as (
    select d::date as day from generate_series(v_from, v_today, interval '1 day') d
    where extract(isodow from d)::int = any(s.workdays)
  ), due as (
    -- Today only counts the reports whose deadline has passed.
    select pe.id as user_id, dd.day, k.kind from people pe cross join days dd
    cross join (values ('signin', s.signin_deadline), ('midday', s.midday_deadline), ('eod', s.eod_deadline)) k(kind, deadline)
    where public.office_expects_report(pe.id, dd.day)
      and (dd.day < v_today or (now() at time zone s.timezone)::time > k.deadline)
  ), filed as (
    select d.user_id, d.day, d.kind, r.timing from due d
    left join public.office_reports r on r.user_id = d.user_id and r.work_date = d.day and r.kind = d.kind
  ), per_person as (
    select pe.id as user_id, pe.full_name, pe.job_title,
      count(f.kind) as due,
      count(f.timing) as filed,
      count(*) filter (where f.timing = 'on_time') as on_time,
      count(*) filter (where f.timing = 'late') as late,
      count(f.kind) - count(f.timing) as missed,
      (select count(*) from public.office_tasks t where t.assigned_to = pe.id and t.status = 'approved' and (t.closed_at at time zone s.timezone)::date >= v_from) as tasks_approved,
      (select count(*) from public.office_tasks t where t.assigned_to = pe.id and t.status in ('open', 'in_progress') and t.due_on < v_today) as tasks_overdue,
      (select round(avg(t.rating), 1) from public.office_tasks t where t.assigned_to = pe.id and t.rating is not null and (t.closed_at at time zone s.timezone)::date >= v_from) as avg_stars
    from people pe left join filed f on f.user_id = pe.id
    group by pe.id, pe.full_name, pe.job_title
  ), per_day as (
    select dd.day,
      count(f.kind) as due,
      count(*) filter (where f.timing = 'on_time') as on_time,
      count(*) filter (where f.timing = 'late') as late,
      count(f.kind) - count(f.timing) as missed,
      (select count(*) from public.office_tasks t where t.status = 'approved' and (t.closed_at at time zone s.timezone)::date = dd.day) as tasks_approved
    from days dd left join filed f on f.day = dd.day group by dd.day
  )
  select json_build_object(
    'from', v_from, 'to', v_today, 'days', (select count(*) from days),
    'totals', (select json_build_object(
        'due', coalesce(sum(due), 0), 'on_time', coalesce(sum(on_time), 0), 'late', coalesce(sum(late), 0), 'missed', coalesce(sum(missed), 0),
        'tasks_approved', coalesce(sum(tasks_approved), 0), 'tasks_overdue', coalesce(sum(tasks_overdue), 0),
        'avg_stars', (select round(avg(t.rating), 1) from public.office_tasks t where t.rating is not null and (t.closed_at at time zone s.timezone)::date >= v_from))
      from per_person),
    'open_tasks', (select count(*) from public.office_tasks where status in ('open', 'in_progress')),
    'waiting_review', (select count(*) from public.office_tasks where status = 'done'),
    'pending_leave', (select count(*) from public.office_leave_requests where status = 'pending'),
    'by_day', (select coalesce(json_agg(per_day order by day), '[]'::json) from per_day),
    'by_person', (select coalesce(json_agg(per_person order by missed desc, late desc, full_name), '[]'::json) from per_person)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Who may call what
-- ---------------------------------------------------------------------------
revoke execute on function public.is_notice_admin() from public, anon;
revoke execute on function public.is_in_room(text) from public, anon;
revoke execute on function public.office_who_is_off() from public, anon;
revoke execute on function public.request_leave(text, date, date, text) from public, anon;
revoke execute on function public.decide_leave(uuid, boolean, text) from public, anon;
revoke execute on function public.cancel_leave(uuid) from public, anon;
revoke execute on function public.book_room(text, text, timestamptz, timestamptz) from public, anon;
revoke execute on function public.cancel_booking(uuid) from public, anon;
revoke execute on function public.enter_room(text, text) from public, anon;
revoke execute on function public.invite_to_room(uuid) from public, anon;
revoke execute on function public.respond_room_invite(uuid, boolean) from public, anon;
revoke execute on function public.office_insights(int) from public, anon;
revoke execute on function public.office_room_place(text) from public, anon, authenticated;
revoke execute on function public.office_room_emptied() from public, anon, authenticated;
revoke execute on function public.office_room_person_off() from public, anon, authenticated;
grant execute on function public.is_notice_admin() to authenticated;
grant execute on function public.is_in_room(text) to authenticated;
grant execute on function public.office_who_is_off() to authenticated;
grant execute on function public.request_leave(text, date, date, text) to authenticated;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_leave(uuid) to authenticated;
grant execute on function public.book_room(text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.cancel_booking(uuid) to authenticated;
grant execute on function public.enter_room(text, text) to authenticated;
grant execute on function public.invite_to_room(uuid) to authenticated;
grant execute on function public.respond_room_invite(uuid, boolean) to authenticated;
grant execute on function public.office_insights(int) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Live: the screens refresh as these change (Realtime respects the policies above).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['office_notices', 'office_notice_reads', 'office_leave_requests', 'office_bookings',
                           'office_room_occupants', 'office_room_messages', 'office_room_invites', 'office_channel_messages'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Self-check
-- ---------------------------------------------------------------------------
do $$
declare t text; f text;
begin
  foreach t in array array['office_notices', 'office_notice_reads', 'office_leave_requests', 'office_rooms', 'office_bookings',
                           'office_room_occupants', 'office_room_messages', 'office_room_invites', 'office_room_codes',
                           'office_room_code_tries', 'office_channel_messages'] loop
    if to_regclass('public.' || t) is null then raise exception '0021: table % is missing.', t; end if;
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relrowsecurity) then
      raise exception '0021: RLS is off on %.', t;
    end if;
  end loop;
  foreach f in array array['public.is_notice_admin()', 'public.is_in_room(text)', 'public.office_who_is_off()',
                           'public.request_leave(text, date, date, text)', 'public.decide_leave(uuid, boolean, text)', 'public.cancel_leave(uuid)',
                           'public.book_room(text, text, timestamptz, timestamptz)', 'public.cancel_booking(uuid)', 'public.enter_room(text, text)',
                           'public.invite_to_room(uuid)', 'public.respond_room_invite(uuid, boolean)', 'public.office_insights(int)',
                           'public.office_room_place(text)'] loop
    if not exists (select 1 from pg_proc where oid = to_regprocedure(f) and prosecdef) then
      raise exception '0021: function % is missing or not security definer.', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '0021: anon can call %.', f; end if;
  end loop;
  if has_function_privilege('authenticated', 'public.office_room_place(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.enter_room(text, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.office_insights(int)', 'execute') then
    raise exception '0021: the wrong role can call a function.';
  end if;
  if (select count(*) from public.office_rooms) <> 3 then raise exception '0021: the rooms are missing.'; end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'office_room_code_tries') <> 0 then
    raise exception '0021: office_room_code_tries must have no policy.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'office_room_emptied')
     or not exists (select 1 from pg_trigger where tgname = 'office_room_person_off') then
    raise exception '0021: a trigger is missing.';
  end if;
  if (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename in ('office_notices', 'office_notice_reads', 'office_leave_requests', 'office_bookings',
                          'office_room_occupants', 'office_room_messages', 'office_room_invites', 'office_channel_messages')) <> 8 then
    raise exception '0021: Realtime is missing a table.';
  end if;
end $$;

commit;
