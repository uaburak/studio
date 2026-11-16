// Test helpers for @studio/publishers and its consumers (e.g. the scheduler).
// Import from "@studio/publishers/testing"; never ship this into a Worker bundle.

import type { MediaReader } from "../models.ts";
import { type CreatePublisherOptions, createPublisher } from "../publisher.ts";
import { FakeClock, FakeGraph, type FakeGraphOptions } from "./fake-graph.ts";

export * from "./fake-graph.ts";

/** In-memory MediaReader over named byte arrays. */
export function memoryMediaReader(
  files: Record<string, Uint8Array>,
): MediaReader & { reads: { key: string; offset: number; length?: number }[] } {
  const reads: { key: string; offset: number; length?: number }[] = [];
  return {
    reads,
    async read(key, range) {
      reads.push({ key, ...range });
      const file = files[key];
      if (!file) throw new Error(`no such media: ${key}`);
      const end = range.length === undefined ? file.length : range.offset + range.length;
      return file.slice(range.offset, end);
    },
  };
}

export interface FakeEnvOptions extends FakeGraphOptions {
  publisher?: Omit<CreatePublisherOptions, "fetch" | "clock" | "sleep">;
}

/**
 * A fake Graph API wired to a publisher with a shared fake clock:
 * sleeping advances time instantly, so polling and backoff cost nothing.
 */
export function createFakeEnv(options: FakeEnvOptions = {}) {
  const clock = options.clock ?? new FakeClock();
  const fake = new FakeGraph({ ...options, clock });
  const publisher = createPublisher({
    ...options.publisher,
    fetch: fake.fetch,
    clock,
    sleep: clock.sleep,
    random: () => 0.5,
  });
  return { clock, fake, publisher };
}
