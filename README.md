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
- Row level security restricts every user to their own rows, four policies
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

### Known limitation

Anonymous auth ties data to a per-device identity. Clearing site data,
reinstalling, or switching devices makes existing jobs unreachable. They still
exist in Postgres, and you can still query them with the CLI above, but the app
cannot re-associate them. Email or Google sign-in is the fix before real
customer data goes in.

## Tests

```bash
npm test
```

Three suites run against the live backend: row level security isolation, the
order lifecycle (open, complete, paid), and cord fraction totals with the
revenue split. Every row they create belongs to throwaway anonymous users and is
removed afterwards; the suite counts pre-existing rows before and after and
fails if that number changes.

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
