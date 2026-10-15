import { useState, type CSSProperties } from "react";
import { BookOpen, Ellipsis, GitPullRequest, LogOut, Palette, Play, Route, Settings, Share2, Square } from "lucide-react";
import { isLiveSite, useProject } from "../stores/project.ts";
import { useRun } from "../stores/run.ts";
import { useAgent } from "../stores/agent.ts";
import { useThread } from "../stores/thread.ts";
import { toast, useUi } from "../stores/ui.ts";
import { call } from "../lib/api.ts";
import { cx, IconButton } from "../components/ui.tsx";
import { Dot, Elapsed } from "../components/Activity.tsx";
import { openIssue, run, tidyUp } from "./commands.ts";
import { fuel } from "./logic.ts";
import { Rec } from "./Rec.tsx";
import { useAskDrop } from "../composer/index.ts";
import { Appearance, useTheme } from "../themes/index.ts";
import { AskFuelRing } from "./Agent.tsx";
import { VoiceOrb } from "../voice/index.ts";
import { XpChip } from "../progress/Profile.tsx";
import { Flag } from "lucide-react"; // quests: QB
import { useQuests } from "../quests/store.ts";
import { isMac, keys } from "../lib/platform.ts";

export function Wordmark({ size = 12 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      SHRIKE
    </span>
  );
}

function RunState() {
  const status = useRun((s) => s.status);
  const [busy, setBusy] = useState(false);
  const state = status.state;
  const live = state === "running";

  const starting = state === "starting";
  return (
    <button
      type="button"
      className={cx("btn", state === "error" && "text-fail")}
      disabled={busy || starting}
      title={state === "error" ? `Didn't start${status.error ? `: ${status.error}` : ""}` : live ? "Your app is live" : undefined}
      onClick={async () => {
        setBusy(true);
        await (live ? useRun.getState().stop() : useRun.getState().start());
        setBusy(false);
      }}
    >
      {starting ? <Dot on tone="var(--slow)" /> : live ? <Square size={9} className="fill-current" /> : <Play size={9} className="fill-current" />}
      {live ? "Stop" : starting ? "Starting" : "Run"}
      <Elapsed on={starting} />
    </button>
  );
}

/** Left: wordmark, project, run state. Right: More, Time, Rec, voice, Ask. */
export function TopBar() {
  const project = useProject((s) => s.project);
  const timeMode = useThread((s) => s.timeMode);
  const agentBusy = useAgent((s) => s.run?.status === "running");
  const focused = useThread((s) => s.focus.actionId);
  const drop = useAskDrop();
  const full = useAgent((s) => fuel(s.usage) > 0.8);
  const liveSide = useRun((s) => s.side === "live");

  return (
    <header className={cx("drag flex h-11 shrink-0 items-center gap-[14px] border-b border-hair max-xl:gap-2.5", isMac ? "pr-1.5 pl-[84px]" : "pr-[calc(100%-env(titlebar-area-width,100%)+6px)] pl-3")}>
      {/* Under xl the wordmark goes and the gaps tighten, so a quest result chip never pushes Ask off. */}
      <span className="contents max-xl:hidden">
        <Wordmark />
      </span>
      <span className="max-w-[220px] min-w-0 shrink-0 truncate text-[13px] font-medium text-ink max-xl:shrink" title={project?.root}>
        {project?.name}
      </span>
      {/* H15 live badge (#54), also on the Live side of a local project (#62) */}
      {project?.liveUrl && (isLiveSite(project) || liveSide) && (
        <span className="lbl shrink-0 rounded-[6px] border border-slow px-1.5 py-[3px] text-slow" title={`Live site: ${project.liveUrl}${project.liveUrl.startsWith("http:") ? " (not secure)" : ""}`}>
          Live
        </span>
      )}
      <XpChip />
      <RunState />
      <IconButton label="Set up processes" onClick={() => useUi.setState({ setup: true })}>
        <Settings size={13} />
      </IconButton>
      <IconButton label="Appearance" onClick={() => useTheme.getState().setOpen(true)}>
        <Palette size={13} />
      </IconButton>
      <Appearance />
      <div className="flex-1" />
      <More />
      <button type="button" className={cx("btn", timeMode && "on")} aria-pressed={timeMode} onClick={() => run("time")} title="Time view (T)">
        Time
      </button>
      {focused && (
        <IconButton label="Write this trip up as an issue" onClick={() => openIssue(focused)}>
          <Share2 size={13} />
        </IconButton>
      )}
      <Rec />
      {full && (
        <button type="button" className="btn fade-in" style={{ borderColor: "var(--slow)", color: "var(--slow)" }} title="Your agent's memory is almost full. Start fresh with a short summary." onClick={() => void tidyUp()}>
          Tidy up the agent's memory
        </button>
      )}
      <span className="flex shrink-0">
        {isMac && <VoiceOrb />}
      </span>
      <button
        type="button"
        className="btn"
        onClick={() => run("ask")}
        title={keys("Ask your agent (⌘K). Drop a step, log line or file here.")}
        style={drop.over ? { borderColor: "var(--violet)", boxShadow: "0 0 18px color-mix(in srgb, var(--violet) 45%, transparent)" } : agentBusy ? { borderColor: "var(--violet)", boxShadow: "inset 0 0 0 1px var(--violet)" } : undefined}
        {...drop.props}
      >
        <AskFuelRing>
          <span className="text-violet" aria-hidden>
            ✦
          </span>
        </AskFuelRing>
        Ask
        <Elapsed on={agentBusy} />
      </button>
    </header>
  );
}

/** The panels that have a key, behind one button (the Changes tab lives on the dock rail). */
function More() {
  const items = [
    { label: "Skills", key: "K", icon: <BookOpen size={13} />, go: () => run("skills") },
    { label: "Flows", key: "W", icon: <Route size={13} />, go: () => run("flows") },
    { label: "Quests", key: "Q", icon: <Flag size={13} />, go: () => useQuests.getState().setOpen(!useQuests.getState().open) },
    { label: "Ship", key: "S", icon: <GitPullRequest size={13} />, go: () => run("ship") },
  ];
  const live = useProject((s) => isLiveSite(s.project)); // LV2 (#55)
  return (
    <>
      <IconButton label="More" popoverTarget="topbar-more" style={{ anchorName: "--topbar-more" } as CSSProperties}>
        <Ellipsis size={14} />
      </IconButton>
      <div id="topbar-more" popover="auto" className="topbar-menu glass solid">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className="hud-btn w-full"
            aria-label={`${it.label} (${it.key})`}
            onClick={(e) => (e.currentTarget.parentElement?.hidePopover(), it.go())}
          >
            {it.icon}
            {it.label}
            <kbd className="ml-auto pl-4 font-mono text-[11px] text-faint">{it.key}</kbd>
          </button>
        ))}
        {live && (
          <button
            type="button"
            className="hud-btn w-full"
            onClick={(e) => (e.currentTarget.parentElement?.hidePopover(), void call((a) => a.signOutLive().then(() => true), "Couldn't sign out").then((ok) => ok && toast("Signed out of your live site.", "ok")))}
          >
            <LogOut size={13} />
            Sign out of your live site
          </button>
        )}
      </div>
    </>
  );
}
