import { useEffect, useState } from "react";
import { connectBridge, hydrate } from "./stores/bridge.ts";
import { useProject } from "./stores/project.ts";
import { Welcome } from "./hud/Welcome.tsx";
import { Frame, Shell } from "./hud/Shell.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { LiveSignIn } from "./hud/LiveSignIn.tsx";
import { Spinner } from "./components/ui.tsx";

export function App() {
  const project = useProject((s) => s.project);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const off = connectBridge();
    void hydrate().finally(() => setReady(true));
    return off;
  }, []);

  return (
    <>
      {!ready ? (
        <Frame>
          <div className="drag flex h-full items-center justify-center text-dim">
            <Spinner size={14} />
          </div>
        </Frame>
      ) : project ? (
        <Shell key={project.root} />
      ) : (
        <Welcome />
      )}
      <Toasts />
      <LiveSignIn />
    </>
  );
}
