import { useEffect, useRef, useState } from "react";
import { Crosshair, PanelLeftOpen, Play, RotateCw, SquareArrowOutUpRight } from "lucide-react";
import { useRun } from "../stores/run.ts";
import { appPartition, isLiveSite, useProject } from "../stores/project.ts";
import { useUi } from "../stores/ui.ts";
import { useFlows } from "../stores/flows.ts";
import { call } from "../lib/api.ts";
import { stripAnsi } from "../lib/format.ts";
import { MockApp } from "../dev/mock-app.tsx";
import { cx, IconButton } from "../components/ui.tsx";
import { Activity } from "../components/Activity.tsx";
import { run } from "./commands.ts";
import { DockTitle, InspectorPanel, useInspectorKeys } from "../inspector/Inspector.tsx";
import { useInspector } from "../inspector/store.ts";
import { StartQuest } from "../start/Quest.tsx";
import { startWithClaude, useStart, useStartBridge } from "../start/store.ts";
import { toggleAppWindow, useAppWindow, useAppWindowBridge } from "../appwindow/store.ts";

const lastLines = (s: string, n: number): string => stripAnsi(s).replace(/\r/g, "").trimEnd().split("\n").slice(-n).join("\n");

const WIDTH = "clamp(260px, 24vw, 440px)";
const WIDE = "clamp(380px, 36vw, 640px)"; // I: a database grid needs the room
const FLOOR = 260; // WIDTH's own minimum: short of room the inspector shrinks back to it before the stage gives way (Shell)
const PAGE_CANVAS = { colorScheme: "light", background: "Canvas" } as const; // a page with no background of its own reads as in a browser, not black on void

/** The user's live app, docked left. Stays mounted when collapsed (P) so main keeps its webview; in its own window (AW1) the webview lives there instead. */
export function AppDock() {
  useAppWindowBridge();
  const detached = useAppWindow((s) => s.open);
  const status = useRun((s) => s.status);
  const output = useRun((s) => s.output);
  const project = useProject((s) => s.project);
  const partition = appPartition(project, useRun((s) => s.side));
  const ref = useRef<HTMLWebViewElement>(null);
  const [navUrl, setNavUrl] = useState<string | null>(null);
  const pointing = useUi((s) => s.pointing);
  const recording = useFlows((s) => !!s.recording); // B1: the app itself shows it's being recorded
  const inspecting = useInspector((s) => !!s.placeId); // I: the dock shows inside a lane; the webview stays mounted below
  useInspectorKeys();
  useStartBridge(); // R: the start quest
  const plan = useStart((s) => (s.plan && s.plan.projectRoot === project?.root ? s.plan : null));
  const quest = plan && plan.state !== "ready" ? plan : null; // ready: the dock shows the live app
  const asking = !!quest?.steps.some((s) => s.ask); // a question for the user shows even over the live app
  const visible = useUi((s) => s.appVisible) && (!detached || inspecting); // a lane still opens here while the app is away

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onNav = (e: Event) => {
      const url = (e as Event & { url?: string }).url;
      if (url && url !== "about:blank") setNavUrl(url);
    };
    el.addEventListener("did-navigate", onNav);
    el.addEventListener("did-navigate-in-page", onNav);
    return () => {
      el.removeEventListener("did-navigate", onNav);
      el.removeEventListener("did-navigate-in-page", onNav);
    };
  }, [detached, partition]);

  useEffect(() => {
    if (status.state !== "running") setNavUrl(null);
  }, [status.state]);

  const running = status.state === "running";
  const noPage = !!project && !project.appUrl && !status.url; // a URL Claude proved with app_ready counts
  const url = (navUrl ?? status.url ?? project?.appUrl ?? "").replace(/^https?:\/\//, "");
  const appBar = running && !noPage && !inspecting;
  const width = inspecting ? WIDE : WIDTH;

  return (
    <>
      {detached && !visible && (
        <button type="button" className="glass mr-3 flex w-[46px] shrink-0 flex-col items-center gap-3 rounded-[var(--r-card)] py-3 text-dim transition-colors hover:text-ink" title="Bring your app back (O)" onClick={toggleAppWindow}>
          <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden />
          <span className="lbl rotate-180 [writing-mode:vertical-rl]">Your app is in its own window · Bring it back</span>
        </button>
      )}
      <div
        className="relative shrink-[3] overflow-hidden transition-[width,min-width,opacity,margin] duration-300 ease-out"
        style={{ width: visible ? width : 0, minWidth: visible ? FLOOR : 0, marginRight: visible ? 12 : 0, opacity: visible ? 1 : 0 }}
        aria-hidden={!visible}
        inert={!visible}
      >
        <section aria-label="Your app" className={cx("absolute inset-y-0 left-0 grid grid-rows-[28px_1fr] overflow-hidden rounded-[var(--r-card)] bg-abyss", recording ? "border-2 border-fail" : "border border-hair")} style={{ width: visible ? "100%" : width }}>
          <div className="group flex items-center gap-2 border-b border-hair px-2.5">
            <DockTitle />
            {recording && <span className="lbl shrink-0 text-fail">● Rec</span>}
            <span className="flex-1" />
            {appBar && <span className="lbl selectable min-w-0 truncate" style={{ textTransform: "none" }}>{url}</span>}
            {appBar && project?.liveUrl && !isLiveSite(project) && <SideSwitch liveUrl={project.liveUrl} />}
            {appBar && (
              <IconButton
                label={pointing ? "Stop pointing (Esc)" : "Point at something in your app (X)"}
                aria-pressed={pointing}
                className={cx("size-5", pointing ? "text-signal" : "opacity-60 group-hover:opacity-100 focus-visible:opacity-100")}
                style={pointing ? { filter: "drop-shadow(0 0 6px var(--signal))" } : undefined}
                onClick={() => run("point")}
              >
                <Crosshair size={12} />
              </IconButton>
            )}
            {appBar && (
              <IconButton label="Reload your app" className="size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void call((a) => a.reloadApp(), "Couldn't reload")}>
                <RotateCw size={11} />
              </IconButton>
            )}
            {!inspecting && (
              <IconButton label="Open your app in its own window (O)" className="size-5 opacity-60 group-hover:opacity-100 focus-visible:opacity-100" onClick={toggleAppWindow}>
                <SquareArrowOutUpRight size={11} />
              </IconButton>
            )}
          </div>
          <div className="relative min-h-0 overflow-hidden bg-void">
            {!detached && <webview key={partition} ref={ref} partition={partition} allowpopups={"true" as unknown as boolean /* React drops a boolean on an unknown attribute */} src="about:blank" className="absolute inset-0 h-full w-full" style={running && !noPage ? PAGE_CANVAS : undefined} />}
            {window.__shrikeMock && running && !noPage && <MockApp />}
            {running && !noPage && <PointLayer />}
            {running && noPage && <NoPage />}
            {(!running && (quest || status.state === "error")) || asking ? (
              <div className="absolute inset-0 overflow-y-auto bg-void p-3 pt-4">
                <StartQuest plan={quest} name={project?.name} legacy={status.state === "error" ? { error: status.error, output } : undefined} />
              </div>
            ) : !running && (
              <Idle state={status.state} output={output} />
            )}
            <InspectorPanel />
          </div>
        </section>
      </div>
    </>
  );
}

/** H16 (#62): a project with a dev command and a liveUrl moves the pane between the local run and the live site. */
function SideSwitch({ liveUrl }: { liveUrl: string }) {
  const side = useRun((s) => s.side);
  return (
    <span role="group" aria-label="Local or live" className="flex shrink-0 overflow-hidden rounded-[6px] border border-hair">
      {(["local", "live"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={side === s}
          className={cx("lbl px-1.5 py-[2px] transition-colors", side === s ? (s === "live" ? "bg-[color-mix(in_srgb,var(--slow)_14%,transparent)] text-slow" : "bg-[var(--glass)] text-ink") : "text-faint hover:text-ink")}
          title={s === "live" ? `Show your live site: ${liveUrl}` : "Show your local app"}
          onClick={() => void useRun.getState().setSide(s)}
        >
          {s === "live" ? "Live" : "Local"}
        </button>
      ))}
    </span>
  );
}

/** O1: a quiet hint while pointing, then the picked reticle (H8 corner brackets) for a moment. */
export function PointLayer() {
  const pointing = useUi((s) => s.pointing);
  const pick = useUi((s) => s.pick);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pick) return;
    setShown(true);
    const t = setTimeout(() => setShown(false), 1800);
    return () => clearTimeout(t);
  }, [pick]);

  const r = pick?.rect;
  const pad = 4;
  const box = r && { left: `calc(${(r.x / r.viewportWidth) * 100}% - ${pad}px)`, top: `calc(${(r.y / r.viewportHeight) * 100}% - ${pad}px)`, width: `calc(${(r.width / r.viewportWidth) * 100}% + ${pad * 2}px)`, height: `calc(${(r.height / r.viewportHeight) * 100}% + ${pad * 2}px)` };
  const corner = "absolute size-[9px] border-signal";
  return (
    <>
      {pointing && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <span className="glass rise flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] text-ink">
            <Crosshair size={11} className="text-signal" aria-hidden />
            Click anything to ask about it
            <span className="lbl text-dim">Esc cancels</span>
          </span>
        </div>
      )}
      {shown && box && (
        <div className="fade-in pointer-events-none absolute z-10" style={{ ...box, filter: "drop-shadow(0 0 6px var(--signal))" }} aria-hidden>
          <i className={`${corner} top-0 left-0 border-t border-l`} />
          <i className={`${corner} top-0 right-0 border-t border-r`} />
          <i className={`${corner} bottom-0 left-0 border-b border-l`} />
          <i className={`${corner} right-0 bottom-0 border-r border-b`} />
          <i className="absolute top-1/2 left-1/2 size-[5px] -translate-1/2 rounded-full bg-signal" />
        </div>
      )}
    </>
  );
}

/** D12: backend-only projects have nothing to show here. */
function NoPage() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-void p-6">
      <div className="flex max-w-[280px] flex-col items-center gap-3 text-center">
        <p className="font-display text-[15px] text-ink">This project has no web page.</p>
        <p className="text-[12.5px] text-dim">Send requests from the API explorer or curl.</p>
        <button type="button" className="btn mt-1" onClick={() => useUi.setState({ sheet: "api", file: null })}>
          Open the API explorer
          <span className="text-faint">A</span>
        </button>
      </div>
    </div>
  );
}

/** Before a start, and the old quick start's "starting" (it has no quest). Run is Claude's (R5). */
function Idle({ state, output }: { state: string; output: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-void p-6">
      {state === "starting" ? (
        <div className="flex w-full flex-col items-center gap-3 text-center">
          <span className="lbl flex items-center gap-2 text-signal">
            <Activity on tone="var(--signal)" label="Starting your app" />
          </span>
          {output && <pre className="w-full overflow-hidden font-mono text-[10.5px] leading-4 whitespace-pre-wrap text-faint">{lastLines(output, 5)}</pre>}
        </div>
      ) : (
        <div className="flex max-w-[300px] flex-col items-center gap-3 text-center">
          <p className="font-display text-[15px] text-ink">Press Run to start your app.</p>
          <p className="m-0 text-[12.5px] text-dim">Claude reads how this project starts, runs it here, fixes what fails and saves what worked as a skill.</p>
          <button type="button" className="btn mt-1" onClick={() => void startWithClaude()}>
            <Play size={9} className="fill-current" />
            Run
          </button>
        </div>
      )}
    </div>
  );
}
