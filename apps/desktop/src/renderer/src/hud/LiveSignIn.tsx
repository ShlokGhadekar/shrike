import { useEffect, useState } from "react";
import type { ShrikeEvents } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { toast } from "../stores/ui.ts";

type Ask = ShrikeEvents["live:login"];

/** LV1 (#55): a page in the app pane asked for a username and password (basic auth). Plain messages about the page arrive as toasts. */
export function LiveSignIn() {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const ask = asks[0];

  useEffect(() => {
    const a = api();
    const offs = [a.on("live:login", (q) => setAsks((l) => [...l, q])), a.on("live:notice", (text) => toast(text, "error"))];
    return () => offs.forEach((off) => off());
  }, []);

  if (!ask) return null;
  const answer = (signIn: boolean) => {
    void api().answerLiveLogin(ask.id, signIn ? { username, password } : null).catch(() => {});
    setPassword("");
    setAsks((l) => l.slice(1));
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--void)_60%,transparent)] p-6">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={`Sign in to ${ask.host}`}
        className="glass solid rise flex w-[min(380px,100%)] flex-col gap-3 rounded-[var(--r-card)] px-5 py-4 shadow-[0_24px_80px_var(--void)]"
        onSubmit={(e) => (e.preventDefault(), answer(true))}
        onKeyDown={(e) => e.key === "Escape" && answer(false)}
      >
        <h2 className="m-0 font-display text-[18px] font-light tracking-[0.04em] text-ink uppercase">Sign in to {ask.host}</h2>
        <p className="m-0 text-[12.5px] text-dim">{ask.realm ? `It says: "${ask.realm}". ` : ""}Shrike passes this to the page and forgets it when you quit. It's never saved.</p>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Username</span>
          <input autoFocus className="field" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="lbl">Password</span>
          <input type="password" className="field" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn" onClick={() => answer(false)}>
            Cancel
          </button>
          <button type="submit" className="btn go">
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
