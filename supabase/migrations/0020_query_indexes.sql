-- 0020: indexes for the filters and sorts the office runs today.
--
-- APPLY AFTER 0019. Indexes only: no table, function or policy changes, so the
-- frontend does not depend on it and nothing breaks before it is applied.
--
-- Audited 2026-11-03 against every supabase-js filter and sort in src/ and api/,
-- and against the schema replayed from 0001-0019. Each index serves a query
-- that had none (the same gaps as tito-crm's 0056, whose office this is):
--
--   office_tasks         the task list (updated_at order), the closed list and
--                        the weekly ratings window (closed_at).
--   office_task_events   task-notify's 10-an-hour throttle (actor, emailed_at).
--   office_day_notes / office_entries   the activity page reads one date or a
--                        range for everyone; the existing indexes lead with user_id.
--   office_alert_log     the weekly summary's `key like 'weekly:%'`: the primary
--                        key cannot serve LIKE under a non-C collation.
--   foreign keys         every remaining foreign key without an index.
--
-- One transaction, plain CREATE INDEX: every table is small, so each build takes
-- a moment. Rollback: supabase/rollbacks/0020_query_indexes.down.sql.

begin;

create index if not exists office_tasks_updated_idx on public.office_tasks (updated_at desc);
create index if not exists office_tasks_closed_idx on public.office_tasks (closed_at) where closed_at is not null;
create index if not exists office_task_events_actor_emailed_idx on public.office_task_events (actor, emailed_at);
create index if not exists office_day_notes_date_idx on public.office_day_notes (work_date);
create index if not exists office_entries_date_idx on public.office_entries (work_date);
create index if not exists office_alert_log_key_pattern_idx on public.office_alert_log (key text_pattern_ops);

-- Foreign keys without an index (office_task_events.actor is covered above).
create index if not exists invites_invited_by_idx on public.invites (invited_by) where invited_by is not null;
create index if not exists office_absences_created_by_idx on public.office_absences (created_by) where created_by is not null;
create index if not exists office_chat_messages_sender_idx on public.office_chat_messages (sender);
create index if not exists office_settings_manager_idx on public.office_settings (manager_id) where manager_id is not null;
create index if not exists office_task_files_uploaded_by_idx on public.office_task_files (uploaded_by);
create index if not exists office_tasks_closed_by_idx on public.office_tasks (closed_by) where closed_by is not null;
create index if not exists office_tasks_rated_by_idx on public.office_tasks (rated_by) where rated_by is not null;

do $$
declare
  missing text;
begin
  select string_agg(n, ', ') into missing
  from unnest(array[
    'office_tasks_updated_idx', 'office_tasks_closed_idx', 'office_task_events_actor_emailed_idx',
    'office_day_notes_date_idx', 'office_entries_date_idx', 'office_alert_log_key_pattern_idx',
    'invites_invited_by_idx', 'office_absences_created_by_idx', 'office_chat_messages_sender_idx',
    'office_settings_manager_idx', 'office_task_files_uploaded_by_idx', 'office_tasks_closed_by_idx',
    'office_tasks_rated_by_idx'
  ]) n
  where to_regclass('public.' || n) is null;
  if missing is not null then
    raise exception '0020: indexes not created: %', missing;
  end if;
end $$;

commit;
