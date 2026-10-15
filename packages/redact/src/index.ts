import type { Cell, DebugEvent } from "@shrike/schema";

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key"]);
// "auth" and "authorization", but not "author"/"authorId"
const KEY = String.raw`pass(?:word)?|passwd|secret|token|api[-_]?key|auth(?!or(?!i[zs]))|session|credential|private[-_]?key|card|cvv|(?<!cla)ssn`; // not "className"
const KEY_RE = new RegExp(KEY, "i");
const NUMERIC_KEY_RE = /card|cvv|ssn/i;
// bounded so long identifier runs stay linear
const IDENT = String.raw`[\w$.-]{0,40}(?:${KEY})[\w$.-]{0,40}`;

const label = (name: string) => `[redacted:${name}]`;
const isRedacted = (v: string) => v.startsWith("[redacted");

const SHAPES: [RegExp, string][] = [
  [/-----BEGIN ([A-Z0-9 ]{1,40})-----[\s\S]{0,10000}?-----END \1-----/g, "pem"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "aws_key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic_key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "openai_key"],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, "stripe_key"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, "github_token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "slack_token"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "google_key"],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, "jwt"],
];

const QUOTED = ["\"", "'", "`"].map(
  (q) => new RegExp(String.raw`(?<![\w$.-])([${q === "`" ? "'\"" : q}]?)(${IDENT})\1(\s*[:=]\s*)${q}((?:[^${q}\\\n]|\\.)*)${q}`, "gi"),
);
const UNQUOTED = new RegExp(String.raw`(?<![\w$.-])(["']?)(${IDENT})\1(\s*[:=]\s*)(?!["'\x60\[{(]|(?:Bearer|Basic)\s)([A-Za-z0-9_\-+/.~%]+)`, "gi");
const LITERAL = /^(?:true|false|null|undefined|NaN|-?\d+(?:\.\d+)?)$/;

export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ponytail: digit + mixed case + entropy keeps words, paths, SQL and hex ids out; a lowercase-only or
// digit-free secret slips through. Upgrade: per-charset thresholds like detect-secrets.
const looksSecret = (v: string): boolean =>
  v.length >= 24 && !v.startsWith("/") && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v) && entropy(v) > 4;

// A quoted string value that is one long letters-and-digits run (a hex or base64url session id) is a
// token handed around as an argument or return value. Unquoted hex (trace ids, commits) stays visible.
// ponytail: UUIDs stay visible because they are usually record ids; a UUID session id slips through.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const looksToken = (v: string): boolean => /^[A-Za-z0-9_-]{32,512}$/.test(v) && /\d/.test(v) && /[a-z]/i.test(v) && !UUID.test(v) && entropy(v) > 3;

export function redactText(s: string): string {
  if (!s) return s;
  let out = s;
  // connection strings: keep the user, mask the password
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^:/\s@'"]+):([^@\s'"/]+)@/gi, (m, scheme: string, user: string, pass: string) =>
    isRedacted(pass) ? m : `${scheme}${user}:${label("password")}@`,
  );
  out = out.replace(/\b(Bearer|Basic)\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{8,}/g, (_m, kind: string) => `${kind} ${label("token")}`);
  for (const re of QUOTED) {
    out = out.replace(re, (m, q: string, key: string, sep: string, value: string) => {
      if (!value || isRedacted(value)) return m;
      const quote = m.at(-1)!;
      return `${q}${key}${q}${sep}${quote}${label(key)}${quote}`;
    });
  }
  out = out.replace(UNQUOTED, (m, q: string, key: string, sep: string, value: string) => {
    if (LITERAL.test(value) && !(NUMERIC_KEY_RE.test(key) && /^\d{3,}$/.test(value))) return m;
    return `${q}${key}${q}${sep}${q === '"' ? `"${label(key)}"` : label(key)}`;
  });
  for (const [re, name] of SHAPES) out = out.replace(re, label(name));
  // high entropy: whole quoted values, and values after = or :
  out = out.replace(/(["'`])([A-Za-z0-9+/_=.-]{24,512})\1/g, (m, q: string, v: string) => (looksSecret(v) || looksToken(v) ? `${q}${label("secret")}${q}` : m));
  out = out.replace(/([=:]\s*)([A-Za-z0-9+/_=.-]{24,512})(?=$|[\s&;,)}\]])/g, (m, sep: string, v: string, at: number, all: string) =>
    looksSecret(v) && !v.startsWith("//") && !/\/\/[^\s/?#@]+$/.test(all.slice(Math.max(0, at - 260), at)) ? `${sep}${label("secret")}` : m, // a URL's scheme or port colon is not a key
  );
  return out;
}

const redactHeaders = (h: Record<string, string> | undefined) => {
  if (!h) return h;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const name = k.toLowerCase();
    out[k] = SENSITIVE_HEADERS.has(name) || KEY_RE.test(name) ? label(name) : redactText(v);
  }
  return out;
};

const opt = (s: string | undefined) => (s === undefined ? s : redactText(s));

/** I: a value from a database row or cache entry; a column or key that names a secret is masked whole. */
export function redactCell(name: string, v: Cell): Cell {
  if (v === null || typeof v !== "string") return v !== null && KEY_RE.test(name) ? label(name.toLowerCase()) : v;
  return KEY_RE.test(name) && !isRedacted(v) ? label(name.toLowerCase()) : redactText(v);
}

export function redactRow(row: Record<string, Cell>): Record<string, Cell> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, redactCell(k, v)]));
}

export function redactEvent(e: DebugEvent): DebugEvent {
  const r: DebugEvent = { ...e, name: redactText(e.name) };
  if (e.http) {
    r.http = { ...e.http, url: redactText(e.http.url) };
    if (e.http.reqHeaders) r.http.reqHeaders = redactHeaders(e.http.reqHeaders);
    if (e.http.resHeaders) r.http.resHeaders = redactHeaders(e.http.resHeaders);
    if (e.http.serverTiming) r.http.serverTiming = e.http.serverTiming.map((t) => (t.desc !== undefined ? { ...t, desc: redactText(t.desc) } : t));
    if (e.http.reqBody !== undefined) r.http.reqBody = redactText(e.http.reqBody);
    if (e.http.resBody !== undefined) r.http.resBody = redactText(e.http.resBody);
  }
  if (e.db) {
    r.db = { ...e.db, statement: redactText(e.db.statement) };
    if (e.db.params !== undefined) r.db.params = redactText(e.db.params);
  }
  if (e.log) r.log = { ...e.log, message: redactText(e.log.message) };
  if (e.error) {
    r.error = { ...e.error, message: redactText(e.error.message) };
    if (e.error.type !== undefined) r.error.type = redactText(e.error.type);
    if (e.error.stack !== undefined) r.error.stack = redactText(e.error.stack);
  }
  if (e.cache?.key !== undefined) r.cache = { ...e.cache, key: redactText(e.cache.key) };
  if (e.caller) r.caller = { ...e.caller, label: redactText(e.caller.label), ...(e.caller.command !== undefined ? { command: redactText(e.caller.command) } : {}) };
  if (e.change?.rows) r.change = { ...e.change, rows: e.change.rows.map((x) => ({ ...x, ...(x.before ? { before: redactRow(x.before) } : {}), ...(x.after ? { after: redactRow(x.after) } : {}) })) };
  if (e.args) r.args = e.args.map(redactText);
  if (e.returned !== undefined) r.returned = opt(e.returned);
  if (e.stack !== undefined) r.stack = opt(e.stack);
  return r;
}
