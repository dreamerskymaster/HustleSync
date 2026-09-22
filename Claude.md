# Claude Instructions

## Project conventions

- Keep the app optimized for web and mobile browsers.
- Prefer minimal, focused changes over broad refactors unless explicitly requested.
- Keep Firebase configuration in `.env` and out of source control.
- Use the Vite entry points already in the repo.

## Working notes

- `src/App.jsx` contains the main app source.
- Firebase Hosting is configured to serve `dist/`.

## Useful commands

```bash
npm install
npm run dev
npm run build
npx firebase-tools deploy
```

## Deployment notes

- Use Firebase Hosting for the simplest deploy path.
- If Firebase CLI asks for auth, use the browser login flow.
- Keep Firestore and Anonymous Auth enabled in the Firebase project.