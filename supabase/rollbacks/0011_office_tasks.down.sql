-- ROLLBACK of 0011 (tasks). Run by hand, newest first: this one before 0010's.
-- DESTRUCTIVE: every task and its history is deleted. Export office_tasks and
-- office_task_events first if they should be kept. Hazel's role stays
-- 'manager' (a label only without this migration); set it back by hand if wanted:
--   update public.profiles set role = 'member' where email = '<her email>';
begin;

drop table if exists public.office_task_events;  -- also drops its policy
drop table if exists public.office_tasks;        -- also leaves supabase_realtime

drop function if exists public.cancel_task(uuid, text);
drop function if exists public.review_task(uuid, boolean, text);
drop function if exists public.complete_task(uuid, text, text);
drop function if exists public.start_task(uuid);
drop function if exists public.create_task(uuid, text, text, date);
drop function if exists public.office_task_event(uuid, text, text);
drop function if exists public.office_task_text(text, int, text);
drop function if exists public.office_task_actor();
drop function if exists public.is_task_admin();

commit;
