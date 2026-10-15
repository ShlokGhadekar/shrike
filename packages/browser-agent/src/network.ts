import type { DebugEvent } from "@shrike/schema";
import { beginWork } from "./actions.ts";
import { dataKind, toData, type DataKind } from "./data.ts";
import { emitEvent } from "./emit.ts";
import { newEventId } from "./ids.ts";
import { serverSide } from "./server-timing.ts";

const LIMIT = 64 * 1024;
const BODY_WAIT_MS = 5000;
const TEXTUAL = /json|text\/|xml|javascript|x-www-form-urlencoded|graphql/i;
const setT = window.setTimeout.bind(window);
const clearT = window.clearTimeout.bind(window);

const cut = (s: string): string => (s.length > LIMIT ? s.slice(0, LIMIT) + "…[truncated]" : s);

function headersObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

function describeBody(b: unknown): string | undefined {
  if (b == null) return undefined;
  if (typeof b === "string") return cut(b);
  if (b instanceof URLSearchParams) return cut(b.toString());
  if (b instanceof FormData) {
    const parts: string[] = [];
    b.forEach((v, k) => parts.push(`${k}=${typeof v === "string" ? v : "[file]"}`));
    return cut(parts.join("&"));
  }
  if (b instanceof Blob) return `[blob ${b.size} bytes]`;
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return `[binary ${b.byteLength} bytes]`;
  if (b instanceof ReadableStream) return "[stream]";
  if (b instanceof Document) return "[document]";
  return undefined;
}

interface Target {
  url: URL;
  sameOrigin: boolean;
  display: string;
  name: string;
}

function target(raw: string, method: string): Target {
  const url = new URL(raw, location.href);
  const sameOrigin = url.origin === location.origin;
  return {
    url,
    sameOrigin,
    display: sameOrigin ? url.pathname + url.search : url.href,
    name: `${method} ${sameOrigin ? url.pathname : url.origin + url.pathname}`,
  };
}

const now = performance.now.bind(performance);
const entriesByName = performance.getEntriesByName.bind(performance);
/** #55: the browser's HTTP cache or a service worker's Cache Storage answered (Resource Timing `deliveryType`, Chromium). */
function fromCache(url: string, since: number): boolean {
  try {
    const e = entriesByName(url, "resource").filter((x) => x.startTime >= since - 1).at(-1) as { deliveryType?: string } | undefined;
    return e?.deliveryType === "cache" || e?.deliveryType === "cache-storage";
  } catch {
    return false;
  }
}

function startEvent(t: Target, method: string, data?: DataKind): { ev: DebugEvent; settle(failed: boolean): void } {
  const { action, settle: release } = beginWork("Background request");
  const ev: DebugEvent = {
    id: newEventId(),
    traceId: action.root.traceId,
    parentId: action.root.id,
    origin: "browser",
    kind: "http_request",
    name: t.name,
    startMs: Date.now(),
    status: "ok",
    http: { method, url: t.display },
  };
  // Sent now as well, so main can join the other server's side to it before it answers (no traceparent cross-origin).
  if (!t.sameOrigin && !data) emitEvent({ ...ev, http: { method, url: t.display } });
  // Drop our own frames (startEvent + the fetch/send wrapper) so the first frame is the caller.
  const stack = new Error().stack;
  if (stack) {
    const lines = stack.split("\n");
    ev.stack = [lines[0], ...lines.slice(3)].join("\n");
  }
  const t0 = now();
  let finished = false;
  return {
    ev,
    settle(failed) {
      if (finished) return;
      finished = true;
      ev.durationMs = Date.now() - ev.startMs;
      if (failed) ev.status = "error";
      if (fromCache(t.url.href, t0)) ev.http!.fromCache = true;
      for (const e of data ? toData(ev, t.url, data, newEventId) : [ev]) emitEvent(e);
      release(failed);
    },
  };
}

const traceparent = (ev: DebugEvent): string => `00-${ev.traceId}-${ev.id}-01`;
// #54: main wraps the bundle with this constant; off on live origins unless the project turns it on.
declare const __shrikeConfig: { traceparent?: boolean } | undefined;
const sendTraceparent = typeof __shrikeConfig === "undefined" || __shrikeConfig.traceparent !== false;

async function readResponseBody(res: Response): Promise<string | undefined> {
  const ct = res.headers.get("content-type") ?? "";
  if (/event-stream/i.test(ct)) return "[stream]";
  if (ct && !TEXTUAL.test(ct)) return `[${ct.split(";")[0]} body]`;
  const body = res.clone().body;
  if (!body) return "";
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = "";
  let bytes = 0;
  // ponytail: long-lived bodies are cut after 5s so the action can close; full streaming capture later.
  const timer = setT(() => reader.cancel().catch(() => {}), BODY_WAIT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += dec.decode(value, { stream: true });
      if (bytes > LIMIT) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    out += dec.decode();
  } catch {
    // body errored; keep what we have
  } finally {
    clearT(timer);
  }
  return cut(out);
}

// A request the page's own navigation cut off is cancelled, not failed.
let leaving = false;
addEventListener("beforeunload", () => {
  leaving = true;
  setT(() => (leaving = false), 3000); // ponytail: a cancelled leave clears after 3s; a request failing inside that window reads as cancelled
});
addEventListener("pagehide", () => (leaving = true));
addEventListener("pageshow", () => (leaving = false));

function isAbort(err: unknown, signal: AbortSignal | null | undefined): boolean {
  return leaving || Boolean(signal?.aborted) || (err instanceof DOMException && err.name === "AbortError");
}

function patchFetch(): void {
  const orig = window.fetch;
  if (typeof orig !== "function") return;
  window.fetch = function fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let ev: DebugEvent;
    let settle: ((failed: boolean) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    let callArgs: unknown[] = Array.from(arguments);
    try {
      const req = input instanceof Request ? input : undefined;
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const t = target(req ? req.url : String(input), method);
      const headers = new Headers(init?.headers ?? req?.headers);
      const data = dataKind(t.url, method, headersObject(headers));
      if (data === "skip") return orig.apply(this, arguments as unknown as Parameters<typeof fetch>);
      ({ ev, settle } = startEvent(t, method, data));
      if (sendTraceparent && t.sameOrigin && !headers.has("traceparent")) {
        headers.set("traceparent", traceparent(ev));
        callArgs = [input, { ...init, headers }];
      }
      ev.http!.reqHeaders = headersObject(headers);
      const reqBody = init && "body" in init ? describeBody(init.body) : undefined;
      if (reqBody !== undefined) ev.http!.reqBody = reqBody;
      else if (req && req.body && !req.bodyUsed) {
        const evRef = ev;
        req.clone().text().then((b) => (evRef.http!.reqBody = cut(b)), () => {});
      }
      signal = init?.signal ?? req?.signal;
    } catch {
      settle?.(false);
      return orig.apply(this, arguments as unknown as Parameters<typeof fetch>);
    }
    const done = settle;
    const p = orig.apply(this, callArgs as Parameters<typeof fetch>);
    p.then(
      (res) => {
        try {
          ev.http!.status = res.status;
          ev.http!.resHeaders = headersObject(res.headers);
          readServerSide(ev);
          const failed = res.status >= 500;
          readResponseBody(res).then(
            (b) => {
              if (b !== undefined) ev.http!.resBody = b;
              done(failed);
            },
            () => done(failed),
          );
        } catch {
          done(res.status >= 500);
        }
      },
      (err: unknown) => {
        try {
          const aborted = isAbort(err, signal);
          ev.error = aborted
            ? { message: leaving ? "Cancelled because the page left" : "Request was cancelled", type: "AbortError" }
            : { message: err instanceof Error ? err.message : String(err), type: err instanceof Error ? err.name : "Error" };
          // ponytail: an abort is a deliberate cancel, not a failure; it is recorded but keeps status ok.
          done(!aborted);
        } catch {
          done(true);
        }
      },
    );
    return p;
  };
}

interface XhrInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function patchXhr(): void {
  if (typeof XMLHttpRequest !== "function") return;
  const proto = XMLHttpRequest.prototype;
  const info = new WeakMap<XMLHttpRequest, XhrInfo>();
  const open = proto.open;
  const setHeader = proto.setRequestHeader;
  const sendOrig = proto.send;

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    try {
      info.set(this, { method: String(method).toUpperCase(), url: String(url), headers: {} });
    } catch {}
    return open.apply(this, arguments as unknown as Parameters<typeof open>);
  } as typeof open;

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const r = setHeader.apply(this, arguments as unknown as Parameters<typeof setHeader>);
    try {
      const i = info.get(this);
      if (i) i.headers[String(name).toLowerCase()] = String(value);
    } catch {}
    return r;
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    let done: ((failed: boolean) => void) | undefined;
    try {
      const i = info.get(this);
      const t = i && target(i.url, i.method);
      const data = i && t && dataKind(t.url, i.method, i.headers);
      if (i && t && data !== "skip" && this.readyState === XMLHttpRequest.OPENED) {
        const { ev, settle } = startEvent(t, i.method, data);
        if (sendTraceparent && t.sameOrigin && !("traceparent" in i.headers)) {
          const tp = traceparent(ev);
          setHeader.call(this, "traceparent", tp);
          i.headers.traceparent = tp;
        }
        ev.http!.reqHeaders = { ...i.headers };
        const reqBody = describeBody(body);
        if (reqBody !== undefined) ev.http!.reqBody = reqBody;
        let aborted = false;
        const xhr = this;
        xhr.addEventListener("abort", () => (aborted = true));
        xhr.addEventListener("error", () => (aborted ||= leaving));
        done = settle;
        xhr.addEventListener("loadend", () => {
          try {
            const status = xhr.status;
            if (status) ev.http!.status = status;
            ev.http!.resHeaders = parseHeaders(xhr.getAllResponseHeaders());
            readServerSide(ev);
            const rt = xhr.responseType;
            if (rt === "" || rt === "text") ev.http!.resBody = cut(xhr.responseText);
            else if (rt === "json") ev.http!.resBody = cut(JSON.stringify(xhr.response) ?? "");
            else ev.http!.resBody = `[${rt} body]`;
            if (aborted) ev.error = { message: leaving ? "Cancelled because the page left" : "Request was cancelled", type: "AbortError" };
            else if (status === 0) ev.error = { message: "Network request failed", type: "NetworkError" };
            done?.(status >= 500 || (status === 0 && !aborted));
          } catch {
            done?.(false);
          }
        });
      }
    } catch {}
    try {
      return sendOrig.apply(this, arguments as unknown as Parameters<typeof sendOrig>);
    } catch (err) {
      // send threw synchronously: no loadend will follow
      try {
        done?.(true);
      } catch {}
      throw err;
    }
  };
}

// #59: cross-origin, the browser hides these unless the server exposes them, so there's simply nothing to read.
function readServerSide(ev: DebugEvent): void {
  try {
    Object.assign(ev.http!, serverSide(ev.http!.resHeaders));
  } catch {}
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

export function installNetwork(): void {
  try {
    patchFetch();
  } catch {}
  try {
    patchXhr();
  } catch {}
}
