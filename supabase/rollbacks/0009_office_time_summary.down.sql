-- ROLLBACK of 0009 (the time summary). Run before 0008's rollback (newest
-- first). Not destructive: the summary stores nothing. The screens fall back
-- to the old "In 09:02 to 17:45" line by themselves.
begin;

drop function if exists public.office_time_summary(date, date);
drop function if exists public.office_minutes(tstzmultirange);

commit;
