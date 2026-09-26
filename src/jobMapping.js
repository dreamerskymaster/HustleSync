// Pure mapping between the app's camelCase job objects and the snake_case
// Postgres rows. Kept out of the component file with no React or Supabase
// imports, so it can be unit tested directly. Two production bugs came from
// this layer being untestable, so that isolation is the point.

// The app speaks camelCase; Postgres columns are snake_case.
export const JOB_FIELDS = [
  ['businessType', 'business_type'], ['customerName', 'customer_name'],
  ['customerAddress', 'customer_address'], ['customerPhone', 'customer_phone'],
  ['totalPrice', 'total_price'], ['notes', 'notes'],
  ['woodQuantity', 'wood_quantity'], ['woodSize', 'wood_size'],
  ['customWoodSize', 'custom_wood_size'], ['pricePerCord', 'price_per_cord'],
  ['isStacked', 'is_stacked'], ['stackingPrice', 'stacking_price'],
  ['deliveryDate', 'delivery_date'], ['loadSize', 'load_size'],
  ['basePrice', 'base_price'], ['dumpFee', 'dump_fee'],
  ['systemType', 'system_type'], ['diagnosis', 'diagnosis'],
  ['partsCost', 'parts_cost'], ['laborHours', 'labor_hours'],
  ['hourlyRate', 'hourly_rate'],
  ['completedAt', 'completed_at'], ['paidAt', 'paid_at'],
  ['invoiceNumber', 'invoice_number'], ['taxRate', 'tax_rate'],
  ['woodPrice', 'wood_price']
];

export const NUMERIC_FIELDS = new Set([
  'invoiceNumber', 'taxRate', 'woodPrice',
  'totalPrice', 'woodQuantity', 'pricePerCord', 'stackingPrice',
  'basePrice', 'dumpFee', 'partsCost', 'laborHours', 'hourlyRate'
]);

export const TIMESTAMP_COLUMNS = new Set(['completed_at', 'paid_at', 'created_at']);

// One encoder for both the insert and the update path. They used to be written
// out separately and drifted twice: once when tax_rate started receiving an
// explicit null over its default, and once when ticking an order complete sent
// raw epoch milliseconds to a timestamptz column. Anything that writes a column
// goes through here.
export const encodeColumn = (column, raw) => {
  if (raw === undefined || raw === '') return null;
  if (raw === null) return null;

  if (TIMESTAMP_COLUMNS.has(column)) {
    // The app carries these as epoch milliseconds; Postgres wants ISO. Accept a
    // numeric string too, since form state stringifies everything it touches.
    const ms = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(ms) && String(raw).trim() !== '') return new Date(ms).toISOString();
    return raw; // already an ISO timestamp
  }

  return raw;
};

export const jobToRow = (job, userId) => {
  const row = { user_id: userId };
  for (const [key, column] of JOB_FIELDS) {
    // Omit anything the form never set so the column default applies. Writing
    // an explicit null here broke every save once tax_rate (not null, default
    // 0) was added, and would break invoice_number's trigger the same way.
    if (!(key in job) || job[key] === undefined) continue;
    row[column] = encodeColumn(column, job[key]);
  }
  row.created_at = encodeColumn('created_at', job.createdAt || Date.now());
  return row;
};

export const rowToJob = (row) => {
  const job = { id: row.id, createdAt: Date.parse(row.created_at) };
  for (const [key, column] of JOB_FIELDS) {
    let value = row[column];
    if ((column === 'completed_at' || column === 'paid_at')) {
      job[key] = value ? Date.parse(value) : null;
      continue;
    }
    // Postgres numerics can arrive as strings; the UI does arithmetic on them.
    job[key] = NUMERIC_FIELDS.has(key) && value !== null && value !== undefined
      ? Number(value)
      : value;
  }
  return job;
};


export const isOpenOrder = (job) => !job.completedAt;
export const isUnpaid = (job) => Boolean(job.completedAt) && !job.paidAt;

// Create and edit share one path. Editing never touches completedAt or paidAt,
// so correcting an address cannot silently change where an order sits.
// Form inputs hold strings; a saved job holds numbers and booleans. Seeding an
// edit form means converting back, keyed off the shape of the blank form.
const seedForm = (blank, job) => {
  if (!job) return blank;
  const seeded = { ...blank };
  for (const key of Object.keys(blank)) {
    const value = job[key];
    if (value === undefined || value === null) continue;
    seeded[key] = typeof blank[key] === 'boolean' ? Boolean(value) : String(value);
  }
  return seeded;
};

const submitJob = async (payload, userId, existingJob) => {
  if (existingJob && existingJob.id) {
    await updateJobFields(existingJob.id, userId, payload);
    return { id: existingJob.id, ...payload };
  }
  return persistJob(payload, userId);
};

export const TRADE_LABELS = {
  firewood: 'Timber', hauling: 'Haul', plumbing: 'Flow', heating: 'HVAC'
};

export const asDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

// One row per job, in the order someone would want to read them in a
// spreadsheet: what it was, who for, where it stands, what it was worth.
export const CSV_COLUMNS = [
  ['Invoice', job => job.invoiceNumber || ''],
  ['Logged', job => asDate(job.createdAt)],
  ['Trade', job => TRADE_LABELS[job.businessType] || job.businessType],
  ['Customer', job => job.customerName || ''],
  ['Address', job => job.customerAddress || ''],
  ['Phone', job => job.customerPhone || ''],
  ['Status', job => (isOpenOrder(job) ? 'Open' : 'Completed')],
  ['Scheduled', job => job.deliveryDate || ''],
  ['Completed', job => asDate(job.completedAt)],
  ['Paid', job => asDate(job.paidAt)],
  ['Amount', job => (Number(job.totalPrice) || 0).toFixed(2)],
  ['Cords', job => (job.businessType === 'firewood' ? job.woodQuantity ?? '' : '')],
  ['Hours', job => (job.businessType === 'plumbing' || job.businessType === 'heating' ? job.laborHours ?? '' : '')],
  ['Details', job => job.diagnosis || job.systemType || job.loadSize || job.woodSize || ''],
  ['Notes', job => job.notes || '']
];

// A value containing a comma, quote or newline has to be quoted, and inner
// quotes doubled, or the file silently corrupts on import.
export const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const buildCsv = (jobs) => {
  const lines = [CSV_COLUMNS.map(([heading]) => csvCell(heading)).join(',')];
  for (const job of jobs) {
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(job))).join(','));
  }
  return lines.join('\r\n');
};
