-- ROLLBACK of 0005 (knocks and chats). Run by hand, newest first: this one
-- before 0004's. DESTRUCTIVE: every knock and chat message is deleted. Export
-- office_knocks and office_chat_messages first if they should be kept.
begin;

drop table if exists public.office_chat_messages;  -- also drops its trigger and policies
drop table if exists public.office_knocks;         -- also leaves supabase_realtime

drop function if exists public.office_chat_message_limits();
drop function if exists public.end_knock_chat(uuid);
drop function if exists public.cancel_knock(uuid);
drop function if exists public.respond_knock(uuid, boolean);
drop function if exists public.knock(uuid);
drop function if exists public.office_chat_open(uuid);

commit;
