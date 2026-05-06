# MGH Robotic Surgery PA Team Calendar (PWA)

A login-gated team operations calendar that replaces the team's Outlook
calendar — delivered as an installable Progressive Web App with push
notifications and a Sunday-night email digest.

## Stack

- **Frontend** — static HTML, vanilla JS, no build step. CDN imports only.
- **Database/API** — Supabase Postgres with Row Level Security
- **Team auth** — Supabase Auth (email + password)
- **Admin auth** — `ADMIN_PASSWORD` env var → HMAC session token
- **Hosting** — Vercel (static + serverless functions in `/api`)
- **Scheduled jobs** — Vercel Cron (free Hobby tier)
- **Email** — Resend (free tier; per-event + Sunday digest)
- **Push** — Web Push Protocol with VAPID
- **PWA** — `manifest.json` + service worker + iOS install tip

## File structure

```
team-calendar/
├── public/
│   ├── index.html              ← the calendar (gated by auth)
│   ├── login.html              ← sign-in / sign-up entry
│   ├── manifest.json           ← PWA manifest
│   ├── sw.js                   ← service worker
│   └── icons/
│       ├── icon-192.png  icon-512.png
│       ├── icon-maskable-192.png  icon-maskable-512.png
│       └── apple-touch-icon.png
├── api/
│   ├── _lib.js                 ← shared helpers
│   ├── _push.js                ← push helper (web-push + VAPID)
│   ├── env.js                  ← public env to browser
│   ├── check-eligible.js       ← POST {email}
│   ├── submit-request.js       ← POST {entry, jwt}
│   ├── subscribe-push.js       ← POST {subscription, scope}
│   ├── unsubscribe-push.js     ← POST {endpoint}
│   ├── admin-verify.js
│   ├── admin-create.js  admin-decide.js  admin-update.js  admin-delete.js
│   ├── notify-request.js       ← per-event email
│   └── cron-weekly-digest.js   ← runs every Sunday 8 PM ET
├── supabase/
│   ├── schema.sql
│   └── seed.sql
├── package.json
├── vercel.json
└── README.md
```

## Step-by-step setup

You'll need accounts at: **Supabase** (free), **Vercel** (free), and
optionally **Resend** (free) for email.

### 1. Push notification keys (VAPID)

Generate ONE pair locally, save them to a notes file. They never need to
change.

```
npx web-push generate-vapid-keys
```

Output:
```
=======================================
Public Key: BNxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...
Private Key: yyyyyyyyyyyyyyyyyyyyyyyy...
=======================================
```

Save the **public** key as `VAPID_PUBLIC_KEY` and **private** as
`VAPID_PRIVATE_KEY` for later.

### 2. App icons (optional)

The repo ships with simple placeholder icons in `public/icons/`. To make
proper ones with your team logo:

1. Upload a square PNG at https://realfavicongenerator.net.
2. Download the package and replace these five files (keep the names):
   - `icon-192.png`, `icon-512.png`
   - `icon-maskable-192.png`, `icon-maskable-512.png`
   - `apple-touch-icon.png`

### 3. Supabase

1. Create a project at https://supabase.com.
2. **SQL Editor → New query** → paste `supabase/schema.sql` → Run.
3. (Optional) Run `supabase/seed.sql` for sample team members. **Skip this
   for production** — add real members instead (see "Adding new team
   members later" below).
4. **Authentication → URL Configuration**: set **Site URL** to your
   eventual Vercel URL, add `<URL>/login.html` to **Redirect URLs**.
5. **Authentication → Email Templates → Confirm signup**: customize HTML
   to match the design system if you like.
6. **Settings → API**: copy **URL**, **anon public**, and **service_role**
   keys.

### 4. Resend (optional but recommended)

For per-event admin notifications + Sunday digest:

1. Sign up at https://resend.com.
2. Add and verify your sending domain (or use `onboarding@resend.dev` for
   testing — works only for the verified account email).
3. Create an API key.

### 5. Vercel deploy

Push this repo to GitHub, then "Import Project" at vercel.com. After the
first deploy, set environment variables in **Project Settings → Environment
Variables** (apply to **Production**, **Preview**, **Development**), then
redeploy.

### 6. Confirm cron is registered

The repo's `vercel.json` declares the weekly digest job. After deploying,
verify it shows up in **Vercel Dashboard → your project → Settings → Cron
Jobs**. To test manually, click **Run Now** there.

### 7. Try it

Open the deployed URL → land on the login page. Add yourself to
`team_members` in Supabase first (Table Editor → Insert row), then click
**First Time?** on the login screen, enter your email, set a password,
confirm via emailed link, sign in.

## Environment variables

| Name                  | Required | Purpose |
| --------------------- | -------- | ------- |
| `SUPABASE_URL`        | yes | Project URL |
| `SUPABASE_ANON_KEY`   | yes | anon public key (browser-visible) |
| `SUPABASE_SERVICE_KEY`| yes | service_role key (server only) |
| `ADMIN_PASSWORD`      | yes | Admin password Mike types in the Admin modal |
| `ADMIN_TOKEN_SECRET`  | yes | Long random string for HMAC tokens — `openssl rand -hex 32` |
| `ADMIN_EMAIL`         | rec | Recipient for new-request notifications + admin digest |
| `RESEND_API_KEY`      | opt | Skip to disable all email |
| `RESEND_FROM`         | opt | e.g. `PA Calendar <pto@yourdomain.com>` |
| `VAPID_PUBLIC_KEY`    | opt | Skip to disable push (calendar still works) |
| `VAPID_PRIVATE_KEY`   | opt | Pair with public key |
| `CRON_SECRET`         | opt | Vercel auto-attaches as `Authorization: Bearer ${CRON_SECRET}` to scheduled hits — set to a long random string to lock the cron endpoint |
| `APP_URL`             | rec | Used in digest CTAs (e.g. `https://pa-calendar.vercel.app`) |

## Custom domain (optional)

`*.vercel.app` works fine and includes free SSL. Add a custom domain in
**Vercel → Project → Domains**, follow DNS instructions, then update
**Supabase → Authentication → URL Configuration** to match.

## Onboarding workflow for team members

1. Mike adds the row in Supabase **Table Editor → team_members → Insert
   row** (name + email + color).
2. Mike sends the calendar URL.
3. Member clicks **First Time?**, enters their email; eligibility check
   confirms they're on the roster.
4. Member sets a password and confirms via email.
5. Member signs in, then **Add to Home Screen** (iOS Share button →
   Add to Home Screen, or Android browser menu → Install).
6. On next launch, sees the **Enable notifications** prompt — tap Enable.

## Setting up the admin (Mike)

Admin auth (the password) is independent of team-member auth (the Supabase
account), but the calendar UI itself requires a Supabase Auth session plus
a matching `team_members` row. So Mike needs both:

1. Add Mike's row to `team_members` (set `active = false` if you don't
   want him counted in KPIs / appearing as a regular team member).
2. Mike signs up at `/login.html` like a team member.
3. Once signed in, he clicks **Admin** in the masthead and types
   `ADMIN_PASSWORD`.

## Daily use

- **Members** click "Request Time Away" → pick PTO / CME / PD, dates,
  optional note. Live conflict preview appears as you change dates.
  Submit triggers an admin push + email.
- **Admin** taps the push notification → calendar opens to that entry.
  Approve / Deny / Reset / Edit / Delete.
- **Admin** also uses **Add Entry** for Events / Coverage Adds / on-behalf
  Time Away. Direct-create skips conflict rules; **member is NOT
  notified** (the modal warns about this).
- **Tap any day cell** → Day Overview shows everything on that day. Tap a
  chip → individual detail. Tap "+N more" → Day Overview.

## Sunday-night digest

- Auto-fires every Sunday ~8 PM ET (`0 1 * * 1` UTC = Mon 1 AM UTC).
- Each member with at least one entry next week gets a personalized
  email; members with no entries are skipped (no spam).
- Admin always gets a master summary, including a "Heads up" section
  for any day with 2+ people off.
- CME entries include the conference link.
- To pause: comment out the `crons` block in `vercel.json` and redeploy.
- To test now: **Vercel Dashboard → Cron Jobs → Run Now** on
  `/api/cron-weekly-digest`.
- If `RESEND_API_KEY` isn't set, the endpoint returns
  `{ skipped: true, reason: 'RESEND_API_KEY not set' }` and does nothing.

## Conflict rules cheat sheet

For Time Away submissions only (Events / Coverage Adds bypass).

| Range            | Other members already off (approved or pending) | Result                |
| ---------------- | ----------------------------------------------- | --------------------- |
| Single day       | 0                                               | OK → pending          |
| Single day       | 1                                               | OK → pending (watch)  |
| Single day       | ≥ 2                                             | **Blocked**           |
| Multiple days    | 0 across every day                              | OK → pending          |
| Multiple days    | ≥ 1 on any day                                  | **Blocked**           |

The same member submitting twice doesn't block themselves.

## Notes field

Every entry has an optional **Notes** field. Visibility:

- **Admin** sees all notes on all entries.
- **Owner** sees their own notes on their own entries.
- **Other team members** see the entry but the Notes row is hidden in the
  detail modal and the Day Overview preview.

The submission UI helper text says: *"Visible to admin and you only."*

## CME conference link

When type = CME:

- Field appears in the request modal.
- **Required** for member submissions (must be a valid `http(s)` URL).
- **Optional** for admin direct-create.
- Renders as a clickable link in the detail modal.
- Included in the Sunday-night digest.

## Admin overrides

- `/api/admin-create` skips conflict rules entirely.
- `/api/admin-decide` on **approve** re-checks against approved-only
  entries; on conflict, the UI shows a confirm dialog with **Override &
  Approve**.

## Adding new team members later

```sql
insert into team_members (name, email, color) values
  ('New Person', 'new.person@example.com', '#3a5a6e');
```

Pick a color from the established palette (see `supabase/seed.sql`). Then
send the URL and tell them to sign up via "First Time?".

To deactivate a member (preserves history):

```sql
update team_members set active = false where email = 'former@example.com';
```

## Troubleshooting

- **Blank page, no error message** — open browser console (F12). The
  watchdog in the page tells you what failed (env vars missing, CDN
  blocked, Supabase URL wrong). Check the visible "Configuration Error"
  message; it lists the most common causes.
- **Push not working on iOS** — must be installed to home screen first.
  iOS Safari only delivers push to standalone PWAs. After installing,
  open the app, then tap **Enable** on the notifications prompt.
- **Stale calendar** — fully close and reopen the PWA (swipe up + away on
  iOS). The service worker activates the new shell on next launch.
- **Email confirmation expired** — admin re-sends from
  Supabase **Authentication → Users → ⋯ → Send magic link**.
- **Digest didn't send** — check Vercel logs filtered to
  `/api/cron-weekly-digest`. Verify `RESEND_API_KEY` is set and `ADMIN_EMAIL`
  too. The endpoint logs which rows it tried to email.
- **"You can only push to admin/member with token"** — the admin push
  subscription is per-browser-per-tab. After the admin signs in for the
  first time, the prompt re-appears so they can subscribe to admin
  notifications too.

## Future extensions

- Per-person YTD allowances with budget tracking
- ICS export so members can subscribe from their phone calendar
- Configurable conflict thresholds per category
- Audit log of all admin actions
