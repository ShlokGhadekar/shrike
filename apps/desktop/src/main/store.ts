// ponytail: in-memory store, cleared on restart. Upgrade path: @shrike/store (SQLite + NDJSON).
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { ActionView, DebugEvent, IngestMessage, Place, ProjectInfo } from "@shrike/schema";
import { buildActionView, relativize, resolveBrowserStack } from "@shrike/correlator";
import { type PiiSeen, redactEvent } from "@shrike/redact";
import { configPlaces } from "@shrike/scanner";

export const ZERO_TRACE = "0".repeat(32);
export const SERVER_OUTPUT_ID = "0".repeat(16);
const ACTION_END_GRACE_MS = 500;
const SERVER_IDLE_MS = 800;
// ponytail: safety net for browser actions whose action_end never arrives (page navigated away mid-window).
const BROWSER_IDLE_MS = 10_000;
const MAX_SERVER_LOGS = 2000;
// Floods (a click that logs in a loop, a server polling itself): bound what one trip and the whole store keep.
export const MAX_TRIP_EVENTS = 5000;
export const MAX_TRIPS = 500;
export const MAX_EVENTS = 100_000;
const MAX_BODY_CHARS = 64 * 1024; // docs/04: bodies are at most 64KB
const THROTTLE_MS = 100;
// Sent on Shrike's own requests (readiness polls, source-map fetches) so they don't show up as Actions.
export const INTERNAL_HEADER = "x-shrike-internal";

export interface StoreOptions {
  projectRoot(): string;
  onUpdate(views: ActionView[]): void;
  onHello?(msg: Extract<IngestMessage, { type: "hello" }>): void;
  loadText?(url: string): Promise<string>;
  projectName?(): string | undefined; // client lane label; else the project folder name
  declaredPlaces?(): ProjectInfo["declaredPlaces"]; // D8; else read from .shrike/config.json
  redactRules?(): ProjectInfo["redact"]; // #52: the user's redact.keys and redact.headers, in every mode
}

type Declared = NonNullable<ProjectInfo["declaredPlaces"]>;
const YOU: Place = { id: "caller:you", kind: "caller", name: "YOU" };
const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?=:|$)/;
const normHost = (h: string | undefined) => h?.toLowerCase().replace(LOOPBACK, "localhost");

interface Outbound {
  id: string;
  traceId: string;
  method: string;
  host: string;
  path: string;
  startMs: number;
  claimed: boolean;
}

interface TraceState {
  rootId?: string;
  eventIds: Set<string>;
  complete: boolean;
  ended: boolean;
  pending: number; // in-flight stack resolutions
  ignored?: boolean;
  dropped?: number; // events past MAX_TRIP_EVENTS, not kept
  timer?: ReturnType<typeof setTimeout>;
}

export class Store {
  private opts: StoreOptions;
  private events = new Map<string, DebugEvent>();
  private traces = new Map<string, TraceState>();
  private serverLogs: string[] = [];
  private dirty = new Set<string>(); // traceIds
  private flushTimer?: ReturnType<typeof setTimeout>;
  private waiters = new Map<string, Set<(v: ActionView) => void>>(); // actionId
  private rootListeners = new Set<(root: DebugEvent) => void>();
  private generation = 0;
  private pageOrigin?: string; // from the browser-agent hello
  private serviceHosts = new Map<string, Place>(); // "localhost:4101" -> service:auth
  private configDeclared?: { root: string; places: Declared | undefined };
  private outbound = new Map<string, Outbound>(); // the page's cross-origin requests, by event id
  private aliases = new Map<string, string>(); // a joined server trace -> the page's trace
  private pii = new Map<string, PiiSeen>(); // #51: live trips, traceId -> placeholders, so one email reads the same across the trip
  private docs = new Map<string, number>(); // page loads waiting for their "Opened" trip: traceId -> server start
  private navs: { traceId: string; rootId: string; startMs: number; at: number }[] = []; // recent "Opened" trips

  constructor(opts: StoreOptions) {
    this.opts = opts;
  }

  handle(msg: IngestMessage): void {
    if (msg.type === "hello") {
      if (msg.source === "browser" && msg.url) {
        try {
          this.pageOrigin = new URL(msg.url).origin;
        } catch {}
      }
      this.opts.onHello?.(msg);
    }
    else if (msg.type === "action_end") this.actionEnd(msg.actionId);
    else for (const e of msg.events) this.add(e);
  }

  private add(raw: DebugEvent): void {
    const traceId = this.aliases.get(raw.traceId) ?? raw.traceId;
    const e = redactEvent(clampBodies(raw), this.opts.redactRules?.(), raw.live ? this.piiOf(traceId) : undefined); // live is set by main, never the page
    e.traceId = traceId;
    if (e.source && (e.origin === "browser" || isAbsolute(e.source.file))) e.source = { ...e.source, file: relativize(e.source.file, this.opts.projectRoot()) }; // OpenTelemetry SDKs send absolute paths
    if ((e.kind === "http_request" || e.kind === "db_query" || e.kind === "user_action") && e.origin === "browser" && e.stack) {
      const stack = e.stack;
      delete e.stack;
      this.resolveStack(e, stack);
    } else delete e.stack;
    this.placeOf(e);

    if (e.traceId === ZERO_TRACE) return this.addServerLog(e);
    if (e.kind === "http_request" && e.origin === "browser") this.noteOutbound(e);
    else if (e.kind === "http_request" && e.origin === "server" && !e.parentId) this.joinOutbound(e);

    const t = this.trace(e.traceId);
    if (t.ignored) return;
    if (e.http?.reqHeaders?.[INTERNAL_HEADER]) return this.ignore(t);
    const isNew = !this.events.has(e.id);
    // ponytail: past the cap only errors get in (up to twice the cap), so a break after a flood still shows. Upgrade: keep the last N too.
    if (isNew && t.eventIds.size >= MAX_TRIP_EVENTS && (e.status !== "error" || t.eventIds.size >= 2 * MAX_TRIP_EVENTS) && !(e.kind === "user_action" && !e.parentId && !t.rootId)) return this.drop(e.traceId, t);
    this.events.set(e.id, { ...this.events.get(e.id), ...e });
    t.eventIds.add(e.id);
    if (isNew) this.evict(e.traceId);

    if (e.kind === "user_action" && !e.parentId && !t.rootId) {
      t.rootId = e.id;
      if (isNew) for (const l of this.rootListeners) l(e);
      if (isNew && e.origin === "browser" && e.trigger === "navigation") this.noteNav(e);
    }
    if (!t.rootId && e.kind === "http_request" && e.origin === "server" && !e.parentId) {
      // A page's own document (typed address, reload, redirect) joins the page's "Opened" trip; its files (script/style/image...) are not a click, only a failing one is shown.
      const dest = e.http?.reqHeaders?.["sec-fetch-dest"];
      const pageLoad = !!dest && dest !== "empty";
      if (dest === "document") {
        const nav = this.navs.findLast((n) => n.startMs - 1000 <= e.startMs && e.startMs <= n.at);
        if (nav) return this.linkDoc(e.traceId, nav);
        if (e.status !== "error") return this.parkDoc(e.traceId, e.startMs);
      }
      if (pageLoad && e.status !== "error") return this.ignore(t);
      const c = knownCaller(e);
      if (!pageLoad && c) this.synthesizeRoot(e, t, callerLabel(c, e.name), c);
      else this.synthesizeRoot(e, t, `${e.name} ${pageLoad ? "(page load)" : "(from outside the app)"}`);
    }
    // A SHRIKE_CALLER script (cron, test) under node-agent starts a trip with its own outgoing call.
    const c = !t.rootId && e.kind === "external_call" && !e.parentId ? knownCaller(e) : undefined;
    if (c) this.synthesizeRoot(e, t, callerLabel(c, `${e.http?.method ?? ""} ${pathOf(e.http?.url) ?? e.name}`.trim()), c);
    this.armIdle(e.traceId, t);
    this.markDirty(e.traceId);
  }

  // Main decides browser-side places (the page is untrusted); agents' places pass through declared names.
  private placeOf(e: DebugEvent): void {
    const root = e.kind === "user_action" && !e.parentId;
    if (e.origin === "browser") {
      if (root) e.place = YOU;
      else if (e.kind === "db_query" && e.place?.kind === "data" && e.place.id.startsWith("data:")) e.place = declare(e.place, this.declared()); // the page's own database calls (Supabase, Firestore)
      else if (this.pageOrigin) e.place = this.clientPlace(this.pageOrigin);
      else delete e.place;
    } else if (e.origin === "explorer" || e.origin === "agent") {
      e.place = callerPlace(e.origin);
      if (root) e.caller ??= { kind: e.origin, label: e.origin === "explorer" ? "API explorer" : "agent" };
    } else if (e.place) {
      e.place = declare(e.place, this.declared());
      if (e.place.kind === "service" && e.place.detail) this.serviceHosts.set(normHost(e.place.detail)!, e.place);
    }
  }

  private clientPlace(origin: string): Place {
    const host = new URL(origin).host;
    const root = this.opts.projectRoot();
    return { id: `client:${origin}`, kind: "client", name: `WEB · ${this.opts.projectName?.() ?? (root ? basename(root) : host)}`, detail: host };
  }

  private declared(): Declared | undefined {
    if (this.opts.declaredPlaces) return this.opts.declaredPlaces();
    const root = this.opts.projectRoot();
    if (this.configDeclared?.root !== root) {
      let places: Declared | undefined;
      try {
        places = configPlaces(JSON.parse(readFileSync(join(root, ".shrike", "config.json"), "utf8")).places);
      } catch {}
      this.configDeclared = { root, places };
    }
    return this.configDeclared.places;
  }

  // A cross-origin call carries no traceparent (CORS), so its server side starts its own trace; join it by method, host, path and time.
  private noteOutbound(e: DebugEvent): void {
    const url = e.http?.url;
    if (!url || !/^https?:\/\//i.test(url) || this.outbound.has(e.id)) return;
    for (const [id, o] of this.outbound) if (o.startMs < e.startMs - 60_000) this.outbound.delete(id);
    try {
      const u = new URL(url);
      this.outbound.set(e.id, { id: e.id, traceId: e.traceId, method: e.http!.method.toUpperCase(), host: normHost(u.host)!, path: u.pathname + u.search, startMs: e.startMs, claimed: false });
    } catch {}
  }

  private joinOutbound(e: DebugEvent): void {
    const h = e.http;
    if (!h?.reqHeaders?.host) return;
    const preflight = h.method === "OPTIONS" ? h.reqHeaders["access-control-request-method"]?.toUpperCase() : undefined;
    const method = preflight ?? h.method.toUpperCase();
    const host = normHost(h.reqHeaders.host);
    for (const o of this.outbound.values()) {
      if (o.method !== method || o.host !== host || o.path !== h.url || (!preflight && o.claimed) || e.startMs < o.startMs - 1000 || e.startMs > o.startMs + 60_000) continue;
      // An answered preflight is CORS plumbing: keeping it put an OPTIONS station first and read as the call's answer. A refused one stays.
      if (preflight && h.status && h.status < 400 && e.traceId !== o.traceId) return this.ignore(this.trace(e.traceId));
      if (!preflight) o.claimed = true;
      this.moveTrace(e.traceId, o.traceId);
      e.traceId = o.traceId;
      e.parentId = o.id;
      return;
    }
  }

  private piiOf(traceId: string): PiiSeen {
    let seen = this.pii.get(traceId);
    if (!seen) this.pii.set(traceId, (seen = new Map()));
    return seen;
  }

  private moveTrace(from: string, to: string): void {
    this.aliases.set(from, to);
    if (this.aliases.size > 1000) this.aliases.delete(this.aliases.keys().next().value!);
    // ponytail: a trip joined into one that already numbered its own values keeps both numberings; joins are page-to-server, and server events are never live
    const seen = this.pii.get(from);
    if (seen && !this.pii.has(to)) this.pii.set(to, seen);
    this.pii.delete(from);
    const old = this.traces.get(from);
    if (!old) return;
    clearTimeout(old.timer);
    const t = this.trace(to);
    for (const id of old.eventIds) {
      const x = this.events.get(id);
      if (x) x.traceId = to;
      t.eventIds.add(id);
    }
    this.traces.delete(from);
    this.dirty.delete(from);
  }

  // ponytail: one app pane, so page loads match by time: a document request between a navigation's start and its "Opened" event is that page's.
  private noteNav(root: DebugEvent): void {
    this.navs.push({ traceId: root.traceId, rootId: root.id, startMs: root.startMs, at: Date.now() });
    if (this.navs.length > 20) this.navs.shift();
    for (const [id, startMs] of this.docs) if (startMs >= root.startMs - 1000) this.linkDoc(id, this.navs.at(-1)!);
  }

  private parkDoc(traceId: string, startMs: number): void {
    for (const [id, s] of this.docs) {
      if (s >= startMs - 60_000) continue;
      this.docs.delete(id);
      const old = this.traces.get(id);
      if (old) this.ignore(old);
    }
    this.docs.set(traceId, startMs);
  }

  private linkDoc(traceId: string, nav: { traceId: string; rootId: string }): void {
    this.docs.delete(traceId);
    const t = this.traces.get(traceId);
    if (!t || traceId === nav.traceId) return;
    for (const id of t.eventIds) {
      const x = this.events.get(id);
      if (x?.kind === "http_request" && x.origin === "server" && !x.parentId) x.parentId = nav.rootId;
    }
    this.moveTrace(traceId, nav.traceId);
    this.markDirty(nav.traceId);
  }

  /** One note in the trip says how many steps weren't kept; it's updated, not repeated. */
  private drop(traceId: string, t: TraceState): void {
    t.dropped = (t.dropped ?? 0) + 1;
    const root = this.rootOf(t);
    const id = `dropped-${traceId}`.slice(0, 64);
    const message = `This trip had too many steps. Shrike kept the first ${MAX_TRIP_EVENTS.toLocaleString("en-US")} and skipped ${t.dropped.toLocaleString("en-US")} more.`;
    const note = this.events.get(id);
    if (note?.log) note.log.message = note.name = message;
    else {
      this.events.set(id, { id, traceId, parentId: root?.id, origin: root?.origin ?? "server", kind: "log", name: message, startMs: Date.now(), status: "ok", log: { level: "warn", message } });
      t.eventIds.add(id);
    }
    this.markDirty(traceId);
  }

  /** Over MAX_TRIPS or MAX_EVENTS: forget the oldest finished trips first, never one an agent is waiting on or the one just added to. */
  private evict(keep: string): void {
    if (this.traces.size <= MAX_TRIPS && this.events.size <= MAX_EVENTS) return;
    const pick = (finished: boolean) => {
      for (const [id, t] of this.traces) if (id !== keep && (!finished || t.complete || t.ignored) && !(t.rootId && this.waiters.has(t.rootId))) return id;
    };
    while (this.traces.size > MAX_TRIPS || this.events.size > MAX_EVENTS) {
      const id = pick(true) ?? pick(false);
      if (!id) return;
      const t = this.traces.get(id)!;
      clearTimeout(t.timer);
      for (const e of t.eventIds) this.events.delete(e);
      this.traces.delete(id);
      this.dirty.delete(id);
      this.pii.delete(id);
    }
  }

  private ignore(t: TraceState): void {
    t.ignored = true;
    clearTimeout(t.timer);
    for (const id of t.eventIds) this.events.delete(id);
    t.eventIds.clear();
  }

  // D1/T20: a trip that didn't start in a browser starts at its caller (curl, cron, ...), when known.
  private synthesizeRoot(http: DebugEvent, t: TraceState, name: string, caller?: DebugEvent["caller"]): void {
    const root: DebugEvent = {
      id: randomHex(8),
      traceId: http.traceId,
      origin: "server",
      kind: "user_action",
      name,
      startMs: http.startMs,
      durationMs: http.durationMs,
      status: http.status,
      trigger: "server",
      ...(caller ? { caller, place: callerPlace(caller.kind === "other" ? caller.label : caller.kind) } : {}),
    };
    this.events.set(root.id, root);
    t.eventIds.add(root.id);
    t.rootId = root.id;
    for (const l of this.rootListeners) l(root);
  }

  private addServerLog(e: DebugEvent): void {
    if (!this.events.has(e.id)) {
      this.serverLogs.push(e.id);
      if (this.serverLogs.length > MAX_SERVER_LOGS) this.events.delete(this.serverLogs.shift()!);
    }
    this.events.set(e.id, e);
    this.markDirty(ZERO_TRACE);
  }

  private resolveStack(e: DebugEvent, stack: string): void {
    const t = this.trace(e.traceId);
    const gen = this.generation;
    t.pending++;
    const loadText = this.opts.loadText ?? defaultLoadText;
    resolveBrowserStack(stack, this.opts.projectRoot(), loadText)
      .then((source) => {
        const cur = this.events.get(e.id);
        if (source && cur && gen === this.generation) {
          cur.source = source;
          this.markDirty(e.traceId);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (gen !== this.generation) return;
        t.pending--;
        if (t.pending === 0 && t.ended && !t.timer) this.complete(e.traceId);
      });
  }

  private trace(traceId: string): TraceState {
    let t = this.traces.get(traceId);
    if (!t) this.traces.set(traceId, (t = { eventIds: new Set(), complete: false, ended: false, pending: 0 }));
    return t;
  }

  private rootOf(t: TraceState): DebugEvent | undefined {
    return t.rootId ? this.events.get(t.rootId) : undefined;
  }

  private armIdle(traceId: string, t: TraceState): void {
    if (t.complete || t.ended) return;
    const trigger = this.rootOf(t)?.trigger;
    const ms = trigger === "server" ? SERVER_IDLE_MS : trigger === "explorer" || trigger === "agent" ? undefined : BROWSER_IDLE_MS;
    clearTimeout(t.timer);
    t.timer = ms === undefined ? undefined : setTimeout(() => this.endNow(traceId), ms);
  }

  private actionEnd(actionId: string): void {
    const traceId = this.events.get(actionId)?.traceId;
    if (!traceId) return;
    const t = this.trace(traceId);
    if (t.complete) return;
    t.ended = true;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this.endNow(traceId), ACTION_END_GRACE_MS);
  }

  private endNow(traceId: string): void {
    const t = this.traces.get(traceId);
    if (!t) return;
    t.ended = true;
    t.timer = undefined;
    if (t.pending === 0) this.complete(traceId);
  }

  private complete(traceId: string): void {
    const t = this.traces.get(traceId);
    if (!t || t.complete) return;
    t.complete = true;
    this.markDirty(traceId);
    const view = this.viewOf(traceId);
    if (!view) return;
    const ws = this.waiters.get(view.id);
    this.waiters.delete(view.id);
    for (const w of ws ?? []) w(view);
  }

  private markDirty(traceId: string): void {
    this.dirty.add(traceId);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      const views = [...this.dirty].map((id) => this.viewOf(id)).filter((v) => v !== undefined);
      this.dirty.clear();
      if (views.length) this.opts.onUpdate(views);
    }, THROTTLE_MS);
  }

  private viewOf(traceId: string): ActionView | undefined {
    if (traceId === ZERO_TRACE) return this.serverOutputView();
    const t = this.traces.get(traceId);
    const root = t && this.rootOf(t);
    if (!t || !root) return undefined;
    const events = [...t.eventIds].map((id) => this.events.get(id)).filter((e): e is DebugEvent => e !== undefined && e.id !== root.id);
    // An outgoing call to a host that turned out to be one of our services is a hop between services (T19), not an outside lane.
    for (const e of events) if (e.place?.kind === "outside") e.place = this.serviceHosts.get(normHost(e.place.detail) ?? "") ?? e.place;
    return safeBuild(root, events, t.complete);
  }

  private serverOutputView(): ActionView | undefined {
    const events = this.serverLogs.map((id) => this.events.get(id)).filter((e) => e !== undefined);
    if (!events.length) return undefined;
    const root: DebugEvent = {
      id: SERVER_OUTPUT_ID,
      traceId: ZERO_TRACE,
      origin: "server",
      kind: "user_action",
      name: "Server output",
      startMs: events[0]!.startMs,
      status: "ok",
      trigger: "server",
    };
    return safeBuild(root, events, true);
  }

  listActions(): ActionView[] {
    const views = [...this.traces.keys()].map((id) => this.viewOf(id)).filter((v) => v !== undefined);
    const server = this.serverOutputView();
    if (server) views.push(server);
    return views.sort((a, b) => a.startMs - b.startMs);
  }

  getAction(id: string): ActionView | undefined {
    if (id === SERVER_OUTPUT_ID) return this.serverOutputView();
    const traceId = this.events.get(id)?.traceId;
    if (!traceId) return undefined;
    const view = this.viewOf(traceId);
    return view?.id === id ? view : undefined;
  }

  getEvent(id: string): DebugEvent | undefined {
    return this.events.get(id);
  }

  searchEvents(query: string, limit = 100): DebugEvent[] {
    const q = query.toLowerCase();
    const out: DebugEvent[] = [];
    for (const e of this.events.values()) {
      const hay = [e.name, e.log?.message, e.error?.message, e.http?.url, e.http?.resBody, e.db?.statement, e.source?.file, ...(e.args ?? []), e.returned];
      if (hay.some((s) => s?.toLowerCase().includes(q))) out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  // Resolves when the action is complete, or with its current (incomplete) view on timeout.
  waitForAction(id: string, timeoutMs = 15_000): Promise<ActionView | undefined> {
    const view = this.getAction(id);
    if (view?.complete) return Promise.resolve(view);
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      const done = (v: ActionView | undefined) => {
        clearTimeout(timer);
        set.delete(done);
        resolve(v);
      };
      const timer = setTimeout(() => done(this.getAction(id)), timeoutMs);
      set.add(done);
    });
  }

  // Resolves with the id of the next new root matching `match`, or null on timeout.
  nextAction(match: (root: DebugEvent) => boolean, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const l = (root: DebugEvent) => {
        if (!match(root)) return;
        this.rootListeners.delete(l);
        clearTimeout(timer);
        resolve(root.id);
      };
      const timer = setTimeout(() => {
        this.rootListeners.delete(l);
        resolve(null);
      }, timeoutMs);
      this.rootListeners.add(l);
    });
  }

  clear(): void {
    for (const t of this.traces.values()) clearTimeout(t.timer);
    this.generation++;
    this.events.clear();
    this.traces.clear();
    this.serverLogs = [];
    this.dirty.clear();
    this.serviceHosts.clear();
    this.outbound.clear();
    this.aliases.clear();
    this.pii.clear();
    this.docs.clear();
    this.navs = [];
    this.configDeclared = undefined;
  }
}

const knownCaller = (e: DebugEvent) => (e.caller && e.caller.kind !== "browser" && e.caller.label !== "unknown" ? e.caller : undefined);
const callerLabel = (c: NonNullable<DebugEvent["caller"]>, what: string) => (c.kind === "curl" ? `${c.label} ${what}` : `${c.label} · ${what}`);
const pathOf = (url: string | undefined) => {
  try {
    return url ? new URL(url, "http://x").pathname : undefined;
  } catch {
    return undefined;
  }
};

export function callerPlace(kind: string): Place {
  return { id: `caller:${kind.toLowerCase()}`, kind: "caller", name: kind.toUpperCase() };
}

/** D8: a declared key ("localhost:4199", "events.db") matches a place's detail (a database's without its "/name") or the end of its id. */
export function declare(p: Place, declared: Declared | undefined): Place {
  for (const [key, d] of Object.entries(declared ?? {})) {
    if (normHost(p.detail) === normHost(key) || (p.kind === "data" && normHost(p.detail?.split("/")[0]) === normHost(key)) || p.id.endsWith(`:${key}`)) return { id: `${d.kind}:${key}`, kind: d.kind, name: d.name, detail: p.detail ?? key };
  }
  return p;
}

function clampBodies(e: DebugEvent): DebugEvent {
  const h = e.http;
  const cut = (s: string | undefined) => (s && s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS)}…[truncated]` : s);
  if (!h || ((h.reqBody?.length ?? 0) <= MAX_BODY_CHARS && (h.resBody?.length ?? 0) <= MAX_BODY_CHARS)) return e;
  return { ...e, http: { ...h, reqBody: cut(h.reqBody), resBody: cut(h.resBody) } };
}

function safeBuild(root: DebugEvent, events: DebugEvent[], complete: boolean): ActionView | undefined {
  try {
    return buildActionView(root, events, complete);
  } catch (err) {
    console.error("[shrike] buildActionView failed", err);
    return undefined;
  }
}

async function defaultLoadText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { [INTERNAL_HEADER]: "1" } });
  return res.text();
}

export function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}
