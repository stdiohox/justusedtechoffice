# JUSTUSED Office

The JustUsedTech team's virtual office: who is in, doors and knocks with a one-hour chat, three
daily reports with proof, check-ins, time in the office, tasks the team gives each other, email
reminders and Mr Tito's 18:30 summary. It is Tito Finance's virtual office (tito-crm `/office` and `/reports`, with the
improvements from its competitor research) lifted into its own app, with its own Supabase
project. No data is shared with Tito Finance, and there is no CRM, so there is no work feed.

React 19 · Vite · TypeScript · Tailwind CSS 4 · Supabase (Auth, Postgres, Realtime, Storage,
pg_cron, pg_net, Vault) · Vercel (static app plus five functions in `api/`) · Resend. Package
manager: **npm**.

## How people get in

Nobody signs up. Mr Tito invites a name and an email in **Settings**; the invite email carries
a one-time link to choose a password (`/set-password`). Following it creates the person's profile
and puts them in the office. "Forgot your password?" on the sign-in page sends a fresh link. Both
emails go through Resend from `OFFICE_FROM_EMAIL`; the app does not use Supabase's own mailer.

Mr Tito manages the team in **Settings** (invite, send again, withdraw, switch someone off or on,
photos, office activity) and the office in **Reports > Team** (who files reports, pauses, days
away).

## Setting it up (once)

All of this is done by hand; nothing here holds database credentials.

1. **Supabase project** (the JustUsedTech one).
   - Authentication > Sign In / Providers: turn **"Allow new users to sign up" OFF**.
   - Authentication > URL Configuration: Site URL = the office's address; add
     `https://<office address>/set-password` to Redirect URLs.
   - Database > Extensions: make sure **pg_cron** and **pg_net** are enabled.
   - Realtime > Settings: leave "Allow public access" ON (the office channel is private and
     guarded by its own RLS).
2. **Migrations**, in the SQL editor, each file as one run, in order:
   `0001_team`, `0002_office_reports`, then `0004` to `0011`. **Leave `0003` for step 6.**
   Each runs in a transaction and checks itself; a failure changes nothing.
3. **Mr Tito** (0001's and 0002's headers):
   ```sql
   insert into public.invites (email, full_name, role) values ('<his email>', 'Titobi Oreolorun', 'manager');
   ```
   Then Authentication > Users > Add user > Create new user: that email, a password, **Auto
   Confirm User** ticked. Then:
   ```sql
   update public.office_settings set manager_id = (select id from public.profiles where email = '<his email>') where id = 1;
   insert into public.office_members (user_id) select id from public.profiles where email = '<his email>' on conflict do nothing;
   ```
4. **Vercel project**: import this repo, framework Vite, install with npm. Set the variables in
   `.env.example` for Production (the two `VITE_` ones too: they are read at build time).
5. **Resend**: the domain in `OFFICE_FROM_EMAIL` must be verified.
6. **The alerts clock**: put the two Vault values in (0003's header: `cron_secret` = the same
   value as `CRON_SECRET`, and `office_alerts_url` = `https://<office address>/api/cron/office-alerts`),
   call the route once by hand (`curl -X POST -H "Authorization: Bearer $CRON_SECRET" <url>`,
   expect 200), then run `0003_office_alerts_clock.sql`. From then on reminders, alerts and the
   summary go out by themselves.
7. Mr Tito signs in and invites the team from Settings.

**Before anyone is invited:** the staff notice (`src/lib/officeNotice.ts`) is shown to everyone
and acknowledged. Have it reviewed by a Nigerian data protection lawyer or a licensed DPCO first
(NDPA 2023; the reasoning is in tito-crm's OFFICE-FEATURES-PLAN.md section 2.3 and
OFFICE-ACTIVITY-PLAN.md section 6). Acknowledging is "I have read this", not consent.

## Tasks

Anyone on the team gives anyone else a task (a title, optional details, an optional due date) under
**Tasks**. The assignee starts it and marks it done, with an optional note and link. The person
who gave it then checks it: **Approve**, or **Send back** with what still needs doing, which puts it
back in progress. The giver (or an admin) can cancel a task that is not yet approved.

- **Who sees what:** a task is seen by the person who gave it and the person it was given to. The
  office admins see every task (an **Everyone** tab) and can check or cancel any of them. Admins are
  the office manager and anyone whose `profiles.role` is `manager`. To make Hazel one, in the SQL editor:
  `update public.profiles set role = 'manager' where email = '<her email>';`. That gives her the
  tasks only; reports, time figures and Settings stay Mr Tito's.
- **Telling people:** a badge on Tasks counts what waits on you (new tasks, and tasks you gave that
  are done). Changes pop up live anywhere in the app, and three steps are emailed once each
  (`api/office/task-notify`): a new task to the assignee, "done, please check" to the giver, and
  "sent back" to the assignee.
- **Limits:** 30 new tasks an hour per person; approved and cancelled tasks leave the lists after 60
  days (the rows stay).
- Migration `0011_office_tasks` switches it on; until it is applied the Tasks tab stays hidden.

## Trial mode

The office starts in trial: sign-outs after inactivity and missed check-ins are recorded and
shown, but nothing acts on them. Mr Tito switches to enforced in Settings > Office activity after
a trial week.

## Changing the timings

In the SQL editor (the database refuses values outside these ranges):

```sql
update public.office_settings set away_signout_minutes   = 45 where id = 1;  -- 10 to 240
update public.office_settings set checkin_every_minutes  = 40 where id = 1;  -- 15 to 120 (±5 random)
update public.office_settings set checkin_answer_minutes = 7  where id = 1;  -- 2 to 15
update public.office_settings set outside_max_minutes    = 180 where id = 1; -- 30 to 480
update public.office_settings set busy_max_minutes       = 60 where id = 1;  -- 30 to 240
-- The working day and checkpoints (Africa/Lagos, Monday to Friday by default):
-- signin_reminder, signin_deadline, midday_opens, midday_deadline, eod_opens, eod_deadline, workdays, timezone.
```

The 10 minutes to "away" is in the screens (`src/lib/presence.ts`), not the database.

## Rolling back

`supabase/rollbacks/`, one per migration, **newest first** (0011 down to 0002). Each is one
transaction. 0002's and 0007's leave their storage buckets (`proof`, `avatars`): empty and delete
them in Storage afterwards (Supabase refuses SQL deletes on storage tables).

## Developing

```
npm install
cp .env.example .env.local   # fill in the two VITE_ values
npm run dev
npm run build                # typechecks the app and the API, loads each API route under Node, builds
```

## What it does not do

- Status is the browser's word: the database sets every time and enforces the boxes, but a
  scripted browser can send "online". That is why the figures sit beside the reports and the
  proof, and are "a guide, not a verdict" on screen.
- Check-ins and knocks do not reach a phone (no push); they show while the office is open in a
  browser, with a system notification when the tab is in the background.
- Office chats and knocks have no retention job yet (proof, presence, stays, check-ins and day
  notes are kept 90 days).
