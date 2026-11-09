# Deploy to Render – exact settings

One Render **Web Service**, connected to GitHub, branch `main`. No Blueprint, no `render.yaml`, no second service,
no other branches. For the step-by-step walk-through see **README_FIRST.md**.

## The settings form (Render → New → Web Service → your repository)

| Field in Render | Enter exactly | Notes |
|---|---|---|
| **Name** | `vicello-platform` | Any name; it becomes part of the web address (`https://vicello-platform.onrender.com`) |
| **Language** | `Node` | Render detects this from `package.json` |
| **Branch** | `main` | The only branch used |
| **Region** | `Singapore (Southeast Asia)` | Closest to Sydney |
| **Root Directory** | `vicello-platform` | If the files are inside a `vicello-platform` folder in the repository (as in the upload zip). If you put the files at the very top of the repository, leave this **empty** |
| **Build Command** | `npm install` | Render fills this in. Nothing is downloaded or compiled: the program has no dependencies |
| **Start Command** | `npm start` | Render fills this in. It runs `node server/index.js` |
| **Instance Type** | `Starter` | A paid plan is required for the disk below. The Free type has no disk: **all data would be lost on every restart** |
| **Environment Variables** | see below | Can also be added later under Environment |

Then, under **Advanced** (or after creating: your service → the tab named in brackets):

| Setting | Value |
|---|---|
| **Disk** (Disks → Add Disk) | Name `data`, Mount Path **`/var/data`**, Size **1 GB**. Required: this is where the database lives |
| **Health Check Path** (Settings) | **`/healthz`** |
| **Auto-Deploy** (Settings) | **On Commit** (Yes). Every upload to `main` in GitHub redeploys automatically |
| **Node version** | Nothing to set: the package includes `.node-version` = `24` (Render reads it). Optional: `NODE_VERSION` = `24` |

**Port bindings:** nothing to set. Render gives the program a `PORT`; the program uses it and listens on `0.0.0.0`
by itself (it detects Render).

## Environment variables (your service → Environment → Add Environment Variable)

Nothing is required for the program to start. Set these for the features you want. Every setting is explained in
`.env.example`.

| Key | Required? | Example value | What it does |
|---|---|---|---|
| `SETUP_KEY` | Recommended | a phrase you choose, e.g. `blue-kettle-harbour-42` | Typed once on the "Set up your company" screen. If empty, a key is generated and shown in Logs |
| `SMTP_HOST` | For email | `smtp.office365.com` | Your mail provider's SMTP server |
| `SMTP_PORT` | For email | `587` | `587` (STARTTLS) or `465` (TLS) |
| `SMTP_USER` | For email | `quotes@vicello.com.au` | The mail account login |
| `SMTP_PASSWORD` | For email | (the account's app password) | Keep secret |
| `SMTP_FROM_EMAIL` | For email | `quotes@vicello.com.au` | The sender address (the account must be allowed to send as it) |
| `SMTP_FROM_NAME` | Optional | `Vicello` | Sender name |
| `NOTIFY_EMAIL` | Optional | `owner@vicello.com.au` | Who gets backup alerts. Empty = all owners |
| `APP_URL` | Optional | `https://quotes.vicello.com.au` | Only if you use your own domain. Render's address is used automatically otherwise |
| `NODE_VERSION` | Optional | `24` | Already set by `.node-version` |

**Not needed** (other apps ask for these; this one does not): `DATABASE_URL` (the database is a file on the disk),
`SESSION_SECRET` (sign-ins use random tokens stored hashed), `PORT` (Render sets it), `HOST`, `DATA_DIR`.
Off-site backup settings (`OFFSITE_*`, `BACKUP_ENCRYPTION_KEY`) are optional and covered in `docs/backup-strategy.md`.

### Email providers – the values to use

| Provider | SMTP_HOST | SMTP_PORT | SMTP_USER | SMTP_PASSWORD |
|---|---|---|---|---|
| Microsoft 365 / Outlook | `smtp.office365.com` | `587` | the full mailbox address | the mailbox password, or an app password if 2-step sign-in is on. "Authenticated SMTP" must be turned on for that mailbox (Microsoft 365 admin centre → Users → the user → Mail → Manage email apps) |
| Google Workspace / Gmail | `smtp.gmail.com` | `587` | the full address | an **app password** (Google account → Security → 2-Step Verification → App passwords) |
| Brevo (free 300/day) | `smtp-relay.brevo.com` | `587` | your Brevo SMTP login | the SMTP key from Brevo → SMTP & API |
| SendGrid | `smtp.sendgrid.net` | `587` | `apikey` (the word) | your SendGrid API key |

Check your provider's own help page if a value differs. The **Send test email** button (README_FIRST.md, Step 6)
shows the mail server's exact reply if something is wrong.

## Checks after deploy

| Check | Where | Expected |
|---|---|---|
| Deploy finished | Render → Events | "Deploy live" |
| Program started | Render → Logs | `Vicello Pricing Platform 0.4.1`, `Data: /var/data`, and `Email: smtp…` (or "not set up") |
| Disk present | Render → Logs | **No** line saying "WARNING: No disk found at /var/data" |
| Health check | open `https://<your-service>.onrender.com/healthz` | `{"ok":true,"version":"0.4.1"}` |
| Site | open `https://<your-service>.onrender.com` | "Set up your company" (new site) or "Sign in" (existing site) |

## Costs

Render Starter about US$7 a month, plus the 1 GB disk about US$0.25 a month. Email uses your existing mailbox or a
free Brevo plan.
