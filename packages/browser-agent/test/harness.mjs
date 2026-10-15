// Electron main: serves a React 18 page, injects the bundle over CDP like apps/desktop does, drives it, prints JSON.
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const bundle = readFileSync(join(here, "../dist/browser-agent.js"), "utf8");

function umd(pkg, file) {
  const direct = join(repo, "fixtures/todo-app/node_modules", pkg, "umd", file);
  if (existsSync(direct)) return direct;
  const store = join(repo, "node_modules/.pnpm");
  const dir = readdirSync(store).find((d) => d.startsWith(`${pkg}@18`));
  return join(store, dir, "node_modules", pkg, "umd", file);
}

const received = [];
const listen = (handler) =>
  new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

// No top-level await: it would hold back Electron's "ready" event.
let crossOrigin = "";
async function run() {
const main = await listen((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    const path = req.url;
    if (path.startsWith("/api/")) received.push({ path, method: req.method, traceparent: req.headers.traceparent ?? null });
    const json = (status, v, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", "x-served-by": "harness", ...extra });
      res.end(JSON.stringify(v));
    };
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Harness</title><div id="root"></div>
<script>window.__CROSS_ORIGIN=${JSON.stringify(crossOrigin)}</script>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/page.js"></script>`);
    } else if (path === "/react.js" || path === "/react-dom.js" || path === "/page.js") {
      const file =
        path === "/react.js"
          ? umd("react", "react.development.js")
          : path === "/react-dom.js"
            ? umd("react-dom", "react-dom.development.js")
            : join(here, "page.js");
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(readFileSync(file));
    } else if (path === "/api/initial") json(200, { initial: true });
    else if (path === "/api/todos")
      json(500, { error: "NOT NULL constraint failed: todos.user_id", got: JSON.parse(body) }, { "server-timing": 'db;dur=53.2;desc="Postgres", app;dur=47', traceresponse: `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01` });
    else if (path === "/api/fail") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    } else if (path === "/api/destroy") req.socket.destroy();
    else if (path === "/api/echo") json(200, { method: req.method, headers: req.headers, body }, { "server-timing": "cache;desc=miss, total;dur=12" });
    else if (path === "/api/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("a");
      setTimeout(() => res.write("b"), 60);
      setTimeout(() => res.end("c"), 120);
    } else if (path === "/api/slow") {
      const t = setTimeout(() => json(200, { slow: true }), 2000);
      res.on("close", () => clearTimeout(t));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});
const cross = await listen((req, res) => {
  received.push({ path: "cross:" + req.url, method: req.method, traceparent: req.headers.traceparent ?? null });
  res.writeHead(req.method === "OPTIONS" ? 204 : 200, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "content-type": "text/plain",
    "server-timing": "db;dur=99", // not exposed (no Access-Control-Expose-Headers): the page can't read it
  });
  res.end(req.method === "OPTIONS" ? "" : "cross ok");
});
const port = main.address().port;
crossOrigin = `http://127.0.0.1:${cross.address().port}`;

const phase = (s) => process.stderr.write(`[harness] ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const out = { msgs: [], received, steps: {} };
try {
  phase("listening");
  await app.whenReady();
  phase("ready");
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  // Like the desktop <webview src="about:blank">: CDP needs a live renderer before commands resolve.
  await wc.loadURL("about:blank");
  wc.debugger.attach("1.3");
  wc.debugger.on("message", (_e, method, params) => {
    if (method === "Runtime.bindingCalled" && params.name === "__shrikeEmit") out.msgs.push(JSON.parse(params.payload));
  });
  const cdp = (m, p) => wc.debugger.sendCommand(m, p);
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Runtime.addBinding", { name: "__shrikeEmit" });
  const { identifier: scriptId } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: bundle });
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${expression}: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  };
  const ended = (id) => out.msgs.some((m) => m.type === "action_end" && m.actionId === id);

  phase("injected");
  await wc.loadURL(`http://127.0.0.1:${port}/`);
  const nav = await waitFor(
    () => out.msgs.flatMap((m) => m.events ?? []).find((e) => e.kind === "user_action" && e.trigger === "navigation"),
    5000,
    "navigation action",
  );
  await waitFor(() => ended(nav.id), 5000, "navigation end");
  out.steps.nav = nav.id;
  phase("loaded");

  // Second injection must be a no-op.
  await evaluate(bundle);

  const snap = await evaluate("window.__shrike.snapshot()");
  out.snapshot = snap;
  const ref = (name) => snap.elements.find((el) => el.name === name)?.ref;

  out.steps.typeResult = await evaluate(`window.__shrike.type(${JSON.stringify(ref("New todo"))}, "buy milk")`);
  out.echo = await evaluate(`document.getElementById("echo").textContent`);

  for (const name of ["Add Todo", "Fail", "Network fail", "Cross", "Stream", "Abort", "Xhr", "Req", "Buy milk"]) {
    const id = await evaluate(`window.__shrike.click(${JSON.stringify(ref(name))})`);
    out.steps[name] = id;
    phase(`clicked ${name} -> ${id}`);
    if (id) await waitFor(() => ended(id), 8000, `end of ${name}`);
  }
  out.steps.submit = await evaluate(`window.__shrike.type(${JSON.stringify(ref("Search"))}, "q", true)`);
  if (out.steps.submit) await waitFor(() => ended(out.steps.submit), 5000, "submit end");
  // Enter in the field: the browser clicks the form's Go button for it; that's still the form's submit.
  const rootsBefore = out.msgs.length;
  const s = await evaluate(`(() => { const r = document.querySelector('[aria-label="Search"]').getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: s.x, y: s.y, button: "left", clickCount: 1 });
  await sleep(50);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(600);
  out.enterRoots = out.msgs.slice(rootsBefore).flatMap((m) => (m.type === "events" ? m.events : [])).filter((e) => e.kind === "user_action" && e.durationMs === undefined).map((e) => `${e.trigger} ${e.name}`);
  out.steps.missingRef = await evaluate(`window.__shrike.click("nope")`);

  // O1 point mode: hover outlines the element, the click goes to Shrike and never reaches the page.
  const c = await evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Add")); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const pointMsgs = () => out.msgs.filter((m) => m.type === "point");
  out.point = { addsBefore: await evaluate("window.__results.adds ?? 0") };
  await evaluate("window.__shrike.point(true)");
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  await sleep(50);
  out.point.tag = await evaluate(`document.querySelector('[data-shrike-point="tag"]')?.textContent ?? null`);
  out.point.boxShown = await evaluate(`document.querySelector('[data-shrike-point="box"]')?.style.display`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await waitFor(() => pointMsgs().length === 1, 3000, "point pick");
  out.point.pick = pointMsgs()[0];
  await sleep(200);
  out.point.addsAfter = await evaluate("window.__results.adds ?? 0");
  out.point.boxAfter = await evaluate(`document.querySelector('[data-shrike-point="box"]')?.style.display`);
  await evaluate("window.__shrike.point(true)");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(() => pointMsgs().length === 2, 3000, "point cancel");
  out.point.cancel = pointMsgs()[1];

  // B1 recording: real input events become flow steps; nothing is reported once recording stops.
  const center = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const mouse = async (sel) => {
    const p = await center(sel);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(30);
  };
  const flowSteps = () => out.msgs.filter((m) => m.type === "flow_step").map((m) => m.step);
  await evaluate(`(() => { const f = document.createElement("form"); f.id = "login"; f.onsubmit = (e) => e.preventDefault();
    f.innerHTML = '<input type="password" aria-label="Password" id="pw">'; const n = document.createElement("input"); n.id = "note"; n.setAttribute("aria-label", "Note"); document.body.append(n, f); })()`);
  await evaluate("window.__shrike.record(true)");
  const button = (name) => `button:nth-of-type(${["Add", "Fail", "Network fail", "Cross", "Stream", "Abort"].indexOf(name) + 1})`;
  await mouse("#note");
  await cdp("Input.insertText", { text: "eggs" });
  await mouse(button("Abort"));
  await mouse("#pw");
  await cdp("Input.insertText", { text: "hunter2" });
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await mouse('input[type="checkbox"]');
  await sleep(100);
  await evaluate("window.__shrike.record(false)");
  const recorded = flowSteps().length;
  await mouse(button("Stream"));
  await sleep(1000); // let its action close before the "outside any action" log
  out.flow = { steps: flowSteps(), after: flowSteps().length - recorded };

  await evaluate(`console.log("outside any action")`);
  // #54: page scripts find no binding, in the page or in a same-origin iframe, so forged messages reach nothing.
  out.forge = await evaluate(`(async () => {
    const forged = JSON.stringify({ type: "events", events: [{ id: "f".repeat(16), traceId: "f".repeat(32), origin: "browser", kind: "log", name: "forged", startMs: Date.now(), status: "ok", log: { level: "info", message: "forged" } }] });
    const blank = document.body.appendChild(document.createElement("iframe"));
    const same = document.createElement("iframe");
    same.src = "/api/initial";
    await new Promise((r) => ((same.onload = r), document.body.appendChild(same)));
    const seen = [window, blank.contentWindow, same.contentWindow].map((w) => typeof w.__shrikeEmit);
    for (const w of [window, blank.contentWindow, same.contentWindow]) try { w.__shrikeEmit(forged); } catch {}
    return seen;
  })()`);
  await sleep(200);
  out.results = await evaluate("window.__results");
  out.consoleWorks = await evaluate(`typeof console.log === "function" && console.log("x") === undefined`);
  await sleep(100);
  // A request the page's own navigation cuts off (a polling health check) is cancelled, not broken.
  const before = out.msgs.length;
  await evaluate(`(() => { fetch("/api/slow").catch(() => {}); setTimeout(() => (location.href = "/?again"), 150); })()`);
  await sleep(1500);
  out.left = out.msgs.splice(before).flatMap((m) => m.events ?? []).filter((e) => e.kind === "http_request" && e.durationMs !== undefined);
  // #54: main's config closure turns traceparent off (a live origin).
  await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {\nconst __shrikeConfig = {"traceparent":false};\n${bundle}\n})();` });
  await wc.loadURL(`http://127.0.0.1:${port}/?live`);
  out.liveEcho = await evaluate(`fetch("/api/echo", { method: "POST", body: "x" }).then((r) => r.json())`);
  out.liveConfig = await evaluate("typeof window.__shrikeConfig");
  out.msgs.splice(before);
} catch (err) {
  out.error = String(err?.stack ?? err);
}
process.stdout.write("\n@@RESULT@@" + JSON.stringify(out) + "\n");
main.close();
cross.close();
app.exit(0);
}
run();
