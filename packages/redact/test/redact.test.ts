import assert from "node:assert/strict";
import { test } from "node:test";
import type { DebugEvent } from "@shrike/schema";
import { entropy, maskText, maskValues, redactCell, redactEvent, redactText } from "../src/index.ts";

test("keys inside JSON keep the key and stay valid JSON", () => {
  const out = redactText('{"email":"a@b.co","password":"hunter2","nested":{"apiKey":"abc123","card":4242424242424242,"author":"Ann"},"maxTokens":100}');
  assert.deepEqual(JSON.parse(out), {
    email: "a@b.co",
    password: "[redacted:password]",
    nested: { apiKey: "[redacted:apiKey]", card: "[redacted:card]", author: "Ann" },
    maxTokens: 100,
  });
  assert.equal(redactText('{ "access_token" : "x.y.z" }'), '{ "access_token" : "[redacted:access_token]" }');
  assert.equal(redactText('{"password":""}'), '{"password":""}');
});

test("keys inside util.inspect-style strings", () => {
  assert.equal(
    redactText("{ title: 'buy milk', password: 'hunter2', 'api-key': 'k1', sessionId: \"s's\", authorId: 3, ok: true }"),
    "{ title: 'buy milk', password: '[redacted:password]', 'api-key': '[redacted:api-key]', sessionId: \"[redacted:sessionId]\", authorId: 3, ok: true }",
  );
  assert.equal(redactText("req { POST /login body: { user: 'ann', passwd: '[redacted]' } }"), "req { POST /login body: { user: 'ann', passwd: '[redacted]' } }");
  assert.equal(redactText("{ token: [Object], session: { id: 1 }, authenticated: false }"), "{ token: [Object], session: { id: 1 }, authenticated: false }");
});

test("query strings, form data, cookies, bearer", () => {
  assert.equal(redactText("GET /api/x?token=abc123&page=2"), "GET /api/x?token=[redacted:token]&page=2");
  assert.equal(redactText("user=ann&password=p%40ss&remember=1"), "user=ann&password=[redacted:password]&remember=1");
  assert.equal(redactText("sessionid=abc123; theme=dark"), "sessionid=[redacted:sessionid]; theme=dark");
  assert.equal(redactText("sent Bearer abcdefghijkl to api"), "sent Bearer [redacted:token] to api");
  assert.equal(redactText("UPDATE users SET password = 'x1' WHERE id = ?"), "UPDATE users SET password = '[redacted:password]' WHERE id = ?");
  assert.equal(redactText("SELECT * FROM sessions WHERE token = ? AND user_id = 4"), "SELECT * FROM sessions WHERE token = ? AND user_id = 4");
});

test("known secret shapes", () => {
  const cases: [string, string][] = [
    ["key AKIAIOSFODNN7EXAMPLE here", "key [redacted:aws_key] here"],
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", "[redacted:anthropic_key]"],
    ["using sk-proj-abcdefghijklmnopqrstuvwx", "using [redacted:openai_key]"],
    ["sk_live_abcdefghij1234", "[redacted:stripe_key]"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "[redacted:github_token]"],
    ["xoxb-1234567890-abcdefghij", "[redacted:slack_token]"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefSIGNATURE_x", "[redacted:jwt]"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "[redacted:pem]"],
    ["postgres://admin:s3cret@db.local:5432/app", "postgres://admin:[redacted:password]@db.local:5432/app"],
    ["mongodb+srv://u:p@x.net", "mongodb+srv://u:[redacted:password]@x.net"],
  ];
  for (const [input, want] of cases) assert.equal(redactText(input), want, input);
});

test("high entropy tokens in value positions", () => {
  assert.equal(redactText("{ id: 'q8Zr3LmX0vT7pN2kWc5yB9dHs4' }"), "{ id: '[redacted:secret]' }");
  assert.equal(redactText("X-Custom: q8Zr3LmX0vT7pN2kWc5yB9dHs4"), "X-Custom: [redacted:secret]");
  assert.ok(entropy("q8Zr3LmX0vT7pN2kWc5yB9dHs4") > 4);
  assert.equal(redactText("verifyToken('9f86d081884c7d659a2feaa0c55ad015')"), "verifyToken('[redacted:secret]')");
  assert.equal(redactText("'550e8400-e29b-41d4-a716-446655440000'"), "'550e8400-e29b-41d4-a716-446655440000'");
});

test("leaves normal text alone", () => {
  const keep = [
    "NOT NULL constraint failed: todos.user_id",
    "INSERT INTO todos (title, user_id) VALUES (?, ?)",
    "{ title: 'buy milk', userId: undefined }",
    "creating todo { title: 'buy milk' }",
    "trace 0af7651916cd43dd8448eb211c80319c event b7ad6b7169203331",
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    "commit 3f786850e387550fdab836ed7e6dc881de23001b",
    "/Users/me/Desktop/new-tool/packages/correlator/src/summary.ts",
    "at createTodo (http://localhost:5173/src/api.ts?t=1712345678901:12:21)",
    "https://example.com/api/v1/items/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9?page=2",
    "'internationalizationFrameworkConfiguration'",
    "id: 550e8400-e29b-41d4-a716-446655440000",
    "Error: Cannot read properties of undefined (reading 'map')",
    "{ cards: [ 'a' ], passed: true, tokens: 12 }",
    "",
  ];
  for (const s of keep) assert.equal(redactText(s), s, s);
});

test("idempotent", () => {
  const s = '{"password":"x","q":"?token=abc","k":"sk-ant-abcdefghijklmnopqrstuvwxyz","db":"postgres://a:b@h"} Bearer abcdefghijkl';
  const once = redactText(s);
  assert.equal(redactText(once), once);
});

test("redactEvent covers every string field and never mutates", () => {
  const e: DebugEvent = {
    id: "b7ad6b7169203331",
    traceId: "0af7651916cd43dd8448eb211c80319c",
    origin: "server",
    kind: "http_request",
    name: "POST /login?token=abc",
    startMs: 1,
    status: "ok",
    source: { file: "server/auth.ts", line: 3, precision: "exact" },
    http: {
      method: "POST",
      url: "/login?token=abc",
      status: 200,
      reqHeaders: { Authorization: "Bearer abcdefghijkl", "content-type": "application/json", "x-csrf-token": "zz", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      resHeaders: { "set-cookie": "sid=1", "x-note": "key=sk-ant-abcdefghijklmnopqrstuvwxyz" },
      reqBody: '{"user":"ann","password":"hunter2"}',
      resBody: '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefSIGNATURE_x"}',
    },
    db: { system: "sqlite", statement: "SELECT 1 WHERE secret = 'x'", params: "[ 'pw', { apiKey: 'k' } ]" },
    log: { level: "info", message: "login { password: 'hunter2' }" },
    error: { message: "bad token=abc", type: "Error", stack: "Error: bad token=abc\n    at x (server/auth.ts:3:1)" },
    args: ["{ password: 'hunter2' }", "res"],
    returned: "{ session: 'abc' }",
    stack: "Error\n    at f (http://localhost:5173/src/a.ts?token=abc:1:1)",
  };
  const before = JSON.stringify(e);
  const r = redactEvent(e);
  assert.equal(JSON.stringify(e), before);
  assert.notEqual(r.http, e.http);
  assert.equal(r.name, "POST /login?token=[redacted:token]");
  assert.equal(r.http!.url, "/login?token=[redacted:token]");
  assert.deepEqual(r.http!.reqHeaders, {
    Authorization: "[redacted:authorization]",
    "content-type": "application/json",
    "x-csrf-token": "[redacted:x-csrf-token]",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  });
  assert.deepEqual(r.http!.resHeaders, { "set-cookie": "[redacted:set-cookie]", "x-note": "key=[redacted:anthropic_key]" });
  assert.equal(r.http!.reqBody, '{"user":"ann","password":"[redacted:password]"}');
  assert.equal(r.http!.resBody, '{"token":"[redacted:token]"}');
  assert.equal(r.db!.statement, "SELECT 1 WHERE secret = '[redacted:secret]'");
  assert.equal(r.db!.params, "[ 'pw', { apiKey: '[redacted:apiKey]' } ]");
  assert.equal(r.log!.message, "login { password: '[redacted:password]' }");
  assert.equal(r.error!.message, "bad token=[redacted:token]");
  assert.match(r.error!.stack!, /token=\[redacted:token\]\n {4}at x \(server\/auth\.ts:3:1\)/);
  assert.deepEqual(r.args, ["{ password: '[redacted:password]' }", "res"]);
  assert.equal(r.returned, "{ session: '[redacted:session]' }");
  assert.equal(r.stack, "Error\n    at f (http://localhost:5173/src/a.ts?token=[redacted:token]:1:1)");
  assert.deepEqual(r.source, e.source);
});

test("redactEvent covers cache keys and caller commands", () => {
  const e: DebugEvent = {
    id: "0000000000000001", traceId: "0af7651916cd43dd8448eb211c80319c", origin: "db", kind: "cache_op", name: "GET user:7", startMs: 1, status: "ok",
    cache: { op: "get", key: "token:sk-ant-abcdefghijklmnopqrstuvwxyz", hit: false },
    caller: { kind: "curl", label: "curl", command: "curl 'http://localhost:4100/x' -H 'authorization: Bearer abcdefgh12345678'" },
  };
  const r = redactEvent(e);
  assert.equal(r.cache!.key, "token:[redacted:token]");
  assert.equal(r.cache!.hit, false);
  assert.equal(r.caller!.command, "curl 'http://localhost:4100/x' -H 'authorization: Bearer [redacted:token]'");
  assert.equal(redactEvent({ ...e, cache: { op: "get", key: "user:7" } }).cache!.key, "user:7");
});

test("I: inspector cells and I3 change rows: secret-named columns masked whole, other values scanned", () => {
  assert.equal(redactCell("password", "hunter2"), "[redacted:password]");
  assert.equal(redactCell("api_key", 1234), "[redacted:api_key]");
  assert.equal(redactCell("password", null), null);
  assert.equal(redactCell("password", "[redacted]"), "[redacted]");
  assert.equal(redactCell("title", "Write the launch email"), "Write the launch email");
  assert.equal(redactCell("note", "key sk-ant-abcdefghijklmnopqrstuvwxyz"), "key [redacted:anthropic_key]");
  assert.equal(redactCell("author_id", 7), 7);
  const e: DebugEvent = {
    id: "0000000000000002", traceId: "0af7651916cd43dd8448eb211c80319c", origin: "db", kind: "db_query", name: "INSERT INTO users", startMs: 1, status: "ok",
    change: { table: "users", op: "insert", count: 1, rows: [{ pk: "3", after: { id: 3, name: "Cy", session_token: "abc" } }] },
  };
  assert.deepEqual(redactEvent(e).change, { table: "users", op: "insert", count: 1, rows: [{ pk: "3", after: { id: 3, name: "Cy", session_token: "[redacted:session_token]" } }] });
  assert.equal(e.change!.rows![0]!.after!.session_token, "abc");
});

test("a URL's port and path are not a secret (Firestore emulator channel)", () => {
  const url = "POST http://127.0.0.1:18080/google.firestore.v1.Firestore/Write/channel";
  assert.equal(redactText(url), url);
  assert.equal(redactText("note: sk9Qx2Lm4Np7Rt1Vw3Yz5Ab8Cd0Ef6Gh"), "note: [redacted:secret]", "a high-entropy value after a colon still goes");
});

test("nextjs-supabase: a React className is not a social security number", () => {
  assert.equal(redactText("{ className: 'inline-flex items-center', variant: undefined }"), "{ className: 'inline-flex items-center', variant: undefined }");
  assert.equal(redactText("{ userSsn: '123-45-6789' }"), "{ userSsn: '[redacted:userSsn]' }");
});

// #52: a Supabase `orders` answer with 5 rows of realistic personal data
const ORDERS = JSON.stringify([
  { id: 101, user_id: "550e8400-e29b-41d4-a716-446655440000", name: "Ada Lovelace", street: "12 Crescent Road", note: "Leave it by the blue door", status: "pending", total: 42.5, items: 3, paid: false, coupon: null },
  { id: 102, user_id: "6f1c2b9a-3d4e-4f5a-8b6c-7d8e9f0a1b2c", name: "Grace Hopper", street: "4 Harbour Lane", note: "Call when outside", status: "paid", total: 19, items: 1, paid: true, coupon: "SPRING" },
  { id: 103, user_id: "7a2d3c0b-4e5f-4a6b-9c7d-8e9f0a1b2c3d", name: "Alan Turing", street: "221 Wilmslow Road", note: "Gift wrap please", status: "pending", total: 7.25, items: 2, paid: false, coupon: null },
  { id: 104, user_id: "8b3e4d1c-5f6a-4b7c-ad8e-9f0a1b2c3d4e", name: "Katherine Johnson", street: "9 Mercury Avenue, Apt 3", note: "", status: "shipped", total: 120, items: 5, paid: true, coupon: null },
  { id: 105, user_id: "9c4f5e2d-6a7b-4c8d-be9f-0a1b2c3d4e5f", name: "Edsger Dijkstra", street: "1 Shortest Path", note: "No rush", status: "pending", total: 3, items: 1, paid: false, coupon: null },
]);

test("#52 maskValues: 5 rows of personal data lose names, streets and free text; ids, numbers, keys and enum words stay", () => {
  const e: DebugEvent = {
    id: "0000000000000003", traceId: "0af7651916cd43dd8448eb211c80319c", origin: "browser", kind: "db_query", name: "SELECT orders", startMs: 1, status: "ok", live: true,
    http: { method: "GET", url: "/rest/v1/orders?select=*&status=eq.pending&email=eq.ada%40example.com", resBody: ORDERS },
    db: { system: "postgres", statement: "SELECT orders", params: '["pending","eq.ada@example.com"]' },
    change: { table: "orders", op: "update", count: 1, rows: [{ pk: "101", after: { id: 101, street: "12 Crescent Road", status: "paid" } }] },
  };
  const before = JSON.stringify(e);
  const r = maskValues(e);
  assert.equal(JSON.stringify(e), before, "never mutates");
  const out = r.http!.resBody!;
  for (const word of ["Ada", "Lovelace", "Grace", "Crescent", "Harbour", "Wilmslow", "Mercury", "blue door", "Gift wrap", "No rush", "Call when"]) assert.ok(!out.includes(word), word);
  const rows = JSON.parse(out) as Record<string, unknown>[];
  assert.deepEqual(rows.map((x) => x.id), [101, 102, 103, 104, 105]);
  assert.deepEqual(rows.map((x) => x.status), ["pending", "paid", "pending", "shipped", "pending"]);
  assert.equal(rows[0]!.user_id, "550e8400-e29b-41d4-a716-446655440000");
  assert.deepEqual([rows[0]!.total, rows[0]!.items, rows[0]!.paid, rows[0]!.coupon, rows[1]!.coupon, rows[3]!.note], [42.5, 3, false, null, "SPRING", ""]);
  assert.deepEqual(Object.keys(rows[0]!), Object.keys((JSON.parse(ORDERS) as Record<string, unknown>[])[0]!));
  assert.match(String(rows[0]!.name), /^\[text#\d+\]$/);
  const n = /email=(\[text#\d+\])$/.exec(r.http!.url)?.[1];
  assert.ok(n && r.http!.url.startsWith("/rest/v1/orders?select=*&status=eq.pending&email="));
  assert.equal(r.db!.params, `["pending","${n}"]`, "the same value keeps its number within an event");
  assert.equal(r.change!.rows![0]!.after!.status, "paid");
  assert.match(String(r.change!.rows![0]!.after!.street), /^\[text#\d+\]$/);
});

test("#52 maskText: keep list, inspect previews, form data; a 25-character word goes", () => {
  assert.equal(maskText("{ name: 'Ada Lovelace', plan: 'Team plan', role: 'admin' }", { keep: ["plan"] }), "{ name: '[text#1]', plan: 'Team plan', role: 'admin' }");
  assert.equal(maskText("name=Ada+Lovelace&page=2"), "name=[text#1]&page=2");
  assert.equal(maskText('{"code":"ABCDEFGHIJKLMNOPQRSTUVWXY"}'), '{"code":"[text#1]"}');
  assert.equal(maskText('{"code":"ABCDEFGHIJKLMNOPQRSTUVWX"}'), '{"code":"ABCDEFGHIJKLMNOPQRSTUVWX"}');
  assert.equal(maskText('{"phone":"555-123-4567","at":"2026-10-15T12:00:00Z"}'), '{"phone":"[text#1]","at":"2026-10-15T12:00:00Z"}');
  assert.equal(maskText("[redacted:password] and '[text#4]', Bob's 'Ann Lee'"), "[redacted:password] and '[text#4]', Bob's '[text#1]'");
  const seen = new Map<string, number>();
  assert.equal(maskText('"Ada Lovelace" "Grace Hopper"', { seen }), '"[text#1]" "[text#2]"');
  assert.equal(maskText("'Grace Hopper'", { seen }), "'[text#2]'", "a shared map keeps numbers across calls");
});

test("#52 user rules: redact.keys and redact.headers are redacted at the store like the built-in names", () => {
  const rules = { keys: ["address"], headers: ["x-tenant"] };
  assert.equal(redactText('{"address":"12 Crescent Road","city":"Leeds"}', rules), '{"address":"[redacted:address]","city":"Leeds"}');
  assert.equal(redactText('{"address":"12 Crescent Road"}'), '{"address":"12 Crescent Road"}', "no rules, no change");
  assert.equal(redactCell("home_address", "x", rules), "[redacted:home_address]");
  const e: DebugEvent = { id: "0000000000000004", traceId: "0af7651916cd43dd8448eb211c80319c", origin: "browser", kind: "http_request", name: "GET /x", startMs: 1, status: "ok", http: { method: "GET", url: "/x?address=here", reqHeaders: { "X-Tenant": "acme", accept: "*/*" } } };
  const r = redactEvent(e, rules);
  assert.deepEqual(r.http!.reqHeaders, { "X-Tenant": "[redacted:x-tenant]", accept: "*/*" });
  assert.equal(r.http!.url, "/x?address=[redacted:address]");
});
