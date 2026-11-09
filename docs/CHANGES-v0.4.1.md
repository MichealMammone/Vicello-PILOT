# Vicello Pricing Platform 0.4.1 – simple deployment and email

Release date 9 November 2026. Package `2026-11-09_Rev09_Vicello-Platform-GitHub-Upload.zip`.
Pricing, quotes, price books, jobs, reporting, statuses, history and backups work exactly as in 0.4.0.
No database change.

## Deployment, simplified

- **One Render Web Service** from GitHub branch `main`: Render → New → Web Service → Connect → Deploy. No
  Blueprint, no staging branch, no second service, no test environment.
- `render.yaml` now describes only that one service and is **optional reference** (a Web Service ignores it).
- `.node-version` (`24`) so Render picks Node 24 with nothing to set.
- `npm install` / `npm start` work as Render's build and start commands; `npm run build` exists and does nothing
  (there is nothing to compile).
- New health check `GET /healthz` (`{"ok":true,"version":"0.4.1"}`), which also checks the database answers.
- New guides at the top of the package: **README_FIRST.md** (7 steps for a business owner) and
  **DEPLOY_TO_RENDER.md** (exact values). `.env.example` now lists and explains every setting, including the ones
  this program does **not** use (`DATABASE_URL`, `SESSION_SECRET`).
- Removed: `READ ME FIRST.txt` and `docs/DEPLOYMENT.md` (replaced by the two guides), `docs/test-environment.md`
  (no test environment). They may still be in GitHub from earlier uploads; they are harmless, or delete them there.

## Email (SMTP)

Optional: without `SMTP_HOST` nothing is sent and everything works as before.

| When | Who gets it | What |
|---|---|---|
| A user is added | the new user | web address, their email, temporary password (they must change it at first sign-in) |
| An owner resets a password | that user | the new temporary password |
| "Forgotten your password?" on the sign-in page | that user (if the email has an active account) | a one-time link to choose a new password, valid 60 minutes |
| A password is changed with a reset link | that user | a notice that it changed |
| Off-site backup fails (first time, then at most every 6 hours) and when it works again | owners, or `NOTIFY_EMAIL` | the reason and what to do |
| A backup is restored | owners, or `NOTIFY_EMAIL` | where from, by whom, the safety copy |
| Settings → Users & access → **Send test email** | whoever you choose | a test message, or the mail server's exact error |

Settings: `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS / 465 TLS), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`,
`SMTP_FROM_NAME`, `SMTP_REPLY_TO`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `NOTIFY_EMAIL`, `APP_URL` (defaults to
Render's own address). Encryption is required unless `SMTP_REQUIRE_TLS=0`. Built on Node's own `net`/`tls`, so there
are still no dependencies.

Security notes: the "forgotten password" answer is the same whether or not the email has an account; requests are
limited to 5 per 15 minutes per address; links are single-use, stored only as a hash, and expire after 60 minutes
(a restart cancels open links); using one signs that user out everywhere. Resets are recorded in the activity log.
Temporary passwords are emailed because the program forces a change at first sign-in.

## Files

New: `README_FIRST.md`, `DEPLOY_TO_RENDER.md`, `.node-version`, `server/services/email.service.js`,
`tests/email.test.js`, `docs/CHANGES-v0.4.1.md`.
Changed: `render.yaml`, `package.json`, `.env.example`, `server/config.js` (version, email settings, APP_URL),
`server/index.js` (start-up line for email), `server/routes.js` (`/healthz`, forgot/reset password, emails on new
user and reset, test email, restore notice), `server/services/account.service.js` (reset links),
`server/services/backup.service.js` (failure/recovery notices), `public/js/app.js`, `public/js/views/auth.js`
(forgotten password, reset page), `public/js/views/settings.js` (Email panel, email-aware messages),
`README.md`, `docs/backup-strategy.md`, `docs/disaster-recovery.md`.

## Testing

- `npm test`: **79 tests, all pass** (72 from 0.4.0 + 7 email tests against a stand-in mail server: AUTH PLAIN and
  LOGIN, UTF-8 subjects, wrong password and missing encryption reported clearly, welcome and reset emails, the
  forgotten-password link end to end, one-time use, the test-email button, backup-failure alerts without repeats,
  `/healthz`).
- Not tested against a real mail provider (none is configured here). Step 6 of README_FIRST.md (Send test email)
  is that test; it shows the provider's exact reply if a setting is wrong.
