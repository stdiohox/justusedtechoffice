-- ROLLBACK of 0006 (office status). Run before 0005's rollback
-- (newest first). DESTRUCTIVE only for office_status: what people wrote on
-- their doors.
begin;

do $$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_status') then
    alter publication supabase_realtime drop table public.office_status;
  end if;
end $$;

drop function if exists public.set_office_status(text, time, date);
drop table if exists public.office_status;  -- also drops its policy

commit;
