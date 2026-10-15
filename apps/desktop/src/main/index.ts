import { app, BrowserWindow, screen, type WebContents } from "electron";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { color } from "@shrike/design";
import { redactText } from "@shrike/redact";
import { stopAllAgents } from "./agent.ts";
import { appView, runner, shutdown } from "./host.ts";
import { reapOrphans, trackGroups } from "./runner.ts";
import { registerIpc } from "./ipc.ts";
import { automated, headless } from "./headless.ts";
import { banner } from "./banner.ts";
import { placeAppWindow, plainUserAgent } from "./app-view.ts";
import { adoptUserPath, isMac } from "./platform.ts";
import { writeAtomicSync } from "./state-file.ts";

let win: BrowserWindow | undefined;
let appWin: BrowserWindow | undefined; // the user's app in its own window (detached from the dock)
const ICON = join(import.meta.dirname, "../../resources/icon.png"); // B-brand4: the dot-bust app icon (design-system/brand/icon.py)

// A bug in main is logged and Shrike keeps running: no "A JavaScript error occurred" dialog, no crash that leaves the user's app orphaned.
function logError(kind: string, err: unknown): void {
  const line = `${new Date().toISOString()} ${kind}: ${redactText(err instanceof Error ? (err.stack ?? err.message) : String(err))}\n`;
  console.error(`[shrike] ${line}`);
  try {
    const dir = join(app.getPath("userData"), "logs");
    const file = join(dir, "main.log");
    mkdirSync(dir, { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 1_000_000) renameSync(file, `${file}.old`);
    appendFileSync(file, line);
  } catch {}
}
process.on("uncaughtException", (err) => logError("uncaught exception", err));
process.on("unhandledRejection", (err) => logError("unhandled rejection", err));

// One Shrike per userData: a second launch focuses the first instead of fighting it for files and the MCP port.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", () => win && (win.isMinimized() && win.restore(), win.focus()));

if (headless && process.platform === "darwin") app.setActivationPolicy("accessory");
// #55: app-wide, because a window.open popup ignores its session's user agent; sign-in providers see plain Chrome.
app.userAgentFallback = plainUserAgent(app.userAgentFallback);
// Dev only, a real terminal only: never in tests, headless runs or piped logs.
if (process.env.ELECTRON_RENDERER_URL && process.stdout.isTTY && !headless && !automated) process.stdout.write(banner());

const webPreferences = {
  preload: join(import.meta.dirname, "../preload/index.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: true,
  backgroundThrottling: !(headless || automated), // hidden or background test windows must keep rendering and running timers
};

// macOS: the traffic lights sit inset in the window's own top bar. Windows and Linux: the top bar is the title bar too, with the
// system buttons drawn over its right end in the theme's colours (setWindowChrome repaints them).
const chrome = (height: number, x: number, y: number) =>
  isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x, y } } : { titleBarStyle: "hidden" as const, titleBarOverlay: { color: color.void, symbolColor: color.ink, height } };

function loadRenderer(w: BrowserWindow, hash?: string): void {
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ""));
  else void w.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash });
}

// Both windows: no navigation away, hardened app webviews, and main adopts each one's webview for recording.
function guard(wc: WebContents): void {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("will-frame-navigate", (e) => !e.isMainFrame && !e.url.startsWith("about:") && e.preventDefault()); // M2: a mockup's link never leaves its sandbox
  wc.on("will-attach-webview", (_e, prefs) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
  });
  appView.watch(wc);
  // A crashed window loads again (state comes back from main); three crashes in a minute stop the loop.
  let crashes: number[] = [];
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit" || wc.isDestroyed()) return;
    logError("window crashed", d.reason);
    crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (crashes.length <= 3) wc.reload();
  });
}

const appWinFile = () => join(app.getPath("userData"), "app-window.json");
const appWindowChanged = (open: boolean) => win?.webContents.send("shrike:event:app:window", open);

function openAppWindow(): void {
  if (appWin) return void (appWin.isMinimized() ? appWin.restore() : appWin.focus());
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(appWinFile(), "utf8"));
  } catch {}
  const place = placeAppWindow(saved, screen.getAllDisplays(), screen.getPrimaryDisplay().workArea);
  appView.handOff();
  const w = (appWin = new BrowserWindow({
    ...place.bounds,
    icon: ICON,
    title: "Your app",
    minWidth: 360,
    minHeight: 280,
    show: false,
    fullscreenable: true,
    backgroundColor: color.void,
    ...chrome(32, 12, 9), // centred in the 32px header
    webPreferences,
  }));
  guard(w.webContents);
  if (!headless)
    w.once("ready-to-show", () => {
      if (automated) w.showInactive();
      else w.show();
      if (place.fullScreen) w.setFullScreen(true);
    });
  w.on("close", () => {
    appView.handOff();
    try {
      const bounds = w.getNormalBounds();
      writeAtomicSync(appWinFile(), JSON.stringify({ displayId: screen.getDisplayMatching(bounds).id, bounds, fullScreen: w.isFullScreen() }));
    } catch {}
  });
  w.on("closed", () => {
    if (appWin === w) appWin = undefined;
    appWindowChanged(false);
  });
  loadRenderer(w, "app-window");
  appWindowChanged(true);
}

const closeAppWindow = (): void => appWin?.close();

function createWindow(): void {
  win = new BrowserWindow({
    icon: ICON,
    width: 1480,
    height: 920,
    minWidth: 1100,
    show: false,
    backgroundColor: color.void, // the theme's own ground arrives from the renderer (setWindowChrome)
    ...chrome(44, 16, 15), // centred in the 44px top bar (14px buttons)
    webPreferences,
  });
  const wc = win.webContents;
  guard(wc);
  // ⌘W closes an API client tab (AP5), never the window: the default menu's Close would quit Shrike and stop the user's app.
  wc.on("before-input-event", (e, i) => {
    if (i.type !== "keyDown" || !(i.meta || i.control) || i.shift || i.alt || i.key.toLowerCase() !== "w") return;
    e.preventDefault();
    wc.send("shrike:event:shortcut", "close-tab");
  });
  // Test windows appear without taking keyboard focus from whatever the owner is doing.
  if (!headless) win.once("ready-to-show", () => (automated ? win?.showInactive() : win?.show()));
  win.on("closed", () => ((win = undefined), appWin?.close()));
  loadRenderer(win);
}

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const force = setTimeout(() => app.exit(0), 5000);
  void Promise.allSettled([stopAllAgents(), shutdown()]).finally(() => {
    clearTimeout(force);
    app.quit();
  });
});
process.on("exit", () => runner.killNow());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.quit());

// ponytail: closing the main window closes the app window too and quits on every platform.
app.on("window-all-closed", () => app.quit());

void app.whenReady().then(async () => {
  if (!primary) return;
  // Whatever a force-quit or crashed Shrike left running (and holding its ports) ends before anything new starts.
  const groupsFile = join(app.getPath("userData"), "process-groups.json");
  await reapOrphans(groupsFile).then((n) => n && logError("ended apps left running by the last Shrike", `${n} process group(s)`), (e) => logError("orphan check", e));
  trackGroups(groupsFile);
  if (process.platform === "darwin" && !headless) app.dock?.setIcon(ICON);
  await adoptUserPath(); // before anything looks for git, gh, claude or node
  registerIpc(() => win, { get: () => appWin, open: openAppWindow, close: closeAppWindow });
  createWindow();
});
