# HustleSync

HustleSync is a Vite + React web app for managing service jobs, invoices, and Firebase-backed authentication/data storage.

## What’s included

- Anonymous Firebase Auth for quick sign-in
- Firestore-backed job storage
- Mobile-friendly layout for web and iPhone browsers
- Firebase Hosting deployment support

## Project structure

- `index.html` - Vite entry HTML
- `src/main.jsx` - React bootstrap entry point
- `src/App.jsx` - Main HustleSync app source
- `src/index.css` - Tailwind entry styles and print rules
- `firebase.json` - Firebase Hosting config
- `.firebaserc` - Firebase project binding
- `.env` - Local Firebase web app config

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the local dev server:

   ```bash
   npm run dev
   ```

3. Build for production:

   ```bash
   npm run build
   ```

## Firebase environment variables

Create a `.env` file with these values:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

## Firebase Hosting

This repo is configured for Firebase Hosting with a `dist/` public folder.

Common deploy flow:

```bash
npm run build
npx firebase-tools deploy
```

If Firebase CLI is not already authenticated, run:

```bash
npx firebase-tools login --no-localhost
```

## Notes

- The app currently uses Firebase Anonymous Authentication and Firestore.
- The code includes a safe fallback screen if Firebase config is missing.
- Tailwind is configured through PostCSS for the latest toolchain.