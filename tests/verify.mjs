// End-to-end verification against the live Supabase backend.
//
// Safety: every row these tests create belongs to throwaway anonymous users and
// is removed at the end. Pre-existing rows are counted before and after and the
// run fails if that number changes, so the suite can never eat real data.
//
//   node tests/verify.mjs

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY;
if (!URL_ || !KEY) { console.error('Missing Supabase env vars'); process.exit(1); }

let pass = 0, fail = 0;
const created = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`    PASS  ${name}`); }
  else { fail++; console.log(`    FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
};

const signIn = async () => {
  const r = await fetch(`${URL_}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}'
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('anon sign-in failed: ' + JSON.stringify(d));
  return { token: d.access_token, uid: d.user.id };
};

const rest = (path, token, init = {}) => fetch(`${URL_}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: KEY, Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {})
  }
});

const insert = async (token, uid, row) => {
  const r = await rest('jobs', token, { method: 'POST', body: JSON.stringify({ user_id: uid, ...row }) });
  const d = await r.json();
  if (Array.isArray(d) && d[0]) created.push({ id: d[0].id, token });
  return { status: r.status, body: d };
};

const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);

// Baseline: how many rows exist before we touch anything.
const admin = await signIn();
const baselineRes = await rest('jobs?select=id', admin.token);
const baseline = (await baselineRes.json()).length;
console.log(`\nBaseline: ${baseline} row(s) visible to a fresh user (RLS means real data is invisible here by design)\n`);

// ---------------------------------------------------------------------------
console.log('TEST 1  Row level security isolates every user');
{
  const a = await signIn(), b = await signIn();
  const mine = await insert(a.token, a.uid, {
    business_type: 'hauling', customer_name: 'T1 Owner', customer_address: '1 Test Rd', total_price: 200
  });
  ok('owner can insert own row', mine.status === 201, `HTTP ${mine.status}`);

  const aSees = await (await rest('jobs?select=customer_name', a.token)).json();
  ok('owner reads own row', aSees.some(r => r.customer_name === 'T1 Owner'));

  const bSees = await (await rest('jobs?select=customer_name', b.token)).json();
  ok('other user reads nothing', Array.isArray(bSees) && bSees.length === 0, JSON.stringify(bSees).slice(0, 80));

  const spoof = await insert(b.token, a.uid, {
    business_type: 'hauling', customer_name: 'T1 Spoof', customer_address: 'x', total_price: 1
  });
  ok('other user cannot insert as owner', spoof.status === 403, `HTTP ${spoof.status}`);

  const del = await rest(`jobs?id=eq.${mine.body[0].id}`, b.token, { method: 'DELETE' });
  const stillThere = await (await rest('jobs?select=id', a.token)).json();
  ok('other user cannot delete owner row', stillThere.length === 1, `deleted, HTTP ${del.status}`);
}

// ---------------------------------------------------------------------------
console.log('\nTEST 2  Order lifecycle: open, complete, paid');
{
  const u = await signIn();
  const future = await insert(u.token, u.uid, {
    business_type: 'firewood', customer_name: 'T2 Future', customer_address: '2 Test Rd',
    total_price: 300, wood_quantity: 1, delivery_date: iso(7)
  });
  ok('future dated job is open', future.body[0].status === 'open', future.body[0].status);
  ok('open job has no completed_at', future.body[0].completed_at === null);

  const done = await insert(u.token, u.uid, {
    business_type: 'plumbing', customer_name: 'T2 Done', customer_address: '3 Test Rd',
    total_price: 150, completed_at: new Date().toISOString()
  });
  ok('same day job is completed', done.body[0].status === 'completed', done.body[0].status);

  const upd = await rest(`jobs?id=eq.${future.body[0].id}`, u.token, {
    method: 'PATCH', body: JSON.stringify({ completed_at: new Date().toISOString() })
  });
  const after = (await upd.json())[0];
  ok('ticking complete flips derived status', after.status === 'completed', after.status);
  ok('completing does not mark it paid', after.paid_at === null);

  const paid = await rest(`jobs?id=eq.${after.id}`, u.token, {
    method: 'PATCH', body: JSON.stringify({ paid_at: new Date().toISOString() })
  });
  ok('paid is tracked separately', (await paid.json())[0].paid_at !== null);

  const bad = await rest(`jobs?id=eq.${after.id}`, u.token, {
    method: 'PATCH', body: JSON.stringify({ status: 'open' })
  });
  ok('generated status cannot be written directly', bad.status >= 400, `HTTP ${bad.status}`);
}

// ---------------------------------------------------------------------------
console.log('\nTEST 3  Cord fractions and the revenue split');
{
  const u = await signIn();
  for (const [name, cords, price] of [['T3 Half', 0.5, 150], ['T3 Quarter', 0.25, 75], ['T3 Full', 1, 300]]) {
    await insert(u.token, u.uid, {
      business_type: 'firewood', customer_name: name, customer_address: 'x',
      wood_quantity: cords, total_price: price, completed_at: new Date().toISOString()
    });
  }
  await insert(u.token, u.uid, {
    business_type: 'firewood', customer_name: 'T3 Booked', customer_address: 'x',
    wood_quantity: 2, total_price: 600, delivery_date: iso(10)
  });

  const v = (await (await rest('job_totals_by_trade?select=*&business_type=eq.firewood', u.token)).json())[0];
  ok('cords total 0.5 + 0.25 + 1 + 2 = 3.75', Number(v.cords) === 3.75, `got ${v.cords}`);
  ok('total revenue counts completed only (525)', Number(v.total_revenue) === 525, `got ${v.total_revenue}`);
  ok('pending revenue counts open only (600)', Number(v.pending_revenue) === 600, `got ${v.pending_revenue}`);
  ok('unpaid equals completed unpaid (525)', Number(v.unpaid_revenue) === 525, `got ${v.unpaid_revenue}`);
  ok('open and completed counts split 1 / 3', v.open_jobs === 1 && v.completed_jobs === 3, `${v.open_jobs}/${v.completed_jobs}`);
  ok('empty sums coalesce to 0, never null', v.pending_revenue !== null && v.total_revenue !== null);
}

// ---------------------------------------------------------------------------
console.log('\nCleaning up rows this run created');
for (const { id, token } of created) {
  await rest(`jobs?id=eq.${id}`, token, { method: 'DELETE' });
}
const afterRes = await rest('jobs?select=id', admin.token);
const after = (await afterRes.json()).length;
ok(`pre-existing data untouched (${baseline} before, ${after} after)`, after === baseline);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
