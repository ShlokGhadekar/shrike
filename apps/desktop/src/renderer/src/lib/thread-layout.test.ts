import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionView, DebugEvent, TimelineNode } from "@shrike/schema";
import { buildTrip, layoutTrip, glyphPath, lanesFor, laneColumns, touchedBy, fitHead, LANE_X, SLIVER } from "./thread-layout.ts";

let n = 0;
const ev = (p: Partial<DebugEvent>): DebugEvent => ({ id: (++n).toString(16).padStart(16, "0"), traceId: "t".repeat(32), origin: "server", kind: "function", name: "f()", startMs: n, status: "ok", ...p });
const node = (event: DebugEvent, children: TimelineNode[] = []): TimelineNode => ({ event, children });
const view = (root: DebugEvent, tree: TimelineNode[], status: ActionView["status"]): ActionView => ({
  id: root.id, traceId: root.traceId, trigger: "click", label: root.name, startMs: 0, durationMs: 15, status, complete: true, tree, root,
  summary: { headline: "", steps: [], stats: { files: 0, functions: 0, requests: 0, queries: 0, logs: 0, errors: 0, totalMs: 15 } }, flags: [],
});
const src = (file: string, line: number) => ({ file, line, precision: "exact" as const });

test("killer demo: snaps at the database, chip shows userId undefined, shape db_refused", () => {
  const root = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Add Todo"', trigger: "click", source: src("src/TodoForm.tsx", 31) });
  const insert = ev({ startMs: 60, kind: "db_query", origin: "db", name: "INSERT", db: { system: "sqlite", statement: "INSERT INTO todos (title, user_id) VALUES (?, ?)" }, status: "error", error: { message: "NOT NULL constraint failed: todos.user_id" }, source: src("server/db.ts", 36) });
  const insertTodo = ev({ startMs: 50, name: "insertTodo()", status: "error", error: { message: "NOT NULL constraint failed: todos.user_id" }, args: ["{ title: 'buy milk', userId: undefined }"], source: src("server/db.ts", 33), callSite: src("server/todos.controller.ts", 18) });
  const log = ev({ startMs: 40, kind: "log", name: "log", log: { level: "info", message: "creating todo { title: 'buy milk' }" }, source: src("server/todos.controller.ts", 16) });
  const createTodo = ev({ startMs: 30, name: "createTodo()", status: "error", error: { message: "NOT NULL constraint failed: todos.user_id" }, args: ["req { POST /api/todos }", "res"], source: src("server/todos.controller.ts", 14) });
  const serverReq = ev({ startMs: 20, kind: "http_request", name: "POST /api/todos", http: { method: "POST", url: "/api/todos", status: 500 }, status: "error" });
  const browserReq = ev({ startMs: 10, kind: "http_request", origin: "browser", name: "POST /api/todos", http: { method: "POST", url: "/api/todos", status: 500, reqBody: '{"title":"buy milk","userId":1}' }, status: "error", source: src("src/api.ts", 12) });
  const v = view(root, [node(browserReq, [node(serverReq, [node(createTodo, [node(log), node(insertTodo, [node(insert)])])])])], "error");
  const trip = buildTrip(v);
  const snap = trip.stations.filter((s) => s.snap);
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.lane, "data:database");
  assert.equal(trip.shape, "db_refused");
  assert.equal(trip.returned, "Server error (500)");
  const it = trip.stations.find((s) => s.label === "insertTodo()")!;
  assert.equal(it.chipError, true);
  assert.match(it.chip!, /userId: undefined/);
  assert.equal(it.where, "called at todos.controller.ts:18");
  assert.deepEqual(trip.stations.map((s) => s.lane), ["client:page", "client:page", "service:server", "service:server", "service:server", "service:server", "data:database"]);
  // Plain words: who passed the bad value, what the failure only went through, what the database meant.
  assert.equal(it.caption, "createTodo() passed userId: undefined to insertTodo().");
  assert.equal(trip.stations.find((s) => s.label === "createTodo()")!.caption, "createTodo() stopped because insertTodo() failed.");
  assert.equal(snap[0]!.caption, "The database refused: NOT NULL constraint failed. The todo had no user.");
  assert.equal(trip.verdict, snap[0]!.caption);
  const lg = trip.stations.find((s) => s.kind === "log")!;
  assert.deepEqual([lg.label, lg.chip], ['log "creating todo"', "{ title: 'buy milk' }"]);
  assert.equal(trip.stations.find((s) => s.label.startsWith("fetch"))!.chip, '{ title: "buy milk", userId: 1 }');
  const g = layoutTrip(trip, 1000);
  assert.ok(g.out.startsWith("M 100 "));
  assert.ok(g.stations.every((s, i, a) => i === 0 || s.y > a[i - 1]!.y), "time runs downward");
  assert.ok(glyphPath(trip).startsWith("M 3 2"));
});

test("a form submitted with Enter starts at onSubmit, a button at onClick", () => {
  const root = (trigger: "click" | "submit") => ev({ kind: "user_action", origin: "browser", name: "x", trigger, source: src("web/src/App.tsx", 56) });
  for (const [trigger, label] of [["submit", "onSubmit"], ["click", "onClick"]] as const) assert.equal(buildTrip(view(root(trigger), [], "ok")).stations[0]?.label, label);
});

test("repeated queries coil, worked trip, never-left-page trip", () => {
  const root = ev({ kind: "user_action", origin: "browser", name: "Opened /", trigger: "navigation" });
  const q = () => node(ev({ kind: "db_query", origin: "db", name: "SELECT", db: { system: "sqlite", statement: "SELECT * FROM users WHERE id = 3" }, durationMs: 7 }));
  const list = ev({ name: "listTodos()", source: src("server/todos.controller.ts", 5) });
  const req = ev({ kind: "http_request", origin: "browser", name: "GET /api/todos", http: { method: "GET", url: "/api/todos", status: 200 }, source: src("src/api.ts", 5) });
  const vite = node(ev({ kind: "log", origin: "browser", name: "log", log: { level: "debug", message: "[vite] connecting..." } }));
  const trip = buildTrip(view(root, [vite, node(req, [node(ev({ kind: "http_request", name: "GET", http: { method: "GET", url: "/api/todos", status: 200 } }), [node(list, [q(), q(), q(), q()])])])], "ok"));
  const coil = trip.stations.find((s) => s.count === 4)!;
  assert.equal(coil.lane, "data:database");
  assert.equal(trip.shape, "repeated");
  assert.equal(trip.returned, "Server replied OK (200)");
  assert.ok(!trip.stations.some((s) => s.kind === "log"), "dev-server chatter is not a station");

  // Real instrumentation wraps the query in functions: withOwner() > getUser() > SELECT, once per todo.
  const owner = () => node(ev({ name: "withOwner()", source: src("server/todos.list.ts", 4) }), [node(ev({ name: "getUser()", source: src("server/db.ts", 29) }), [q()])]);
  const t3 = buildTrip(view(root, [node(req, [node(ev({ kind: "http_request", name: "GET", http: { method: "GET", url: "/api/todos", status: 200 } }), [node(list, [owner(), owner(), owner(), owner()])])])], "ok"));
  assert.deepEqual(t3.stations.filter((s) => s.count).map((s) => [s.label, s.count]), [["withOwner()", 4], ["getUser()", 4], ["SELECT * FROM users WHERE id = 3", 4]]);
  assert.equal(t3.shape, "repeated");

  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Save"', trigger: "click", source: src("src/Form.tsx", 9) });
  const handler = ev({ origin: "browser", name: "onSave()", source: src("src/Form.tsx", 4) });
  const t2 = buildTrip(view(click, [node(handler)], "ok"));
  assert.equal(t2.shape, "never_left_page");
  assert.equal(t2.returned, "Your page never called the server");
});

test("slow trip blames the steps' own time and marks them; unseen server and page errors read plainly", () => {
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Load dashboard"', trigger: "click", source: src("src/Dash.tsx", 9) });
  const stats = ev({ name: "fetchStats()", startMs: 100, durationMs: 302, source: src("server/dash.ts", 4) });
  const act = ev({ name: "fetchActivity()", startMs: 403, durationMs: 302, source: src("server/dash.ts", 8) });
  const dash = ev({ name: "getDashboard()", durationMs: 605, source: src("server/dash.ts", 12) });
  const sreq = ev({ kind: "http_request", name: "GET", durationMs: 606, http: { method: "GET", url: "/api/dashboard", status: 200 } });
  const breq = ev({ kind: "http_request", origin: "browser", name: "GET", durationMs: 609, http: { method: "GET", url: "/api/dashboard", status: 200 }, source: src("src/api.ts", 30) });
  const handler = ev({ origin: "browser", name: "onClick", durationMs: 609, source: src("src/Dash.tsx", 9) });
  const slow = buildTrip({ ...view(click, [node(handler, [node(breq, [node(sreq, [node(dash, [node(stats), node(act)])])])])], "slow"), durationMs: 609 });
  assert.equal(slow.shape, "slow");
  assert.equal(slow.verdict, "Most of the 609ms was spent in fetchStats() and fetchActivity().");
  assert.deepEqual(slow.stations.filter((s) => s.status === "slow").map((s) => s.label), ["fetchStats()", "fetchActivity()"]);

  const opened = ev({ kind: "user_action", origin: "browser", name: "Opened /", trigger: "navigation" });
  const fetchOnly = ev({ kind: "http_request", origin: "browser", name: "GET", http: { method: "GET", url: "/api/todos", status: 200 }, source: src("src/api.ts", 5) });
  const blind = buildTrip(view(opened, [node(fetchOnly)], "ok"));
  assert.equal(blind.returned, "Server replied OK (200)");
  assert.doesNotMatch(blind.verdict, /never called/);

  const thrown = ev({ kind: "error", origin: "browser", name: "Cannot read properties of null (reading 'foo')", status: "error", error: { message: "Cannot read properties of null (reading 'foo')" } });
  const bad = buildTrip(view(ev({ kind: "user_action", origin: "browser", name: 'Clicked "Throw"', trigger: "click", source: src("index.html", 3) }), [node(thrown)], "error"));
  assert.ok(bad.stations.some((s) => s.label === "uncaught error"));
  assert.match(bad.verdict, /^Your page's code threw an error: Cannot read properties of null/);
});

// ---------------------------------------------------------------- discovered lanes (docs/12-feature-map.md)

import type { Place } from "@shrike/schema";
import { cronNightly, curlSignup, ordersLoad, P, payNow } from "../thread/fixtures.ts";

const addTodo = (places?: { server: Place; db: Place }) => {
  const pl = <T extends Partial<DebugEvent>>(e: T, p?: Place) => (p ? { ...e, place: p } : e);
  const root = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Add Todo"', trigger: "click", source: src("src/TodoForm.tsx", 31) });
  const insert = ev(pl({ startMs: 60, kind: "db_query", origin: "db", name: "INSERT", db: { system: "sqlite", statement: "INSERT INTO todos (title, user_id) VALUES (?, ?)" }, status: "error", error: { message: "NOT NULL constraint failed: todos.user_id" } } as const, places?.db));
  const create = ev(pl({ startMs: 30, name: "createTodo()", status: "error", source: src("server/todos.controller.ts", 14) } as const, places?.server));
  const sreq = ev(pl({ startMs: 20, kind: "http_request", name: "POST /api/todos", http: { method: "POST", url: "/api/todos", status: 500 }, status: "error" } as const, places?.server));
  const breq = ev({ startMs: 10, kind: "http_request", origin: "browser", name: "POST /api/todos", http: { method: "POST", url: "/api/todos", status: 500 }, status: "error", source: src("src/api.ts", 12) });
  return buildTrip(view(root, [node(breq, [node(sreq, [node(create, [node(insert)])])])], "error"));
};

test("todo look is protected: SCREEN, PAGE, SERVER, DATABASE at the approved x, with or without place info", () => {
  for (const t of [addTodo(), addTodo({ server: { id: "service:app", kind: "service", name: "APP" }, db: { id: "data:sqlite:todos.db", kind: "data", name: "SQLITE · todos.db" } })]) {
    const lanes = lanesFor([t], [{ id: "service:app", kind: "service", name: "APP" }]);
    assert.deepEqual(lanes.map((l) => l.label), ["YOU", "PAGE", "SERVER", "DATABASE"]);
    assert.ok(lanes.every((l) => !l.ghost));
    for (const w of [540, 777, 1000, 1280]) {
      const cols = laneColumns(lanes, touchedBy(t), w);
      assert.deepEqual(cols.cols.map((c) => c.x), LANE_X.map((f) => Math.round(w * f)), `width ${w}`);
      assert.deepEqual(layoutTrip(t, w).stations.map((s) => s.x - s.sub * 30), [1, 1, 2, 2, 3].map((i) => Math.round(w * LANE_X[i]!)));
    }
    assert.equal(layoutTrip(t, 1000).stations[4]!.left, true, "database labels go left");
  }
  // An expected place the fallback lane probably is stays hidden; a new kind shows as a ghost.
  const ghosts = lanesFor([addTodo()], [{ id: "service:app", kind: "service", name: "APP" }, { id: "cache:redis", kind: "cache", name: "REDIS · cache" }]);
  assert.deepEqual(ghosts.filter((l) => l.ghost).map((l) => l.label), ["REDIS · cache"]);
});

test("shop Pay now: crossing, cache hit bounce, fork, snap at Stripe, plain words", () => {
  const t = buildTrip(payNow(0));
  const lanes = lanesFor([t]);
  assert.deepEqual(lanes.map((l) => l.label), ["YOU", "PAGE", "API", "AUTH", "PAYMENTS", "LRU · sessions", "POSTGRES · orders", "SQLITE · events.db", "Stripe (test double)"]);
  assert.deepEqual(lanes.map((l) => l.hop).slice(2, 5), [0, 1, 1]);
  const by = (label: string) => t.stations.find((s) => s.label === label)!;
  assert.equal(by("fetch POST /verify").lane, "service:api", "the outgoing call starts in the caller's lane");
  assert.equal(by("POST /verify").lane, "service:auth", "T19 crossing");
  assert.equal(by("POST /verify").caption, "The auth service got POST /verify: OK (200)");
  assert.equal(by("hit").cache, "hit");
  assert.equal(by("hit").caption, "Asked the cache for session:91. It had it.");
  const stripe = t.stations.find((s) => s.lane === P.stripe.id)!;
  assert.equal(stripe.snap, true);
  assert.equal(stripe.caption, "Called Stripe (test double): Bad request (400). Amount must be at least 50 cents.");
  assert.equal(t.shape, "outside_refused");
  assert.equal(t.verdict, "Stripe (test double) refused: amount must be at least 50 cents.");
  assert.deepEqual(t.forks.map((f) => f.caption), ["Did 2 things at the same time: charged the card and saved the event."]);
  assert.equal(by("saveEvent()").caption, t.forks[0]!.caption);
  assert.equal(by("chargeCard()").fork?.main, true);
  assert.match(by("createCharge()").caption, /^createCharge\(\) sent .+ to Stripe \(test double\), which refused: Amount must be at least 50 cents\.$/, "the call that sent the refused request names it");

  const g = layoutTrip(t, 1200);
  const at = (label: string) => g.stations.find((s) => s.label === label)!;
  assert.equal(at("chargeCard()").y, at("saveEvent()").y, "T17: branches start on the same row");
  assert.equal(g.forks.length, 1);
  assert.ok(g.forks[0]!.label);
  const hit = at("hit");
  const i = g.outPts.findIndex(([x, y]) => x === hit.x && y === hit.y);
  assert.ok(i > 0 && g.outPts[i + 1]![1] === hit.y && g.outPts[i + 1]![0] < hit.x, "T15: the thread pokes into the cache and comes straight back");
  assert.ok(isFinite(at("INSERT INTO events (kind, data) VALUES (?, ?)").reach), "the side branch still draws when the main one snaps");
  assert.deepEqual(g.outPts[g.outPts.length - 1], [g.stations.find((s) => s.snap)!.x, g.stations.find((s) => s.snap)!.y], "the thread stops at the snap");
  assert.ok(g.stations.filter((s) => !s.fork).every((s, k, a) => k === 0 || s.y > a[k - 1]!.y), "time runs downward");
});

test("cache miss passes through and fills; a later hit bounces; lanes stay put as trips arrive", () => {
  const miss = buildTrip(ordersLoad(0, false));
  assert.deepEqual(miss.stations.map((s) => s.cache).filter(Boolean), ["miss", "set"]);
  assert.equal(miss.stations.find((s) => s.cache === "miss")!.caption, "The cache didn't have orders:7, so it asked the database.");
  assert.equal(miss.stations.find((s) => s.cache === "set")!.caption, "Saved orders:7 in the cache.");
  assert.equal(miss.shape, "worked");
  const mg = layoutTrip(miss, 1200);
  const set = mg.stations.find((s) => s.cache === "set")!;
  const poke = mg.outPts[mg.outPts.findIndex(([x, y]) => x === set.x && y === set.y) + 1]!;
  assert.deepEqual(poke, [mg.stations.find((s) => s.label === "listOrders()")!.x, set.y], "the fill pokes back to the code that wrote it");
  const hit = buildTrip(ordersLoad(100, true));
  assert.equal(hit.stations.find((s) => s.cache)!.cache, "hit");
  const pay = buildTrip(payNow(200));
  const before = lanesFor([miss, hit]).map((l) => l.id);
  const after = lanesFor([miss, hit, pay]).map((l) => l.id);
  assert.deepEqual(after.filter((id) => before.includes(id)), before, "only slot in, never reorder");

  // Two reads, no hits: the cache never helped.
  const twice = ordersLoad(300, false);
  twice.tree[0]!.children[0]!.children[0]!.children.push(...ordersLoad(400, false).tree[0]!.children[0]!.children[0]!.children.map((c) => ({ ...c, event: { ...c.event, cache: c.event.cache && { ...c.event.cache, key: "orders:8" } } })));
  assert.equal(buildTrip(twice).shape, "cache_never_hit");
});

test("backend-only callers: curl 409 from sqlite, cron with a slow outside call (T20)", () => {
  const curl = buildTrip(curlSignup(0));
  assert.equal(curl.caller.browser, false);
  assert.match(curl.caller.text, /^\$ curl -X POST localhost:4300\/api\/signup/);
  assert.deepEqual(lanesFor([curl]).map((l) => l.label), ["CURL", "API-ONLY", "DATABASE"], "a service the user named keeps its name, even alone");
  // the single-command default ("app") still reads SERVER
  const asApp = lanesFor([{ ...curl, places: curl.places.map((p) => (p.place.kind === "service" ? { ...p, place: { ...p.place, id: "service:app", name: "APP" } } : p)) }]);
  assert.deepEqual(asApp.map((l) => l.label), ["CURL", "SERVER", "DATABASE"]);
  assert.equal(curl.shape, "db_refused");
  assert.equal(curl.verdict, "The database refused: UNIQUE constraint failed. A user with that email already exists.");
  assert.equal(curl.returned, "Conflict (409)");
  const cron = buildTrip(cronNightly(0));
  assert.equal(cron.caller.text, "cron · nightly 02:00\n$ node src/nightly.ts");
  assert.equal(cron.caller.place.name, "CRON");
  assert.equal(cron.shape, "slow_outside");
  assert.equal(cron.verdict, "Postmark took 401ms of the 412ms.");
  assert.equal(cron.returned, "It finished");
  const g = layoutTrip(cron, 1000);
  assert.ok(g.stations.find((s) => s.kind === "external_call")!.x > g.stations.find((s) => s.kind === "db_query")!.x, "outside sits right of data");
});

test("a queue's delivery to a subscriber starts in the QUEUE lane, not a SERVER lane", () => {
  const Q = { id: "queue:localhost:4408", kind: "queue" as const, name: "QUEUE · order-events", detail: "localhost:4408" };
  const N = { id: "service:notifications", kind: "service" as const, name: "NOTIFICATIONS", detail: "localhost:4407" };
  const root = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Place order"', trigger: "click" });
  const qReq = ev({ kind: "http_request", name: "POST /topics/order.placed/messages", http: { method: "POST", url: "/topics/order.placed/messages", status: 202 }, place: Q });
  const deliver = ev({ name: "deliver()", place: Q, source: src("services/queue/src/broker/deliver.ts", 9) });
  const call = ev({ kind: "external_call", name: "POST", http: { method: "POST", url: "http://localhost:4407/events/order-placed", status: 200 }, place: N, durationMs: 5 });
  const nReq = ev({ kind: "http_request", name: "POST /events/order-placed", http: { method: "POST", url: "/events/order-placed", status: 200 }, place: N });
  const trip = buildTrip(view(root, [node(qReq, [node(deliver, [node(call, [node(nReq)])])])], "ok"));
  assert.equal(trip.stations.find((s) => s.kind === "external_call")!.lane, Q.id);
  assert.deepEqual([...new Set(trip.stations.map((s) => s.lane))], [Q.id, N.id]);
});

test("accordion: untouched lanes are slivers, more than 6 touched lanes of a kind fold into a group", () => {
  const pay = buildTrip(payNow(0));
  const curl = buildTrip(curlSignup(10));
  const lanes = lanesFor([pay, curl]);
  const cols = laneColumns(lanes, touchedBy(curl), 1000);
  const full = cols.cols.filter((c) => c.mode === "full").map((c) => c.label);
  assert.deepEqual(full, ["CURL", "API-ONLY", "SQLITE · app.db"]);
  assert.ok(cols.cols.filter((c) => c.mode === "sliver").every((c) => c.w === SLIVER));
  assert.ok(Math.abs(cols.cols.reduce((a, c) => a + c.w, 0) - 1000 * 1.01) < 1e-6 || cols.cols[cols.cols.length - 1]!.mode === "sliver");
  assert.ok(cols.cols.every((c, i, a) => i === 0 || c.x > a[i - 1]!.x), "lines left to right");

  const many = Array.from({ length: 8 }, (_, i): Place => ({ id: `service:s${i}`, kind: "service", name: `S${i}` }));
  const fake = { ...pay, places: [{ place: pay.caller.place, hop: 0 }, ...many.map((place, hop) => ({ place, hop }))], stations: many.map((p, i) => ({ ...pay.stations[0]!, id: String(i), lane: p.id, place: p })) };
  const grouped = laneColumns(lanesFor([fake]), touchedBy(fake), 1000);
  assert.deepEqual(grouped.cols.map((c) => c.label), ["YOU", "8 services"]);
  assert.equal(new Set(many.map((p) => grouped.x[p.id])).size, 1);
  assert.equal(laneColumns(lanesFor([fake]), touchedBy(fake), 1000, new Set(["service"])).cols.length, 9);
  assert.ok(glyphPath(pay).startsWith("M 3 2"));
});

test("parallel page-load fetches: long side branches fold to one express station each, rows never overlap; inline callbacks and two quick repeats aren't waste", () => {
  const root = ev({ kind: "user_action", origin: "browser", name: "Opened /", trigger: "navigation" });
  const branch = (path: string, t: number, depth: number) => {
    const fns = Array.from({ length: depth }, (_, k) => ev({ startMs: t + 2 + k, durationMs: 1, name: `step${k}()`, args: [`'${path}'`] }));
    let inner: TimelineNode[] = [];
    for (const f of fns.reverse()) inner = [node(f, inner)];
    const server = ev({ startMs: t + 1, durationMs: 8, kind: "http_request", name: `GET ${path}`, http: { method: "GET", url: path, status: 200 } });
    return node(ev({ startMs: t, durationMs: 10 + depth, kind: "http_request", origin: "browser", name: `GET ${path}`, http: { method: "GET", url: path, status: 200 } }), [node(server, inner)]);
  };
  const v = view(root, [branch("/api/cart", 1, 6), branch("/api/orders", 1.5, 8), branch("/api/cart", 2, 6)], "ok");
  const trip = buildTrip(v);
  const folded = trip.stations.filter((s) => s.kind === "express" && s.fork && !s.fork.main);
  assert.equal(folded.length, 2);
  assert.match(folded[0]!.label, /^fetch GET \/api\/cart · \d+ steps$/);
  assert.equal(trip.stations.filter((s) => s.fork?.main).length, 10, "the deepest branch draws in full");
  const g = layoutTrip(trip, 1200);
  const ys = g.stations.map((s) => s.y);
  assert.equal(new Set(ys).size, ys.length, "every station has its own row");
  assert.equal(g.forks.filter((f) => f.folded).length, 2);
  const open = buildTrip(v, new Set([folded[0]!.id]));
  assert.equal(open.stations.filter((s) => s.kind === "express" && s.fork && !s.fork.main).length, 1, "Enter opens one");

  const cart = ev({ name: "loadCart()", startMs: 1, durationMs: 3 });
  const cb = (k: number) => ev({ name: "map callback()", startMs: 2 + k, durationMs: 0.1 });
  const sum = (k: number) => ev({ name: "total()", startMs: 3 + k, durationMs: 0.1, source: src("db.ts", 26) });
  const t2 = buildTrip(view(root, [node(cart, [node(cb(0)), node(cb(0.2)), node(sum(0)), node(sum(0.2))])], "ok"));
  assert.ok(!t2.stations.some((s) => s.label.includes("callback")));
  const tot = t2.stations.find((s) => s.label === "total()")!;
  assert.equal(tot.count, 2);
  assert.equal(tot.status, "ok", "two quick calls are just two calls");
});

test("fork labels: a left label on a near row starts after the right label beside it (shop Pay now)", () => {
  const trip = buildTrip(payNow(0));
  for (const w of [700, 820, 1000, 1300]) {
    const g = layoutTrip(trip, w);
    const est = (s: (typeof g.stations)[number]) => Math.min(s.room, Math.max(s.label.length * 7.6, [s.where, `${Math.round(s.ms)}ms`].filter(Boolean).join(" · ").length * 6.9));
    const insert = g.stations.find((s) => s.label.startsWith("INSERT INTO events"))!;
    const save = g.stations.find((s) => s.label === "saveEvent()")!;
    assert.ok(Math.abs(insert.y - save.y) < 40, "the side branch's rows are close");
    if (!insert.left) continue;
    assert.ok(insert.x - 18 - insert.room >= save.x + 18 + est(save), `at ${w}px INSERT's text clears saveEvent's`);
  }
});

// ---------------------------------------------------------------- real projects (scratchpad/realworld)

import { knownPlaces } from "./thread-layout.ts";

test("remix save: a redirect reads as one, and three parallel fetches in one lane never print over each other", () => {
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Save"', trigger: "click", source: src("app/routes/notes.new.tsx", 100) });
  const post = ev({ startMs: 10, durationMs: 9, kind: "http_request", origin: "browser", name: "POST /notes/new", http: { method: "POST", url: "/notes/new?_data=routes%2Fnotes.new", status: 204, resHeaders: { "x-remix-redirect": "/notes/abc" } } });
  const get = (d: string) => ev({ startMs: 30, durationMs: 6, kind: "http_request", origin: "browser", name: "GET /notes/abc", http: { method: "GET", url: `/notes/cmuzhp9t60000zyhhhu92jlhs?_data=${d}`, status: 200 } });
  const trip = buildTrip(view(click, [node(post), node(get("root")), node(get("routes%2Fnotes")), node(get("routes%2Fnotes.%24noteId"))], "ok"));
  assert.equal(trip.returned, "Server sent your page to /notes/abc");
  assert.equal(trip.verdict, "The server sent your page to /notes/abc. Shrike can't see inside that server.");
  assert.equal(trip.forks.length, 1);
  for (const w of [700, 1000, 1400]) {
    const g = layoutTrip(trip, w);
    const box = (s: (typeof g.stations)[number]) => {
      const tw = Math.min(s.room, Math.max(s.label.length * 7.6, [s.where, `${Math.round(s.ms)}ms`].filter(Boolean).join(" · ").length * 6.9));
      return { l: s.left ? s.x - 18 - tw : s.x + 18, r: s.left ? s.x - 18 : s.x + 18 + tw, t: s.y - 10, b: s.y + 22 };
    };
    for (const a of g.stations) for (const b of g.stations) {
      if (a === b) continue;
      const p = box(a), q = box(b);
      assert.ok(p.r <= q.l || q.r <= p.l || p.b <= q.t || q.b <= p.t, `at ${w}px "${a.label}" and "${b.label}" overlap`);
    }
  }
});

test("a page's call to the project's Python API lands in the API lane, which Shrike can't see inside", () => {
  const api: Place = { id: "service:api", kind: "service", name: "API", detail: "localhost:18000" };
  const known = knownPlaces([{ id: "client:http://localhost:15174", kind: "client", name: "WEB", detail: "localhost:15174" }, api, { id: "service:web", kind: "service", name: "WEB", detail: "localhost:15173" }], [{ name: "web", state: "running", instrumented: true }, { name: "api", state: "running" }]);
  assert.deepEqual(known.map((p) => p.id), ["client:http://localhost:15174", "service:api"], "an instrumented process records its own inside");
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Save"', trigger: "click", source: src("src/AddItem.tsx", 40) });
  const call = (status: number) => ev({ startMs: 10, durationMs: 20, kind: "http_request", origin: "browser", name: "POST", http: { method: "POST", url: "http://127.0.0.1:18000/api/v1/items/", status }, status: status >= 500 ? "error" : "ok" });
  const ok = buildTrip(view(click, [node(call(200))], "ok"), new Set(), known);
  const st = ok.stations.find((s) => s.lane === "service:api")!;
  assert.ok(st?.opaque);
  assert.equal(st.label, "POST /api/v1/items/");
  assert.equal(ok.verdict, "Your page called the api service, which Shrike can't see inside.");
  assert.ok(touchedBy(ok).has("service:api"));
  const bad = buildTrip(view(click, [node(call(500))], "error"), new Set(), known);
  assert.equal(bad.stations.find((s) => s.snap)!.lane, "service:api", "it breaks where it arrived");
  assert.equal(bad.verdict, "The api service said no: Server error (500). Shrike can't see inside it.");
  assert.ok(!buildTrip(view(click, [node(call(200))], "ok")).stations.some((s) => s.opaque), "no known services, no guess");
});

test("a cross-origin 500 the browser couldn't read (no CORS headers on FastAPI's error) still reads as the server's error", () => {
  const click = ev({ kind: "user_action", origin: "browser", name: 'Submitted "Place order"', trigger: "submit", source: src("web/src/App.tsx", 56) });
  const call = ev({ startMs: 10, kind: "http_request", origin: "browser", name: "POST", http: { method: "POST", url: "http://localhost:4511/api/checkout" }, status: "error", error: { type: "TypeError", message: "Failed to fetch" } });
  const served = ev({ startMs: 11, kind: "http_request", parentId: call.id, name: "POST /api/checkout", http: { method: "POST", url: "/api/checkout", status: 500 }, status: "error" });
  const trip = buildTrip(view(click, [node(call, [node(served)])], "error"));
  assert.equal(trip.returned, "Server error (500)");
});

test("dev-server noise and logger colours stay out of the trip", () => {
  const nav = ev({ kind: "user_action", origin: "browser", name: "Opened /notes", trigger: "navigation" });
  const frames = ev({ kind: "http_request", origin: "browser", name: "POST /__nextjs_original-stack-frames", http: { method: "POST", url: "/__nextjs_original-stack-frames", status: 200 } });
  const hono = ev({ kind: "log", name: "log", log: { level: "info", message: "--> POST /rpc/todo/create \u001b[32m200\u001b[0m 28ms" } });
  const refresh = ev({ kind: "log", origin: "browser", name: "log", log: { level: "info", message: "[Fast Refresh] rebuilding" } });
  const trip = buildTrip(view(nav, [node(frames), node(refresh), node(hono)], "ok"));
  assert.ok(!trip.stations.some((s) => /__nextjs|Fast Refresh/.test(s.label)), trip.stations.map((s) => s.label).join(", "));
  const lg = trip.stations.find((s) => s.kind === "log")!;
  assert.ok(!/\u001b|\[32m|\[0m/.test(`${lg.label}${lg.chip}${lg.caption}`), `${lg.label} ${lg.chip} ${lg.caption}`);
  assert.match(lg.caption, /POST \/rpc\/todo\/create 200 28ms/);
});

test("remix: page events recorded before the page's address was known share the WEB lane, not a second PAGE lane", () => {
  const web: Place = { id: "client:http://localhost:13005", kind: "client", name: "WEB · indie-stack", detail: "localhost:13005" };
  const known = knownPlaces([web, { id: "data:sqlite", kind: "data", name: "SQLITE" }]);
  const nav = ev({ kind: "user_action", origin: "browser", name: "Opened /login", trigger: "navigation" });
  const early = ev({ startMs: 2, durationMs: 4, kind: "http_request", origin: "browser", name: "GET /login", http: { method: "GET", url: "/login?_data=root", status: 200 } });
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Log in"', trigger: "click", source: src("app/routes/login.tsx", 90) });
  const later = ev({ startMs: 2, durationMs: 4, kind: "http_request", origin: "browser", name: "POST /login", place: web, http: { method: "POST", url: "/login", status: 204 } });
  const trips = [buildTrip(view(nav, [node(early)], "ok"), new Set(), known), buildTrip(view(click, [node(later)], "ok"), new Set(), known)];
  assert.deepEqual(lanesFor(trips, [web]).map((l) => l.label), ["YOU", "PAGE"]);
});

test("nextjs-supabase: the server's call to Supabase's auth host lands in the Supabase lane, not an outside LOCALHOST lane", () => {
  const sb: Place = { id: "data:supabase:localhost:15421", kind: "data", name: "SUPABASE · localhost", detail: "localhost:15421" };
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Sign up"', trigger: "click", source: src("components/sign-up-form.tsx", 40) });
  const signup = ev({ startMs: 2, durationMs: 30, kind: "db_query", origin: "browser", name: "sign up (auth)", place: sb, db: { system: "supabase", statement: "sign up (auth)" } });
  const page = ev({ startMs: 40, durationMs: 20, kind: "http_request", origin: "browser", name: "GET /auth/sign-up-success", http: { method: "GET", url: "/auth/sign-up-success", status: 200 } });
  const req = ev({ startMs: 41, durationMs: 18, kind: "http_request", name: "GET /auth/sign-up-success", place: { id: "service:app", kind: "service", name: "APP" }, http: { method: "GET", url: "/auth/sign-up-success", status: 200 } });
  const jwks = ev({ startMs: 42, durationMs: 5, kind: "external_call", name: "GET", place: { id: "outside:localhost:15421", kind: "outside", name: "LOCALHOST:15421", detail: "localhost:15421" }, http: { method: "GET", url: "http://127.0.0.1:15421/auth/v1/.well-known/jwks.json", status: 200 } });
  const trip = buildTrip(view(click, [node(signup), node(page, [node(req, [node(jwks)])])], "ok"));
  assert.ok(!trip.places.some((p) => p.place.kind === "outside"), trip.places.map((p) => p.place.id).join(", "));
  assert.equal(trip.stations.find((s) => s.kind === "external_call")!.lane, sb.id);
});

test("nextjs-supabase sign-up: React props with undefined in a working trip are not red; a red chip under its label gets its own room", () => {
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Sign up"', trigger: "click" });
  const req = ev({ startMs: 10, kind: "http_request", name: "GET /auth/sign-up-success", http: { method: "GET", url: "/auth/sign-up-success", status: 200 } });
  const desc = ev({ startMs: 20, name: "CardDescription()", args: ["{ className: undefined, children: 'Check your email' }"], source: src("components/ui/card.tsx", 47) });
  const cn = ev({ startMs: 20, name: "cn()", args: ["'text-sm', undefined"], source: src("lib/utils.ts", 4), callSite: src("components/ui/card.tsx", 50) });
  const ok = buildTrip(view(click, [node(req, [node(desc, [node(cn)])])], "ok"));
  assert.ok(ok.stations.every((s) => !s.chipError), "no red chips in a trip that worked");

  const bad = { ...cn, status: "error" as const, error: { message: "boom" } };
  const failed = buildTrip(view(click, [node(req, [node(ev({ startMs: 15, name: "CardTitle()" }), [node(ev({ startMs: 15, name: "cn()", args: ["'font-semibold'"] }))]), node(desc, [node(bad)]), node(ev({ startMs: 30, name: "CardContent()", source: src("components/ui/card.tsx", 59) }))])], "error"));
  assert.equal(failed.stations.find((s) => s.label === "CardDescription()")!.chipError, true, "a caller whose callee failed keeps its suspect");
  const g = layoutTrip(failed, 1000);
  const i = failed.stations.findIndex((s) => s.label === "CardDescription()");
  const st = g.stations;
  assert.ok(st[i - 1]!.x > st[i]!.x, "label sits under its station");
  assert.ok(st[i + 1]!.y - st[i]!.y >= 110, `room under the red chip: ${st[i + 1]!.y - st[i]!.y}`);
});

test("nextjs-supabase login: stacked side branches (React's async components) never print over each other", () => {
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Login"', trigger: "click" });
  const req = ev({ startMs: 1, durationMs: 60, kind: "http_request", name: "GET /protected", http: { method: "GET", url: "/protected", status: 200 } });
  const fn = (name: string, startMs: number, durationMs: number, args?: string[]) => ev({ name, startMs, durationMs, args, source: src(`app/${name}.tsx`, 3) });
  const auth = node(fn("AuthButton()", 10, 32), [node(fn("createClient()", 10.1, 17), [node(fn("getAll()", 27, 0.01)), node(fn("getAll()", 27.2, 0))]), node(fn("getAll()", 28, 0))]);
  const details = node(fn("UserDetails()", 13, 30), [node(fn("createClient()", 13.1, 15), [node(fn("getAll()", 28, 0.01)), node(fn("getAll()", 28.2, 0))]), node(fn("getAll()", 29, 0))]);
  const tut = [0, 1, 2, 3, 4].map((k) => node(fn("TutorialStep()", 15 + k, 0.04)));
  const trip = buildTrip(view(click, [node(req, [node(fn("ProtectedLayout()", 5, 0.17)), auth, node(fn("ProtectedPage()", 11, 0.17, ["{}"])), details, node(fn("FetchDataSteps()", 14, 0.26, ["{}, undefined"])), ...tut])], "ok"));
  const g = layoutTrip(trip, 1200);
  const side = g.stations.filter((s) => s.fork && !s.fork.main);
  assert.ok(side.length >= 3 && side.some((s) => s.kind === "express"), side.map((s) => s.label).join(", "));
  const tall = (s: (typeof g.stations)[number]) => (s.kind === "express" || !s.chip ? 30 : 54);
  for (let k = 1; k < side.length; k++) {
    const a = side[k - 1]!, b = side[k]!;
    assert.ok(b.y - tall(b) / 2 >= a.y + tall(a) / 2, `"${a.label}" (y ${a.y}) and "${b.label}" (y ${b.y}) overlap`);
  }
});

test("time view: back-to-back 0ms rows clear a two-line label, a label written below gets more, time still reads", () => {
  const root = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Place order"', trigger: "click" });
  const fn = (name: string, ms: number, kids: TimelineNode[] = []) => node(ev({ name, durationMs: ms, source: src("cart/pricing.ts", 9) }), kids);
  const q = node(ev({ kind: "db_query", origin: "db", name: "SELECT", db: { system: "postgresql", statement: "SELECT 1" }, durationMs: 0 }));
  const req = ev({ kind: "http_request", name: "POST /orders", http: { method: "POST", url: "/orders", status: 200 } });
  const trip = buildTrip(view(root, [node(req, [fn("load()", 0, [q]), fn("priceCart()", 0), fn("lineTotal()", 0), fn("slow()", 400)])], "ok"));
  const g = layoutTrip(trip, 1000, true);
  const y = (l: string) => g.stations.find((s) => s.label.startsWith(l))!.y;
  for (let i = 1; i < g.stations.length; i++) assert.ok(g.stations[i]!.y - g.stations[i - 1]!.y >= 44, `row ${i} clears a two-line label`);
  assert.ok(y("lineTotal") - y("priceCart") >= 60, "priceCart's label sits under it (the thread came back from the database): the next row clears it");
  assert.ok(y("slow") - y("lineTotal") > 2 * (y("lineTotal") - y("priceCart")), "400ms still reads longer than 0ms");
});

test("lane heads fit: the name, else a short form, else the glyph; never a cut word", () => {
  assert.equal(fitHead("QUEUE", 36, 6.8), "QUEUE");
  assert.equal(fitHead("POSTGRES", 36, 6.8), "PGSQL");
  assert.equal(fitHead("STRIPE", 36, 6.8), "STRP");
  assert.equal(fitHead("SQLITE", 36, 6.8), "SQLT");
  assert.equal(fitHead("POSTGRES", 80, 6.8), "POSTGRES");
  assert.equal(fitHead("7 services", 30, 8), "7");
  assert.equal(fitHead("NOTIFICATIONS", 10, 6.8), "");
});

// ---------------------------------------------------------------- live projects (T22, #58)

import { subLine } from "./thread-layout.ts";

test("live: a same-origin request with nothing recorded inside lands on a grey SERVER station, never on a local project", () => {
  const known = knownPlaces([], [], { liveUrl: "https://Shop.example.com/app", origins: ["https://api.example.com"] });
  assert.deepEqual(known.map((p) => p.id), ["service:live:shop.example.com", "service:live:api.example.com"]);
  const page: Place = { id: "client:https://shop.example.com", kind: "client", name: "WEB · shop", detail: "shop.example.com" };
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Save"', trigger: "click", source: src("app/page.tsx", 9) });
  const call = (url: string, p: Partial<DebugEvent> = {}) => ev({ startMs: 10, durationMs: 180, kind: "http_request", origin: "browser", name: "POST", place: page, http: { method: "POST", url, status: 200 }, ...p });
  const ok = buildTrip(view(click, [node(call("/api/save"))], "ok"), new Set(), known);
  const st = ok.stations.find((s) => s.live)!;
  assert.equal(st.lane, "service:live:shop.example.com");
  assert.ok(st.opaque);
  assert.deepEqual([st.label, subLine(st)], ["Server, not visible from your browser", "OK (200) · 180ms"]);
  assert.equal(ok.verdict, "Your page called the server. What happened inside isn't visible from your browser.");
  assert.equal(lanesFor([ok]).find((l) => l.id === st.lane)!.label, "SERVER");
  const bad = buildTrip(view(click, [node(call("/api/save", { status: "error", http: { method: "POST", url: "/api/save", status: 500 } }))], "error"), new Set(), known);
  assert.equal(bad.stations.find((s) => s.snap)!.lane, "service:live:shop.example.com", "it breaks where it arrived");
  assert.equal(bad.verdict, "The server said no: Server error (500). What happened inside isn't visible from your browser.");
  assert.equal(buildTrip(view(click, [node(call("https://api.example.com/v1/cart"))], "ok"), new Set(), known).stations.find((s) => s.live)?.lane, "service:live:api.example.com", "a host in origins");
  assert.ok(!buildTrip(view(click, [node(call("https://other.example.org/x"))], "ok"), new Set(), known).stations.some((s) => s.live), "a host not in origins is not the server");
  const served = call("/api/save");
  assert.ok(!buildTrip(view(click, [node(served, [node(ev({ startMs: 11, kind: "http_request", parentId: served.id, name: "POST /api/save", http: { method: "POST", url: "/api/save", status: 200 } }))])], "ok"), new Set(), known).stations.some((s) => s.live), "a recorder answered: no grey station");
  assert.ok(!buildTrip(view(click, [node(call("/api/save"))], "ok"), new Set(), knownPlaces([page])).stations.some((s) => s.live), "a local project never shows it");
  assert.equal(buildTrip(view(click, [node(call("/api/save", { http: { method: "GET", url: "/api/save", status: 200, resHeaders: { "x-vercel-cache": "HIT" } } }))], "ok"), new Set(), known).stations.find((s) => s.live)!.label, "From cache");
  assert.equal(buildTrip(view(click, [node(call("/api/save", { http: { method: "GET", url: "/api/save", status: 200, fromCache: true } }))], "ok"), new Set(), known).stations.find((s) => s.live)!.label, "From cache", "#55 a service worker's cache");
});

test("live: Server-Timing entries with a duration become the grey station's chip (#59)", () => {
  const known = knownPlaces([], [], { liveUrl: "https://shop.example.com" });
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Save"', trigger: "click", source: src("app/page.tsx", 9) });
  const call = (serverTiming: unknown) => ev({ startMs: 10, durationMs: 180, kind: "http_request", origin: "browser", name: "POST", http: { method: "POST", url: "/api/save", status: 200, serverTiming } as DebugEvent["http"] });
  const chip = (t: unknown) => buildTrip(view(click, [node(call(t))], "ok"), new Set(), known).stations.find((s) => s.live)!.chip;
  assert.equal(chip([{ name: "db", durMs: 53.2, desc: "Postgres" }, { name: "cache", desc: "miss" }, { name: "app", durMs: 47 }]), "db 53ms, app 47ms");
  assert.equal(chip([{ name: "cache", desc: "miss" }]), undefined, "no durations, no chip");
  assert.equal(chip(undefined), undefined);
  assert.equal(chip("db;dur=5"), undefined, "a malformed field from the page is ignored");
});

test("live: a Next.js page load and its page data (RSC) say Rendered on the server", () => {
  const known = knownPlaces([], [], { liveUrl: "https://shop.example.com" });
  const nav = ev({ kind: "user_action", origin: "browser", name: "Opened /", trigger: "navigation" });
  const load = buildTrip({ ...view(nav, [], "ok"), trigger: "navigation" }, new Set(), known);
  const st = load.stations[0]!;
  assert.deepEqual([st.live, st.label, subLine(st)], [true, "Rendered on the server", "page load"]);
  assert.equal(load.returned, "Rendered on the server");
  assert.equal(load.verdict, "The server rendered this page. What happened inside isn't visible from your browser.");
  assert.equal(layoutTrip(load, 1000).stations.length, 1);
  assert.ok(!buildTrip(view(nav, [], "ok")).stations.length, "a local page load draws nothing new");
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Orders"', trigger: "click", source: src("app/nav.tsx", 4) });
  const rsc = ev({ startMs: 10, durationMs: 90, kind: "http_request", origin: "browser", name: "GET", http: { method: "GET", url: "/orders?_rsc=1x2y", status: 200, reqHeaders: { rsc: "1" } } });
  assert.equal(buildTrip(view(click, [node(rsc)], "ok"), new Set(), known).stations.find((s) => s.live)!.label, "Rendered on the server");
});

test("empty_result: a Supabase read with 0 rows says so in the verdict, in the warning shape", () => {
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Load orders"', trigger: "click", source: src("src/Orders.tsx", 12) });
  const q = ev({ startMs: 10, kind: "db_query", origin: "browser", name: "SELECT", db: { system: "supabase", statement: "db.orders.select()" } });
  const message = "Supabase answered with 0 rows from orders. Row level security can do this when no policy matches the signed-in user.";
  const trip = buildTrip({ ...view(click, [node(q)], "ok"), flags: [{ kind: "empty_result", eventId: q.id, message }] });
  assert.equal(trip.shape, "came_back_empty");
  assert.equal(trip.verdict, "Supabase answered with 0 rows from orders.");
  const unknown = buildTrip({ ...view(click, [node(q)], "ok"), flags: [{ kind: "empty_result", eventId: q.id, message: "Supabase didn't say how many rows changed in orders. If Save did nothing, row level security may have matched 0 rows." }] });
  assert.equal(unknown.verdict, "Supabase didn't say how many rows changed in orders.", "an unknown count is never shown as 0");
  assert.equal(buildTrip(view(click, [node(q)], "ok")).shape, "worked");
});

test("#62: a page that asked Supabase directly never says it never called the server; 0 rows wins, in amber", () => {
  const click = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Save"', trigger: "click", source: src("app.js", 1) });
  const place = { kind: "data" as const, id: "data:supabase:abcdefghijklmnopqrst.supabase.co", name: "SUPABASE · abcdefghijklmnopqrst" };
  const q = ev({ startMs: 10, durationMs: 250, kind: "db_query", origin: "browser", name: "SELECT * FROM orders", place, db: { system: "postgres", statement: "SELECT * FROM orders" } });
  const message = "Supabase answered with 0 rows from orders. Row level security can do this when no policy matches the signed-in user.";
  const known = knownPlaces([], [], { liveUrl: "http://live.test/" });
  for (const status of ["ok", "slow"] as const) {
    const empty = buildTrip({ ...view(click, [node({ ...q, live: true })], status), flags: [{ kind: "empty_result", eventId: q.id, message }] }, new Set(), known);
    assert.deepEqual([empty.shape, empty.verdict, empty.returned], ["came_back_empty", "Supabase answered with 0 rows from orders.", "Your page asked Supabase directly"], status);
  }
  const rows = buildTrip(view(click, [node(q)], "ok"));
  assert.equal(rows.returned, "Your page asked Supabase directly");
  assert.notEqual(rows.shape, "never_left_page");
  assert.doesNotMatch(rows.verdict, /never called/);
});
