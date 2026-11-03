-- Rollback of 0020: drops its indexes.

begin;

drop index if exists public.office_tasks_updated_idx;
drop index if exists public.office_tasks_closed_idx;
drop index if exists public.office_task_events_actor_emailed_idx;
drop index if exists public.office_day_notes_date_idx;
drop index if exists public.office_entries_date_idx;
drop index if exists public.office_alert_log_key_pattern_idx;
drop index if exists public.invites_invited_by_idx;
drop index if exists public.office_absences_created_by_idx;
drop index if exists public.office_chat_messages_sender_idx;
drop index if exists public.office_settings_manager_idx;
drop index if exists public.office_task_files_uploaded_by_idx;
drop index if exists public.office_tasks_closed_by_idx;
drop index if exists public.office_tasks_rated_by_idx;

commit;
