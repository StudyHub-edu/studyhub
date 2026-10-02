# StudyHub

One Node app, one port, three things merged together — now organized as a
clear **frontend/** (everything served to the browser) and **backend/**
(the server and data) split.

| Path | What it is |
|---|---|
| `/` | Login, dashboard, profile, etc. (static site + Supabase Auth) |
| `/community/` | Community: chat, Q&A, announcements, resources |
| `/community/#/calendar` | Calendar (lives inside the Community app) |
| `/library/` | The ebook Library |

**Login only ever happens at `/` (`index.html`).** Community, Calendar and
Library never show a login form — see "How login works" below.

## Project layout

```
frontend/
  public/      <- main site (login, dashboard, teacher/admin dashboards, notes, ...)
  community/   <- Community + Calendar's HTML/CSS/JS (no server code here)
  library/     <- Library's HTML/CSS/JS + reader vendor libs (epub.js, pdf.js)

backend/
  server.js              <- entry point: mounts everything below on one port
  package.json
  .env.example
  supabase/               <- SQL schema + RLS policies (run these in Supabase)
  apps/
    community/
      server.js           <- Express sub-app, mounted at /community
      db.js                <- in-memory + JSON-file "database"
      calendar.js, lib/     <- calendar feature
      data/db.json         <- created on first run, not committed
    library/
      server.js           <- Express sub-app, mounted at /library
      data.json            <- book catalog
      books/, covers/       <- the actual files
```

The split is purely about *where a file lives*, not about how the app runs:
it's still one `npm start`, one port. `backend/server.js` serves
`frontend/public` directly and mounts the two apps in `backend/apps/`, which
in turn serve `frontend/community` and `frontend/library`.

## 1. Install

```bash
cd backend
npm install
cp .env.example .env
```

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the same Supabase project used
by `frontend/public/js/config.js`. The anon/publishable key is public by
design; never put a service-role/secret key in frontend code.

For the admin management page, copy the Supabase **service-role/secret key**
into `SUPABASE_SERVICE_ROLE_KEY` in your local `backend/.env`. This key stays
on the server; never paste it into chat, frontend files, or the repository.
Restart the Node server after changing `.env`. Without it, the admin forms
show a configuration error and do not perform privileged operations.

## 2. Set up the database

Run these files in Supabase SQL Editor, one at a time in this order:

```
schema.sql
migration_profile_and_identity.sql
identity_ocr_review_migration.sql
migration_real_institutions.sql
migration_phone_signup.sql
dashboard_schema.sql
migration_map_and_feed.sql
map_schema.sql
map_coordinates_seed.sql
admin_schema.sql
past_papers_schema.sql
ai_teacher_schema.sql
notes_schema.sql
```

`migration_map_and_feed.sql` extends the community question feed. `map_schema.sql`
adds the map columns and saved locations. `map_coordinates_seed.sql` deliberately
adds no fake coordinates; the map looks up missing institution locations when
selected, and admins can save verified coordinates for future visits.

`past_papers_schema.sql` creates the private image bucket and access policies
used by the Past Papers page, plus per-user save and rating tables. Run it
after the core schema and map schema. Re-run it after updating StudyHub so the
bucket's allowed file types and save/rating tables are current.
The map uses OpenStreetMap tiles and lookup, plus OpenStreetMap-based routing
services for road distance/time; these public services require an internet
connection and may be rate-limited.

`notes_schema.sql` extends the existing `resources` table for the Notes feature
(search/upload/save/rate) and creates the `notes-uploads` storage bucket. Re-run
it after updating StudyHub so the bucket accepts only supported image uploads.
Notes, shared resources, questions and answers can include up to 10 JPG, PNG,
or WebP images (25 MB each); question papers can also include up to 10 images.
Re-run both `notes_schema.sql` and `past_papers_schema.sql` after updating so
the new image URL/path columns and private image access policies are installed.
Existing stored PDFs remain accessible if they were uploaded before the
image-only upload change.

### AI Teacher setup

The AI Teacher saves each user's conversation in `ai_chat_messages`. It reloads
the latest 50 messages on the page and sends up to the latest 40 messages as
conversation context to the AI model, so the assistant can follow the chat
after a refresh. This is bounded chat context, not model training or unlimited
memory; the full saved transcript remains in Supabase until the user clears it.

The AI reply service is a Supabase Edge Function, separate from the local
Node server. From `backend/`, link the Supabase CLI to the same project as
`frontend/public/js/config.js`, set one provider secret, and deploy it:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase secrets set OPENAI_API_KEY=YOUR_KEY
npx supabase functions deploy ai-teacher
```

Alternatively, set `OPENROUTER_API_KEY` instead of `OPENAI_API_KEY`. Never
put either key in frontend code, commit it, or share it in chat. The `openrouter/free`
model is selected when using OpenRouter; free model availability and capabilities
can vary. After deployment, sign in and test AI Teacher. If the browser reports a
CORS/preflight or network error, confirm the function is deployed to the linked
project; if the function responds but cannot generate an answer, check its
provider secret and Supabase function logs.

`identity_ocr_review_migration.sql` adds storage for the full text recognized
from ID cards. Run it after `migration_profile_and_identity.sql` so new scans
can include the detected text in the admin review queue. Admins can open
**Verify Accounts** from the admin dashboard to view the private ID photo,
submitted account details, and OCR text, then verify or reject the request.
ID images stay in the private `id-cards` bucket; only the owner and admin can
read them. Dashboard users can click **Verify account** to open the profile
scanner. Live-preview capture needs camera permission; if that is unavailable
or unreliable, **Use camera or choose a photo instead** opens the device camera
or image picker and submits a JPG, PNG, or WebP ID photo (up to 10 MB).
Live-preview camera access works on `localhost` without HTTPS; deployed sites
must use HTTPS. The server's `Permissions-Policy` allows camera access only
from StudyHub's own origin. The card-outline tracker uses OpenCV.js; if that
optional third-party script is unavailable, OCR continues with the on-screen
guide.

## 3. Set up Supabase email OTP delivery

Your login page already does everything (sign-up email OTP, password reset)
through **Supabase Auth** — there's no separate OTP code to write. You just
need to tell Supabase to send those emails through your own Gmail account
instead of Supabase's limited default sender:

1. In Supabase → Authentication → Settings, keep email confirmations enabled.
2. In Supabase → Authentication → Email Templates → Confirm signup, use the
   `{{ .Token }}` template variable so the message contains the one-time code
   entered on StudyHub's verification page (rather than only a confirmation link).
   Add the local and deployed verification pages to Supabase → Authentication →
   URL Configuration → Redirect URLs (for example,
   `http://localhost:3000/verify.html` and `https://your-domain.example/verify.html`).
3. For delivery to users outside the Supabase project team, configure a custom
   SMTP sender. For Gmail, turn on 2-Step Verification at
   `myaccount.google.com/security`, create an App Password at
   `myaccount.google.com/apppasswords`, then in Supabase → Authentication →
   Settings → SMTP Settings, turn on
   "Enable Custom SMTP" and fill in:
   - Host: `smtp.gmail.com`
   - Port: `465`
   - Username: your Gmail address
   - Password: the 16-character App Password (not your normal Gmail password)
   - Sender email: the same Gmail address

Sign-up OTP emails and password-reset emails now come from your configured
sender. Gmail imposes sending limits; for a public production app, use a
transactional SMTP provider and a verified sending domain.

The sender account is separate from a user's account: once custom SMTP is
configured and verified, users can register with any valid email address,
not just Gmail. Supabase's default mail service may only send to project
team addresses, which is why unconfigured SMTP often appears to work only
for the owner's email.

## 3a. Enable Google sign-in

1. In Google Cloud Console, create an OAuth client ID for a Web application.
2. Add Supabase's callback URL
   (`https://rhcpnzduqishmbmfdwat.supabase.co/auth/v1/callback`)
   to Google's **Authorized redirect URIs**.
3. In Supabase → Authentication → Sign In / Providers, enable Google and
   paste the client ID and client secret.
4. In Supabase → Authentication → URL Configuration, set the Site URL to
   your deployed StudyHub origin and allow the app redirect URL
   (`https://your-domain.example/dashboard`). For local development, also
   allow `http://localhost:3000/dashboard`.

Google's provider credentials and Supabase redirect allow-list are required;
the button cannot complete OAuth until those project settings are correct.
New Google users are sent through onboarding to choose their institution and
student/teacher profile details.

## 3b. Admin account

The fixed admin email is `teamofstudyhub@gmail.com`. Create that user in
Supabase Authentication (or register it through StudyHub), set a unique,
strong password in Supabase, then re-run `backend/supabase/admin_schema.sql`.
That SQL promotes the configured account and removes the admin role from any
previous admin account. Never put an admin password in frontend code, SQL, or
the repository; use Supabase Auth's password reset flow to change it.

After logging in as that admin, the dashboard's **Add New User**, **Add
Teacher**, **Add School/College**, and **Upload Content** actions open
`/admin-tools.html`. User creation sets an initial password that you must
share securely. Content uploads are published to the Notes library and
require `notes_schema.sql` (including its `notes-uploads` Storage bucket);
optional institution map coordinates require `map_schema.sql`.

## 4. Run it

```bash
cd backend
npm start
```

Then open `http://localhost:3000`.

## 5. Free demo deployment on Render

StudyHub's main site, Community, Calendar, Library, APIs, and live chat are
served by one Node/Socket.IO process and use same-origin routes. Deploy the
whole app as one Render Web Service; splitting it across Vercel and Render
would require changing the API, authentication bridge, and WebSocket routing.

1. Push this project to a GitHub repository. Do not add `.env`, Supabase
   service-role keys, or any other secrets to the repository.
2. In Render, choose **New → Blueprint**, connect the repository, and let
   Render use the root `render.yaml`. It sets the backend root directory,
   `npm ci`, `npm start`, and the free Web Service plan.
3. When prompted, add `SUPABASE_SERVICE_ROLE_KEY` from Supabase → Project
   Settings → API Keys. It is required for admin account/institution tools.
   Render stores it as a secret environment variable; never add it to
   `frontend/public/js/config.js`.
4. Once deployed, copy the service's `https://<service-name>.onrender.com`
   address. In Supabase → Authentication → URL Configuration, set that as
   the Site URL and add the deployed
   `https://<service-name>.onrender.com/verify.html` and
   `https://<service-name>.onrender.com/dashboard.html` to allowed redirect
   URLs. Keep any localhost URLs needed for development. If Google sign-in
   is enabled, add the Render origin to Google's authorized JavaScript
   origins; keep Supabase's callback URL as Google's authorized redirect URI.
5. Open the Render HTTPS address, sign in, and smoke-test the main dashboard,
   Community, Calendar, Library, and admin tools. Render supports this
   app's Socket.IO WebSockets.

This free deployment is suitable for testing/demo use, not durable production
storage. Render's free service has an ephemeral filesystem and can sleep while
idle. StudyHub currently stores Community/Calendar data and the Library
catalogue/uploads on local files, so those can be lost on restart, redeploy,
or instance replacement. Do not rely on free Render for persistent user
content; migrate those stores to a managed database/object storage before a
production launch. Supabase Auth and Supabase Storage content are separate and
are not stored on Render's filesystem.

## How login works (SSO bridge)

- Community/Calendar were originally a *separate* app with their own
  username+password login screen and their own session tokens.
- That login screen has been **removed**. Instead, right after you sign in
  on the main site, `frontend/public/js/auth-bridge.js` calls
  `POST /api/bridge/session` with your Supabase access token. The server
  verifies it with Supabase, reads your real role (student/teacher/admin),
  then silently creates (or reuses, keeping the role in sync) a matching
  Community account and hands the browser a Community session token —
  stored under `sh_token` in `localStorage`, which is exactly what
  Community's front end already reads.
- If Community/Calendar ever find no valid session (e.g. you open the link
  directly without logging in first, or the bridge failed), they redirect
  straight to `/index.html` instead of showing their own login form.
- Signing out (`studyHubSignOut()`) clears both the Supabase session and the
  Community token.
- Library never had a login of its own — it stayed as-is, just re-pathed
  under `/library`.
- The Home logo and Back button in Community/Library/Calendar read a
  `studyhub_home` value (also set by the bridge) to send you back to the
  *correct* dashboard for your role.

## Notes / things you'll likely want to change

- `TEACHER_CODE` (`.env`) — only matters if you build a UI for Community's
  disabled legacy account endpoints in a local test; normal teacher status
  comes from the Supabase profile.
- `LIBRARIAN_CODE` (`.env`) — PIN for the "librarian" unlock button inside
  `/library/` that lets someone add/edit books. It must be a random secret
  with at least 32 characters; library editing stays disabled if it is not
  configured. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- Community's old username/password API is disabled by default; all normal
  sign-in must go through Supabase on the main site. Only the automated
  legacy API test enables it in its isolated process.
- In Supabase → Authentication → Settings, require email confirmation, set
  the minimum password length to 12 or more, and enable leaked-password
  protection when available. The browser enforces a 12-character minimum
  for new and reset passwords too.
- The Community app's data lives in `backend/apps/community/data/db.json`
  (created on first run). The Library's book catalog is
  `backend/apps/library/data.json`. Neither is a real database — fine for a
  hackathon, not for production.
- Colors/fonts across Community and Library were remapped to match the main
  site's dark-navy + blue/violet, Sora/Inter theme (same CSS variable names,
  new values) — if you tweak the brand palette, change it once in
  `frontend/public/css/auth.css`'s `:root` and mirror the values into
  `frontend/community/css/style.css` and `frontend/library/style.css`.
- The official logo lives in one place only:
  `frontend/public/assets/studyhub-logo.png`, referenced by absolute path
  (`/assets/studyhub-logo.png`) from every page, including Community and
  Library.
