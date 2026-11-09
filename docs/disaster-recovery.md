# Disaster recovery – Vicello Pricing Platform 0.4.0

Print this page and keep it with the sealed copy of the backup encryption key.

**Targets:** at most **15 minutes** of work lost (RPO). Working again within **30 minutes** on Render, or **1 hour** on
the office PC (RTO). Confirm these in the first quarterly drill.

## Who and where (fill in)

| What | Where it is kept | Who can get it |
|---|---|---|
| Render login (2-step on) | password manager | |
| GitHub login (2-step on) | password manager | |
| Backblaze login (2-step on, different email to Render) | password manager | |
| Backup encryption key | password manager + sealed copy in the office safe | |
| Backblaze read-only key (`vicello-read`) | password manager | |
| Latest release zip | OneDrive `Work\Vicello\` | |
| Scale Point Group (support) | | |

## First: what happened?

| What you see | Go to |
|---|---|
| Site works but data is wrong or missing (deleted by mistake, bad edit) | A |
| Site broke straight after an update | B |
| Site down; Render dashboard works | C |
| Render (or the Render account) unavailable or taken over | D |
| GitHub account lost, deleted or taken over | E |

### A. Data deleted or changed by mistake  (about 10 minutes)

1. Find what changed and when: open the job → **History** (every change, with the previous and new value), or
   Settings → Activity log. Jobs are never deleted; archived jobs come back with Job → Restore.
2. Small change: put the previous values back by hand from the History, and save.
3. Larger damage: Settings → Backups & restore → pick the newest backup **from before** the mistake (or
   "Show off-site backups" for one from any 15 minutes in the last 30 days) → **Restore…**. You see what is in it
   before anything changes. A safety copy of the current data is made first.
   *Limit:* a restore replaces the whole database, so work done by others since that backup is lost from the live
   site. It is still in the safety copy if it needs to be re-entered.

### B. An update broke the site  (about 5 minutes)

1. Render → `vicello-platform` → **Events** → the deploy before → **Rollback**.
2. If the update changed the database (the Logs say "Backup before upgrade"), the older version may not read the
   newer data. Restore the before-upgrade copy: Settings → Backups & restore → the "Before an upgrade" backup →
   Restore…
3. Tell Scale Point Group; fix and test the next version on a PC (UAT demo) before uploading it again.

### C. Site down, Render works  (15–30 minutes)

1. Render → Logs: read the last error. Render → Events: restart the service (Manual Deploy → Restart).
2. Disk damaged: Render → Disks → a daily snapshot (last 7 days) → Restore. Then check the newest off-site copy is
   newer (Settings → Backups & restore) and restore that on top if it is.

### D. Render unavailable, or the Render account lost/taken over  (1–4 hours)

Nothing in Backblaze can have been deleted (write-only key, Object Lock).

**Fast: office PC (about 1 hour)**
1. On the office PC, unzip the latest release zip from OneDrive (Node.js must be installed; see README.md).
2. Backblaze → Browse Files → `vicello/recent/` → the newest file → Download.
3. Double-click **Restore From Backup.cmd**, drag the downloaded `.vbak` file in, press Enter, type the
   backup encryption key, then type `RESTORE`.
4. Double-click **Start Pricing Platform.cmd**. Staff in the office open `http://<this PC's name>:4310`
   (set `HOST=0.0.0.0` in the launcher for other PCs; see README). Everyone signs in with their usual password.

**Permanent: a new Render service (or another host)**
1. Make a new Render account if the old one is lost (new email, 2-step on). New → Web Service → the GitHub
   repository, with the settings in DEPLOY_TO_RENDER.md (including the 1 GB disk at `/var/data`).
2. Add `OFFSITE_ENDPOINT`, `OFFSITE_BUCKET`, `OFFSITE_READ_KEY_ID`, `OFFSITE_READ_SECRET` (the **read** key) and
   `BACKUP_ENCRYPTION_KEY` under Environment.
3. Open the new site. On "Set up your company" open **Start from a backup instead** → enter the setup key (your
   `SETUP_KEY`, or the one shown in Logs) → **Use the latest off-site backup** → check what it shows → **Restore now**.
4. Sign in. Check the newest job and quote. Then make a **new write-only Backblaze key**, set `OFFSITE_KEY_ID` /
   `OFFSITE_SECRET`, and press Settings → Backups & restore → Back up off-site now.
5. Point people (and UptimeRobot) at the new address.
6. If the account was taken over: delete the old Backblaze write key, change every password, and consider whether
   client details were exposed (Privacy Act notifiable data breach scheme).

### E. GitHub lost, deleted or taken over  (about 1 hour; the site keeps running)

1. Render → `vicello-platform` → Settings → **Auto-Deploy: No**, straight away.
2. Render → Events: check no deploy you did not make. If there is one, Rollback (B).
3. Make a new repository (or recover the account), upload the latest release zip from OneDrive the usual way,
   reconnect Render to it (Settings → Repository), turn Auto-Deploy back on.
4. Change the GitHub password, check its 2-step sign-in, remove unknown collaborators and keys.

## Rollback procedure (any update)

1. Before every update: Settings → Backups & restore → **Back up now** (the program also copies the database by
   itself before any database change).
2. Roll back the code: Render → Events → previous deploy → Rollback.
3. Roll back the data only if needed: restore the "Before an upgrade" copy.

## Restore into a brand-new deployment (summary)

New service with a disk → open it → **Start from a backup instead** → setup key → backup file or latest off-site
→ the program checks it (integrity, record links, version, encryption) and shows the company, last activity and
counts → **Restore now** → sign in with existing accounts. Quotes, users, price books and history all come back
together, because they are all in the one database.

## Quarterly drill log

| Date | Who | Backup used | Restored to | Time taken | Problems | Signed |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |
