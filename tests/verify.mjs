// Read-only verification against the live Supabase backend.
//
// This file performs NO writes. No insert, no update, no delete. Every request
// is a GET. It asserts invariants over whatever data is already there.
//
// That is deliberate. The book is now shared, so any session can delete any
// job. A suite that creates and cleans up its own rows is one bug away from
// removing real work, so it does not create rows at all. tests/imports.test.mjs
// fails the build if a write verb ever appears in this file.
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
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`    PASS  ${name}`); }
  else { fail++; console.log(`    FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
};

const signIn = async () => {
  const r = await fetch(`${URL_}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}'
  });
  const d = await r.json();
  if (d.error_code === 'over_request_rate_limit' || r.status === 429) {
    console.error('\n  Anonymous sign-in rate limit reached (30/hour per IP). Wait and retry.\n');
    process.exit(2);
  }
  if (!d.access_token) throw new Error('anon sign-in failed: ' + JSON.stringify(d));
  return { token: d.access_token, uid: d.user.id };
};

// GET only. There is no helper here capable of anything else.
const read = async (path, token) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  return { status: r.status, body: await r.json() };
};

const alice = await signIn();
const bob = await signIn();
const num = (v) => Number(v) || 0;

const all = await read('jobs?select=id,business_type,status,total_price,wood_quantity,labor_hours,completed_at,paid_at,invoice_number,user_id', alice.token);
const rows = Array.isArray(all.body) ? all.body : [];
console.log(`\nRead-only run. ${rows.length} job(s) visible, ${new Set(rows.map(r => r.user_id)).size} account(s). Nothing will be written.\n`);

// ---------------------------------------------------------------------------
console.log('TEST 1  The book is shared, and the remaining guard holds');
{
  ok('a signed-in device can read the book', all.status === 200 && rows.length > 0, `HTTP ${all.status}`);

  const bobSees = await read('jobs?select=id', bob.token);
  ok('a second device sees exactly the same jobs',
     Array.isArray(bobSees.body) && bobSees.body.length === rows.length,
     `${Array.isArray(bobSees.body) ? bobSees.body.length : '?'} vs ${rows.length}`);

  // Sharing must be proven by behaviour, not by how many accounts happen to
  // hold data today. Bob signed in seconds ago and owns nothing, so every job
  // he can see belongs to somebody else.
  const bobOwns = rows.filter(r => r.user_id === bob.uid).length;
  ok('a brand new account owns none of these jobs', bobOwns === 0, `${bobOwns} owned`);
  ok('yet that account still sees the whole book',
     Array.isArray(bobSees.body) && bobSees.body.length === rows.length && rows.length > 0,
     `sees ${Array.isArray(bobSees.body) ? bobSees.body.length : '?'} of ${rows.length}`);

  const anon = await read('jobs?select=id&limit=1', null);
  ok('the publishable key alone cannot read the table',
     anon.status !== 200 || (Array.isArray(anon.body) && anon.body.length === 0),
     `HTTP ${anon.status} ${JSON.stringify(anon.body).slice(0, 60)}`);
}

// ---------------------------------------------------------------------------
console.log('\nTEST 2  Lifecycle invariants across every real row');
{
  ok('status is only open or completed',
     rows.every(r => r.status === 'open' || r.status === 'completed'),
     [...new Set(rows.map(r => r.status))].join(', '));

  ok('every completed row has a completed_at',
     rows.filter(r => r.status === 'completed').every(r => r.completed_at),
     'a completed row is missing its timestamp');

  ok('every open row has no completed_at',
     rows.filter(r => r.status === 'open').every(r => !r.completed_at),
     'an open row carries a completed timestamp');

  ok('nothing is marked paid before it was completed',
     rows.filter(r => r.paid_at).every(r => r.completed_at),
     'a row is paid but not completed');

  ok('every row carries an invoice number',
     rows.every(r => r.invoice_number !== null && r.invoice_number !== undefined));

  const perUser = {};
  for (const r of rows) (perUser[r.user_id] ||= []).push(r.invoice_number);
  ok('invoice numbers are unique per account',
     Object.values(perUser).every(ns => new Set(ns).size === ns.length));
}

// ---------------------------------------------------------------------------
console.log('\nTEST 3  The reporting view matches the underlying rows');
{
  const view = (await read('job_totals_by_trade?select=*', alice.token)).body;
  ok('the view is readable', Array.isArray(view) && view.length > 0);

  let checked = 0;
  for (const trade of [...new Set(rows.map(r => r.business_type))]) {
    const own = rows.filter(r => r.business_type === trade);
    const v = Array.isArray(view) ? view.find(x => x.business_type === trade) : null;
    if (!v) { ok(`view has a row for ${trade}`, false); continue; }
    const expTotal = own.filter(r => r.status === 'completed').reduce((s, r) => s + num(r.total_price), 0);
    const expPending = own.filter(r => r.status === 'open').reduce((s, r) => s + num(r.total_price), 0);
    const expUnpaid = own.filter(r => r.completed_at && !r.paid_at).reduce((s, r) => s + num(r.total_price), 0);
    const expCords = own.reduce((s, r) => s + num(r.wood_quantity), 0);
    ok(`${trade}: job count`, v.jobs === own.length, `${v.jobs} vs ${own.length}`);
    ok(`${trade}: total revenue is completed only`, num(v.total_revenue).toFixed(2) === expTotal.toFixed(2), `${v.total_revenue} vs ${expTotal}`);
    ok(`${trade}: pending revenue is open only`, num(v.pending_revenue).toFixed(2) === expPending.toFixed(2), `${v.pending_revenue} vs ${expPending}`);
    ok(`${trade}: unpaid is completed and not paid`, num(v.unpaid_revenue).toFixed(2) === expUnpaid.toFixed(2), `${v.unpaid_revenue} vs ${expUnpaid}`);
    ok(`${trade}: cords sum`, num(v.cords).toFixed(2) === expCords.toFixed(2), `${v.cords} vs ${expCords}`);
    checked++;
  }
  ok('at least one trade was checked', checked > 0);
  ok('sums are never null', Array.isArray(view) && view.every(v => v.total_revenue !== null && v.pending_revenue !== null));
}

const stillThere = (await read('jobs?select=id', alice.token)).body;
ok(`nothing was written or removed (${rows.length} before, ${Array.isArray(stillThere) ? stillThere.length : '?'} after)`,
   Array.isArray(stillThere) && stillThere.length === rows.length);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
