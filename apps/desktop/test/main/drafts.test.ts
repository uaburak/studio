// The post editor's working drafts on disk (one per post, 0600, atomic) and the flush the main
// process asks of the page before the window closes or the app quits (E14).
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DraftStore, validDraft } from "../../src/main/drafts.ts";
import { RendererFlush } from "../../src/main/flush.ts";
import type { Draft } from "../../src/shared/drafts.ts";

const draft = (over: Partial<Draft> = {}): Draft => ({
  contentId: "p1",
  baseVersion: 3,
  baseVersionId: "v3",
  savedAt: 1_700_000_000_000,
  baseHash: "a".repeat(64),
  docHash: "b".repeat(64),
  bundle: new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]),
  ...over,
});

const folder = () => join(mkdtempSync(join(tmpdir(), "studio-drafts-")), "drafts");

describe("draft store", () => {
  it("keeps one draft per post, readable only by this user, and reads it back", () => {
    const dir = folder();
    const store = new DraftStore(dir);
    store.save(draft());
    expect(store.load("p1")).toEqual(draft());
    expect(statSync(join(dir, "p1.draft")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // A newer draft replaces it (no second file, no temporary left behind).
    store.save(draft({ baseVersion: 4, bundle: new Uint8Array([1, 2, 3]) }));
    expect(store.load("p1")).toMatchObject({ baseVersion: 4, bundle: new Uint8Array([1, 2, 3]) });
    expect(readdirSync(dir)).toEqual(["p1.draft"]);
    store.remove("p1");
    expect(store.load("p1")).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses ids that leave the folder, empty or broken drafts; a broken file is no draft", () => {
    const dir = folder();
    const store = new DraftStore(dir);
    expect(() => store.save(draft({ contentId: "../x" }))).toThrow();
    expect(() => store.save({ ...draft(), bundle: new Uint8Array() })).toThrow();
    expect(() => store.save({ ...draft(), bundle: "zip" })).toThrow();
    expect(validDraft({ ...draft(), baseVersion: "3" })).toBeNull();
    expect(store.load("../../etc/passwd")).toBeNull();
    store.save(draft());
    writeFileSync(join(dir, "p1.draft"), "not a draft");
    expect(store.load("p1")).toBeNull();
  });
});

describe("flush before close / quit", () => {
  function page() {
    const listeners = new Set<(id: number) => void>();
    const asked: number[] = [];
    return {
      asked,
      answer: (id: number) => {
        for (const l of listeners) l(id);
      },
      deps: {
        send: (id: number) => {
          asked.push(id);
          return true;
        },
        onDone: (l: (id: number) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      listening: () => listeners.size,
    };
  }

  it("asks the page and goes on when it answers", async () => {
    const p = page();
    const flush = new RendererFlush({ ...p.deps, timeoutMs: 10_000 });
    const done = flush.run();
    expect(p.asked).toEqual([1]);
    // A second quit request while the first waits shares it.
    expect(flush.run()).toBe(done);
    p.answer(99); // someone else's answer
    p.answer(1);
    await expect(done).resolves.toBe("done");
    expect(p.listening()).toBe(0);
  });

  it("never holds the quit longer than the timeout, nor without a window", async () => {
    vi.useFakeTimers();
    try {
      const p = page();
      const flush = new RendererFlush({ ...p.deps, timeoutMs: 1500 });
      const done = flush.run();
      vi.advanceTimersByTime(1500);
      await expect(done).resolves.toBe("timeout");
      const none = new RendererFlush({ ...p.deps, send: () => false });
      await expect(none.run()).resolves.toBe("no-window");
    } finally {
      vi.useRealTimers();
    }
  });
});
