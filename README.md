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
   `0001_team`, `0002_office_reports`, then `0004` to `0018`. **Leave `0003` for step 6.**
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
**Tasks**. The assignee starts it and marks it done, with an optional note, links (up to 5 since 0016) and images. The person
who gave it then checks it: **Approve**, or **Send back** with what still needs doing, which puts it
back in progress. The giver (or an admin) can cancel a task that is not yet approved.

- **Who sees what:** a task is seen by the person who gave it and the person it was given to. The
  office admins see every task (an **Everyone** tab) and can check or cancel any of them. Admins are
  the office manager and anyone whose `profiles.role` is `manager`. To make Hazel one, in the SQL editor:
  `update public.profiles set role = 'manager' where email = 'operations@justusedtech.org';`. That gives her the
  tasks, and (since 0016) inviting people and setting roles in Settings; reports, time figures,
  switching people off, photos and the office settings stay Mr Tito's.
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

## The day's hours, and work started before sign-in (0014, 0017, 0018)

Since 0017 the day is: sign-in from 09:00 (on time until 11:00), midday report 15:00 to 16:00,
end-of-day report from 17:00 (on time until 19:00). Mr Tito's summary goes after 19:00, the time
figures cover 09:00 to 19:00, and the leaderboard week closes Friday 19:00. Every screen and email
reads these from `office_settings`; change them there.

Since 0018 the times are hard limits at both ends of the day: sign-in cannot be filed before
09:00, and the end-of-day report cannot be filed after 19:00 (19:00:59 still counts). An end of day
not filed by then stays missed, and Mr Tito and HR are told as before; the member is not emailed
to file it late, as they no longer can. A sign-in after 11:00 is still accepted and marked late, and
the midday report is unchanged. To apply: run `0018_report_windows.sql` in the SQL editor, before
or after the deploy (either order is safe). Rollback: `0018_report_windows.down.sql`.

Nothing is recorded before someone files their sign-in. Someone who started earlier says so under
**Your time in the office** ("I started before 09:00": a time and what on). Mr Tito sees it on the Day
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

## Proof, links, roles, and Hazel inviting people (0016)

- **Proof is optional.** Midday and end-of-day reports still need a few words on what was worked on;
  a screenshot or file is optional, like the links.
- **Several links**, up to 5, on a report and on a task handed in ("Add another link"). Each must
  start with http:// or https://. Older reports and tasks keep their one link.
- **Roles** (job titles): "CEO", "Operations Manager". Given when someone is invited (Role, optional),
  shown on their door and beside their name, and changed in Settings > The team by Mr Tito or Hazel.
  A role is a label only: access stays as it was (Access column: Manager = admin).
- **Hazel invites people** from Settings, as Mr Tito does: always as a member. She sees and can
  withdraw the invites waiting. Switching people off, photos and the office settings stay Mr Tito's.

To apply: run `0016_proof_links_and_titles.sql` in the SQL editor, then merge `proof-links-titles`
(Vercel deploys main). Then set the roles of the people already on the team in Settings > The team
(for example Mr Tito: CEO; Hazel: Operations Manager), or in SQL:
`update public.profiles set job_title = 'CEO' where email = '<his email>';`
Before 0016 is applied the new screens fall back: one link box, no Role field or column; the
reports still ask for proof until then. Hazel's Settings page appears with the deploy, and her
invites list fills once 0016 is in.

Rollback: `0016_proof_links_and_titles.down.sql` (proof required again; each report or task keeps
its first link only; roles are dropped; invites back to Mr Tito alone).

## HR: Emmanuella (0017)

`profiles.role = 'hr'` is a third access level. HR sees what Mr Tito sees (every report, proof file,
time figure, note, flag and task) and runs the people: invites, pausing and removing people, days
away, photos, switching people off and on, names and roles. She still files her own reports (the
**Mine** tab on Team reports) and is on the leaderboard. She gets a copy of Mr Tito's alert emails and
daily summary, and the Friday table. What stays Mr Tito's: trial or enforced, the short day, his own
account and place in the office, and who has which access. HR cannot pause or remove herself.
Access ends at once if she is switched off, paused, or set back to member.

To apply: run `0017_hr_and_new_hours.sql` in the SQL editor, then merge `hr-and-new-hours` (Vercel
deploys main). It also sets the new hours. If Emmanuella (hr@justusedtech.org) had not signed in yet
when it ran, invite her from Settings and, once she has signed in, run:
`update public.profiles set role = 'hr' where email = 'hr@justusedtech.org';`
Everyone re-reads the staff notice (v6, which names her) on their next visit.

Rollback: `0017_hr_and_new_hours.down.sql` (hours back to 11:00/11:15 and 19:00/20:30; every HR
person back to member).

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

`supabase/rollbacks/`, one per migration, **newest first** (0018 down to 0002). Each is one
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
