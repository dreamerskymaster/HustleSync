# HustleSync

Job and invoice tracking for a field service operation running four trades out
of one truck: firewood (HS Timber), junk hauling (HS Haul), plumbing (HS Flow)
and HVAC (HS HVAC).

Built mobile first, because it is used standing in a driveway, one handed, in
sunlight. Not a desktop admin panel.

**Live: https://hustlesync-3665b.web.app**

## What it does

- **Log a job** in any of four trades, each with its own fields: cords and
  stacking for firewood, load size and dump fees for hauling, parts and labour
  hours for the trades.
- **Capture the address** from GPS with one tap, resolved to a street number
  where the fix is good enough, and labelled approximate where it is not.
- **Schedule ahead.** A job with a future date sits in Open orders until the
  work is done. Anything dated today or earlier starts Completed.
- **Track money in two steps.** Delivered and paid are separate ticks, because
  a cord can be dropped on Tuesday and settled on Friday. Each board shows
  total revenue, pending revenue and what is still owed.
- **Raise an invoice** with a per-account sequential number, optional tax,
  print layout and share sheet.
- **Work offline.** Jobs saved without signal queue on the device and upload
  when it returns.
- **Export to CSV** from the home board or any single trade.
- **Dark and light mode**, following the system unless told otherwise.

## Stack

| Layer | Choice |
| --- | --- |
| Build | Vite 8 |
| UI | React 19, Tailwind CSS 4 (CSS-first config) |
| Icons | lucide-react |
| Auth | Supabase anonymous sign-ins |
| Data | Supabase Postgres |
| Hosting | Firebase Hosting |
| Native | Capacitor 8 (iOS and Android) |

Firebase remains configured as a rollback path for storage. The app selects its
backend from the presence of the Supabase environment variables alone.

## Setup

```bash
npm install
npm run dev          # local dev server on :5173
npm run build        # production build into dist/
npm test             # unit suites, then the read-only integration suite
```

Create `.env` from `.env.example`:

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...

# Firebase, still used for hosting and as the storage fallback
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

> **Never run tooling here through `npx`.** `npx firebase-tools` and `npx cap`
> hang indefinitely at zero CPU, producing no output. Call the binaries
> directly. This cost hours once.

## Deploying

```bash
npm run build
./node_modules/.bin/cap sync                         # web build into ios/ and android/
./node_modules/.bin/firebase deploy --only hosting
```

`firebase.json` sets cache headers deliberately: `index.html` is `no-cache` so a
deploy is visible immediately, and content-hashed files under `/assets/` are
cached for a year. Without the first rule Firebase defaults HTML to
`max-age=3600` and hides a deploy for up to an hour.

An installed app ships a frozen bundle. A fix reaches web users on reload but
never reaches an installed APK or TestFlight build until it is rebuilt and
redistributed.

## Data

One table, `public.jobs`, one row per job.

- Supabase project `hustlesync`, ref `jsaxjeziqyptrxmvoopp`
- `completed_at` and `paid_at` are nullable timestamps; `status` is a generated
  column derived from `completed_at`, so it cannot drift
- `invoice_number` is assigned by a trigger, sequential per account, with a
  unique index as a backstop
- Views: `job_totals_by_trade`, `open_orders`. Both use `security_invoker`,
  without which a Postgres view runs as its owner and leaks every row.

Apply or re-apply the schema. It is idempotent:

```bash
./node_modules/.bin/supabase db query --linked -f supabase/schema.sql
```

Query your data without the database password:

```bash
./node_modules/.bin/supabase db query --linked "select * from job_totals_by_trade;"
```

`db push` and `link -p` want the database password. `db query --linked` goes
through the Management API and needs none.

### Sharing model, and what it costs

One shared book, no login. Every device that opens the app gets an anonymous
session and sees every job from every device. A job added on a phone appears on
a laptop immediately.

The cost, stated plainly: **anyone who opens the app URL can read every
customer name, address and phone number, and can edit or delete any job.**
There is no per-person privacy in this table, and no record of who deleted
what.

Two guards remain:

- Policies apply to `authenticated` only, so the publishable key alone cannot
  dump the table without first obtaining a session. A speed bump, not a wall.
- Insert requires `auth.uid() = user_id`, so nobody can forge who created a job.

## Exporting

Every board has an export button: the home screen exports all trades, a trade
board exports just that trade. The file opens cleanly in Excel, Numbers and
Sheets. It carries a byte order mark so UTF-8 names survive, quotes any value
holding a comma, quote or newline, and uses CRLF endings.

A WebView cannot trigger a download, so native builds hand the CSV to the share
sheet instead.

## Tests

```bash
npm test
```

| Suite | Scope |
| --- | --- |
| `tests/imports.test.mjs` | Module boundary. Fails if App.jsx calls an unexported helper, if an import is not exported, if jobMapping.js starts touching Supabase or the DOM, or if a write verb appears in the integration suite. |
| `tests/mapping.test.mjs` | Pure logic in `src/jobMapping.js`: field mapping, timestamp encoding, numeric round trips, CSV escaping. No network. |
| `tests/verify.mjs` | Live backend, **strictly read-only**. Asserts the book is shared, an unauthenticated key cannot read it, status always agrees with `completed_at`, nothing is paid before it was completed, invoice numbers are unique per account, and the reporting view matches a direct aggregate. |

The integration suite performs no writes at all. Under a shared book any session
can delete any job, so a suite that creates and cleans up its own rows is one
bug away from deleting real work. The boundary test enforces that.

## Architecture

- `src/jobMapping.js` holds every pure function: field mapping, value encoding,
  the open and unpaid predicates, CSV building. No React, no Supabase, no DOM,
  so it is unit testable.
- `src/App.jsx` holds components and anything touching Supabase, Capacitor or
  the DOM.
- `src/ErrorBoundary.jsx` catches render crashes and shows the failing message
  instead of a white screen.

The split is not cosmetic. Two production bugs shipped from logic buried in
App.jsx where no test could reach it.

## Design system

Tokens live in `src/index.css` under `@theme` and work as ordinary Tailwind
utilities. Each is redefined under `[data-theme="dark"]`, so the whole app
flips without `dark:` variants scattered through the components.

| Token | Light | Role |
| --- | --- | --- |
| `paper` | `#EDEAE5` | Page background |
| `surface` | `#FFFFFF` | Cards and rows |
| `ink` | `#14110F` | Primary text |
| `graphite` | `#3F3A36` | Secondary text |
| `ash` | `#6B635C` | Labels and metadata |
| `hazard` | `#F59E0B` | Brand accent, money on dark panels |
| `timber` / `haul` / `flow` / `hvac` | `#B45309` / `#3F4A56` / `#0E6F7A` / `#8C2F39` | Trade identity |

Type is Barlow and Barlow Condensed, drawn from Californian highway and public
signage, which is the vernacular of trucks and job sites. Money and counts use
`.tabular` so columns align.

Trade colours must appear as literal class strings. Tailwind scans source text,
so `bg-${trade}` silently produces no CSS.

## Brand assets

`public/favicon.svg` is the master mark, a two-arrow sync ring in hazard amber
on a dark tile. Every raster size is generated from the same geometry, so the
vector and the bitmaps cannot drift apart.

```bash
./node_modules/.bin/capacitor-assets generate \
  --iconBackgroundColor '#1c1917' --splashBackgroundColor '#1c1917'
```

## Native builds

```bash
npm run build
./node_modules/.bin/cap sync
./node_modules/.bin/cap open ios      # or: cap open android
```

Location capture needs platform permissions, already declared:

- iOS: `NSLocationWhenInUseUsageDescription` in `ios/App/App/Info.plist`
- Android: `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` in
  `android/app/src/main/AndroidManifest.xml`

iOS has been compiled successfully against Xcode 26. Android is configured but
has not been compiled here, for want of an SDK and a Java runtime.

## Notable behaviour

**Address capture.** The pin watches the position stream and keeps the tightest
fix, stopping at 20 m or 12 s. A device returns a coarse cell or wifi position
within a second then tightens over several seconds, so asking once captures the
worst fix of the session. Three keyless geocoders are tried in order of
precision, preferring whichever returns a house number.

**Printing.** The invoice prints through a `@media print` block that hides the
app and reveals `#printable-invoice`. That id must stay on the invoice card.

**Saving.** Failures surface the real Postgres or PostgREST code rather than a
generic message.

## Known limitations

- **No real accounts.** Anonymous auth means there is no sign-in, no recovery
  and no way to make the book private again without adding one.
- **No payment collection.** Invoices are documents, not payment links.
- **No audit trail.** Nothing records who edited or deleted a job.
- **Bundle is 1.05 MB (304 kB gzipped).** Firebase is still bundled as the
  fallback path; removing it is the easiest win once Postgres is trusted.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Saves fail, UI looks fine | Schema not applied, or RLS policies missing |
| A deploy is not visible | Stale cache from before the header fix; hard reload once |
| Users see old behaviour | Installed apps ship a frozen bundle; rebuild and redistribute |
| Blank printed page | `#printable-invoice` missing from the invoice card |
| Pin returns town only | Coarse fix; the app labels anything over 100 m approximate |
| `npx` command hangs forever | Use `./node_modules/.bin/<tool>` instead |
| White screen | Should now show the error boundary with the failing message |

## Credits

Built by **SkyMaster**, with **Claude**.
