# JUSTUSED Office - standing rules

The JustUsedTech team's virtual office. Lifted from tito-crm's /office and /reports
(`stdiohox/tito-crm`, branch office-improvements, migration 0047); this repo has its own Supabase
project and shares no data with Tito Finance. Registered in Koret Tech's `clients/registry.md`.

## Process

- **npm only** (`package-lock.json`). `~/.bun/bin` is first on PATH: never let a Bun command
  write a lockfile here. A stray `bun.lock` or `pnpm-lock.yaml` is deleted, reported, never
  committed.
- **Migrations are applied by hand** in the Supabase SQL editor; nothing here holds database
  credentials. Every migration is one transaction with a self-check, has a rollback in
  `supabase/rollbacks/`, and is verified on a PGlite replay of the whole chain before it is
  committed. Number new ones from the next free number (0016 after 0015_personal_and_editable_tasks).
- **The screens degrade**: a feature that needs a migration stays hidden (or falls back) until it
  is applied, so the frontend can ship first.
- `npm run build` must pass (it typechecks the app and `api/`, and loads every API route under
  Node ESM). Add a new route to `scripts/verify-api-bundle.mjs`.
- When the office changes in tito-crm, consider whether the change belongs here too, and the
  other way round.

## Monitoring and the law (NDPA 2023)

The team works in Nigeria. Everything the office records stays at levels A to C of tito-crm's
OFFICE-FEATURES-PLAN.md section 2.3: reports and presence, what people declare, activity in the
office itself. No screenshots, keystrokes, webcam, other apps or websites, or covert monitoring,
ever. Nothing automatic acts on the figures beyond trial/enforced sign-outs; no pay or
disciplinary step follows from them alone. The staff notice (`src/lib/officeNotice.ts`) must stay
true of the code: if the office starts recording something new, the notice changes first (new
`NOTICE_VERSION`), and is reviewed before it goes out.

## Brand (from the JustUsedTech website's CLAUDE.md; exact, do not adjust)

| Token | Hex | Use |
| --- | --- | --- |
| `--brand-green` | `#00A652` | Bright fills and large type only (3.1:1 on white) |
| `--brand-green-dark` | `#007A37` | Primary action fill (5.4:1 with white) |
| `--brand-blue` | `#00ADEF` | Icon accent |
| `--brand-gold` | `#FFD966` | Accent on dark regions only; never text on light |

- Wordmark: **JUSTUSED** (here "JUSTUSED Office"). Full legal name in copy: **JustUsedTech**.
- Font: **Nunito** only.
- Rounded and friendly: generous radii, pill buttons, soft shadows, no sharp corners.
- Logo files in `public/` are cropped PNG placeholders; every use carries
  `{/* TODO: swap for final vector/SVG logo when client delivers it */}`.
- The office floor's lit room is `#08462a` (the brand dark green fails contrast for the floor's
  smaller text); see the comment in `src/index.css`.

## Writing

- Zero em-dashes in anything a person reads (screens, emails, alt text).
- Plain words. "Working elsewhere", not "outside the CRM": there is no CRM here.
- Never fabricate a quote, a figure or a person.
