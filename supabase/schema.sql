-- HustleSync schema for Supabase Postgres.
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- The app currently keeps every job as one Firestore document. Here it becomes
-- one row in one table, so the columns are wide: each trade fills in its own
-- subset and leaves the rest null. That keeps querying simple (one table, no
-- joins) which is the point of moving to SQL.

create table if not exists public.jobs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,

  business_type    text not null check (business_type in ('firewood', 'hauling', 'plumbing', 'heating')),
  customer_name    text not null,
  customer_address text not null,
  customer_phone   text,
  total_price      numeric(10, 2) not null default 0,
  notes            text,

  -- firewood
  wood_quantity    numeric,
  wood_size        text,
  custom_wood_size text,
  price_per_cord   numeric,
  is_stacked       boolean,
  stacking_price   numeric,
  delivery_date    date,

  -- hauling
  load_size        text,
  base_price       numeric,
  dump_fee         numeric,

  -- plumbing and HVAC
  system_type      text,
  diagnosis        text,
  parts_cost       numeric,
  labor_hours      numeric,
  hourly_rate      numeric,

  -- Order lifecycle. Two independent ticks, because finishing the work and
  -- getting paid are different events: a cord can be delivered on Tuesday and
  -- settled on Friday. Both are nullable timestamps rather than booleans so the
  -- date is recorded, not just the fact.
  completed_at     timestamptz,
  paid_at          timestamptz,

  -- Derived, so it can never drift out of step with completed_at.
  status           text generated always as (
                     case when completed_at is null then 'open' else 'completed' end
                   ) stored,

  created_at       timestamptz not null default now()
);

-- The app always reads one user's jobs newest first.
create index if not exists jobs_user_created_idx
  on public.jobs (user_id, created_at desc);

-- The trade boards always split the list into open and completed.
create index if not exists jobs_user_status_idx
  on public.jobs (user_id, status, created_at desc);

-- Row level security: a signed-in user can only ever see and touch their own
-- rows. This is the Postgres equivalent of the Firestore rules, and like those
-- it is the only thing standing between users, so it is not optional.
alter table public.jobs enable row level security;

drop policy if exists jobs_select_own on public.jobs;
create policy jobs_select_own on public.jobs
  for select using (auth.uid() = user_id);

drop policy if exists jobs_insert_own on public.jobs;
create policy jobs_insert_own on public.jobs
  for insert with check (auth.uid() = user_id);

drop policy if exists jobs_update_own on public.jobs;
create policy jobs_update_own on public.jobs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists jobs_delete_own on public.jobs;
create policy jobs_delete_own on public.jobs
  for delete using (auth.uid() = user_id);

-- Live updates, so a job saved on the phone appears on the laptop.
do $$
begin
  alter publication supabase_realtime add table public.jobs;
exception
  when duplicate_object then null;  -- already published, re-running is fine
end $$;

-- Convenience view for reporting. Query it in the SQL editor:
--   select * from job_totals_by_trade;
create or replace view public.job_totals_by_trade as
  select
    user_id,
    business_type,
    count(*)                                                     as jobs,
    count(*) filter (where status = 'open')                      as open_jobs,
    count(*) filter (where status = 'completed')                 as completed_jobs,
    -- Total revenue is work actually finished. Pending revenue is booked work
    -- not yet delivered. Unpaid is finished work the customer still owes on.
    -- coalesce, or an empty set sums to null and reads as a missing value
    coalesce(sum(total_price) filter (where status = 'completed'), 0)  as total_revenue,
    coalesce(sum(total_price) filter (where status = 'open'), 0)       as pending_revenue,
    coalesce(sum(total_price) filter (where completed_at is not null
                                        and paid_at is null), 0)       as unpaid_revenue,
    sum(coalesce(wood_quantity, 0))                              as cords,
    sum(coalesce(labor_hours, 0))                                as hours,
    min(created_at)                                              as first_job,
    max(created_at)                                              as latest_job
  from public.jobs
  group by user_id, business_type;

-- Everything still on the books, soonest delivery first.
create or replace view public.open_orders as
  select id, user_id, business_type, customer_name, customer_address,
         delivery_date, total_price, created_at
  from public.jobs
  where status = 'open'
  order by delivery_date nulls last, created_at;

-- Views do NOT enforce the underlying table's row level security by default:
-- they run as the view owner, so every user would see everyone's totals.
-- security_invoker makes them run as the caller, which is the whole point.
alter view public.job_totals_by_trade set (security_invoker = on);
alter view public.open_orders set (security_invoker = on);
