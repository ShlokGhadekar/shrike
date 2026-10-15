import { app, dialog, type BrowserWindow } from "electron";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProcessSpec, ProjectInfo } from "@shrike/schema";
import { detectProject, plannedPlaces } from "@shrike/scanner";
import { livePartition } from "./app-view.ts";
import { runSkillId, runSkillPath } from "./start/runskill.ts";
import { writeAtomicSync } from "./state-file.ts";

// ponytail: remembered only; not auto-reopened, so launch always starts on the welcome screen.
const stateFile = () => join(app.getPath("userData"), "state.json");

export async function loadProject(root: string): Promise<{ info: ProjectInfo; serverUrl?: string }> {
  let real: string;
  try {
    real = realpathSync(root);
    if (!statSync(real).isDirectory()) throw new Error();
  } catch {
    throw new Error(`That folder doesn't exist: ${root}`);
  }
  const info = await detectProject(real);
  // Lanes-from-plan: a run skill that names the services beats the package.json guess.
  try {
    const places = plannedPlaces([], readFileSync(runSkillPath(info.root, runSkillId(info.name)), "utf8"), info);
    if (places.length) (info.expectedPlaces = places), (info.placesFrom = "skill");
  } catch {}
  try {
    writeAtomicSync(stateFile(), JSON.stringify({ lastProject: info.root }));
  } catch {}
  // A project with no web page sends explorer requests straight to its first process that listens.
  const config = readConfig(info.root);
  const serverUrl = config.serverUrl;
  // #53: a live project's origins; a bad value is dropped, so it never widens what agents can reach
  const live = liveZ.parse(config); // authoritative over the scanner's lenient read
  info.liveUrl = live.liveUrl;
  info.origins = live.origins?.length ? live.origins : undefined;
  info.livePartition = live.liveUrl ? livePartition(live.liveUrl) : undefined;
  return { info, serverUrl: typeof serverUrl === "string" ? serverUrl : info.appUrl ? undefined : info.processes.find((p) => p.url)?.url };
}

const httpUrl = z.string().url().refine((u) => /^https?:$/.test(new URL(u).protocol));
const liveZ = z.object({ liveUrl: httpUrl.optional().catch(undefined), origins: z.array(httpUrl).max(20).optional().catch(undefined) });

export function readConfig(root: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(join(root, ".shrike/config.json"), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** D12: write `processes` into .shrike/config.json, keeping every other key. */
export function saveProcesses(root: string, processes: ProcessSpec[]): void {
  saveConfig(root, { processes });
}

/** #54: a live URL typed by the user, as a clean http(s) URL. */
export function liveUrlFrom(input: string): string {
  let u: URL;
  try {
    u = new URL(/^[a-z][\w+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new Error("That isn't a web address. Paste it like https://your-app.com");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Shrike opens web addresses only: https:// or http://");
  return u.href;
}

/** #54: a live site with no folder gets a scratch project in userData/live/<host>/ holding only .shrike/config.json. */
export function liveProjectRoot(url: string): string {
  const root = join(app.getPath("userData"), "live", new URL(url).host.replace(/[^\w.-]/g, "_"));
  saveConfig(root, { liveUrl: url });
  return root;
}

/** #54: the user said once per host that they own the app or may test it; saved in the project's .shrike/config.json. */
export async function liveConsent(root: string, url: string, win: BrowserWindow | undefined): Promise<boolean> {
  const host = new URL(url).host;
  const said = readConfig(root).liveConsent;
  if (Array.isArray(said) && said.includes(host)) return true;
  const opts = {
    type: "question" as const,
    message: `Open ${host}?`,
    detail: "Shrike records every request this site makes, including the data real people see on it. Only open apps you own or have permission to test.",
    buttons: ["I own this app or may test it", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (r.response !== 0) return false;
  saveConfig(root, { liveConsent: [...(Array.isArray(said) ? said : []), host] });
  return true;
}

/** Merge `patch` into .shrike/config.json, keeping every other key (null removes one). */
export function saveConfig(root: string, patch: Record<string, unknown>): void {
  const file = join(root, ".shrike", "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    const v: unknown = (() => {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return undefined;
      }
    })();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Shrike can't read .shrike/config.json, so it didn't change it. Fix that file, then try again.");
    config = v as Record<string, unknown>;
  }
  const next: Record<string, unknown> = { ...config, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === null) delete next[k];
  writeAtomicSync(file, JSON.stringify(next, null, 2) + "\n");
}

export async function pickFolder(win: BrowserWindow | undefined): Promise<string | undefined> {
  // ponytail: test-only stand-in for the native folder picker, like SHRIKE_EDITOR_LOG.
  if (process.env.SHRIKE_OPEN_FOLDER) return process.env.SHRIKE_OPEN_FOLDER;
  const opts = { title: "Open a project", properties: ["openDirectory" as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? undefined : r.filePaths[0];
}
