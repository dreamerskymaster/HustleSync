# Project memory

## Identity

- Project: HustleSync, job and invoice tracking across four trades
- Firebase project: `hustlesync-3665b`
- Live web app: https://hustlesync-3665b.web.app
- Firebase CLI account: `ajithsri2000@gmail.com`
- App source: `src/App.jsx` (single file)

## Data

Live backend is Supabase Postgres as of 23 Sep 2026.

- Supabase project: `hustlesync`, ref `jsaxjeziqyptrxmvoopp`, us-east-2, Postgres 17
- Table `public.jobs`, 27 columns, one row per job, RLS on with four policies
- Views: `job_totals_by_trade` (revenue split per trade), `open_orders`
- Auth: Supabase anonymous sign-ins, enabled via `supabase config push`
- The app switches backend purely on the presence of `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY`. Remove them and it falls back to Firestore.

Firestore still works and is still configured, kept as the rollback path. Its
data did not migrate: anonymous auth made the old rows unreadable to anyone but
the original device.

Query the database without the DB password:

```bash
./node_modules/.bin/supabase db query --linked "select * from job_totals_by_trade;"
```

## History worth remembering

- The original "saving does nothing" bug was undeployed Firestore rules
  returning PERMISSION_DENIED, made invisible by a silent localStorage fallback
  that reported success. Both are fixed.
- Two Firebase Data Connect services on Cloud SQL were provisioned but never
  wired to the app and never held data. Deleted, to stop the Cloud SQL billing.
- Firebase Hosting defaults HTML to `max-age=3600`, which hid deploys for up to
  an hour. `firebase.json` now sets `no-cache` on `index.html`.
- Print was broken because the CSS revealed `#printable-invoice`, an id no
  element had.

## Design

- Palette: `ink #14110F`, `graphite #3F3A36`, `ash #6B635C`, `paper #EDEAE5`,
  `hazard #F59E0B`, `ember #B45309`
- Trades: timber `#B45309`, haul `#3F4A56`, flow `#0E6F7A`, hvac `#8C2F39`
- Type: Barlow and Barlow Condensed, chosen for their highway signage roots
- Mark: two-arrow sync ring, hazard amber on a dark tile. `public/favicon.svg`
  is the master; all raster sizes generate from the same geometry.

## Order lifecycle

- Two independent ticks: `completedAt` (work done) and `paidAt` (money in)
- A job with a future `deliveryDate` starts Open; everything else starts Completed
- Revenue reads as Total (completed), Pending (open), Awaiting payment (done, unpaid)

## Scheduling

All four trades can be booked ahead. `ScheduledDateSection` is shared, labelled
per trade (delivery, pickup, service). A future date keeps the job in Open
orders; a blank date means the work is already done.

## Tests

`npm test` runs `tests/verify.mjs`: RLS isolation, order lifecycle, cord
fractions and the revenue split. It is safe to run against live data.

## Export

CSV export from the home board (all trades) and each trade board. Pure logic in
`src/jobMapping.js`, unit tested. Native builds share the text rather than
downloading, because a WebView cannot trigger a file download.

## Bugs that shipped, and why

Worth remembering, because all three came from the same place.

1. Firestore rules were never deployed, and a silent localStorage fallback
   reported success. Every save failed invisibly.
2. `tax_rate` received an explicit null over its default, so every save failed
   with 23502 once the tax column existed.
3. Ticking an order complete sent epoch milliseconds to a timestamptz column,
   failing with 22008, because the update path did not share the insert path's
   encoder.

Two and three lived in code no test could import. That is why the pure logic now
sits in `src/jobMapping.js` with its own suite.

## Open items

- Anonymous Auth means jobs are unreachable after a reinstall or device change.
  Email or Google sign-in is the fix before real customer data goes in.
- Real GPS precision, native permission prompts, the printed PDF, and the native
  share sheet are unverified on a physical device.
- The JS bundle is around 810 kB, worth code splitting eventually.
- Supabase Postgres migration is written but not switched on. `supabase/schema.sql`
  is ready to run; the app needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to
  cut over, and stays on Firestore until they exist.
- `npx` hangs in this repo; call binaries in node_modules/.bin directly.
- Installed apps ship a frozen bundle. A fix reaches web users on reload but
  never reaches an installed app until it is rebuilt and redistributed.

## Credits

Built by SkyMaster, with Claude.
