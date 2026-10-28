-- JustUsedTech office, 0018: sign-in opens at its time, the end-of-day report
-- closes at its deadline.
--
-- APPLY AFTER 0017. Safe before or after the deploy: submit_report keeps its
-- shape, and the screens already stop offering the forms outside these times.
--
-- Asked 2026-10-28: people could file their sign-in before the sign-in time,
-- and their end-of-day report after the end-of-day time. Now:
--
-- 1. SIGN-IN opens at office_settings.signin_reminder (09:00). Before that it
--    is refused ("Sign-in opens at 09:00."). After signin_deadline (11:00) it
--    can still be filed, marked late, as before.
-- 2. THE END-OF-DAY REPORT closes at eod_deadline (19:00), to the minute, as
--    on time is counted (19:00:59 is still on time). After that it is refused
--    and the day's report stays missed (flagged to Mr Tito and HR, as before).
--
-- The midday report is unchanged (15:00 to 16:00, late after). The times stay
-- in office_settings; change them there.

begin;

-- 0016's submit_report, with the two checks above. Same arguments, so its
-- grants are kept.
create or replace function public.submit_report(
  p_kind  text,
  p_body  text,
  p_link  text,
  p_files jsonb,
  p_links text[] default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s          public.office_settings%rowtype;
  v_uid      uuid := auth.uid();
  v_local    timestamp;
  v_date     date;
  v_time     time;
  v_opens    time;
  v_deadline time;
  v_timing   text;
  v_body     text := nullif(btrim(coalesce(p_body, '')), '');
  v_links    text[];
  v_files    jsonb := coalesce(p_files, '[]'::jsonb);
  v_id       uuid;
  f          jsonb;
  v_path     text;
  v_sha      text;
  v_name     text;
  v_mime     text;
  v_size     bigint;
  v_found    boolean;
begin
  if v_uid is null then
    raise exception 'Sign in again and retry.' using errcode = '42501';
  end if;
  if p_kind not in ('signin', 'midday', 'eod') then
    raise exception 'Unknown report.' using errcode = '22023';
  end if;

  select * into s from public.office_settings where id = 1;
  v_local := now() at time zone s.timezone;
  v_date  := v_local::date;
  v_time  := v_local::time;

  if not public.office_expects_report(v_uid, v_date) then
    raise exception 'No report is due from you today.' using errcode = '42501';
  end if;

  v_opens := case p_kind when 'signin' then s.signin_reminder when 'midday' then s.midday_opens else s.eod_opens end;
  v_deadline := case p_kind
    when 'signin' then s.signin_deadline
    when 'midday' then s.midday_deadline
    else s.eod_deadline
  end;
  if v_time < v_opens then
    raise exception '% opens at %.', case p_kind when 'signin' then 'Sign-in' else 'This report' end, to_char(v_opens, 'HH24:MI') using errcode = '22023';
  end if;
  v_timing := case when v_time < v_deadline + interval '1 minute' then 'on_time' else 'late' end;
  -- 0018: the end-of-day report closes at its deadline (to the minute, as
  -- on time is counted). After that it stays missed.
  if p_kind = 'eod' and v_timing = 'late' then
    raise exception 'The end-of-day report closed at %. It can no longer be filed today.', to_char(v_deadline, 'HH24:MI') using errcode = '22023';
  end if;

  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Files must be a list.' using errcode = '22023';
  end if;
  if p_kind <> 'signin' and v_body is null then
    raise exception 'Say what you worked on.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_files) > 5 then
    raise exception 'Attach up to 5 files.' using errcode = '22023';
  end if;
  v_links := public.office_links(p_link, p_links);

  begin
    insert into public.office_reports (user_id, work_date, kind, body, links, timing)
    values (v_uid, v_date, p_kind, v_body, v_links, v_timing)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'You have already filed this report today.' using errcode = '23505';
  end;

  for f in select value from jsonb_array_elements(v_files) loop
    v_path := f ->> 'path';
    v_sha  := lower(coalesce(f ->> 'sha256', ''));
    v_name := left(coalesce(nullif(btrim(f ->> 'name'), ''), 'file'), 200);

    if v_path is null or v_path not like v_uid::text || '/' || v_date::text || '/' || p_kind || '/%' then
      raise exception 'A file is not in your folder for this report.' using errcode = '42501';
    end if;
    if v_sha !~ '^[0-9a-f]{64}$' then
      raise exception 'A file is missing its fingerprint. Attach it again.' using errcode = '22023';
    end if;

    select true, o.metadata ->> 'mimetype', (o.metadata ->> 'size')::bigint
      into v_found, v_mime, v_size
      from storage.objects o
     where o.bucket_id = 'proof' and o.name = v_path;
    if v_found is not true then
      raise exception 'An upload did not finish. Attach the file again.' using errcode = '22023';
    end if;
    if v_mime is null or (v_mime not like 'image/%' and v_mime <> 'application/pdf') then
      raise exception 'Proof must be an image or a PDF.' using errcode = '22023';
    end if;
    if v_size is null or v_size > 10485760 then
      raise exception 'Each file must be 10 MB or smaller.' using errcode = '22023';
    end if;

    if exists (select 1 from public.office_report_files where sha256 = v_sha) then
      insert into public.office_flags (user_id, work_date, kind, flag, detail)
      values (v_uid, v_date, p_kind, 'reused_proof', v_name)
      on conflict do nothing;
    end if;

    insert into public.office_report_files (report_id, user_id, storage_path, file_name, mime_type, size_bytes, sha256)
    values (v_id, v_uid, v_path, v_name, v_mime, v_size, v_sha);
  end loop;

  update public.office_flags
     set resolved_at = now()
   where user_id = v_uid and work_date = v_date and kind = p_kind
     and flag = 'missed' and resolved_at is null;

  if v_timing = 'late' then
    insert into public.office_flags (user_id, work_date, kind, flag, detail)
    values (v_uid, v_date, p_kind, 'late', to_char(v_time, 'HH24:MI'))
    on conflict do nothing;
  end if;

  return v_id;
end;
$$;

do $$
declare
  v_src text := (select prosrc from pg_proc
                  where oid = 'public.submit_report(text, text, text, jsonb, text[])'::regprocedure);
begin
  if v_src not like '%when ''signin'' then s.signin_reminder%'
     or v_src not like '%It can no longer be filed today%' then
    raise exception '0018: something is missing.';
  end if;
  if has_function_privilege('anon', 'public.submit_report(text, text, text, jsonb, text[])', 'execute')
     or not has_function_privilege('authenticated', 'public.submit_report(text, text, text, jsonb, text[])', 'execute') then
    raise exception '0018: the wrong role can call a function.';
  end if;
end $$;

commit;
