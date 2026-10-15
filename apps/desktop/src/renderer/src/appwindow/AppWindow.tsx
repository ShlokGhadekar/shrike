import { useEffect, useRef, useState } from "react";
import { Crosshair, PanelLeftClose, RotateCw } from "lucide-react";
import type { RunStatus } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { useUi } from "../stores/ui.ts";
import { cx, IconButton } from "../components/ui.tsx";
import { Toasts } from "../components/Toasts.tsx";
import { PointLayer } from "../hud/AppDock.tsx";
import { isMac } from "../lib/platform.ts";

const PAGE_CANVAS = { colorScheme: "light", background: "Canvas" } as const;

/** AW1: the user's app in its own window (index.html#app-window). Main adopts this webview exactly like the docked one; closing the window docks it back. */
export function AppWindow() {
  const ref = useRef<HTMLWebViewElement>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [url, setUrl] = useState("");
  const [partition, setPartition] = useState<string | null>(null);
  const pointing = useUi((s) => s.pointing);

  useEffect(() => {
    document.title = "Your app";
    const a = api();
    const sync = () => void a.appPartition().then(setPartition, () => {}); // #55: the same session as the dock, following the side
    void a.getRunStatus().then(setStatus).catch(() => {});
    sync();
    const offs = [
      a.on("run:status", (s) => (setStatus(s), sync())),
      a.on("point:picked", (pick) => useUi.setState({ pointing: false, pick: { ...pick, at: Date.now() } })),
      a.on("point:cancelled", () => useUi.setState({ pointing: false })),
    ];
    const el = ref.current;
    const onNav = (e: Event) => {
      const u = (e as Event & { url?: string }).url;
      if (u && u !== "about:blank") setUrl(u.replace(/^https?:\/\//, ""));
    };
    el?.addEventListener("did-navigate", onNav);
    el?.addEventListener("did-navigate-in-page", onNav);
    return () => {
      offs.forEach((off) => off());
      el?.removeEventListener("did-navigate", onNav);
      el?.removeEventListener("did-navigate-in-page", onNav);
    };
  }, [partition]);

  const running = status?.state === "running";
  const point = async () => {
    useUi.setState({ pointing: !pointing });
    if (pointing) return void call((a) => a.cancelPointMode(), "Couldn't stop pointing");
    if (!(await call((a) => a.startPointMode().then(() => true), "Couldn't start point mode"))) useUi.setState({ pointing: false });
  };

  return (
    <div className="app-bg flex h-full w-full flex-col">
      <header className={cx("drag group flex h-8 shrink-0 items-center gap-2 border-b border-hair", isMac ? "pr-1.5 pl-[76px]" : "pr-[calc(100%-env(titlebar-area-width,100%)+6px)] pl-3")}>
        <span className="lbl shrink-0">Your app</span>
        {running && <span className="lbl selectable no-drag min-w-0 truncate" style={{ textTransform: "none" }}>{url}</span>}
        <span className="flex-1" />
        {running && (
          <IconButton
            label={pointing ? "Stop pointing (Esc)" : "Point at something in your app"}
            aria-pressed={pointing}
            className={cx("size-6", pointing && "text-signal")}
            style={pointing ? { filter: "drop-shadow(0 0 6px var(--signal))" } : undefined}
            onClick={() => void point()}
          >
            <Crosshair size={13} />
          </IconButton>
        )}
        {running && (
          <IconButton label="Reload your app" className="size-6" onClick={() => void call((a) => a.reloadApp(), "Couldn't reload")}>
            <RotateCw size={12} />
          </IconButton>
        )}
        <button type="button" className="hud-btn" title="Put your app back in Shrike's window (O)" onClick={() => void call((a) => a.dockApp(), "Couldn't bring your app back")}>
          <PanelLeftClose size={13} aria-hidden />
          Dock back
        </button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-void">
        {partition && <webview key={partition} ref={ref} partition={partition} allowpopups={"true" as unknown as boolean} src="about:blank" className="absolute inset-0 h-full w-full" style={running ? PAGE_CANVAS : undefined} />}
        {running && <PointLayer />}
        {status && !running && (
          <div className="absolute inset-0 grid place-items-center bg-void p-6 text-center">
            <div className="flex max-w-[320px] flex-col items-center gap-2">
              <p className="font-display text-[15px] text-ink">{status.state === "starting" ? "Starting your app" : "Your app isn't running."}</p>
              {status.state !== "starting" && <p className="m-0 text-[12.5px] text-dim">Press Run in Shrike and it opens here.</p>}
            </div>
          </div>
        )}
      </div>
      <Toasts />
    </div>
  );
}
