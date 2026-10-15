# fixtures/live-supabase

The live demo app for the launch clip and for testing live mode. Vite 6 + React 18 + supabase-js, an orders list with Save. The browser talks straight to Supabase, like a Lovable or Bolt app. Every visitor signs in as their own anonymous user.

## The planted bug

`supabase/migrations/20261015000000_orders.sql` creates `orders` with row level security on:

| Piece | What it does |
|---|---|
| `user_id uuid default auth.uid()` | Filled on every insert (the trigger forces it) |
| `owner_id uuid` | Never set by the app |
| Insert policy `with check (true)` | Save always succeeds |
| Select policy `using (owner_id = auth.uid())` | **The bug.** It compares the wrong column, so a signed-in user saves fine and then reads 0 rows |

Save calls `.insert(row)` without `.select()` (`src/main.tsx`). With `.select()`, PostgREST reads the new row back through the select policy and the insert fails with `new row violates row-level security policy` (a 403). That is a different, louder bug; this fixture keeps the quiet one.

The fix is one line, in `supabase/fix.sql`:

```sql
alter policy "users read their own orders" on public.orders using (user_id = auth.uid());
```

## Spam guards

A public demo with the anon key and an open insert collects spam, so the migration adds two guards:

- **At most 20 orders per visitor per day.** A `before insert` trigger refuses the 21st with "This demo takes 20 orders a day per visitor. Try again tomorrow."
- **A nightly wipe.** `public.wipe_old_orders()` deletes visitors' orders older than a day; a `pg_cron` job runs it at 03:00 UTC. The two seed rows (Ada Example, Grace Example) stay. Only the database owner can call it.

Supabase also limits anonymous sign-ins per IP (30 an hour by default, under Authentication, Rate Limits). Keep that on.

## Run it locally (no Supabase needed)

```sh
cd fixtures/live-supabase && npm i && npm run dev:stub
```

`stub.ts` answers the PostgREST and auth calls the page makes, on :54321 (the port Supabase uses locally). The page runs on :5173. Open the folder in Shrike, click Run, then Save.

- Default: reads come back with rows, like the fixed policy ("local: 3 rows" after the first Save).
- `STUB_EMPTY=1 npm run dev:stub`: reads come back with 0 rows, like the planted policy. A `.insert().select()` gets the 403.

Ports follow `APP_PORT` (page, default 5173) and `SERVER_PORT` (stub, default 54321).

Tests: `npm test` runs the migration on PGlite (planted bug, fix, both spam guards). The e2e in `apps/desktop/e2e/live-site.test.ts` builds this app, serves it from the stub with the same CSP as Vercel, opens it as a live site and checks the 0 rows trip and its caption.

## Deploy it (maintainer)

You need a free Supabase project and a Vercel account. The anon key lives in Vercel only, never in this repo.

1. **Supabase project.** At [supabase.com/dashboard](https://supabase.com/dashboard), New project. Free plan, any region.
2. **Anonymous sign-ins.** Authentication, Sign In / Providers, turn on "Allow anonymous sign-ins".
3. **pg_cron.** Database, Extensions, turn on `pg_cron`.
4. **Tables and policies.** SQL Editor, New query, paste all of `supabase/migrations/20261015000000_orders.sql`, Run. Do not run `fix.sql`: the deployed copy keeps the bug.
5. **Check the wipe is scheduled.** In the SQL Editor: `select jobname, schedule from cron.job;` shows `wipe-old-orders | 0 3 * * *`. If it's missing (pg_cron was off in step 4), run `select cron.schedule('wipe-old-orders', '0 3 * * *', 'select public.wipe_old_orders()');`
6. **Keys.** Project Settings, API: copy the Project URL and the `anon` `public` key.
7. **Vercel.** From the repo root:

   ```sh
   cd fixtures/live-supabase
   npx vercel link
   npx vercel env add VITE_SUPABASE_URL production        # paste the Project URL
   npx vercel env add VITE_SUPABASE_ANON_KEY production   # paste the anon key
   npx vercel deploy --prod
   ```

   Or in the Vercel dashboard: import the repo, Root Directory `fixtures/live-supabase`, Framework Vite, the two environment variables, Deploy. `vercel.json` adds the strict CSP; the build registers `public/sw.js`.
8. **Point Shrike at it.** Add the deployed URL to `.shrike/config.json`:

   ```json
   { "devCommand": "npm run dev:stub", "appUrl": "http://localhost:5173", "liveUrl": "https://YOUR-APP.vercel.app/" }
   ```

   The Local / Live switch then shows on the app pane.
9. **Check it.** Open the URL, click Save: "Saved." and then "No orders yet."

**Before recording:** free Supabase projects pause after a week without traffic. Open the dashboard and click "Restore project" (a few minutes), then load the site once so the first click isn't slow.
