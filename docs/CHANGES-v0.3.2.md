# Vicello Pricing Platform 0.3.2 – change report

Three targeted refinements. No redesign, no database change (no migration), and no change to pricing or reporting
calculations. Builds on 0.3.1 (`docs/CHANGES-v0.3.1.md`).

## 1. KPI terminology clean-up (Quotes vs Jobs Quoted)

The win rate and staff performance reports no longer show a separate quote count next to "Jobs quoted":

- the **"Total quotes"** card is removed;
- the **"Quotes"** column in Staff performance and Team is removed;
- the **"Quote success rate"** card and column are removed. They counted quote revisions, the same duplication.

The report now shows, in this order: **Jobs quoted, Jobs won, Jobs missed, Win %, Missed %, Revenue won,
Revenue missed**, then Conversion % (quoted jobs that were won). The staff and team tables use the same columns, plus
the existing average margin on won jobs.

Calculations are unchanged; only what is displayed changed. The server still calculates the same figures, so nothing
that relies on them breaks. The dashboard's "Open quotes" card was left as it is. It is the value of open jobs in the
pipeline, not a duplicate of Jobs quoted.

## 2. "Lost" is now "Missed"

Wording only. The stored job status is still `lost`, so existing data, filters and calculations are unaffected.

| Before | After |
|---|---|
| Lost (job status: dashboard pipeline, status chips, Status dropdown, Jobs list filter) | Missed |
| Lost jobs (drill-down title) | Missed jobs |
| Jobs lost | Jobs missed |
| Loss % | Missed % |
| Revenue lost | Revenue missed |
| Date lost / Loss reason / notes | Date missed / Reason / notes |
| "Won vs lost, all time" (Win rate card) | "Won vs missed, all time" |
| "Won ÷ (won + lost)" and other explanations | "Won ÷ (won + missed)" |
| "This job is marked lost…" (Schedule tab) | "This job is marked missed…" |

Not renamed: the Budget & costs status "Loss", which means a job's actual costs exceed its contract value. That is
a different meaning from a missed job.

## 3. Price book update control: how publishing works now

1. Open the draft price book and press **Publish…**.
2. Choose **Effective from**. It still decides when **new** jobs start using this price book.
3. **Apply Updated Pricing To Existing Jobs** lists every open job (Enquiry, Quoting or Quoted) that is on an older
   price book, showing job number, name, client, current price, the price on the new book and the % change.
4. **Nothing is ticked to start with.** Tick jobs one by one, or use **Select all open jobs**, then untick any to
   leave out. **Deselect all** clears them again. A running count shows how many are selected and how many will keep
   their prices.
5. Press **Apply Selected (N) and Publish**. With nothing ticked the button reads **Publish – leave all jobs
   unchanged**. **Cancel** changes nothing.
6. What happens:
   - The price book is published and locked, as before.
   - **Ticked jobs** move to the new price book straight away. Their product prices are recalculated from it, using
     the same tested routine as Job → Update to latest prices.
   - **Unticked jobs** keep their price book, lines and prices exactly as they were. Agreed pricing is protected.
     Each can still be moved later, one at a time, with Job → Update to latest prices.
   - **Won, in-production, installing and complete jobs** are never listed and never changed.
   - Publishing and the job updates happen together. If anything fails, nothing is published or changed. A request
     naming a job that is not open is refused.
7. **Audit**, using the existing activity log and job history:
   - **Settings → Activity log** shows an "apply new prices" entry: user, date and time, price book name and
     effective date, the jobs updated, and the jobs that kept their prices. The existing "publish" entry is recorded
     too.
   - Each **updated job's History** shows "Moved to newer prices: when published "…"".
   - Each **unselected job's History** shows "Kept its existing prices: "…" was published; this job was not selected".

Before this change, publishing never repriced existing jobs either. Each job had to be moved by hand afterwards.
That route still works; the new section simply lets you choose the jobs at the moment of publishing.

## 4. Files

**Modified:**
- `server/` — `routes.js` (the publish endpoint passes the chosen jobs), `services/jobs.service.js` (new
  `publishAndApply`; `applyReprice` records how it was triggered), `services/pricebook.service.js` (the publish list
  includes client and status), `services/reports.service.js` (drill-down titles say "Missed"), `config.js` (version).
- `public/` — `js/ui.js` (status label Lost → Missed), `js/views/drilldown.js` (KPI and column wording; quote counts
  removed), `js/views/dashboard.js` ("Won vs missed"), `js/views/job-schedule.js` (wording),
  `js/views/pricebook-editor.js` (job selection in the Publish window), `js/views/job-editor.js` (history wording),
  `js/views/settings.js` (readable activity log entry), `css/app.css`.
- `scripts/create-demo.js` (adds a draft price book ready to publish).
- Project files — `package.json`, `package-lock.json`, `README.md`, `READ ME FIRST.txt`, `docs/DEPLOYMENT.md`.

**New:** `tests/publish-apply.test.js`, `docs/CHANGES-v0.3.2.md`, `UAT/2026-10-28_Rev03_v0.3.2-Test-Checklist.txt`.

**API:** `POST /api/price-books/:id/publish` accepts `applyToJobIds` (a list of open job ids; empty or missing means
no job is changed). It returns the published price book as before, plus `publishResult: { applied, kept }`.
`GET /api/price-books/:id/impact` also returns each job's client and status. There are no other API changes.

**Database:** no change. New activity log actions: `apply_new_prices` (price book) and `reprice_kept` (job).

## 5. Testing

`npm test`: **52 tests, all pass** (6 new in `publish-apply.test.js`):

- **Publish window list:** shows every open job with its client, and never won jobs.
- **Invalid choice:** choosing a job that is not open is refused, and nothing is published or changed.
- **Selected vs unselected:** only the selected jobs move to the new price book and new prices. The unselected job
  keeps its price book, total and every line unchanged, and the won job is untouched.
- **Audit:** user, time, price book, effective date, jobs updated and jobs kept are recorded. Job history shows
  "reprice" for updated jobs and "reprice_kept" for the others.
- **Nothing ticked:** publishing leaves every job unchanged.
- **Wording:** the reporting screens no longer show "Quotes", "Total quotes", "Quote success", "Lost", "Loss %",
  "Revenue lost" or "Date lost", and they do show the new terms.

All earlier tests still pass, including the drill-down figures (Win 60.0% / Missed 40.0% in the demo, unchanged) and
the price-integrity checks.

Browser checks on the demo:
- **Publish window:** lists 4 open jobs with current and new prices, nothing ticked.
- **Select all:** 4 of 4, button "Apply Selected (4) and Publish".
- **Untick one:** 3 of 4, and the select-all box shows partly ticked.
- **Deselect all:** 0 of 4, button "Publish – leave all jobs unchanged".
- **Tick two:** 2 of 4.
- **Win rate report:** shows the new terms with the same figures.
- **Pipeline:** shows "Missed".
- **Errors:** none in the browser console or the server log.
