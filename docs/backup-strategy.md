# Backup strategy – Vicello Pricing Platform 0.4.0

**Goal:** no business data is ever lost. Copies are made automatically, kept off-site with a different company, held
in several versions, protected against deletion, checked every time, and restored in a test every week.

## 1. What is backed up

Everything the business has is in **one database file** (`platform.db`): company settings, users and their password
hashes, every price book version, jobs, areas and items, every issued quote (frozen, with its reference number),
costs, staff, leave, the calendar, job statuses, workflow milestones and the full history.

There are **no separate document files**: quotes are stored inside the database and printed from it. Restoring one
backup therefore restores the whole business, including user accounts.

**Application (code) backups:** the code is in GitHub, every release is also kept as a dated Rev zip in OneDrive
(`Work\Vicello\…_Vicello-Platform-GitHub-Upload.zip`), and Render keeps every previous deploy (Events → Rollback).
Copy each new release zip into the Backblaze bucket's `code/` folder as well (drag it in on the Backblaze website).

## 2. The layers

| Copy | Where | How often | Kept | Made by | Protects against |
|---|---|---|---|---|---|
| Live database | Render disk `/var/data` | continuous | – | the program | – |
| Daily copy | Render disk `backups/` | once a day | newest 14 | the program (automatic) | quick undo |
| Before-upgrade copy | Render disk `backups/` | before every database upgrade | 90 days | the program (automatic, **new**) | a bad upgrade |
| Before-restore copy | Render disk `backups/` | before every restore | 90 days | the program (automatic, **new**) | restoring the wrong backup |
| Render disk snapshot | Render | daily | 7 days | Render | disk-level mistakes |
| **Off-site "recent"** | Backblaze B2 `vicello/recent/` | **every 15 min if data changed**, and 2 min after a quote or price book publish | 30 days, locked | the program (**new**) | disk, server or Render account loss |
| **Off-site daily** | Backblaze B2 `vicello/daily/` | once a day from 11 pm Sydney | 13 months (locked 30 days) | the program (**new**) | problems found weeks later |
| **Off-site monthly** | Backblaze B2 `vicello/monthly/` | first daily copy of each month | **7 years, locked** | the program (**new**) | tax/records, disputes |
| Offline copy | USB drive in the office | quarterly | owner's choice | owner (Download button) | losing both cloud providers |

Most work that can be lost (**RPO**): **15 minutes**. Time to be working again (**RTO**): about **30 minutes** on a new
Render service, **1 hour** on the office PC. See `disaster-recovery.md`.

## 3. How the off-site copies are protected

- **Separate company and login.** Backblaze is not Render. Losing, closing or someone taking over the Render
  account does not touch the off-site copies.
- **Write-only key on the live site.** The key stored in Render can add backups but cannot read or delete them.
- **Object Lock (compliance mode).** Each copy is locked when it is uploaded (30 days; monthly copies 7 years).
  Until then nobody can delete or overwrite it, not even the Backblaze account owner.
- **Encrypted** with AES-256-GCM before it leaves the server, using the *backup encryption key*. Backblaze only ever
  holds scrambled files. The key is kept in the password manager (two people) and as a sealed printed copy in the
  office. **Without this key the off-site backups cannot be read.**
- **Checked before upload.** Each copy is made with SQLite's `VACUUM INTO` (a consistent snapshot while the site is
  running), then checked (integrity, record links, version, company present). A copy that fails is not uploaded and
  the failure is reported. Each file carries a manifest: program version, record counts and a SHA-256 checksum.
  The upload carries an MD5 checksum, so storage rejects a damaged transfer.
- **Alerts.** After every check (every 15 minutes) the program pings a Healthchecks.io monitor; if a ping is missed
  for 2 hours, or a backup fails, two people get an email/SMS. Settings → Backups & restore shows the last upload,
  last check and any error.

## 4. Verification (restore tests)

| Test | How often | What it proves |
|---|---|---|
| Check of every copy | every backup | integrity, record links, version, counts – before it is kept or uploaded |
| **Automatic restore test** (GitHub Actions) | **weekly**, Monday 6 am Sydney | downloads the newest off-site copy with a read-only key, decrypts it, restores it in a throw-away folder, **reprices every job and compares with its saved total**, **re-checks every quote's reference number**, compares counts with the manifest, and fails if the newest copy is over 26 hours old. A failed run emails the repository owner. |
| Hands-on restore drill | quarterly (30 min) | a person can follow `disaster-recovery.md`: restore a downloaded backup on a PC (`Restore From Backup.cmd`), sign in, check a quote, record it in the drill log |

## 5. Set up off-site backups (once, about 45 minutes)

Accounts and keys are created by Vicello's owner (or Scale Point Group with the owner); nobody else should hold them.

1. **Backblaze account.** Sign up at backblaze.com (B2 Cloud Storage) with a Vicello email address that is *not*
   the one used for Render. Turn on two-step sign-in.
2. **Bucket.** B2 Cloud Storage → Buckets → Create a Bucket: name e.g. `vicello-backups-` plus a few random
   letters; Files: **Private**; Default encryption: Enable; **Object Lock: Enable** (it can only be chosen here).
   Then on the bucket: Object Lock → Default retention → **Compliance**, **30 days**.
3. **Lifecycle rules** (bucket → Lifecycle Settings → custom rules):
   - `vicello/recent/` – hide after **31** days, delete **1** day after hiding
   - `vicello/daily/` – hide after **400** days, delete **1** day after hiding
   - `vicello/monthly/` – no rule (each copy is locked for 7 years when uploaded)
4. **Two application keys** (App Keys → Add a New Application Key), both limited to this bucket:
   - `vicello-live-write` – Type of access **Write Only**. Goes into Render.
   - `vicello-read` – Type of access **Read Only**. Goes into the password manager and GitHub (restore test, recovery).
   Note each keyID and applicationKey straight away; Backblaze shows the key only once.
   The bucket page shows the **Endpoint**, e.g. `s3.us-west-004.backblazeb2.com`.
5. **Backup encryption key.** Make a long random passphrase (the password manager's generator, 40+ characters).
   Save it in the password manager under two people and print one sealed copy for the office safe.
6. **Render → vicello-platform → Environment → Add Environment Variable** (then Save; the site restarts):

   | Key | Value |
   |---|---|
   | `OFFSITE_ENDPOINT` | `https://` + the bucket endpoint, e.g. `https://s3.us-west-004.backblazeb2.com` |
   | `OFFSITE_BUCKET` | the bucket name |
   | `OFFSITE_KEY_ID` | keyID of `vicello-live-write` |
   | `OFFSITE_SECRET` | applicationKey of `vicello-live-write` |
   | `BACKUP_ENCRYPTION_KEY` | the passphrase from step 5 |
   | `OFFSITE_OBJECT_LOCK` | `1` |
   | `BACKUP_HEARTBEAT_URL` | the Healthchecks.io ping URL (step 7) |

7. **Missed-backup alert.** healthchecks.io → sign up (free) → Add Check: name `Vicello off-site backup`,
   Period **1 hour**, Grace **2 hours**; add two people's email (and SMS if wanted). Copy the ping URL into
   `BACKUP_HEARTBEAT_URL`.
8. **Site-down alert.** uptimerobot.com (free) → New monitor → HTTP(s) →
   `https://vicello-platform.onrender.com/api/state`, every 5 minutes, alert the same two people.
9. **Check it works.** Sign in as owner → Settings → Backups & restore → **Back up off-site now**. It must say
   "uploaded and confirmed". In Backblaze → Browse Files you see `vicello/recent/…`, `daily/…` and `monthly/…`.
10. **Weekly restore test.** In GitHub: repository → Settings → Secrets and variables → Actions → New repository
    secret, five times: `OFFSITE_ENDPOINT`, `OFFSITE_BUCKET`, `OFFSITE_READ_KEY_ID` (keyID of `vicello-read`),
    `OFFSITE_READ_SECRET`, `BACKUP_ENCRYPTION_KEY`. Then Add file → Create new file, name it
    `.github/workflows/backup-restore-test.yml` (at the **top** of the repository) and paste the contents of
    `deploy/github/backup-restore-test.yml`. Commit. Actions → "Weekly backup restore test" → **Run workflow**:
    it must finish green with "PASSED".

## 6. Costs

| Item | US$ / month |
|---|---|
| Backblaze B2 (about 5–6 GB with these retention rules; first 10 GB free) | 0.00 |
| Healthchecks.io, UptimeRobot (free plans) | 0.00 |
| GitHub Actions (about 3 minutes a week; 2,000 free minutes a month) | 0.00 |

Above 10 GB Backblaze charges about US$0.006 per GB per month. Prices at the time of writing; confirm on sign-up.

## 7. Settings reference

| Setting | Default | Meaning |
|---|---|---|
| `OFFSITE_ENDPOINT`, `OFFSITE_BUCKET`, `OFFSITE_KEY_ID`, `OFFSITE_SECRET` | – | S3-compatible storage (Backblaze B2, Cloudflare R2, AWS S3 and Wasabi all work) |
| `BACKUP_ENCRYPTION_KEY` | – | passphrase that encrypts off-site copies (required for off-site backups) |
| `OFFSITE_READ_KEY_ID`, `OFFSITE_READ_SECRET` | the write key | a key that can read, where backups are read back (recovery, GitHub restore test) |
| `OFFSITE_PREFIX` | `vicello` | folder in the bucket |
| `OFFSITE_INTERVAL_MINUTES` | `15` | how often to check for changes |
| `OFFSITE_DAILY_HOUR` | `23` | hour (business time) of the daily copy |
| `OFFSITE_OBJECT_LOCK` | off | `1` = lock each copy (needs a bucket with Object Lock) |
| `OFFSITE_LOCK_DAYS` / `OFFSITE_MONTHLY_YEARS` | `30` / `7` | lock periods |
| `BACKUP_HEARTBEAT_URL` | – | Healthchecks.io ping URL |
| `BUSINESS_TIMEZONE` | `Australia/Sydney` | time zone for "daily" and "monthly" |
| `AUTO_BACKUP`, `BACKUP_KEEP` | on, `14` | on-disk daily copies |

Commands (on a PC or in GitHub): `npm run backup:offsite` (upload now), `npm run restore-test [file]`,
`npm run restore <file>` (restore into this PC's data folder; the program must be closed).

## 8. What was tested, and what still needs the real accounts

Tested automatically (`npm test`, 72 tests): checked on-disk copies, before-upgrade copies, encryption round trip,
wrong key and tampering refused, off-site schedule (15-minute, daily, monthly, catch-up), uploads with Object Lock and
checksums against a stand-in S3 server, failures recorded and shown, restore over a running site (password, safety
copy, sign-out), restore into a brand-new site from the setup screen, bad and too-new backups refused, and the weekly
restore test. The request signing matches Amazon's published Signature Version 4 example exactly.

**Not yet tested against the real Backblaze account**, because it does not exist yet. Steps 9 and 10 above are
that test; do them as soon as the account is set up.
