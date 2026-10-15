import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Place, PlaceKind, ProcessSpec, ProjectInfo, RedactRules, Route } from "@shrike/schema";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", ".next", ".turbo", ".vercel", "coverage", "out", "venv", "__pycache__", "site-packages"]);
const CODE_EXT = /\.(ts|tsx|js|mjs|py)$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = JSON.parse(await readFile(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

type Pkg = Record<string, unknown>;
type Pm = "npm" | "pnpm" | "yarn" | "bun";
type Env = Record<string, string>;
interface App {
  dir: string; // relative to the root, "" for the root
  pkg: Pkg;
  pm: Pm;
  env: Env;
}
interface Ctx {
  abs: string;
  facts: Facts;
  workspaces: App[];
  hints: { web?: string; api?: string };
  notes: string[];
  web: Set<string>; // names of processes that serve the page
  spa: Set<string>; // ...and only the page (vite), so the page's address is theirs
}

const scriptsOf = (p: Pkg): Record<string, string> =>
  Object.fromEntries(Object.entries(p.scripts && typeof p.scripts === "object" ? p.scripts : {}).flatMap(([k, v]) => (str(v) ? [[k, str(v)!]] : [])));
const depsOf = (p: Pkg): Record<string, unknown> => ({ ...(p.dependencies as object), ...(p.devDependencies as object) });
// A script (plus the one it calls) that runs tests or Firebase tooling doesn't start the app.
const NOT_APP = /\b(vitest|jest|mocha|playwright|cypress|firebase)\b/;
const REF = /\b(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)/;
function appScript(p: Pkg, names: string[]): string | undefined {
  const s = scriptsOf(p);
  return names.find((n) => s[n] && !NOT_APP.test(`${s[n]} ${s[REF.exec(s[n])?.[1] ?? ""] ?? ""}`));
}
const run = (pm: Pm, script: string, args = "") =>
  `${pm === "npm" ? "npm run" : pm === "bun" ? "bun run" : pm} ${script}${args ? (pm === "npm" ? ` -- ${args}` : ` ${args}`) : ""}`;
const WEB_SCRIPT = /\b(vite|next|remix|nuxt|astro|react-scripts|ng serve)\b/;
const WEB_DEPS = ["vite", "next", "@remix-run/dev", "nuxt", "astro", "@sveltejs/kit", "react-scripts", "@angular/cli"];
const SERVER_DEPS = ["express", "fastify", "hono", "koa", "@nestjs/core"];
const isWeb = (p: Pkg, body: string) => WEB_SCRIPT.test(body) || (WEB_DEPS.some((d) => d in depsOf(p)) && !SERVER_DEPS.some((d) => d in depsOf(p)));

export async function detectProject(root: string, opts: { java?: () => Promise<Java> } = {}): Promise<ProjectInfo> {
  const abs = resolve(root);
  const pkg = (await readJson(join(abs, "package.json"))) ?? {};
  const config = (await readJson(join(abs, ".shrike", "config.json"))) ?? {};
  const rootApp = await loadApp(abs, "", pkg);
  const workspaces = await Promise.all((await workspaceDirs(abs, pkg)).map((d) => loadApp(abs, d)));
  const rootScript = appScript(pkg, ["dev", "start:dev", "develop"]);
  const folders = rootScript || workspaces.length ? [] : await folderApps(abs);
  const apps = [rootApp, ...workspaces, ...folders];
  const deps: Record<string, unknown> = Object.assign({}, ...apps.map((a) => depsOf(a.pkg)));
  const has = (d: string) => d in deps;
  const facts = await scanCode(abs);
  const ctx: Ctx = { abs, facts, workspaces, hints: urlHints(apps.map((a) => a.env)), notes: [], web: new Set(), spa: new Set() };
  const name = str(pkg.name) ?? basename(abs);

  const scripts = scriptsOf(pkg);
  const devBody = scripts.dev ?? "";
  // dev:x is its own process unless `dev` runs it as one step (remix dev -c "npm run dev:serve").
  const parallel = /\b(concurrently|run-p|npm-run-all)\b|&/.test(devBody);
  const split = Object.keys(scripts).filter((k) => /^dev:[\w.-]+$/.test(k) && (parallel || !devBody.includes(k)) && !NOT_APP.test(scripts[k]!));
  const fallbackDev = str(config.devCommand);
  let processes =
    configProcesses(config.processes) ??
    (fallbackDev ? [{ name: "app", command: fallbackDev }] : undefined) ??
    nonEmpty(uniq((await Promise.all(split.map((k) => scriptProcs(ctx, rootApp, k, k.slice(4))))).flat())) ??
    (rootScript ? await scriptProcs(ctx, rootApp, rootScript, "app") : undefined) ??
    nonEmpty(uniq((await Promise.all(workspaces.filter((w) => scriptsOf(w.pkg).dev).map((w) => appProc(ctx, w, "dev", basename(w.dir))))).flat())) ??
    nonEmpty(await Promise.all(folders.map((f) => appProc(ctx, f, appScript(f.pkg, START)!, basename(f.dir))))) ??
    nonEmpty(await procfile(abs)) ??
    (appScript(pkg, ["start", "serve"]) ? [await appProc(ctx, rootApp, appScript(pkg, ["start", "serve"])!, "app")] : []);

  if (!configProcesses(config.processes) && !fallbackDev) {
    const dirs = ["", ...(await subdirs(abs))];
    const proxy = ctx.hints.api ? undefined : (await Promise.all(apps.map((a) => viteConfig(join(abs, a.dir))))).find((c) => c.proxy)?.proxy;
    const py = await pythonProc(abs, dirs, ctx.hints.api ?? proxy);
    if (py && !processes.some((p) => p.name === py.name)) processes.push(py);
    if (py) facts.usesSqlite ||= !!(await findPy(join(abs, py.cwd ?? ""), /\bsqlite3\b/)); // sqlite3 or Django's sqlite3 engine
    const fb = await firebaseProc(abs, dirs, facts, deps, name, opts.java ?? findJava, ctx.notes);
    if (fb && !processes.some((p) => p.name === fb.name)) processes.push(fb);
  }
  const devCommand = fallbackDev ?? processes[0]?.command ?? "";
  const liveUrl = webUrl(config.liveUrl);
  const origins = Array.isArray(config.origins) ? config.origins.map(webUrl).filter((o): o is string => !!o) : [];
  if (!processes.length) {
    processes = [{ name: "app", command: devCommand }];
    if (!liveUrl) ctx.notes.push("Shrike didn't find a dev script. Type the command you use to start your app.");
  }

  const frontend = has("@remix-run/react") ? "remix" : has("next") ? "next" : has("vite") && has("react") ? "vite-react" : has("react") ? "react" : has("vite") ? "vite" : undefined;
  const backend =
    has("express") ? "express" : has("fastify") ? "fastify" : has("hono") ? "hono" : has("@nestjs/core") ? "nest" : has("koa") ? "koa"
    : has("@remix-run/node") ? "remix" : has("next") ? "next" : processes.some((p) => /\b(fastapi|uvicorn)\b/.test(p.command)) ? "fastapi" : processes.some((p) => /manage\.py runserver/.test(p.command)) ? "django" : facts.py ?? undefined;
  const appUrl =
    str(config.appUrl) ??
    (frontend ? processes.find((p) => p.url && (ctx.web.has(p.name) || /^(web|app|client|frontend|site|ui)$/.test(p.name) || /\b(vite|next)\b/.test(`${p.command} ${scripts[`dev:${p.name}`] ?? ""}`)))?.url : undefined) ??
    (frontend === "vite-react" || frontend === "vite" ? "http://localhost:5173" : frontend === "next" || frontend === "remix" ? "http://localhost:3000" : undefined);
  const declaredPlaces = configPlaces(config.places);
  const redact = configRedact(config.redact);
  if (redact.warning) console.warn(redact.warning), ctx.notes.push(redact.warning);
  if (appUrl && ctx.spa.size === 1) processes = processes.map((p) => (!p.url && ctx.spa.has(p.name) ? { ...p, url: appUrl } : p));

  return {
    root: abs,
    name,
    ...(frontend ? { frontend } : {}),
    ...(backend ? { backend } : {}),
    devCommand,
    ...(appUrl ? { appUrl } : {}),
    routes: facts.routes,
    processes,
    expectedPlaces: expectPlaces({ name, appUrl, processes, deps, usesSqlite: facts.usesSqlite, env: envSchemes(apps.map((a) => a.env)), declaredPlaces }),
    ...(declaredPlaces ? { declaredPlaces } : {}),
    ...(ctx.notes.length ? { notes: ctx.notes } : {}),
    ...(liveUrl ? { liveUrl } : {}),
    ...(origins.length ? { origins } : {}),
    ...(redact.rules ? { redact: redact.rules } : {}),
  };
}

/** An http(s) URL from .shrike/config.json, or undefined. */
function webUrl(v: unknown): string | undefined {
  try {
    return typeof v === "string" && /^https?:$/.test(new URL(v).protocol) ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

const START = ["dev", "start:dev", "develop", "start"];
const uniq = (ps: ProcessSpec[]) => ps.filter((p, i) => ps.findIndex((q) => q.name === p.name) === i);

async function loadApp(abs: string, dir: string, pkg?: Pkg): Promise<App> {
  return { dir, pkg: pkg ?? (await readJson(join(abs, dir, "package.json"))) ?? {}, pm: await packageManager(abs, dir), env: await readEnv(join(abs, dir)) };
}

async function subdirs(abs: string): Promise<string[]> {
  try {
    return (await readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// A repo whose app sits in a folder of its own (example/, server/), with no workspaces.
async function folderApps(abs: string): Promise<App[]> {
  const out: App[] = [];
  for (const d of await subdirs(abs)) {
    const pkg = await readJson(join(abs, d, "package.json"));
    if (pkg && appScript(pkg, START)) out.push(await loadApp(abs, d, pkg));
  }
  return out;
}

/** The nearest lockfile or packageManager field decides. Yarn 1 lockfiles run through npm: a global Yarn 2+ refuses them. */
async function packageManager(abs: string, dir: string): Promise<Pm> {
  for (let d = join(abs, dir); ; d = dirname(d)) {
    const m = /^(npm|pnpm|yarn|bun)@(\d+)/.exec(str((await readJson(join(d, "package.json")))?.packageManager) ?? "");
    if (m) return m[1] === "yarn" && m[2] === "1" ? "npm" : (m[1] as Pm);
    if (existsSync(join(d, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(d, "bun.lock")) || existsSync(join(d, "bun.lockb"))) return "bun";
    if (existsSync(join(d, "yarn.lock"))) return (await readFile(join(d, "yarn.lock"), "utf8").catch(() => "")).includes("__metadata:") ? "yarn" : "npm";
    if (existsSync(join(d, "package-lock.json")) || d === abs || !d.startsWith(abs)) return "npm";
  }
}

/** A root script that hands off to workspaces (turbo, pnpm -r, --filter x): those workspaces' own dev scripts, run directly. */
async function scriptProcs(ctx: Ctx, a: App, script: string, name: string): Promise<ProcessSpec[]> {
  const body = scriptsOf(a.pkg)[script]!;
  const ws = ctx.workspaces.filter((w) => scriptsOf(w.pkg).dev);
  if (ws.length && /\b(npm|pnpm|yarn|bun|turbo|nx|lerna)\b/.test(body)) {
    const names = [...body.matchAll(/(?:--filter|--workspace|-F|-w)[= ]["']?([@\w./-]+)/g)].map((m) => m[1]!.replace(/^\.\//, ""));
    const hit = names.length ? ws.filter((w) => names.some((n) => n === str(w.pkg.name) || n === basename(w.dir) || n === w.dir)) : /\b(turbo|nx|lerna)\b|\s(-r|--recursive|--workspaces)\b/.test(body) ? ws : [];
    // ponytail: turbo's strict env mode drops NODE_OPTIONS and PORT, so its tasks are started without turbo.
    if (hit.length) return Promise.all(hit.map((w) => appProc(ctx, w, "dev", basename(w.dir))));
  }
  return [await appProc(ctx, a, script, name)];
}

async function appProc(ctx: Ctx, a: App, script: string, name: string): Promise<ProcessSpec> {
  const body = scriptsOf(a.pkg)[script] ?? "";
  const dir = join(ctx.abs, a.dir);
  let command = (await bunToNode(ctx, a, script, body)) ?? run(a.pm, script);
  const web = isWeb(a.pkg, body);
  if (web) ctx.web.add(name);
  if (web && /\bvite\b/.test(body) && !/\b(next|remix|nuxt|astro|node|tsx)\b/.test(body)) ctx.spa.add(name);
  let port = /(?:--port[= ]|\bPORT=|-p )(\d{2,5})\b/.exec(body)?.[1];
  if (!port && web && /\bvite\b/.test(body)) {
    const cfg = await viteConfig(dir);
    const own = (cfg.env && a.env[cfg.env]) || cfg.port;
    const want = ctx.hints.web;
    port = own;
    if (want && want !== own) {
      if (cfg.env) [port, command] = [want, `${cfg.env}=${want} ${command}`];
      else if (!cfg.port && /^vite\b/.test(body)) [port, command] = [want, run(a.pm, script, `--port ${want}`)];
    }
  } else if (!port) {
    port = a.env.PORT ?? (web ? ctx.hints.web : (ctx.hints.api ?? ctx.facts.ports.find((p) => p.file.startsWith(a.dir ? `${a.dir}/` : ""))?.port));
  }
  return { name, command, ...(a.dir ? { cwd: a.dir } : {}), ...(port ? { url: `http://localhost:${port}` } : {}) };
}

// `bun run --watch .`, `bun src/index.ts`: Bun as the runtime, which Shrike can't record. Same entry under Node.
async function bunToNode(ctx: Ctx, a: App, script: string, body: string): Promise<string | undefined> {
  const m = /^(?:\w+=\S*\s+)*bun\s+((?:(?:run|--?[\w-]+)\s+)*)(\S+)/.exec(body);
  if (!m || !(m[2] === "." || /\.[cm]?[jt]sx?$/.test(m[2]!))) return undefined;
  const dir = join(ctx.abs, a.dir);
  let entry = m[2] === "." ? (str(a.pkg.module) ?? str(a.pkg.main) ?? "index.ts") : m[2]!;
  entry = [entry, entry.replace(/\.[cm]?js$/, ".ts"), entry.replace(/\.[cm]?js$/, ".tsx"), `${entry}/index.ts`, `${entry}/index.js`].find((e) => existsSync(join(dir, e)) && statSync(join(dir, e)).isFile()) ?? entry;
  const watch = /--(watch|hot)\b/.test(m[1]!);
  const tsx = existsSync(join(dir, "node_modules/.bin/tsx")) || existsSync(join(ctx.abs, "node_modules/.bin/tsx")) || "tsx" in depsOf(a.pkg);
  const command = !/\.[cm]?tsx?$/.test(entry) ? `node${watch ? " --watch" : ""} ${entry}` : tsx ? `node --import tsx${watch ? " --watch" : ""} ${entry}` : `npx -y tsx${watch ? " watch" : ""} ${entry}`;
  ctx.notes.push(`Your "${script}" script runs on Bun. Shrike records Node apps, so it runs ${entry} with Node instead. Change the command below if that's wrong.`);
  return command;
}

async function viteConfig(dir: string): Promise<{ port?: string; env?: string; proxy?: string }> {
  for (const f of ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
    let text: string;
    try {
      text = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    // ponytail: the first `port:` in the file (server.port in practice); no config evaluation.
    const m = /\bport\s*:\s*(?:Number\(\s*|parseInt\(\s*|\+\s*)?(?:process\.env\.(\w+)\s*(?:\?\?|\|\|)\s*)?["']?(\d{2,5})?/.exec(text);
    // server.proxy's first local target ("/api": "http://localhost:8000" or { target: ... }): where the page expects the API.
    const proxy = /\bproxy\s*:\s*\{[^]*?["'`]https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/.exec(text)?.[1];
    return { ...(m?.[2] ? { port: m[2] } : {}), ...(m?.[1] ? { env: m[1] } : {}), ...(proxy ? { proxy } : {}) };
  }
  return {};
}

// Env files point at each other: the page's VITE_API_URL is the API's address, the API's CORS_ORIGIN the page's.
// ponytail: one page and one API; a project with several of either gets the hint on each.
const API_KEY = /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_)?(?:API|SERVER|BACKEND)_(?:BASE_)?(?:URL|HOST|ORIGIN)$/;
const WEB_KEY = /^(?:CORS_ORIGINS?|FRONTEND_(?:URL|HOST|ORIGIN)|CLIENT_(?:URL|ORIGIN)|WEB_(?:URL|ORIGIN))$/;
function urlHints(envs: Env[]): { web?: string; api?: string } {
  const out: { web?: string; api?: string } = {};
  for (const env of envs)
    for (const [k, v] of Object.entries(env)) {
      const port = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/.exec(v.split(",")[0]!.trim())?.[1];
      if (port && API_KEY.test(k)) out.api ??= port;
      if (port && WEB_KEY.test(k)) out.web ??= port;
    }
  return out;
}

const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

/** KEY=value pairs of the env files in `dir`, later files winning. ponytail: no multi-line values or ${VAR} expansion. */
export async function readEnv(dir: string, files = ENV_FILES): Promise<Env> {
  const out: Env = {};
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.]*)[ \t]*=[ \t]*(.*?)[ \t]*$/gm)) {
      const q = /^(["'`])(.*?)\1(?:[ \t]+#.*)?$/.exec(m[2]!);
      out[m[1]!] = q ? q[2]! : m[2]!.replace(/(^|[ \t]+)#.*$/, "");
    }
  }
  return out;
}

const PY_SKIP = new Set([".venv", "venv", "__pycache__", "node_modules", "tests", "test", "alembic", "migrations", "site-packages"]);

async function findPy(dir: string, re: RegExp, depth = 3): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isFile() && e.name.endsWith(".py") && re.test(await readFile(join(dir, e.name), "utf8").catch(() => ""))) return e.name;
  }
  for (const e of entries) {
    if (!e.isDirectory() || depth <= 0 || PY_SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const hit = await findPy(join(dir, e.name), re, depth - 1);
    if (hit) return `${e.name}/${hit}`;
  }
  return undefined;
}

// FastAPI, Flask or Django in the root or a top folder, run from its virtualenv (or uv / poetry).
async function pythonProc(abs: string, dirs: string[], hint?: string): Promise<ProcessSpec | undefined> {
  for (const d of dirs) {
    const dir = join(abs, d);
    const reqs = (await Promise.all(["pyproject.toml", "requirements.txt", "requirements/base.txt"].map((f) => readFile(join(dir, f), "utf8").catch(() => "")))).join("\n");
    const django = existsSync(join(dir, "manage.py")) && /\bdjango\b/i.test(reqs);
    const fastapi = /\bfastapi\b/i.test(reqs) ? await findPy(dir, /^\s*\w+\s*(?::\s*\w+\s*)?=\s*FastAPI\(/m) : undefined;
    const flask = !django && !fastapi && /\bflask\b/i.test(reqs) ? await findPy(dir, /^\s*\w+\s*=\s*Flask\(/m) : undefined;
    if (!django && !fastapi && !flask) continue;
    const venv = [join(dir, ".venv"), join(dir, "venv"), join(abs, ".venv")].find((v) => existsSync(join(v, "bin", "python")));
    const bin = (tool: string) =>
      venv && existsSync(join(venv, "bin", tool)) ? `${relative(dir, join(venv, "bin", tool)) || tool}` : existsSync(join(dir, "uv.lock")) || existsSync(join(abs, "uv.lock")) ? `uv run ${tool}` : existsSync(join(dir, "poetry.lock")) ? `poetry run ${tool}` : tool;
    const flaskText = flask ? await readFile(join(dir, flask), "utf8").catch(() => "") : "";
    const own = /\bport\s*=\s*(\d{2,5})\b|["']PORT["']\s*,\s*["']?(\d{2,5})/.exec(flaskText); // app.run(port=5001), os.environ.get("PORT", 5001)
    const port = hint ?? (own ? (own[1] ?? own[2])! : flask ? "5000" : "8000");
    const command = django
      ? `${bin("python")} manage.py runserver ${port}`
      : flask
        ? /__main__[\s\S]*\.run\(/.test(flaskText) ? `${bin("python")} ${flask}` : `${bin("flask")} --app ${flask.replace(/\.py$/, "").replace(/\//g, ".")} run --port ${port}`
        : /fastapi\[standard\]|fastapi-cli/.test(reqs)
        ? `${bin("fastapi")} dev ${fastapi} --port ${port}`
        : `${bin("uvicorn")} ${fastapi!.replace(/\.py$/, "").replace(/\//g, ".")}:${/^\s*(\w+)\s*(?::\s*\w+\s*)?=\s*FastAPI\(/m.exec(await readFile(join(dir, fastapi!), "utf8"))?.[1] ?? "app"} --reload --port ${port}`;
    return { name: "api", command, ...(d ? { cwd: d } : {}), url: `http://localhost:${port}` };
  }
  return undefined;
}

export interface Jdk {
  home: string;
  major: number;
}
/** Installed JDKs and the major version plain `java` runs (if known). */
export interface Java {
  jdks: Jdk[];
  current?: number;
}

async function jdkAt(home: string): Promise<Jdk | undefined> {
  const v = /JAVA_VERSION="(?:1\.)?(\d+)/.exec(await readFile(join(home, "release"), "utf8").catch(() => ""))?.[1];
  return v ? { home, major: Number(v) } : undefined;
}

const ls = async (dir: string, re: RegExp, sub = "") => (await readdir(dir).catch(() => [] as string[])).filter((n) => re.test(n)).map((n) => join(dir, n, sub));

// JAVA_HOME, macOS java_home, Homebrew, Linux, NixOS, SDKMAN and Windows installs.
async function findJava(): Promise<Java> {
  const listed =
    process.platform === "darwin"
      ? await new Promise<string[]>((ok) =>
          execFile("/usr/libexec/java_home", ["-V"], { timeout: 3000 }, (_e, out, err) => ok(`${out}\n${err}`.split("\n").flatMap((l) => /^\s+\d\S*\s.*?\s(\/\S.*)$/.exec(l)?.[1] ?? []))),
        )
      : [];
  const brew = (await Promise.all(["/opt/homebrew/opt", "/usr/local/opt"].map((d) => ls(d, /^openjdk(@\d+)?$/, "libexec/openjdk.jdk/Contents/Home")))).flat();
  const other = (await Promise.all([ls("/usr/lib/jvm", /./), ls(join(homedir(), ".sdkman/candidates/java"), /^\d/)])).flat();
  other.push("/run/current-system/sw/lib/openjdk", join(homedir(), ".nix-profile/lib/openjdk")); // NixOS
  if (process.platform === "win32") other.push(...(await Promise.all(["Java", "Eclipse Adoptium", "Microsoft"].map((d) => ls(join(process.env.ProgramFiles || "C:\\Program Files", d), /jdk/i)))).flat());
  const env = str(process.env.JAVA_HOME);
  const all = (await Promise.all([...(env ? [env] : []), ...listed, ...brew, ...other].map(jdkAt))).filter((j): j is Jdk => !!j);
  const jdks = all.filter((j, i) => all.findIndex((k) => k.home === j.home) === i);
  const current = env ? jdks.find((j) => j.home === env)?.major : listed.length ? jdks.find((j) => j.home === listed[0])?.major : undefined;
  return { jdks, ...(current !== undefined ? { current } : {}) };
}

// firebase.json emulators: the one whose ports the app connects to, else the root's.
async function firebaseProc(
  abs: string,
  dirs: string[],
  facts: Facts,
  deps: Record<string, unknown>,
  name: string,
  java: () => Promise<Java>,
  notes: string[],
): Promise<ProcessSpec | undefined> {
  const found: { d: string; emu: Record<string, { port?: unknown; host?: unknown }> }[] = [];
  for (const d of dirs) {
    const emu = (await readJson(join(abs, d, "firebase.json")))?.emulators;
    if (emu && typeof emu === "object") found.push({ d, emu: emu as Record<string, { port?: unknown }> });
  }
  const pick = found.find((f) => Object.values(f.emu).some((e) => facts.emulatorPorts.has(String(e?.port)))) ?? found[0];
  if (!pick) return undefined;
  const only = Object.keys(pick.emu).filter((k) => !["ui", "hub", "logging", "eventarc", "tasks"].includes(k) && pick.emu[k] && typeof pick.emu[k] === "object");
  if (!only.length) return undefined;
  const rc = (await readJson(join(abs, pick.d, ".firebaserc"))) ?? (await readJson(join(abs, ".firebaserc")));
  const project = str((rc?.projects as Pkg | undefined)?.default) ?? facts.firebaseProject ?? `demo-${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
  const localDir = [join(abs, pick.d), abs].find((d) => existsSync(join(d, "node_modules/.bin/firebase")));
  const localVer = localDir ? str((await readJson(join(localDir, "node_modules/firebase-tools/package.json")))?.version) : undefined;
  const major = /(\d+)/.exec(localVer ?? str(deps["firebase-tools"]) ?? "")?.[1];
  let cli = localDir ? "npx firebase" : `npx -y firebase-tools${major ? `@${major}` : ""}`;
  // firebase-tools 14+ (and @latest) needs Java 21; 13 runs on Java 11+.
  const needs = !major || Number(major) >= 14 ? 21 : 11;
  const { jdks, current } = await java();
  let home: string | undefined;
  if (current === undefined || current < needs) {
    const newest = [...jdks].sort((a, b) => b.major - a.major)[0];
    if (newest && newest.major >= needs) home = newest.home;
    else if (newest && newest.major >= 11) {
      // ponytail: firebase-tools 13 is the last line that runs on Java 11-20; drop when JDK 21 is everywhere.
      if (newest.major !== current) home = newest.home;
      cli = "npx -y firebase-tools@13";
      notes.push(`The Firebase emulators in this project need Java 21, and the newest Java here is ${newest.major}. Shrike runs them with firebase-tools 13, which works with Java ${newest.major}. Install Java 21 to use the project's own version.`);
    } else notes.push(`The Firebase emulators need Java ${needs} or newer. ${newest ? `The newest Java here is ${newest.major}.` : "Shrike didn't find Java on this computer."} Install Java ${needs} (or set JAVA_HOME to it), then open the project again.`);
  }
  const main = pick.emu.firestore ?? pick.emu[only[0]!]!;
  const port = Number(main.port) || (pick.emu.firestore ? 8080 : undefined);
  return {
    name: "firebase",
    command: `${home ? `JAVA_HOME="${home}" PATH="${home}/bin:$PATH" ` : ""}${cli} emulators:start --project ${project} --only ${only.join(",")}`,
    ...(pick.d ? { cwd: pick.d } : {}),
    ...(port ? { url: `http://${str(main.host) ?? "127.0.0.1"}:${port}` } : {}),
  };
}

const nonEmpty = <T>(a: T[]): T[] | undefined => (a.length ? a : undefined);
const PLACE_KINDS: PlaceKind[] = ["caller", "client", "service", "queue", "cache", "data", "outside"];
const PROCESS_NAME = /^[\w.-]{1,40}$/;

function configProcesses(v: unknown): ProcessSpec[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ProcessSpec[] = [];
  for (const p of v) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = str(o.name);
    const command = str(o.command);
    if (!name || !PROCESS_NAME.test(name) || !command || out.some((q) => q.name === name)) continue;
    out.push({ name, command, ...(str(o.cwd) ? { cwd: str(o.cwd) } : {}), ...(str(o.url) ? { url: str(o.url) } : {}) });
  }
  return nonEmpty(out);
}

/** Validated `places` from .shrike/config.json (D8). */
export function configPlaces(v: unknown): ProjectInfo["declaredPlaces"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: NonNullable<ProjectInfo["declaredPlaces"]> = {};
  for (const [key, p] of Object.entries(v)) {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const name = str(o.name);
    if (name && PLACE_KINDS.includes(o.kind as PlaceKind)) out[key] = { kind: o.kind as PlaceKind, name };
  }
  return Object.keys(out).length ? out : undefined;
}

/** #52: `redact` from .shrike/config.json. All or nothing: a broken block is ignored with a warning, never half applied. */
export function configRedact(v: unknown): { rules?: RedactRules; warning?: string } {
  if (v === undefined) return {};
  const warning = 'Shrike ignored "redact" in .shrike/config.json. It should look like { "keys": ["address"], "headers": ["x-tenant"], "keep": ["status"] }.';
  if (!v || typeof v !== "object" || Array.isArray(v)) return { warning };
  const o = v as Record<string, unknown>;
  const rules: RedactRules = {};
  for (const k of Object.keys(o)) {
    const list = o[k];
    if ((k !== "keys" && k !== "headers" && k !== "keep") || !Array.isArray(list) || list.length > 200 || !list.every((x) => typeof x === "string" && x.trim() && x.length <= 100)) return { warning };
    rules[k] = list.map((x: string) => x.trim());
  }
  return { rules };
}

// ponytail: a port flag or PORT= in the script text; anything else is learnt from the output at run time.
function withUrl(p: ProcessSpec, script: string): ProcessSpec {
  const port = /(?:--port[= ]|\bPORT=|-p )(\d{2,5})\b/.exec(script)?.[1];
  return port ? { ...p, url: `http://localhost:${port}` } : p;
}

// ponytail: "dir" and "dir/*" patterns only (no ** or negations).
async function workspaceDirs(abs: string, pkg: Record<string, unknown>): Promise<string[]> {
  const ws = pkg.workspaces;
  let patterns: string[] = Array.isArray(ws) ? ws : Array.isArray((ws as { packages?: unknown })?.packages) ? (ws as { packages: string[] }).packages : [];
  if (!patterns.length) {
    try {
      const yaml = await readFile(join(abs, "pnpm-workspace.yaml"), "utf8");
      const block = /^packages:\s*\n((?:[ \t]+-.*\n?|\s*#.*\n?)*)/m.exec(yaml)?.[1] ?? "";
      patterns = [...block.matchAll(/^[ \t]+-\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]!);
    } catch {}
  }
  const dirs: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.startsWith("!")) continue;
    const pat = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const star = /^(.*?)\/\*{1,2}$/.exec(pat);
    let found: string[] = [pat];
    if (star) {
      try {
        found = (await readdir(join(abs, star[1]!), { withFileTypes: true })).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => `${star[1]}/${e.name}`).sort();
      } catch {
        found = [];
      }
    }
    for (const d of found) if (!dirs.includes(d) && existsSync(join(abs, d, "package.json"))) dirs.push(d);
  }
  return dirs;
}

async function procfile(abs: string): Promise<ProcessSpec[]> {
  let text: string;
  try {
    text = await readFile(join(abs, "Procfile"), "utf8");
  } catch {
    return [];
  }
  const out: ProcessSpec[] = [];
  for (const m of text.matchAll(/^([\w.-]+):\s*(.+?)\s*$/gm)) if (!out.some((p) => p.name === m[1])) out.push(withUrl({ name: m[1]!, command: m[2]! }, m[2]!));
  return out;
}

// Only the URL scheme of connection settings is read; values never leave this function.
const DB_KEY = /^(?:DATABASE_URL|REDIS_URL)$|(?:^|_)(?:DB|DATABASE|MONGO(?:DB)?|REDIS|MYSQL|MARIADB|POSTGRES(?:QL)?|PG|SQLITE)\w*_(?:URL|URI|DSN)$/;
function envSchemes(envs: Env[]): string[] {
  return envs.flatMap((env) => Object.entries(env).flatMap(([k, v]) => (DB_KEY.test(k) && /^([a-z][a-z0-9+.-]*):/i.test(v) ? [/^([a-z][a-z0-9+.-]*):/i.exec(v)![1]!.toLowerCase()] : [])));
}

const DATA = (system: string): Place => ({ id: `data:${system}`, kind: "data", name: system.toUpperCase() });
const OUTSIDE = (name: string, host: string): Place => ({ id: `outside:${host}`, kind: "outside", name, detail: host });
const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).host.replace(/^127\.0\.0\.1(?=:|$)/, "localhost") : undefined;
  } catch {
    return undefined;
  }
};

// D11. Ids are prefixes of what agents report at run time ("data:postgres" before "data:postgres:orders").
function expectPlaces(p: {
  name: string;
  appUrl?: string;
  processes: ProcessSpec[];
  deps: Record<string, unknown>;
  usesSqlite: boolean;
  env: string[];
  declaredPlaces: ProjectInfo["declaredPlaces"];
}): Place[] {
  const out: Place[] = [];
  const add = (pl: Place) => void (out.some((o) => o.id === pl.id) || out.push(pl));
  const has = (d: string) => d in p.deps;
  const appHost = hostOf(p.appUrl);
  if (p.appUrl) add({ id: `client:${new URL(p.appUrl).origin}`, kind: "client", name: `WEB · ${p.name}`, detail: appHost });
  for (const proc of p.processes) {
    if (/\bemulators:start\b/.test(proc.command)) {
      if (/\bfirestore\b/.test(proc.command)) add(DATA("firestore"));
      continue;
    }
    const host = hostOf(proc.url);
    const declared = host ? (p.declaredPlaces?.[host] ?? p.declaredPlaces?.[host.replace(/^localhost(?=:|$)/, "127.0.0.1")]) : undefined;
    if (declared) add({ id: `${declared.kind}:${host}`, kind: declared.kind, name: declared.name, detail: host });
    else if (!host || host !== appHost) add({ id: `service:${proc.name}`, kind: "service", name: proc.name.toUpperCase(), ...(host ? { detail: host } : {}) });
  }
  if (has("ioredis") || has("redis") || p.env.some((s) => s.startsWith("redis"))) add({ id: "cache:redis", kind: "cache", name: "REDIS" });
  if (has("lru-cache")) add({ id: "cache:lru", kind: "cache", name: "LRU" });
  if (has("pg") || has("postgres") || has("@electric-sql/pglite") || p.env.some((s) => s.startsWith("postgres"))) add(DATA("postgres"));
  if (has("mysql2") || has("mysql") || p.env.includes("mysql")) add(DATA("mysql"));
  if (has("mongodb") || has("mongoose") || p.env.some((s) => s.startsWith("mongodb"))) add(DATA("mongodb"));
  if (Object.keys(p.deps).some((d) => d.startsWith("@supabase/"))) add(DATA("supabase"));
  if (has("better-sqlite3") || p.usesSqlite || p.env.some((s) => s === "file" || s === "sqlite")) add(DATA("sqlite"));
  if (has("stripe")) add(OUTSIDE("STRIPE", "api.stripe.com"));
  if (has("openai")) add(OUTSIDE("OPENAI", "api.openai.com"));
  if (has("@anthropic-ai/sdk")) add(OUTSIDE("ANTHROPIC", "api.anthropic.com"));
  const procHosts = new Set(p.processes.map((x) => hostOf(x.url)));
  for (const [key, d] of Object.entries(p.declaredPlaces ?? {})) {
    if (procHosts.has(key.replace(/^127\.0\.0\.1(?=:|$)/, "localhost"))) continue; // named on its process above
    add({ id: `${d.kind}:${key}`, kind: d.kind, name: d.name, detail: key });
  }
  // A declared database file replaces the generic SQLITE guess (it is that database, with the user's name).
  const declaredFile = Object.entries(p.declaredPlaces ?? {}).some(([k, d]) => d.kind === "data" && /\.(db|sqlite3?)$/i.test(k));
  return declaredFile ? out.filter((o) => o.id !== "data:sqlite") : out;
}

// Stores a start plan or run skill can name. ponytail: well-known names only (ysweet, livekit stay off the lanes); upgrade: let the plan pass kinds.
const STORES: [RegExp, PlaceKind, string][] = [
  [/\bpostgres(?:ql)?\b/i, "data", "postgres"],
  [/\b(?:mysql|mariadb)\b/i, "data", "mysql"],
  [/\bmongo(?:db)?\b/i, "data", "mongodb"],
  [/\bclickhouse\b/i, "data", "clickhouse"],
  [/\b(?:elasticsearch|opensearch)\b/i, "data", "elasticsearch"],
  [/\bminio\b/i, "data", "minio"],
  [/\bfake-gcs\b/i, "data", "gcs"],
  [/\bzero-cache\b/i, "cache", "zero-cache"],
  [/\b(?:redis|valkey)\b/i, "cache", "redis"],
  [/\bmemcached\b/i, "cache", "memcached"],
  [/\bkafka\b/i, "queue", "kafka"],
  [/\brabbitmq\b/i, "queue", "rabbitmq"],
  [/\bnats\b/i, "queue", "nats"],
];
const CLIENT = /^(web|client|frontend|site|dashboard|www)$/i; // "app", "ui", "admin" are often API servers: they need the app_ready port
const INFRA = /^(infra|infrastructure|services|deps|dependencies|docker|compose|stack)$/i;
const storeOf = (name: string) => STORES.find(([re]) => re.test(name) && name.replace(re, "").replace(/[\s_-]/g, "") === "");

/** Where `re` is named next to a port: "postgres 5433", "redis :6379", "`tcp:5433` postgres". */
function portNear(text: string, re: RegExp): number | undefined {
  const src = re.source;
  const m = new RegExp(String.raw`${src}[\s\`'"(,:]{0,4}(?:localhost|127\.0\.0\.1)?:?(\d{4,5})\b`, "i").exec(text) ?? new RegExp(String.raw`(?:tcp|localhost):(\d{4,5})\`?\s+${src}`, "i").exec(text);
  return m ? Number(m[1]) : undefined;
}

/** `start_service` named `backend` … :3001 in a run skill's numbered steps. instrument: false (infra) is not a lane: its stores are. */
function skillServices(text: string): { name: string; port?: number; infra: boolean }[] {
  const out: { name: string; port?: number; infra: boolean }[] = [];
  for (const m of text.matchAll(/start_service`?\s+named\s+`?([\w.-]+)`?/g)) {
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(/\n\s*(?:\d+[.)]\s|#)/);
    const para = end < 0 ? rest : rest.slice(0, end);
    const port = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:(\d{4,5})\b/.exec(para)?.[1];
    out.push({ name: m[1]!, ...(port ? { port: Number(port) } : {}), infra: /instrument:\s*false/.test(para) });
  }
  return out;
}

/** Lanes-from-plan: the expected lanes from Claude's start plan and/or a run skill's text, not package.json. [] = nothing to go on. Pure. */
export function plannedPlaces(services: { name: string; port?: number; url?: string }[] = [], text = "", guess?: Pick<ProjectInfo, "expectedPlaces" | "declaredPlaces">): Place[] {
  const out: Place[] = [];
  const add = (pl: Place) => void (out.some((o) => o.id === pl.id) || out.push(pl));
  const fromSkill = skillServices(text);
  const portOf = (host?: string) => Number(host?.split(":")[1]) || undefined;
  const ports = [portOf(hostOf(/app_ready`?\s+`?(https?:\/\/[^\s`'")]+)/.exec(text)?.[1])), portOf(guess?.expectedPlaces.find((x) => x.kind === "client")?.detail)];
  const declared = (detail?: string) => (detail ? (guess?.declaredPlaces?.[detail] ?? guess?.declaredPlaces?.[detail.replace(/^localhost/, "127.0.0.1")]) : undefined);
  const byName = new Map<string, { name: string; port?: number; infra: boolean }>();
  for (const s of fromSkill) byName.set(s.name.toLowerCase(), s);
  for (const s of services) {
    const port = s.port ?? (Number(hostOf(s.url)?.split(":")[1]) || undefined);
    const was = byName.get(s.name.toLowerCase());
    byName.set(s.name.toLowerCase(), { name: s.name, ...(port ?? was?.port ? { port: port ?? was?.port } : {}), infra: was?.infra ?? false });
  }
  // The page lane: the app_ready port, else the scanner's app URL port, else a page-like name.
  const all = [...byName.values()].filter((s) => s.port && !s.infra && !storeOf(s.name));
  const page = ports.reduce<(typeof all)[number] | undefined>((f, p) => f ?? all.find((s) => p && s.port === p), undefined) ?? (ports[0] ? undefined : all.find((s) => CLIENT.test(s.name)));
  for (const s of byName.values()) {
    const store = storeOf(s.name);
    const detail = s.port ? `localhost:${s.port}` : undefined;
    const d = declared(detail);
    if (d) add({ id: `${d.kind}:${detail}`, kind: d.kind, name: d.name, detail: detail! });
    else if (store) add({ id: `${store[1]}:${store[2]}`, kind: store[1], name: store[2].toUpperCase(), ...(detail ? { detail } : {}) });
    else if (s.infra || INFRA.test(s.name)) continue;
    else if (s === page) add({ id: `client:http://${detail}`, kind: "client", name: s.name.toUpperCase(), detail: detail! });
    else add({ id: `service:${s.name}`, kind: "service", name: s.name.toUpperCase(), ...(detail ? { detail } : {}) });
  }
  for (const [re, kind, system] of STORES) {
    if (!named(text, re) || out.some((o) => o.id === `${kind}:${system}`)) continue;
    const port = portNear(text, re);
    add({ id: `${kind}:${system}`, kind, name: system.toUpperCase(), ...(port ? { detail: `localhost:${port}` } : {}) });
  }
  if (!out.length) return out;
  // The plan replaces the guessed page and process lanes; the scanner's stores, outside APIs and declared places (D8) stay.
  for (const g of guess?.expectedPlaces ?? []) {
    const d = declared(g.detail);
    if ((d || (g.kind !== "client" && g.kind !== "service")) && !out.some((o) => o.id === g.id || (g.detail && o.detail === g.detail))) add(g);
  }
  return out;
}

/** `re` said outright, not "no redis needed" or "without postgres". */
function named(text: string, re: RegExp): boolean {
  for (const m of text.matchAll(new RegExp(re.source, "gi"))) if (!/\b(?:no|not|without|skip|instead of)\s+(?:\w+\s+(?:or|and|,)\s+)*$/i.test(text.slice(Math.max(0, m.index - 40), m.index))) return true;
  return false;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name), out);
    } else if (e.isFile() && CODE_EXT.test(e.name) && !e.name.endsWith(".d.ts")) {
      out.push(join(dir, e.name));
    }
  }
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;

// ponytail: regex only, so router mount prefixes (app.use("/api", router)) aren't applied. Upgrade: ts-morph.
const EXPRESS = /\b(?:app|router|\w+Router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`)/g;

// Plain node:http: route tables ("POST /v1/users": handler) and `req.method === "POST" && path === "/v1/users"`.
const ROUTE_KEY = new RegExp(String.raw`["'](${METHODS.join("|")}) (/[^"'\s]*)["']\s*:`, "g");
const METHOD_CHECK = new RegExp(String.raw`method\s*===?\s*["'](${METHODS.join("|")})["']\s*&&\s*[\w.]+\s*===?\s*["'](/[^"']*)["']`, "g");

function nextSegments(segments: string[]): string | undefined {
  const out: string[] = [];
  for (const s of segments) {
    if (/^\(.*\)$/.test(s) || s.startsWith("@")) continue;
    if (s.startsWith("_")) return undefined; // private folder, not routable
    const m = /^\[{1,2}(\.\.\.)?([^\]]+)\]{1,2}$/.exec(s);
    out.push(m ? `:${m[2]}${m[1] ? "*" : ""}` : s);
  }
  return "/" + out.join("/");
}

// FastAPI and Flask decorators: @app.get("/orders/{id}"), @bp.route("/rooms/<int:id>", methods=["GET", "POST"]).
// ponytail: APIRouter(prefix=...) and Blueprint url_prefix aren't applied; Django urls.py isn't read. Upgrade: follow include_router / register_blueprint.
const PY_ROUTE = /^\s*@\w+\.(get|post|put|patch|delete|route)\(\s*(?:"([^"\n]*)"|'([^'\n]*)')([^)\n]*)/gm;
const pyPath = (p: string) => p.replace(/\{(\w+)(?::\w+)?\}/g, ":$1").replace(/<(?:\w+:)?(\w+)>/g, ":$1");

function routesIn(rel: string, text: string): Route[] {
  const routes: Route[] = [];
  const at = (index: number) => ({ file: rel, line: lineAt(text, index), precision: "exact" as const });
  if (rel.endsWith(".py")) {
    for (const m of text.matchAll(PY_ROUTE)) {
      const path = m[2] ?? m[3] ?? "";
      if (!path.startsWith("/")) continue;
      const methods = m[1] === "route" ? (/methods\s*=\s*[[(]([^\])]*)/.exec(m[4]!)?.[1]?.match(/\w+/g) ?? ["GET"]) : [m[1]!];
      for (const method of methods) routes.push({ method: method.toUpperCase(), path: pyPath(path), handler: at(m.index + m[0].indexOf("@")) });
    }
    return routes;
  }
  for (const m of text.matchAll(EXPRESS)) {
    const path = m[2] ?? m[3] ?? m[4] ?? "";
    if (path.startsWith("/") || path === "*") routes.push({ method: m[1]!.toUpperCase(), path, handler: at(m.index) });
  }
  for (const m of [...text.matchAll(ROUTE_KEY), ...text.matchAll(METHOD_CHECK)]) routes.push({ method: m[1]!, path: m[2]!, handler: at(m.index) });

  const parts = rel.split("/");
  const appIdx = parts[0] === "app" ? 0 : parts[0] === "src" && parts[1] === "app" ? 1 : -1;
  if (appIdx >= 0 && /^route\.(ts|js)$/.test(parts.at(-1)!)) {
    const path = nextSegments(parts.slice(appIdx + 1, -1));
    if (path !== undefined) {
      const fn = new RegExp(String.raw`export\s+(?:async\s+)?(?:function\s+|(?:const|let|var)\s+)(${METHODS.join("|")})\b`, "g");
      for (const m of text.matchAll(fn)) routes.push({ method: m[1]!, path, handler: at(m.index) });
      for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const name of m[1]!.split(",")) {
          const exported = name.trim().split(/\s+as\s+/).at(-1)!;
          if (METHODS.includes(exported)) routes.push({ method: exported, path, handler: at(m.index) });
        }
      }
    }
  }

  const pagesIdx = parts[0] === "pages" ? 0 : parts[0] === "src" && parts[1] === "pages" ? 1 : -1;
  if (pagesIdx >= 0 && parts[pagesIdx + 1] === "api") {
    const segs = parts.slice(pagesIdx + 1);
    segs[segs.length - 1] = segs.at(-1)!.replace(CODE_EXT, "");
    if (segs.at(-1) === "index") segs.pop();
    const path = nextSegments(segs);
    const def = /export\s+default\b/.exec(text);
    if (path !== undefined && def) {
      // ponytail: methods guessed from req.method checks; a handler with none is listed as GET.
      const found = new Set<string>();
      for (const m of text.matchAll(new RegExp(String.raw`(?:method\s*[!=]==?\s*|case\s+)["'](${METHODS.join("|")})["']`, "g"))) found.add(m[1]!);
      for (const method of found.size ? found : ["GET"]) routes.push({ method, path, handler: at(def.index) });
    }
  }
  return routes;
}

export async function scanRoutes(root: string): Promise<Route[]> {
  return (await scanCode(resolve(root))).routes;
}

interface Facts {
  routes: Route[];
  usesSqlite: boolean;
  ports: { file: string; port: string }[]; // `process.env.PORT ?? 3000`, `.listen(3000)`, one per file
  emulatorPorts: Set<string>; // connectFirestoreEmulator(db, host, 8080)
  py?: "fastapi" | "flask"; // the Python web framework a .py file makes an app with
  firebaseProject?: string;
}

async function scanCode(abs: string): Promise<Facts> {
  const files: string[] = [];
  await walk(abs, files);
  const byKey = new Map<string, Route>();
  let usesSqlite = false;
  const ports: Facts["ports"] = [];
  const emulatorPorts = new Set<string>();
  let firebaseProject: string | undefined;
  let py: Facts["py"];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    usesSqlite ||= /["']node:sqlite["']|^\s*(?:import|from) sqlite3\b/m.test(text);
    const rel = relative(abs, file).split(sep).join("/");
    if (rel.endsWith(".py")) py ??= /=\s*FastAPI\(/.test(text) ? "fastapi" : /=\s*Flask\(/.test(text) ? "flask" : undefined;
    const port = /process\.env\.PORT\s*(?:\?\?|\|\|)\s*["']?(\d{2,5})|\.listen\(\s*(\d{2,5})\b/.exec(text);
    const app = !/(^|\/)(tests?|__tests__|e2e|cypress|scripts)\/|\.(test|spec)\.\w+$/.test(rel);
    if (port && app) ports.push({ file: rel, port: (port[1] ?? port[2])! });
    if (app) for (const m of text.matchAll(/connect\w*Emulator\([^)]*?\b(\d{4,5})\b/g)) emulatorPorts.add(m[1]!);
    firebaseProject ??= /projectId\s*:\s*["'](demo-[\w-]+)["']/.exec(text)?.[1];
    for (const r of routesIn(rel, text)) {
      const key = `${r.method} ${r.path}`;
      if (!byKey.has(key)) byKey.set(key, r);
    }
  }
  const routes = [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
  return { routes, usesSqlite, ports, emulatorPorts, ...(py ? { py } : {}), ...(firebaseProject ? { firebaseProject } : {}) };
}

// R2: files that say how a project starts, for the start agent to read first. Hints only: Claude reads them and decides.
const SETUP_FILES = [
  "README.md", "README", "readme.md", "CONTRIBUTING.md", "docs/setup.md", "docs/development.md", "DEVELOPMENT.md",
  "justfile", "Justfile", ".justfile", "Makefile", "Taskfile.yml", "Procfile", "Procfile.dev", "package.json", "pnpm-workspace.yaml", "turbo.json", "nx.json",
  "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "docker-compose.dev.yml", "docker-compose.override.yml",
  "flake.nix", ".envrc", "devbox.json", "shell.nix", "process-compose.yml", "process-compose.yaml", "mise.toml", ".tool-versions", ".nvmrc", ".node-version",
  "pyproject.toml", "requirements.txt", "Pipfile", "uv.lock", "poetry.lock", "manage.py", "Gemfile", "go.mod", "Cargo.toml",
  ".env.example", ".env.sample", ".env.template",
];

/** The setup files present at `root` (and one level into apps/, packages/, services/), repo-relative. */
export async function setupFiles(root: string): Promise<string[]> {
  const abs = resolve(root);
  const found = SETUP_FILES.filter((f) => existsSync(join(abs, f)));
  const ci = await readdir(join(abs, ".github", "workflows")).catch(() => [] as string[]);
  found.push(...ci.filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => `.github/workflows/${f}`));
  for (const group of ["apps", "packages", "services", "backend", "frontend"]) {
    const dirs = await readdir(join(abs, group), { withFileTypes: true }).catch(() => []);
    for (const d of dirs.filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
      for (const f of ["package.json", "pyproject.toml", "requirements.txt", ".env.example", "README.md", "Procfile"]) if (existsSync(join(abs, group, d, f))) found.push(`${group}/${d}/${f}`);
    }
    for (const f of ["package.json", "pyproject.toml", "requirements.txt", ".env.example"]) if (existsSync(join(abs, group, f))) found.push(`${group}/${f}`);
  }
  return [...new Set(found)];
}
