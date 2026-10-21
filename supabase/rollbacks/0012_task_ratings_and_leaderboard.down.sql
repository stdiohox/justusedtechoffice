-- ROLLBACK of 0012. Run by hand, newest first: 0013's before this one.
-- DESTRUCTIVE for ratings: every star and comment is deleted, and so are the
-- 'rated' events in the task histories. Tasks themselves stay.
begin;

drop function if exists public.office_leaderboard(int);
drop function if exists public.office_week_window(int);
drop function if exists public.rate_task(uuid, int, text);

delete from public.office_task_events where kind = 'rated';
alter table public.office_task_events drop constraint if exists office_task_events_kind_check;
alter table public.office_task_events add constraint office_task_events_kind_check
  check (kind in ('assigned', 'started', 'done', 'approved', 'returned', 'cancelled'));

alter table public.office_tasks
  drop column if exists rated_at,
  drop column if exists rated_by,
  drop column if exists rating_note,
  drop column if exists rating;

commit;
