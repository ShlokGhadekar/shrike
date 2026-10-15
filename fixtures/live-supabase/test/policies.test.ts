// The migration on PGlite with Supabase's roles and auth.uid() stood in: the quiet bug, the fix, and both spam guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const sql = (f: string) => readFileSync(new URL(`../supabase/${f}`, import.meta.url), "utf8");
const ADA = "00000000-0000-4000-8000-00000000ada0";

async function db() {
  const w = globalThis as { window?: unknown };
  const win = w.window;
  delete w.window; // pnpm test shares a process with renderer tests that set a global window; PGlite's loader would take its browser path
  const pg = new PGlite();
  await pg.waitReady.finally(() => win !== undefined && (w.window = win));
  await pg.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;`);
  await pg.exec(sql("migrations/20261015000000_orders.sql"));
  return pg;
}
const as = (pg: PGlite, user: string) => pg.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
const count = async (pg: PGlite) => (await pg.query<{ n: number }>("select count(*)::int as n from public.orders")).rows[0]!.n;

test("planted: Save succeeds without a 403 and the user reads 0 rows; with .select() it fails loudly; fix.sql shows the row", async () => {
  const pg = await db();
  await as(pg, ADA);
  await pg.query("insert into public.orders (item) values ('Blue mug')");
  assert.equal(await count(pg), 0);
  await assert.rejects(pg.query("insert into public.orders (item) values ('Blue mug') returning *"), /row-level security/);
  await pg.exec("reset role;");
  await pg.exec(sql("fix.sql"));
  await as(pg, ADA);
  assert.equal(await count(pg), 1, "the row Ada saved, not the seed rows");
});

test("spam guards: a 21st insert in a day is refused, the nightly wipe drops visitors' rows older than a day", async () => {
  const pg = await db();
  await as(pg, ADA);
  for (let i = 0; i < 20; i++) await pg.query("insert into public.orders (item) values ('Mug')");
  await assert.rejects(pg.query("insert into public.orders (item) values ('Mug')"), /20 orders a day/);
  await pg.exec("reset role;");
  const all = async () => (await pg.query<{ n: number }>("select count(*)::int as n from public.orders")).rows[0]!.n;
  assert.equal(await all(), 22);
  await pg.exec("update public.orders set created_at = now() - interval '25 hours' where id in (select id from public.orders where user_id is not null limit 5)");
  await pg.exec("update public.orders set created_at = now() - interval '25 hours' where user_id is null");
  await pg.exec("select public.wipe_old_orders()");
  assert.equal(await all(), 17, "5 old visitor rows gone, 15 fresh and 2 seed rows stay");
  await as(pg, ADA);
  await pg.query("insert into public.orders (item) values ('Mug')"); // a day's room again after the wipe
  await assert.rejects(pg.query("select public.wipe_old_orders()"), /permission denied/);
});
