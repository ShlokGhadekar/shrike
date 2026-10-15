import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppSnapshot, IngestMessage, PointPick } from "@shrike/schema";
import { headless } from "./headless.ts";
import { parseIngest } from "./ingest.ts";

const num = z.number().finite();
const pointMsg = z.object({
  type: z.literal("point"),
  cancelled: z.boolean().optional(),
  pick: z
    .object({
      selector: z.string().max(2000),
      text: z.string().max(200),
      role: z.string().max(60),
      rect: z.object({ x: num, y: num, width: num, height: num, viewportWidth: num, viewportHeight: num }),
      source: z.object({ file: z.string().min(1).max(4096), line: z.number().int().min(1), column: z.number().int().min(0).optional(), precision: z.enum(["exact", "approximate", "unavailable"]) }).optional(),
    })
    .optional(),
});

export interface AppViewOptions {
  bundlePath: string;
  appUrl(): string | undefined; // set while the run is "running"
  live?(): boolean; // #54: the page is a live site; its events are marked live
  traceparent?(): boolean; // #54: add traceparent to same-origin requests (default on)
  bypassServiceWorker?(): boolean; // #55: requests skip the site's service worker
  onLogin?(host: string, realm: string): Promise<{ username: string; password: string } | null>; // #55: basic auth; null cancels
  onNotice?(text: string): void; // #55: a plain message the user should see
  rightSession?(guest: WebContents): boolean; // #55: false while the pane still has the other side's session
  onMessage(msg: IngestMessage): void;
  onWarning(text: string): void;
}

/** The app pane's window.open: web pages open as a small sandboxed child window (kept off screen when headless); anything else is refused. */
export function popupPolicy(url: string): { action: "deny" } | { action: "allow"; overrideBrowserWindowOptions: BrowserWindowConstructorOptions } {
  if (!/^https?:/i.test(url) && url !== "about:blank") return { action: "deny" };
  return { action: "allow", overrideBrowserWindowOptions: { show: !headless, width: 520, height: 680, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
}

/** #55: a live site's own session, one per host: its logins survive restarts and never mix with the local pane's cookies. */
export const livePartition = (url: string): string => `persist:live-${createHash("sha256").update(new URL(url).host.toLowerCase()).digest("hex").slice(0, 16)}`;

/** #55: Electron's user agent with only the browser's own tokens, so sign-in providers see plain Chrome (no Electron, no Shrike). */
export const plainUserAgent = (ua: string): string => ua.replace(/ (?!(?:AppleWebKit|Chrome|Safari|Mobile)\/)[^\s()]+\/[^\s()]+/g, "");

export const CERT_REFUSED = "This site's certificate isn't valid (it's self-signed, expired or for another address), so Shrike didn't open it. Shrike never trusts a bad certificate.";
export const SIGN_IN_REFUSED = "This sign-in doesn't open inside Shrike. Try email sign-in or a test account.";
const REFUSED = /[?&/]disallowed_useragent\b|accounts\.google\.com\/(?:v3\/)?signin\/rejected/; // Google's "this browser may not be secure"

const rect = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(100), height: z.number().int().min(100) });
export const appWindowState = z.object({ displayId: z.number(), bounds: rect, fullScreen: z.boolean() });
type Rect = z.infer<typeof rect>;
const APP_WINDOW = { width: 1280, height: 860 };

/** Where the detached app window opens: its saved place while that display is still connected (kept inside it), else centred on the primary display. */
export function placeAppWindow(saved: unknown, displays: { id: number; workArea: Rect }[], primary: Rect): { bounds: Rect; fullScreen: boolean } {
  const s = appWindowState.safeParse(saved);
  const area = (s.success && displays.find((d) => d.id === s.data.displayId)?.workArea) || undefined;
  const a = area ?? primary;
  const width = Math.min(s.success ? s.data.bounds.width : APP_WINDOW.width, a.width);
  const height = Math.min(s.success ? s.data.bounds.height : APP_WINDOW.height, a.height);
  if (!s.success || !area) return { bounds: { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height }, fullScreen: false };
  const b = s.data.bounds;
  const x = Math.min(Math.max(b.x, a.x), a.x + a.width - width);
  const y = Math.min(Math.max(b.y, a.y), a.y + a.height - height);
  return { bounds: { x, y, width, height }, fullScreen: s.data.fullScreen };
}

/** The recorder bundle with its settings as a closure constant (read by browser-agent as `__shrikeConfig`). */
export const withConfig = (source: string, config: { traceparent: boolean }): string => `(() => {\nconst __shrikeConfig = ${JSON.stringify(config)};\n${source}\n})();`;

const NOT_OPEN = "The app isn't open yet. Press Run first.";
const MAX_SHOTS = 50;
const SHOT_WIDTH = 1280;

export class AppView {
  private opts: AppViewOptions;
  private guest?: WebContents;
  private scriptId?: string;
  private bypassing = false; // #55: the guest's debugger skips the service worker
  private queue: Promise<void> = Promise.resolve(); // serializes attach + load
  // ponytail: in memory, last 50 only. Upgrade: write to the project's .shrike folder.
  private shots = new Map<string, string>(); // root action id -> PNG data URL
  private pointing = false;
  private resume?: string; // the page to reopen when the app moves between the dock and its own window
  onPoint?: (pick: PointPick | null) => void; // O1: null when the page cancelled

  constructor(opts: AppViewOptions) {
    this.opts = opts;
  }

  // Call once with the main window's webContents.
  watch(host: WebContents): void {
    host.on("did-attach-webview", (_e, guest) => void this.adopt(guest));
  }

  private async adopt(guest: WebContents): Promise<void> {
    this.guest = guest;
    // Sign-in popups (Firebase signInWithPopup, OAuth) need a real child window with its opener; it closes itself, or with the app.
    guest.setWindowOpenHandler(({ url }) => popupPolicy(url));
    const popups = new Set<BrowserWindow>();
    guest.on("did-create-window", (w) => {
      popups.add(w);
      w.once("closed", () => popups.delete(w));
      this.watchPage(w.webContents);
      void this.recordPopup(w.webContents).catch(() => {});
    });
    this.watchPage(guest);
    guest.once("destroyed", () => {
      for (const w of popups) if (!w.isDestroyed()) w.close();
      if (this.guest === guest) this.guest = undefined;
    });
    guest.on("render-process-gone", (_e, d) => this.opts.onWarning(`\r\n[shrike] The app page crashed (${d.reason}). Press Reload to open it again.\r\n`));
    guest.debugger.on("message", (_e, method, params) => {
      if (method !== "Runtime.bindingCalled" || params?.name !== "__shrikeEmit") return;
      this.onBinding(String(params.payload));
    });
    guest.debugger.on("detach", () => {
      if (this.guest === guest) this.scriptId = undefined; // a guest left behind by a move must not clear the new one's script
    });
    const resume = this.resume;
    this.resume = undefined;
    if (this.opts.appUrl()) await this.load(resume).catch(() => {});
    else {
      const run = this.queue.then(() => this.ensureAttached(guest));
      this.queue = run.catch((err) => this.opts.onWarning(`\r\n[shrike] Couldn't attach the recorder: ${err.message}\r\n`));
      await this.queue;
    }
  }

  // #55: basic auth asks the user; a refused certificate or sign-in says so in plain words.
  private watchPage(wc: WebContents): void {
    wc.on("login", (e, details, info, cb) => {
      if (info.isProxy || !this.opts.onLogin) return;
      e.preventDefault();
      this.opts.onLogin(new URL(details.url).host, info.realm).then((c) => (c ? cb(c.username, c.password) : cb()), () => cb());
    });
    wc.on("did-fail-load", (_e, code, _desc, _url, main) => main && code <= -200 && code > -300 && this.opts.onNotice?.(CERT_REFUSED)); // -2xx are certificate errors
    wc.on("did-navigate", (_e, url) => REFUSED.test(url) && this.opts.onNotice?.(SIGN_IN_REFUSED));
  }

  // #55: a sign-in popup gets the pane's recorder and closure binding. ponytail: a popup's first page can load before the debugger
  // reaches it and go unrecorded (Firebase opens about:blank first, so all of its pages are); every page after it is.
  private async recordPopup(wc: WebContents): Promise<void> {
    const source = await this.bundle();
    if (!source || wc.isDestroyed()) return;
    const d = wc.debugger;
    d.on("message", (_e, method, params) => method === "Runtime.bindingCalled" && params?.name === "__shrikeEmit" && this.onBinding(String(params.payload), true));
    d.attach("1.3");
    // Sent in one go, in order, so they land before the popup's next page.
    await Promise.all([d.sendCommand("Runtime.enable"), d.sendCommand("Page.enable"), d.sendCommand("Runtime.addBinding", { name: "__shrikeEmit" }), d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source })]);
  }

  private onBinding(payload: string, popup = false): void {
    let msg: IngestMessage | null = null;
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {}
    if ((raw as { type?: unknown } | undefined)?.type === "point") return popup ? undefined : this.onPointMsg(raw);
    try {
      msg = parseIngest(raw);
    } catch {}
    if (!msg) return;
    // The page is untrusted: it may only speak for the browser side.
    const live = this.opts.live?.() === true;
    if (msg.type === "events")
      for (const e of msg.events) {
        e.origin = "browser";
        if (live) e.live = true;
        else delete e.live;
        // The root is sent at open (no duration) and again at close; shoot only at open.
        if (e.kind === "user_action" && !e.parentId && e.durationMs === undefined && (e.trigger === "click" || e.trigger === "submit")) void this.capture(e.id);
      }
    try {
      this.opts.onMessage(msg);
    } catch (err) {
      console.error("[shrike] browser event handling failed", err);
    }
  }

  private async ensureAttached(guest: WebContents): Promise<void> {
    const d = guest.debugger;
    if (!d.isAttached()) {
      d.attach("1.3");
      this.scriptId = undefined;
      await d.sendCommand("Runtime.enable");
      await d.sendCommand("Page.enable");
      await d.sendCommand("Runtime.addBinding", { name: "__shrikeEmit" });
      this.bypassing = false;
    }
    const bypass = this.opts.bypassServiceWorker?.() === true;
    if (bypass || this.bypassing) {
      await d.sendCommand("Network.enable");
      await d.sendCommand("Network.setBypassServiceWorker", { bypass });
      this.bypassing = bypass;
    }
    if (this.scriptId) await d.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.scriptId }).catch(() => {});
    this.scriptId = undefined;
    const source = await this.bundle();
    if (!source) return;
    const r = (await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source })) as { identifier: string };
    this.scriptId = r.identifier;
  }

  private async bundle(): Promise<string | undefined> {
    try {
      // #54: settings go into the script's own closure, never a window property a page could read or set.
      return withConfig(await readFile(this.opts.bundlePath, "utf8"), { traceparent: this.opts.traceparent?.() !== false });
    } catch {
      this.opts.onWarning(`\r\n[shrike] Browser recording is off: ${this.opts.bundlePath} is missing. Run "pnpm --filter @shrike/browser-agent build".\r\n`);
    }
  }

  // Loads the app URL (or `url`) into the app pane with the recorder injected.
  load(url?: string): Promise<void> {
    const run = this.queue.then(() => this.loadNow(url ?? this.opts.appUrl()));
    this.queue = run.catch(() => {});
    return run;
  }

  private async loadNow(url: string | undefined): Promise<void> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed() || !url) throw new Error(NOT_OPEN);
    if (this.opts.rightSession?.(guest) === false) return; // #55: the pane remounts in the right partition and loads then, so a live login never lands in the local one
    try {
      await this.ensureAttached(guest);
    } catch (err) {
      this.opts.onWarning(`\r\n[shrike] Couldn't attach the recorder: ${(err as Error).message}\r\n`);
    }
    try {
      await guest.loadURL(url);
    } catch (err) {
      // ERR_ABORTED happens when a newer navigation (or an HMR reload) replaces this one.
      if (!String((err as Error).message).includes("ERR_ABORTED")) this.opts.onWarning(`\r\n[shrike] Couldn't open ${url}: ${(err as Error).message}\r\n`);
    }
  }

  /** Call before the app moves to the other host: the next guest opens the page this one is on. */
  handOff(): void {
    this.resume = this.currentUrl();
  }

  async reload(): Promise<void> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed()) throw new Error(NOT_OPEN);
    const current = guest.getURL();
    await this.load(current.startsWith("http") ? current : undefined);
  }

  private async capture(actionId: string): Promise<void> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed() || this.shots.has(actionId)) return;
    try {
      const img = await guest.capturePage();
      if (img.isEmpty()) return;
      const small = img.getSize().width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH, quality: "good" }) : img;
      this.shots.set(actionId, small.toDataURL());
      while (this.shots.size > MAX_SHOTS) this.shots.delete(this.shots.keys().next().value!);
    } catch {}
  }

  shot(actionId: string): string | null {
    return this.shots.get(actionId) ?? null;
  }

  clearShots(): void {
    this.shots.clear();
  }

  currentUrl(): string | undefined {
    const url = this.guest && !this.guest.isDestroyed() ? this.guest.getURL() : undefined;
    return url?.startsWith("http") ? url : undefined;
  }

  private async call<T>(expr: string): Promise<T> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed() || !guest.debugger.isAttached() || !this.currentUrl()) throw new Error(NOT_OPEN);
    const r = (await guest.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => { if (!window.__shrike) throw new Error("Shrike's recorder isn't loaded in this page."); return window.__shrike.${expr}; })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "The page threw an error.");
    return r.result?.value as T;
  }

  // The page may only answer a point mode Shrike asked for.
  private onPointMsg(raw: unknown): void {
    const m = pointMsg.safeParse(raw);
    if (!m.success || !this.pointing) return;
    this.pointing = false;
    this.onPoint?.(m.data.pick && !m.data.cancelled ? (m.data.pick as PointPick) : null);
  }

  async startPointMode(): Promise<void> {
    await this.call<void>("point(true)");
    this.pointing = true;
  }

  async cancelPointMode(): Promise<void> {
    this.pointing = false;
    await this.call<void>("point(false)").catch(() => {});
  }

  snapshot(): Promise<AppSnapshot> {
    return this.call<AppSnapshot>("snapshot()");
  }

  async click(ref: string): Promise<string | null> {
    return (await this.call<string | null>(`click(${JSON.stringify(ref)})`)) ?? null;
  }

  async type(ref: string, text: string, submit?: boolean): Promise<string | null> {
    return (await this.call<string | null>(`type(${JSON.stringify(ref)}, ${JSON.stringify(text)}, ${submit === true})`)) ?? null;
  }
}
