// One open canvas editor: the draft (working copy + saves), the canvas (engine + frames) and
// the pieces that keep them in step with the post (PostEditor: versions, approval, AI).
import type { ContentVersion } from "@studio/contract";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  activeVersion,
  type EditorSnapshot,
  editBlocker,
  type PostEditor,
} from "../post-detail/editor.ts";
import { type CanvasState, PostCanvas } from "./canvas/controller.ts";
import type { RenderKit } from "./model/brand-kit.ts";
import { DraftSession, type DraftSnapshot } from "./model/draft.ts";
import { presetFor, type SafeAreaView, safeAreaView } from "./model/safe-areas.ts";

export interface Toast {
  id: number;
  message: string;
  tone: "error" | "notice";
}

function slidesOf(version: ContentVersion | null) {
  return (version?.slides ?? []).map((s) => ({ html: s.html, width: s.width, height: s.height }));
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function accentColor(): string {
  if (typeof document === "undefined") return "#ff6a00";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent-default").trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : "#ff6a00";
}

export interface EditorSession {
  draft: DraftSession;
  draftState: DraftSnapshot;
  canvas: PostCanvas;
  canvasState: CanvasState;
  toasts: Toast[];
  notify(message: string, tone?: Toast["tone"]): void;
  dismiss(id: number): void;
  preset: string | null;
  setPreset(id: string | null): void;
  safeArea(slide: number): SafeAreaView | null;
}

export function useEditorSession(
  editor: PostEditor,
  snapshot: EditorSnapshot,
  kit: RenderKit,
  options: { autosaveMs?: number } = {},
): EditorSession {
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const kitRef = useRef(kit);
  kitRef.current = kit;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [preset, setPreset] = useState<string | null>(null);
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const nextToast = useRef(1);

  const notify = (message: string, tone: Toast["tone"] = "notice") => {
    const id = nextToast.current++;
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    setTimeout(
      () => setToasts((list) => list.filter((t) => t.id !== id)),
      tone === "error" ? 7000 : 4000,
    );
  };
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const safeArea = (slide: number): SafeAreaView | null => {
    const s = snapRef.current;
    const version = activeVersion(s);
    const size = version?.slides[slide] ?? version?.slides[0];
    if (!size) return null;
    const p = presetFor(s.content.type, s.content.targetPlatforms, size, presetRef.current);
    return p ? safeAreaView(p) : null;
  };
  const safeAreaRef = useRef(safeArea);
  safeAreaRef.current = safeArea;

  const [draft] = useState(() => {
    const version = activeVersion(snapshot);
    return new DraftSession(
      { commit: (patches, name, note) => editor.commitPatches(patches, name, note) },
      { version: version?.version ?? null, slides: slidesOf(version) },
      kit.ctx,
      {
        ...(options.autosaveMs !== undefined ? { autosaveMs: options.autosaveMs } : {}),
        storage: storage(),
        storageKey: `studio.post-editor.draft.${snapshot.content.id}`,
      },
    );
  });

  const [canvas] = useState(
    () =>
      new PostCanvas({
        draft,
        kit: () => kitRef.current,
        fallback: () => (activeVersion(snapRef.current)?.slides ?? []).map((s) => s.layers),
        safeArea: (i) => safeAreaRef.current(i),
        notify: (m, t) => notifyRef.current(m, t),
        accent: accentColor,
        blocker: () => editBlocker(snapRef.current),
        storage: storage(),
        storageKey: `studio.post-editor.${snapshot.content.id}`,
      }),
  );

  const draftState = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const canvasState = useSyncExternalStore(canvas.subscribe, canvas.getSnapshot);

  // Brand tokens decide which colour / font tokens a patch may use.
  useEffect(() => draft.setContext(kit.ctx), [draft, kit]);

  // Unsaved edits a closed window left: back on top of the same version.
  useEffect(() => {
    if (draft.recover()) notifyRef.current("Kaydedilmemiş değişiklikler geri yüklendi.");
  }, [draft]);

  // A version from elsewhere (AI, restore, chat, another device) becomes the base.
  const shown = activeVersion(snapshot);
  useEffect(() => {
    if (!shown) return;
    const s = draft.getSnapshot();
    if (
      s.baseVersion === shown.version &&
      !draft.dirty &&
      s.slides.every((sl, i) => sl.html === shown.slides[i]?.html)
    )
      return;
    if (s.inflight) return;
    if (!draft.rebase({ version: shown.version, slides: slidesOf(shown) }))
      notifyRef.current("Kaydedilmemiş değişiklikler yeni sürüme uymadı ve bırakıldı.", "error");
  }, [draft, shown]);

  // The kit (brand.css) arrived or changed: the frames reload with it.
  useEffect(() => {
    canvas.refreshKit();
  }, [canvas, kit]);
  useEffect(() => {
    canvas.updateSafeAreas();
  }, [canvas, preset]);

  useEffect(
    () => () => {
      void draft.flush();
      draft.dispose();
    },
    [draft],
  );

  useEffect(() => {
    const s = draftState.saveError;
    if (s) notifyRef.current(`Kaydedilemedi: ${s}`, "error");
  }, [draftState.saveError]);

  return useMemo(
    () => ({
      draft,
      draftState,
      canvas,
      canvasState,
      toasts,
      notify,
      dismiss: (id: number) => setToasts((list) => list.filter((t) => t.id !== id)),
      preset,
      setPreset,
      safeArea,
    }),
    [draft, draftState, canvas, canvasState, toasts, preset],
  );
}
