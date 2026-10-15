import assert from "node:assert/strict";
import { test } from "node:test";
import type { DebugEvent } from "@shrike/schema";
import { redactEvent } from "../../redact/src/index.ts";
import { parseServerTiming, serverSide, traceIdOf } from "../src/server-timing.ts";

test("parseServerTiming: names, durations and quoted descriptions", () => {
  assert.deepEqual(parseServerTiming('db;dur=53.2;desc="Postgres", app;dur=47'), [{ name: "db", durMs: 53.2, desc: "Postgres" }, { name: "app", durMs: 47 }]);
  assert.deepEqual(parseServerTiming("cache;desc=hit"), [{ name: "cache", desc: "hit" }], "a missing dur stays unset");
  assert.deepEqual(parseServerTiming("miss"), [{ name: "miss" }]);
  assert.deepEqual(parseServerTiming('db;desc="a, b; c \\"d\\"";dur=1'), [{ name: "db", desc: 'a, b; c "d"', durMs: 1 }], "commas and semicolons inside quotes");
  assert.deepEqual(parseServerTiming("DB ; DUR = 5 ; Desc = x"), [{ name: "DB", durMs: 5, desc: "x" }], "whitespace and parameter case");
  assert.deepEqual(parseServerTiming("a;dur=1;dur=2;desc=x;desc=y"), [{ name: "a", durMs: 1, desc: "x" }], "the first dur and desc win");
});

test("parseServerTiming: several headers joined by commas, as the browser hands them over", () => {
  assert.deepEqual(parseServerTiming("edge;dur=2, origin;dur=80, db;dur=53"), [{ name: "edge", durMs: 2 }, { name: "origin", durMs: 80 }, { name: "db", durMs: 53 }]);
});

test("parseServerTiming: bad input returns what it can, never throws", () => {
  for (const bad of [undefined, "", "   ", ",,,", ";dur=1", '"quoted"', "a b;dur=1", 42 as unknown as string, null as unknown as string]) {
    assert.deepEqual(parseServerTiming(bad), [], String(bad));
  }
  assert.deepEqual(parseServerTiming("a;dur=abc, b;dur=-3, c;dur=, d;dur=Infinity"), [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }], "a bad dur is dropped, the metric kept");
  assert.deepEqual(parseServerTiming('ok;dur=1, a b, x;desc="unterminated'), [{ name: "ok", durMs: 1 }, { name: "x", desc: '"unterminated' }]);
});

test("parseServerTiming: at most 20 entries, header capped at 4 KB", () => {
  const many = Array.from({ length: 50 }, (_, i) => `m${i};dur=${i}`).join(", ");
  const out = parseServerTiming(many);
  assert.equal(out.length, 20);
  assert.deepEqual(out.at(-1), { name: "m19", durMs: 19 });
  const huge = `a;dur=1, b;desc="${"x".repeat(10_000)}", c;dur=3`;
  assert.deepEqual(parseServerTiming(huge).map((m) => m.name), ["a", "b"], "nothing past 4 KB is read");
  assert.ok(parseServerTiming(huge)[1]!.desc!.length < 4096);
});

test("traceIdOf: W3C trace context, only valid IDs", () => {
  const t = "4bf92f3577b34da6a3ce929d0e0e4736";
  assert.equal(traceIdOf(`00-${t}-00f067aa0ba902b7-01`), t);
  assert.equal(traceIdOf(` 00-${t.toUpperCase()}-00F067AA0BA902B7-00 `), t, "trimmed and lowercased");
  assert.equal(traceIdOf(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`), undefined, "all-zero trace ID is invalid");
  assert.equal(traceIdOf(`00-${t}-${"0".repeat(16)}-01`), undefined, "all-zero span ID is invalid");
  assert.equal(traceIdOf(`ff-${t}-00f067aa0ba902b7-01`), undefined, "version ff is invalid");
  for (const bad of [undefined, "", "garbage", `00-${t.slice(1)}-00f067aa0ba902b7-01`]) assert.equal(traceIdOf(bad), undefined);
});

test("serverSide: only the fields that were found", () => {
  assert.deepEqual(serverSide(undefined), {});
  assert.deepEqual(serverSide({ "content-type": "text/plain", "server-timing": "nope nope" }), {});
  assert.deepEqual(serverSide({ "server-timing": "db;dur=5", traceresponse: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` }), { serverTiming: [{ name: "db", durMs: 5 }], serverTraceId: "a".repeat(32) });
});

test("redaction reaches Server-Timing descriptions", () => {
  const ev: DebugEvent = {
    id: "a".repeat(16), traceId: "1".repeat(32), origin: "browser", kind: "http_request", name: "GET /x", startMs: 1, status: "ok",
    http: { method: "GET", url: "/x", serverTiming: [{ name: "auth", durMs: 3, desc: "token=sk_live_abcdefghijklmnop1234" }, { name: "db", durMs: 9 }] },
  };
  const [auth, db] = redactEvent(ev).http!.serverTiming!;
  assert.equal(auth!.desc, "token=[redacted:token]");
  assert.deepEqual(db, { name: "db", durMs: 9 });
  const bad = (serverTiming: unknown) => redactEvent({ ...ev, http: { ...ev.http!, serverTiming } as DebugEvent["http"] }).http!.serverTiming;
  assert.equal(bad("db;dur=5"), undefined, "a page sending a string doesn't throw");
  assert.deepEqual(bad([null, { desc: 5 }, { name: "ok", desc: 5 }]), [{ name: "ok" }], "junk entries are dropped, never thrown on");
});
