// Unit tests for the camelCase <-> snake_case mapping layer.
//
// This file exists because two production bugs shipped from code that nothing
// could reach: tax_rate received an explicit null over its default, and ticking
// an order complete sent epoch milliseconds to a timestamptz column. Both were
// in this layer. No network, no database.
//
//   node tests/mapping.test.mjs

import { JOB_FIELDS, encodeColumn, jobToRow, rowToJob, csvCell, buildCsv } from '../src/jobMapping.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`    PASS  ${name}`); }
  else { fail++; console.log(`    FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
};

const UID = '00000000-0000-0000-0000-000000000001';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

console.log('\nTEST 4  Row mapping');

// The tax_rate regression: absent fields must be omitted, not nulled, or the
// column default and the invoice_number trigger never get a chance to run.
{
  const row = jobToRow({ businessType: 'hauling', customerName: 'A', customerAddress: 'B' }, UID);
  ok('omits fields the form never set', !('tax_rate' in row) && !('invoice_number' in row),
     JSON.stringify({ tax_rate: row.tax_rate, invoice_number: row.invoice_number }));
  ok('keeps fields that were set', row.business_type === 'hauling' && row.customer_name === 'A');
  ok('always stamps created_at as ISO', ISO.test(row.created_at), row.created_at);
}

// The 22008 regression: epoch milliseconds must become ISO on every path.
{
  const ms = 1790297080580;
  ok('encodes epoch ms for completed_at', ISO.test(encodeColumn('completed_at', ms)), String(encodeColumn('completed_at', ms)));
  ok('encodes epoch ms for paid_at', ISO.test(encodeColumn('paid_at', ms)), String(encodeColumn('paid_at', ms)));
  ok('encodes a numeric STRING too', ISO.test(encodeColumn('completed_at', String(ms))), String(encodeColumn('completed_at', String(ms))));
  ok('passes an existing ISO string through', encodeColumn('completed_at', '2026-09-24T10:00:00Z') === '2026-09-24T10:00:00Z');
  ok('null stays null', encodeColumn('completed_at', null) === null);
  ok('empty string becomes null', encodeColumn('completed_at', '') === null);
  ok('never emits a bare epoch number', !/^\d+$/.test(String(encodeColumn('completed_at', ms))));
}

// Insert and update must encode identically; they drifted before.
{
  const ms = 1790297080580;
  const viaInsert = jobToRow({ completedAt: ms, paidAt: ms }, UID);
  const viaUpdate = {};
  for (const [key, column] of JOB_FIELDS) {
    const fields = { completedAt: ms, paidAt: ms };
    if (key in fields) viaUpdate[column] = encodeColumn(column, fields[key]);
  }
  ok('insert and update agree on completed_at', viaInsert.completed_at === viaUpdate.completed_at,
     `${viaInsert.completed_at} vs ${viaUpdate.completed_at}`);
  ok('insert and update agree on paid_at', viaInsert.paid_at === viaUpdate.paid_at);
}

// A date column rejects '' but accepts null.
{
  ok('blank delivery_date becomes null', jobToRow({ deliveryDate: '' }, UID).delivery_date === null);
  ok('real delivery_date survives', jobToRow({ deliveryDate: '2026-10-05' }, UID).delivery_date === '2026-10-05');
}

// Reading back: PostgREST hands numerics over as strings and the UI does maths.
{
  const job = rowToJob({
    id: 'x', created_at: '2026-09-24T10:00:00Z', total_price: '262.50',
    wood_quantity: '0.75', tax_rate: '0.0625', invoice_number: 7,
    completed_at: null, paid_at: '2026-09-24T11:00:00Z', customer_name: 'A'
  });
  ok('numerics come back as numbers', typeof job.totalPrice === 'number' && job.totalPrice === 262.5, String(job.totalPrice));
  ok('cords come back as a number', job.woodQuantity === 0.75, String(job.woodQuantity));
  ok('timestamps come back as epoch ms', typeof job.paidAt === 'number' && job.paidAt > 0, String(job.paidAt));
  ok('null timestamp stays null', job.completedAt === null);
  ok('round trip survives', ISO.test(jobToRow(job, UID).paid_at), String(jobToRow(job, UID).paid_at));
}

// CSV export. A stray comma or quote silently corrupts a spreadsheet, and the
// damage is invisible until someone opens the file weeks later.
console.log('\nTEST 5  CSV export');
{
  ok('plain text is unquoted', csvCell('Eleanor Hayes') === 'Eleanor Hayes');
  ok('a comma forces quoting', csvCell('41 Birch Hollow Rd, Concord NH') === '"41 Birch Hollow Rd, Concord NH"');
  ok('inner quotes are doubled', csvCell('Said "urgent"') === '"Said ""urgent"""');
  ok('newlines are quoted', csvCell('line one\nline two') === '"line one\nline two"');
  ok('null becomes empty', csvCell(null) === '' && csvCell(undefined) === '');

  const csv = buildCsv([
    { invoiceNumber: 1, createdAt: Date.parse('2026-09-24T10:00:00Z'), businessType: 'firewood',
      customerName: 'A, Inc', customerAddress: '1 St', totalPrice: 262.5, woodQuantity: 0.75,
      deliveryDate: '2026-10-05', notes: 'he said "leave it"' },
    { invoiceNumber: 2, createdAt: Date.parse('2026-09-24T10:00:00Z'), businessType: 'hauling',
      customerName: 'B', customerAddress: '2 St', totalPrice: 325, completedAt: Date.parse('2026-09-24T12:00:00Z') }
  ]);
  const lines = csv.split('\r\n');
  ok('header plus one line per job', lines.length === 3, String(lines.length));
  ok('uses CRLF line endings', csv.includes('\r\n'));
  ok('open job reports Open', lines[1].includes('Open'));
  ok('completed job reports Completed', lines[2].includes('Completed'));
  ok('amount is fixed to 2 decimals', lines[1].includes('262.50'));
  ok('embedded comma did not add a column',
     lines[1].split(',').length === lines[2].split(',').length + 1 || lines[1].includes('"A, Inc"'));
  ok('embedded quotes survived', lines[1].includes('""leave it""'));
  ok('every row has the same field count', (() => {
    const count = (line) => {
      let n = 1, inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (inQ && line[i + 1] === '"') i++; else inQ = !inQ; }
        else if (c === ',' && !inQ) n++;
      }
      return n;
    };
    return count(lines[0]) === count(lines[1]) && count(lines[1]) === count(lines[2]);
  })());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
