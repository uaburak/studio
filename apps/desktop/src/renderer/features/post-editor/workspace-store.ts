// UI state of the post workspace (the canvas in the centre column, the post's panel on the
// right): which mode the floating dock and the right panel are in (Sohbet / Düzenle, remembered
// per post on this Mac), the edit panel's tab, whether the sidebar's layers are unfolded, the conversation each
// post's Sohbet continues, and which post the workspace shows right now.
import type { Content } from "@studio/contract";
import { create } from "zustand";

export type WorkspaceMode = "chat" | "edit";
export type EditTab = "design" | "caption";

/** A post opens on Düzenle until it was left on Sohbet. */
export const DEFAULT_MODE: WorkspaceMode = "edit";

const MODES_KEY = "studio.post-workspace.modes";
const CHATS_KEY = "studio.post-workspace.chats";
const LAYERS_KEY = "studio.post-workspace.layers-open";
/** Remembered posts (oldest forgotten first). */
const MEMORY_LIMIT = 300;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readRecord<T extends string>(
  key: string,
  valid: (v: unknown) => v is T,
): Record<string, T> {
  try {
    const raw = storage()?.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(parsed)) if (valid(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeRecord(key: string, value: Record<string, string>): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the memory lasts for this window only.
  }
}

/** `record` with `id` set last (insertion order = recency), capped at MEMORY_LIMIT. */
function remember<T>(record: Record<string, T>, id: string, value: T): Record<string, T> {
  const { [id]: _, ...rest } = record;
  const entries = Object.entries(rest);
  return Object.fromEntries([...entries.slice(-(MEMORY_LIMIT - 1)), [id, value]]);
}

const isMode = (v: unknown): v is WorkspaceMode => v === "chat" || v === "edit";
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function readLayersOpen(): boolean {
  try {
    return storage()?.getItem(LAYERS_KEY) !== "0";
  } catch {
    return true;
  }
}

interface WorkspaceState {
  modes: Record<string, WorkspaceMode>;
  /** Post id → the conversation its Sohbet continues. */
  chats: Record<string, string>;
  /** The sidebar's "Katmanlar" unfolded (remembered on this Mac). */
  layersOpen: boolean;
  editTab: EditTab;
  /** The post the workspace shows (set while it is mounted). */
  active: string | null;

  setMode(postId: string, mode: WorkspaceMode): void;
  setChat(postId: string, conversationId: string): void;
  forgetChat(postId: string): void;
  setLayersOpen(open: boolean): void;
  setEditTab(tab: EditTab): void;
  setActive(postId: string | null): void;
  /** Re-reads what this Mac remembers (tests, another window). */
  reload(): void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  modes: readRecord(MODES_KEY, isMode),
  chats: readRecord(CHATS_KEY, isId),
  layersOpen: readLayersOpen(),
  editTab: "design",
  active: null,

  setMode(postId, mode) {
    if (get().modes[postId] === mode) return;
    const modes = remember(get().modes, postId, mode);
    set({ modes });
    writeRecord(MODES_KEY, modes);
  },
  setChat(postId, conversationId) {
    const chats = remember(get().chats, postId, conversationId);
    set({ chats });
    writeRecord(CHATS_KEY, chats);
  },
  forgetChat(postId) {
    const { [postId]: _, ...chats } = get().chats;
    set({ chats });
    writeRecord(CHATS_KEY, chats);
  },
  setLayersOpen(layersOpen) {
    set({ layersOpen });
    try {
      storage()?.setItem(LAYERS_KEY, layersOpen ? "1" : "0");
    } catch {
      // ignore
    }
  },
  setEditTab(editTab) {
    set({ editTab });
  },
  setActive(active) {
    if (get().active !== active) set({ active });
  },
  reload() {
    set({
      modes: readRecord(MODES_KEY, isMode),
      chats: readRecord(CHATS_KEY, isId),
      layersOpen: readLayersOpen(),
    });
  },
}));

/** The mode a post opens in: the last one used for it on this Mac, else Düzenle. */
export function modeOf(state: Pick<WorkspaceState, "modes">, postId: string): WorkspaceMode {
  return state.modes[postId] ?? DEFAULT_MODE;
}

/**
 * How an opened post is shown: posts with slides open straight into the canvas workspace
 * (the centre column becomes the canvas); reels keep the post detail (they are edited in chat).
 */
export function openedView(content: Pick<Content, "type">): "canvas" | "detail" {
  return content.type === "reel" ? "detail" : "canvas";
}
