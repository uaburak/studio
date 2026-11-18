// What must be written before the page goes (E14): the open post's canvas draft. The window
// closing and ⌘Q ask through the main process (`lifecycle.onFlushRequest`, answered with
// `flushDone` — the main process waits a moment at most); a reload only gets `beforeunload`, so
// each writer also has a blocking variant for it.

export interface AppFlushWriter {
  /** Writes what is unsaved (the window closes / the app quits after it, or after a short wait). */
  flush(): Promise<void>;
  /** The same without waiting (the page is unloading: a reload). */
  flushSync(): void;
}

const writers = new Set<AppFlushWriter>();

export function registerAppFlush(writer: AppFlushWriter): () => void {
  writers.add(writer);
  return () => writers.delete(writer);
}

export async function flushApp(): Promise<void> {
  await Promise.allSettled([...writers].map((w) => w.flush()));
}

export function flushAppSync(): void {
  for (const w of writers) {
    try {
      w.flushSync();
    } catch {
      // The page goes anyway; the other writers still run.
    }
  }
}

/** Answers the main process's flush requests and writes on unload (mounted once, by the shell). */
export function installAppFlush(
  lifecycle: {
    onFlushRequest(listener: (id: number) => void): () => void;
    flushDone(id: number): void;
  } | null,
): () => void {
  const off = lifecycle?.onFlushRequest((id) => {
    void flushApp().finally(() => lifecycle.flushDone(id));
  });
  const onUnload = () => flushAppSync();
  window.addEventListener("beforeunload", onUnload);
  return () => {
    off?.();
    window.removeEventListener("beforeunload", onUnload);
  };
}
