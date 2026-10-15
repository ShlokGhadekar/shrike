// A stand-in for Supabase (PostgREST and the bit of auth the page uses), so nothing here needs a real project.
// STUB_EMPTY=1 answers reads like the planted policy (0 rows); otherwise like the fixed one. DIST also serves a build.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const CSP = (JSON.parse(readFileSync(join(here, "vercel.json"), "utf8")) as { headers: { headers: { key: string; value: string }[] }[] }).headers
  .flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy")!.value;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-expose-headers": "content-range" };
const USER = { id: "00000000-0000-4000-8000-00000000ada0", aud: "authenticated", role: "authenticated", is_anonymous: true, created_at: "2026-10-15T00:00:00Z" };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const session = () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  return { access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", aud: "authenticated", exp })}.stub`, refresh_token: "stub-refresh", token_type: "bearer", expires_in: 86400, expires_at: exp, user: USER };
};

export function stub(opts: { empty?: boolean; dist?: string } = {}) {
  const state = { empty: !!opts.empty };
  const orders = [
    { id: 1, item: "Blue mug", qty: 2, customer: "Ada Example", created_at: "2026-10-15T09:00:00Z" },
    { id: 2, item: "Tea towel", qty: 1, customer: "Grace Example", created_at: "2026-10-15T09:05:00Z" },
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
      void res.writeHead(status, { ...CORS, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }).end(body === undefined ? undefined : JSON.stringify(body));
    if (req.method === "OPTIONS") return send(204);
    if (req.method === "POST" && (url.pathname === "/auth/v1/signup" || url.pathname === "/auth/v1/token")) return send(200, session());
    if (url.pathname === "/auth/v1/user") return send(200, USER);
    if (url.pathname === "/rest/v1/orders" && req.method === "GET") {
      const rows = state.empty ? [] : orders;
      return send(200, rows, { "content-range": rows.length ? `0-${rows.length - 1}/*` : "*/0" });
    }
    if (url.pathname === "/rest/v1/orders" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c; if (raw.length > 10_000) req.destroy(); });
      req.on("end", () => {
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return send(400, { code: "PGRST102", message: "Empty or invalid json" }); }
        const rows = [body].flat().filter((r): r is { item?: unknown; qty?: unknown } => !!r && typeof r === "object");
        const readBack = /return=representation/.test(String(req.headers.prefer));
        // .insert().select() reads the new row back through the select policy: the loud bug, not the planted one.
        if (state.empty && readBack) return send(403, { code: "42501", message: 'new row violates row-level security policy for table "orders"' });
        const added = rows.map((r, i) => ({ id: orders.length + i + 1, item: String(r.item ?? "").slice(0, 80), qty: Number(r.qty) || 1, customer: "You", created_at: new Date().toISOString() }));
        orders.push(...added);
        send(201, readBack ? added : undefined);
      });
      return;
    }
    if (opts.dist && req.method === "GET") {
      const dist = resolve(opts.dist);
      const file = extname(url.pathname) ? normalize(join(dist, url.pathname)) : join(dist, "index.html");
      if (!file.startsWith(dist + sep)) return send(404);
      let body: Buffer;
      try { body = readFileSync(file); } catch { return send(404); }
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      return void res.writeHead(200, { "content-type": type, ...(type === "text/html" && { "content-security-policy": CSP }) }).end(body);
    }
    send(404, { message: "Not found" });
  });
  return { server, state };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SERVER_PORT ?? 54321);
  const empty = process.env.STUB_EMPTY === "1";
  stub({ empty, dist: process.env.DIST }).server.listen(port, () => console.log(`Supabase stub on http://localhost:${port} (${empty ? "0 rows, like the planted policy" : "with rows, like the fixed policy"})`));
}
