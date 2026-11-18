/**
 * The waits of one chat turn (U1, U6): while a tool holds its call for the owner (consent card,
 * `ask_user`) or for other jobs (`wait_jobs`), the model is not working. During such a wait
 * - the turn's timeout clock stops (`startTurnTimer`): the 15-minute cap counts the model's own
 *   work only, so a 10-minute question or a 15-minute `wait_jobs` never ends the turn;
 * - the turn gives its Claude gate slot back (`ClaudeGate`), so two conversations waiting for an
 *   answer do not block the generation jobs; the slot is taken again before the tool returns.
 * Nested / parallel waits count once (from the first start to the last end).
 */

export interface TurnWaitListener {
  /** The first wait started (the model is idle now). */
  start?: () => void | Promise<void>;
  /** The last wait ended; the tool returns to the model once this resolves. */
  end?: () => void | Promise<void>;
}

export class TurnWaits {
  private depth = 0;
  private readonly listeners = new Set<TurnWaitListener>();

  /** True while at least one wait runs. */
  get waiting(): boolean {
    return this.depth > 0;
  }

  /** Run `fn` as a wait (the clock stops, the gate slot is free). */
  async around<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth++ === 0) await this.emit("start");
    try {
      return await fn();
    } finally {
      if (--this.depth === 0) await this.emit("end");
    }
  }

  on(listener: TurnWaitListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async emit(kind: "start" | "end"): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener[kind]?.();
    }
  }
}

export interface TurnTimer {
  /** Stop the timer for good. */
  cancel(): void;
  /** Milliseconds of active (non-waiting) time left. */
  remaining(): number;
}

/**
 * Calls `onTimeout` after `timeoutMs` of active time: the time spent in `waits` does not count.
 * Without `waits` it is a plain timer.
 */
export function startTurnTimer(input: {
  timeoutMs: number;
  waits?: TurnWaits | undefined;
  onTimeout: () => void;
  now?: () => number;
}): TurnTimer {
  const now = input.now ?? Date.now;
  let left = Math.max(0, input.timeoutMs);
  let startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const arm = () => {
    clearTimeout(timer);
    startedAt = now();
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe?.();
      input.onTimeout();
    }, left);
    timer.unref?.();
  };
  const pause = () => {
    if (done || timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    left = Math.max(0, left - (now() - startedAt));
  };
  const resume = () => {
    if (done || timer !== undefined) return;
    arm();
  };

  const unsubscribe = input.waits?.on({ start: pause, end: resume });
  if (input.waits?.waiting) {
    // Started inside a wait: count from its end.
    timer = undefined;
  } else {
    arm();
  }
  return {
    cancel() {
      done = true;
      clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
    },
    remaining() {
      return timer === undefined ? left : Math.max(0, left - (now() - startedAt));
    },
  };
}
