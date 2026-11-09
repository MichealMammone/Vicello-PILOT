# Vicello Pricing Platform – read me first

Putting the program online takes about **10 minutes**: upload the files to GitHub, create one Render Web Service, and
fill in a form. No YAML files, no Blueprints, no extra branches. The exact values for every field are in
**DEPLOY_TO_RENDER.md**; every setting is explained in **.env.example**.

> **Already have the program running on Render, with real data in it?**
> Do not create a new service – that starts with an empty database. To update it, do **Step 1** only: Render
> redeploys by itself and your data stays on its disk. Do Step 5 to check.
> To *move* to a new service: first sign in to the old site → Settings → Backups & restore → **Back up now** →
> **Download**. Then do Steps 2–5 on the new service, and at Step 6 choose **"Start from a backup instead"** and
> upload that file. Everyone keeps their login.

You need: a GitHub account, a Render account (with a payment card – the Starter plan is about US$7 a month), and
for email the SMTP details of a mailbox (see Step 3).

---

## STEP 1 – Upload the files to GitHub  (3 minutes)

1. Unzip the package. You get a folder called **`vicello-platform`**.
2. Sign in at **github.com** and open your repository (or **New repository** → name `vicello-platform` → **Private**
   → Create).
3. **Existing repository** that already has a `vicello-platform` folder: click that folder → **Add file → Upload
   files** → drag in **everything inside** your unzipped `vicello-platform` folder (all files and sub-folders).
   **New, empty repository:** click **uploading an existing file** → drag in the whole **`vicello-platform`** folder.
4. Type a message such as `Version 0.4.1` and click **Commit changes**. Make sure it says **main** branch.

Tip: some files start with a dot (`.env.example`, `.node-version`). If Windows hides them, they are still uploaded
when you drag the folder contents; GitHub shows them in the list.

## STEP 2 – Create the Render Web Service  (3 minutes)

1. Sign in at **dashboard.render.com** → **New** → **Web Service**.
2. Connect GitHub if asked, then pick your repository → **Connect**.
3. Fill in the form (Render fills most of it in; check each value):

   | Field | Value |
   |---|---|
   | Name | `vicello-platform` |
   | Language | `Node` |
   | Branch | `main` |
   | Region | `Singapore` |
   | Root Directory | `vicello-platform` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Starter** (not Free – the Free type cannot keep your data) |

4. Under **Advanced**: **Add Disk** → Name `data`, Mount Path **`/var/data`**, Size **1 GB**.
   Health Check Path: **`/healthz`**. Auto-Deploy: **Yes / On Commit**.
   (If you do not see these in the form, add them right after creating: service → **Disks** → Add Disk, and
   service → **Settings** → Health Check Path.)

## STEP 3 – Configure environment variables  (2 minutes)

Still in the form (section **Environment Variables**), or later under your service → **Environment** → **Add
Environment Variable**. Click **Add** for each line:

| Key | Value |
|---|---|
| `SETUP_KEY` | A phrase you make up, e.g. `blue-kettle-harbour-42`. You type it once in Step 6. |
| `SMTP_HOST` | Your mail server, e.g. `smtp.office365.com` (Microsoft 365) or `smtp.gmail.com` (Google) |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | The mailbox login, e.g. `quotes@vicello.com.au` |
| `SMTP_PASSWORD` | That mailbox's password or **app password** |
| `SMTP_FROM_EMAIL` | The address emails come from, e.g. `quotes@vicello.com.au` |
| `SMTP_FROM_NAME` | `Vicello` |

Values for Microsoft 365, Google, Brevo and SendGrid are in DEPLOY_TO_RENDER.md. No email yet? Leave the `SMTP_`
lines out: the program works without email, and you can add them any time (Render restarts by itself).

**You do not need** `DATABASE_URL`, `SESSION_SECRET` or `PORT` – this program does not use them.

## STEP 4 – Deploy  (2–3 minutes)

Click **Create Web Service** (or, for changes later, **Manual Deploy → Deploy latest commit**). Render shows the
progress. Wait until it says **Live** (green).

## STEP 5 – Verify the program started  (1 minute)

1. Click **Logs**. You should see:
   ```
   Vicello Pricing Platform 0.4.1
     Open:     http://localhost:10000
     Data:     /var/data
     Email:    smtp.office365.com:587 from quotes@vicello.com.au; links to https://vicello-platform.onrender.com
   ```
   ("localhost" here is normal – it is inside Render.) If you see **"WARNING: No disk found at /var/data"**, go back
   to Step 2.4 and add the disk.
2. Open your site's address (top of the Render page, e.g. `https://vicello-platform.onrender.com`). You see
   **Set up your company**.
3. Optional: open `https://<your address>/healthz` – it shows `{"ok":true,...}`.

## STEP 6 – Test email sending  (2 minutes)

Email is tested from inside the program, so first create the company and its owner (the first user):

1. On **Set up your company**: type your `SETUP_KEY` → **Check key** → company name, your name, your email and a
   password → leave the **Material + Labour** price book selected → **Create company and sign in**.
   *(Moving from another service? Open **"Start from a backup instead"** at the bottom instead, choose your backup
   file, and sign in with your existing login.)*
2. Go to **Settings → Users & access**. Under **Email**, click **Send test email** → **Send**.
3. Check that inbox (and the junk folder). The email says "If you can read this, email is working".
   If it fails, the message on screen is the mail server's own reply – usually a wrong `SMTP_PASSWORD`, an account
   that is not allowed to send as `SMTP_FROM_EMAIL`, or (Microsoft 365) "Authenticated SMTP" turned off. Fix the
   value under Render → Environment → Save, wait 1 minute, try again.

## STEP 7 – Create the first user  (1 minute)

1. **Settings → Users & access → + Add user**: name, email, role (Designer, Admin or Owner) and a temporary
   password.
2. They receive an email with the web address, their email and the temporary password, and choose their own
   password when they first sign in. (Without email set up, tell them the temporary password yourself.)
3. If anyone forgets their password, the sign-in page has **"Forgotten your password?"**, which emails them a
   reset link (valid 60 minutes).

**Done.** Next, when you have 45 minutes: switch on encrypted off-site backups (`docs/backup-strategy.md`) and print
`docs/disaster-recovery.md`.

---

### Updating later

Upload the new version's files to the same place in GitHub (Step 1). Render redeploys by itself (Auto-Deploy);
your data is not touched. Before a database change the program copies the database by itself, and you can always
download a backup first from Settings → Backups & restore.

### If something goes wrong

| What you see | What to do |
|---|---|
| Deploy fails with "Cannot find module" or "no package.json" | Root Directory must be the folder that contains `package.json` (`vicello-platform`), or empty if the files are at the top of the repository |
| "No open ports detected" | Start Command must be `npm start` |
| Log says "WARNING: No disk found at /var/data" | Add the disk (Step 2.4). Until then nothing is kept |
| "That setup key is not right" | Type the `SETUP_KEY` exactly as you set it in Render. Not set? Copy the key from Logs (line "FIRST-TIME SETUP KEY") |
| The site shows "Sign in" instead of "Set up your company" | It is already set up – sign in with the owner email |
| Test email fails | The message shows why; see Step 6.3 |
| Forgot the owner password and email is not set up | Another owner can reset it in Settings → Users & access |

### What is in this folder

| | |
|---|---|
| `README_FIRST.md` | this guide |
| `DEPLOY_TO_RENDER.md` | exact Render settings, environment variables, email providers |
| `.env.example` | every setting explained |
| `render.yaml` | optional reference only – not needed for a Web Service |
| `docs/` | backups, disaster recovery, change logs, quote logo |
| `UAT/`, `*.cmd` | testing on a Windows PC (see README.md) |
| `server/`, `public/`, `shared/` | the program |
