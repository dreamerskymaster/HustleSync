import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, onSnapshot } from 'firebase/firestore';
import { Flame, Truck, Droplet, Thermometer, ArrowLeft, Printer, Share, PlusCircle, LayoutDashboard } from 'lucide-react';

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export default function App() {
  const [user, setUser] = useState(null);
  const [activeApp, setActiveApp] = useState('dashboard'); // 'dashboard', 'firewood', 'hauling', 'plumbing', 'hvac'
  const [jobs, setJobs] = useState([]);

  // Auth & Data Fetching
  useEffect(() => {
    signInAnonymously(auth).catch(console.error);
    const unsubscribeAuth = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsubscribeAuth();
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "jobs"), orderBy("createdAt", "desc"));
    const unsubscribeDb = onSnapshot(q, (snapshot) => {
      setJobs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    });
    return () => unsubscribeDb();
  }, [user]);

  if (!user) return <div className="min-h-screen flex items-center justify-center bg-gray-100">Loading HustleSync...</div>;

  // Render Logic
  return (
    <div className="min-h-screen bg-gray-100 pb-12">
      {/* Navbar */}
      <nav className="bg-gray-900 text-white p-4 shadow-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setActiveApp('dashboard')}>
            <LayoutDashboard size={24} className="text-blue-400" />
            <h1 className="text-xl font-bold tracking-wider">HustleSync</h1>
          </div>
          <span className="text-xs bg-gray-800 px-3 py-1 rounded-full text-gray-300">User ID: {user.uid.slice(0, 6)}</span>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto mt-6 px-4">
        {activeApp === 'dashboard' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
             {/* Portal Cards */}
            <div onClick={() => setActiveApp('firewood')} className="bg-amber-50 border-2 border-amber-600 rounded-xl p-6 cursor-pointer hover:shadow-lg transition">
              <Flame size={40} className="text-amber-600 mb-2" />
              <h2 className="text-2xl font-bold text-amber-900">Timber & Firewood</h2>
              <p className="text-amber-700 mt-1">Cords, stacking, & delivery tracking.</p>
            </div>
            <div onClick={() => setActiveApp('hauling')} className="bg-slate-50 border-2 border-slate-600 rounded-xl p-6 cursor-pointer hover:shadow-lg transition">
              <Truck size={40} className="text-slate-600 mb-2" />
              <h2 className="text-2xl font-bold text-slate-900">Trash & Hauling</h2>
              <p className="text-slate-700 mt-1">Trailer cleanouts & dump fees.</p>
            </div>
            <div onClick={() => setActiveApp('plumbing')} className="bg-blue-50 border-2 border-blue-600 rounded-xl p-6 cursor-pointer hover:shadow-lg transition">
              <Droplet size={40} className="text-blue-600 mb-2" />
              <h2 className="text-2xl font-bold text-blue-900">Plumbing Services</h2>
              <p className="text-blue-700 mt-1">Pipe repairs, parts, & hourly labor.</p>
            </div>
            <div onClick={() => setActiveApp('hvac')} className="bg-rose-50 border-2 border-rose-600 rounded-xl p-6 cursor-pointer hover:shadow-lg transition">
              <Thermometer size={40} className="text-rose-600 mb-2" />
              <h2 className="text-2xl font-bold text-rose-900">Heating & HVAC</h2>
              <p className="text-rose-700 mt-1">System diagnosis & maintenance.</p>
            </div>
          </div>
        )}

        {/* You and your agent can expand these to contain the forms we generated earlier! */}
        {activeApp !== 'dashboard' && (
          <div>
            <button onClick={() => setActiveApp('dashboard')} className="flex items-center gap-2 text-gray-600 mb-6 hover:text-black">
              <ArrowLeft size={20} /> Back to Dashboard
            </button>
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
               <h2 className="text-2xl font-bold mb-4">
                 {activeApp === 'firewood' ? 'New Firewood Order' : 
                  activeApp === 'hauling' ? 'New Hauling Job' : 
                  activeApp === 'plumbing' ? 'New Plumbing Invoice' : 'New HVAC Service'}
               </h2>
               <p className="text-gray-500 mb-4">Form implementation goes here... (Instruct your agent to populate the forms based on the previous app version).</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}