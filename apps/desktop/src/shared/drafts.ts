// The post editor's working drafts (S5): one per post, on this Mac only, kept by the main
// process in the state folder (`drafts/<contentId>.draft`, 0600, written atomically). A draft is
// the canvas's Wecra document as a bundle (post-editor/wecra/bundle.ts) plus what it was made
// on. Writing one is cheap and never touches the API: versions are created only on ⌘S, approve,
// schedule, a chat message and closing the post (post-editor/wecra/session.ts).
//
// Also here: the flush handshake. Before the window closes or the app quits, the main process
// asks the page to write its drafts (`flushRequest`) and waits a moment for `flushDone`.

/** What a draft is of (everything but the document's bytes). */
export interface DraftMeta {
  contentId: string;
  /** The version the canvas document was made on. */
  baseVersion: number;
  baseVersionId: string | null;
  /** When the draft was written (ms since the epoch). */
  savedAt: number;
  /** The base document's hash (session.ts `documentHash`): the draft equals it → nothing to keep. */
  baseHash: string | null;
  /** The draft document's hash (null: written in a hurry, e.g. while the page unloads). */
  docHash: string | null;
}

export interface Draft extends DraftMeta {
  /** The document as a Wecra bundle (zip). */
  bundle: Uint8Array;
}

/** The largest draft kept (a bundle with pictures not yet uploaded). */
export const MAX_DRAFT_BYTES = 256 * 1024 * 1024;

/** A post id usable as a file name (the API's ids; nothing that walks out of the folder). */
export const DRAFT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface DraftsBridge {
  /** Replaces the post's draft. */
  save(draft: Draft): Promise<void>;
  /** The same, blocking (only while the page unloads: a reload). */
  saveSync?(draft: Draft): boolean;
  load(contentId: string): Promise<Draft | null>;
  remove(contentId: string): Promise<void>;
}

export interface LifecycleBridge {
  /** The window is closing or the app quits: write what is unsaved, then call `flushDone(id)`. */
  onFlushRequest(listener: (id: number) => void): () => void;
  flushDone(id: number): void;
}

export const DRAFTS_IPC = {
  save: "drafts:save",
  saveSync: "drafts:save-sync",
  load: "drafts:load",
  remove: "drafts:remove",
  flushRequest: "lifecycle:flush-request",
  flushDone: "lifecycle:flush-done",
} as const;
