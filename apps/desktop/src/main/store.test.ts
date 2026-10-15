import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionView, DebugEvent } from "@shrike/schema";
import { MAX_TRIP_EVENTS, MAX_TRIPS, SERVER_OUTPUT_ID, Store, ZERO_TRACE } from "./store.ts";

const T = "1".repeat(32);
const ev = (p: Partial<DebugEvent> & Pick<DebugEvent, "id" | "kind" | "name">): DebugEvent => ({ traceId: T, origin: "browser", startMs: Date.now(), status: "ok", ...p });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(loadText?: (url: string) => Promise<string>) {
  const updates: ActionView[][] = [];
  const store = new Store({ projectRoot: () => "/proj", onUpdate: (v) => updates.push(v), loadText });
  return { store, updates };
}

test("browser action: upserts, links server events, completes 500ms after action_end", async () => {
  const { store, updates } = make();
  const root = ev({ id: "a".repeat(16), kind: "user_action", name: 'Clicked "Add Todo"', trigger: "click", source: { file: "/proj/src/TodoForm.tsx", line: 31, precision: "exact" } });
  store.handle({ type: "events", events: [root] });
  store.handle({ type: "events", events: [ev({ id: "b".repeat(16), parentId: root.id, kind: "http_request", name: "POST /api/todos", http: { method: "POST", url: "/api/todos", status: 500 } })] });
  store.handle({ type: "events", events: [ev({ id: "c".repeat(16), parentId: "b".repeat(16), origin: "server", kind: "http_request", name: "POST /api/todos", status: "error" })] });
  const waited = store.waitForAction(root.id, 5000);
  store.handle({ type: "action_end", actionId: root.id, at: Date.now() });
  store.handle({ type: "events", events: [{ ...root, durationMs: 48, status: "error" }] });

  assert.equal(store.getAction(root.id)?.complete, false);
  await sleep(150);
  assert.equal(updates.length, 1, "throttled into one update");
  const t0 = Date.now();
  const view = await waited;
  assert.ok(Date.now() - t0 >= 300);
  assert.equal(view?.complete, true);
  assert.equal(view?.status, "error");
  assert.equal(view?.root.source?.file, "src/TodoForm.tsx");
  assert.equal(view?.tree[0]?.children[0]?.event.origin, "server");
  assert.equal(store.listActions().length, 1);
  assert.equal(store.searchEvents("api/todos").length, 2);
  assert.equal((await store.waitForAction(root.id, 10))?.complete, true);
  await sleep(150);
  assert.equal(updates.at(-1)?.[0]?.complete, true);
});

test("server-only trace gets a synthetic root and completes after 800ms idle", async () => {
  const { store } = make();
  const S = "2".repeat(32);
  const fn = ev({ id: "d".repeat(16), traceId: S, origin: "server", kind: "function", name: "createTodo()", parentId: "e".repeat(16) });
  const http = ev({ id: "e".repeat(16), traceId: S, origin: "server", kind: "http_request", name: "POST /api/todos", http: { method: "POST", url: "/api/todos", status: 201 } });
  const rootId = store.nextAction((r) => r.trigger === "server", 1000);
  store.handle({ type: "events", events: [fn, http] });
  const id = await rootId;
  assert.ok(id);
  const view = store.getAction(id!);
  assert.equal(view?.label, "POST /api/todos (from outside the app)");
  assert.equal(view?.complete, false);
  assert.equal((await store.waitForAction(id!, 3000))?.complete, true);
});

test("a browser loading the page and its files makes no trips; a failing one does", async () => {
  const { store } = make();
  const load = (n: string, path: string, dest: string, status = 200) =>
    ev({ id: n.repeat(16), traceId: n.repeat(32), origin: "server", kind: "http_request", name: `GET ${path}`, status: status >= 500 ? "error" : "ok", http: { method: "GET", url: path, status, reqHeaders: { "sec-fetch-dest": dest } } });
  store.handle({ type: "events", events: [load("3", "/", "document"), load("4", "/a.css", "style"), load("5", "/b.js", "script"), load("6", "/boom", "document", 500)] });
  assert.deepEqual(store.listActions().map((a) => a.label), ["GET /boom (page load)"]);
});

test("nextjs-supabase: a page opened by its address carries the server's render and query, whichever arrives first", async () => {
  for (const docFirst of [true, false]) {
    const { store } = make();
    const t0 = Date.now();
    const nav = ev({ id: "7".repeat(16), traceId: "7".repeat(32), kind: "user_action", name: "Opened /notes", trigger: "navigation", startMs: t0 - 50 });
    const doc = ev({ id: "8".repeat(16), traceId: "8".repeat(32), origin: "server", kind: "http_request", name: "GET /notes", startMs: t0 - 40, http: { method: "GET", url: "/notes", status: 200, reqHeaders: { "sec-fetch-dest": "document" } } });
    const page = ev({ id: "9".repeat(16), traceId: doc.traceId, parentId: doc.id, origin: "server", kind: "function", name: "Page()", startMs: t0 - 30 });
    const late = ev({ id: "a".repeat(16), traceId: doc.traceId, parentId: page.id, origin: "db", kind: "db_query", name: "SELECT * FROM notes", startMs: t0 - 20 });
    store.handle({ type: "events", events: docFirst ? [page, doc, nav] : [nav, page, doc] });
    store.handle({ type: "events", events: [late] });
    await sleep(150);
    const views = store.listActions();
    assert.deepEqual(views.map((a) => a.label), ["Opened /notes"], `docFirst=${docFirst}`);
    const top = views[0]!.tree.map((n) => n.event.name);
    assert.deepEqual(top, ["GET /notes"]);
    assert.deepEqual(views[0]!.tree[0]!.children[0]!.children.map((n) => n.event.name), ["SELECT * FROM notes"]);
  }
  // A page load long before any "Opened" trip stays out.
  const { store } = make();
  store.handle({ type: "events", events: [ev({ id: "b".repeat(16), traceId: "b".repeat(32), origin: "server", kind: "http_request", name: "GET /", startMs: Date.now() - 5000, http: { method: "GET", url: "/", status: 200, reqHeaders: { "sec-fetch-dest": "document" } } })] });
  store.handle({ type: "events", events: [ev({ id: "c".repeat(16), traceId: "c".repeat(32), kind: "user_action", name: "Opened /", trigger: "navigation" })] });
  await sleep(150);
  assert.equal(store.listActions()[0]!.tree.length, 0);
});

test("zero-trace logs land in the always-complete Server output action", async () => {
  const { store } = make();
  store.handle({ type: "events", events: [ev({ id: "f".repeat(16), traceId: ZERO_TRACE, origin: "server", kind: "log", name: "listening", log: { level: "info", message: "listening on 3001" } })] });
  const v = store.getAction(SERVER_OUTPUT_ID);
  assert.equal(v?.label, "Server output");
  assert.equal(v?.trigger, "server");
  assert.equal(v?.complete, true);
  assert.equal(v?.tree.length, 1);
  store.clear();
  assert.equal(store.listActions().length, 0);
});

test("browser request stacks are resolved before the action completes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { store } = make(async () => {
    await gate;
    return "export function createTodo() {}\n";
  });
  const root = ev({ id: "1".repeat(16), kind: "user_action", name: "Clicked", trigger: "click" });
  const req = ev({ id: "2".repeat(16), parentId: root.id, kind: "http_request", name: "POST /api/todos", stack: "Error\n    at createTodo (http://localhost:5173/src/api.ts:12:9)" });
  store.handle({ type: "events", events: [root, req] });
  assert.equal(store.getEvent(req.id)?.stack, undefined);
  store.handle({ type: "action_end", actionId: root.id, at: Date.now() });
  await sleep(700);
  assert.equal(store.getAction(root.id)?.complete, false, "waits for stack resolution");
  release();
  const v = await store.waitForAction(root.id, 2000);
  assert.equal(v?.complete, true);
  assert.equal(v?.tree[0]?.event.source?.file, "src/api.ts");
});

test("a React 19 click's JSX stack resolves to its component's file and survives the closing re-send", async () => {
  const { store } = make(async () => "export function App() {}\n");
  const root = ev({ id: "6".repeat(16), kind: "user_action", name: 'Clicked "Add"', trigger: "click", stack: "Error: react-stack-top-frame\n    at exports.jsxDEV (http://localhost:4510/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)\n    at App (http://localhost:4510/src/App.tsx?t=1:72:13)" });
  store.handle({ type: "events", events: [root] });
  store.handle({ type: "action_end", actionId: root.id, at: Date.now() });
  const { stack: _, ...closed } = root;
  store.handle({ type: "events", events: [{ ...closed, durationMs: 5 }] });
  const v = await store.waitForAction(root.id, 2000);
  assert.deepEqual(v?.root.source && { file: v.root.source.file, line: v.root.source.line }, { file: "src/App.tsx", line: 72 });
  assert.equal(store.getEvent(root.id)?.stack, undefined);
});

test("traces from Shrike's own requests are dropped", async () => {
  const { store } = make();
  const S = "3".repeat(32);
  store.handle({ type: "events", events: [ev({ id: "4".repeat(16), traceId: S, origin: "server", kind: "function", name: "handle()" })] });
  store.handle({ type: "events", events: [ev({ id: "5".repeat(16), traceId: S, origin: "server", kind: "http_request", name: "GET /", http: { method: "GET", url: "/", reqHeaders: { "x-shrike-internal": "1" } } })] });
  assert.equal(store.listActions().length, 0);
  assert.equal(store.getEvent("4".repeat(16)), undefined);
});

test("places: browser root is YOU, browser steps are the page's client lane, the page can't claim others; explorer roots are callers", async () => {
  const { store } = make();
  store.handle({ type: "hello", source: "browser", url: "http://localhost:5180/cart?x=1", at: 1 });
  const root = ev({ id: "7".repeat(16), kind: "user_action", name: 'Clicked "Pay now"', trigger: "click", place: { id: "service:api", kind: "service", name: "API" } });
  const req = ev({ id: "8".repeat(16), parentId: root.id, kind: "http_request", name: "POST /api/checkout" });
  store.handle({ type: "events", events: [root, req] });
  assert.deepEqual(store.getEvent(root.id)?.place, { id: "caller:you", kind: "caller", name: "YOU" });
  assert.deepEqual(store.getEvent(req.id)?.place, { id: "client:http://localhost:5180", kind: "client", name: "WEB · proj", detail: "localhost:5180" });

  const X = "9".repeat(32);
  store.handle({ type: "events", events: [ev({ id: "9".repeat(16), traceId: X, origin: "explorer", kind: "user_action", name: "Sent GET /v1/users", trigger: "explorer" })] });
  const sent = store.getEvent("9".repeat(16));
  assert.deepEqual(sent?.place, { id: "caller:explorer", kind: "caller", name: "EXPLORER" });
  assert.deepEqual(sent?.caller, { kind: "explorer", label: "API explorer" });
});

test("server-only trips start at their caller (curl, cron); unknown callers keep the old label", async () => {
  const { store } = make();
  const http = (n: string, caller?: DebugEvent["caller"]) =>
    ev({ id: n.repeat(16), traceId: n.repeat(32), origin: "server", kind: "http_request", name: "POST /v1/users", place: { id: "service:api", kind: "service", name: "API" }, http: { method: "POST", url: "/v1/users", status: 409 }, ...(caller ? { caller } : {}) });
  store.handle({ type: "events", events: [http("a", { kind: "curl", label: "curl", command: "curl -X POST 'http://localhost:4300/v1/users'" })] });
  store.handle({ type: "events", events: [http("b", { kind: "cron", label: "cron" })] });
  store.handle({ type: "events", events: [http("c", { kind: "other", label: "unknown" })] });
  store.handle({ type: "events", events: [http("d", { kind: "other", label: "nightly" })] });
  const byLabel = Object.fromEntries(store.listActions().map((a) => [a.label, a.root]));
  assert.deepEqual(Object.keys(byLabel).sort(), ["POST /v1/users (from outside the app)", "cron · POST /v1/users", "curl POST /v1/users", "nightly · POST /v1/users"]);
  assert.deepEqual(byLabel["curl POST /v1/users"]!.place, { id: "caller:curl", kind: "caller", name: "CURL" });
  assert.equal(byLabel["curl POST /v1/users"]!.caller?.command, "curl -X POST 'http://localhost:4300/v1/users'");
  assert.equal(byLabel["cron · POST /v1/users"]!.place?.id, "caller:cron");
  assert.equal(byLabel["nightly · POST /v1/users"]!.place?.id, "caller:nightly");
  assert.equal(byLabel["POST /v1/users (from outside the app)"]!.place, undefined);
  assert.equal(byLabel["curl POST /v1/users"]!.trigger, "server");
});

test("declared places rename outside hosts and data targets; a call to one of our services becomes a hop to it", async () => {
  const updates: ActionView[][] = [];
  const declared = { "localhost:4199": { kind: "outside" as const, name: "Stripe (test double)" }, "events.db": { kind: "data" as const, name: "Analytics" }, "localhost:4622": { kind: "data" as const, name: "Postgres" } };
  const store = new Store({ projectRoot: () => "/proj", onUpdate: (v) => updates.push(v), declaredPlaces: () => declared });
  const S = "4".repeat(32);
  const top = ev({ id: "1".repeat(16), traceId: S, origin: "server", kind: "http_request", name: "POST /api/checkout", place: { id: "service:api", kind: "service", name: "API", detail: "localhost:4100" } });
  const pay = ev({ id: "2".repeat(16), traceId: S, parentId: top.id, origin: "server", kind: "external_call", name: "POST localhost:4199/v1/charges", place: { id: "outside:localhost:4199", kind: "outside", name: "LOCALHOST:4199", detail: "127.0.0.1:4199" } });
  const db = ev({ id: "3".repeat(16), traceId: S, parentId: top.id, origin: "db", kind: "db_query", name: "INSERT INTO events", place: { id: "data:sqlite:events.db", kind: "data", name: "SQLITE · events.db" } });
  const toAuth = ev({ id: "4".repeat(16), traceId: S, parentId: top.id, origin: "server", kind: "external_call", name: "POST localhost:4101/verify", place: { id: "outside:localhost:4101", kind: "outside", name: "LOCALHOST:4101", detail: "localhost:4101" } });
  const pg = ev({ id: "7".repeat(16), traceId: S, parentId: top.id, origin: "db", kind: "db_query", name: "INSERT INTO orders", place: { id: "data:postgres:localhost:4622/edge", kind: "data", name: "POSTGRES · edge", detail: "localhost:4622/edge" } });
  store.handle({ type: "events", events: [top, pay, db, toAuth, pg] });
  assert.deepEqual(store.getEvent(pg.id)?.place, { id: "data:localhost:4622", kind: "data", name: "Postgres", detail: "localhost:4622/edge" }, "a database on a declared host joins its lane");
  assert.deepEqual(store.getEvent(pay.id)?.place, { id: "outside:localhost:4199", kind: "outside", name: "Stripe (test double)", detail: "127.0.0.1:4199" });
  assert.deepEqual(store.getEvent(db.id)?.place, { id: "data:events.db", kind: "data", name: "Analytics", detail: "events.db" });
  // auth reports in after the call that reached it
  const auth = ev({ id: "5".repeat(16), traceId: S, parentId: toAuth.id, origin: "server", kind: "http_request", name: "POST /verify", place: { id: "service:auth", kind: "service", name: "AUTH", detail: "localhost:4101" } });
  store.handle({ type: "events", events: [auth] });
  const view = store.listActions()[0]!;
  const places = (n: ActionView["tree"]): string[] => n.flatMap((x) => [`${x.event.name}@${x.event.place?.id}`, ...places(x.children)]);
  assert.ok(places(view.tree).includes("POST localhost:4101/verify@service:auth"), places(view.tree).join("\n"));
  assert.ok(places(view.tree).includes("POST /verify@service:auth"));
});

test("declared places fall back to .shrike/config.json", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "shrike-store-"));
  mkdirSync(join(root, ".shrike"));
  writeFileSync(join(root, ".shrike/config.json"), JSON.stringify({ places: { "localhost:4199": { kind: "outside", name: "Stripe (test double)" } } }));
  const store = new Store({ projectRoot: () => root, onUpdate: () => {} });
  const e = ev({ id: "6".repeat(16), traceId: "6".repeat(32), origin: "server", kind: "external_call", name: "POST", place: { id: "outside:localhost:4199", kind: "outside", name: "LOCALHOST:4199", detail: "localhost:4199" } });
  store.handle({ type: "events", events: [e] });
  assert.equal(store.getEvent(e.id)?.place?.name, "Stripe (test double)");
});

test("a cron script's own outgoing call starts its trip; the API's side joins it", async () => {
  const { store } = make();
  const C = "c".repeat(32);
  const api = ev({ id: "b".repeat(16), traceId: C, parentId: "a".repeat(16), origin: "server", kind: "http_request", name: "POST /v1/users", place: { id: "service:api", kind: "service", name: "API", detail: "localhost:4300" } });
  const call = ev({ id: "a".repeat(16), traceId: C, origin: "server", kind: "external_call", name: "POST localhost:4300/v1/users", http: { method: "POST", url: "http://localhost:4300/v1/users?x=1" }, caller: { kind: "cron", label: "cron" }, place: { id: "outside:localhost:4300", kind: "outside", name: "LOCALHOST:4300", detail: "localhost:4300" } });
  store.handle({ type: "events", events: [api] });
  assert.equal(store.listActions().length, 0);
  store.handle({ type: "events", events: [call] });
  const [view] = store.listActions();
  assert.equal(view?.label, "cron · POST /v1/users");
  assert.equal(view?.root.place?.id, "caller:cron");
  assert.equal(view?.tree[0]?.event.place?.id, "service:api", "the call to our own API is a hop to it");
  assert.equal(view?.tree[0]?.children[0]?.event.id, api.id);
});

test("a cross-origin call's server side joins the click, its answered CORS preflight is dropped and a refused one kept; the page's own database calls keep their lane", async () => {
  const { store } = make();
  store.handle({ type: "hello", source: "browser", url: "http://localhost:13007/todos", at: 1 });
  const root = ev({ id: "a1".repeat(8), kind: "user_action", name: 'Clicked "Add"', trigger: "click" });
  const fetchId = "a2".repeat(8);
  const early = ev({ id: fetchId, parentId: root.id, kind: "http_request", name: "POST http://localhost:13006/rpc/todo/create", http: { method: "POST", url: "http://localhost:13006/rpc/todo/create" } });
  store.handle({ type: "events", events: [root, early] });
  const S = "5".repeat(32);
  const P = "6".repeat(32);
  const server = (id: string, traceId: string, method: string, h: Record<string, string> = {}) =>
    ev({ id, traceId, origin: "server", kind: "http_request", name: `${method} /rpc/todo/create`, http: { method, url: "/rpc/todo/create", status: 200, reqHeaders: { host: "127.0.0.1:13006", origin: "http://localhost:13007", ...h } } });
  const insert = ev({ id: "a3".repeat(8), traceId: S, parentId: "a4".repeat(8), origin: "server", kind: "db_query", name: "insert", db: { system: "postgres", statement: 'insert into "todo"' } });
  store.handle({ type: "events", events: [server("a5".repeat(8), P, "OPTIONS", { "access-control-request-method": "POST" })] });
  store.handle({ type: "events", events: [insert] });
  store.handle({ type: "events", events: [server("a4".repeat(8), S, "POST")] });
  store.handle({ type: "events", events: [ev({ id: "a6".repeat(8), traceId: S, parentId: "a4".repeat(8), origin: "server", kind: "function", name: "create()" })] });
  const data = ev({ id: "a7".repeat(8), parentId: root.id, kind: "db_query", name: "SELECT", db: { system: "postgres", statement: "SELECT * FROM notes" }, place: { kind: "data", id: "data:supabase:localhost:15421", name: "SUPABASE · localhost:15421" } });
  const sneaky = ev({ id: "a8".repeat(8), parentId: root.id, kind: "http_request", name: "GET /x", place: { kind: "data", id: "data:x", name: "X" } });
  store.handle({ type: "events", events: [data, sneaky] });

  assert.deepEqual(store.listActions().map((a) => a.label), ['Clicked "Add"'], "no '(from outside the app)' trips");
  const v = store.getAction(root.id)!;
  const fetchNode = v.tree.find((n) => n.event.id === fetchId)!;
  assert.deepEqual(fetchNode.children.map((c) => c.event.http?.method), ["POST"], "the answered preflight is not a station");
  assert.equal(store.getEvent("a5".repeat(8)), undefined);
  const post = fetchNode.children.find((c) => c.event.http?.method === "POST")!;
  assert.deepEqual(post.children.map((c) => c.event.name).sort(), ["create()", "insert"]);
  assert.equal(store.getEvent("a6".repeat(8))?.traceId, T, "later server events follow the join");
  assert.equal(store.getEvent(data.id)?.place?.id, "data:supabase:localhost:15421");
  assert.equal(store.getEvent(sneaky.id)?.place?.kind, "client");
  // A refused preflight is the story (the browser never sends the call): it stays on the fetch.
  const fetch2 = ev({ id: "b2".repeat(8), parentId: root.id, kind: "http_request", name: "POST http://localhost:13006/rpc/todo/create", http: { method: "POST", url: "http://localhost:13006/rpc/todo/create" } });
  store.handle({ type: "events", events: [fetch2] });
  const refused = server("b5".repeat(8), "7".repeat(32), "OPTIONS", { "access-control-request-method": "POST" });
  refused.http!.status = 400;
  store.handle({ type: "events", events: [refused] });
  assert.equal(store.getEvent(refused.id)?.traceId, T, "joined to the click");
});

test("floods stay bounded: a trip keeps MAX_TRIP_EVENTS, a note and later errors; old trips go first, a waited one stays; bodies are cut", async () => {
  const { store } = make();
  const root = ev({ id: "f".repeat(16), kind: "user_action", name: "Clicked", trigger: "click" });
  store.handle({ type: "events", events: [root] });
  const waited = store.waitForAction(root.id, 5000);
  const fns = Array.from({ length: MAX_TRIP_EVENTS + 1000 }, (_, i) => ev({ id: `fn${i}`.padStart(16, "0"), parentId: root.id, origin: "server", kind: "function", name: `f${i}()` }));
  store.handle({ type: "events", events: fns });
  store.handle({ type: "events", events: [ev({ id: "e".repeat(16), parentId: root.id, origin: "server", kind: "error", name: "Boom", status: "error" })] });
  assert.equal(store.getAction(root.id)!.summary.stats.functions, MAX_TRIP_EVENTS - 1);
  assert.ok(store.getEvent("e".repeat(16)), "an error past the cap is still kept");
  assert.match(store.searchEvents("too many steps")[0]?.log?.message ?? "", /kept the first 5,000 and skipped 1,001 more/);

  const big = "x".repeat(200_000);
  for (let i = 0; i < MAX_TRIPS + 50; i++) {
    const tr = (i + 16).toString(16).padStart(32, "0");
    store.handle({ type: "events", events: [ev({ id: `s${i}`.padStart(16, "0"), traceId: tr, origin: "server", kind: "http_request", name: "GET /poll", http: { method: "GET", url: "/poll", status: 200, resBody: big } })] });
  }
  assert.ok(store.listActions().length <= MAX_TRIPS);
  assert.ok(store.getAction(root.id), "the trip an agent waits on is never dropped");
  assert.equal(store.getEvent("s0".padStart(16, "0")), undefined, "the oldest trip went first");
  const body = store.getEvent(`s${MAX_TRIPS + 49}`.padStart(16, "0"))!.http!.resBody!;
  assert.ok(body.length < 70_000 && body.endsWith("…[truncated]"));
  store.handle({ type: "action_end", actionId: root.id, at: Date.now() });
  assert.equal((await waited)?.complete, true);
});

test("#51: live events lose personal data with placeholders stable across the trip; local events keep theirs", () => {
  const { store } = make();
  const root = ev({ id: "d".repeat(16), kind: "user_action", name: 'Clicked "Orders"', trigger: "click", live: true });
  const list = ev({ id: "e".repeat(16), parentId: root.id, kind: "http_request", name: "GET /api/orders", live: true, http: { method: "GET", url: "/api/orders", status: 200, resBody: '[{"email":"ada@example.com","phone":"+44 20 7946 0958"},{"email":"bob@example.com"}]' } });
  const send = ev({ id: "f".repeat(16), parentId: root.id, kind: "http_request", name: "POST /api/notify", live: true, http: { method: "POST", url: "/api/notify?to=bob%40example.com", status: 202 } });
  store.handle({ type: "events", events: [root, list, send] });
  assert.equal(store.getEvent(list.id)!.http!.resBody, '[{"email":"[email#1]","phone":"[phone#1]"},{"email":"[email#2]"}]');
  assert.equal(store.getEvent(send.id)!.http!.url, "/api/notify?to=[email#2]", "the same address keeps its number in a later event");

  const local = ev({ id: "9".repeat(16), traceId: "9".repeat(32), kind: "http_request", name: "GET /api/orders", http: { method: "GET", url: "/api/orders", status: 200, resBody: '[{"email":"ada@example.com"}]' } });
  store.handle({ type: "events", events: [local] });
  assert.equal(store.getEvent(local.id)!.http!.resBody, '[{"email":"ada@example.com"}]', "local debugging needs the real values");
  store.clear();
});
