import { create } from "zustand";
import type { AppSide, FileNode, ProcessSpec, ProjectInfo } from "@shrike/schema";
import { call } from "../lib/api.ts";
import { useUi } from "./ui.ts";

interface Recent {
  root: string;
  name: string;
  openedAt: number;
}

interface ProjectState {
  project: ProjectInfo | null;
  files: FileNode[];
  opening: boolean;
  recent: Recent[];
  setProject(p: ProjectInfo | null): void;
  openRoot(root: string): Promise<void>;
  openDialog(): Promise<void>;
  openSample(): Promise<void>;
  openLive(url: string): Promise<boolean>;
  refreshFiles(): Promise<void>;
  saveProcesses(list: ProcessSpec[]): Promise<boolean>;
  saveLiveUrl(url: string | null): Promise<boolean>;
}

const RECENT_KEY = "shrike.recent";

function loadRecent(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((r) => typeof r?.root === "string") : [];
  } catch {
    return [];
  }
}

function remember(p: ProjectInfo): Recent[] {
  const list = [{ root: p.root, name: p.name, openedAt: Date.now() }, ...loadRecent().filter((r) => r.root !== p.root)].slice(0, 5);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: recents are a convenience only
  }
  return list;
}

export const useProject = create<ProjectState>((set, get) => ({
  project: null,
  files: [],
  opening: false,
  recent: loadRecent(),
  setProject(p) {
    set({ project: p, ...(p ? { recent: remember(p) } : {}) });
    if (p) void get().refreshFiles();
  },
  async openRoot(root) {
    set({ opening: true });
    const p = await call((a) => a.openProject(root), "Couldn't open the project");
    set({ opening: false });
    if (p) opened(p);
  },
  async openDialog() {
    set({ opening: true });
    const p = await call((a) => a.openProjectDialog(), "Couldn't open the project");
    set({ opening: false });
    if (p) opened(p);
  },
  async openSample() {
    const root = await call((a) => a.sampleProjectPath(), "Couldn't find the sample project");
    if (root) await get().openRoot(root);
  },
  async openLive(url) {
    set({ opening: true });
    const p = await call((a) => a.openLiveSite(url), "Couldn't open that site");
    set({ opening: false });
    if (p) opened(p);
    return !!p;
  },
  async refreshFiles() {
    const files = await call((a) => a.listFiles(), "Couldn't list files");
    if (files) set({ files });
  },
  async saveProcesses(list) {
    const p = await call((a) => a.setProcesses(list), "Couldn't save the processes");
    if (p) set({ project: p });
    return !!p;
  },
  async saveLiveUrl(url) {
    const p = await call((a) => a.setLiveUrl(url), "Couldn't save the live URL");
    if (p) set({ project: p });
    return !!p;
  },
}));

/** #54: a live URL and nothing to start: Run opens the site (main's liveUrlOf). */
export const isLiveSite = (p: ProjectInfo | null): boolean => !!p?.liveUrl && !p.devCommand.trim() && !p.processes.some((x) => x.command.trim());

/** #55: the app pane's session: the live site's own (main names it) for a live project or the Live side (#62), else the local one.
 * Same rule as main's appPartition. A webview can't change partition, so key the webview by it. */
export const appPartition = (p: ProjectInfo | null, side: AppSide = "local"): string => ((isLiveSite(p) || side === "live") && p?.livePartition) || "persist:shrike-app";

/** D12: an explicit open lands on the setup screen first when there is something to check (several processes, or no web page). */
function opened(p: ProjectInfo): void {
  useProject.getState().setProject(p);
  if (!isLiveSite(p) && (p.processes.length > 1 || !p.appUrl)) useUi.setState({ setup: true });
}
