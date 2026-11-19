import { describe, expect, it, vi } from "vitest";
import {
  type CoverDiskCache,
  coverSize,
  coverTime,
  formatClipDuration,
  VideoCoverStore,
} from "../../src/renderer/lib/video-cover.ts";

describe("formatClipDuration", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatClipDuration(0)).toBe("0:00");
    expect(formatClipDuration(7_400)).toBe("0:07");
    expect(formatClipDuration(65_000)).toBe("1:05");
    expect(formatClipDuration(3_723_000)).toBe("1:02:03");
  });
});

describe("coverSize / coverTime", () => {
  it("scales the short side down to the target, never up", () => {
    expect(coverSize(1920, 1080)).toEqual({ width: 853, height: 480 });
    expect(coverSize(1080, 1920)).toEqual({ width: 480, height: 853 });
    expect(coverSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(coverSize(0, 0)).toEqual({ width: 480, height: 480 });
  });
  it("grabs 0.1 s in, or the middle of a very short clip", () => {
    expect(coverTime(12)).toBe(0.1);
    expect(coverTime(0.1)).toBe(0.05);
    expect(coverTime(Number.NaN)).toBe(0.1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeStore(over: { disk?: CoverDiskCache | null; limit?: number } = {}) {
  const pending = new Map<
    string,
    ReturnType<typeof deferred<{ blob: Blob; durationMs: number | null } | null>>
  >();
  const extract = vi.fn((id: string) => {
    const d = deferred<{ blob: Blob; durationMs: number | null } | null>();
    pending.set(id, d);
    return d.promise;
  });
  const revoke = vi.fn();
  const store = new VideoCoverStore({
    extract,
    disk: over.disk ?? null,
    toUrl: (blob) => `blob:${(blob as Blob & { tag?: string }).tag ?? "x"}`,
    revoke,
    concurrency: 2,
    ...(over.limit ? { limit: over.limit } : {}),
  });
  const blob = (tag: string) => Object.assign(new Blob(["x"]), { tag });
  return { store, extract, pending, revoke, blob };
}

describe("VideoCoverStore", () => {
  it("makes at most two at a time and shares one result between watchers", async () => {
    const { store, extract, pending, blob } = makeStore();
    const a1 = vi.fn();
    const a2 = vi.fn();
    store.watch("a", a1);
    store.watch("a", a2);
    store.watch("b", vi.fn());
    store.watch("c", vi.fn());
    await flush();
    expect(extract.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    pending.get("a")?.resolve({ blob: blob("a"), durationMs: 7000 });
    await flush();
    expect(a1).toHaveBeenCalledWith({ url: "blob:a", durationMs: 7000 });
    expect(a2).toHaveBeenCalledTimes(1);
    expect(store.peek("a")).toEqual({ url: "blob:a", durationMs: 7000 });
    expect(extract.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
  });

  it("drops a tile that left before its turn, and remembers failures as null", async () => {
    const { store, extract, pending } = makeStore();
    store.watch("a", vi.fn());
    store.watch("b", vi.fn());
    const stopC = store.watch("c", vi.fn());
    stopC();
    await flush();
    pending.get("a")?.resolve(null);
    await flush();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(store.peek("a")).toBeNull();
    expect(store.peek("c")).toBeUndefined();
    const late = vi.fn();
    store.watch("a", late);
    expect(late).toHaveBeenCalledWith(null);
  });

  it("reads the disk cache first and writes new covers to it", async () => {
    const stored = new Map<string, { blob: Blob; durationMs: number | null }>();
    const disk: CoverDiskCache = {
      get: async (id) => stored.get(id) ?? null,
      put: async (id, cover) => {
        stored.set(id, cover);
      },
    };
    const { store, extract, pending, blob } = makeStore({ disk });
    stored.set("a", { blob: blob("disk-a"), durationMs: null });
    const onA = vi.fn();
    store.watch("a", onA);
    store.watch("b", vi.fn());
    await flush();
    expect(onA).toHaveBeenCalledWith({ url: "blob:disk-a", durationMs: null });
    expect(extract.mock.calls.map((c) => c[0])).toEqual(["b"]);
    pending.get("b")?.resolve({ blob: blob("b"), durationMs: 1000 });
    await flush();
    expect(stored.has("b")).toBe(true);
  });

  it("lets go of the oldest covers past the limit", async () => {
    const { store, pending, revoke, blob } = makeStore({ limit: 1 });
    store.watch("a", vi.fn());
    await flush();
    pending.get("a")?.resolve({ blob: blob("a"), durationMs: null });
    await flush();
    store.watch("b", vi.fn());
    await flush();
    pending.get("b")?.resolve({ blob: blob("b"), durationMs: null });
    await flush();
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(store.peek("a")).toBeUndefined();
    expect(store.peek("b")).toEqual({ url: "blob:b", durationMs: null });
  });
});
