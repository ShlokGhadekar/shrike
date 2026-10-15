-- The one-line fix for the planted bug: read orders by the column the app actually fills.
alter policy "users read their own orders" on public.orders using (user_id = auth.uid());
