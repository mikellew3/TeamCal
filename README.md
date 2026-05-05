# MGH Robotic Surgery PA Team Calendar

A login-gated team operations calendar that replaces the team's Outlook calendar.
Members sign in to view the team calendar and submit time-away requests for
themselves. The admin (Mike) approves/denies requests and creates everything
else (events, coverage adds).

The visual language matches the PA Staffing Executive Summary report exactly:
Inter + Source Serif 4 typography, deep teal `#1f6b6b` accent, warm off-white
page background, white "paper sheet" with a subtle drop shadow.

## Stack

- **Frontend** – static HTML, vanilla JS, no build step. CDN imports only.
- **Database/API** – Supabase Postgres with Row Level Security
- **Team auth** – Supabase Auth (email + password)
- **Admin auth** – `ADMIN_PASSWORD` env var → HMAC session token
- **Hosting** – Vercel (static + serverless functions in `/api`)
- **Email** – Resend (free tier, optional)

## File structure

```
team-calendar/
├── public/
│   ├── index.html              ← the calendar (gated by auth)
│   └── login.html              ← sign-in / sign-up entry point
├── api/
│   ├── _lib.js                 ← shared helpers (HMAC, conflict-check, etc.)
│   ├── env.js                  ← serves SUPABASE_URL + SUPABASE_ANON to browser
│   ├── check-eligible.js       ← POST {email} → {eligible}
│   ├── submit-request.js       ← POST {entry, jwt} → conflict-checked submit
│   ├── admin-verify.js         ← POST password → HMAC session token
│   ├── admin-decide.js         ← POST {id, status, token, override?}
│   ├── admin-create.js         ← POST {entry, token} → bypass conflict rules
│   ├── admin-update.js         ← POST {id, patch, token}
│   ├── admin-delete.js         ← POST {id, token}
│   └── notify-request.js       ← POST {entry_id} → emails admin via Resend
├── supabase/
│   ├── schema.sql
│   └── seed.sql
├── package.json
├── vercel.json
└── README.md
```

## First-time Supabase setup

1. Create a new Supabase project at https://supabase.com.
2. In the SQL editor, paste and run **`supabase/schema.sql`**.
3. Optionally run **`supabase/seed.sql`** to populate sample team members.
   For real use, replace these with the actual roster (see "Adding new team
   members" below).
4. Enable email auth: **Authentication → Providers → Email** (it's on by
   default — verify the toggle is enabled).
5. **Authentication → URL Configuration**: set the **Site URL** to your
   deployed Vercel URL (e.g. `https://teamcal.vercel.app`). Add
   `https://teamcal.vercel.app/login.html` to the **Redirect URLs** allow-list.
6. **Authentication → Email Templates → Confirm signup**: customize the
   template to match the report's visual language. Suggested HTML:
   ```html
   <div style="font-family:'Inter',sans-serif;background:#e8e6e1;padding:32px;">
     <div style="background:#fff;max-width:480px;margin:0 auto;padding:32px;
                 box-shadow:0 8px 32px rgba(0,0,0,0.12);border-radius:2px;">
       <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;
                   color:#1f6b6b;font-weight:600;margin-bottom:6px;">
         MGH Robotic Surgery PA Team
       </div>
       <h1 style="font-family:'Source Serif 4',serif;font-size:24px;
                  font-weight:600;margin:0 0 12px;color:#1a2a33;">
         Confirm your email
       </h1>
       <p style="color:#3a4a52;font-size:13px;line-height:1.5;">
         Click below to confirm your email and finish creating your account.
       </p>
       <p>
         <a href="{{ .ConfirmationURL }}"
            style="display:inline-block;background:#1f6b6b;color:#fff;
                   padding:11px 18px;font-weight:600;border-radius:2px;
                   text-decoration:none;font-size:13px;">
           Confirm email
         </a>
       </p>
     </div>
   </div>
   ```
7. **Project Settings → API** → copy the **Project URL**, **anon public key**,
   and **service_role key**. You'll need them as env vars below.

## Resend setup (optional)

If you want admin email notifications:

1. Create a free account at https://resend.com.
2. Add your sending domain (or use the test mode with `onboarding@resend.dev`
   as the From address — works only for the verified account email).
3. Create an API key — save it for `RESEND_API_KEY`.
4. Set `RESEND_FROM` like `MGH PA Team Calendar <pto@yourdomain.com>` and
   `ADMIN_EMAIL` to Mike's address.

If `RESEND_API_KEY` is unset, `/api/notify-request` is a silent no-op — submit
flow still works, but no email is sent.

## Vercel deploy

Either of:

**A. Vercel CLI**
```
npm install -g vercel
vercel login
vercel link        # one-time
vercel             # preview deploy
vercel --prod      # production deploy
```

**B. GitHub import**
Push this repo to GitHub, then "Import Project" in the Vercel dashboard.

After the first deploy, set environment variables in **Project Settings →
Environment Variables** for the **Production** environment, then redeploy.

## Environment variables

| Name                     | Required | Purpose                                                      |
| ------------------------ | -------- | ------------------------------------------------------------ |
| `SUPABASE_URL`           | yes      | Supabase project URL                                         |
| `SUPABASE_ANON_KEY`      | yes      | Supabase anon (public) key — exposed to the browser          |
| `SUPABASE_SERVICE_KEY`   | yes      | Supabase service role key — server-side only, bypasses RLS   |
| `ADMIN_PASSWORD`         | yes      | Password for admin sign-in (Mike picks this)                 |
| `ADMIN_TOKEN_SECRET`     | yes      | Long random string, used to sign HMAC admin session tokens   |
| `ADMIN_EMAIL`            | rec      | Email recipient for new-request notifications                |
| `RESEND_API_KEY`         | opt      | Resend API key (omit to disable email notifications)         |
| `RESEND_FROM`            | opt      | From-address for Resend (`Name <addr@domain>`)               |

Generate `ADMIN_TOKEN_SECRET` with e.g. `openssl rand -hex 32`.

## Custom domain

Add the domain in **Vercel Project → Domains**, follow DNS instructions, then
update the Supabase **Site URL** + **Redirect URLs** to match.

## Setting up the admin (Mike)

Admin auth is independent of team-member auth: the "Admin" button in the
masthead asks for `ADMIN_PASSWORD` and stores an HMAC token in
`sessionStorage`. But the calendar UI itself requires a Supabase Auth session
plus a matching `team_members` row, so Mike still needs to sign in like a
team member.

Two practical options:

1. **Add Mike as a team member.** Insert a `team_members` row for Mike
   (using whatever email he wants), have him sign up via "First Time?",
   then he can promote himself to admin via the "Admin" button. Set his
   row's `active = false` if you don't want him appearing in the team
   roster / KPIs.
2. **Add a dedicated admin user.** Same as above but with an alias email
   like `admin@yourdomain.com`, only used for calendar access.

Either way, `ADMIN_PASSWORD` is what gates admin-only actions
(approve/deny/edit/delete/direct-create) — independent of which Supabase
account is signed in.

## Onboarding workflow for team members

1. Mike adds the team member's email to the `team_members` table (see "Adding
   new team members" below).
2. Mike sends the new member the calendar URL.
3. The member clicks "First Time?" on the login page, enters their email; the
   eligibility check confirms they're on the roster.
4. The member chooses a password and submits.
5. Supabase emails them a confirmation link. After clicking it, the
   `link_auth_user_to_team_member` trigger automatically links their
   `auth.users` row to their `team_members` row by email match.
6. They sign in and start using the calendar.

If a member tries to sign up without a matching `team_members` row, the
eligibility check rejects them at step 3.

## Daily use

- **Members** click "Request Time Away" → pick PTO / CME / PD, dates, optional
  note. The modal shows a live conflict preview before submission. On submit
  the entry appears with a striped pending pattern; admin gets an email.
- **Admin** clicks "Admin", enters the password, then can:
  - Click any chip to approve / deny / reset / edit / delete
  - Click any day cell to add a new entry
  - Use "Add Entry" in the masthead for any category (Time Away / Events /
    Coverage Adds), any team member or team-wide
- Admin sessions live in `sessionStorage` and end when the tab closes.

## Conflict rules cheat sheet

For **Time Away** entries only (Events and Coverage Adds have no conflict
rules — admin always direct-creates them).

| Range            | Other members already off (approved or pending) | Result                |
| ---------------- | ----------------------------------------------- | --------------------- |
| Single day       | 0                                               | OK → pending          |
| Single day       | 1                                               | OK → pending (watch)  |
| Single day       | ≥ 2                                             | **Blocked**           |
| Multiple days    | 0 across every day                              | OK → pending          |
| Multiple days    | ≥ 1 on any day                                  | **Blocked**           |

The same person submitting twice doesn't block themselves — only OTHER members
count.

## Admin overrides

- `/api/admin-create` skips the conflict check entirely → admin can stack any
  number of entries on any day.
- `/api/admin-decide` on **approve** re-runs the check against
  *approved-only* entries. If a conflict is found, the UI shows a confirm
  dialog with an **Override & Approve** button that re-submits with
  `override: true`.

## Adding new team members later

```sql
insert into team_members (name, email, color) values
  ('New Person', 'new.person@example.com', '#3a5a6e');
```

Pick any hex color from the established palette range — see the team_members
seed in `supabase/seed.sql` for the institutional palette. Then send the
person the URL and tell them to sign up via the "First Time?" tab.

To deactivate a member (preserves history):

```sql
update team_members set active = false where email = 'former@example.com';
```

## Future extensions

- **Per-person YTD tracking** with allowance configuration
- **ICS export** so members can subscribe from their phones
- **Configurable conflict thresholds** per category (e.g. allow up to 2 off
  during low-volume weeks)
- **Push notifications** for newly-decided requests
- **Audit log** of all admin actions

## Self-check

After deploy, run through these by hand:

1. **Visual fidelity** – warm-gray bg, white sheet with shadow, Inter +
   Source Serif 4 loaded, teal accent on eyebrows / section tags / buttons.
2. **Login flow** – both tabs, eligibility error states, account creation.
3. **Auth guard** – visit `/index.html` while signed out → bounces to login.
4. **Empty calendar** – fresh project with seed-only data renders cleanly.
5. **Member request** – only Time Away types shown, no member field, live
   preview works, conflict rules trigger correctly.
6. **Admin add** – all 3 categories, all 8 types, member dropdown includes
   "Team-wide", no conflict block.
7. **Admin override** – approve a pending request that conflicts with an
   already-approved entry → confirm dialog appears, override succeeds.
8. **Email** – submitting a request triggers the Resend email (if configured).
