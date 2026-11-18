// Before the window closes or the app quits (⌘Q, the red button, ⌘W), the page is asked to write
// what is unsaved (the post editor's draft, shared/drafts.ts) and given a short moment to say it
// is done. A page that does not answer (busy, crashed, no post open: it answers at once) never
// holds the quit up for longer than `timeoutMs`.

export interface FlushDeps {
  /** Asks the page (`id`); false when there is no page to ask. */
  send(id: number): boolean;
  /** The page's answers. */
  onDone(listener: (id: number) => void): () => void;
  timeoutMs?: number;
}

export type FlushOutcome = "done" | "timeout" | "no-window";

export class RendererFlush {
  private seq = 0;
  private running: Promise<FlushOutcome> | null = null;

  constructor(private readonly deps: FlushDeps) {}

  /** One flush at a time: a second request while one runs waits for the same answer. */
  run(): Promise<FlushOutcome> {
    if (this.running) return this.running;
    const id = ++this.seq;
    this.running = new Promise<FlushOutcome>((resolve) => {
      let off: (() => void) | null = null;
      const finish = (outcome: FlushOutcome) => {
        clearTimeout(timer);
        off?.();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish("timeout"), this.deps.timeoutMs ?? 2000);
      off = this.deps.onDone((done) => {
        if (done === id) finish("done");
      });
      if (!this.deps.send(id)) finish("no-window");
    }).finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
