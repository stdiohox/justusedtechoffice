-- ROLLBACK of 0013. Run by hand, newest first: this one before 0012's.
-- DESTRUCTIVE for the record of task images (office_task_files). The bucket
-- `task-proof` and its files are left: empty and delete it in Storage
-- afterwards (Supabase refuses SQL deletes on storage tables).
begin;

drop policy if exists "Task proof uploaded by the assignee of an open task" on storage.objects;
drop policy if exists "Task proof readable with its task" on storage.objects;
drop function if exists public.office_task_proof_orphans(int);
drop function if exists public.task_proof_upload_count(text);
drop table if exists public.office_task_files;

drop function if exists public.complete_task(uuid, text, text, jsonb);
-- 0011's complete_task.
create or replace function public.complete_task(p_id uuid, p_note text default null, p_link text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := public.office_task_actor();
  v_note text := public.office_task_text(p_note, 2000, 'The note');
  v_link text := public.office_task_text(p_link, 2000, 'The link');
begin
  if v_link is not null and v_link !~* '^https?://\S+$' then
    raise exception 'The link must start with http:// or https://.' using errcode = '22023';
  end if;
  update public.office_tasks
     set status = 'done', done_note = v_note, done_link = v_link, done_at = now(), updated_at = now()
   where id = p_id and assigned_to = v_uid and status in ('open', 'in_progress');
  if not found then
    raise exception 'That task is not open.' using errcode = '22023';
  end if;
  return public.office_task_event(p_id, 'done', v_note);
end;
$$;

revoke execute on function public.complete_task(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.complete_task(uuid, text, text) to authenticated;

commit;
