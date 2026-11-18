// Wecra's editor in Studio's layout. Wecra's own EditorApp runs the canvas — the engine, its
// keyboard, clipboard, context menu, dialogs and overlays, exactly as in Wecra — inside the
// centre column; its rail, panels and toolbar are left out (embed.ts) and Wecra's own components
// are drawn in Studio's places instead, on the same editor (EditorContext):
//
//   WecraDesignPanel   Wecra's Design panel (DesignPanel) in Studio's right panel
//   WecraLayers        Wecra's Layers panel in the canvas's layers card
//   WecraToolbar       Wecra's bottom toolbar (its tools, no mode switch) in Studio's dock
//   WecraZoomMenu      Wecra's zoom menu (the Design tab row's) in the panel header
//
// Nothing here re-implements Wecra: these are Wecra's components with Studio's colours and radii
// (wecra.css). The vendored copy is gitignored (scripts/vendor-wecra.mjs).
import "./embed.ts";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ReturnFocusProvider } from "@/ds";
import { BottomToolbar } from "@/editor/canvas/BottomToolbar";
import { EditorContext, type EditorController } from "@/editor/controller";
import type { DocumentSource } from "@/editor/documentSource";
import { EditorApp } from "@/editor/EditorApp";
import { DesignPanel } from "@/editor/panels/design/DesignPanel";
import { designPanelTab } from "@/editor/panels/design/tabOrder";
import { Layers } from "@/editor/panels/Layers";
import panelStyles from "@/editor/panels/Panels.module.css";
import { ZoomMenu } from "@/editor/panels/RightPanel";
import { applyLocale } from "@/i18n";
import { WECRA_OVERLAYS, WECRA_REGION } from "./embed.ts";

// Studio is Turkish: Wecra's own Turkish dictionary (loaded once, before the editor's first render).
const locale = applyLocale("tr").catch(() => {});

/** Studio's theme as it is now: forced on <html data-theme>, else the system's (Ayarlar sets it). */
function studioTheme(): "light" | "dark" {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribeTheme(cb: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", cb);
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    media.removeEventListener("change", cb);
    observer.disconnect();
  };
}

/** Studio's resolved theme; Wecra's overlay root follows it (its menus inherit from there). */
export function useStudioTheme(): "light" | "dark" {
  const theme = useSyncExternalStore(subscribeTheme, studioTheme, () => "light" as const);
  useEffect(() => {
    let root = document.getElementById(WECRA_OVERLAYS);
    if (!root) {
      root = document.createElement("div");
      root.id = WECRA_OVERLAYS;
      document.body.appendChild(root);
    }
    root.dataset.theme = theme;
    // Wecra's theme preference follows Studio's (its canvas colours, its own theme reads).
    try {
      localStorage.setItem("designer-theme", theme);
    } catch {
      // this page only
    }
    window.dispatchEvent(new Event("designer-theme-change"));
  }, [theme]);
  return theme;
}

const WecraContext = createContext<EditorController | null>(null);

/** The open post's Wecra editor (null until it is up). */
export const useWecraEditor = () => useContext(WecraContext);

/** One of the editor's places: keys and the clipboard there are Wecra's, its colours Studio's. */
export function WecraRegion({
  name,
  className,
  style,
  children,
  ...rest
}: {
  name: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const theme = useStudioTheme();
  return (
    <div
      {...{ [WECRA_REGION]: name }}
      data-theme={theme}
      className={className}
      style={style}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Wecra's components below work on `ed` (its EditorContext), focus going back to its canvas. */
export function WecraScope({ ed, children }: { ed: EditorController; children: ReactNode }) {
  const focusCanvas = useCallback(() => ed.focusCanvas(), [ed]);
  return (
    <EditorContext.Provider value={ed}>
      <ReturnFocusProvider value={focusCanvas}>{children}</ReturnFocusProvider>
    </EditorContext.Provider>
  );
}

/**
 * The canvas: Wecra's EditorApp on `source`, filling its parent (the centre column). `children`
 * (Studio's panels and dock, portalled or not) get the editor once it is up.
 */
export function WecraEditor({
  source,
  onReady,
  insets,
  children,
}: {
  source: DocumentSource;
  onReady?: (ed: EditorController) => void;
  /** What Studio's cards and dock cover of the canvas (zoom to fit keeps clear of it). */
  insets?: { left?: number; bottom?: number };
  children?: ReactNode;
}) {
  const [ed, setEd] = useState<EditorController | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void locale.then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  const ready_ = useCallback(
    (editor: EditorController) => {
      setEd(editor);
      onReady?.(editor);
    },
    [onReady],
  );
  // A new document is a new editor.
  useEffect(() => () => setEd(null), [source]);
  return (
    <WecraContext.Provider value={ed}>
      <WecraRegion
        name="canvas"
        className="wecra-canvas absolute inset-0"
        style={{
          ["--wecra-inset-left" as string]: `${insets?.left ?? 0}px`,
          ["--wecra-inset-bottom" as string]: `${insets?.bottom ?? 0}px`,
        }}
      >
        {ready && <EditorApp source={source} onReady={ready_} initialView="fit" />}
      </WecraRegion>
      {ed ? <WecraScope ed={ed}>{children}</WecraScope> : null}
    </WecraContext.Provider>
  );
}

/** Wecra's Design panel (the Design tab's sections, by selection), scrolling in its container. */
export function WecraDesignPanel({ className }: { className?: string }) {
  return (
    <WecraRegion
      name="design"
      data-panel="right"
      className={`${panelStyles.rightBody ?? ""} wecra-design ${className ?? ""}`}
    >
      {/* Tab / ⇧Tab go through the panel's fields in Wecra's order. */}
      <div className="contents" onKeyDownCapture={designPanelTab}>
        <DesignPanel />
      </div>
    </WecraRegion>
  );
}

/** Wecra's Layers panel (its header, the tree, drag to reorder, rename, eye, lock). */
export function WecraLayers({ width, className }: { width: number; className?: string }) {
  return (
    <WecraRegion
      name="layers"
      data-panel="left"
      className={`wecra-layers ${className ?? ""}`}
      style={{ ["--left-panel-width" as string]: `${width}px`, width }}
    >
      <Layers />
    </WecraRegion>
  );
}

/** Wecra's bottom toolbar's tools (Move ▾, Region ▾, Shape ▾, Creation ▾, Text ▾), in flow. */
export function WecraToolbar() {
  return (
    <WecraRegion name="toolbar" className="wecra-toolbar">
      <BottomToolbar embedded />
    </WecraRegion>
  );
}

/** Wecra's zoom menu ("100% ⌄": zoom, pixel preview, rulers, outlines …). */
export function WecraZoomMenu() {
  return (
    <WecraRegion name="zoom" className="wecra-zoom">
      <ZoomMenu />
    </WecraRegion>
  );
}
