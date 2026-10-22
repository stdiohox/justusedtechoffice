# JUSTUSED Office

The JustUsedTech team's virtual office: who is in, doors and knocks with a one-hour chat, three
daily reports with proof, check-ins, time in the office, tasks the team gives each other, email
reminders and Mr Tito's end-of-day summary. It is Tito Finance's virtual office (tito-crm `/office` and `/reports`, with the
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
   `0001_team`, `0002_office_reports`, then `0004` to `0014`. **Leave `0003` for step 6.**
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
  `update public.profiles set role = 'manager' where email = 'operations@justusedtech.org';`. That gives her the
  tasks only; reports, time figures and Settings stay Mr Tito's.
- **Telling people:** a badge on Tasks counts what waits on you (new tasks, and tasks you gave that
  are done). Changes pop up live anywhere in the app, and three steps are emailed once each
  (`api/office/task-notify`): a new task to the assignee, "done, please check" to the giver, and
  "sent back" to the assignee.
- **Limits:** 30 new tasks an hour per person; approved and cancelled tasks leave the lists after 60
  days (the rows stay).
- Migration `0011_office_tasks` switches it on; until it is applied the Tasks tab stays hidden.
- **Proof images (0013):** marking a task done can include up to 5 images (PNG, JPEG, WebP or GIF,
  10 MB each), shown as thumbnails to the people on the task and the admins. Stored in the private
  `task-proof` bucket; an image uploaded but never handed in is removed by the alerts route after a day.

## The day's hours, and work started before sign-in (0014)

Since 0014 the day is: sign-in at 11:00 (on time until 11:15), midday report 15:00 to 16:00, end-of-day
report from 19:00 (on time until 20:30). Mr Tito's summary goes after 20:30 and the time figures cover
11:00 to 20:30. Every screen and email reads these from `office_settings`; change them there.

Nothing is recorded before someone files their sign-in. Someone who started earlier says so under
**Your time in the office** ("I started before 11:00": a time and what on). Mr Tito sees it on the Day
view and in his summary as "said by them", beside the evidence the office already has: the time of
their first task step, knock or chat message that day.

## Personal tasks, and editing tasks (0015)

Anyone can give a task to themselves (**Myself** in Give a task, or the **Personal** tab, which shows
what is to do, in progress and done in the last 7 days). Done closes it at once: no check, no stars,
no leaderboard points. Only its owner starts, finishes, edits or cancels it; Mr Tito and Hazel can see
it; nobody is emailed.

The person who gave a task, or an admin, can edit it while it is To do or In progress: the title,
details, due date, or who it is for. Each edit is one step in the task's history saying what changed.
The person it is for is told in the office and by email (at most one edit email per task every 30
minutes). Moving a task starts it afresh, as a new task, for the new person; the person who had it no
longer sees it.

## Ratings and the weekly leaderboard (0012)

The person who gave a task (or an admin) rates it 1 to 5 stars once it is approved; changeable for 7
days, final once its week has closed. The assignee is told in the office and by email.

**Leaderboard** (everyone sees the whole table; Mr Tito runs it and is not on it): the week runs
Friday to Friday at the end-of-day deadline (20:30 since 0014), office time. Points: each task approved 5 plus its stars (3 if not
rated), at most 80 a week, whoever gave it; 1 for each report filed on time. Time in the office and
sign-in times are not scored. **Friday after 20:30**, on the alerts clock (0003): everyone gets their
week by email, the top of the table a special one, Mr Tito and the admins the whole table. It is for
recognition: no pay or disciplinary step follows from it (the staff notice, v3, says so).

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

`supabase/rollbacks/`, one per migration, **newest first** (0014 down to 0002). Each is one
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
