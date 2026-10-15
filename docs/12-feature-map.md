# 12 · Feature map: discovered lanes, plus what Orca and Claude Code taught us

Decisions taken autonomously on 2026-10-08 while the owner was away. Every element gets a design-system ID (see `design-system/README.md`). **Build** = in the current build. **Design** = specified and in the prototype, built later.

## Part 1. Lanes are discovered, not fixed (D*)

A lane is **a place where code runs or data lives**. Shrike sees places at runtime: every server process says hello with its name, every database or cache call names its system and target, every outgoing call names its host, every incoming request says who sent it.

| ID | Place kind | How it's discovered | Lane name example | Status |
|---|---|---|---|---|
| D1 | **Caller** | Who started the trip: a browser click (SCREEN shot), or the request's `user-agent` (curl, Postman, node-fetch, Shrike's API explorer, a cron or test runner via `SHRIKE_CALLER`) | `YOU`, `CURL`, `CRON` | Build |
| D2 | **Client** | Each web origin the browser-agent runs in | `WEB · shop-web` | Build |
| D3 | **Service** | Each instrumented server process: `SHRIKE_SERVICE` (set per process by the runner), else the nearest `package.json` name | `API`, `AUTH`, `WORKER` | Build |
| D4 | **Queue** | Messaging libraries (BullMQ, SQS, Kafka) | `JOBS · bullmq` | Design |
| D5 | **Cache** | Cache clients: `ioredis`, `redis`, `lru-cache` | `REDIS · cache`, `LRU · sessions` | Build |
| D6 | **Data** | Database clients: `node:sqlite` (file name), PGlite, `pg`, `mysql2`, `mongodb` (target database) | `SQLITE · events.db`, `POSTGRES · orders` | Build (sqlite, PGlite); Design (pg, mysql2, mongodb) |
| D7 | **Outside** | Outgoing HTTP to a host that isn't an instrumented service | `STRIPE · api.stripe.com` | Build |
| D8 | **Declared places** | `.shrike/config.json` `places` can name or re-kind any target (`"localhost:4199": { "kind": "outside", "name": "Stripe (test double)" }`) | anything | Build |
| D9 | **Not visible from your browser** | A live project (#50): the deployed server the page calls (its own origin from `liveUrl`, plus hosts in `origins`), which Shrike can't see inside. Drawn as a grey station (T22) with status and timing when no recorder answered; "Rendered on the server" for the page load and Next.js page data; filled from `Server-Timing` when sent; the full path comes from local vs live | `SERVER · shop.example.com` | Build (#58, #59, #62 first cut); Design (#65) |

**Ordering (D9):** caller → client → service (by first-hop distance from the caller) → queue → cache → data → outside. Stable for the session, so shapes stay comparable between trips. New places slot in by kind.

**Accordion (D10):** lanes the focused trip touches are full width; the rest shrink to 26px slivers with a vertical label. A group of more than 6 touched lanes of the same kind collapses into a group header ("3 services") that expands on click.

**Expected lanes (D11):** before anything runs, the scanner proposes places from the project (workspace packages, `dev:*` scripts, Procfile, docker-compose services, `DATABASE_URL`/`REDIS_URL`, dependencies like `pg`, `ioredis`, `stripe`). They show as ghosted lane headers until seen. This is also the setup screen's "We think your app has: web, api, Postgres, Redis, Stripe". That is only a guess, and the lane header says "guess". Once the project has a run skill, or Claude posts its start plan, the page and service lanes come from that skill or plan (its services, and the databases, caches and queues its recipe names). The scanner's stores, outside APIs and places declared in `.shrike/config.json` stay.

**Multi-process projects (D12):** `.shrike/config.json` `processes: [{ name, command, cwd?, url? }]`. The scanner detects them (pnpm/npm workspaces with `dev` scripts, `dev:web` / `dev:api` scripts, Procfile). The runner starts each process with node-agent and `SHRIKE_SERVICE=<name>`. Terminal output is per process.

**Cross-service traces (D13):** node-agent injects `traceparent` into outgoing `fetch`/`http.request`, so a call from `api` to `auth` continues the same trip in the AUTH lane.

### New shapes (T15–T19)

| ID | Shape | Meaning | Status |
|---|---|---|---|
| T15 | **Bounce**: the thread pokes into CACHE and comes straight back, green dot | Cache hit | Build |
| T16 | **Pass-through**: hollow amber dot in CACHE, the thread continues to DATA, then a small poke back into CACHE (set) | Cache miss, then filled | Build |
| T17 | **Fork**: calls that overlap in time branch side by side and rejoin, labelled "at the same time" | Parallel work | Build |
| T18 | **Handoff**: dashed segment into QUEUE; the job is its own trip, headed "started by Clicked Pay now · 1.2s later" | Background work | Design |
| T19 | **Crossing**: the thread hops between SERVICE lanes | Service-to-service call | Build |
| T20 | **Terminal card**: for non-browser callers, the SCREEN shot is replaced by the command or caller (`$ curl -X POST …`, `cron · 02:00`) | Backend-only trips | Build |

Verdicts extend the shape table: "Stripe refused: amount must be at least 50 cents", "The cache never hit: every request went to the database", "auth took 820ms of the 900ms".

## Part 2. Claude Code → Shrike (A*)

| Claude Code feature | What it means in Shrike | Visual element | ID | Status |
|---|---|---|---|---|
| Plan mode | The agent states its plan before acting | **Planned route**: faint dotted line over the stations it intends to check, then the probe walks it | A1 | Build |
| Todo list | Progress through the plan | Probe ticks (T13) plus a 3-dot progress in the agent column | A2 | Build (exists) |
| Subagents / parallel agents | Several hypotheses at once | **Twin probes**: up to 3 probes in different colours walking different trips, each with its own verdict chip | A3 | Design |
| Skills | Reusable debugging playbooks | **Skill chips** on the agent column ("N+1 hunter", "Auth", "Slow page", "Bad value"), files in `prompts/skills/*.md`; the brain loads the matching one and the chip lights | A4 | Build |
| Memory (CLAUDE.md / memory) | Facts the agent learns about this project | **Pinned notes**: small violet pins on stations and lines ("userId must be a number"), stored in `.shrike/memory.md`; the agent adds them through an MCP tool | A5 | Build |
| Checkpoints / rewind | Every applied fix is a restorable point | **Checkpoint rail**: diamonds on the minimap edge, one per applied patch; click to see the diff, Rewind restores | A6 | Build |
| Context and usage | How much of the agent's budget is used | **Fuel ring** around the ASK button (tokens used / context window), cost on hover | A7 | Build |
| Permissions / approvals | Risky actions ask first | Approval card (exists) | A8 | Build (exists) |
| Hooks | Rules that run automatically | **Watchers**: small eye icons on trip headers for rules like "when a trip breaks, ask the agent" (off by default) | A9 | Design |
| Slash commands | Fast commands | **Command palette** in ⌘K: `/explain`, `/fix`, `/replay`, `/compare`, `/record`, `/time`, `/issue`, `/chain` | A10 | Build |
| MCP | Other agents can read Shrike | **Watched-by eye**: when Cursor or Claude Code outside Shrike reads a trip through MCP, a small eye with its name appears on that trip | A11 | Build |
| Worktrees | Try a fix without touching your files | **Sandbox fix**: the fix runs in a git worktree copy; its re-run trip appears with a "sandbox" ribbon | A12 | Build (W4, docs/13) |
| Code review | Review before accepting | **Line comments on the diff**: comment on any diff line; "Send to agent" asks for a revised patch | A13 | Build |
| Model / effort choice | Pick the brain | Brain picker (exists) with an effort dial (Quick, Normal, Deep on the composer) | A14 | Build (docs/13) |
| Background tasks | Long jobs | Background-job trips (T18) | A15 | Design |
| Artifacts / sharing | Share the result | **Share card**: export the trip clip + an issue-ready summary | A16 | Build (via O6) |
| Status line | Glanceable state | Telemetry strip in the top bar (trips, failures, agent state) | A17 | Build |
| Web search / fetch | The agent looks something up | **Looked-up chip** in the agent column with the source title | A18 | Design |

## Part 3. Orca → Shrike (O*)

| Orca feature | What it means in Shrike | Visual element | ID | Status |
|---|---|---|---|---|
| Design mode (click an element, send to agent) | Ask about anything in your running app | **Point mode** (X, or the crosshair in the app dock): hover outlines elements in the live app, click pins a reticle, and the composer opens with that element as context ("Why does this button do nothing?") | O1 | Build |
| Computer use | The agent operates your app | **Ghost cursor**: a violet cursor with the label "agent" moves and clicks in the app dock when the agent drives the app | O2 | Build |
| Parallel worktrees / fan-out | Try several fixes and pick the winner | **Fix race**: 2–3 candidate fixes, each re-run in its own worktree, their re-run threads side by side; the green one wins | O3 | Build (W3, docs/13) |
| Terminal splits | Output per process | **Process tabs** in the Terminal sheet, one per process, with a status dot | O4 | Build |
| Quick open | Search everything | **⌘P**: files (opens the in-app file view), trips, routes, logs | O5 | Build |
| GitHub & Linear | Turn a bug into an issue or PR | **Issue card**: one click copies a GitHub/Linear-ready issue (title, plain-English summary, steps, the failing line, the fix diff) and saves the clip next to it | O6 | Build (copy + file); Design (direct API) |
| Annotate AI diffs | Comment on changes | A13 line comments | O7 | Build |
| Drag files to agents | Give context fast | **Drag to Ask**: drag a station, a log line or a file onto the composer to attach it as a context chip | O8 | Build |
| Notifications & unread | Know when something needs you | **Unread dots** on trips you haven't viewed and on agent results; macOS notification when the agent needs approval or finishes while Shrike is in the background | O9 | Build |
| Mobile companion | Steer from your phone | **Pair phone** QR in settings; approvals on the phone | O10 | Design |
| SSH worktrees | Remote runs | Remote project badge | O11 | Design |
| Account switcher & usage | Plan limits | Part of A7 (usage on hover, rate-limit reset time when the brain reports it) | O12 | Build (A7) |
| Rich previews | See non-code files | The in-app file view renders Markdown and images | O13 | Build |
| Orca CLI | Agents drive the tool | Shrike's MCP server (exists) + A11 | O14 | Build (exists) |

## What this build does not do yet

Queues (D4/T18), twin probes (A3), watchers (A9), mobile (O10), remote (O11), looked-up chips (A18), direct Linear API. All are specified above and drawn in the prototype so the vocabulary is fixed.

## Built since: skills, git, worktrees, flows and the SDLC rail (docs/13)

Built on 2026-10-08: S1–S6 (skill shelf on K, Claude Code skills imported read-only, run checklist, "Learned something" card, Save as a skill, Save as command), G1–G6 (Ship sheet on S; push, PR, merge and updating main always ask first; never force-push), W1–W5 (worktree tabs, a run per worktree on +100/+200 ports, Try both, Try in a sandbox first, Clean up), B1–B5 (flows shelf on W, recording bar, Keep watching, your own MCP servers behind the "My tools" toggle, Shrike's own actions as MCP tools for outside clients), L1–L7 (the SDLC rail under the top bar) and Pick up where you left off on the welcome screen. Skills live in `prompts/skills`, `.shrike/skills`, `~/.shrike/skills` and (read only) `~/.claude/skills`; flows in `.shrike/flows/<id>.json`; worktrees in `<repo>/.shrike/worktrees/<name>` on `shrike/<name>` branches. S7 (marketplace) stays Design.

### Review fixes (decisions taken while the owner was away)

- Rail buttons follow the current stage: Find the cause at Understand, Review this fix at Review, Ship this fix (or See the pull request) at Ship, Keep watching at Watch. Run the tests shows only when package.json has a real test script, and goes away once it ran. Most two buttons.
- A fix that only lives in a race or sandbox worktree gets no rail buttons: the race card's Use this fix / Bring it over is the one focal point. A failed sandbox or race offers Find another fix and Throw it away; Bring it over is disabled.
- Worktree port offsets skip any offset that would land a shifted port on one of the project's own ports (3000 and 3100 rule out +100), and a run refuses to start on a port another Shrike run holds.
- Worktrees of a project in a monorepo subfolder open that subfolder. Background runs are keyed by folder, and stop when a project from another repo opens.
- A worktree whose copy fails part-way is rolled back; dangling symlinks are copied as links; nested git repos are left out. A half-made worktree can be removed.
- Bringing a fix over takes only the files the fix's patch changed, never .shrike state or files the app wrote while it ran.
- Commit subject, PR title and branch read as the fix: `Fix: "Add Todo" works again`, `fix/add-todo-works-again`.
- Skill shelf: source filters (All, This project, Shrike, From Claude Code), your own and Claude Code skills before built-in ones, names shown as the folder id in mono.
