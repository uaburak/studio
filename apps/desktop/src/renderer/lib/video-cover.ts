// Video covers for the Medya grid: the server makes no thumbnail for videos, so the renderer
// draws one. An off-screen <video> loads the file (the content route serves Range requests, so
// only the start is read), seeks to ~0.1 s, the frame goes on a canvas (short side 480 px) and is
// kept as a JPEG: in memory (object URL, for this session) and in Cache Storage (on disk, for the
// next launch), keyed by asset id — a file never changes under its id. Only mounted tiles ask
// (the grid draws just the rows near the viewport), at most two videos decode at once, and a
// tile scrolled away before its turn is dropped from the queue. A failure resolves to null and
// the tile keeps its video glyph.
import { useEffect, useState } from "react";
import { assetUrl } from "./api.ts";

export interface VideoCover {
  /** `<img src>` of the frame (an object URL). */
  url: string;
  /** The video's length as the decoder saw it (null when unknown). */
  durationMs: number | null;
}

/** "0:07", "1:05", "1:02:03" — the badge on a video tile (Photos' style). */
export function formatClipDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The frame's canvas size: the short side `target` px (never upscaled), aspect kept. */
export function coverSize(
  width: number,
  height: number,
  target = COVER_SHORT_SIDE,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: target, height: target };
  const scale = Math.min(1, target / Math.min(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Where to grab the frame: 0.1 s in, or the middle of a shorter clip. */
export function coverTime(durationSec: number): number {
  return Number.isFinite(durationSec) && durationSec > 0 ? Math.min(0.1, durationSec / 2) : 0.1;
}

const COVER_SHORT_SIDE = 480;
const EXTRACT_TIMEOUT_MS = 15_000;
const CACHE_NAME = "studio-video-covers-v1";

interface CoverBlob {
  blob: Blob;
  durationMs: number | null;
}

/** Draws `assetId`'s first frame (browser only). */
export function extractVideoFrame(assetId: string): Promise<CoverBlob | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (result: CoverBlob | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), EXTRACT_TIMEOUT_MS);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      video.currentTime = coverTime(video.duration);
    };
    video.onseeked = () => {
      const size = coverSize(video.videoWidth, video.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context || !(video.videoWidth > 0)) return finish(null);
      try {
        context.drawImage(video, 0, 0, size.width, size.height);
      } catch {
        return finish(null);
      }
      const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null;
      canvas.toBlob((blob) => finish(blob ? { blob, durationMs } : null), "image/jpeg", 0.82);
    };
    video.src = assetUrl(assetId);
  });
}

/** The on-disk side of the cache (Cache Storage; absent in tests and when the API is missing). */
export interface CoverDiskCache {
  get(assetId: string): Promise<CoverBlob | null>;
  put(assetId: string, cover: CoverBlob): Promise<void>;
}

function cacheKey(assetId: string): string {
  return `/video-cover/${encodeURIComponent(assetId)}`;
}

export function cacheStorageCovers(): CoverDiskCache | null {
  if (typeof caches === "undefined") return null;
  const open = () => caches.open(CACHE_NAME);
  return {
    async get(assetId) {
      try {
        const response = await (await open()).match(cacheKey(assetId));
        if (!response) return null;
        const duration = Number(response.headers.get("x-duration-ms"));
        return {
          blob: await response.blob(),
          durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
        };
      } catch {
        return null;
      }
    },
    async put(assetId, cover) {
      try {
        const headers = new Headers({ "content-type": "image/jpeg" });
        if (cover.durationMs) headers.set("x-duration-ms", String(cover.durationMs));
        await (await open()).put(cacheKey(assetId), new Response(cover.blob, { headers }));
      } catch {
        // Disk cache is best effort; the memory copy still serves this session.
      }
    },
  };
}

interface Entry {
  /** Settled cover (null: failed) or undefined while pending. */
  cover: VideoCover | null | undefined;
  listeners: Set<(cover: VideoCover | null) => void>;
  /** Waiting in the queue or being made. */
  busy: boolean;
}

/** Covers by asset id, with a small decode queue (pure enough to test with fakes). */
export class VideoCoverStore {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private running = 0;

  constructor(
    private readonly deps: {
      extract(assetId: string): Promise<CoverBlob | null>;
      disk: CoverDiskCache | null;
      toUrl(blob: Blob): string;
      revoke(url: string): void;
      concurrency?: number;
      /** Settled covers kept in memory; older unwatched ones are let go. */
      limit?: number;
    },
  ) {}

  /** The cover if already made (null: it failed), else undefined. */
  peek(assetId: string): VideoCover | null | undefined {
    return this.entries.get(assetId)?.cover;
  }

  /** Watches `assetId`'s cover; the listener runs once when it is ready. Returns the unsubscribe. */
  watch(assetId: string, listener: (cover: VideoCover | null) => void): () => void {
    let entry = this.entries.get(assetId);
    if (entry?.cover !== undefined) {
      listener(entry.cover);
      return () => {};
    }
    if (!entry) {
      entry = { cover: undefined, listeners: new Set(), busy: false };
      this.entries.set(assetId, entry);
    }
    entry.listeners.add(listener);
    if (!entry.busy) {
      entry.busy = true;
      this.queue.push(assetId);
      this.pump();
    }
    const watched = entry;
    return () => {
      watched.listeners.delete(listener);
    };
  }

  private pump(): void {
    const max = this.deps.concurrency ?? 2;
    while (this.running < max && this.queue.length > 0) {
      const assetId = this.queue.shift() as string;
      const entry = this.entries.get(assetId);
      if (!entry) continue;
      if (entry.listeners.size === 0) {
        entry.busy = false;
        // Scrolled away before its turn: forget it; a later tile asks again.
        if (entry.cover === undefined) this.entries.delete(assetId);
        continue;
      }
      this.running += 1;
      void this.make(assetId).then((cover) => {
        this.running -= 1;
        this.settle(assetId, cover);
        this.pump();
      });
    }
  }

  private async make(assetId: string): Promise<VideoCover | null> {
    try {
      const cached = await this.deps.disk?.get(assetId);
      if (cached) return { url: this.deps.toUrl(cached.blob), durationMs: cached.durationMs };
      const made = await this.deps.extract(assetId);
      if (!made) return null;
      await this.deps.disk?.put(assetId, made);
      return { url: this.deps.toUrl(made.blob), durationMs: made.durationMs };
    } catch {
      return null;
    }
  }

  private settle(assetId: string, cover: VideoCover | null): void {
    const entry = this.entries.get(assetId) ?? {
      cover: undefined,
      listeners: new Set(),
      busy: false,
    };
    entry.cover = cover;
    entry.busy = false;
    // Re-insert so the map's order is "most recently made last".
    this.entries.delete(assetId);
    this.entries.set(assetId, entry);
    const listeners = [...entry.listeners];
    entry.listeners.clear();
    for (const listener of listeners) listener(cover);
    this.trim();
  }

  private trim(): void {
    const limit = this.deps.limit ?? 400;
    let settled = 0;
    for (const entry of this.entries.values()) if (entry.cover !== undefined) settled += 1;
    for (const [assetId, entry] of this.entries) {
      if (settled <= limit) break;
      if (entry.cover === undefined) continue;
      if (entry.cover) this.deps.revoke(entry.cover.url);
      this.entries.delete(assetId);
      settled -= 1;
    }
  }
}

let shared: VideoCoverStore | null = null;

function store(): VideoCoverStore {
  shared ??= new VideoCoverStore({
    extract: extractVideoFrame,
    disk: cacheStorageCovers(),
    toUrl: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  });
  return shared;
}

/**
 * `assetId`'s cover while the calling tile is mounted: undefined while it is being made, null
 * when it could not be (or `assetId` is null), else the cover.
 */
export function useVideoCover(assetId: string | null): VideoCover | null | undefined {
  const [cover, setCover] = useState<VideoCover | null | undefined>(() =>
    assetId ? store().peek(assetId) : null,
  );
  useEffect(() => {
    if (!assetId) {
      setCover(null);
      return;
    }
    const known = store().peek(assetId);
    setCover(known);
    if (known !== undefined) return;
    return store().watch(assetId, setCover);
  }, [assetId]);
  return cover;
}
