# HustleSync

Job and invoice tracking for a field service operation running four trades:
firewood (HS Timber), junk hauling (HS Haul), plumbing (HS Flow), and HVAC
(HS HVAC). Built mobile first, because it is used standing in a driveway rather
than sitting at a desk.

Live: https://hustlesync-3665b.web.app

## Stack

| Layer | Choice |
| --- | --- |
| Build | Vite 8 |
| UI | React 19, Tailwind CSS 4 (CSS-first config) |
| Icons | lucide-react |
| Auth | Firebase Anonymous Auth |
| Data | Cloud Firestore |
| Hosting | Firebase Hosting |
| Native | Capacitor 8 (iOS and Android) |

## Setup

```bash
npm install
npm run dev          # local dev server on :5173
npm run build        # production build into dist/
```

Create a `.env` from `.env.example`:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

If the keys are missing the app renders a setup screen instead of crashing.

## Deploying

```bash
npm run build
npx firebase-tools deploy        # hosting and Firestore rules together
```

`firebase.json` sets cache headers deliberately: `index.html` is `no-cache` so a
deploy is visible immediately, and the content-hashed files under `/assets/` are
cached for a year. Without the first rule Firebase defaults HTML to
`max-age=3600`, which hides a deploy from users for up to an hour.

## Data model

Jobs live in Supabase Postgres, one row per job in `public.jobs`.

- Project `hustlesync`, ref `jsaxjeziqyptrxmvoopp`
- One shared book: every signed-in device reads and edits the same jobs
- `completed_at` and `paid_at` are nullable timestamps; `status` is a generated
  column derived from `completed_at`, so it can never drift
- Views: `job_totals_by_trade` (revenue split per trade), `open_orders`

Apply or re-apply the schema. It is idempotent:

```bash
./node_modules/.bin/supabase db query --linked -f supabase/schema.sql
```

Query your data without the database password:

```bash
./node_modules/.bin/supabase db query --linked "select * from job_totals_by_trade;"
```

### Backend switch

The app picks its backend purely from environment variables. With
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set it uses Postgres; remove
them and it falls back to Firestore, which is still configured as the rollback
path.

### Sharing model, and what it costs

Chosen deliberately on 30 Sep 2026: one shared book with no login. Every device
that opens the app gets an anonymous session and sees every job, from every
device. Adding a job on a phone shows up on a laptop immediately.

The cost, stated plainly: **anyone who opens the app URL can read every customer
name, address and phone number, and can edit or delete any job.** There is no
per-person privacy in this table and no audit trail beyond `user_id`, which
records which device created a row.

Two things still hold:

- Policies apply to `authenticated` only, so the publishable key alone cannot
  dump the table without first obtaining a session. A speed bump, not a wall.
- Insert still requires `auth.uid() = user_id`, so nobody can forge who
  created a job.

If this ever needs to be private again, the fix is email sign-in plus either
per-user policies (back to separate books) or a shared business id (a crew
sharing one book, with outsiders excluded).

## Exporting

Every board has an export button. The home screen exports all trades, a trade
board exports just that trade. The file opens cleanly in Excel, Numbers and
Sheets: it carries a byte order mark so UTF-8 names survive, quotes any value
containing a comma, quote or newline, and uses CRLF endings.

On a phone a WebView cannot trigger a download, so the native build hands the
CSV to the share sheet instead. Mail it to yourself or save it to Files.

## Tests

```bash
npm test          # unit suite, then integration suite
```

**`tests/mapping.test.mjs`** covers `src/jobMapping.js` with no network: field
mapping, timestamp encoding, numeric round trips and CSV escaping. This file
exists because two production bugs shipped from code nothing could import.

**`tests/verify.mjs`** runs against the live backend and is **strictly
read-only**. No insert, no update, no delete. It asserts invariants over
whatever data is already there: that the book is shared across accounts, that
an unauthenticated key cannot read it, that status always agrees with
`completed_at`, that nothing is paid before it was completed, that invoice
numbers are unique per account, and that the reporting view matches a direct
aggregate of the rows.

It is read-only on purpose. Under a shared book any session can delete any job,
so a suite that creates and cleans up its own rows is one bug away from
deleting real work. `tests/imports.test.mjs` fails the build if a write verb
ever appears in it.

Anonymous sign-ins are rate limited to 30/hour per IP. The suite uses two
sessions per run, so roughly 15 runs an hour.

## Design system

Tokens live in `src/index.css` under `@theme` and are available as ordinary
Tailwind utilities (`bg-ink`, `text-ash`, `bg-timber`).

| Token | Value | Role |
| --- | --- | --- |
| `ink` | `#14110F` | App shell, primary text |
| `graphite` | `#3F3A36` | Secondary text, headings |
| `ash` | `#6B635C` | Labels and metadata |
| `paper` | `#EDEAE5` | Page background |
| `hazard` | `#F59E0B` | Brand accent, money on dark panels |
| `ember` | `#B45309` | Deep accent |
| `timber` / `haul` / `flow` / `hvac` | `#B45309` / `#3F4A56` / `#0E6F7A` / `#8C2F39` | Trade identity |

Type is Barlow and Barlow Condensed, drawn from Californian highway and public
signage. Condensed (`font-display`) carries headings and figures; regular
carries body and UI. Money and counts use the `.tabular` class so columns align.

Trade colours are literal class strings in the source rather than composed at
runtime, because Tailwind only emits classes it can find by scanning.

## Brand assets

`public/favicon.svg` is the master mark, a two-arrow sync ring in hazard amber on
a dark tile. Every raster size is generated from the same geometry, so the
vector and the bitmaps cannot drift apart. `resources/icon.png` and
`resources/splash.png` feed the native icon sets.

Regenerate native icons after changing the mark:

```bash
npx capacitor-assets generate --iconBackgroundColor '#1c1917' --splashBackgroundColor '#1c1917'
```

## Native builds

```bash
npm run build
npx cap sync         # copy the web build and plugins into ios/ and android/
npx cap open ios     # or: npx cap open android
```

Location capture needs platform permissions, already declared:

- iOS: `NSLocationWhenInUseUsageDescription` in `ios/App/App/Info.plist`
- Android: `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` in
  `android/app/src/main/AndroidManifest.xml`

## Notable behaviour

**Address capture.** The pin beside the Address field fills in the current
location. It tries three keyless geocoders in order of precision: OpenStreetMap
Nominatim, then Komoot Photon, then BigDataCloud, then raw coordinates. Only the
first two return a house number. Each request is bounded by an 8 second timeout,
because browser `fetch` has none and a hung request would otherwise spin
forever. The address field stays free text; the pin only fills it in.

**Printing.** The invoice prints through a `@media print` block in
`src/index.css` that hides the app and reveals `#printable-invoice`. That id must
stay on the invoice card or printing produces a blank page.

**Saving.** Firestore failures surface the real reason in the form rather than
falling back to local storage and reporting success.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Saves fail, UI looks fine | Schema not applied, or RLS policies missing |
| A deploy is not visible | Stale cache from before the header fix; hard reload once |
| Blank printed page | `#printable-invoice` missing from the invoice card |
| Pin returns town only | Coarse desktop location; real GPS resolves the street |
| Jobs vanished | Anonymous auth identity was reset; see Known limitation |
| `npx` command hangs forever | Use `./node_modules/.bin/<tool>` instead |
| Users see an old error or old behaviour | Installed apps ship a frozen bundle; rebuild and redistribute |

## Credits

Built by **SkyMaster**, with **Claude**.
