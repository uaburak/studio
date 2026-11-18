import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/shell/app-shell.tsx";
import { isElectron } from "./lib/bridge.ts";
import { useAppStore } from "./state/app-store.ts";
import { StudioProvider } from "./state/studio.tsx";

const root = document.documentElement;
if (isElectron()) root.dataset.electron = "";

// `?theme=dark|light` forces a theme (headless checks); otherwise the system / app setting
// decides through prefers-color-scheme (main sets nativeTheme.themeSource).
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "dark" || theme === "light") root.dataset.theme = theme;
if (window.location.hash === "#/gallery" || params.get("route") === "gallery") {
  queueMicrotask(() => useAppStore.getState().navigate({ kind: "gallery" }));
}

const container = document.getElementById("root");
if (container && params.get("demo") === "post-editor") {
  // The canvas post editor on a demo post, no host needed (headless checks).
  void import("./features/post-editor/demo/demo.tsx").then(({ PostEditorDemo }) =>
    createRoot(container).render(
      <StrictMode>
        <PostEditorDemo />
      </StrictMode>,
    ),
  );
} else if (container) {
  createRoot(container).render(
    <StrictMode>
      <StudioProvider>
        <AppShell />
      </StudioProvider>
    </StrictMode>,
  );
}
