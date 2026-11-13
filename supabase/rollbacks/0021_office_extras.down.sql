-- ROLLBACK of 0021. Run by hand. Nothing newer depends on it.
-- Removes notices, time off requests, rooms (bookings, who is in, codes,
-- conversations, invites) and team chat, and the insights function.
-- DATA LOSS: every notice and who read it, every leave request (days away
-- already written by an approval stay in office_absences), every booking,
-- room message, invite and team chat message. Export first if any of it
-- should be kept. The screens hide the pages again by themselves.
begin;

do $$
declare t text;
begin
  foreach t in array array['office_notices', 'office_notice_reads', 'office_leave_requests', 'office_bookings',
                           'office_room_occupants', 'office_room_messages', 'office_room_invites', 'office_channel_messages'] loop
    if exists (select 1 from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;

drop trigger if exists office_room_person_off on public.profiles;
drop trigger if exists office_room_emptied on public.office_room_occupants;

drop function if exists public.office_insights(int);
drop function if exists public.office_room_person_off();
drop function if exists public.office_room_emptied();
drop function if exists public.respond_room_invite(uuid, boolean);
drop function if exists public.invite_to_room(uuid);
drop function if exists public.enter_room(text, text);
drop function if exists public.office_room_place(text);
drop function if exists public.office_room_lock(text);
drop function if exists public.touch_room();
drop function if exists public.office_room_sweep();
drop function if exists public.cancel_booking(uuid);
drop function if exists public.book_room(text, text, timestamptz, timestamptz);
drop function if exists public.cancel_leave(uuid);
drop function if exists public.decide_leave(uuid, boolean, text);
drop function if exists public.request_leave(text, date, date, text);
drop function if exists public.office_who_is_off();

drop table if exists public.office_channel_messages;
drop table if exists public.office_room_code_tries;
drop table if exists public.office_room_codes;
drop table if exists public.office_room_invites;
drop table if exists public.office_room_messages;
drop table if exists public.office_room_occupants;
drop table if exists public.office_bookings;
drop table if exists public.office_rooms;
drop table if exists public.office_leave_requests;
drop table if exists public.office_notice_reads;
drop table if exists public.office_notices;

drop function if exists public.is_in_room(text);
drop function if exists public.is_notice_admin();

commit;
