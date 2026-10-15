-- Orders for the live demo. Row level security is on, with one planted bug in the select policy.

create table public.orders (
  id bigint generated always as identity primary key,
  item text not null check (char_length(item) between 1 and 80),
  qty int not null default 1 check (qty between 1 and 99),
  customer text not null default 'You' check (char_length(customer) <= 80),
  user_id uuid default auth.uid(),
  owner_id uuid, -- the app never sets this
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;
grant select, insert on public.orders to authenticated;

-- Insert is open to any signed-in user, so Save always succeeds.
create policy "signed-in users can add orders" on public.orders
  for insert to authenticated with check (true);

-- PLANTED BUG: compares owner_id, which is always null, so a signed-in user reads 0 rows after a good Save.
-- The fix is one line: using (user_id = auth.uid()). See supabase/fix.sql.
create policy "users read their own orders" on public.orders
  for select to authenticated using (owner_id = auth.uid());

-- Spam guard 1: at most 20 orders per user per day. Security definer so the count sees rows the select policy hides.
create function public.orders_daily_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.user_id := auth.uid();
  new.owner_id := null;
  perform pg_advisory_xact_lock(hashtext(coalesce(new.user_id::text, '')));
  if (select count(*) from public.orders where user_id = new.user_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'This demo takes 20 orders a day per visitor. Try again tomorrow.';
  end if;
  return new;
end $$;

create trigger orders_daily_limit before insert on public.orders
  for each row execute function public.orders_daily_limit();

-- Spam guard 2: a nightly wipe of visitors' orders older than a day. The seed rows below stay.
create function public.wipe_old_orders() returns void
language sql security definer set search_path = '' as $$
  delete from public.orders where user_id is not null and created_at < now() - interval '1 day';
$$;

revoke execute on function public.wipe_old_orders() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('wipe-old-orders', '0 3 * * *', 'select public.wipe_old_orders()');
  end if;
end $$;

insert into public.orders (item, qty, customer) values
  ('Blue mug', 2, 'Ada Example'),
  ('Tea towel', 1, 'Grace Example');
