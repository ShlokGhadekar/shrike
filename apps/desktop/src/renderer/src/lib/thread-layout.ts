import type { ActionView, DebugEvent, Place, PlaceKind, ProjectInfo, RunStatus, Status } from "@shrike/schema";
import { placeWords, refusal, serviceWords, statusWords, toSteps, type PlayStep } from "./steps.ts";

// The Thread: pure layout shared by the on-screen view (thread/**) and the clip painter (capture/**).
// Spec: docs/06-design.md, docs/12-feature-map.md (D9-D11, T15-T20). Painter-agnostic: paths are SVG path strings.

export const LANE_X = [0.1, 0.36, 0.62, 0.86] as const; // the owner-approved four lanes (SCREEN, PAGE, SERVER, DATABASE), as fractions of width
export const KIND_ORDER: readonly PlaceKind[] = ["caller", "client", "service", "queue", "cache", "data", "outside"];
export const SLIVER = 26; // px, an untouched lane (D10)
const GROUP_AFTER = 6; // more touched lanes of one kind than this collapse into a group header

// Places for events that don't name one: today's four lanes, so a project without place info looks as before.
export const FALLBACK = {
  screen: { id: "caller:you", kind: "caller", name: "YOU" }, // same id as the store's browser caller
  page: { id: "client:page", kind: "client", name: "PAGE" },
  server: { id: "service:server", kind: "service", name: "SERVER" },
  database: { id: "data:database", kind: "data", name: "DATABASE" },
} as const satisfies Record<string, Place>;
const FALLBACK_IDS = new Set<string>(Object.values(FALLBACK).map((p) => p.id));
const PLAIN: Partial<Record<PlaceKind, string>> = { client: "PAGE", service: "SERVER", data: "DATABASE" }; // a kind with one lane keeps its plain word
const GENERIC_SERVICE = new Set(["app", "server", "service"]); // the single-command default: a name the user gave ("api") is shown instead

export type Shape =
  | "worked" | "never_left_page" | "server_failed" | "db_refused" | "page_failed" | "repeated" | "slow" | "page_not_updated"
  | "outside_refused" | "cache_never_hit" | "slow_outside" | "came_back_empty";

export interface Station {
  id: string; // event id (first event for coils)
  stepIndex: number; // index into PlayStep[] (for coils/express: the first)
  lane: string; // place id
  place: Place;
  sub: number; // 0..2 nested offset inside the lane
  kind: DebugEvent["kind"] | "express";
  label: string; // "createTodo()", "INSERT INTO todos", "POST /api/todos"
  where?: string; // "todos.controller.ts:14" or "called at todos.controller.ts:18"
  file?: string; // repo-relative, the line E opens (call site for calls)
  line?: number;
  chip?: string; // one value worth seeing
  chipError?: boolean;
  status: Status;
  ms: number;
  caption: string;
  count?: number; // coil: repeated N times; express: N collapsed steps
  opaque?: boolean; // a project service that got the request but that Shrike can't see inside
  live?: boolean; // T22: a live project's server, not visible from the browser (also opaque)
  snap?: boolean; // the thread breaks here
  cache?: "hit" | "miss" | "set"; // T15 bounce, T16 pass-through, and the later fill
  back?: string; // cache marks: the lane of the code that asked (a poke returns there)
  fork?: { id: string; branch: number; main: boolean }; // T17: one of several things done at the same time
  eventIds: string[];
}

export interface TripCaller {
  place: Place;
  browser: boolean; // SCREEN shot (T10) vs terminal card (T20)
  text: string; // T20 card: "$ curl -X POST …", "cron · nightly"
}

export interface Trip {
  actionId: string;
  title: string; // 'Clicked "Add Todo"'
  status: Status;
  ms: number;
  shape: Shape;
  verdict: string; // one plain sentence for the shape
  returned: string; // "Server replied 201 Created" | "Server error (500)" | "Your page never called the server"
  caller: TripCaller;
  places: { place: Place; hop: number }[]; // every place the trip touched, caller first; hop = service hops from the caller
  forks: { id: string; caption: string }[];
  stations: Station[];
}

// ---------------------------------------------------------------- lanes (D9-D11)

export interface LaneDef {
  id: string;
  kind: PlaceKind;
  name: string;
  label: string; // header text: the place name, or the plain word when the kind has one lane
  detail?: string;
  ghost: boolean; // expected (D11), not seen yet
  hop: number;
}

const norm = (s: string) => s.split(" · ")[0]!.trim().toLowerCase();

/** The session's lanes, in D9 order: caller, client, service (by hops from the caller), queue, cache, data, outside. Pure. */
export function lanesFor(trips: readonly Trip[], expected: readonly Place[] = []): LaneDef[] {
  const seen = new Map<string, { place: Place; hop: number; n: number }>();
  for (const t of trips) for (const p of t.places) if (!seen.has(p.place.id)) seen.set(p.place.id, { ...p, n: seen.size }); // hop is fixed at first sight: lanes only slot in
  const fallbackKinds = new Set([...seen.values()].filter((v) => FALLBACK_IDS.has(v.place.id)).map((v) => v.place.kind));
  const all = [...seen.values()].map((v) => ({ ...v, ghost: false }));
  for (const p of expected) {
    if (fallbackKinds.has(p.kind)) continue; // an unnamed lane of this kind is probably this place
    if (all.some((v) => v.place.id === p.id || (v.place.kind === p.kind && norm(v.place.name) === norm(p.name)))) continue;
    all.push({ place: p, hop: Number.MAX_SAFE_INTEGER, n: all.length, ghost: true });
  }
  const rank = (k: PlaceKind) => KIND_ORDER.indexOf(k);
  all.sort((a, b) => rank(a.place.kind) - rank(b.place.kind) || (a.place.kind === "service" ? a.hop - b.hop : 0) || Number(a.ghost) - Number(b.ghost) || a.n - b.n);
  const per = new Map<PlaceKind, number>();
  for (const v of all) per.set(v.place.kind, (per.get(v.place.kind) ?? 0) + 1);
  return all.map(({ place: p, hop, ghost }) => {
    const plain = per.get(p.kind) === 1 && (p.kind !== "service" || GENERIC_SERVICE.has(norm(p.name))) ? PLAIN[p.kind] : undefined;
    return { id: p.id, kind: p.kind, name: p.name, label: plain ?? p.name, detail: plain && plain !== p.name ? p.name : p.detail, ghost, hop: ghost ? 0 : hop };
  });
}

/** Places a trip can land in without an event naming them: the project's page (for page events recorded before its address was known), its services with an address and no agent attached (a Python API), and a live project's servers (T22). Pure. */
export function knownPlaces(expected: readonly Place[] = [], procs: RunStatus["processes"] = [], live: Pick<ProjectInfo, "liveUrl" | "origins"> = {}): Place[] {
  const hosts = [...new Set([live.liveUrl, ...(live.origins ?? [])].map((o) => o && (hostOf(o) || o).toLowerCase()).filter((h): h is string => !!h))];
  return [
    ...expected.filter((p) => p.kind === "client" || (p.kind === "service" && !!p.detail && !procs.some((x) => `service:${x.name}` === p.id && x.instrumented))),
    ...hosts.map((h): Place => ({ id: `${LIVE}${h}`, kind: "service", name: "SERVER", detail: h })),
  ];
}
const LIVE = "service:live:";

/** Lanes a trip touches: its caller and every station's lane. */
export function touchedBy(trip: Trip): Set<string> {
  return new Set([trip.caller.place.id, ...trip.stations.map((s) => s.lane)]);
}

export interface LaneCol {
  key: string;
  kind: PlaceKind;
  label: string;
  head: string; // caps name for the header: "LRU", "STRIPE"
  sub?: string; // faint sub-label: "sessions", "test double"
  glyph: string; // SVG path (12x12)
  title: string; // tooltip
  mode: "full" | "sliver" | "group";
  ghost: boolean;
  ids: string[]; // lane ids drawn in this column (a group has several)
  left: number;
  w: number;
  x: number; // the lane's line
}

export interface LaneLayout {
  width: number;
  cols: LaneCol[];
  x: Record<string, number>;
  w: Record<string, number>;
  callerX: number;
}

const KIND_PLURAL: Record<PlaceKind, string> = { caller: "callers", client: "pages", service: "services", queue: "queues", cache: "caches", data: "databases", outside: "outside services" };

/**
 * D10 accordion: touched lanes share the width, the rest are 26px slivers, and more than 6 touched lanes of one kind
 * fold into one group column unless their kind is in `open`. With SCREEN, PAGE, SERVER, DATABASE all touched this
 * reproduces LANE_X exactly. Pure.
 */
export function laneColumns(lanes: readonly LaneDef[], touched: ReadonlySet<string>, width: number, open: ReadonlySet<string> = new Set()): LaneLayout {
  const count = new Map<PlaceKind, number>();
  for (const l of lanes) if (touched.has(l.id)) count.set(l.kind, (count.get(l.kind) ?? 0) + 1);
  const cols: LaneCol[] = [];
  for (const l of lanes) {
    const hot = touched.has(l.id);
    if (hot && (count.get(l.kind) ?? 0) > GROUP_AFTER && !open.has(l.kind)) {
      const g = cols.find((c) => c.mode === "group" && c.kind === l.kind);
      if (g) g.ids.push(l.id);
      else {
        const label = `${count.get(l.kind)} ${KIND_PLURAL[l.kind]}`;
        cols.push({ key: `group:${l.kind}`, kind: l.kind, label, head: label.toUpperCase(), glyph: laneGlyph(l), title: "Click to show each one", mode: "group", ghost: false, ids: [l.id], left: 0, w: 0, x: 0 });
      }
      continue;
    }
    const title = l.ghost ? `${l.name}: expected, not seen yet` : [l.label, l.detail].filter((t, i) => t && (i === 0 || !l.label.includes(t))).join(" · ");
    const { head, sub } = headOf(l);
    cols.push({ key: l.id, kind: l.kind, label: l.label, head, sub, glyph: laneGlyph(l), title, mode: hot ? "full" : "sliver", ghost: l.ghost, ids: [l.id], left: 0, w: 0, x: 0 });
  }
  const full = cols.filter((c) => c.mode !== "sliver");
  const slivers = cols.length - full.length;
  const caller = full[0]?.kind === "caller" ? full[0] : undefined;
  const others = full.length - (caller ? 1 : 0);
  const lastFull = cols.length > 0 && cols[cols.length - 1]!.mode !== "sliver";
  const total = (lastFull ? width * 1.01 : width) - SLIVER * slivers; // the last lane sits a little left of centre: its labels go left
  const k = total / ((caller ? 0.23 : 0) + 0.26 * others || 1);
  const cw = caller ? (others ? Math.min(0.26 * width, Math.max(0.23 * k, Math.min(0.23 * width, 140))) : Math.min(0.26 * width, total)) : 0;
  const ow = others ? (total - cw) / others : 0;
  let left = 0;
  const lastCol = full[full.length - 1];
  for (const c of cols) {
    c.left = left;
    c.w = c.mode === "sliver" ? SLIVER : c === caller ? cw : ow;
    c.x = Math.round(
      c.mode === "sliver" ? left + SLIVER / 2
      : c === caller ? left + Math.max((cw * 0.1) / 0.23, Math.min(0.1 * width, 66))
      : c === lastCol && others > 0 ? left + (ow * 11) / 26
      : left + ow / 2,
    );
    left += c.w;
  }
  const x: Record<string, number> = {};
  const w: Record<string, number> = {};
  for (const c of cols) for (const id of c.ids) (x[id] = c.x), (w[id] = c.mode === "sliver" ? 0 : c.w);
  return { width, cols, x, w, callerX: caller?.x ?? Math.round(0.1 * width) };
}

/** Header text: "LRU · sessions" -> LRU / sessions, "Stripe (test double)" -> STRIPE / test double, API + its host. */
export function headOf(l: Pick<LaneDef, "label" | "name" | "detail">): { head: string; sub?: string } {
  if (l.label !== l.name && !l.label.includes(" · ")) return { head: l.label }; // a plain word (PAGE, SERVER, DATABASE) stands alone, as in the four-lane view
  const paren = /^(.+?)\s*\((.+)\)$/.exec(l.label);
  const [head, sub] = paren ? [paren[1]!, paren[2]!] : l.label.includes(" · ") ? l.label.split(" · ") : [l.label, l.detail?.split(" · ").pop()];
  return { head: head!.toUpperCase(), ...(sub && sub.toUpperCase() !== head!.toUpperCase() ? { sub } : {}) };
}

const SHORT: Record<string, string> = { POSTGRES: "PGSQL", POSTGRESQL: "PGSQL", MONGODB: "MONGO", DYNAMODB: "DYNMO", RABBITMQ: "RMQ" };

/** A lane header's text for `room` px at `ch` px a letter: the name, else a 3 to 5 letter short form, else nothing (the glyph alone). Never cuts a word. */
export function fitHead(head: string, room: number, ch: number): string {
  const fits = (t: string) => t.length * ch <= room;
  if (fits(head)) return head;
  const words = head.split(" ");
  const short = SHORT[head] ?? (words.length > 1 ? words[0]! : head.length <= 5 ? head : head[0] + head.slice(1).replace(/[AEIOU\W_]/gi, "").slice(0, 3));
  return fits(short) ? short : "";
}

/** Place glyphs: the path form of @shrike/design placeGlyph (12x12, stroke), for lane headers in the DOM and on canvas. */
export const PLACE_GLYPH = {
  browser: "M3 2l6 4.2-2.6.6L8 10l-1.3.6L5.2 7.4 3 9z",
  terminal: "M2 3.5l3 2.5-3 2.5M6.5 9.5H10",
  clock: "M10.2 6a4.2 4.2 0 1 1-8.4 0a4.2 4.2 0 1 1 8.4 0M6 3.6V6l1.8 1.2",
  client: "M1.5 2.5h9v7h-9zM1.5 4.6h9",
  service: "M6 1.5l3.9 2.25v4.5L6 10.5 2.1 8.25v-4.5z",
  queue: "M2 3.5h8M2 6h8M2 8.5h5",
  cache: "M6.8 1.5L3 6.6h3l-.8 3.9L9 5.4H6z",
  data: "M2.2 3a3.8 1.4 0 1 0 7.6 0a3.8 1.4 0 1 0-7.6 0M2.2 3v6c0 .8 1.7 1.4 3.8 1.4s3.8-.6 3.8-1.4V3M2.2 6c0 .8 1.7 1.4 3.8 1.4S9.8 6.8 9.8 6",
  outside: "M5 2.5H2.5v7h7V7M7 2h3v3M10 2L5.5 6.5",
} as const;

/** A caller's glyph says who called: a click for the browser, a clock for cron, a prompt for the rest. */
export function laneGlyph(l: Pick<LaneDef, "id" | "kind">): string {
  if (l.kind !== "caller") return PLACE_GLYPH[l.kind];
  return PLACE_GLYPH[/^caller:(you|screen|browser)$/.test(l.id) ? "browser" : l.id === "caller:cron" ? "clock" : "terminal"];
}

// ---------------------------------------------------------------- the trip model

export interface PlacedStation extends Station {
  x: number;
  y: number;
  reach: number; // thread length at which the tip arrives here (Infinity: the thread broke before it)
  left: boolean; // label on the left (the rightmost lanes)
  room: number; // px the label may use, from 18px off the station
}

export interface ForkPath {
  id: string;
  d: string;
  pts: [number, number][];
  start: number; // main-thread length where this branch leaves it
  label?: { x: number; y: number }; // "at the same time", once per fork
  folded?: boolean;
}

export interface TripGeometry {
  height: number;
  shotY: number; // caller card ("before" shot or terminal card) centre
  endY: number; // "after" card centre
  stations: PlacedStation[];
  outPts: [number, number][]; // main thread polyline (M/H/V only, so lengths are exact)
  out: string; // outbound thread, stops at the snap
  ret: string; // return line back to the caller
  forks: ForkPath[]; // T17 side branches
  callerX: number;
  lanes: LaneLayout;
}

const MAX_VISIBLE = 14;
const HEAD = 104; // trip title + before shot
const ROW = 74;
const TAIL = 120;

const basename = (f: string) => f.split("/").pop() ?? f;
const loc = (e: DebugEvent) => (e.source ? `${basename(e.source.file)}:${e.source.line}` : undefined);
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// ponytail: known dev-server console chatter; a project-level ignore list is the upgrade path.
const DEV_NOISE = /^\[(vite|hmr|webpack|Fast Refresh)\]|Download the React DevTools/i;
const normSql = (s: string) => s.replace(/\s+/g, " ").replace(/'[^']*'|\b\d+\b/g, "?").trim();
const pathOf = (url = "") => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};
const hostOf = (url = "") => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};
const localHost = (h?: string) => h?.replace(/^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?=:|$)/, "localhost");

const CALLER_NAMES: Record<string, string> = { curl: "CURL", postman: "POSTMAN", explorer: "EXPLORER", agent: "AGENT", cron: "CRON", test: "TEST", service: "SERVICE", other: "CALLER" };

function callerOf(root: DebugEvent): TripCaller {
  const c = root.caller;
  const browser = root.origin === "browser" && (!c || c.kind === "browser");
  if (browser) return { place: root.place?.kind === "caller" ? root.place : FALLBACK.screen, browser, text: root.name };
  const kind = c?.kind ?? (root.trigger === "explorer" || root.trigger === "agent" ? root.trigger : "other");
  const place: Place = root.place?.kind === "caller" ? root.place : { id: `caller:${kind}`, kind: "caller", name: CALLER_NAMES[kind] ?? "CALLER" };
  // T20: the command as typed (headers left out so the body that matters shows); a script says which one ran.
  const cmd = c?.command?.replace(/ -H '[^']*'/g, "");
  const text = c?.kind === "cron" || c?.kind === "test" ? [c.label, cmd && `$ ${cmd}`].filter(Boolean).join("\n") : cmd ? `$ ${cmd}` : (c?.label ?? root.name);
  return { place, browser, text };
}

function outsidePlace(e: DebugEvent): Place {
  const host = hostOf(e.http?.url) ?? "outside";
  const parts = host.split(":")[0]!.split(".");
  const name = (parts.length > 1 ? parts[parts.length - 2]! : host).toUpperCase();
  return { id: `outside:${host}`, kind: "outside", name, detail: host };
}

/** Where an event ran. Events that don't say inherit their caller's service or page; datastores and outside hosts get their own lane. */
function placeFor(e: DebugEvent, parent: Place | undefined, hasServedChild: boolean, page: Place): Place {
  if (e.kind === "external_call") {
    if (e.place?.kind === "outside" || (!e.place && !hasServedChild)) return e.place ?? outsidePlace(e);
    return parent?.kind === "service" || parent?.kind === "queue" || parent?.kind === "caller" ? parent : FALLBACK.server; // a call into an instrumented service starts in the caller's lane (T19); a queue's delivery in its QUEUE lane; a cron script's call in its CRON lane
  }
  if (e.place) return e.place;
  if (e.kind === "db_query") return FALLBACK.database;
  if (e.kind === "cache_op") return { id: `cache:${e.db?.system ?? "cache"}`, kind: "cache", name: "CACHE" };
  if (e.origin === "browser") return parent?.kind === "client" ? parent : page;
  if (e.kind === "http_request") return FALLBACK.server;
  return parent?.kind === "service" ? parent : FALLBACK.server;
}

function labelOf(e: DebugEvent): string {
  switch (e.kind) {
    case "user_action":
      return e.trigger === "navigation" ? "page loaded" : e.trigger === "submit" ? "onSubmit" : "onClick";
    case "http_request":
      return e.origin === "server" ? `${e.http?.method ?? ""} ${e.http?.url ?? ""}`.trim() : `fetch ${e.http?.method ?? ""} ${e.http?.url ?? ""}`.trim();
    case "external_call":
      return e.place?.kind === "outside" || !e.place ? clip(`${e.http?.method ?? ""} ${pathOf(e.http?.url)}`.trim() || e.name, 40) : clip(`fetch ${e.http?.method ?? ""} ${pathOf(e.http?.url)}`, 40);
    case "cache_op":
      return e.cache?.hit === true ? "hit" : e.cache?.hit === false ? "miss" : (e.cache?.op ?? "cache");
    case "db_query":
      return clip(e.db?.statement ?? e.name, 48);
    case "log":
      return `log "${clip(logParts(e.log?.message ?? "").text, 28)}"`;
    case "error":
      return "uncaught error";
    default:
      return clip(e.name, 40);
  }
}

const cacheMark = (e: DebugEvent): Station["cache"] =>
  e.kind !== "cache_op" ? undefined : e.cache?.hit === true ? "hit" : e.cache?.hit === false ? "miss" : /^(set|hset|setex|mset|put)$/i.test(e.cache?.op ?? "") ? "set" : undefined;

/** A log line split into its words and the value logged after them: "creating todo { title: 'x' }". */
function logParts(message: string): { text: string; value?: string } {
  const m = /^([^{[]*?)\s*([{[][\s\S]*)$/.exec(message.trim());
  return m?.[1] ? { text: m[1], value: m[2] } : { text: message };
}

/** A JSON body as people write it: { title: "buy milk", userId: 1 }. */
function pretty(body: string): string {
  const fmt = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map(fmt).join(", ")}]`
    : v && typeof v === "object" ? `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${fmt(x)}`).join(", ")} }`
    : JSON.stringify(v) ?? String(v);
  try {
    return fmt(JSON.parse(body));
  } catch {
    return body;
  }
}

// failed: the step or something it called failed; only then is an undefined argument a suspect (React props are full of them).
function chipOf(s: PlayStep, failed: () => boolean): { chip?: string; chipError?: boolean } {
  const e = s.event;
  if (e.kind === "db_query" && e.status === "error") return { chip: clip(e.error?.message ?? "refused", 60), chipError: true };
  if (e.kind === "external_call" && (e.status === "error" || (e.http?.status ?? 0) >= 400)) {
    const why = refusal(e) ?? (e.http?.status ? statusWords(e.http.status) : "failed");
    return { chip: clip(why, 60), chipError: true };
  }
  if (e.kind === "function") {
    const args = (e.args ?? []).filter((a) => a !== "res" && !a.startsWith("[Function") && !a.startsWith("req "));
    if (args.length) {
      const chip = clip(args.join(", "), 60);
      return { chip, chipError: /\bundefined\b|\bnull\b|NaN/.test(chip) && failed() };
    }
    if (e.status === "error") return { chip: clip(e.error?.message ?? "failed", 60), chipError: true };
  }
  if (e.kind === "error") return { chip: clip(e.error?.message ?? e.name, 60), chipError: true };
  if (e.kind === "log") {
    const { text, value } = logParts(e.log?.message ?? "");
    const chip = value ?? (text.length > 28 ? text : undefined);
    return chip ? { chip: clip(chip, 48) } : {};
  }
  if (e.kind === "http_request" && e.origin === "browser" && e.http?.reqBody) return { chip: clip(pretty(e.http.reqBody), 48) };
  return {};
}

function failedBelow(steps: PlayStep[], i: number): boolean {
  for (let j = i; j < steps.length && (j === i || steps[j]!.depth > steps[i]!.depth); j++) if (steps[j]!.event.status === "error") return true;
  return false;
}

function whereOf(e: DebugEvent): string | undefined {
  if (e.kind === "cache_op") return e.cache?.key;
  if (e.kind === "function" && e.callSite) return `called at ${basename(e.callSite.file)}:${e.callSite.line}`;
  return loc(e);
}

// ---------------------------------------------------------------- T17 forks

const FORKABLE = new Set<DebugEvent["kind"]>(["function", "http_request", "external_call", "db_query", "cache_op"]);
const PAST: Record<string, string> = { get: "got", send: "sent", find: "found", make: "made", build: "built", write: "wrote", read: "read", run: "ran", set: "set", put: "put", pay: "paid" };
const VERBS = new Set([
  "charge", "save", "send", "create", "get", "load", "fetch", "update", "delete", "insert", "check", "verify", "write", "read", "log", "notify", "record", "add", "set",
  "find", "make", "build", "call", "emit", "publish", "store", "upload", "process", "validate", "compute", "render", "list", "remove", "post", "put", "sync", "refresh",
  "track", "queue", "enqueue", "schedule", "email", "resize", "generate", "parse", "apply", "reserve", "ship", "bill", "refund", "cancel", "sign", "issue", "pay", "warm", "audit",
]);
const past = (v: string) => PAST[v] ?? (v.endsWith("e") ? `${v}d` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ied` : `${v}ed`);
const singular = (w: string) => w.replace(/ies$/, "y").replace(/s$/, "");
const article = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

/** One branch of a fork in a few words: chargeCard() -> "charged the card", INSERT INTO events -> "saved an event". */
function phrase(e: DebugEvent): string {
  if (e.kind === "function") {
    const words = e.name.replace(/\(\)$/, "").split(/(?=[A-Z])|_/).map((w) => w.toLowerCase()).filter(Boolean);
    const [verb, ...rest] = words;
    return verb && VERBS.has(verb) ? `${past(verb)}${rest.length ? ` the ${rest.join(" ")}` : ""}` : `ran ${e.name}`;
  }
  if (e.kind === "db_query") {
    const sql = e.db?.statement ?? e.name;
    const t = /\b(?:into|from|update)\s+["`]?(\w+)/i.exec(sql)?.[1];
    if (/^\s*insert/i.test(sql) && t) return `saved ${article(singular(t))}`;
    if (/^\s*update/i.test(sql) && t) return `updated ${t}`;
    if (/^\s*delete/i.test(sql) && t) return `deleted from ${t}`;
    return t ? `read ${t}` : "asked the database";
  }
  if (e.kind === "cache_op") return cacheMark(e) === "set" ? "filled the cache" : "checked the cache";
  if (e.kind === "external_call") return e.place?.kind === "service" ? `called ${serviceWords(e.place)}` : `called ${e.place ? placeWords(e.place) : (hostOf(e.http?.url) ?? "a server")}`;
  return `called ${e.http?.url ?? e.name}`;
}

const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Siblings that overlap in time (Promise.all and friends), one level deep: step index -> fork branch. */
function findForks(steps: PlayStep[], parentOf: number[]): Map<number, { id: string; branch: number }> {
  const out = new Map<number, { id: string; branch: number }>();
  const kids = new Map<number, number[]>();
  steps.forEach((s, i) => {
    if (i === 0) return;
    const p = parentOf[i]!;
    kids.set(p, [...(kids.get(p) ?? []), i]);
  });
  const subtreeEnd = (i: number) => {
    let j = i + 1;
    while (j < steps.length && steps[j]!.depth > steps[i]!.depth) j++;
    return j;
  };
  for (const [p, list] of kids) {
    if (p >= 0 && out.has(p)) continue; // ponytail: forks inside a fork branch draw in sequence; nested forks are the upgrade path
    let run: number[] = [];
    let end = -Infinity;
    const close = () => {
      if (run.length >= 2) {
        const id = steps[run[0]!]!.id;
        run.forEach((c, b) => {
          for (let j = c; j < subtreeEnd(c); j++) out.set(j, { id, branch: b });
        });
      }
      run = [];
      end = -Infinity;
    };
    for (const c of list) {
      const s = steps[c]!;
      const ok = FORKABLE.has(s.event.kind) && s.durationMs > 0;
      if (!ok) {
        close();
        continue;
      }
      if (run.length && s.startMs < end - 1) run.push(c);
      else {
        close();
        run = [c];
      }
      end = Math.max(end, s.startMs + s.durationMs);
    }
    close();
  }
  return out;
}

// ---------------------------------------------------------------- buildTrip

/** Build the trip model from an action. `known`: knownPlaces() (unplaced page events land in the project's page; a page's call to an uninstrumented service lands in its lane). Pure. */
export function buildTrip(view: ActionView, expanded: ReadonlySet<string> = new Set(), known: readonly Place[] = []): Trip {
  const steps = toSteps(view);
  const caller = callerOf(view.root);

  // Places and service hops per step (a step inherits its parent's service or page).
  const parentOf: number[] = [];
  const stack: number[] = [];
  for (const s of steps) {
    while (stack.length && steps[stack[stack.length - 1]!]!.depth >= s.depth) stack.pop();
    parentOf.push(stack[stack.length - 1] ?? -1);
    stack.push(s.index);
  }
  const served = new Set(steps.filter((s) => s.event.kind === "http_request" && s.event.origin === "server").map((s) => parentOf[s.index]!));
  const page = known.find((k) => k.kind === "client") ?? FALLBACK.page;
  const places: Place[] = [];
  const hops: number[] = [];
  for (const s of steps) {
    const p = parentOf[s.index]!;
    const place = s.index === 0 ? caller.place : placeFor(s.event, places[p], served.has(s.index), page);
    places.push(place);
    const ph = p >= 0 ? hops[p]! : 0;
    const crossed = place.kind === "service" && p >= 0 && places[p]!.kind === "service" && places[p]!.id !== place.id;
    hops.push(ph + (crossed ? 1 : 0));
  }
  // A call to the host a database lives on (Supabase's auth keys next to its PostgREST) is that database, not an outside service.
  const stores = new Map([...places, ...known].filter((q) => (q.kind === "data" || q.kind === "cache") && q.detail).map((q) => [localHost(q.detail), q]));
  places.forEach((q, i) => {
    const db = q.kind === "outside" ? stores.get(localHost(q.detail)) : undefined;
    if (db) places[i] = db;
  });
  const forkOf = findForks(steps, parentOf);

  const raw: Station[] = [];
  const laneBase = new Map<string, number>();
  let prevLane: string | null = null;
  const same = (a: DebugEvent, b: DebugEvent) =>
    a.kind === b.kind &&
    (a.kind === "db_query" ? normSql(a.db?.statement ?? "") === normSql(b.db?.statement ?? "")
    : a.kind === "cache_op" ? a.cache?.op === b.cache?.op && a.cache?.key === b.cache?.key
    : a.kind === "external_call" ? a.http?.method === b.http?.method && a.http?.url === b.http?.url
    : a.name === b.name && a.source?.line === b.source?.line);
  const bump = (st: Station, e: DebugEvent, ms: number) => {
    st.count = (st.count ?? 1) + 1;
    st.ms += ms;
    st.eventIds.push(e.id);
    if (e.status === "error") st.status = "error";
    st.caption = e.kind === "db_query" ? `The same database question was asked ${st.count} times.` : `${e.name} ran ${st.count} times in a row.`;
    st.chip = `×${st.count}, ${Math.round(st.ms)}ms total`;
    // T5 waste: a repeated query, or a call repeated often or long enough to matter; two quick calls are just two calls.
    if (st.status !== "error" && (e.kind === "db_query" || st.count >= 5 || st.ms >= 50)) st.status = "slow";
  };
  // Inside a repeat of an already-drawn call: its children fold into the first call's stations, in order.
  let absorb: { depth: number; cursor: number } | null = null;

  for (const s of steps) {
    const e = s.event;
    if (absorb && s.depth > absorb.depth) {
      const target = raw[absorb.cursor];
      if (target && same(steps[target.stepIndex]!.event, e)) {
        bump(target, e, s.durationMs);
        absorb.cursor++;
      }
      continue; // ponytail: a child that doesn't line up with the first call's children is dropped from the drawing
    }
    absorb = null;
    if (e.kind === "user_action" && !e.source) continue; // nothing to point at; the caller card carries it
    if (e.kind === "http_request" && (e.origin === "explorer" || e.origin === "agent")) continue; // the caller's own request: its card says it
    if (e.kind === "log" && e.origin === "browser" && DEV_NOISE.test(e.log?.message ?? "")) continue;
    if (e.kind === "function" && e.status === "ok" && /^(anonymous|\w+ callback)(\(\))?$/.test(e.name)) continue; // inline callbacks are plumbing, not a step anyone wrote by name
    const place = s.index === 0 ? (places.find((q) => q.kind === "client") ?? page) : places[s.index]!; // the root's handler runs in the page
    const lane = place.id;
    if (lane !== prevLane || !laneBase.has(lane)) laneBase.set(lane, s.depth);
    prevLane = lane;
    const sub = Math.max(0, Math.min(2, s.depth - (laneBase.get(lane) ?? s.depth)));
    // Coil: identical repeated queries (or repeated calls of the same function, with their subtrees) back to back.
    if (e.kind === "db_query" || e.kind === "function" || e.kind === "cache_op") {
      let pi = raw.length - 1;
      while (pi >= 0 && steps[raw[pi]!.stepIndex]!.depth > s.depth) pi--;
      const prev = raw[pi];
      if (prev && steps[prev.stepIndex]!.depth === s.depth && same(steps[prev.stepIndex]!.event, e) && forkOf.get(prev.stepIndex)?.id === forkOf.get(s.index)?.id) {
        bump(prev, e, s.durationMs);
        if (e.kind === "function") absorb = { depth: s.depth, cursor: pi + 1 };
        continue;
      }
    }
    const at = e.kind === "function" && e.callSite ? e.callSite : e.source;
    const fork = forkOf.get(s.index);
    raw.push({
      id: e.id, stepIndex: s.index, lane, place, sub, kind: e.kind, label: labelOf(e), where: whereOf(e), file: at?.file, line: at?.line,
      ...chipOf(s, () => failedBelow(steps, s.index)), status: e.status, ms: s.durationMs, caption: s.caption, cache: cacheMark(e), back: e.kind === "cache_op" ? places[parentOf[s.index]!]?.id : undefined, fork: fork && { ...fork, main: false }, eventIds: [e.id],
    });
    // A page's call to one of the project's own services with nothing recorded inside (a Python API, an agent that isn't attached): show it arrive in that lane.
    const unserved = e.kind === "http_request" && e.origin === "browser" && !served.has(s.index);
    const host = unserved ? localHost(hostOf(e.http?.url)) : undefined;
    const svc = host ? known.find((k) => k.kind === "service" && !k.id.startsWith(LIVE) && localHost(k.detail) === host) : undefined;
    const srv: Place | undefined = unserved && !svc ? liveServer(known, host ?? (place as Place).detail) : undefined; // a same-origin url has no host: it went to the page's own
    if (srv) {
      raw.push({ id: `${e.id}:in`, stepIndex: s.index, lane: srv.id, place: srv, sub: 0, kind: "http_request", ...unseen(e, isRsc(e)), status: e.status, ms: s.durationMs, opaque: true, live: true, fork: fork && { ...fork, main: false }, eventIds: [e.id] });
      prevLane = srv.id;
    }
    if (svc) {
      const what = `${e.http?.method ?? ""} ${pathOf(e.http?.url)}`.trim();
      const res = e.http?.status ? `: ${statusWords(e.http.status)}` : "";
      raw.push({
        id: `${e.id}:in`, stepIndex: s.index, lane: svc.id, place: svc, sub: 0, kind: "http_request", label: clip(what, 48), status: e.status, ms: s.durationMs, opaque: true,
        caption: `${serviceWords(svc).replace(/^t/, "T")} got ${what}${res}. Shrike can't see inside it.`, fork: fork && { ...fork, main: false }, eventIds: [e.id],
      });
      prevLane = svc.id;
    }
  }

  // T22: a live page's own load with nothing recorded on its server was rendered there.
  const loadedOn = view.root.trigger === "navigation" && caller.browser && !served.size ? liveServer(known, places.find((q) => q.kind === "client")?.detail) : undefined;
  if (loadedOn) raw.unshift({ id: `${view.root.id}:in`, stepIndex: 0, lane: loadedOn.id, place: loadedOn, sub: 0, kind: "http_request", ...unseen(view.root, true), status: "ok", ms: 0, opaque: true, live: true, eventIds: [view.root.id] });

  // Snap: the first failing station with no failing station inside it (the innermost failure, in run order).
  const failsInside = (i: number) => {
    const d = steps[raw[i]!.stepIndex]!.depth;
    for (let j = i + 1; j < raw.length; j++) {
      if (steps[raw[j]!.stepIndex]!.depth <= d) return false;
      if (raw[j]!.status === "error") return true;
    }
    return false;
  };
  const snapAt = raw.findIndex((st, i) => st.status === "error" && !failsInside(i) && !raw[i + 1]?.opaque); // a page's call breaks where it arrived
  if (snapAt >= 0) raw[snapAt]!.snap = true;
  explainFailures(raw, steps);
  const multi = new Set(raw.filter((s) => s.place.kind === "service").map((s) => s.lane)).size > 1;
  explainPlaces(raw, steps, multi);
  const forks = markForks(raw, steps);
  const hog = view.status === "slow" ? markSlow(raw, steps) : undefined;

  const stations = collapse(foldSideBranches(raw, expanded), expanded);
  const browserReq = steps.find((s) => s.event.kind === "http_request" && s.event.origin === "browser")?.event;
  const firstReq = steps.find((s) => s.event.kind === "http_request")?.event;
  // A cross-origin answer without CORS headers (FastAPI's 500) reaches the page as a network error: the server's side still has the status.
  const answer = browserReq && !browserReq.http?.status ? steps.find((s) => s.event.kind === "http_request" && s.event.origin === "server" && s.event.parentId === browserReq.id)?.event : undefined;
  const httpStatus = browserReq?.http?.status ?? answer?.http?.status ?? firstReq?.http?.status;
  const h = (browserReq ?? firstReq)?.http?.resHeaders;
  const to = h?.["x-remix-redirect"] ?? (httpStatus && httpStatus >= 300 && httpStatus < 400 ? h?.location : undefined); // Remix answers a redirect to a data fetch with 204 and this header
  const direct = caller.browser ? raw.find((s) => s.place.kind === "data" && steps[s.stepIndex]!.event.origin === "browser")?.place : undefined; // Supabase, Firebase called from the page
  const returned =
    to ? `Server sent your page to ${pathOf(to)}`
    : httpStatus ? (httpStatus >= 400 ? statusWords(httpStatus) : `Server replied ${statusWords(httpStatus)}`)
    : loadedOn ? "Rendered on the server"
    : direct ? `Your page asked ${placeWords(direct)} directly`
    : caller.browser ? "Your page never called the server"
    : view.status === "error" ? "It stopped with an error"
    : "It finished";
  const tripPlaces = new Map<string, { place: Place; hop: number }>([[caller.place.id, { place: caller.place, hop: 0 }]]);
  for (const st of raw) if (!tripPlaces.has(st.lane)) tripPlaces.set(st.lane, { place: st.place, hop: hops[st.stepIndex]! });
  const { shape, verdict } = classify(view, raw, caller, multi, httpStatus, hog, to && pathOf(to));
  return { actionId: view.id, title: view.label, status: view.status, ms: Math.round(view.durationMs), shape, verdict, returned, caller, places: [...tripPlaces.values()], forks, stations };
}

const depthOf = (st: Station, steps: PlayStep[]) => steps[st.stepIndex]!.depth;

/** T22: the live server lane a request to `host` (the page's own when unknown) lands in; none on a project without `liveUrl`. */
function liveServer(known: readonly Place[], host?: string): Place | undefined {
  const live = known.filter((k) => k.id.startsWith(LIVE));
  return host ? live.find((k) => k.detail === host.toLowerCase()) : live[0]; // ponytail: an unknown page host is taken as the live page; a project with a local page and liveUrl (#62) should pass the pane's host
}

// Next.js page data: the router's fetch carries an RSC header and an _rsc query.
const isRsc = (e: DebugEvent) => e.http?.reqHeaders?.rsc === "1" || /[?&]_rsc=/.test(e.http?.url ?? "");
const CDN_HIT = ["x-vercel-cache", "cf-cache-status", "x-cache"];
// #59: Server-Timing entries with a duration become the station's chip: "db 180ms, render 40ms".
function serverTiming(e: DebugEvent): string | undefined {
  const t = e.http?.serverTiming;
  if (!Array.isArray(t)) return undefined; // from the page: don't trust the shape
  const parts = t.filter((x) => typeof x?.name === "string" && typeof x.durMs === "number").map((x) => `${x.name} ${Math.round(x.durMs!)}ms`);
  return parts.length ? clip(parts.join(", "), 48) : undefined;
}

/** T22 words: what answered, its status and time, and why Shrike can't show more. */
function unseen(e: DebugEvent, rendered: boolean): Pick<Station, "label" | "where" | "caption" | "chip"> {
  const h = e.http;
  const where = h?.status ? statusWords(h.status) : rendered && !h ? "page load" : undefined;
  const what = h ? `${h.method} ${pathOf(h.url)}` : "your page";
  const chip = serverTiming(e);
  if (h?.fromCache) return { label: "From cache", where, chip, caption: `Your browser answered ${what} from its cache or the site's service worker. It never reached your server.` }; // #55
  if (CDN_HIT.some((k) => /^hit\b/i.test(h?.resHeaders?.[k] ?? ""))) return { label: "From cache", where, chip, caption: `A cache answered ${what}, not your server.` };
  // ponytail: every live page load reads as rendered on the server; telling a static page apart needs the document's response headers
  if (rendered) return { label: "Rendered on the server", where, chip, caption: `The server rendered ${what}. Your browser only sees the finished result.` };
  return { label: "Server, not visible from your browser", where, chip, caption: `The server got ${what}${where ? `: ${where}` : ""}. What happened inside isn't visible from your browser.` };
}

// Plain "why" captions: the call that got the bad value names who passed it; a call the failure only went through names what failed.
function explainFailures(raw: Station[], steps: PlayStep[]): void {
  raw.forEach((st, i) => {
    if (st.kind !== "function" || st.status !== "error" || (st.count ?? 1) > 1) return;
    const d = depthOf(st, steps);
    const bad = st.chipError ? /(?:[\w$]+: )?\b(?:undefined|null|NaN)\b/.exec(st.chip ?? "")?.[0] : undefined;
    if (bad) {
      let min = d;
      let caller: Station | undefined;
      for (let c = i - 1; c >= 0 && !caller; c--) {
        const dc = depthOf(raw[c]!, steps);
        if (dc >= min) continue;
        min = dc;
        if (raw[c]!.kind === "function") caller = raw[c];
      }
      st.caption = caller ? `${caller.label} passed ${bad} to ${st.label}.` : `${st.label} got ${bad}.`;
      return;
    }
    let end = i + 1;
    while (end < raw.length && depthOf(raw[end]!, steps) > d) end++;
    const inside = raw.slice(i + 1, end);
    const first = inside.find((x) => x.status === "error");
    const snap = inside.find((x) => x.snap);
    for (const r of first && snap && (first.kind === "external_call" || first.kind === "http_request") ? [snap] : inside) { // a request only carried the failure: name where it broke
      if (r.status !== "error") continue;
      st.caption =
        r.kind === "db_query" ? `${st.label} stopped because the database refused.`
        : r.place.kind === "outside" ? `${st.label} stopped because ${placeWords(r.place)} refused.`
        : `${st.label} stopped because ${r.label} failed.`;
      return;
    }
  });
}

// Captions that need neighbours: a miss names what it did next; with several services, each request names its service.
function explainPlaces(raw: Station[], steps: PlayStep[], multi: boolean): void {
  raw.forEach((st, i) => {
    const e = steps[st.stepIndex]!.event;
    if (st.cache === "miss" && raw[i + 1]?.kind === "db_query" && e.cache?.key) st.caption = `The cache didn't have ${e.cache.key}, so it asked the database.`;
    const next = raw.find((x) => x.snap);
    if (st.kind === "function" && next?.kind === "external_call" && next.place.kind === "outside" && st.eventIds.includes(steps[next.stepIndex]!.event.parentId ?? "")) {
      const why = refusal(steps[next.stepIndex]!.event); // the call that sent the refused request carries the clue: its arguments
      st.caption = `${st.label} sent ${st.chip ?? "a request"} to ${placeWords(next.place)}, which refused${why ? `: ${why.replace(/\.$/, "")}` : ""}.`;
    }
    if (multi && st.kind === "http_request" && st.place.kind === "service") st.caption = st.caption.replace(/^The server got/, `${serviceWords(st.place).replace(/^t/, "T")} got`);
  });
}

// T17: the branch with the break (else the slowest) carries the main thread; its first station says what ran at once.
function markForks(raw: Station[], steps: PlayStep[]): Trip["forks"] {
  const byId = new Map<string, Station[]>();
  for (const st of raw) if (st.fork) byId.set(st.fork.id, [...(byId.get(st.fork.id) ?? []), st]);
  const out: Trip["forks"] = [];
  for (const [id, list] of byId) {
    const branches = [...new Set(list.map((s) => s.fork!.branch))];
    if (branches.length < 2) {
      list.forEach((s) => delete s.fork);
      continue;
    }
    const first = branches.map((b) => list.find((s) => s.fork!.branch === b)!);
    const ms = (b: number) => steps[first[branches.indexOf(b)]!.stepIndex]!.durationMs;
    const reach = (b: number) => new Set(list.filter((s) => s.fork!.branch === b).map((s) => s.lane)).size; // the branch that goes deepest tells the most
    const main = list.find((s) => s.snap)?.fork!.branch ?? branches.reduce((a, b) => (reach(b) > reach(a) || (reach(b) === reach(a) && ms(b) > ms(a)) ? b : a));
    list.forEach((s) => (s.fork!.main = s.fork!.branch === main));
    const caption = `Did ${branches.length} things at the same time: ${listWords(first.map((s) => phrase(steps[s.stepIndex]!.event)))}.`;
    const lead = [first[branches.indexOf(main)]!, ...first].find((s) => s.status === "ok" && !s.chipError && !/, which refused/.test(s.caption)); // a failing step, or one that sent the refused call, keeps its own words
    if (lead) lead.caption = caption;
    out.push({ id, caption });
  }
  return out;
}

const FOLD_SIDE = 3; // a side branch longer than this folds into one express station

/** T17 + T11: a long side branch (one of several parallel requests) folds into one express station, so twin branches never print over each other. */
function foldSideBranches(raw: Station[], expanded: ReadonlySet<string>): Station[] {
  const branch = new Map<string, Station[]>();
  for (const st of raw) if (st.fork && !st.fork.main) branch.set(`${st.fork.id}/${st.fork.branch}`, [...(branch.get(`${st.fork.id}/${st.fork.branch}`) ?? []), st]);
  const fold = new Map<Station, Station>();
  for (const list of branch.values()) {
    const f = list[0]!;
    const long = list.length > FOLD_SIDE || (list.length > 1 && crowded(f, raw)); // a crowded branch can't draw beside the others
    if (!long || list.some((x) => x.snap) || expanded.has(f.id)) continue;
    const status: Status = list.some((x) => x.status === "error") ? "error" : list.some((x) => x.status === "slow") ? "slow" : "ok";
    fold.set(f, { ...f, kind: "express", label: `${f.label} · ${list.length} steps`, where: undefined, chip: undefined, chipError: undefined, cache: undefined, back: undefined, count: list.length, status, caption: `At the same time: ${f.label}, ${list.length} steps. Enter to expand.`, eventIds: list.flatMap((x) => x.eventIds) });
    for (const x of list.slice(1)) fold.set(x, f);
  }
  return raw.flatMap((st) => (fold.get(st) === undefined ? [st] : fold.get(st)!.kind === "express" ? [fold.get(st)!] : []));
}

/** A side branch that starts in a lane where two other branches of its fork start too (Promise.all of fetches). */
function crowded(f: Station, all: readonly Station[]): boolean {
  if (!f.fork || f.fork.main) return false;
  const firsts = all.filter((x, i) => x.fork?.id === f.fork!.id && all.findIndex((y) => y.fork?.id === x.fork!.id && y.fork.branch === x.fork!.branch) === i);
  return firsts.filter((x) => x.lane === f.lane).length > 2; // two share a lane side by side (labels left and right); a third has no room
}

// Slow trip: blame the steps whose own time (minus the calls inside them) is the biggest, and draw them amber.
function markSlow(raw: Station[], steps: PlayStep[]): { st: Station; ms: number } | undefined {
  const own = (st: Station) => {
    if ((st.count ?? 1) > 1) return st.ms;
    const i = st.stepIndex;
    const d = steps[i]!.depth;
    let inner = 0;
    for (let j = i + 1; j < steps.length && steps[j]!.depth > d; j++) if (steps[j]!.depth === d + 1) inner += steps[j]!.durationMs;
    return Math.max(0, steps[i]!.durationMs - inner); // ponytail: parallel children can overlap; clamped, not merged
  };
  const mine = raw.map(own);
  const top = Math.max(0, ...mine);
  let hog: { st: Station; ms: number } | undefined;
  raw.forEach((st, i) => {
    if (st.status !== "ok" || mine[i]! < Math.max(50, top * 0.5)) return;
    st.status = "slow";
    st.caption = `${st.label} took ${Math.round(mine[i]!)}ms.`;
    if (!hog || mine[i]! > hog.ms) hog = { st, ms: mine[i]! };
  });
  return hog;
}

function collapse(stations: Station[], expanded: ReadonlySet<string>): Station[] {
  if (stations.length <= MAX_VISIBLE) return stations;
  const keep = (s: Station, i: number, all: Station[]) =>
    s.status !== "ok" || s.snap || !!s.chip || s.count || !!s.fork || !!s.cache || i === 0 || i === all.length - 1 || all[i - 1]?.lane !== s.lane || all[i + 1]?.lane !== s.lane || s.kind !== "function";
  const out: Station[] = [];
  let run: Station[] = [];
  const flush = () => {
    if (run.length >= 2 && !expanded.has(run[0]!.id)) {
      const f = run[0]!;
      out.push({ ...f, kind: "express", label: `${run.length} steps`, where: undefined, chip: undefined, count: run.length, ms: run.reduce((a, r) => a + r.ms, 0), caption: `${run.length} routine steps. Enter to expand.`, eventIds: run.flatMap((r) => r.eventIds) });
    } else out.push(...run);
    run = [];
  };
  stations.forEach((s, i, all) => {
    if (keep(s, i, all)) { flush(); out.push(s); } else run.push(s);
  });
  flush();
  return out;
}

function classify(view: ActionView, st: Station[], caller: TripCaller, multi: boolean, httpStatus?: number, hog?: { st: Station; ms: number }, redirect?: string): { shape: Shape; verdict: string } {
  const snap = st.find((s) => s.snap);
  const coil = st.find((s) => (s.count ?? 0) >= 3 && s.kind === "db_query");
  const reachedServer = st.some((s) => !s.opaque && s.place.kind !== "client" && s.place.kind !== "caller");
  const blind = st.find((s) => s.opaque && !s.live)?.place;
  const live = st.some((s) => s.live);
  const inside = live ? "What happened inside isn't visible from your browser." : `Shrike can't see inside ${blind ? "it" : "that server"}.`;
  const where = (s: Station) => (multi && s.place.kind === "service" ? serviceWords(s.place).replace(/^t/, "T") : "The server");
  if (snap?.place.kind === "data") return { shape: "db_refused", verdict: snap.caption };
  if (snap?.place.kind === "outside") {
    const e = snap.chip && snap.chipError ? snap.chip : undefined;
    const why = e && !/\(\d{3}\)$/.test(e) ? `${e.charAt(0).toLowerCase()}${e.slice(1)}` : undefined;
    return { shape: "outside_refused", verdict: why ? `${placeWords(snap.place)} refused: ${why.replace(/\.$/, "")}.` : `${placeWords(snap.place)} said no${e ? `: ${e}` : ""}.` };
  }
  if (snap?.place.kind === "cache") return { shape: "server_failed", verdict: snap.caption };
  if (snap?.opaque) return { shape: "server_failed", verdict: `${snap.live ? "The server" : serviceWords(snap.place).replace(/^t/, "T")} said no${httpStatus ? `: ${statusWords(httpStatus)}` : ""}. ${snap.live ? inside : "Shrike can't see inside it."}` };
  if (snap?.place.kind === "service") return { shape: "server_failed", verdict: `${where(snap)} failed in ${snap.label}.` };
  if (snap?.kind === "error") return { shape: "page_failed", verdict: `Your page's code threw an error: ${snap.chip ?? "unknown"}` };
  if (snap) return { shape: "page_failed", verdict: `Your page's code failed in ${snap.label}.` };
  const empty = view.flags.find((f) => f.kind === "empty_result" && f.message.includes(" 0 rows")); // same pick as the correlator's headline
  if (empty && !(httpStatus && httpStatus >= 400)) return { shape: "came_back_empty", verdict: `${empty.message.split(". ")[0]}.` }; // #62: wins over every "worked" shape
  const direct = caller.browser && st.find((s) => s.place.kind === "data" && !s.opaque);
  if (!reachedServer && caller.browser && !direct) {
    if (!httpStatus) return live ? { shape: "worked", verdict: `The server rendered this page. ${inside}` } : { shape: "never_left_page", verdict: "Your page never called the server." };
    const who = blind ? serviceWords(blind) : "the server";
    if (httpStatus >= 400) return { shape: "server_failed", verdict: `${who.replace(/^t/, "T")} said no: ${statusWords(httpStatus)}. ${inside}` };
    if (redirect) return { shape: "worked", verdict: `The server sent your page to ${redirect}. ${live ? inside : "Shrike can't see inside that server."}` };
    if (live) return { shape: "worked", verdict: `Your page called the server. ${inside}` };
    return { shape: "worked", verdict: blind ? `Your page called ${who}, which Shrike can't see inside.` : "Your page called a server Shrike can't see inside." };
  }
  if (httpStatus && httpStatus >= 400) return { shape: "server_failed", verdict: `The server said no: ${statusWords(httpStatus)}.` };
  if (coil) return { shape: "repeated", verdict: `The same database question was asked ${coil.count} times.` };
  const reads = st.filter((s) => s.cache === "hit" || s.cache === "miss");
  if (reads.reduce((n, s) => n + (s.count ?? 1), 0) >= 2 && !reads.some((s) => s.cache === "hit"))
    return { shape: "cache_never_hit", verdict: "The cache never hit: every request went to the database." };
  if (view.status === "slow") {
    const total = Math.round(view.durationMs);
    if (hog?.st.place.kind === "outside") return { shape: "slow_outside", verdict: `${placeWords(hog.st.place)} took ${Math.round(hog.ms)}ms of the ${total}ms.` };
    const entry = hog && multi && hog.st.place.kind === "service" ? st.find((s) => s.lane === hog.st.lane && s.kind === "http_request") : undefined;
    if (entry && entry !== st.find((s) => s.kind === "http_request" && s.place.kind === "service"))
      return { shape: "slow", verdict: `${serviceWords(entry.place).replace(/^t/, "T")} took ${Math.round(entry.ms)}ms of the ${total}ms.` };
    const hogs = st.filter((s) => s.status === "slow").map((s) => s.label);
    const w = hogs.length > 2 ? `${hogs.slice(0, 2).join(", ")} and ${hogs.length - 2} more` : hogs.join(" and ") || "one step";
    return { shape: "slow", verdict: `Most of the ${total}ms was spent in ${w}.` };
  }
  return { shape: "worked", verdict: `Everything worked (${Math.round(view.durationMs)}ms).` };
}

/** Where the clue is: the last failing call at or before the snap (it got the bad value), else the call that sent a refused outside request (its arguments), else the snap, else the first failure. */
export function firstFailure(trip: Trip): number {
  const st = trip.stations;
  const snap = st.findIndex((s) => s.snap);
  for (let i = snap; i >= 0; i--) if (st[i]!.kind === "function" && st[i]!.status === "error") return i;
  if (snap > 0 && st[snap]!.kind === "external_call" && st[snap - 1]!.kind === "function") return snap - 1;
  return snap >= 0 ? snap : Math.max(0, st.findIndex((s) => s.status === "error"));
}


/** Where a trip ends: its last station on the main thread (a side branch of a fork is not the end). */
export function lastStation(trip: Trip): number {
  return Math.max(0, trip.stations.findLastIndex((s) => !s.fork || s.fork.main));
}

// ---------------------------------------------------------------- layout

const TIME_ROW = 44; // time view: a two-line label (31px) and air, the least a row gets
const BELOW_ROOM = 16; // time view: a label written under its station needs this much more before the next row

/** Vertical gap before a station. Even spacing, or by time spent (time view): never under a label's height, long spans compressed (√, capped). */
export function rowGap(ms: number, timeMode: boolean): number {
  if (!timeMode) return ROW;
  return Math.max(TIME_ROW, Math.min(260, 34 + Math.sqrt(Math.max(0, ms)) * 34));
}

/** The trip's own lanes, all full width: the default when no session lane layout is given (clips, tests). */
export function tripLanes(trip: Trip, width: number): LaneLayout {
  return laneColumns(lanesFor([trip]), touchedBy(trip), width);
}

const FOLD_ROW = 34; // a folded side branch's row
const CHIP_ROOM = 46; // a two-line chip under a label
const FORK_LIFT = 14; // a side branch leaves the thread this far above the fork row

/** Place a trip in a feed column. Lane x positions come from the lane layout. Pure; deterministic. */
export function layoutTrip(trip: Trip, width: number, timeMode = false, lanes: LaneLayout = tripLanes(trip, width)): TripGeometry {
  const callerX = lanes.callerX;
  const xOf = (s: Station) => (lanes.x[s.lane] ?? callerX) + s.sub * Math.min(30, (lanes.w[s.lane] ?? 0) * 0.22);
  const shotY = HEAD;
  const narrow = width < 700;

  // Rows. A fork's branches start on the same row; the thread carries on below the longest one.
  let y = HEAD;
  let broke = false;
  const stacked = new Set<Station>();
  const ys: number[] = [];
  // A label written under its station (TripView `below`: the thread arrives from the right) shows only a red chip; leave room for it.
  const below = (i: number) => {
    const s = trip.stations[i];
    const prev = trip.stations[i - 1];
    return !!s && !!prev && !s.fork && !prev.fork && xOf(prev) > xOf(s);
  };
  const chipBelow = (i: number) => (timeMode ? below(i) : below(i) && !!trip.stations[i]!.chip && !!trip.stations[i]!.chipError);
  const gap = (s: Station, i: number) => (i === 0 ? 46 : broke ? Math.max(62, rowGap(s.ms, timeMode)) : rowGap(s.ms, timeMode)); // rows after the snap keep room for two-line labels
  for (let i = 0; i < trip.stations.length; ) {
    const s = trip.stations[i]!;
    if (!s.fork) {
      y += gap(s, i) + (chipBelow(i - 1) ? (timeMode ? BELOW_ROOM : CHIP_ROOM) : 0);
      ys[i] = y;
      broke ||= !!s.snap;
      i++;
      continue;
    }
    let j = i;
    while (j < trip.stations.length && trip.stations[j]!.fork?.id === s.fork.id) j++;
    const y0 = y + gap(s, i) + FORK_LIFT;
    let bottom = y0;
    const at = new Map<number, number>();
    // Folded side branches (and crowded one-step branches) stack one under another beside the fork's first row; the main branch carries on below them.
    const run = trip.stations.slice(i, j);
    const folded = run.filter((x) => !x.fork!.main && (x.kind === "express" || (run.filter((o) => o.fork!.branch === x.fork!.branch).length === 1 && crowded(x, run))));
    for (const x of folded) stacked.add(x);
    // Each stacked row clears the one above: a label with a chip under it is taller than FOLD_ROW.
    const tall = (x: Station) => (x.kind === "express" || !x.chip || timeMode ? 30 : 54);
    const foldY: number[] = [];
    folded.forEach((x, fi) => foldY.push(fi ? foldY[fi - 1]! + Math.max(FOLD_ROW, (tall(folded[fi - 1]!) + tall(x)) / 2 + 4) : y0 + 20 + FOLD_ROW));
    const foldEnd = foldY.at(-1) ?? y0 + 20;
    for (let k = i; k < j; k++) {
      const b = trip.stations[k]!.fork!.branch;
      const side = !trip.stations[k]!.fork!.main;
      const fi = folded.indexOf(trip.stations[k]!);
      if (fi >= 0) {
        ys[k] = foldY[fi]!; // clear of the first row's two-line label
        bottom = Math.max(bottom, ys[k]!);
        continue;
      }
      if (!side && !at.has(b) && folded.length) {
        ys[k] = y0;
        at.set(b, foldEnd);
        continue;
      }
      // Side rows sit midway between main rows (two-line labels are ~30px tall), clear of their labels; too narrow for two labels on one row, the side branch starts half a row down.
      const g = rowGap(trip.stations[k]!.ms, timeMode) * (narrow ? 1.5 : 1);
      const yb = at.has(b) ? at.get(b)! + g * (side && at.get(b) === y0 ? 0.5 : 1) : side && narrow ? y0 + g / 2 : y0;
      at.set(b, yb);
      ys[k] = yb;
      bottom = Math.max(bottom, yb);
    }
    for (let k = i; k < j; k++) broke ||= !!trip.stations[k]!.snap && !!trip.stations[k]!.fork?.main;
    y = bottom;
    i = j;
  }

  const placed: PlacedStation[] = trip.stations.map((s, i) => ({ ...s, x: Math.min(width - 12, xOf(s) + (stacked.has(s) ? 40 : 0)), y: ys[i]!, reach: Infinity, left: false, room: 0 })); // a station stepped right stays whole inside the stage
  // A side branch running in the same lane as another steps right of it; the one it sits beside writes its label left.
  const writeLeft = new Set<PlacedStation>();
  // Stacked branches in the main branch's lane drop past its first row: that label goes left, clear of their lines.
  placed.forEach((p, i) => {
    if (!stacked.has(trip.stations[i]!)) return;
    const head = placed.find((q) => q.fork?.id === p.fork!.id && q.fork.main);
    if (head && head.lane === p.lane) writeLeft.add(head);
  });
  for (const p of placed) {
    if (!p.fork || p.fork.main) continue;
    let q: PlacedStation | undefined;
    while ((q = placed.find((o) => o !== p && Math.abs(o.y - p.y) < 4 && Math.abs(o.x - p.x) < 24))) {
      p.x += 40;
      writeLeft.add(q);
    }
  }

  // Main thread: V into the row, H into the lane; a cache hit or fill pokes in and comes straight back (T15/T16).
  const pts: [number, number][] = [[callerX, shotY]];
  let len = 0;
  const go = (x: number, yy: number) => {
    const [px, py] = pts[pts.length - 1]!;
    if (px === x && py === yy) return;
    len += Math.abs(x - px) + Math.abs(yy - py);
    pts.push([x, yy]);
  };
  const forks: ForkPath[] = [];
  const prevX = new Map<PlacedStation, number>();
  const backX = (p: PlacedStation, i: number) => {
    if (!p.back) return undefined;
    for (let k = i - 1; k >= 0; k--) if (placed[k]!.lane === p.back && (!placed[k]!.fork || placed[k]!.fork!.main || placed[k]!.fork!.id === p.fork?.id)) return placed[k]!.x;
    return lanes.x[p.back];
  };
  let cut = false;
  for (let i = 0; i < placed.length && !cut; i++) {
    const p = placed[i]!;
    if (p.fork && !p.fork.main) continue;
    if (p.fork && placed.findIndex((q) => q.fork?.id === p.fork!.id) <= i && !forks.some((f) => f.id === p.fork!.id)) {
      // First main-branch station of a fork: side branches leave from just above this row.
      const [ax, ay] = pts[pts.length - 1]!;
      const fy = p.y - FORK_LIFT;
      const start = len + Math.max(0, fy - ay);
      let labelled = false;
      for (const b of [...new Set(placed.filter((q) => q.fork?.id === p.fork!.id && !q.fork.main).map((q) => q.fork!.branch))]) {
        const side = placed.filter((q) => q.fork?.id === p.fork!.id && q.fork.branch === b);
        const sp: [number, number][] = [[ax, fy]];
        let sl = 0;
        const sgo = (x: number, yy: number) => {
          const [px, py] = sp[sp.length - 1]!;
          if (px === x && py === yy) return;
          sl += Math.abs(x - px) + Math.abs(yy - py);
          sp.push([x, yy]);
        };
        side.forEach((q, k) => {
          const [bx] = sp[sp.length - 1]!;
          prevX.set(q, k === 0 ? ax : bx);
          if (k === 0) sgo(q.x, fy);
          sgo(sp[sp.length - 1]![0], q.y);
          sgo(q.x, q.y);
          q.reach = start + sl;
          if (q.cache === "hit" || q.cache === "set") sgo(backX(q, placed.indexOf(q)) ?? (k === 0 ? ax : bx), q.y);
        });
        const folded = side.length === 1 && stacked.has(trip.stations[placed.indexOf(side[0]!)]!); // a folded branch stops at its station: the long way back would run beside the whole trip
        forks.push({ id: p.fork.id, d: toD(sp), pts: sp, start, folded, label: labelled ? undefined : { x: Math.min(ax, p.x, side[0]!.x) + 10, y: fy - 12 } });
        labelled = true;
      }
    }
    const back = pts[pts.length - 1]![0];
    prevX.set(p, back);
    go(back, p.y);
    go(p.x, p.y);
    p.reach = len;
    if (p.cache === "hit" || p.cache === "set") go(backX(p, i) ?? back, p.y);
    if (p.snap) cut = true;
    // Rejoin: once the fork's last main station is drawn, side branches come back to the thread.
    const nextMain = placed.slice(i + 1).find((q) => !q.fork || q.fork.main);
    if (p.fork && !cut && nextMain?.fork?.id !== p.fork.id) {
      const [jx] = pts[pts.length - 1]!;
      const jy = Math.max(...placed.filter((q) => q.fork?.id === p.fork!.id).map((q) => q.y)) + 18;
      for (const f of forks.filter((f) => f.id === p.fork!.id && !f.folded)) {
        const [lx] = f.pts[f.pts.length - 1]!;
        f.pts.push([lx, jy], [jx, jy]);
        f.d = toD(f.pts);
      }
    }
  }

  const endY = y + rowGap(4, timeMode) + 10;
  const [ex, ey] = pts[pts.length - 1]!;
  const ret = placed.length ? `M ${ex} ${ey} V ${endY} H ${callerX}` : `M ${callerX} ${shotY} V ${endY}`;

  // Labels: the rightmost lanes write to the left; text stops short of the thread and of a station on the same row.
  for (const p of placed) {
    const row = placed.filter((q) => q !== p && Math.abs(q.y - p.y) < 4);
    p.left = p.x > width * 0.75 || writeLeft.has(p);
    if (p.left) {
      // A station just above or below (a fork's side row) also stops the text: two-line labels are ~30px tall.
      const near = placed.filter((q) => q !== p && Math.abs(q.y - p.y) < 30 && q.x < p.x).map((q) => q.x);
      const minX = Math.max(callerX, ...[prevX.get(p) ?? callerX, ...row.map((q) => q.x), ...near].filter((x) => x < p.x)) + 14;
      p.room = Math.max(near.length ? 100 : 160, p.x - 18 - minX);
    } else {
      const next = Math.min(width - 14, ...row.filter((q) => q.x > p.x).map((q) => q.x - 26));
      p.room = Math.max(row.some((q) => q.x > p.x) ? 90 : 160, next - p.x - 18);
    }
  }
  // A left label yields to a right label on a near row (a fork's side rows sit half a row apart): its text starts after theirs.
  // ponytail: text width is estimated from mono character counts; measure the DOM if labels ever use a proportional font.
  const textW = (q: PlacedStation) => Math.max(q.label.length * 7.6, subLine(q).length * 6.9, q.chip ? q.chip.length * 6.9 + 18 : 0); // the value chip is often the widest line
  for (const p of placed) {
    if (!p.left) continue;
    const near = placed.filter((q) => q !== p && !q.left && q.x < p.x && Math.abs(q.y - p.y) < (q.chip ? 46 : 40));
    if (!near.length) continue;
    const free = p.x - 18 - Math.max(...near.map((q) => q.x + 18 + Math.min(q.room, textW(q)) + 10));
    p.room = Math.max(64, Math.min(p.room, free));
    if (free < 64) for (const q of near) q.room = Math.max(40, Math.min(q.room, p.x - 18 - 64 - 10 - (q.x + 18))); // no room for both: the right label (and its chip) ends sooner, never under this one
  }
  return { height: endY + TAIL, shotY, endY, stations: placed, outPts: pts, out: toD(pts), ret, forks, callerX, lanes };
}

/** A station's second line: where it ran and how long it took (a live page load has no time of its own). */
export const subLine = (s: Pick<Station, "where" | "ms" | "live">) => [s.where, s.live && !s.ms ? "" : `${Math.round(s.ms)}ms`].filter(Boolean).join(" · ");

const toD = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ");

/** Tiny glyph path for the minimap (26×30 box). */
export function glyphPath(trip: Trip, lanes: readonly LaneDef[] = lanesFor([trip])): string {
  const n = Math.max(1, trip.stations.length);
  const idx = new Map(lanes.map((l, i) => [l.id, i]));
  const step = Math.min(7, 20 / Math.max(1, lanes.length - 1));
  let y = 2;
  let d = "M 3 2";
  for (const s of trip.stations) {
    y += 24 / n;
    d += ` V ${y.toFixed(1)} H ${(3 + (idx.get(s.lane) ?? 0) * step).toFixed(1)}`;
    if (s.snap) break;
  }
  return d;
}
