// HustleSync app source.
// The app is kept in this file and re-exported from src/App.jsx for Vite.

import React, { useState, useEffect, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Device } from '@capacitor/device';
import { Geolocation } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import { PushNotifications } from '@capacitor/push-notifications';
import { createClient } from '@supabase/supabase-js';
import {
  JOB_FIELDS, encodeColumn, jobToRow, rowToJob,
  isOpenOrder, isUnpaid, asDate, buildCsv, seedForm
} from './jobMapping.js';
import { initializeApp } from 'firebase/app';
import { 
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  signInAnonymously, 
  signInWithCustomToken, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  onSnapshot, 
  addDoc, 
  doc,
  deleteDoc,
  updateDoc
} from 'firebase/firestore';
import { 
  User as UserIcon, MapPin, Phone, Calendar as CalendarIcon, 
  Flame, DollarSign, Layers, CheckCircle, Plus, ArrowLeft,
  Truck, Trash2, TreePine, Printer, Share2, Home, Wrench, 
  Thermometer, Briefcase, Activity, Clock, Sun, Moon, Pencil, AlertTriangle, Download
} from 'lucide-react';

// --- Supabase (Postgres) ---
// Present only once VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
// While they are absent the app stays on Firestore, so adding the two
// variables is the entire cutover and removing them is the rollback.
const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;
const usePostgres = Boolean(supabase);

const fetchPostgresJobs = async (userId) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToJob);
};

// --- Firebase Initialization ---
let firebaseConfig;

// This logic allows the app to run in the current sandbox AND on standard external hosting via Vite
if (typeof __firebase_config !== 'undefined' && __firebase_config) {
  firebaseConfig = typeof __firebase_config === 'string' ? JSON.parse(__firebase_config) : __firebase_config;
} else if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_FIREBASE_API_KEY) {
  firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:1234567890:web:abcdef'
  };
} else {
  console.warn("Firebase configuration missing. Please ensure .env variables are set.");
  firebaseConfig = null;
}

const hasFirebaseConfig = Boolean(
  firebaseConfig?.apiKey &&
  firebaseConfig?.authDomain &&
  firebaseConfig?.projectId &&
  firebaseConfig?.appId
);

const LOCAL_STORAGE_KEY = 'hustlesync-demo-jobs-v1';
const THEME_STORAGE_KEY = 'hustlesync-theme';

const readLocalJobs = () => {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (error) {
    console.warn('Could not read local job cache:', error);
    return [];
  }
};

const localJobsListeners = new Set();

const subscribeLocalJobs = (listener) => {
  localJobsListeners.add(listener);
  return () => localJobsListeners.delete(listener);
};

const writeLocalJobs = (jobs) => {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(jobs));
  } catch (error) {
    console.warn('Could not save local job cache:', error);
  }
  // Notify any mounted view so on-device saves show up immediately.
  localJobsListeners.forEach(listener => listener(jobs));
};

const saveLocalJob = (payload) => {
  const current = readLocalJobs();
  const id = payload.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`);
  const next = [{ ...payload, id, createdAt: payload.createdAt || Date.now() }, ...current].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  writeLocalJobs(next);
  return { id, ...payload, createdAt: payload.createdAt || Date.now() };
};

const deleteLocalJob = (jobId) => {
  const next = readLocalJobs().filter(job => job.id !== jobId);
  writeLocalJobs(next);
};

// A Firestore write stays pending forever when the request never reaches the
// network (ad blocker, privacy extension, VPN, captive wifi), so race it.
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${Math.round(ms / 1000)}s - the request never reached firestore.googleapis.com.`);
      error.code = 'timeout';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// A job booked for a future date is still Open. Anything else was done on the
// spot, which is how plumbing, HVAC and hauling are normally logged: standing
// there having just finished it.
// --- Offline support -------------------------------------------------------
// This app is used in driveways with one bar of signal. A save that fails
// because the van moved behind a hill must not lose the job. Writes made
// offline go into an outbox in local storage, are applied to a cached copy of
// the list so the screen stays truthful, and replay in order on reconnect.

const OUTBOX_KEY = 'hustlesync-outbox-v1';
const JOBS_CACHE_KEY = 'hustlesync-jobs-cache-v1';

const readJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
};

const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Storage full or blocked. The queue is a convenience, not a guarantee.
  }
};

const cacheListeners = new Set();
const subscribeCache = (listener) => {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
};
const publishCache = () => {
  const jobs = readJson(JOBS_CACHE_KEY, []);
  const pending = readJson(OUTBOX_KEY, []).length;
  cacheListeners.forEach(listener => listener(jobs, pending));
};

const cacheJobs = (jobs) => {
  writeJson(JOBS_CACHE_KEY, jobs);
  publishCache();
};

const pendingCount = () => readJson(OUTBOX_KEY, []).length;

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// A refused request is a real error and must surface. A request that never
// reached the server is worth retrying later.
const isNetworkFailure = (error) => {
  if (isOffline()) return true;
  const message = String((error && error.message) || '');
  return /failed to fetch|networkerror|network request failed|timed out|load failed/i.test(message);
};

const queueChange = (change) => {
  const outbox = readJson(OUTBOX_KEY, []);
  outbox.push({ ...change, queuedAt: Date.now() });
  writeJson(OUTBOX_KEY, outbox);
};

// Mirror the change onto the cached list so the screen matches what the user
// just did, even though the server has not heard about it yet.
const applyToCache = (change) => {
  const jobs = readJson(JOBS_CACHE_KEY, []);
  let next = jobs;
  if (change.type === 'insert') {
    next = [{ ...change.payload, id: change.localId, pendingSync: true }, ...jobs];
  } else if (change.type === 'update') {
    next = jobs.map(job => (job.id === change.jobId ? { ...job, ...change.fields, pendingSync: true } : job));
  } else if (change.type === 'delete') {
    next = jobs.filter(job => job.id !== change.jobId);
  }
  next.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  cacheJobs(next);
};

let flushing = false;

const flushOutbox = async (userId) => {
  if (flushing || !usePostgres || !userId) return;
  const outbox = readJson(OUTBOX_KEY, []);
  if (!outbox.length) return;
  flushing = true;
  try {
    const remaining = [...outbox];
    while (remaining.length) {
      const change = remaining[0];
      try {
        if (change.type === 'insert') {
          const { error } = await supabase.from('jobs').insert(jobToRow(change.payload, userId));
          if (error) throw error;
        } else if (change.type === 'update') {
          // A row that only ever existed offline has no server id yet; its
          // insert is still queued ahead of this, so skip rather than fail.
          if (String(change.jobId).startsWith('pending-')) { remaining.shift(); continue; }
          await updateJobFields(change.jobId, userId, change.fields, true);
        } else if (change.type === 'delete') {
          if (!String(change.jobId).startsWith('pending-')) {
            const { error } = await supabase.from('jobs').delete().eq('id', change.jobId).eq('user_id', userId);
            if (error) throw error;
          }
        }
        remaining.shift();
        writeJson(OUTBOX_KEY, remaining);
      } catch (error) {
        if (isNetworkFailure(error)) break;      // still offline, try again later
        console.error('Dropping unsendable queued change:', change, error);
        remaining.shift();                        // rejected outright, retrying will not help
        writeJson(OUTBOX_KEY, remaining);
      }
    }
  } finally {
    flushing = false;
    publishCache();
  }
};

const initialCompletion = (payload) => {
  const scheduled = payload.deliveryDate
    ? Date.parse(`${payload.deliveryDate}T23:59:59`)
    : null;
  const isFuture = Boolean(scheduled) && scheduled > Date.now();
  return { completedAt: isFuture ? null : Date.now(), paidAt: null };
};

const updateJobFields = async (jobId, userId, fields, direct = false) => {
  if (usePostgres && userId) {
    const queueIt = () => {
      const change = { type: 'update', jobId, fields };
      queueChange(change);
      applyToCache(change);
    };
    // `direct` is set when replaying the outbox, so a retry cannot re-queue
    // itself and spin forever.
    if (!direct && isOffline()) return queueIt();
    // Send only the columns that changed, mapped to snake_case.
    const row = {};
    for (const [key, column] of JOB_FIELDS) {
      if (key in fields) row[column] = encodeColumn(column, fields[key]);
    }
    try {
      const { error } = await supabase.from('jobs').update(row).eq('id', jobId).eq('user_id', userId);
      if (error) throw error;
    } catch (error) {
      if (!direct && isNetworkFailure(error)) return queueIt();
      throw error;
    }
    return;
  }
  if (!db || !userId) {
    const next = readLocalJobs().map(job => (job.id === jobId ? { ...job, ...fields } : job));
    writeLocalJobs(next);
    return;
  }
  const docRef = doc(db, 'artifacts', appId, 'users', userId, 'jobs', jobId);
  await withTimeout(updateDoc(docRef, fields), 15000, 'Updating this job');
};

// Create and edit share one path. Editing never touches completedAt or paidAt,
// so correcting an address cannot silently change where an order sits.
// Lives here, not in jobMapping.js, because it reaches the database.
const submitJob = async (payload, userId, existingJob) => {
  if (existingJob && existingJob.id) {
    await updateJobFields(existingJob.id, userId, payload);
    return { id: existingJob.id, ...payload };
  }
  return persistJob(payload, userId);
};

const persistJob = async (rawPayload, userId) => {
  const payload = { ...rawPayload, ...initialCompletion(rawPayload) };

  if (usePostgres && userId) {
    const localId = `pending-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    const queueIt = () => {
      const change = { type: 'insert', payload, localId };
      queueChange(change);
      applyToCache(change);
      return { id: localId, ...payload, pendingSync: true };
    };
    if (isOffline()) return queueIt();
    try {
      const { data, error } = await supabase
        .from('jobs')
        .insert(jobToRow(payload, userId))
        .select()
        .single();
      if (error) throw error;
      return rowToJob(data);
    } catch (error) {
      if (isNetworkFailure(error)) return queueIt();
      throw error;
    }
  }

  // Only used when the app has no backend configured at all (true demo mode).
  if (!db || !userId) {
    return saveLocalJob(payload);
  }

  // Let failures propagate: the form shows the real reason instead of
  // pretending the job was saved.
  const docRef = await withTimeout(
    addDoc(collection(db, 'artifacts', appId, 'users', userId, 'jobs'), payload),
    15000,
    'Saving this job'
  );
  return { id: docRef.id, ...payload };
};

const removePersistedJob = async (jobId, userId) => {
  if (usePostgres && userId) {
    const queueIt = () => {
      const change = { type: 'delete', jobId };
      queueChange(change);
      applyToCache(change);
    };
    if (isOffline()) return queueIt();
    try {
      const { error } = await supabase.from('jobs').delete().eq('id', jobId).eq('user_id', userId);
      if (error) throw error;
    } catch (error) {
      if (isNetworkFailure(error)) return queueIt();
      throw error;
    }
    return;
  }
  if (!db || !userId) {
    deleteLocalJob(jobId);
    return;
  }

  const docRef = doc(db, 'artifacts', appId, 'users', userId, 'jobs', jobId);
  await withTimeout(deleteDoc(docRef), 15000, 'Deleting this job');
};

let app = null;
let auth = null;
let db = null;

const createMobileFriendlyAuth = (firebaseApp) => {
  try {
    return initializeAuth(firebaseApp, {
      persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    });
  } catch (error) {
    return getAuth(firebaseApp);
  }
};

if (hasFirebaseConfig) {
  app = initializeApp(firebaseConfig);
  auth = createMobileFriendlyAuth(app);
  db = getFirestore(app);
}

// Use sandbox appId if available, otherwise default for production
const appId = typeof __app_id !== 'undefined' ? __app_id : 'hustlesync-prod';

// Never hide the real reason a save failed. The previous version returned
// Firestore-flavoured copy for a Supabase app and swallowed the actual error,
// which made every report unactionable. Postgres and PostgREST return precise
// codes, so check those before guessing at wording, and always append the raw
// detail so a screenshot is enough to diagnose from.
const describeSaveError = (error) => {
  const message = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  const status = error && error.status;
  const detail = [code, message].filter(Boolean).join(': ').slice(0, 220);

  if (code === '23502') {
    return `A required field was empty, so the database rejected it. ${detail}`;
  }
  if (code === '23505') {
    return `That record already exists. ${detail}`;
  }
  if (code === '42501' || /row-level security/i.test(message)) {
    return 'This session is not allowed to save that. Close and reopen the app to sign in again.';
  }
  if (code === 'PGRST205') {
    return 'The jobs table is missing from the database. The schema needs to be applied.';
  }
  if (code === 'PGRST204' || /schema cache/i.test(message)) {
    // A column the app sends is not in PostgREST's cached schema, which happens
    // when the table changed but the cache has not reloaded yet.
    return `The app sent a field the database does not know about yet. ${detail}`;
  }
  if (status === 429 || /rate limit|too many requests/i.test(message)) {
    return 'Too many sign-ins from this network in the last hour. Wait a few minutes, then try again.';
  }
  if (/failed to fetch|networkerror|network request failed|load failed|timed out|offline/i.test(message)) {
    return 'No connection. This job is saved on your device and will upload when you get signal.';
  }
  if (status === 401 || /jwt|invalid token|unauthor/i.test(message)) {
    return 'Your session expired. Close and reopen the app to sign in again.';
  }
  if (/permission|insufficient|PERMISSION_DENIED/i.test(message)) {
    return `The database refused the write. ${detail}`;
  }

  return `Save failed. ${detail || 'The server returned no details.'}`;
};


// HustleSync brand mark - mirrors public/favicon.svg
export function HustleSyncMark({ className = "h-8 w-8", tile = true }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="HustleSync">
      <defs>
        <linearGradient id="hsm-tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2d2926" />
          <stop offset="1" stopColor="#0e0c0b" />
        </linearGradient>
        <linearGradient id="hsm-mark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      {tile && <rect width="64" height="64" rx="14" fill="url(#hsm-tile)" />}
      <g fill="none" stroke="url(#hsm-mark)" strokeWidth="5.0" strokeLinecap="round">
        <path d="M19.31 26.08 A14.0 14.0 0 0 1 44.69 26.08" />
        <path d="M44.69 37.92 A14.0 14.0 0 0 1 19.31 37.92" />
      </g>
      <g fill="url(#hsm-mark)">
        <path d="M49.34 36.05 L38.35 29.04 L51.03 23.12 Z" />
        <path d="M14.66 27.95 L25.65 34.96 L12.97 40.88 Z" />
      </g>
    </svg>
  );
}

export default function HustleSyncApp() {
  if (!hasFirebaseConfig) {
    return (
      <div className="min-h-[100svh] bg-paper text-ink flex items-center justify-center p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">
        <div className="w-full max-w-xl rounded-3xl border border-line bg-surface p-8 shadow-xl">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-panel text-white">
            <Briefcase className="h-7 w-7" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">HustleSync is almost ready</h1>
          <p className="mt-3 text-graphite">
            The app is installed, but Firebase keys are still missing. Paste your Firebase Web App config into a local .env file, then reload the app.
          </p>
          <div className="mt-6 rounded-2xl border border-line bg-paper p-4 text-sm font-mono text-graphite">
            <div>VITE_FIREBASE_API_KEY=...</div>
            <div>VITE_FIREBASE_AUTH_DOMAIN=...</div>
            <div>VITE_FIREBASE_PROJECT_ID=...</div>
            <div>VITE_FIREBASE_STORAGE_BUCKET=...</div>
            <div>VITE_FIREBASE_MESSAGING_SENDER_ID=...</div>
            <div>VITE_FIREBASE_APP_ID=...</div>
          </div>
          <p className="mt-4 text-sm text-ash">
            After that, I can verify anonymous auth and Firestore against your Firebase project and prep the deployment target you choose.
          </p>
        </div>
      </div>
    );
  }

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [firestoreIssue, setFirestoreIssue] = useState(null);
  const [localDemoMode, setLocalDemoMode] = useState(!hasFirebaseConfig || !db);
  // Follow the operating system unless the user has chosen otherwise.
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (error) {
      // Private browsing can throw on read; fall through to the system value.
    }
    return typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      // A remembered theme is a convenience, never a requirement.
    }
  }, [theme]);

  const toggleTheme = () => setTheme(current => (current === 'dark' ? 'light' : 'dark'));

  const [queued, setQueued] = useState(() => pendingCount());
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);

  useEffect(() => {
    const unsubscribe = subscribeCache((_jobs, waiting) => setQueued(waiting));
    const goOnline = () => { setOnline(true); setQueued(pendingCount()); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      unsubscribe();
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  
  // Navigation State: { view: 'home' | 'dashboard' | 'new_order' | 'invoice', business: string, job: object }
  const [nav, setNav] = useState({ view: 'home', business: null, job: null });
  const [allJobs, setAllJobs] = useState([]);

  // Handle Authentication
  useEffect(() => {
    if (usePostgres) {
      let active = true;
      // Normalise to `uid` so the rest of the app does not care which backend
      // issued the session.
      const adopt = (session) => {
        if (!active || !session || !session.user) return;
        setUser({ uid: session.user.id });
        setLoading(false);
      };

      const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => adopt(session));

      (async () => {
        try {
          const { data } = await supabase.auth.getSession();
          if (data && data.session) {
            adopt(data.session);
            return;
          }
          const { data: signedIn, error } = await supabase.auth.signInAnonymously();
          if (error) throw error;
          adopt(signedIn.session);
        } catch (error) {
          console.error('Supabase auth error:', error);
          if (!active) return;
          setAuthError(error);
          setLoading(false);
        }
      })();

      return () => {
        active = false;
        listener.subscription.unsubscribe();
      };
    }

    const initAuth = async () => {
      try {
        setAuthError(null);

        if (!auth) {
          setUser({ uid: 'local-demo-user' });
          setLoading(false);
          return;
        }

        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Auth error:", error);
        setAuthError(error);
        setUser({ uid: 'local-demo-user' });
        setLocalDemoMode(true);
        setLoading(false);
      }
    };

    if (!auth) {
      setUser({ uid: 'local-demo-user' });
      setLoading(false);
      return;
    }

    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // Fetch All Jobs across all businesses
  useEffect(() => {
    if (!user || !user.uid) {
      setAllJobs([]);
      return;
    }

    if (usePostgres) {
      let active = true;
      const load = async () => {
        try {
          await flushOutbox(user.uid);
          const rows = await fetchPostgresJobs(user.uid);
          if (!active) return;
          cacheJobs(rows);
          setAllJobs(rows);
          setLocalDemoMode(false);
          setFirestoreIssue(null);
        } catch (error) {
          console.error('Could not load jobs:', error);
          if (!active) return;
          // Fall back to the last known list rather than an empty screen.
          const cached = readJson(JOBS_CACHE_KEY, []);
          if (cached.length) setAllJobs(cached);
          setFirestoreIssue(
            isNetworkFailure(error)
              ? 'Offline. Showing the last synced list; changes are saved on this device and will upload when you reconnect.'
              : describeSaveError(error)
          );
        }
      };

      // Local edits made while offline must repaint immediately.
      const unsubscribeCache = subscribeCache((jobs) => {
        if (active) setAllJobs([...jobs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      });

      const onOnline = () => load();
      window.addEventListener('online', onOnline);

      load();

      // Postgres changes stream back, so a job saved on the phone shows up on
      // the laptop without a refresh.
      const channel = supabase
        .channel(`jobs-${user.uid}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'jobs', filter: `user_id=eq.${user.uid}` },
          () => load()
        )
        .subscribe();

      return () => {
        active = false;
        unsubscribeCache();
        window.removeEventListener('online', onOnline);
        supabase.removeChannel(channel);
      };
    }

    if (!db) {
      const localJobs = readLocalJobs();
      localJobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setAllJobs(localJobs);
      setFirestoreIssue('Running in local demo mode. Firebase is unavailable, so jobs are stored in your browser for testing.');
      setLocalDemoMode(true);
      return;
    }

    setFirestoreIssue(null);
    setLocalDemoMode(false);
    const jobsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'jobs');
    
    const unsubscribe = onSnapshot(jobsRef, 
      (snapshot) => {
        const fetchedJobs = snapshot.docs.map(doc => ({
          id: doc.id, ...doc.data()
        }));
        fetchedJobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setAllJobs(fetchedJobs);
        setFirestoreIssue(null);
      },
      (error) => {
        console.error("Error fetching jobs:", error);
        setAllJobs(readLocalJobs());
        setLocalDemoMode(true);
        setFirestoreIssue(`${describeSaveError(error)} Showing on-device jobs only until the connection is restored.`);
      }
    );

    return () => unsubscribe();
  }, [user]);

  // While running on-device only, reflect local saves immediately.
  useEffect(() => {
    if (!localDemoMode) return undefined;
    setAllJobs(readLocalJobs().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    return subscribeLocalJobs((jobs) => {
      setAllJobs([...jobs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    });
  }, [localDemoMode]);

  if (loading) {
    return (
      <div className="flex min-h-[100svh] w-full items-center justify-center bg-panel text-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">
        <div className="flex flex-col items-center gap-4">
          <HustleSyncMark className="h-16 w-16 animate-pulse" tile={false} />
          <p className="font-bold tracking-widest uppercase text-ash">Loading HustleSync...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    const errorCode = authError?.code || authError?.message || 'Unknown auth error';
    const isConfigMissing = String(errorCode).includes('auth/configuration-not-found');
    const consoleLink = 'https://console.firebase.google.com/project/hustlesync-3665b/authentication/providers';

    return (
      <div className="flex min-h-[100svh] w-full items-center justify-center bg-panel text-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] text-center">
        <div className="bg-panel p-8 rounded-2xl max-w-md shadow-xl border border-line w-full">
          <Briefcase className="w-16 h-16 text-red-400 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-3">Authentication Required</h2>
          <p className="text-ash text-sm mb-4">
            {isConfigMissing
              ? 'Anonymous Authentication is likely disabled or not configured for this Firebase project. Enable the Anonymous provider in the Firebase Console.'
              : 'Please check your Firebase configuration and make sure Anonymous Authentication is enabled in the Firebase Console.'}
          </p>
          <div className="bg-panel p-4 rounded-lg text-left overflow-auto text-xs text-ash font-mono mb-4">
            {errorCode}
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={() => window.location.reload()}
              className="bg-red-500 hover:bg-red-400 text-white px-4 py-2 rounded-lg font-bold transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => {
                console.log('Firebase auth config', firebaseConfig);
                window.location.reload();
              }}
              className="bg-graphite hover:bg-ink text-white px-4 py-2 rounded-lg font-bold transition-colors"
            >
              Reload App
            </button>
          </div>
          {isConfigMissing && (
            <a
              href={consoleLink}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex text-sm font-bold text-red-300 hover:text-red-200 underline underline-offset-4"
            >
              Open Firebase Authentication settings
            </a>
          )}
        </div>
      </div>
    );
  }

  const navigateTo = (view, business = null, job = null) => {
    setNav({ view, business, job });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const currentBusinessJobs = allJobs.filter(j => j.businessType === nav.business);

  return (
    <div className="min-h-[100svh] bg-paper text-ink font-sans pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">
      {(!online || queued > 0) && (
        <div className="mx-auto max-w-4xl px-4 pt-4">
          <div className="flex items-start gap-3 rounded-2xl border border-hazard/40 bg-hazard/10 p-4 text-sm text-ember shadow-sm">
            <div className="mt-0.5 rounded-full bg-hazard/25 p-1 text-ember"><Activity className="h-4 w-4" /></div>
            <div>
              <p className="font-bold">{online ? 'Catching up' : 'Working offline'}</p>
              <p className="mt-1">
                {queued > 0
                  ? `${queued === 1 ? '1 change is' : `${queued} changes are`} saved on this device and will upload ${online ? 'in a moment' : 'when you get signal'}.`
                  : 'No connection. Jobs you save are kept on this device and upload when you reconnect.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {firestoreIssue && (
        <div className="mx-auto max-w-4xl px-4 pt-4">
          <div className={`rounded-2xl border p-4 text-sm shadow-sm ${localDemoMode ? 'border-ink/15 bg-surface text-graphite' : 'border-hazard/40 bg-hazard/10 text-ember'}`}>
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 rounded-full p-1 ${localDemoMode ? 'bg-ink/10 text-graphite' : 'bg-hazard/25 text-ember'}`}>{localDemoMode ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}</div>
              <div>
                <p className="font-bold">{localDemoMode ? 'Demo mode active' : 'Data connection warning'}</p>
                <p className="mt-1">{firestoreIssue}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {nav.view === 'home' && (
        <MasterDashboard jobs={allJobs} onNavigate={navigateTo} theme={theme} onToggleTheme={toggleTheme} />
      )}
      
      {nav.view === 'dashboard' && nav.business && (
        <BusinessDashboard 
          businessType={nav.business}
          jobs={currentBusinessJobs}
          userId={user.uid}
          onNavigate={navigateTo}
        />
      )}

      {nav.view === 'new_order' && nav.business && (
        <NewJobFormRouter
          businessType={nav.business}
          user={user}
          onNavigate={navigateTo}
          jobs={allJobs}
        />
      )}

      {nav.view === 'edit_order' && nav.business && nav.job && (
        <NewJobFormRouter
          businessType={nav.business}
          user={user}
          onNavigate={navigateTo}
          existingJob={nav.job}
          jobs={allJobs}
        />
      )}

      {nav.view === 'invoice' && nav.job && (
        <UniversalInvoiceView 
          job={nav.job}
          onClose={() => navigateTo('dashboard', nav.business)}
        />
      )}
    </div>
  );
}

function MasterDashboard({ jobs, onNavigate, theme, onToggleTheme }) {
  // Match the trade boards: earned money and scheduled money are different
  // things, so the headline figure must not quietly add them together.
  const earned = jobs.filter(job => !isOpenOrder(job)).reduce((sum, job) => sum + (job.totalPrice || 0), 0);
  const scheduled = jobs.filter(isOpenOrder).reduce((sum, job) => sum + (job.totalPrice || 0), 0);
  const recentJobs = jobs.slice(0, 5);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [pushStatus, setPushStatus] = useState('Web-ready');

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      setPushStatus('Web-ready');
      return;
    }

    let cancelled = false;

    Device.getInfo()
      .then((info) => {
        if (!cancelled) setDeviceInfo(info);
      })
      .catch(() => {});

    PushNotifications.requestPermissions()
      .then((permission) => {
        if (!cancelled) {
          setPushStatus(permission.receive === 'granted' ? 'Notifications enabled' : 'Permission pending');
        }
        if (permission.receive === 'granted') {
          PushNotifications.register();
        }
      })
      .catch(() => {
        if (!cancelled) setPushStatus('Unavailable');
      });

    const registrationListener = PushNotifications.addListener('registration', (token) => {
      if (!cancelled) setPushStatus(`Ready (${token.value.slice(-8)})`);
    });

    const notificationListener = PushNotifications.addListener('pushNotificationReceived', () => {
      if (!cancelled) setPushStatus('New push received');
    });

    return () => {
      cancelled = true;
      registrationListener?.remove();
      notificationListener?.remove();
    };
  }, []);

  const businesses = [
    { id: 'firewood', name: 'Timber', icon: Flame, color: 'text-timber', bg: 'bg-timber', lightBg: 'bg-timber/8', border: 'border-timber/20' },
    { id: 'hauling', name: 'Haul', icon: Truck, color: 'text-haul', bg: 'bg-haul', lightBg: 'bg-haul/8', border: 'border-haul/20' },
    { id: 'plumbing', name: 'Flow', icon: Wrench, color: 'text-flow', bg: 'bg-flow', lightBg: 'bg-flow/8', border: 'border-flow/20' },
    { id: 'heating', name: 'HVAC', icon: Thermometer, color: 'text-hvac', bg: 'bg-hvac', lightBg: 'bg-hvac/8', border: 'border-hvac/20' }
  ];

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 pb-24">
      <header className="mb-8 mt-2">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <HustleSyncMark className="h-9 w-9" />
            <span className="font-display text-2xl font-semibold tracking-wide text-ink">HustleSync</span>
          </div>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-line text-graphite transition-colors hover:bg-surface"
          >
            {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
        </div>

        {/* The money is the one loud thing on this screen. */}
        <div className="rounded-2xl bg-panel px-6 py-7 text-on-panel">
          <p className="text-base font-medium text-on-panel/60">Earned across all four trades</p>
          <p className="mt-1 font-display text-6xl font-bold leading-none tabular sm:text-7xl">
            ${earned.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="mt-3 text-base font-medium text-on-panel/60">
            {jobs.length === 1 ? '1 job logged' : `${jobs.length} jobs logged`}
            {scheduled > 0 && `, plus $${scheduled.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} scheduled`}
          </p>
        </div>
      </header>

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold tracking-wide text-graphite">Trades</h2>
        <ExportButton jobs={jobs} filename={`hustlesync-all-jobs-${asDate(Date.now())}.csv`} label="Export all" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
        {businesses.map(biz => {
          const bizJobs = jobs.filter(j => j.businessType === biz.id);
          const bizRev = bizJobs.reduce((sum, j) => sum + (j.totalPrice || 0), 0);
          const Icon = biz.icon;

          return (
            <button 
              key={biz.id}
              onClick={() => onNavigate('dashboard', biz.id)}
              className={`flex min-h-24 items-center gap-4 rounded-2xl border ${biz.border} ${biz.lightBg} p-5 text-left transition-colors hover:bg-surface active:scale-[0.99]`}
            >
              <div className={`${biz.bg} shrink-0 rounded-xl p-3.5 text-white`}>
                <Icon className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-xl font-semibold tracking-wide text-ink">HS {biz.name}</h3>
                <p className="text-sm font-medium text-ash">{bizJobs.length === 1 ? '1 job' : `${bizJobs.length} jobs`}</p>
              </div>
              {/* A zero is not worth accenting; only real money gets the trade colour. */}
              <p className={`font-display text-2xl font-semibold tabular ${bizRev > 0 ? biz.color : 'text-ash'}`}>${bizRev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            </button>
          )
        })}
      </div>

      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-xl font-semibold tracking-wide text-graphite">Recent jobs</h2>
        <span className="text-sm font-medium text-ash">Last 5</span>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink/10 bg-surface">
        {recentJobs.length === 0 ? (
          <div className="p-8 text-center">
            <p className="font-semibold text-graphite">No jobs logged yet</p>
            <p className="mt-1 text-sm text-ash">Pick a trade above to write your first one.</p>
          </div>
        ) : (
          <div className="divide-y divide-ink/10">
            {recentJobs.map(job => {
              const bizConfig = businesses.find(b => b.id === job.businessType) || businesses[0];
              const Icon = bizConfig.icon;
              return (
                <button key={job.id} type="button" className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-paper" onClick={() => onNavigate('invoice', job.businessType, job)}>
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={`${bizConfig.lightBg} ${bizConfig.color} shrink-0 rounded-lg p-2`}><Icon className="h-5 w-5" /></div>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{job.customerName}</p>
                      <p className="text-sm capitalize text-ash">{job.businessType}, {new Date(job.createdAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <p className="shrink-0 font-display text-xl font-semibold tabular text-graphite">${(job.totalPrice || 0).toFixed(2)}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <footer className="mt-12 border-t border-line pt-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <HustleSyncMark className="h-8 w-8" tile={false} />
          <p className="font-display text-lg font-semibold tracking-wide text-ink">HustleSync</p>
          <p className="text-sm text-ash">
            Built by <span className="font-bold text-graphite">SkyMaster</span>, with{' '}
            <span className="font-bold text-graphite">Claude</span>
          </p>
          <p className="mt-2 text-sm text-ash">
            {Capacitor.isNativePlatform() ? 'Installed app' : 'Running in the browser'}. Notifications: {pushStatus.toLowerCase()}.
          </p>
        </div>
      </footer>
    </div>
  );
}

function BusinessDashboard({ businessType, jobs, userId, onNavigate }) {
  const configs = {
    firewood: { title: 'Timber', icon: Flame, theme: 'bg-timber', text: 'text-timber', light: 'bg-timber/8', unit: 'Cords', calcUnit: j => Number(j.woodQuantity || 0) },
    hauling: { title: 'Haul', icon: Truck, theme: 'bg-haul', text: 'text-haul', light: 'bg-haul/8', unit: 'Loads', calcUnit: j => 1 },
    plumbing: { title: 'Flow', icon: Wrench, theme: 'bg-flow', text: 'text-flow', light: 'bg-flow/8', unit: 'Hours', calcUnit: j => Number(j.laborHours || 0) },
    heating: { title: 'HVAC', icon: Thermometer, theme: 'bg-hvac', text: 'text-hvac', light: 'bg-hvac/8', unit: 'Hours', calcUnit: j => Number(j.laborHours || 0) }
  };

  const config = configs[businessType];
  const Icon = config.icon;
  const [deleteErr, setDeleteErr] = useState("");
  const [confirming, setConfirming] = useState(null);

  const [query, setQuery] = useState("");

  // Search covers name, address and phone, which is how someone actually looks
  // for a job: they remember the street or the person, not the order.
  const needle = query.trim().toLowerCase();
  const matchesQuery = (job) => !needle || [job.customerName, job.customerAddress, job.customerPhone]
    .some(field => String(field || '').toLowerCase().includes(needle));

  // Totals stay over every job. Filtering the list must not change the money.
  const openJobs = jobs.filter(isOpenOrder);
  const completedJobs = jobs.filter(job => !isOpenOrder(job));
  const openShown = openJobs.filter(matchesQuery);
  const completedShown = completedJobs.filter(matchesQuery);
  const sum = (list) => list.reduce((total, job) => total + (job.totalPrice || 0), 0);

  // Total revenue is work finished. Pending revenue is booked but not yet
  // delivered. Unpaid is finished work the customer still owes on.
  const totalRev = sum(completedJobs);
  const pendingRev = sum(openJobs);
  const unpaidRev = sum(completedJobs.filter(isUnpaid));
  const totalUnits = jobs.reduce((total, job) => total + config.calcUnit(job), 0);

  const runUpdate = async (jobId, fields, failure) => {
    setDeleteErr("");
    try {
      await updateJobFields(jobId, userId, fields);
    } catch (e) {
      console.error(failure, e);
      setDeleteErr(describeSaveError(e));
    }
  };

  const handleDelete = async (orderId) => {
    setDeleteErr("");
    try {
        await removePersistedJob(orderId, userId);
    } catch (e) {
        console.error("Error deleting job:", e);
        setDeleteErr(describeSaveError(e));
    }
  };

  const confirmAction = async () => {
    const pending = confirming;
    setConfirming(null);
    if (!pending) return;
    if (pending.type === 'complete') {
      await runUpdate(pending.job.id, { completedAt: Date.now() }, 'Error completing job:');
    } else if (pending.type === 'reopen') {
      await runUpdate(pending.job.id, { completedAt: null, paidAt: null }, 'Error reopening job:');
    } else if (pending.type === 'delete') {
      await handleDelete(pending.job.id);
    }
  };

  const togglePaid = (job) =>
    runUpdate(job.id, { paidAt: job.paidAt ? null : Date.now() }, 'Error updating payment:');

  const confirmCopy = {
    complete: {
      title: 'Mark this order complete?',
      body: `${confirming?.job?.customerName ?? ''} moves to Completed orders and its $${(confirming?.job?.totalPrice || 0).toFixed(2)} counts as total revenue. You can reopen it later.`,
      confirmLabel: 'Mark complete',
      tone: 'default'
    },
    reopen: {
      title: 'Reopen this order?',
      body: `${confirming?.job?.customerName ?? ''} moves back to Open orders. Its payment mark is cleared and the money returns to pending revenue.`,
      confirmLabel: 'Reopen order',
      tone: 'default'
    },
    delete: {
      title: 'Delete this order?',
      body: `${confirming?.job?.customerName ?? ''} and its invoice are removed for good. This cannot be undone.`,
      confirmLabel: 'Delete order',
      tone: 'danger'
    }
  }[confirming?.type] || {};

  const renderJob = (job) => {
    const open = isOpenOrder(job);
    return (
      <div key={job.id} className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-bold text-ink">{job.customerName}</h3>
              <span className={`rounded-lg px-2.5 py-1 text-xs font-bold ${config.light} ${config.text}`}>
                ${(job.totalPrice || 0).toFixed(2)}
              </span>
              {isUnpaid(job) && (
                <span className="rounded-lg bg-hazard/15 px-2.5 py-1 text-xs font-bold text-ember">Awaiting payment</span>
              )}
              {job.paidAt && (
                <span className="rounded-lg bg-ink/10 px-2.5 py-1 text-xs font-bold text-graphite">Paid</span>
              )}
            </div>
            <p className="mb-2 flex items-start gap-2 text-sm text-ash">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{job.customerAddress}</span>
            </p>
            <JobSummaryLine businessType={businessType} job={job} />
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {open && (
              <button
                onClick={() => onNavigate('edit_order', businessType, job)}
                className="rounded-full p-2 text-ash transition-colors hover:bg-paper hover:text-ink"
                title="Edit order"
                aria-label="Edit order"
              >
                <Pencil className="h-5 w-5" />
              </button>
            )}
            <button
              onClick={() => onNavigate('invoice', businessType, job)}
              className="rounded-full p-2 text-ash transition-colors hover:bg-paper hover:text-ink"
              title="View invoice"
              aria-label="View invoice"
            >
              <Printer className="h-5 w-5" />
            </button>
            <button
              onClick={() => setConfirming({ type: 'delete', job })}
              className="rounded-full p-2 text-ash transition-colors hover:bg-red-50 hover:text-red-600"
              title="Delete order"
              aria-label="Delete order"
            >
              <Trash2 className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-4">
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-bold text-graphite">
            <input
              type="checkbox"
              checked={!open}
              onChange={() => setConfirming({ type: open ? 'complete' : 'reopen', job })}
              className="h-5 w-5 accent-hazard"
            />
            <span>Order complete</span>
          </label>
          {!open && (
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-bold text-graphite">
              <input
                type="checkbox"
                checked={Boolean(job.paidAt)}
                onChange={() => togglePaid(job)}
                className="h-5 w-5 accent-hazard"
              />
              <span>Paid</span>
            </label>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 pb-24">
      {deleteErr && (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800">
          {deleteErr}
        </div>
      )}
      <header className={`flex flex-col sm:flex-row justify-between items-center mb-8 ${config.theme} text-white p-5 rounded-3xl shadow-lg`}>
        <div className="flex items-center gap-4 mb-4 sm:mb-0 w-full sm:w-auto">
          <button onClick={() => onNavigate('home')} className="p-2 bg-black/20 hover:bg-black/40 rounded-xl transition-colors">
            <Home className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-surface/20 rounded-xl backdrop-blur-sm">
              <Icon className="w-8 h-8" fill={businessType === 'firewood' ? 'currentColor' : 'none'} />
            </div>
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-wide">HS {config.title}</h1>
            </div>
          </div>
        </div>
        <button 
          onClick={() => onNavigate('new_order', businessType)}
          className="w-full sm:w-auto flex items-center justify-center gap-2 bg-surface text-ink hover:bg-paper px-6 py-3 rounded-xl font-bold shadow-md transition-colors active:scale-95"
        >
          <Plus className="w-5 h-5 stroke-[3]" />
          <span>New Job</span>
        </button>
      </header>

      <div className="mb-4 flex justify-end">
        <ExportButton jobs={jobs} filename={`hustlesync-${businessType}-${asDate(Date.now())}.csv`} label={`Export ${config.title}`} />
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="mb-1 text-sm font-medium text-ash">Total revenue</p>
          <p className={`font-display text-3xl font-semibold tabular ${config.text}`}>${totalRev.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
          <p className="mt-1 text-sm text-ash">{completedJobs.length === 1 ? '1 completed order' : `${completedJobs.length} completed orders`}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="mb-1 text-sm font-medium text-ash">Pending revenue</p>
          <p className="font-display text-3xl font-semibold tabular text-ink">${pendingRev.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
          <p className="mt-1 text-sm text-ash">{openJobs.length === 1 ? '1 open order' : `${openJobs.length} open orders`}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="mb-1 text-sm font-medium text-ash">Awaiting payment</p>
          <p className={`font-display text-3xl font-semibold tabular ${unpaidRev > 0 ? 'text-hazard' : 'text-ash'}`}>${unpaidRev.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
          <p className="mt-1 text-sm text-ash">delivered, not yet paid</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="mb-1 text-sm font-medium text-ash">Total {config.unit.toLowerCase()}</p>
          <p className="font-display text-3xl font-semibold tabular text-ink">{totalUnits % 1 !== 0 ? totalUnits.toFixed(2) : totalUnits}</p>
          <p className="mt-1 text-sm text-ash">across every order</p>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-line bg-surface py-16 text-center">
          <div className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${config.light}`}>
            <Icon className={`h-8 w-8 ${config.text}`} />
          </div>
          <h3 className="text-lg font-semibold text-graphite">No jobs logged yet</h3>
          <button
            onClick={() => onNavigate('new_order', businessType)}
            className={`mt-2 px-4 py-2 font-bold hover:underline ${config.text}`}
          >
            Create the first job
          </button>
        </div>
      ) : (
        <div className="space-y-10">
          {jobs.length > 3 && (
            <div>
              <label htmlFor="job-search" className="sr-only">Search jobs</label>
              <input
                id="job-search"
                type="search"
                inputMode="search"
                placeholder="Search by name, address or phone"
                className="w-full min-h-12 rounded-xl border border-line bg-surface p-3 text-ink placeholder:text-ash"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
          )}

          <section>
            <h2 className="mb-4 font-display text-xl font-semibold tracking-wide text-graphite">
              Open orders <span className="text-ash">({needle ? `${openShown.length} of ${openJobs.length}` : openJobs.length})</span>
            </h2>
            {openShown.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line p-6 text-center text-ash">
                {needle ? 'No open orders match that search.' : 'Nothing outstanding. Every order has been delivered.'}
              </p>
            ) : (
              <div className="space-y-4">{openShown.map(renderJob)}</div>
            )}
          </section>

          <section>
            <h2 className="mb-4 font-display text-xl font-semibold tracking-wide text-graphite">
              Completed orders <span className="text-ash">({needle ? `${completedShown.length} of ${completedJobs.length}` : completedJobs.length})</span>
            </h2>
            {completedShown.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line p-6 text-center text-ash">
                {needle ? 'No completed orders match that search.' : 'Nothing delivered yet. Tick an open order complete when the work is done.'}
              </p>
            ) : (
              <div className="space-y-4">{completedShown.map(renderJob)}</div>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirming)}
        title={confirmCopy.title}
        body={confirmCopy.body}
        confirmLabel={confirmCopy.confirmLabel}
        tone={confirmCopy.tone}
        onConfirm={confirmAction}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}

function NewJobFormRouter({ businessType, user, onNavigate, existingJob = null, jobs = [] }) {
  const commonProps = {
    user,
    existingJob,
    knownCustomers: customersFrom(jobs),
    onCancel: () => onNavigate('dashboard', businessType),
    onSave: () => onNavigate('dashboard', businessType)
  };

  switch (businessType) {
    case 'firewood': return <FirewoodForm {...commonProps} />;
    case 'hauling': return <HaulingForm {...commonProps} />;
    case 'plumbing': return <TradeForm tradeType="plumbing" {...commonProps} />;
    case 'heating': return <TradeForm tradeType="heating" {...commonProps} />;
    default: return <div>Unknown business type</div>;
  }
}

function FormLayout({ title, theme, onCancel, err, children }) {
  return (
    <div className="max-w-2xl mx-auto pb-24 sm:pb-12 bg-paper min-h-[100svh]">
      <div className={`sticky top-0 z-10 ${theme} text-white px-4 py-4 flex items-center justify-between mb-6 shadow-md pt-[calc(1rem+env(safe-area-inset-top))]`}>
        <button onClick={onCancel} className="flex items-center bg-surface/20 hover:bg-surface/30 px-3 py-1.5 rounded-lg font-bold transition-colors">
          <ArrowLeft className="w-5 h-5 mr-1" /> Cancel
        </button>
        <h2 className="text-xl font-bold">{title}</h2>
        <div className="w-20"></div>
      </div>
      <div className="px-4 space-y-6 pb-6">
        {err && <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-r-lg font-bold shadow-sm">{err}</div>}
        {children}
      </div>
    </div>
  );
}

// --- Location helpers (free + keyless: no API key, no billing) ---

// Reads the device position. Uses the Capacitor plugin on iOS/Android and the
// browser API on the web. Always rejects with a short, user-facing message.
// A phone almost never gives its best fix first: it returns a coarse cell or
// wifi position within a second, then tightens to satellite accuracy over the
// next several seconds. Asking once therefore usually captures the worst fix of
// the session, which is why the pin lands on a town rather than a house. Watch
// the stream instead, keep the tightest fix, and stop as soon as it is good
// enough to name a street number.
const TARGET_ACCURACY_M = 20;    // tight enough for a house number
const STREET_ACCURACY_M = 100;   // beyond this, a house number is a guess
const MAX_FIX_WAIT_MS = 12000;   // never make someone stand there longer

async function readBestFix(onProgress) {
  const report = (coords) => {
    if (onProgress && coords) onProgress(coords);
  };

  if (Capacitor.isNativePlatform()) {
    let perm = await Geolocation.checkPermissions();
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      perm = await Geolocation.requestPermissions({ permissions: ['location'] });
    }
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      throw new Error('Location permission denied. Enable it in Settings and try again.');
    }

    return new Promise((resolve, reject) => {
      let best = null;
      let settled = false;
      let watchId = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watchId) Geolocation.clearWatch({ id: watchId }).catch(() => {});
        if (best) resolve(best);
        else reject(new Error('Could not get a location fix. Try again outdoors, or type the address.'));
      };

      const timer = setTimeout(finish, MAX_FIX_WAIT_MS);

      Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: MAX_FIX_WAIT_MS, maximumAge: 0 },
        (position, err) => {
          if (err || !position) return;
          const coords = position.coords;
          if (!best || coords.accuracy < best.accuracy) best = coords;
          report(best);
          if (best.accuracy <= TARGET_ACCURACY_M) finish();
        }
      ).then(id => {
        watchId = id;
        // The watch can resolve after we have already stopped waiting.
        if (settled) Geolocation.clearWatch({ id }).catch(() => {});
      }).catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Could not start location services. Type the address instead.'));
      });
    });
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('This device cannot share its location. Type the address instead.');
  }

  return new Promise((resolve, reject) => {
    let best = null;
    let settled = false;
    let watchId = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (best) resolve(best);
      else reject(new Error('Could not get a location fix. Try again, or type the address.'));
    };

    const timer = setTimeout(finish, MAX_FIX_WAIT_MS);

    watchId = navigator.geolocation.watchPosition(
      pos => {
        if (!best || pos.coords.accuracy < best.accuracy) best = pos.coords;
        report(best);
        if (best.accuracy <= TARGET_ACCURACY_M) finish();
      },
      e => {
        // Only surface an error when nothing usable arrived at all.
        if (best || settled) return;
        settled = true;
        clearTimeout(timer);
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        reject(new Error(
          e && e.code === 1
            ? 'Location permission denied. Allow it and try again.'
            : 'Could not get your location. Try again or type the address.'
        ));
      },
      { enableHighAccuracy: true, timeout: MAX_FIX_WAIT_MS, maximumAge: 0 }
    );
  });
}

// A watch delivers nothing in a backgrounded tab, and some devices refuse it
// outright. One plain ask, allowing a recently cached fix, is far better than
// filling in nothing. Only used when the watch came back empty.
function readSingleFix() {
  if (Capacitor.isNativePlatform()) {
    return Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })
      .then(pos => pos.coords)
      .catch(() => null);
  }
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

async function readCurrentPosition(onProgress) {
  try {
    return await readBestFix(onProgress);
  } catch (watchError) {
    const fallback = await readSingleFix();
    if (fallback) return fallback;
    // Nothing worked: report the original reason, which names the real cause
    // such as a denied permission.
    throw watchError;
  }
}

// Builds one clean address line: drops blanks and repeats, keeps order.
// Browser fetch has no default timeout, and these three providers run in series.
// Without this, one hung request (not failed - hung) leaves the spinner going
// forever, which is a real risk on a weak connection in the field.
const GEOCODE_TIMEOUT_MS = 8000;

async function fetchGeocodeJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function joinAddressParts(parts) {
  return parts
    .filter(part => typeof part === 'string' && part.trim())
    .map(part => part.trim())
    .filter((part, i, arr) => arr.indexOf(part) === i)
    .join(', ');
}

// OpenStreetMap Nominatim - keyless, and the only one of the three that returns
// a house number + street, which is what makes this an exact address.
async function geocodeNominatim(lat, lng) {
  const data = await fetchGeocodeJson(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1&zoom=18`,
    { headers: { Accept: 'application/json' } }
  );
  if (!data) return "";
  const a = data.address || {};
  const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(' ');
  const town = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb;
  return {
    line: joinAddressParts([
      street, town, a.state, a.postcode,
      a.country_code && a.country_code.toLowerCase() !== 'us' ? a.country : null
    ]),
    hasNumber: Boolean(a.house_number)
  };
}

// Komoot Photon - also OSM street-level data, on a different host. Covers the
// case where Nominatim is rate-limited or unreachable.
async function geocodePhoton(lat, lng) {
  const data = await fetchGeocodeJson(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`);
  if (!data) return "";
  const p = ((data.features || [])[0] || {}).properties || {};
  const street = [p.housenumber, p.street || p.name].filter(Boolean).join(' ');
  return {
    line: joinAddressParts([
      street, p.city || p.district, p.state, p.postcode,
      p.countrycode && p.countrycode.toUpperCase() !== 'US' ? p.country : null
    ]),
    hasNumber: Boolean(p.housenumber)
  };
}

// BigDataCloud - no street data, but a dependable town/state/ZIP last resort.
async function geocodeBigDataCloud(lat, lng) {
  const geo = await fetchGeocodeJson(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
  );
  if (!geo) return "";
  const admin = (geo.localityInfo && geo.localityInfo.administrative) || [];
  // adminLevel 8 is the municipality; the most specific one wins (the top-level
  // `city` field can name the nearest metro instead of the actual town).
  const towns = admin.filter(a => a.adminLevel === 8 && a.name);
  const town = towns.length ? towns[towns.length - 1].name : geo.city;
  return {
    line: joinAddressParts([
      geo.locality, town, geo.principalSubdivision, geo.postcode,
      geo.countryCode && geo.countryCode !== 'US' ? geo.countryName : null
    ]),
    hasNumber: false
  };
}

// Tries each free, keyless provider in order of address precision and returns
// the first usable line. Falls back to raw coordinates so the user always gets
// something they can work with in the field.
async function reverseGeocode(latitude, longitude) {
  // Stop at the first answer carrying a house number, since that is the whole
  // point. Keep the best street-only answer as a fallback rather than letting
  // a later, vaguer provider overwrite it. Measured hit rates: Nominatim
  // returns a house number in town, suburb and most rural roads; Photon covers
  // some gaps; BigDataCloud never does, so it is the last resort.
  let fallback = '';
  for (const provider of [geocodeNominatim, geocodePhoton, geocodeBigDataCloud]) {
    try {
      const result = await provider(latitude, longitude);
      if (!result || !result.line) continue;
      if (result.hasNumber) return result.line;
      if (!fallback) fallback = result.line;
    } catch (e) {
      console.error('Reverse geocode provider failed:', e);
    }
  }
  return fallback || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

// Every trade can be booked ahead, not just firewood. A job with a future date
// stays in Open orders until it is ticked complete, so this section is what
// makes the open/completed split work across all four business lines.
function ScheduledDateSection({ label, value, onChange }) {
  return (
    <section className="bg-surface p-6 rounded-2xl shadow-sm border border-line">
      <h3 className="font-bold text-lg mb-4 flex items-center gap-2 border-b pb-2">
        <CalendarIcon className="text-ash" /> {label}
      </h3>
      <label className="block text-sm font-bold text-graphite mb-1">{label} date</label>
      <input
        type="date"
        className="w-full p-3 bg-paper border border-line rounded-xl min-h-12"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <p className="mt-2 text-sm text-ash">
        Leave blank if the work is already done. A future date keeps this in Open orders.
      </p>
    </section>
  );
}

function ConfirmDialog({ open, title, body, confirmLabel, tone, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-xl"
        onClick={event => event.stopPropagation()}
      >
        <h3 className="font-display text-xl font-semibold tracking-wide text-ink">{title}</h3>
        <p className="mt-2 text-graphite">{body}</p>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-12 flex-1 rounded-xl border border-line font-bold text-graphite transition-colors hover:bg-paper"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`min-h-12 flex-1 rounded-xl font-bold text-white transition-colors ${tone === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-ink hover:bg-graphite'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Icons rather than emoji: emoji render differently on every platform and look
// like clip art next to the rest of the interface.
// Cords are the only unit this trade sells in, so the size is the amount:
// there is no separate quantity to multiply by. A half cord order is 0.5, and
// the trade board adds those fractions up (1/2 + 1/4 + 1 = 1.75 cords).
// Reformat from the digits on every keystroke rather than inserting dashes in
// place. That way backspacing over a dash behaves the way people expect, and
// pasting a number in any format still lands correctly.
const formatPhone = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  // A pasted number often carries the US country code. Drop it, or every digit
  // shifts one place left and 555-123-4567 becomes 155-512-3456.
  if (digits.length > 10 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
};

const CORD_SIZES = { 'Full Cord': 1, '3/4 Cord': 0.75, '1/2 Cord': 0.5, '1/4 Cord': 0.25 };

const cordsFor = (size, custom) =>
  size === 'Other' ? (parseFloat(custom) || 0) : (CORD_SIZES[size] || 0);

const SUMMARY_ICONS = { firewood: Flame, hauling: Truck, plumbing: Wrench, heating: Thermometer };

const plural = (count, one, many) => `${count} ${Number(count) === 1 ? one : many}`;

function JobSummaryLine({ businessType, job }) {
  const SummaryIcon = SUMMARY_ICONS[businessType];
  const text = {
    firewood: `${plural(job.woodQuantity, 'cord', 'cords')}, ${job.isStacked ? 'stacked' : 'not stacked'}${job.deliveryDate ? `, due ${job.deliveryDate}` : ''}`,
    hauling: `${job.loadSize} load, dump $${job.dumpFee}${job.deliveryDate ? `, due ${job.deliveryDate}` : ''}`,
    plumbing: `${job.diagnosis}, ${plural(job.laborHours, 'hr', 'hrs')}${job.deliveryDate ? `, due ${job.deliveryDate}` : ''}`,
    heating: `${job.systemType}, ${plural(job.laborHours, 'hr', 'hrs')}${job.deliveryDate ? `, due ${job.deliveryDate}` : ''}`
  }[businessType];
  if (!SummaryIcon || !text) return null;
  return (
    <p className="mt-2 inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-sm font-medium text-graphite">
      <SummaryIcon className="h-4 w-4 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

// Repeat customers are the norm in this trade. The details are already in the
// job list, so there is no reason to retype them. Jobs arrive newest first, so
// the first match is the most recent version of their details.
const downloadCsv = async (jobs, filename) => {
  // Excel assumes the system encoding without a byte order mark and mangles
  // anything non-ascii in a customer name.
  const csv = '\uFEFF' + buildCsv(jobs);

  if (Capacitor.isNativePlatform()) {
    // A WebView cannot trigger a file download, so hand the text to the share
    // sheet instead: mail it, save it to Files, send it to a spreadsheet app.
    await Share.share({ title: filename, text: csv, dialogTitle: 'Export jobs as CSV' });
    return;
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function ExportButton({ jobs, filename, label = 'Export CSV' }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!jobs.length) return null;

  const run = async () => {
    setBusy(true);
    setErr('');
    try {
      await downloadCsv(jobs, filename);
    } catch (e) {
      // Dismissing the native share sheet is not a failure.
      if (!(e && /abort|cancel/i.test(String(e.message || e)))) {
        console.error('CSV export failed:', e);
        setErr('Could not export. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-bold text-graphite transition-colors hover:bg-paper disabled:opacity-50"
      >
        <Download className="h-4 w-4" />
        <span>{busy ? 'Exporting...' : label}</span>
      </button>
      {err && <p className="mt-1 text-sm font-bold text-red-600">{err}</p>}
    </div>
  );
}

const customersFrom = (jobs = []) => {
  const seen = new Map();
  for (const job of jobs) {
    const name = (job.customerName || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, { name, address: job.customerAddress || '', phone: job.customerPhone || '' });
    }
  }
  return [...seen.values()];
};

function CustomerSection({ data, setData, knownCustomers = [] }) {
  const [locating, setLocating] = useState(false);
  const [locErr, setLocErr] = useState("");
  const [locNote, setLocNote] = useState("");
  const [fixAccuracy, setFixAccuracy] = useState(null);

  const useMyLocation = async () => {
    setLocating(true);
    setLocErr("");
    setLocNote("");
    setFixAccuracy(null);
    try {
      const coords = await readCurrentPosition(live => setFixAccuracy(live.accuracy));
      const address = await reverseGeocode(coords.latitude, coords.longitude);
      setData(prev => ({ ...prev, customerAddress: address }));
      const metres = Math.round(coords.accuracy);
      // Say how good the fix was. A coarse one still fills the field, but the
      // user needs to know the street number is a guess rather than a fact.
      setLocNote(
        coords.accuracy > STREET_ACCURACY_M
          ? `Approximate only, accurate to about ${metres} m. Check the street and number before saving.`
          : `Located to about ${metres} m.`
      );
    } catch (e) {
      console.error('Location lookup failed:', e);
      setLocErr((e && e.message) || 'Could not get your location.');
    } finally {
      setLocating(false);
    }
  };

  return (
    <section className="bg-surface p-6 rounded-2xl shadow-sm border border-line">
      <h3 className="font-bold text-lg mb-4 flex items-center gap-2 border-b pb-2"><UserIcon className="text-ash"/> Customer Info</h3>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-bold text-graphite mb-1">Name *</label>
          <input
            type="text"
            list="known-customers"
            autoComplete="off"
            className="w-full p-3 bg-paper border border-line rounded-xl min-h-12"
            value={data.customerName}
            onChange={e => {
              const name = e.target.value;
              const match = knownCustomers.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
              // Only fill blanks, so picking a name never overwrites something
              // already typed for this job.
              setData(prev => ({
                ...prev,
                customerName: name,
                customerAddress: match && !prev.customerAddress ? match.address : prev.customerAddress,
                customerPhone: match && !prev.customerPhone ? match.phone : prev.customerPhone
              }));
            }}
          />
          {knownCustomers.length > 0 && (
            <datalist id="known-customers">
              {knownCustomers.map(c => <option key={c.name} value={c.name} />)}
            </datalist>
          )}
        </div>
        <div>
          <label className="block text-sm font-bold text-graphite mb-1">Address *</label>
          <div className="flex items-stretch gap-2">
            <div className="flex-1 min-w-0">
              <input type="text" className="w-full p-3 bg-paper border border-line rounded-xl min-h-12" value={data.customerAddress} onChange={e => setData({...data, customerAddress: e.target.value})} />
            </div>
            <button
              type="button" onClick={useMyLocation} disabled={locating}
              title="Use my current location" aria-label="Use my current location"
              className={`shrink-0 flex items-center justify-center min-h-12 min-w-12 px-3 rounded-xl border border-line bg-paper text-graphite font-bold transition-colors ${locating ? 'opacity-50' : 'hover:bg-line active:bg-line'}`}
            >
              {locating
                ? <span className="w-5 h-5 rounded-full border-2 border-ash border-t-transparent animate-spin" />
                : <MapPin className="w-5 h-5" />}
            </button>
          </div>
          {locating && (
            <p className="mt-1 text-sm font-bold text-ash">
              {fixAccuracy
                ? `Sharpening the fix, within ${Math.round(fixAccuracy)} m...`
                : 'Getting your location...'}
            </p>
          )}
          {!locating && locNote && (
            <p className={`mt-1 text-sm font-bold ${fixAccuracy > STREET_ACCURACY_M ? 'text-ember' : 'text-ash'}`}>
              {locNote}
            </p>
          )}
          {locErr && <p className="mt-1 text-sm font-bold text-red-600">{locErr}</p>}
        </div>
        <div>
          <label className="block text-sm font-bold text-graphite mb-1">Phone</label>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="555-123-4567"
            className="w-full p-3 bg-paper border border-line rounded-xl min-h-12"
            value={data.customerPhone}
            onChange={e => setData({ ...data, customerPhone: formatPhone(e.target.value) })}
          />
        </div>
      </div>
    </section>
  );
}

function SummarySection({ total, saving, onSave, btnTheme, isEdit }) {
  return (
    <section className="bg-panel text-on-panel p-6 rounded-3xl shadow-xl mt-8">
      <div className="flex items-center justify-between mb-6">
        <span className="text-lg font-bold text-on-panel/60">Total price</span>
        <span className="font-display text-5xl font-semibold tabular text-hazard">${total.toFixed(2)}</span>
      </div>
      <button
        onClick={onSave} disabled={saving}
        className={`w-full flex items-center justify-center py-4 rounded-2xl font-bold text-lg transition-all shadow-lg ${saving ? 'opacity-50' : btnTheme}`}
      >
        {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Confirm and save job'}
      </button>
    </section>
  );
}

function FirewoodForm({ user, onCancel, onSave, existingJob = null, knownCustomers = [] }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState(() => seedForm({
    customerName: "", customerAddress: "", customerPhone: "",
    woodQuantity: "1", woodSize: "Full Cord", customWoodSize: "", woodPrice: "300",
    isStacked: true, stackingPrice: "50",
    deliveryDate: "", notes: ""
  }, existingJob));

  const cords = cordsFor(data.woodSize, data.customWoodSize);

  useEffect(() => {
    setData(prev => ({ ...prev, stackingPrice: (cords * 50).toString() }));
  }, [cords]);

  // The price is whatever is typed, for whatever amount was picked. It is not a
  // rate: a half cord can be priced at anything the customer agreed to.
  const woodPrice = parseFloat(data.woodPrice) || 0;
  const logisticsPrice = data.isStacked ? (parseFloat(data.stackingPrice) || 0) : 0;
  const totalPrice = woodPrice + logisticsPrice;

  const handleSubmit = async () => {
    if (!data.customerName || !data.customerAddress) return setErr("Name and Address required.");
    setSaving(true);
    try {
      const payload = {
        ...data, businessType: 'firewood',
        woodQuantity: cords, woodPrice,
        stackingPrice: data.isStacked ? parseFloat(data.stackingPrice) : 0,
        totalPrice, createdAt: Date.now()
      };
      const saved = await submitJob(payload, user.uid, existingJob);
      if (saved) {
        onSave();
      }
    } catch (e) { console.error('Save failed:', e); setErr(describeSaveError(e)); setSaving(false); }
  };

  return (
    <FormLayout title={existingJob ? "Edit Firewood Order" : "New Firewood Order"} theme="bg-timber" onCancel={onCancel} err={err}>
      <CustomerSection data={data} setData={setData} knownCustomers={knownCustomers} />
      
      <section className="bg-surface p-6 rounded-2xl shadow-sm border border-line">
        <h3 className="font-bold text-lg mb-4 flex items-center gap-2 border-b pb-2"><Flame className="text-timber"/> Wood Details</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-sm font-bold text-graphite mb-1">Amount</label>
            <select
              className="w-full p-3 bg-surface border border-line rounded-xl min-h-12"
              value={data.woodSize}
              onChange={e => setData({ ...data, woodSize: e.target.value })}
            >
              <option>Full Cord</option>
              <option>3/4 Cord</option>
              <option>1/2 Cord</option>
              <option>1/4 Cord</option>
              <option>Other</option>
            </select>
          </div>
          {data.woodSize === 'Other' && (
            <div className="col-span-2">
              <label className="block text-sm font-bold text-graphite mb-1">How many cords</label>
              <input
                type="number"
                step="0.25"
                min="0"
                placeholder="e.g. 1.5"
                className="w-full p-3 bg-paper border border-line rounded-xl min-h-12"
                value={data.customWoodSize}
                onChange={e => setData({ ...data, customWoodSize: e.target.value })}
              />
            </div>
          )}
          <div className="col-span-2">
            <label className="block text-sm font-bold text-graphite mb-1">Wood price</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ash font-bold">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                className="w-full pl-8 p-3 bg-paper border border-line rounded-xl font-bold text-graphite min-h-12"
                value={data.woodPrice}
                onChange={e => setData({ ...data, woodPrice: e.target.value })}
              />
            </div>
            <p className="mt-1 text-sm text-ash">
              What you are charging for the wood itself, for the amount above. Stacking is added separately.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-surface p-6 rounded-2xl shadow-sm border border-line">
        <h3 className="font-bold text-lg mb-4 flex items-center gap-2 border-b pb-2"><Layers className="text-ash"/> Stacking</h3>
        <div className="flex gap-4 mb-4">
          <label className={`flex-1 p-4 border-2 rounded-xl cursor-pointer text-center font-bold ${data.isStacked ? 'border-timber bg-timber/8 text-timber' : 'border-line text-ash'}`}>
            <input type="radio" className="hidden" checked={data.isStacked} onChange={() => setData({...data, isStacked: true})} /> Stacked
          </label>
          <label className={`flex-1 p-4 border-2 rounded-xl cursor-pointer text-center font-bold ${!data.isStacked ? 'border-timber bg-timber/8 text-timber' : 'border-line text-ash'}`}>
            <input type="radio" className="hidden" checked={!data.isStacked} onChange={() => setData({...data, isStacked: false})} /> Not Stacked
          </label>
        </div>
        {data.isStacked ? (
          <div>
            <label className="block text-sm font-bold text-graphite mb-1">Stacking Fee (Auto-calc $50/cord)</label>
            <div className="relative">
               <span className="absolute left-4 top-1/2 -translate-y-1/2 text-ash font-bold">$</span>
               <input type="number" className="w-full pl-8 p-3 bg-surface border border-line rounded-xl min-h-12" value={data.stackingPrice} onChange={e => setData({...data, stackingPrice: e.target.value})} />
            </div>
          </div>
        ) : (
          <p className="text-sm font-medium text-ash">No stacking fee applied.</p>
        )}
      </section>

      <ScheduledDateSection
        label="Scheduled delivery"
        value={data.deliveryDate}
        onChange={v => setData({ ...data, deliveryDate: v })}
      />

      <SummarySection total={totalPrice} saving={saving} onSave={handleSubmit} isEdit={Boolean(existingJob)} btnTheme="bg-timber hover:bg-ember text-white" />
    </FormLayout>
  );
}

function HaulingForm({ user, onCancel, onSave, existingJob = null, knownCustomers = [] }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState(() => seedForm({
    customerName: "", customerAddress: "", customerPhone: "",
    loadSize: "Full Trailer", basePrice: "250", dumpFee: "75",
    deliveryDate: "", notes: ""
  }, existingJob));

  const totalPrice = (parseFloat(data.basePrice) || 0) + (parseFloat(data.dumpFee) || 0);

  const handleSubmit = async () => {
    if (!data.customerName || !data.customerAddress) return setErr("Name and Address required.");
    setSaving(true);
    try {
      const payload = {
        ...data, businessType: 'hauling',
        basePrice: parseFloat(data.basePrice), dumpFee: parseFloat(data.dumpFee),
        totalPrice, createdAt: Date.now()
      };
      const saved = await submitJob(payload, user.uid, existingJob);
      if (saved) {
        onSave();
      }
    } catch (e) { console.error('Save failed:', e); setErr(describeSaveError(e)); setSaving(false); }
  };

  return (
    <FormLayout title={existingJob ? "Edit Hauling Job" : "New Hauling Job"} theme="bg-haul" onCancel={onCancel} err={err}>
      <CustomerSection data={data} setData={setData} knownCustomers={knownCustomers} />
      
      <section className="bg-surface p-6 rounded-2xl shadow-sm border border-line">
        <h3 className="font-bold text-lg mb-4 flex items-center gap-2 border-b pb-2"><Trash2 className="text-haul"/> Haul Details</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-graphite mb-1">Load Size</label>
            <select className="w-full p-3 bg-surface border border-line rounded-xl min-h-12" value={data.loadSize} onChange={e => setData({...data, loadSize: e.target.value})}>
              <option>Single Item</option><option>1/4 Trailer</option><option>1/2 Trailer</option><option>Full Trailer</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-graphite mb-1">Base Rate / Labor</label>
              <input type="number" className="w-full p-3 bg-paper border border-line rounded-xl min-h-12" value={data.basePrice} onChange={e => setData({...data, basePrice: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-bold text-graphite mb-1">Dump/Recycling Fees</label>
              <input type="number" className="w-full p-3 bg-paper border border-line rounded-xl text-red-700 font-bold min-h-12" value={data.dumpFee} onChange={e => setData({...data, dumpFee: e.target.value})} />
            </div>
          </div>
        </div>
      </section>

      <ScheduledDateSection
        label="Scheduled pickup"
        value={data.deliveryDate}
        onChange={v => setData({ ...data, deliveryDate: v })}
      />

      <SummarySection total={totalPrice} saving={saving} onSave={handleSubmit} isEdit={Boolean(existingJob)} btnTheme="bg-haul hover:bg-haul/90 text-white" />
    </FormLayout>
  );
}

function TradeForm({ tradeType, user, onCancel, onSave, existingJob = null, knownCustomers = [] }) {
  const isPlumbing = tradeType === 'plumbing';
  const themeColors = {
    bg: isPlumbing ? 'bg-flow' : 'bg-hvac',
    text: isPlumbing ? 'text-flow' : 'text-hvac',
    btn: isPlumbing ? 'bg-flow hover:bg-flow/90 text-white' : 'bg-hvac hover:bg-hvac/90 text-white',
    title: isPlumbing ? 'New Plumbing Job' : 'New HVAC Job',
    Icon: isPlumbing ? Wrench : Thermometer
  };

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState(() => seedForm({
    customerName: "", customerAddress: "", customerPhone: "",
    systemType: isPlumbing ? "Piping/Fixtures" : "Furnace",
    diagnosis: "", partsCost: "0", laborHours: "1", hourlyRate: "120",
    deliveryDate: "", notes: ""
  }, existingJob));

  const totalParts = parseFloat(data.partsCost) || 0;
  const totalLabor = (parseFloat(data.laborHours) || 0) * (parseFloat(data.hourlyRate) || 0);
  const totalPrice = totalParts + totalLabor;

  const handleSubmit = async () => {
    if (!data.customerName || !data.customerAddress) return setErr("Name and Address required.");
    setSaving(true);
    try {
      const payload = {
        ...data, businessType: tradeType,
        partsCost: totalParts, laborHours: parseFloat(data.laborHours), hourlyRate: parseFloat(data.hourlyRate),
        totalPrice, createdAt: Date.now()
      };
      const saved = await submitJob(payload, user.uid, existingJob);
      if (saved) {
        onSave();
      }
    } catch (e) { console.error('Save failed:', e); setErr(describeSaveError(e)); setSaving(false); }
  };

  return (
    <FormLayout title={existingJob ? `Edit ${themeColors.title.replace("New ", "")}` : themeColors.title} theme={themeColors.bg} onCancel={onCancel} err={err}>
      <CustomerSection data={data} setData={setData} knownCustomers={knownCustomers} />
      
      <section className="bg-surface p-6 rounded-2xl shadow-sm border border-line">
        <h3 className="font-bold text-lg mb-4 flex items-center gap-2 border-b pb-2"><themeColors.Icon className={themeColors.text}/> Service Details</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-graphite mb-1">System / Area</label>
            <input type="text" placeholder={isPlumbing ? "e.g. Kitchen Sink" : "e.g. Rheem Heat Pump"} className="w-full p-3 bg-paper border border-line rounded-xl min-h-12" value={data.systemType} onChange={e => setData({...data, systemType: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm font-bold text-graphite mb-1">Issue / Work Performed</label>
            <textarea rows="2" className="w-full p-3 bg-paper border border-line rounded-xl min-h-24" value={data.diagnosis} onChange={e => setData({...data, diagnosis: e.target.value})} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t pt-4">
            <div>
              <label className="block text-sm font-bold text-graphite mb-1">Parts Cost</label>
              <input type="number" className="w-full p-3 bg-paper border border-line rounded-xl min-h-12" value={data.partsCost} onChange={e => setData({...data, partsCost: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-bold text-graphite mb-1">Labor (Hours)</label>
              <input type="number" step="0.5" className="w-full p-3 bg-paper border border-line rounded-xl min-h-12" value={data.laborHours} onChange={e => setData({...data, laborHours: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-bold text-graphite mb-1">Hourly Rate</label>
              <input type="number" className="w-full p-3 bg-paper border border-line rounded-xl font-bold min-h-12" value={data.hourlyRate} onChange={e => setData({...data, hourlyRate: e.target.value})} />
            </div>
          </div>
        </div>
      </section>

      <ScheduledDateSection
        label="Scheduled service"
        value={data.deliveryDate}
        onChange={v => setData({ ...data, deliveryDate: v })}
      />

      <SummarySection total={totalPrice} saving={saving} onSave={handleSubmit} isEdit={Boolean(existingJob)} btnTheme={themeColors.btn} />
    </FormLayout>
  );
}

function UniversalInvoiceView({ job, onClose }) {
  const isFirewood = job.businessType === 'firewood';
  const isHauling = job.businessType === 'hauling';
  const isTrade = job.businessType === 'plumbing' || job.businessType === 'heating';

  const config = {
    firewood: { title: 'HS Timber', color: 'text-timber', Icon: Flame },
    hauling: { title: 'HS Haul', color: 'text-haul', Icon: Truck },
    plumbing: { title: 'HS Flow Plumbing', color: 'text-flow', Icon: Wrench },
    heating: { title: 'HS HVAC Services', color: 'text-hvac', Icon: Thermometer },
  }[job.businessType] || { title: 'Invoice', color: 'text-ink', Icon: Briefcase };

  const TheIcon = config.Icon;

  const money = n => `$${(Number(n) || 0).toFixed(2)}`;

  // Plain-text twin of the invoice table, so a shared invoice carries the same
  // detail the printed one does instead of just a name and a total.
  const buildInvoiceText = () => {
    const items = [];
    if (isFirewood) {
      items.push(`Firewood (${job.woodSize}) - ${plural(job.woodQuantity, 'cord', 'cords')} - ${money(firewoodCharge)}`);
      if (job.isStacked) items.push(`Stacking service - ${money(job.stackingPrice)}`);
    } else if (isHauling) {
      items.push(`Hauling labor & transport (${job.loadSize}) - ${money(job.basePrice)}`);
      items.push(`Municipal dump / recycling fees - ${money(job.dumpFee)}`);
    } else if (isTrade) {
      items.push(`Service diagnosis & repair (${job.systemType}${job.diagnosis ? ` - ${job.diagnosis}` : ''}) - ${job.laborHours} hrs @ ${money(job.hourlyRate)}/hr - ${money((job.laborHours || 0) * (job.hourlyRate || 0))}`);
      items.push(`Parts & materials - ${money(job.partsCost)}`);
    }
    return [
      `${config.title} - INVOICE`,
      job.invoiceNumber ? `Invoice No. ${String(job.invoiceNumber).padStart(4, '0')}` : null,
      `Date: ${new Date(job.createdAt).toLocaleDateString()}`,
      '',
      'BILL TO',
      job.customerName,
      job.customerAddress,
      job.customerPhone || null,
      '',
      'ITEMS',
      ...items.map(line => `- ${line}`),
      '',
      ...(taxRate > 0
        ? [`Subtotal: ${money(subtotal)}`, `Tax (${(taxRate * 100).toFixed(2)}%): ${money(taxAmount)}`]
        : []),
      `TOTAL DUE: ${money(grandTotal)}`,
      job.notes ? `\nNotes: ${job.notes}` : null,
      '',
      'Thank you for your business! Powered by HustleSync.'
    ].filter(line => line !== null && line !== undefined).join('\n');
  };

  const toast = message => {
    const popup = document.createElement('div');
    popup.innerText = message;
    Object.assign(popup.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      backgroundColor: '#1c1917', color: 'white', padding: '12px 24px',
      borderRadius: '8px', zIndex: '9999', fontWeight: 'bold'
    });
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 3000);
  };

  // Tax is stored per job as a rate, so an old invoice keeps the rate that was
  // in force when it was raised rather than silently re-pricing itself.
  // Rows saved before the flat price change stored a per cord rate instead.
  const firewoodCharge = job.woodPrice != null
    ? Number(job.woodPrice)
    : (Number(job.woodQuantity) || 0) * (Number(job.pricePerCord) || 0);

  const subtotal = job.totalPrice || 0;
  const taxRate = Number(job.taxRate) || 0;
  const taxAmount = subtotal * taxRate;
  const grandTotal = subtotal + taxAmount;

  const handleShare = async () => {
    const text = buildInvoiceText();
    const title = `Invoice - ${config.title}`;
    try {
      // navigator.share does not exist in the Android WebView, so native goes
      // through the Capacitor plugin and only the web falls back to the DOM API.
      if (Capacitor.isNativePlatform()) {
        await Share.share({ title, text, dialogTitle: title });
        return;
      }
      if (navigator.share) {
        await navigator.share({ title, text });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast('Invoice copied to clipboard!');
    } catch (err) {
      if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) return;
      console.error('Share failed', err);
      try {
        await navigator.clipboard.writeText(text);
        toast('Invoice copied to clipboard!');
      } catch (copyErr) {
        console.error('Clipboard fallback failed', copyErr);
        toast('Could not share the invoice.');
      }
    }
  };

  return (
    <div className="min-h-[100svh] bg-paper p-4 sm:p-12 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">
      <div className="max-w-2xl mx-auto print:w-full print:max-w-none print:p-0">
        <div className="flex flex-col sm:flex-row justify-between items-center mb-6 gap-4 print:hidden">
          <button onClick={onClose} className="w-full sm:w-auto flex justify-center items-center text-graphite bg-surface border border-line px-4 py-2 rounded-lg font-bold transition-colors hover:bg-paper">
            <ArrowLeft className="w-5 h-5 mr-1" /> Back
          </button>
          <div className="flex w-full sm:w-auto gap-2">
             <button onClick={handleShare} className="flex-1 sm:flex-none flex justify-center items-center gap-2 bg-blue-100 text-blue-700 hover:bg-blue-200 px-5 py-2 rounded-lg font-bold transition-colors">
                <Share2 className="w-5 h-5" /> Share
             </button>
             <button onClick={() => window.print()} className="flex-1 sm:flex-none flex justify-center items-center gap-2 bg-panel text-white hover:bg-panel px-5 py-2 rounded-lg font-bold transition-colors">
                <Printer className="w-5 h-5" /> Print
             </button>
          </div>
        </div>

        <div id="printable-invoice" className="bg-surface border border-line rounded-3xl p-8 shadow-lg print:border-none print:shadow-none print:p-0">
          <div className="flex justify-between items-start mb-10 border-b-2 border-line pb-8">
            <div>
              <h1 className={`text-3xl font-bold flex items-center gap-2 ${config.color}`}>
                <TheIcon className="w-8 h-8" fill={isFirewood ? "currentColor" : "none"} /> {config.title}
              </h1>
              <p className="text-ash mt-1 font-medium text-sm tracking-wide">Professional Service Invoice</p>
            </div>
            <div className="text-right">
              <h2 className="text-2xl font-bold text-ash uppercase tracking-widest">INVOICE</h2>
              {job.invoiceNumber && (
                <p className="font-display text-xl font-semibold tabular text-ink">
                  No. {String(job.invoiceNumber).padStart(4, '0')}
                </p>
              )}
              <p className="text-ash font-medium mt-1">Date: {new Date(job.createdAt).toLocaleDateString()}</p>
            </div>
          </div>

          <div className="mb-10 bg-paper p-6 rounded-2xl border border-line">
            <h3 className="text-xs font-bold text-ash uppercase tracking-widest mb-3">Bill To</h3>
            <p className="text-xl font-bold text-ink">{job.customerName}</p>
            <p className="text-graphite font-medium">{job.customerAddress}</p>
            {job.customerPhone && <p className="text-graphite font-medium">{job.customerPhone}</p>}
          </div>

          <div className="mb-10 overflow-x-auto">
            <table className="w-full text-left min-w-[500px]">
              <thead>
                <tr className="text-ash text-xs uppercase tracking-widest border-b-2 border-line">
                  <th className="pb-4 font-bold">Description</th>
                  <th className="pb-4 font-bold text-center">Qty / Details</th>
                  <th className="pb-4 font-bold text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="text-ink font-medium text-lg">
                
                {isFirewood && (
                  <>
                    <tr className="border-b border-line">
                      <td className="py-5">Firewood<br/><span className="text-sm text-ash">{job.woodSize}</span></td>
                      <td className="py-5 text-center">{job.woodQuantity} cords</td>
                      <td className="py-5 text-right">${firewoodCharge.toFixed(2)}</td>
                    </tr>
                    {job.isStacked && (
                      <tr className="border-b border-line">
                        <td className="py-5">Stacking Service</td>
                        <td className="py-5 text-center">1</td>
                        <td className="py-5 text-right">${(job.stackingPrice || 0).toFixed(2)}</td>
                      </tr>
                    )}
                  </>
                )}

                {isHauling && (
                  <>
                    <tr className="border-b border-line">
                      <td className="py-5">Hauling Labor & Transport<br/><span className="text-sm text-ash">{job.loadSize}</span></td>
                      <td className="py-5 text-center">1</td>
                      <td className="py-5 text-right">${(job.basePrice || 0).toFixed(2)}</td>
                    </tr>
                    <tr className="border-b border-line">
                      <td className="py-5">Municipal Dump / Recycling Fees</td>
                      <td className="py-5 text-center">At Cost</td>
                      <td className="py-5 text-right">${(job.dumpFee || 0).toFixed(2)}</td>
                    </tr>
                  </>
                )}

                {isTrade && (
                  <>
                    <tr className="border-b border-line">
                      <td className="py-5">Service Diagnosis & Repair<br/><span className="text-sm text-ash">{job.systemType} - {job.diagnosis}</span></td>
                      <td className="py-5 text-center">{job.laborHours} hrs @ ${job.hourlyRate}/hr</td>
                      <td className="py-5 text-right">${(job.laborHours * job.hourlyRate).toFixed(2)}</td>
                    </tr>
                    <tr className="border-b border-line">
                      <td className="py-5">Parts & Materials</td>
                      <td className="py-5 text-center">-</td>
                      <td className="py-5 text-right">${(job.partsCost || 0).toFixed(2)}</td>
                    </tr>
                  </>
                )}

              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <div className="w-full sm:w-80 bg-panel text-white p-6 rounded-2xl">
              {taxRate > 0 && (
                <>
                  <div className="flex justify-between items-center mb-2 text-on-panel/70">
                    <span className="font-medium">Subtotal</span>
                    <span className="font-display text-lg font-semibold tabular">${subtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center mb-3 border-b border-white/15 pb-3 text-on-panel/70">
                    <span className="font-medium">Tax ({(taxRate * 100).toFixed(2)}%)</span>
                    <span className="font-display text-lg font-semibold tabular">${taxAmount.toFixed(2)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between items-center mb-2">
                <span className="text-ash font-bold uppercase tracking-wider text-xs">Total Due</span>
                <span className="font-display text-4xl font-semibold tabular text-hazard">${grandTotal.toFixed(2)}</span>
              </div>
            </div>
          </div>
          
          <div className="mt-12 text-center text-sm font-bold text-ash">
            Thank you for your business! Powered by HustleSync.
          </div>
        </div>
      </div>
    </div>
  );
}