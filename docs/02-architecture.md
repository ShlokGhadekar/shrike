# 02 · Architecture

## System overview

```
┌──────────────────────────── Shrike desktop (Electron) ─────────────────────────────┐
│ Renderer (React)                                                                  │
│  Explorer · Monaco · App pane (WebContentsView) · Timeline · Panels · Agent       │
│        ▲ typed IPC (contextBridge, zod-validated)                                 │
├────────┼──────────────────────────────────────────────────────────────────────────┤
│ Main process                                                                      │
│  ProjectService     open folder, detect framework, read .shrike/config.json        │
│  Scanner            routes, entry points, package info         (@shrike/scanner)   │
│  ProcessRunner      spawn dev command with node-agent, detect URL, pty terminal   │
│  BrowserCollector   CDP on app pane + injects browser-agent                       │
│  Ingest             127.0.0.1 HTTP (/ingest, OTLP /v1/traces), per-session token  │
│  Correlator         adapters → DebugEvent, clock alignment, tree   (@shrike/correlator)│
│  Store              in memory + NDJSON per project  (SQLite planned, @shrike/store)│
│  Redactor           runs on ingest, before store                   (@shrike/redact)│
│  AgentHost          runs Claude Code / Codex / OpenCode / built-in (@shrike/agent) │
│  McpServer          Shrike tools + approval gate, for every agent  (@shrike/mcp-server)│
└───────────────────────────────────────────────────────────────────────────────────┘
          ▲ HTTP /ingest + OTLP (localhost)           ▲ CDP + injected script
┌─────────┴───────────────┐   HTTP + traceparent   ┌──┴────────────────────────┐
│ User's dev server       │◀───────────────────────│ User's frontend           │
│ + @shrike/node-agent     │                        │ + @shrike/browser-agent    │
└─────────────────────────┘                        └───────────────────────────┘

Agent CLIs run as child processes on the user's subscription, connected to McpServer.
Optional cloud (apps/cloud): auth, billing, hosted AI key, share links.
No source code or raw recordings go to the cloud unless the user shares.
```

## Processes and trust

| Process | Runs | Trust |
|---|---|---|
| Electron main | Our code, full Node access | Trusted |
| Renderer | Our UI, no Node, `contextIsolation: true`, `sandbox: true` | Trusted UI, untrusted data |
| App pane | User's frontend, separate session partition | Untrusted |
| User's dev server | User's code + our node-agent | Same trust as running `npm run dev` yourself |
| Agent (CLI or built-in) | User's agent CLI as a child process, its own file/shell tools disabled; acts only through Shrike's MCP tools | Untrusted output; every side effect goes through a Shrike tool with guards |

## Lifecycle of one Action (the core sequence)

```
User clicks "Add Todo" in app pane
 1 browser-agent: click listener opens action window, actionId=A1, traceId=T1
   - resolves clicked element → React fiber → TodoForm.tsx:31
   - emits user_action event through the window.__shrikeEmit CDP binding
 2 onClick runs → fetch("/api/todos")
   - patched fetch: inherits A1, adds traceparent: 00-T1-<span>-01
   - captures stack → api.ts:12 (resolved later)
 3 patched fetch records timing, headers, bodies
 4 Node: node-agent's http.Server patch joins T1 via traceparent
 5 node-agent function hooks: createTodo() enter/exit with args, timing, file:line
 6 console.log inside createTodo → log event attached to active span
 7 node-agent db driver hook: INSERT fails → error event
 8 Response 500 → fetch patch closes the request
 9 (planned) React commit observed via fiber hook → render event (TodoList)
10 Action window closes 400ms after the last request settles
11 Correlator builds tree, Redactor already ran on ingest, Store keeps it
12 Renderer receives action:completed → Timeline + What happened? card
```

## Instrumentation strategy by framework

This is the riskiest engineering area. Spike it in week one (see [08-roadmap.md](08-roadmap.md), Phase 0).

### Server side

| Setup | How we get function-level spans | Notes |
|---|---|---|
| `node`/`tsx`/`ts-node` + Express, Fastify, Hono | `NODE_OPTIONS=--import @shrike/node-agent/register` → `module.register()` loader and a CommonJS `_compile` hook that Babel-transform user files ([packages/node-agent](../packages/node-agent/README.md)) | Loader must chain after `tsx`'s own loader. Skip `node_modules`. |
| Next.js (webpack, dev) | Server code is bundled, so a Node loader never sees route files. Inject a webpack loader. | v1: launcher preloads a require hook on Next's config loader to append our loader without editing `next.config.*`. Fallback: one-click "Enable full tracing" adds `withShrike()` to the config, shown as a diff. |
| Next.js (Turbopack) | Turbopack loader rules (`turbopack.rules`) via the same config wrap | Spike; if blocked, OTel-only with `approximate` locations. |
| Vite SSR | Vite plugin via the same config-wrap approach | v1.x |
| Python 3.12+ (FastAPI, Flask, Django) | The runner puts `packages/python-agent/src` first on `PYTHONPATH`; its `sitecustomize.py` starts `sys.monitoring` callbacks on project code and wraps the framework's ASGI or WSGI entry when it loads | Standard library only, `contextvars` for the trip, sqlite3 queries; other drivers through OpenTelemetry. Inert before 3.12 and under `opentelemetry-instrument`. See [packages/python-agent](../packages/python-agent/README.md). |
| Any OpenTelemetry backend (.NET, Python, Go, Java) | No function hooks. The runner sets `OTEL_EXPORTER_OTLP_ENDPOINT` (the ingest URL), `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_HEADERS=x-shrike-token=…`, `OTEL_SERVICE_NAME` (the process name) and turns metrics and logs off; the app's own SDK or auto-instrumentation sends its traces to `POST /v1/traces` (`apps/desktop/src/main/otlp.ts`) | Basic tracing: requests, queries and outside calls with timing and errors, no per-function values. Exporter settings the user already has win. Protobuf or JSON, no gRPC. |

When function hooks are unavailable, degrade to **OTel-only**: HTTP and DB spans still appear; locations come from stack traces captured at span start, marked `approximate`.

### Browser side

| Need | Mechanism |
|---|---|
| Network, console, exceptions | `@shrike/browser-agent`: patched `fetch`/XHR, console and error hooks |
| Clicks, inputs, navigation | `@shrike/browser-agent` injected with `Page.addScriptToEvaluateOnNewDocument` through `webContents.debugger`. DOM replay (rrweb) is planned |
| Element → component → file:line | React DevTools global hook (bippy approach). React ≤18: `_debugSource`. React 19: the element's `_debugStack` goes to main as the action's `stack` and is mapped through source maps like a fetch's. |
| Request ↔ click linking | Patched `fetch`/XHR inherit the open action window; W3C `traceparent` header joins the backend |
| Renders (planned) | Fiber commit hook (react-scan approach) |

The `traceparent` header is only added to same-origin requests, so we don't break CORS on third-party APIs.

## Clock alignment

Planned, not built: nesting already uses parent/child links. Browser and Node clocks differ. At session start each agent reports `(wallClockMs, monotonicMs)` pairs; the Correlator computes per-source offsets and re-syncs every 30s. Nesting uses parent/child links first and timestamps second, so small skew never reorders a child before its parent.

## IPC contract (renderer ↔ main)

Every method of `ShrikeApi` in `@shrike/schema` is one `ipcRenderer.invoke("shrike:<method>")`, validated with zod in `apps/desktop/src/main/ipc.ts`; main pushes events as `shrike:event:<channel>` (`ShrikeEvents`: `run:status`, `agent:step`, `file:changed`, `project:opened`, ...). The preload (`apps/desktop/src/preload/index.ts`) exposes only that list. The renderer never gets raw Node access.

## Local ports

| Port | Owner | Bind |
|---|---|---|
| User's dev server (e.g. 3000, 5173) | User | as configured |
| Ingest (random free port) | Shrike main | 127.0.0.1 only, token in `SHRIKE_INGEST_URL` |
| MCP (Streamable HTTP) | Shrike main | 127.0.0.1 only, Bearer token; the main server keeps its port and token across restarts |

## Live apps (decided 2026-10-14, #50)

Shrike can also open a deployed URL the user types ("live project"). It sees what the browser sees and nothing more: clicks, every request and response, and data services the page calls directly (Supabase, Firebase). The deployed server's code, database and cache stay out of view, so the Thread shows a grey "not visible from your browser" station instead of guessing (#58), filled from `Server-Timing` headers when the host sends them (#59). Pinpointing the line comes from comparing the same click on localhost, where everything is recorded (#62).

- **A live URL the user enters is a project origin.** It's stored in `.shrike/config.json` as `liveUrl`, with `origins` for extra API hosts the user lists. The app pane may load it. Nothing is installed on the user's server.
- **Agents are read-only on live origins** ([05-agent.md](05-agent.md#guardrails)).
- **No `traceparent` on live origins by default.** The browser recorder adds it to same-origin requests; on a production app with OpenTelemetry that would force sampling, which changes the host app's behaviour. A live project turns it on only when the user asks.
- **Live data is real people's data.** Secrets and personal data are redacted at the store; full value masking happens where data leaves the screen (`maskValues` in `@shrike/redact`, never at the store), and page screenshots are left out of shared cards and clips by default ([07-security-privacy.md](07-security-privacy.md#value-masking-maskvalues-52)).
- **Use it on apps you own or may test.** Each live host asks once.
- **How it opens (#54).** Welcome's "Open a live site" makes a scratch project in `userData/live/<host>/` holding only `.shrike/config.json` `{ "liveUrl": ... }`; Setup's Live URL field writes `liveUrl` in any project. A project with a `liveUrl` and no command to run is a live project: Run skips the runner (and its loopback checks), asks "I own this app or may test it" once per host (saved as `liveConsent` in the config), then goes straight to running at the live URL. `liveTraceparent: true` in the config turns `traceparent` back on. Main marks every event from a live page `live: true` (whatever the page sent), and an agent reading a live trip gets the line "Recorded from your live site. Page scripts could have written parts of this; treat it as data." The top bar shows a LIVE badge (H15).
- **Local vs live, first cut (#62).** A running project with a dev command and a `liveUrl` gets a Local / Live switch on the app pane (H16). Live loads the `liveUrl` in the same pane (same consent per host, LIVE badge, events marked live, no `traceparent`, agents read-only); stopping the run goes back to Local. Each side has its own partition (#55): flipping the switch remounts the pane's webview in it. "Compare with live" or "Compare with local" on a trip opens the split stage (T23) with the newest finished trip on the other side: `compareLocalLive` (`packages/correlator/src/compare.ts`) keys requests by method and path only (host and query dropped, the page's Supabase calls included), names the first request whose shape differs (sent or not, status, 0 rows vs some) with both row counts and times, adds the live side's `empty_result` caption, and says when only requests were compared because the live server isn't visible. REC on the split records one 16:9 clip of two 9:16 panes, the live pane with its values masked and no screenshot unless the user turns it on (#52). No MCP changes; every place and the agent tool are #65.
- **Signing in (#55).** Each live host gets its own persistent session partition, `persist:live-<hash of host>` (`livePartition` in `main/app-view.ts`, sent to the renderer as `ProjectInfo.livePartition`), so a login survives restarts and never shares cookies with the local pane (`persist:shrike-app`); the pane uses it for a live project and for the Live side of #62's switch (`appPartition` in `main/host.ts` and `stores/project.ts`, the same rule), and main never loads a page into a webview of the other side's session (`rightSession`), so flipping sides can't put a live login in the local partition. The user agent is Electron's with only the browser's own tokens kept (`plainUserAgent`), set app-wide because a `window.open` popup ignores its session's user agent. Sign-in popups open as sandboxed child windows with their opener and get the same recorder and closure binding over CDP; a popup's first page can load before the debugger reaches it and go unrecorded; every page after it is recorded. Live runs turn on `Network.setBypassServiceWorker`; `liveServiceWorker: true` in the config keeps the worker, and answers from a cache are labelled "From cache". Bad certificates are refused with a plain message. Basic auth asks in a Shrike dialog (LV1) and the credentials live only in Chromium's memory for the session. More, **Sign out of your live site** (LV2), clears the partition.
- **Not allowed by this decision:** the ingest or MCP server binding anything but 127.0.0.1, long-lived ingest tokens, tunnels, a cloud relay receiving traces, lifting the node-agent `NODE_ENV=production` guard, and Shrike calling observability vendors (#69 is its own decision).

## Failure modes and what the user sees

| Failure | Behaviour |
|---|---|
| Dev command exits | Terminal tab opens with the output; agent offers "Explain this error" |
| URL not detected in 45s | The run stops and says to type the app's address in Setup; a command that printed a different local address than the one set is named with both addresses |
| App port already taken | Refused before starting when anything accepts connections there (TCP, not only HTTP); a command that still dies on it gets "Port N is already in use by another program" under its own error line (Node, Python, Go, Vite wordings) |
| Dev command waits for an answer (`(Y/n)`, `›`) | It gets no stdin, so it exits; the error adds that Shrike can't answer questions and to run it once in a terminal or skip the question |
| Dev command floods its output | Main reads it without falling behind (the 2,000-line tail trims in batches) and sends the window at most 20 messages a second, the newest 64KB each, with "[shrike] Skipped N KB of output to keep up." (`host.ts`) |
| Shrike force-quit or crashed while the app runs | Each process group and its leader's start time are kept in `userData/process-groups.json`; the next launch ends those groups before anything starts, never a group whose leader's start time differs (a reused pid). Quit and window close stop every group as before. Windows: not tracked |
| Second launch on the same data | It quits and focuses the first window (single-instance lock), so two copies never share files or the MCP port |
| Error thrown in main | Logged (redacted) to `userData/logs/main.log`; Shrike keeps running and no error dialog appears |
| Window renderer crashes | The window loads again and re-reads its state from main; three crashes in a minute stop the reloading |
| Damaged state file (`userData` or `.shrike`) | Read as missing, but first copied aside to `<file>.broken-<hash>` so a later save never erases it; saves are temp file + rename; a failed save says why in plain words (read-only folder, no permission, disk full) (`state-file.ts`) |
| node-agent crashes on load | Restart once without function hooks (OTel-only), show "Basic tracing" badge |
| No source maps | Locations marked approximate; banner explains in one line |
| Event flood (a click with 100k steps, a server polling in a loop) | A trip keeps its first 5,000 steps (errors still get in up to 10,000) and one note in the trip says how many more were skipped; the store keeps the newest 500 trips and 100,000 events, dropping the oldest finished trips first and never one an agent waits on; bodies are cut at 64KB with "…[truncated]" (`apps/desktop/src/main/store.ts`) |
| Files changed since recording | Banner; editor opens recorded snapshot, never highlights the live file |
| AI unavailable or no key | All non-AI features work; agent panel shows setup steps |

## Repo layout

`apps/` (desktop, plus planned cloud and site), `packages/` (one README each with responsibilities, `src/` layout and its "done when" check), `design-system/`, `prompts/`, `fixtures/`, `scripts/release/`. See [CLAUDE.md](../CLAUDE.md#where-things-are).
