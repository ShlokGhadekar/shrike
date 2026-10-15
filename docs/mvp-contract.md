# MVP contract

This is the binding contract for the MVP build. Parallel builders each own one area and must code to the interfaces here and in `packages/schema/src/index.ts`. If something here is wrong, stop and report it; don't silently diverge.

## MVP scope (what "working end to end" means)

1. `pnpm dev` launches the Shrike Electron app. Welcome screen → **Open sample project** opens `fixtures/todo-app`.
2. **Run** spawns the fixture's dev command with node-agent injected. The app appears in the App pane (`<webview>`).
3. Page load and every click create an Action. Clicking **Add Todo** shows: click (`src/TodoForm.tsx:31`) → `POST /api/todos` (`src/api.ts:12`) → server `POST /api/todos` 500 → `createTodo()` (`server/todos.controller.ts:14`) → log "creating todo" (`:16`) → `insertTodo()` called at `:18` with args `{ title: 'buy milk', userId: undefined }` → `INSERT INTO todos` ✕ `NOT NULL constraint failed: todos.user_id`.
4. Clicking a timeline row opens the file in Monaco with the line highlighted and inline values/logs/errors. ↑/↓ step through rows; the editor follows.
5. What happened? card, Network, Logs, API explorer (auto-discovered routes, search, send, copy cURL), Terminal tabs all work.
6. Agent panel: goal → Claude Code runs headless with only Shrike MCP tools → steps stream into the panel → Found it card → proposed patch shown as a diff → Apply writes the file → agent re-runs the scenario → verified.

**MVP simplifications** (deliberate; each gets a `ponytail:` comment at the code site):
- In-memory store in main (no SQLite yet). Cleared on restart.
- Server instrumentation is our own (Babel function hooks + `http.Server` patch + `node:sqlite` patch + console patch). Other backends come in through OpenTelemetry: OTLP/HTTP traces on `/v1/traces` (`apps/desktop/src/main/otlp.ts`), basic tracing only.
- ESM user code only; `.ts` imports must use explicit extensions (Node ≥ 22.18 type stripping). CJS and extensionless TS imports come later.
- Browser network capture via the injected fetch/XHR patch only (no CDP Network domain).
- No rrweb replay, no React render events, no clock alignment (same machine).
- Route discovery by regex, not ts-morph.

## Repo conventions

- pnpm workspace. Node 24 is the dev runtime. TypeScript `strict`, `erasableSyntaxOnly`: no enums, namespaces or parameter properties, so Node can run `.ts` directly.
- **Relative imports use explicit `.ts` extensions.** Workspace packages export `./src/index.ts` directly (no build step), except `browser-agent` (bundled IIFE) and `node-agent` (plain `.mjs`).
- Tests: `node --test` on `test/*.test.ts` in each package. Root `pnpm test` runs all.
- **Do not add dependencies.** Everything needed is already in each `package.json`. If you truly need one, stop and report it.
- No em dashes in user-facing copy.

## Ids and trace context

- `traceId`: 32 lowercase hex. `event.id`: 16 lowercase hex. Generate with `crypto.getRandomValues` / `crypto.randomBytes`.
- Every Action has its own `traceId`. The root event of an Action is a `user_action` event whose `id` is the Action id.
- Browser fetches inside an action window send `traceparent: 00-<traceId>-<fetchEventId>-01`. The server's `http_request` event uses that `traceId` and `parentId = fetchEventId`.
- Server code with no `traceparent` (curl from outside): node-agent makes a new traceId, and main creates a synthetic `user_action` root with `trigger: "server"`, label `"POST /api/x (from outside the app)"`.
- All timestamps are epoch ms.

## node-agent (`packages/node-agent`, plain ESM JavaScript)

Injected by main via env when spawning the dev command through the user's login shell:

```
NODE_OPTIONS=--import=<file URL of packages/node-agent/src/register.mjs> --enable-source-maps
SHRIKE_INGEST_URL=http://127.0.0.1:<port>   SHRIKE_TOKEN=<random>   SHRIKE_PROJECT_ROOT=<absolute project root>
```

- **Inert** (does nothing at all) unless `SHRIKE_INGEST_URL` is set, `process.argv[1]`'s realpath is inside `SHRIKE_PROJECT_ROOT`, and not inside any `node_modules`. This keeps npm, the shell and Vite uninstrumented. Refuses when `NODE_ENV=production`.
- On activation: `POST <ingest>/ingest` `{type:"hello", source:"server", pid, at}`.
- **Loader** (`module.register`): for `file:` URLs inside the project root, not in `node_modules`, extensions `.ts .mts .js .mjs`: read the original file, Babel-transform (strip TS with `@babel/plugin-transform-typescript`, then the Shrike plugin), `sourceMaps: "inline"`, return `{ format: "module", source, shortCircuit: true }`. Everything else → `nextLoad`.
- **Shrike Babel plugin:** for every non-generator `FunctionDeclaration`, `FunctionExpression`, `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod` (kind `method` only), replace the body with
  `return __shrike.run(<id>, <argsExpr>, <async?> () => { <original body> });`
  - `argsExpr` is `arguments` for non-arrows; for arrows it's an array of identifier params (`undefined` for patterns).
  - The arrow keeps `this`, `arguments`, `super` and `new.target` lexically. Concise arrow bodies become `{ return <expr>; }` first.
  - `<id>` indexes a per-file table `{file (repo-relative), line, column, name}` registered at the top of the module: `globalThis.__shrike.def(<fileIndex>, [...])`.
- **Runtime `__shrike.run(id, args, fn)`:** creates a context `{eventId, traceId, parentId}` from `AsyncLocalStorage` (or a fresh trace if there is none and this isn't under a request: such top-level calls are **not** emitted), runs `fn` inside `als.run(ctx, fn)`, captures the call site from `new Error().stack` (first frame in a user file other than the function itself), handles sync return, promise resolve/reject and throw. Emits one `function` event on completion: `name: "<name>()"`, `source` = definition, `callSite`, `args` (previews), `returned`, `status` (`error` on throw, with `error`), `durationMs`.
- **Previews:** `util.inspect(value, { depth: 2, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 200 })`, cut to 2KB. `IncomingMessage` → `req { POST /api/todos body: { … } }`; `ServerResponse` → `res`. Values of keys matching `/pass(word)?|secret|token|api[-_]?key|authorization|cookie|session/i` → `'[redacted]'` before inspecting.
- **HTTP server:** patch `http.Server.prototype.emit` for `"request"`: read `traceparent`, create the request context, wrap the rest of request handling in `als.run`. Capture the response body by wrapping `res.write`/`res.end` (≤ 64KB) and the request body from `req.body` at finish if a framework set it, else the raw chunks. On `res` `"finish"` emit `http_request` (`origin: "server"`, `name: "POST /api/todos"`, `http.status`, headers, bodies, `status: "error"` if ≥ 500).
- **`node:sqlite`:** patch `StatementSync.prototype.run/get/all/iterate`: emit `db_query` (`origin: "db"`, `name` = first ~60 chars of SQL, `db.statement` = full SQL `sourceSQL`, `db.params` preview, `source` = first user frame of the stack, `status: "error"` + `error` on throw).
- **Console:** patch `log/info/warn/error/debug`: emit `log` events with `util.format` message, `source` = first user frame, parent = current context. Outside any request: still emit with a fixed `traceId` of 32 zeros (main shows these in the Logs tab only). Always call the original.
- **Uncaught errors** in a request: the function event carries the error; nothing extra.
- **Exporter:** buffer, flush every 100ms and on `beforeExit`: `POST <ingest>/ingest` `{type:"events", events}` with header `x-shrike-token`. Use the global `fetch` (undici, unpatched). Never throw into user code; on ingest failure drop silently.
- Source locations: Babel gives exact original lines for definitions. Stack frames map back through the inline source map (`--enable-source-maps`). Repo-relative paths.

## browser-agent (`packages/browser-agent`, TS bundled to `dist/browser-agent.js` IIFE by esbuild, `pnpm --filter @shrike/browser-agent build`)

Injected by main into the app pane with CDP `Page.addScriptToEvaluateOnNewDocument`. Talks to main **only** through the CDP binding `window.__shrikeEmit(json: string)` carrying an `IngestMessage`. At document start it keeps the binding in a closure and deletes `window.__shrikeEmit` before any page script runs, in every frame (#54); a page where the binding wasn't there at document start records nothing. If a call throws, buffer up to 500 messages and retry every 200ms. Main wraps the bundle as `(() => { const __shrikeConfig = {...}; <bundle> })()`, so settings like `traceparent` never sit on `window`.

- **Action windows:** a capture-phase `click` listener on `window` (only for elements that are, or are inside, `button, a, input[type=submit|checkbox|radio], [role=button], label, select, summary, [onclick]`, or any element with a React `onClick` prop) and a `submit` listener open an action: `user_action` event with a new traceId, `name: 'Clicked "<accessible name>"'`, `trigger`, `source` from the React fiber. Page load (`DOMContentLoaded`) opens a `navigation` action named `'Opened <pathname>'`.
- An action window stays open while it has pending requests, and closes 400ms after the last one settles (or 400ms after opening if none started). On close emit `{type:"action_end", actionId, at}` and emit the root `user_action` event again with its final `durationMs` and `status` (`error` if any child request ≥ 500 or failed). Main upserts events by `id`.
- **fetch/XHR patch:** a request started while a window is open joins it; outside a window it opens an implicit action (`trigger:"click"`, name `"Background request"`). Adds `traceparent` only for same-origin URLs, and not at all when `__shrikeConfig.traceparent` is false (live sites by default). Emits `http_request` (`origin:"browser"`, `parentId` = action id, `http` with method, path, status, headers, bodies ≤ 64KB, `stack` = `new Error().stack`, `status` `error` on network failure or ≥ 500). Never changes request/response behaviour; read bodies from a `clone()`.
- **Console & errors:** patch console (`log`/`info`/`warn`/`error`) → `log` events in the current window (or traceId zeros); `window.onerror` and `unhandledrejection` → `error` events. Always call the original.
- **React source:** find the `__reactFiber$…` key on the element (walk up the DOM until found), then walk `fiber` → `.return` until a fiber with `_debugSource` (React ≤ 18) is found. Emit `source: { file: <_debugSource.fileName as-is, absolute>, line, column, precision: "exact" }`. Main makes it repo-relative. React 19 has no `_debugSource`: emit the element fiber's `_debugStack.stack` as the action's `stack` and main maps it through the page's source maps. If neither: no `source`.
- **Page API for main/agent:** `window.__shrike = { snapshot(): AppSnapshot, click(ref): string | null, type(ref, text, submit?): string | null }`.
  - `snapshot` assigns `data-shrike-ref="eN"` to visible interactive elements (buttons, links, inputs, textareas, selects, checkboxes, `[role=button]`), returns role, accessible name (aria-label, label text, placeholder, text content), value.
  - `click(ref)` scrolls into view and dispatches a real `element.click()`; returns the actionId it opened (or null).
  - `type` sets the value with the native value setter (so React sees it), dispatches `input` + `change`; if `submit`, submits the closest form via `requestSubmit()` and returns that actionId.
- Never break the page: wrap everything in try/catch.

## Main process ↔ correlator

`@shrike/correlator` exports pure functions (no Electron, no I/O except the injected loader):

```ts
export function buildActionView(rootEvent: DebugEvent, events: DebugEvent[], complete: boolean): ActionView;
// events = all events with root's traceId (any order). Builds tree by parentId, children sorted by startMs.
// Orphans (parentId not found) attach to the root. Server http_request events attach to the browser
// http_request whose id is their parentId. Computes status (error if any error event or http ≥ 500,
// else slow if any slow flag, else ok), durationMs (max end − root start), summary, flags.
// Marks events whose source.file includes "node_modules" as framework.
export function summarize(view: Omit<ActionView, "summary" | "flags">): WhatHappened;
export function findFlags(view: Omit<ActionView, "summary" | "flags">): Flag[];
export function formatActionTree(view: ActionView, opts?: { includeIds?: boolean }): string; // compact text for agents
export function compareActions(before: ActionView, after: ActionView): string; // plain-text diff for agents
export function resolveBrowserStack(
  stack: string, projectRoot: string, loadText: (url: string) => Promise<string>,
): Promise<SourceLocation | undefined>;
// First frame not from the browser-agent bundle, node_modules, /@vite/, /@react-refresh, or chunk-*.js.
// Loads the module text, reads its inline (data: URL) or linked source map, maps line/column with
// @jridgewell/trace-mapping, returns repo-relative file. Caches per URL. precision "exact" when mapped,
// "approximate" when only the URL path is known.
export function relativize(file: string, projectRoot: string): string; // strip root, file://, /@fs, query
```

`What happened?` copy follows docs/06-design.md (status words, plain language). Headline examples: `You clicked "Add Todo". The server returned an error (500).` / `You clicked "Toggle". Everything worked (42ms).`

Heuristics: as docs/05-agent.md, MVP subset: slow, n_plus_one, sequential, duplicate_request, swallowed_error.

## scanner and redact

```ts
// @shrike/scanner
export function detectProject(root: string): Promise<ProjectInfo>; // reads package.json, .shrike/config.json (devCommand, appUrl override)
export function scanRoutes(root: string): Promise<Route[]>; // Express app./router.<method>("path"), Next app/**/route.ts exports, pages/api/**
// @shrike/redact
export function redactEvent(e: DebugEvent): DebugEvent; // headers, key patterns inside JSON/inspect strings, secret shapes, high entropy
export function redactText(s: string): string;
```

## mcp-server and agent

```ts
// @shrike/mcp-server
export function startMcpServer(host: ShrikeHost): Promise<{ url: string; token: string; close(): Promise<void> }>;
// Streamable HTTP MCP on 127.0.0.1:<random>/mcp. Requires header "authorization: Bearer <token>".
// Server name "shrike". Tools (zod input schemas): list_actions, get_action, get_event, search_events,
// get_logs, compare_actions, app_snapshot, app_click, app_type, app_navigate, run_scenario, list_routes,
// send_request, read_file, search_code, list_files, propose_patch, report_findings.
// Outputs are text, compact (formatActionTree), passed through redactText. app_* and run_scenario wait
// for the resulting Action to complete (host.waitForAction) and return its tree.
// send_request with a method other than GET/HEAD asks host.requestApproval first.

// @shrike/agent
export function detectBrains(): Promise<BrainInfo[]>;
export function startAgentRun(opts: {
  goal: string; brain: BrainId; cwd: string;
  mcp: { url: string; token: string };
  context: { frontend?: string; backend?: string; appUrl?: string; routeCount: number; recentActions: string };
  onStep(step: AgentStep): void;
  onStatus(info: AgentRunInfo): void;
  promptsDir: string; // absolute path of prompts/agent; system.md is read and its {{vars}} filled
}): { info: AgentRunInfo; stop(): void };
```

Built-in brain: connects to the same MCP server as a client (`@modelcontextprotocol/sdk` Client), converts its tools to Anthropic tool definitions, and runs a `@anthropic-ai/sdk` tool-use loop (`claude-sonnet-5`, `ANTHROPIC_API_KEY`). One tool surface for every brain.

Claude Code brain: spawn the resolved `claude` binary (login-shell `command -v claude`, then `~/.npm-global/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`) with
`-p <goal> --output-format stream-json --verbose --mcp-config <json string> --strict-mcp-config --tools "" --allowedTools mcp__shrike --append-system-prompt <filled prompts/agent/system.md>`, env `MCP_TOOL_TIMEOUT=600000`, cwd = project root. Parse stream-json lines into `AgentStep`s. A `report_findings` tool call becomes a `findings` step.

## Main process (apps/desktop) responsibilities

- Ingest HTTP server on `127.0.0.1:<random>`: `POST /ingest` with `x-shrike-token`; body is an `IngestMessage`; zod-validated; `redactEvent` on every event; upsert by id.
- Webview: renderer renders `<webview partition="persist:shrike-app" src="about:blank">` (a live project uses `ProjectInfo.livePartition` instead, #55). Main handles `did-attach-webview`, attaches `webContents.debugger` (`1.3`), `Runtime.enable`, `Page.enable`, `Runtime.addBinding({name:"__shrikeEmit"})`, `Page.addScriptToEvaluateOnNewDocument(browser-agent bundle)`, then `loadURL(appUrl)` once the app is running. `Runtime.bindingCalled` → ingest pipeline. The same applies to the app window (AW1, `index.html#app-window`): main adopts its webview the same way, and only one of the two holds the app at a time.
- Browser `http_request` events with `stack` → `resolveBrowserStack` (loadText = `fetch(url)` from main), set `source`, drop `stack`.
- Action lifecycle: an Action is created when its root `user_action` arrives (or synthesised for server-only traces). It is `complete` 500ms after `action_end` (to let server events land). Push `actions:update` with changed ActionViews, throttled to every 100ms.
- Patches: `proposePatch` applies `edits` in memory (each `oldText` must match exactly once, else reject with a clear error), creates the `ApprovalRequest` (kind `patch`), waits for the renderer's answer, writes files on approve, then waits up to 6s for a new node-agent `hello` (server restart via `node --watch`) or 1.5s if only frontend files changed. Keeps `before` for revert.
- Files: list (skip `node_modules`, `.git`, `dist`, dotfiles except `.shrike`), read, write, watch for changes (`file:changed`).
- `sendRequest`: new traceId, synthetic `user_action` (`trigger: "explorer"` or `"agent"`, label `"Sent POST /api/todos"`), `fetch` from main with `traceparent`, returns response + actionId.

## Fixture (`fixtures/todo-app`)

Must match these exact lines (docs depend on them):

| File | Line | Content |
|---|---|---|
| `src/api.ts` | 12 | the `fetch(` call inside `createTodo` |
| `src/TodoForm.tsx` | 31 | the `<button` that renders "Add Todo" |
| `server/todos.controller.ts` | 14 | `export async function createTodo(req, res) {` (typed) |
| `server/todos.controller.ts` | 16 | `console.log("creating todo", { title });` |
| `server/todos.controller.ts` | 18 | the call `insertTodo({ title, userId: req.body.user })` (the planted bug; frontend sends `userId`) |

`dev` script runs Vite on 5173 (strictPort, `/api` proxied to 3001) and `node --watch server/index.ts` on 3001. `.shrike/config.json` sets `appUrl: "http://localhost:5173"`.
