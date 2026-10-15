import type { DebugEvent, HttpRequestSpec, HttpResponseSpec } from "@shrike/schema";
import { friendlyError, isBinary, LIVE_WRITE } from "./api/exec.ts";
import { randomHex, type Store } from "./store.ts";

const MAX_EVENT_BODY = 64 * 1024;
const MAX_RETURN_BODY = 1024 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…[truncated]` : s);

export function resolveTarget(raw: string, baseUrl: string | undefined, live: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    throw new Error(baseUrl ? `That isn't a valid URL: ${raw}` : "Run your app first so relative URLs have somewhere to go.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs can be sent: ${raw}`);
  // #53: loopback, plus a live project's own origins from .shrike/config.json
  if (!LOOPBACK.has(url.hostname) && !live.includes(url.origin)) throw new Error(`Shrike only sends requests to your local app (localhost) or your project's live site, not ${url.host}.`);
  return url;
}

export async function sendRequest(
  store: Store,
  spec: HttpRequestSpec,
  baseUrl: string | undefined,
  trigger: "explorer" | "agent",
  live: string[] = [],
): Promise<{ response: HttpResponseSpec; actionId: string }> {
  const url = resolveTarget(spec.url, baseUrl, live);
  const hidden = [spec.url, spec.body ?? "", ...Object.values(spec.headers ?? {})].join("\n").match(/\[redacted:[\w.-]*\]/)?.[0];
  if (hidden) throw new Error(`Type the real value for ${hidden} first. Shrike hid it in the recording.`);
  const method = spec.method.toUpperCase();
  const onLive = live.includes(url.origin);
  if (onLive && trigger === "agent" && method !== "GET" && method !== "HEAD") throw new Error(LIVE_WRITE);
  const path = url.pathname + url.search;
  const traceId = randomHex(16);
  const reqId = randomHex(8);
  const start = Date.now();
  const root: DebugEvent = {
    id: randomHex(8),
    traceId,
    origin: trigger,
    kind: "user_action",
    name: `Sent ${method} ${path}`,
    startMs: start,
    status: "ok",
    trigger,
    ...(spec.name ? { caller: { kind: trigger, label: spec.name.slice(0, 120) } } : {}), // AP: the request's name on the caller card
    ...(spec.resendOf ? { resendOf: spec.resendOf } : {}),
    ...(onLive ? { live: true as const } : {}), // #52: a send to the live site is live data, masked when it leaves the screen
  };
  store.handle({ type: "events", events: [root] });

  const reqHeaders: Record<string, string> = { ...spec.headers, ...(onLive ? {} : { traceparent: `00-${traceId}-${reqId}-01` }) }; // docs/02: no traceparent on live origins
  const hasBody = spec.body !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === "content-type")) reqHeaders["content-type"] = "application/json";
  const event: DebugEvent = {
    id: reqId,
    traceId,
    parentId: root.id,
    origin: trigger,
    kind: "http_request",
    name: `${method} ${path}`,
    startMs: start,
    status: "ok",
    http: { method, url: path, reqHeaders, reqBody: hasBody ? cut(spec.body!, MAX_EVENT_BODY) : undefined },
    ...(onLive ? { live: true as const } : {}),
  };

  let cur = url;
  let started = false;
  try {
    const signal = AbortSignal.timeout(30_000);
    let res: Response;
    let init: RequestInit = { method, headers: reqHeaders, body: hasBody ? spec.body : undefined, redirect: "manual", signal };
    for (let hops = 0; ; hops++) {
      res = await fetch(cur, init);
      const loc = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || !loc || hops >= 5) break;
      let next: URL;
      try {
        next = resolveTarget(loc, cur.href, live);
      } catch {
        break;
      }
      if (next.origin !== cur.origin) break; // like exec.ts: a redirect to another origin comes back as the 3xx, never followed
      await res.body?.cancel();
      if (res.status !== 307 && res.status !== 308) init = { ...init, method: method === "HEAD" ? "HEAD" : "GET", body: undefined };
      cur = next;
    }
    started = true;
    const { bytes, size, cutOff } = await readCapped(res, MAX_RETURN_BODY);
    const headers = Object.fromEntries(res.headers.entries());
    const body = isBinary(headers["content-type"], bytes) ? `[binary ${headers["content-type"] ?? "data"}, ${size}${cutOff ? "+" : ""} bytes]` : bytes.toString("utf8") + (cutOff ? "…[truncated]" : "");
    const durationMs = Date.now() - start;
    const status = res.status >= 500 ? "error" : "ok";
    event.durationMs = durationMs;
    event.status = status;
    event.http = { ...event.http!, status: res.status, resHeaders: headers, resBody: cut(body, MAX_EVENT_BODY) };
    store.handle({ type: "events", events: [event, { ...root, durationMs, status }] });
    return { response: { status: res.status, statusText: res.statusText, headers, body, durationMs }, actionId: root.id };
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    const message = friendlyError(e.name === "TimeoutError" ? { name: e.name, started } : (e.cause ?? e), cur, 30_000, false);
    event.durationMs = Date.now() - start;
    event.status = "error";
    event.error = { message, type: e.name };
    store.handle({ type: "events", events: [event, { ...root, durationMs: event.durationMs, status: "error" }] });
    throw new Error(message);
  } finally {
    store.handle({ type: "action_end", actionId: root.id, at: Date.now() });
  }
}

/** The body up to `max` bytes; the rest is never read, so a huge answer can't fill memory. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Buffer; size: number; cutOff: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return { bytes: Buffer.concat(chunks).subarray(0, max), size, cutOff: true };
    }
  }
  return { bytes: Buffer.concat(chunks), size, cutOff: false };
}
