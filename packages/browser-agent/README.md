# @shrike/browser-agent

Runs inside the user's frontend in the app pane. Main injects `dist/browser-agent.js` with CDP `Page.addScriptToEvaluateOnNewDocument` and receives `IngestMessage` JSON through the `window.__shrikeEmit` binding. Spec: the "browser-agent" section of [docs/mvp-contract.md](../../docs/mvp-contract.md).

```
src/
├── index.ts      # bootstrap (idempotent, top frame only), click/submit/navigation actions
├── emit.ts       # binding calls, buffered (500) and retried every 200ms when missing
├── ids.ts        # trace and event ids
├── actions.ts    # action windows: close 400ms after the last request settles
├── network.ts    # fetch + XHR + sendBeacon patch, traceparent for same-origin only; cross-origin calls are also sent at start so main can join their server side
├── data.ts       # the page's own database calls (Supabase PostgREST/auth, Firestore WebChannel/REST) as db_query on the database's lane
├── console.ts    # console, window errors, unhandled rejections
├── react.ts      # DOM element -> fiber -> _debugSource (React 18 dev), else _debugStack (React 19 dev, mapped by main)
├── names.ts      # accessible names
├── record.ts     # B1: while recording, clicks (accessible name) and typing (secrets marked) as flow steps
├── point.ts      # O1 point mode: outline what's under the mouse, take the next click for Shrike
└── page-api.ts   # window.__shrike.snapshot/click/type
```

`pnpm --filter @shrike/browser-agent build` bundles it. `node --test test/` runs the Electron end-to-end check.
