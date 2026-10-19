-- JustUsedTech office (ported from tito-crm), 0005: knocking on an office (VIRTUAL-OFFICE-PLAN Phase 4,
-- text only: no audio, video or calls).
--
-- APPLY AFTER 0004. Safe before the frontend ships.
--
-- ============================================================================
-- THE FLOW
-- ============================================================================
--   knock(to)            A asks to come into B's office. One pending knock per
--                        pair; it lapses after 10 minutes unanswered. At most
--                        10 knocks in 10 minutes, and 3 an hour at one door,
--                        so cancel-and-knock-again cannot be used to spam.
--   respond_knock(id)    B accepts or declines. Accepting opens a chat.
--   cancel_knock(id)     A withdraws a knock still pending.
--   end_knock_chat(id)   Either closes the chat. It also closes by itself an
--                        hour after it opened: this is a quick word, not a
--                        messaging system.
-- Messages go into office_chat_messages, insertable only by one of the two,
-- only while the chat is open and both are still in the office, at most one a
-- second and 200 a chat, and readable only by the two (their own history
-- stays readable to them after the chat closes). Mr Tito has no special
-- access to other people's chats.
--
-- If B is not in the office when A knocks, the browser asks
-- /api/office/knock-ping to send B a Telegram message, once per knock and at
-- most once per pair in 30 minutes. The route checks the caller is A and the
-- knock is still pending; pinged_at is its once-only latch.
--
-- Rows change only through the functions below. Realtime carries the
-- changes to both people (RLS applies to Realtime too).

begin;

create table if not exists public.office_knocks (
  id           uuid primary key default gen_random_uuid(),
  from_user    uuid not null references public.profiles(id) on delete cascade,
  to_user      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '10 minutes',
  responded_at timestamptz,
  ended_at     timestamptz,
  pinged_at    timestamptz,
  check (from_user <> to_user)
);

-- One pending knock per pair at a time.
create unique index if not exists office_knocks_one_pending
  on public.office_knocks (from_user, to_user) where status = 'pending';
create index if not exists office_knocks_to_idx   on public.office_knocks (to_user, created_at desc);
create index if not exists office_knocks_from_idx on public.office_knocks (from_user, created_at desc);

create table if not exists public.office_chat_messages (
  id         bigserial primary key,
  knock_id   uuid not null references public.office_knocks(id) on delete cascade,
  sender     uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists office_chat_messages_knock_idx on public.office_chat_messages (knock_id, id);

-- Is this chat open for messages, and is the caller one of the two?
create or replace function public.office_chat_open(p_knock uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.office_knocks k
     where k.id = p_knock
       and k.status = 'accepted' and k.ended_at is null
       and k.responded_at > now() - interval '1 hour'
       and auth.uid() in (k.from_user, k.to_user)
  )
  -- Removed from the office (or deactivated) mid-chat: the chat closes to you.
  and public.is_office_member()
$$;

create or replace function public.knock(p_to uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or not public.is_office_member() or not public.office_signed_in_today() then
    raise exception 'You need to be in the office to knock.' using errcode = '42501';
  end if;
  if p_to = v_uid then
    raise exception 'That is your own office.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.office_members m join public.profiles u on u.id = m.user_id
     where m.user_id = p_to and m.active and u.deactivated_at is null
  ) then
    raise exception 'That person is not in the office.' using errcode = '22023';
  end if;
  -- Serialise one person's knocks, so parallel calls cannot slip past the caps.
  perform pg_advisory_xact_lock(hashtext('office_knock:' || v_uid::text));
  if (select count(*) from public.office_knocks
       where from_user = v_uid and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many knocks. Wait a few minutes.' using errcode = '22023';
  end if;
  if (select count(*) from public.office_knocks
       where from_user = v_uid and to_user = p_to and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'You have knocked on that door three times this hour. Try again later.' using errcode = '22023';
  end if;

  -- A lapsed knock no longer blocks a new one.
  update public.office_knocks set status = 'expired'
   where from_user = v_uid and to_user = p_to and status = 'pending' and expires_at <= now();

  begin
    insert into public.office_knocks (from_user, to_user) values (v_uid, p_to) returning id into v_id;
  exception when unique_violation then
    raise exception 'You are already knocking on that office.' using errcode = '23505';
  end;
  return v_id;
end;
$$;

create or replace function public.respond_knock(p_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_office_member() then
    raise exception 'You are not in the office.' using errcode = '42501';
  end if;
  update public.office_knocks
     set status = case when p_accept then 'accepted' else 'declined' end,
         responded_at = now()
   where id = p_id and to_user = auth.uid() and status = 'pending' and expires_at > now();
  if not found then
    raise exception 'That knock is no longer waiting.' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.cancel_knock(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.office_knocks set status = 'cancelled', responded_at = now()
   where id = p_id and from_user = auth.uid() and status = 'pending';
  if not found then
    raise exception 'That knock is no longer waiting.' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.end_knock_chat(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.office_knocks set ended_at = now()
   where id = p_id and status = 'accepted' and ended_at is null
     and auth.uid() in (from_user, to_user);
  if not found then
    raise exception 'That chat is already closed.' using errcode = '22023';
  end if;
end;
$$;

-- Flood guard: one message a second per sender, 200 a chat.
create or replace function public.office_chat_message_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.office_chat_messages
              where knock_id = NEW.knock_id and sender = NEW.sender
                and created_at > now() - interval '1 second') then
    raise exception 'Slow down a little.' using errcode = '22023';
  end if;
  if (select count(*) from public.office_chat_messages where knock_id = NEW.knock_id) >= 200 then
    raise exception 'This chat is full. Knock again to start a new one.' using errcode = '22023';
  end if;
  return NEW;
end;
$$;

drop trigger if exists office_chat_message_limits on public.office_chat_messages;
create trigger office_chat_message_limits
  before insert on public.office_chat_messages
  for each row execute function public.office_chat_message_limits();

revoke execute on function public.office_chat_message_limits() from public, anon, authenticated;
revoke execute on function public.office_chat_open(uuid)        from public, anon, authenticated;
revoke execute on function public.knock(uuid)                   from public, anon, authenticated;
revoke execute on function public.respond_knock(uuid, boolean)  from public, anon, authenticated;
revoke execute on function public.cancel_knock(uuid)            from public, anon, authenticated;
revoke execute on function public.end_knock_chat(uuid)          from public, anon, authenticated;
grant  execute on function public.office_chat_open(uuid)        to authenticated;
grant  execute on function public.knock(uuid)                   to authenticated;
grant  execute on function public.respond_knock(uuid, boolean)  to authenticated;
grant  execute on function public.cancel_knock(uuid)            to authenticated;
grant  execute on function public.end_knock_chat(uuid)          to authenticated;

alter table public.office_knocks        enable row level security;
alter table public.office_chat_messages enable row level security;

-- Knocks: the two people involved. Changed only through the functions above.
drop policy if exists "Knocks you sent or received" on public.office_knocks;
create policy "Knocks you sent or received"
  on public.office_knocks for select to authenticated
  using ((select auth.uid()) in (from_user, to_user));

-- Messages: the two people, and only while the chat is open to write.
drop policy if exists "Messages in your chats" on public.office_chat_messages;
create policy "Messages in your chats"
  on public.office_chat_messages for select to authenticated
  using (exists (select 1 from public.office_knocks k
                  where k.id = knock_id and (select auth.uid()) in (k.from_user, k.to_user)));

drop policy if exists "Send in an open chat" on public.office_chat_messages;
create policy "Send in an open chat"
  on public.office_chat_messages for insert to authenticated
  with check (sender = (select auth.uid()) and public.office_chat_open(knock_id));

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_knocks') then
    alter publication supabase_realtime add table public.office_knocks;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'office_chat_messages') then
    alter publication supabase_realtime add table public.office_chat_messages;
  end if;
end $$;

commit;
