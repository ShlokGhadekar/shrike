// What the server says about itself in response headers (#59): Server-Timing (where its time went) and traceresponse
// (the trace ID it used). Pure: no window access, so test/server-timing.test.ts runs it in Node. Never throws.
import type { DebugEvent } from "@shrike/schema";

type Http = NonNullable<DebugEvent["http"]>;
export type ServerTiming = NonNullable<Http["serverTiming"]>[number];

const MAX_HEADER = 4 * 1024;
const MAX_ENTRIES = 20;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Splits on `sep` outside quoted strings. */
function splitOutside(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted && c === "\\" && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (v: string): string => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

/** `db;dur=53.2;desc="Postgres", app;dur=47` → [{ name: "db", durMs: 53.2, desc: "Postgres" }, { name: "app", durMs: 47 }]. Bad input gives []. */
export function parseServerTiming(header: string | undefined): ServerTiming[] {
  try {
    if (typeof header !== "string") return [];
    const out: ServerTiming[] = [];
    for (const entry of splitOutside(header.slice(0, MAX_HEADER), ",")) {
      if (out.length >= MAX_ENTRIES) break;
      const [rawName, ...params] = splitOutside(entry, ";");
      const name = rawName!.trim();
      if (!TOKEN.test(name)) continue; // not a metric (or cut off at the cap): skip it, keep the rest
      const metric: ServerTiming = { name };
      for (const p of params) {
        const eq = p.indexOf("=");
        const key = (eq < 0 ? p : p.slice(0, eq)).trim().toLowerCase();
        const value = eq < 0 ? "" : unquote(p.slice(eq + 1).trim());
        // the first dur and desc win (Server Timing spec)
        if (key === "dur" && metric.durMs === undefined) {
          const n = Number(value);
          if (value !== "" && Number.isFinite(n) && n >= 0) metric.durMs = n;
        } else if (key === "desc" && metric.desc === undefined && value) metric.desc = value;
      }
      out.push(metric);
    }
    return out;
  } catch {
    return [];
  }
}

/** `00-<traceId>-<spanId>-<flags>` (W3C Trace Context) → the trace ID, or undefined. */
export function traceIdOf(header: string | undefined): string | undefined {
  try {
    const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}/.exec(String(header ?? "").trim().toLowerCase());
    if (!m || m[1] === "ff" || /^0+$/.test(m[2]!) || /^0+$/.test(m[3]!)) return undefined;
    return m[2];
  } catch {
    return undefined;
  }
}

/** The fields to add to `http` from its response headers (lowercase names, repeats joined by ", " as browsers do). */
export function serverSide(resHeaders: Record<string, string> | undefined): Pick<Http, "serverTiming" | "serverTraceId"> {
  const timing = parseServerTiming(resHeaders?.["server-timing"]);
  const traceId = traceIdOf(resHeaders?.traceresponse);
  return { ...(timing.length && { serverTiming: timing }), ...(traceId && { serverTraceId: traceId }) };
}
