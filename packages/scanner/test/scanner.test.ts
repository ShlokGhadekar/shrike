import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectProject, scanRoutes, type Java } from "../src/index.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "shrike-scan-"));
  dirs.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

test("express routes, quotes, routers, skipped dirs, sorted and deduped", async () => {
  const root = project({
    "package.json": JSON.stringify({ name: "shop", dependencies: { express: "5", react: "18" }, devDependencies: { vite: "6" } }),
    "pnpm-lock.yaml": "",
    "server/index.ts": [
      'import express from "express";',
      "const app = express();",
      'app.get("/api/todos", listTodos);',
      "app.post('/api/todos', createTodo);",
      "app.delete(`/api/todos/:id`, removeTodo);",
      'app.get(`/api/${name}`, nope);',
      'app.get("port");',
      "app.patch(",
      '  "/api/todos/:id",',
      "  toggle,",
      ");",
    ].join("\n"),
    "server/plain.ts": 'const routes = { "GET /api/carts": a, \'DELETE /api/carts/:id\' : b, "GET not-a-route": c };\nif (req.method === "PUT" && url === "/api/carts") x();\n',
    "server/users.js": 'const usersRouter = Router();\nusersRouter.put("/api/users/:id", h);\nrouter.get("/api/todos", dup);\n',
    "node_modules/x/index.js": 'app.get("/hidden", h);',
    "dist/server.js": 'app.get("/hidden2", h);',
    "build/server.js": 'app.get("/hidden3", h);',
    ".git/x.js": 'app.get("/hidden4", h);',
    "server/types.d.ts": 'app.get("/hidden5", h);',
    "README.md": 'app.get("/hidden6", h);',
  });
  const routes = await scanRoutes(root);
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path} ${r.handler?.file}:${r.handler?.line}`),
    [
      "GET /api/carts server/plain.ts:1",
      "PUT /api/carts server/plain.ts:2",
      "DELETE /api/carts/:id server/plain.ts:1",
      "GET /api/todos server/index.ts:3",
      "POST /api/todos server/index.ts:4",
      "DELETE /api/todos/:id server/index.ts:5",
      "PATCH /api/todos/:id server/index.ts:8",
      "PUT /api/users/:id server/users.js:2",
    ],
  );
  assert.equal(routes[0]!.handler!.precision, "exact");

  const info = await detectProject(root);
  assert.equal(info.root, resolve(root));
  assert.equal(info.name, "shop");
  assert.equal(info.frontend, "vite-react");
  assert.equal(info.backend, "express");
  assert.equal(info.devCommand, ""); // no dev script: nothing made up
  assert.match(info.notes?.[0] ?? "", /didn't find a dev script/);
  assert.equal(info.appUrl, "http://localhost:5173");
  assert.equal(info.routes.length, 8);
});

test("config overrides, lockfiles, missing or broken files", async () => {
  const a = project({
    "package.json": JSON.stringify({ name: "a", dependencies: { fastify: "4" } }),
    "yarn.lock": "",
    ".shrike/config.json": JSON.stringify({ devCommand: "make dev", appUrl: "http://localhost:8080" }),
  });
  assert.deepEqual(await detectProject(a), {
    root: a,
    name: "a",
    backend: "fastify",
    devCommand: "make dev",
    appUrl: "http://localhost:8080",
    routes: [],
    processes: [{ name: "app", command: "make dev" }],
    expectedPlaces: [{ id: "client:http://localhost:8080", kind: "client", name: "WEB · a", detail: "localhost:8080" }, { id: "service:app", kind: "service", name: "APP" }],
  });
  const b = project({ "package.json": "{ not json", ".shrike/config.json": "[]" });
  const info = await detectProject(b);
  assert.equal(info.devCommand, "");
  assert.equal(info.frontend, undefined);
  assert.equal(info.appUrl, undefined);
  assert.ok(info.name.startsWith("shrike-scan-"));
  const c = project({ "package.json": JSON.stringify({ dependencies: { hono: "4", react: "19" } }) });
  const ci = await detectProject(c);
  assert.equal(ci.backend, "hono");
  assert.equal(ci.frontend, "react");
  // #54: a live site's scratch project: no dev script note, only http(s) URLs kept.
  const live = await detectProject(project({ ".shrike/config.json": JSON.stringify({ liveUrl: "https://your-app.com", origins: ["https://api.your-app.com", "file:///etc", 3] }) }));
  assert.equal(live.liveUrl, "https://your-app.com");
  assert.deepEqual(live.origins, ["https://api.your-app.com"]);
  assert.equal(live.notes, undefined);
  assert.equal((await detectProject(project({ ".shrike/config.json": JSON.stringify({ liveUrl: "javascript:alert(1)" }) }))).liveUrl, undefined);
  await assert.doesNotReject(scanRoutes(join(a, "does-not-exist")));
});

test("#52: redact rules from .shrike/config.json, and a broken block is ignored with a note", async () => {
  const redact = { keys: ["address"], headers: ["x-tenant"], keep: ["status", "plan"] };
  assert.deepEqual((await detectProject(project({ ".shrike/config.json": JSON.stringify({ liveUrl: "https://your-app.com", redact }) }))).redact, redact);
  for (const bad of [["address"], { keys: "address" }, { keys: [3] }, { keep: ["status"], hide: ["x"] }]) {
    const p = await detectProject(project({ ".shrike/config.json": JSON.stringify({ liveUrl: "https://your-app.com", redact: bad }) }));
    assert.equal(p.redact, undefined, JSON.stringify(bad));
    assert.match(p.notes?.join(" ") ?? "", /Shrike ignored "redact"/);
  }
});

test("next app router and pages/api", async () => {
  const root = project({
    "package.json": JSON.stringify({ name: "nx", dependencies: { next: "15", react: "19" } }),
    "src/app/api/todos/route.ts": "export async function GET() {}\n\nexport async function POST(req: Request) {}\n",
    "src/app/(shop)/api/items/[id]/route.ts": "const h = () => {};\nexport const PATCH = h;\nexport { h as DELETE, h as helper };\n",
    "src/app/api/files/[...path]/route.js": "export function GET() {}\n",
    "src/app/_lib/route.ts": "export function GET() {}\n",
    "src/app/page.tsx": "export default function Page() {}\n",
    "app/route.ts": "export function GET() {}\n",
    "pages/api/users/index.ts": "export default function handler(req, res) {\n  if (req.method === 'POST') {}\n  switch (req.method) { case \"DELETE\": break; }\n}\n",
    "pages/api/users/[id].js": "\nexport default (req, res) => {};\n",
    ".next/server/app/api/todos/route.js": "export function PUT() {}\n",
  });
  const routes = await scanRoutes(root);
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path} ${r.handler?.file}:${r.handler?.line}`),
    [
      "GET / app/route.ts:1",
      "GET /api/files/:path* src/app/api/files/[...path]/route.js:1",
      "DELETE /api/items/:id src/app/(shop)/api/items/[id]/route.ts:3",
      "PATCH /api/items/:id src/app/(shop)/api/items/[id]/route.ts:2",
      "GET /api/todos src/app/api/todos/route.ts:1",
      "POST /api/todos src/app/api/todos/route.ts:3",
      "DELETE /api/users pages/api/users/index.ts:1",
      "POST /api/users pages/api/users/index.ts:1",
      "GET /api/users/:id pages/api/users/[id].js:2",
    ],
  );
  const info = await detectProject(root);
  assert.equal(info.frontend, "next");
  assert.equal(info.backend, "next");
  assert.equal(info.appUrl, "http://localhost:3000");
});

test("fixtures/todo-app (if present)", async (t) => {
  const fixture = fileURLToPath(new URL("../../../fixtures/todo-app", import.meta.url));
  if (!existsSync(join(fixture, "server"))) return t.skip("fixture not built yet");
  const info = await detectProject(fixture);
  assert.equal(info.frontend, "vite-react");
  assert.equal(info.backend, "express");
  assert.equal(info.appUrl, "http://localhost:5173");
  assert.ok(info.routes.some((r) => r.method === "POST" && r.path === "/api/todos"), JSON.stringify(info.routes));
});

const ids = (info: { expectedPlaces: { id: string }[] }) => info.expectedPlaces.map((p) => p.id);

test("processes from .shrike/config.json, declared places, no web page", async () => {
  const root = project({
    "package.json": JSON.stringify({ name: "api", scripts: { "dev:x": "node x.js" }, dependencies: { stripe: "1" } }),
    ".shrike/config.json": JSON.stringify({
      processes: [{ name: "api", command: "node src/server.ts", url: "http://localhost:4300" }, { name: "bad name!", command: "x" }, { name: "api", command: "dup" }, { name: "w", command: "node w.js", cwd: "worker" }],
      places: { "localhost:4199": { kind: "outside", name: "Stripe (test double)" }, "x": { kind: "nope", name: "X" } },
    }),
  });
  const info = await detectProject(root);
  assert.deepEqual(info.processes, [{ name: "api", command: "node src/server.ts", url: "http://localhost:4300" }, { name: "w", command: "node w.js", cwd: "worker" }]);
  assert.equal(info.appUrl, undefined);
  assert.deepEqual(info.declaredPlaces, { "localhost:4199": { kind: "outside", name: "Stripe (test double)" } });
  assert.deepEqual(info.expectedPlaces, [
    { id: "service:api", kind: "service", name: "API", detail: "localhost:4300" },
    { id: "service:w", kind: "service", name: "W" },
    { id: "outside:api.stripe.com", kind: "outside", name: "STRIPE", detail: "api.stripe.com" },
    { id: "outside:localhost:4199", kind: "outside", name: "Stripe (test double)", detail: "localhost:4199" },
  ]);
});

test("dev:* scripts become processes; the page process is the client, a declared one is outside", async () => {
  const root = project({
    "package.json": JSON.stringify({
      name: "shop",
      scripts: { dev: "all", "dev:web": "vite --port 5180 --strictPort", "dev:api": "node --watch api.ts", "dev:pay": "PORT=4199 node pay.ts", build: "x" },
      dependencies: { react: "18", "@electric-sql/pglite": "0", "lru-cache": "11", ioredis: "5", openai: "4", "@anthropic-ai/sdk": "0" },
      devDependencies: { vite: "6" },
    }),
    "pnpm-lock.yaml": "",
    ".shrike/config.json": JSON.stringify({ places: { "localhost:4199": { kind: "outside", name: "Pay double" } } }),
    "api.ts": 'import { DatabaseSync } from "node:sqlite";\n',
  });
  const info = await detectProject(root);
  assert.deepEqual(info.processes, [
    { name: "web", command: "pnpm dev:web", url: "http://localhost:5180" },
    { name: "api", command: "pnpm dev:api" },
    { name: "pay", command: "pnpm dev:pay", url: "http://localhost:4199" },
  ]);
  assert.equal(info.appUrl, "http://localhost:5180");
  assert.deepEqual(ids(info), [
    "client:http://localhost:5180",
    "service:api",
    "outside:localhost:4199",
    "cache:redis",
    "cache:lru",
    "data:postgres",
    "data:sqlite",
    "outside:api.openai.com",
    "outside:api.anthropic.com",
  ]);
});

test("npm and pnpm workspaces with a dev script; their deps count", async () => {
  const npm = project({
    "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*", "./libs/core"] }),
    "apps/web/package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "15", react: "19" } }),
    "apps/api/package.json": JSON.stringify({ scripts: { dev: "node --watch index.js --port 4000" }, dependencies: { pg: "8", mongoose: "8" } }),
    "apps/docs/package.json": JSON.stringify({ scripts: { build: "x" } }),
    "apps/notapkg/readme.md": "",
    "libs/core/package.json": JSON.stringify({ scripts: { dev: "tsc -w" }, dependencies: { mysql2: "3" } }),
  });
  const a = await detectProject(npm);
  assert.deepEqual(a.processes, [
    { name: "api", command: "npm run dev", cwd: "apps/api", url: "http://localhost:4000" },
    { name: "web", command: "npm run dev", cwd: "apps/web" },
    { name: "core", command: "npm run dev", cwd: "libs/core" },
  ]);
  assert.equal(a.frontend, "next");
  assert.equal(a.appUrl, "http://localhost:3000");
  assert.deepEqual(ids(a), ["client:http://localhost:3000", "service:api", "service:web", "service:core", "data:postgres", "data:mysql", "data:mongodb"]);

  const pnpm = project({
    "package.json": JSON.stringify({ name: "mono2" }),
    "pnpm-lock.yaml": "",
    "pnpm-workspace.yaml": "packages:\n  - 'services/*'\n  # comment\n  - \"!services/skip\"\nonlyBuiltDependencies:\n  - esbuild\n",
    "services/auth/package.json": JSON.stringify({ scripts: { dev: "node auth.js" }, dependencies: { "better-sqlite3": "11" } }),
    "esbuild/package.json": JSON.stringify({ scripts: { dev: "x" } }),
  });
  const b = await detectProject(pnpm);
  assert.deepEqual(b.processes, [{ name: "auth", command: "pnpm dev", cwd: "services/auth" }]);
  assert.deepEqual(ids(b), ["service:auth", "data:sqlite"]);
});

test("Procfile, env URL schemes (values never kept), single-command fallback", async () => {
  const root = project({
    "package.json": JSON.stringify({ name: "p" }),
    Procfile: "web: node web.js -p 8000\nworker: node worker.js\n# not: this\n",
    ".env": "DATABASE_URL=postgres://user:hunter2@db:5432/app\nexport REDIS_URL='rediss://:pw@cache:6379'\nOTHER=mysql://x\n",
  });
  const info = await detectProject(root);
  assert.deepEqual(info.processes, [{ name: "web", command: "node web.js -p 8000", url: "http://localhost:8000" }, { name: "worker", command: "node worker.js" }]);
  assert.deepEqual(ids(info), ["service:web", "service:worker", "cache:redis", "data:postgres"]);
  assert.ok(!JSON.stringify(info).includes("hunter2") && !JSON.stringify(info).includes("db:5432"));

  const single = await detectProject(project({ "package.json": JSON.stringify({ name: "s", scripts: { dev: "node s.js" } }) }));
  assert.deepEqual(single.processes, [{ name: "app", command: "npm run dev" }]);
  assert.deepEqual(single.expectedPlaces, [{ id: "service:app", kind: "service", name: "APP" }]);
});

test("fixtures/shop-app and fixtures/api-only (if present)", async (t) => {
  const shop = fileURLToPath(new URL("../../../fixtures/shop-app", import.meta.url));
  const api = fileURLToPath(new URL("../../../fixtures/api-only", import.meta.url));
  if (!existsSync(join(shop, ".shrike/config.json")) || !existsSync(join(api, ".shrike/config.json"))) return t.skip("fixtures not built yet");
  const s = await detectProject(shop);
  assert.deepEqual(s.processes.map((p) => p.name), ["web", "api", "auth", "payments"]);
  assert.equal(s.appUrl, "http://localhost:5180");
  for (const id of ["client:http://localhost:5180", "service:api", "service:auth", "outside:localhost:4199", "cache:lru", "data:postgres", "data:sqlite"]) assert.ok(ids(s).includes(id), id);
  assert.ok(!ids(s).includes("service:payments"));
  const a = await detectProject(api);
  assert.equal(a.appUrl, undefined);
  assert.deepEqual(a.processes.map((p) => p.name), ["api"]);
  assert.deepEqual(ids(a), ["service:api", "data:sqlite"]);
  assert.deepEqual(a.routes.map((r) => `${r.method} ${r.path}`), ["GET /health", "GET /v1/users", "POST /v1/users"]);
  for (const r of ["GET /api/cart", "GET /api/orders", "POST /api/checkout", "POST /verify", "POST /v1/charges"]) assert.ok(s.routes.some((x) => `${x.method} ${x.path}` === r), r);
});

const java21: Java = { jdks: [{ home: "/jdk21", major: 21 }], current: 21 };
const procs = async (files: Record<string, string>, java = java21) => {
  const info = await detectProject(project(files), { java: async () => java });
  return { ...info, list: info.processes.map((p) => [p.name, p.command, p.cwd ?? ".", p.url ?? "-"].join(" | ")) };
};

test("real projects: package manager from the lockfile's kind, scripts that exist, ports from .env", async () => {
  const express = { name: "api", scripts: { dev: "cross-env NODE_ENV=development nodemon src/index.js" }, dependencies: { express: "4", mongoose: "5" } };
  // yarn 1 lockfile + a global Yarn 4 would refuse it, so npm runs the script; PORT from .env gives the API address (express-mongoose).
  const y1 = await procs({ "package.json": JSON.stringify(express), "yarn.lock": "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n", ".env": "PORT=13002\nMONGODB_URL=mongodb://127.0.0.1:17017/x\n" });
  assert.deepEqual(y1.list, ["app | npm run dev | . | http://localhost:13002"]);
  assert.deepEqual(ids(y1), ["service:app", "data:mongodb"]);
  assert.equal((await procs({ "package.json": JSON.stringify(express), "yarn.lock": "__metadata:\n  version: 8\n" })).devCommand, "yarn dev");
  assert.equal((await procs({ "package.json": JSON.stringify({ ...express, packageManager: "pnpm@10.1.0" }), "yarn.lock": "" })).devCommand, "pnpm dev");
  // Nest has no `dev`: start:dev, never a made-up `npm run dev`.
  const nest = await procs({ "package.json": JSON.stringify({ scripts: { start: "nest start", "start:dev": "nest start --watch" }, dependencies: { "@nestjs/core": "11", mysql2: "3" } }), "package-lock.json": "{}", ".env": "PORT=13004\nDB_HOST=127.0.0.1\n" });
  assert.deepEqual(nest.list, ["app | npm run start:dev | . | http://localhost:13004"]);
  assert.equal(nest.backend, "nest");
  // ...nor the port from code when .env has none.
  const code = await procs({ "package.json": JSON.stringify({ scripts: { dev: "tsx watch src/index.ts" }, dependencies: { hono: "4" } }), "src/index.ts": "serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3300) });", "test/x.ts": "app.listen(9999)" });
  assert.deepEqual(code.list, ["app | npm run dev | . | http://localhost:3300"]);
});

test("real projects: an app in a folder of its own, a sub-script `dev` runs itself, Remix", async () => {
  // express-sequelize-mysql: no root package.json, app in a folder, DB_CONNECTION_URL names MySQL.
  const seq = await procs({ "express-main-example/package.json": JSON.stringify({ scripts: { start: "node index.js" }, dependencies: { express: "4", sequelize: "6" } }), "express-main-example/.env": "DB_CONNECTION_URL=mysql://u:secret@127.0.0.1:13306/x\nPORT=13003\n" });
  assert.deepEqual(seq.list, ["express-main-example | npm run start | express-main-example | http://localhost:13003"]);
  assert.deepEqual(ids(seq), ["service:express-main-example", "data:mysql"]);
  assert.ok(!JSON.stringify(seq).includes("secret"));
  // remix-indie-stack: dev runs dev:serve as one step, so one process; Remix's page is on 3000.
  const remix = await procs({
    "package.json": JSON.stringify({ scripts: { dev: 'remix dev -c "npm run dev:serve"', "dev:serve": "remix-serve ./build/index.js" }, dependencies: { "@remix-run/react": "2", "@remix-run/node": "2", react: "18" }, devDependencies: { vite: "5" } }),
    "package-lock.json": "{}",
  });
  assert.deepEqual(remix.list, ["app | npm run dev | . | -"]);
  assert.equal(remix.frontend, "remix");
  assert.equal(remix.appUrl, "http://localhost:3000");
});

test("real projects: firebase.json emulators next to the app folder; Bun as the runtime runs under Node", async () => {
  // vite-react-firebase: root scripts only run tests; the app is example/; the emulator config the app connects to wins.
  const fb = await procs({
    "package.json": JSON.stringify({ name: "reactfire", scripts: { start: 'firebase emulators:exec "vitest --ui"', test: "vitest" }, devDependencies: { "firebase-tools": "^15.2.0", vitest: "3" } }),
    "firebase.json": JSON.stringify({ emulators: { auth: { port: 9099 }, firestore: { port: 8085 } } }),
    "test/fs.test.ts": "connectFirestoreEmulator(db, 'localhost', 8085);",
    "emulators/firebase.json": JSON.stringify({ emulators: { hub: { port: 14400 }, firestore: { host: "127.0.0.1", port: 18080 }, auth: { port: 19099 }, ui: { enabled: false } } }),
    "functions/package.json": JSON.stringify({ scripts: { shell: "firebase functions:shell", start: "npm run shell" } }),
    "example/package.json": JSON.stringify({ scripts: { start: "vite" }, dependencies: { firebase: "9", react: "17" }, devDependencies: { vite: "8" } }),
    "example/app.tsx": "const firebaseConfig = { projectId: 'demo-shrike' };\nconnectFirestoreEmulator(db, '127.0.0.1', 18080);",
  });
  assert.deepEqual(fb.list, [
    "example | npm run start | example | http://localhost:5173",
    "firebase | npx -y firebase-tools@15 emulators:start --project demo-shrike --only firestore,auth | emulators | http://127.0.0.1:18080",
  ]);
  assert.deepEqual(ids(fb), ["client:http://localhost:5173", "data:firestore"]);
  // Only JDK 11 (default) and Homebrew's 17: firebase-tools 15 refuses Java < 21, so 13 runs on the newest one, and Setup says why.
  const files = { "package.json": JSON.stringify({ name: "x", devDependencies: { "firebase-tools": "^15.2.0" } }), "firebase.json": JSON.stringify({ emulators: { firestore: { port: 18080 } } }) };
  const old = await procs(files, { jdks: [{ home: "/jdk11", major: 11 }, { home: "/brew/jdk17", major: 17 }], current: 11 });
  assert.equal(old.processes[0]!.command, 'JAVA_HOME="/brew/jdk17" PATH="/brew/jdk17/bin:$PATH" npx -y firebase-tools@13 emulators:start --project demo-x --only firestore');
  assert.match(old.notes?.join(" ") ?? "", /need Java 21, and the newest Java here is 17/);
  // JDK 21 installed but not the default: use it.
  const off = await procs(files, { jdks: [{ home: "/jdk11", major: 11 }, { home: "/jdk21", major: 21 }], current: 11 });
  assert.match(off.processes[0]!.command, /^JAVA_HOME="\/jdk21" PATH="\/jdk21\/bin:\$PATH" npx -y firebase-tools@15 /);
  // No Java at all: plain words instead of a command that dies at once.
  const none = await procs(files, { jdks: [] });
  assert.match(none.notes?.join(" ") ?? "", /need Java 21 or newer\. Shrike didn't find Java/);
  // nextjs-supabase: the database is reached through supabase-js, so its lane is expected from the dependency.
  const sb = await procs({ "package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "16", "@supabase/ssr": "latest", "@supabase/supabase-js": "latest" } }) });
  assert.ok(ids(sb).includes("data:supabase"), ids(sb).join(", "));
  // express-redis: `bun run --watch .` would run outside Node; Setup says so.
  const bun = await procs({
    "package.json": JSON.stringify({ main: "server/index.js", type: "module", scripts: { dev: "bun run --watch ." }, dependencies: { express: "5", redis: "5" }, devDependencies: { tsx: "4" } }),
    "bun.lock": "",
    "server/index.ts": "app.listen(process.env.PORT || 8080)",
    ".env": "REDIS_URL=redis://localhost:16379\nPORT=13008\n",
  });
  assert.deepEqual(bun.list, ["app | node --import tsx --watch server/index.ts | . | http://localhost:13008"]);
  assert.match(bun.notes?.[0] ?? "", /runs on Bun.*with Node instead/);
  assert.equal((await procs({ "package.json": JSON.stringify({ scripts: { dev: "bun run --watch src/main.ts" } }), "src/main.ts": "" })).devCommand, "npx -y tsx watch src/main.ts");
});

test("real projects: turbo monorepo runs each app directly on the ports the env files expect; FastAPI next to a bun workspace", async () => {
  // hono-drizzle-pg: turbo's strict env mode would drop NODE_OPTIONS and PORT, so each workspace's own dev script runs.
  const hono = await procs({
    "package.json": JSON.stringify({ scripts: { dev: "turbo run dev", "dev:web": "turbo run dev -F web --", "dev:server": "turbo run dev -F server --" }, workspaces: ["apps/*", "packages/*"], packageManager: "pnpm@10.3.0" }),
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { dev: "vite dev" }, dependencies: { react: "19" }, devDependencies: { vite: "8" } }),
    "apps/web/vite.config.ts": "export default defineConfig({ server: { port: Number(process.env.WEB_PORT ?? 3001), strictPort: true } });",
    "apps/web/.env": "VITE_SERVER_URL=http://localhost:13006\n",
    "apps/server/package.json": JSON.stringify({ name: "server", scripts: { dev: "tsx watch src/index.ts" }, dependencies: { hono: "4", pg: "8" } }),
    "apps/server/src/index.ts": "serve({ port: Number(process.env.PORT ?? 3000) });",
    "apps/server/.env": "CORS_ORIGIN=http://localhost:13007\nDATABASE_URL=postgresql://p:p@localhost:15433/postgres\n",
    "packages/db/package.json": JSON.stringify({ name: "@x/db", scripts: { "db:push": "drizzle-kit push" } }),
  });
  assert.deepEqual(hono.list, ["web | WEB_PORT=13007 pnpm dev | apps/web | http://localhost:13007", "server | pnpm dev | apps/server | http://localhost:13006"]);
  assert.equal(hono.appUrl, "http://localhost:13007");
  assert.deepEqual(ids(hono), ["client:http://localhost:13007", "service:server", "data:postgres"]);
  // fastapi-sqlalchemy-pg: the root dev filters to the frontend (not the email previewer); uvicorn via the venv; bun.lock.
  const fa = await procs({
    "package.json": JSON.stringify({ scripts: { dev: "bun run --filter frontend dev", "email:dev": "bun run --filter emails dev" }, workspaces: ["frontend", "packages/*"] }),
    "bun.lock": "",
    ".env": "FRONTEND_HOST=http://localhost:15174\nDATABASE_URL=postgresql+psycopg://u:p@localhost:15434/app\n",
    "frontend/package.json": JSON.stringify({ name: "frontend", scripts: { dev: "vite" }, dependencies: { react: "19" }, devDependencies: { vite: "8" } }),
    "frontend/.env": "VITE_API_URL=http://localhost:18000\n",
    "packages/emails/package.json": JSON.stringify({ name: "emails", scripts: { dev: "email dev --port 3333" } }),
    "backend/pyproject.toml": '[project]\ndependencies = ["fastapi[standard]>=0.141", "sqlmodel"]\n',
    "backend/app/main.py": "from fastapi import FastAPI\n\napp = FastAPI(title='x')\n",
    "backend/tests/test_x.py": "app = FastAPI()\n",
    ".venv/bin/python": "",
    ".venv/bin/fastapi": "",
  });
  assert.deepEqual(fa.list, ["frontend | bun run dev --port 15174 | frontend | http://localhost:15174", "api | ../.venv/bin/fastapi dev app/main.py --port 18000 | backend | http://localhost:18000"]);
  assert.equal(fa.backend, "fastapi");
  assert.equal(fa.appUrl, "http://localhost:15174");
  assert.deepEqual(ids(fa), ["client:http://localhost:15174", "service:api", "data:postgres"]);
});

test("Python backends with no page: FastAPI and Flask commands, ports, routes and sqlite3 from the code (fixtures/py-api-only, fixtures/flask-api-only)", async () => {
  const fixture = (name: string, files: string[]) => Object.fromEntries(files.map((f) => [f, readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}/${f}`, import.meta.url)), "utf8")]));
  const venv = { ".venv/bin/python": "", ".venv/bin/uvicorn": "", "venv/lib/site-packages/flask/app.py": '@app.route("/never")\n' };
  const fa = await procs({ ...fixture("py-api-only", ["main.py", "reorder.py", "requirements.txt"]), ...venv });
  assert.deepEqual(fa.list, ["api | .venv/bin/uvicorn main:app --reload --port 8000 | . | http://localhost:8000"]);
  assert.equal(fa.backend, "fastapi");
  assert.equal(fa.appUrl, undefined);
  assert.deepEqual(ids(fa), ["service:api", "data:sqlite"]);
  assert.deepEqual(fa.routes.map((r) => `${r.method} ${r.path} ${r.handler?.file}:${r.handler?.line}`), ["GET /health main.py:69", "POST /orders main.py:79", "GET /orders/:order_id main.py:86", "GET /products main.py:74"]);
  const fl = await procs({ ...fixture("flask-api-only", ["app.py", "channel_sync.py", "requirements.txt"]), ...venv });
  assert.deepEqual(fl.list, ["api | .venv/bin/python app.py | . | http://localhost:4411"]);
  assert.equal(fl.backend, "flask");
  assert.deepEqual(ids(fl), ["service:api", "data:sqlite"]);
  assert.deepEqual(fl.routes.map((r) => `${r.method} ${r.path}`), ["GET /api/bookings", "POST /api/bookings", "GET /api/rooms/:room/free", "GET /health"]);
  const factory = await procs({ "requirements.txt": "Flask==3.0\n", "web/server.py": 'app = Flask(__name__)\n\n@app.route("/items/<int:item_id>", methods=["GET", "DELETE"])\ndef item(item_id): ...\n' });
  assert.deepEqual(factory.list, ["api | flask --app web.server run --port 5000 | . | http://localhost:5000"]);
  assert.deepEqual(factory.routes.map((r) => `${r.method} ${r.path}`), ["DELETE /items/:item_id", "GET /items/:item_id"]);
});

test("React + Python: the Vite proxy target is the API's port; sqlite3 in the Python code is an expected place", async () => {
  const vite = { scripts: { dev: "vite" }, dependencies: { react: "19" }, devDependencies: { vite: "6" } };
  const fa = await procs({
    "web/package.json": JSON.stringify({ name: "web", ...vite }),
    "web/vite.config.ts": 'export default defineConfig({ server: { port: 4510, proxy: { "/api": "http://localhost:4511" } } });',
    "api/requirements.txt": "fastapi\nuvicorn\n",
    "api/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    "api/db.py": "import sqlite3\n",
  });
  assert.deepEqual(fa.list, ["web | npm run dev | web | http://localhost:4510", "api | uvicorn main:app --reload --port 4511 | api | http://localhost:4511"]);
  assert.deepEqual(ids(fa), ["client:http://localhost:4510", "service:api", "data:sqlite"]);
  const dj = await procs({
    "package.json": JSON.stringify({ name: "site", ...vite }),
    "vite.config.ts": 'export default defineConfig({ server: { port: 4520, proxy: { "/api": { target: "http://127.0.0.1:4521", changeOrigin: true } } } });',
    "backend/requirements.txt": "django>=5\n",
    "backend/manage.py": "",
    "backend/config/settings.py": 'DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3"}}\n',
  });
  assert.deepEqual(dj.list, ["app | npm run dev | . | http://localhost:4520", "api | python manage.py runserver 4521 | backend | http://localhost:4521"]);
  assert.ok(ids(dj).includes("data:sqlite"));
});
