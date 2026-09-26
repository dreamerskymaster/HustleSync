# Claude instructions

## What this is

HustleSync: job and invoice tracking for a one-person field service operation
running four trades (firewood, hauling, plumbing, HVAC). Mobile first. The user
is standing in a driveway, one handed, in sunlight. Optimise for that, not for a
desktop admin panel.

## Conventions

- Keep the app fast and legible on phones. Touch targets stay at `min-h-12`.
- Prefer minimal, focused changes over broad refactors unless asked.
- Keep Firebase config in `.env`, out of source control.
- All app source lives in `src/App.jsx`. It is one large file on purpose; match
  the surrounding style rather than introducing a new structure mid-file.
- No em dashes anywhere, in code, comments, copy, or docs.

## Design system

Tokens are defined in `src/index.css` under `@theme`, not in
`tailwind.config.js`. Tailwind 4 is CSS-first here.

- Neutrals: `ink`, `graphite`, `ash`, `paper`
- Accent: `hazard`, `ember`
- Trades: `timber`, `haul`, `flow`, `hvac`
- Type: `font-display` is Barlow Condensed (headings, figures), the default sans
  is Barlow. Use `.tabular` on money and counts.

Rules that matter:

- Trade colours must appear as literal class strings. Tailwind scans source
  text, so `bg-${trade}` silently produces no CSS.
- Weight tops out at `font-bold`. Do not reintroduce `font-black`.
- No all-caps tracked micro-labels, no middle-dot meta joins, no arrows glued to
  link text. These were removed deliberately.
- Accent colour carries meaning. A zero value is not accented.

## Supabase

- `db push` and `link -p` want the database password. `supabase db query
  --linked` goes through the Management API and needs none, so use it for
  schema work and for inspecting data.
- `supabase/schema.sql` is idempotent and safe to re-run. The realtime
  publication line is wrapped in an exception block for exactly that reason.
- `config push` sends the whole of `config.toml`, not just the line you edited.
  Check `supabase config diff` first on a project with real settings.
- Postgres numerics come back as strings over PostgREST. `rowToJob` coerces
  them, because the UI does arithmetic on those fields.
- `status` is a generated column. Never write to it.

## Where code belongs

- `src/jobMapping.js` holds every pure function: field mapping, value encoding,
  the open/unpaid predicates and CSV building. No React, no Supabase, no DOM.
  Anything that can be tested without a browser goes here.
- `src/App.jsx` holds components and anything touching Supabase, Capacitor or
  the DOM.

This split is not cosmetic. Two production bugs shipped from logic buried in
App.jsx where no test could import it. If you add a pure helper, put it in
jobMapping.js and test it.

## Things that will bite you

- **One encoder for every write.** `encodeColumn` is used by both the insert and
  the update path. They were written separately once and drifted twice: an
  explicit null wiped tax_rate's default, then raw epoch milliseconds hit a
  timestamptz column as 22008. Never hand-roll a second encoder.
- **Absent is not null.** Omit a field the form never set so the column default
  and the invoice_number trigger still run. Writing null overrides both.
- **Surface the real error.** `describeSaveError` appends the raw code and
  message. A generic message cost a full round trip of guessing with a user.

- **Never use `npx` in this repo.** `npx firebase-tools deploy` and `npx cap sync`
  hang indefinitely at zero CPU, producing no output at all. Call the binaries
  directly instead: `./node_modules/.bin/firebase`, `./node_modules/.bin/cap`.
  Same commands, same flags, and they complete in seconds. This cost a long
  debugging detour once already.
- **Order state is two independent ticks.** `completedAt` and `paidAt` are
  nullable timestamps; `status` is derived from `completedAt` so it cannot
  drift. Editing an order must never write either field, or fixing a typo would
  move the order between sections.

- **Firestore rules gate everything.** `firestore.rules` must be deployed or
  every write fails with PERMISSION_DENIED while the UI looks healthy. This was
  the original bug in this project.
- **Do not swallow save errors.** An earlier version caught Firestore failures,
  wrote to localStorage, and reported success. Failures must surface.
- **`#printable-invoice`** must stay on the invoice card or printing yields a
  blank page. The print CSS hides everything else.
- **Never call `getCurrentPosition` once and trust it.** A device returns a
  coarse cell or wifi fix within a second, then tightens to GPS over several
  seconds. Asking once captures the worst fix of the session, which is why the
  pin used to return a town instead of a street. `readBestFix` watches the
  stream, keeps the tightest fix, and stops at 20 m or 12 s. Measured effect on
  one desktop: town-only before, `360 Martin Luther King Drive, Norwalk,
  Connecticut, 06853` at 40 m after.
- **Never discard `coords.accuracy`.** A 3 km fix still yields a confident
  looking town name. Anything coarser than 100 m is labelled approximate.
- **Geocoder order is measured, not guessed.** Nominatim returns a house number
  in urban, suburban, small town and most rural cases; Photon fills some gaps
  but disagreed with Nominatim on one address; BigDataCloud never returns a
  house number. `reverseGeocode` prefers whichever result carries one.
- **Geocoding fetches need timeouts.** Browser `fetch` has none, and the three
  providers run in series, so a hung request means an endless spinner.
- **Cache headers are deliberate** in `firebase.json`. `index.html` is
  `no-cache`; `/assets/**` is immutable for a year. Do not "simplify" these.
- **The address field stays free text.** The location pin fills it in; it never
  replaces the input.

## Commands

```bash
npm install
npm run dev
npm run build
./node_modules/.bin/firebase deploy                        # hosting and rules
./node_modules/.bin/firebase deploy --only firestore:rules # rules only
./node_modules/.bin/cap sync                               # web build into ios/ and android/
```

## Deployment

- Firebase Hosting serves `dist/`.
- `npx firebase-tools deploy` ships hosting and Firestore rules together.
- After any web change intended for a phone, run `npx cap sync` before building
  natively.
