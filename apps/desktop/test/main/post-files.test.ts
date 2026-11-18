// Post export in the main process: request checks, save to a file or a folder (never over an
// existing file), the share menu's cache folder, reveal only what was written; and the cloud
// sync asked for when Studio comes to the front.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PostFiles, uniquePath } from "../../src/main/post-files.ts";
import { PublishingSync } from "../../src/main/publishing-sync.ts";
import { requestProblem, safeFileName } from "../../src/shared/post-files.ts";

function fakeFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const id = decodeURIComponent(url.split("/api/assets/")[1]?.split("/")[0] ?? "");
    if (id === "missing") return new Response("no", { status: 404 });
    return new Response(`bytes:${id}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function setup(over: { file?: string | null; folder?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "studio-export-"));
  const { fn, calls } = fakeFetch();
  const shared: string[][] = [];
  const revealed: string[] = [];
  const files = new PostFiles({
    target: () => ({ port: 9999, ownerSecret: "owner" }),
    chooseFile: async () => (over.file === undefined ? join(dir, "chosen.jpg") : over.file),
    chooseFolder: async () => (over.folder === undefined ? dir : over.folder),
    shareDir: join(dir, "share"),
    showShareMenu: (paths) => shared.push(paths),
    showInFolder: (path) => revealed.push(path),
    fetch: fn,
  });
  return { dir, files, calls, shared, revealed };
}

describe("post files", () => {
  it("refuses requests the page should never send", () => {
    expect(requestProblem(null)).toBeTruthy();
    expect(requestProblem({ format: "exe", files: [{ assetId: "a", name: "x" }] })).toMatch(
      /biçim/,
    );
    expect(requestProblem({ format: "jpeg", files: [] })).toMatch(/dosya yok/);
    expect(requestProblem({ format: "jpeg", files: [{ assetId: "../etc", name: "x" }] })).toMatch(
      /kimliği/,
    );
    expect(
      requestProblem({ format: "jpeg", files: [{ assetId: "a1", name: "x.jpg" }] }),
    ).toBeNull();
  });

  it("keeps file names inside the chosen folder with the format's extension", () => {
    expect(safeFileName("../../etc/passwd", "jpeg")).toBe("passwd.jpg");
    expect(safeFileName("hasat-v3-1.png", "jpeg")).toBe("hasat-v3-1.jpg");
    expect(safeFileName(".gizli", "pdf")).toBe("gizli.pdf");
    expect(safeFileName("...", "pdf")).toBeNull();
  });

  it("writes one file where the save dialog says, with the owner secret", async () => {
    const { files, dir, calls } = setup();
    const result = await files.save({ format: "jpeg", files: [{ assetId: "a1", name: "p.jpg" }] });
    expect(result).toEqual({ ok: true, paths: [join(dir, "chosen.jpg")] });
    expect(readFileSync(join(dir, "chosen.jpg"), "utf8")).toBe("bytes:a1");
    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:9999/api/assets/a1/content",
      headers: { "X-Studio-Owner": "owner" },
    });
  });

  it("writes several files into a folder without overwriting", async () => {
    const { files, dir } = setup();
    writeFileSync(join(dir, "p-1.jpg"), "old");
    const result = await files.save({
      format: "jpeg",
      files: [
        { assetId: "a1", name: "p-1.jpg" },
        { assetId: "a2", name: "p-2.jpg" },
      ],
    });
    expect(result).toEqual({ ok: true, paths: [join(dir, "p-1 2.jpg"), join(dir, "p-2.jpg")] });
    expect(readFileSync(join(dir, "p-1.jpg"), "utf8")).toBe("old");
    expect(readFileSync(join(dir, "p-1 2.jpg"), "utf8")).toBe("bytes:a1");
  });

  it("says canceled when the dialog is closed and why a download failed", async () => {
    const canceled = setup({ file: null });
    expect(
      await canceled.files.save({ format: "pdf", files: [{ assetId: "a1", name: "p.pdf" }] }),
    ).toEqual({ ok: false, canceled: true });
    const failing = setup();
    const result = await failing.files.save({
      format: "pdf",
      files: [{ assetId: "missing", name: "p.pdf" }],
    });
    expect(result.ok).toBe(false);
    expect("message" in result && result.message).toMatch(/indirilemedi/);
  });

  it("shares from a fresh cache folder through the share menu", async () => {
    const { files, shared, dir } = setup();
    const result = await files.share({
      format: "mp4",
      files: [{ assetId: "v1", name: "reel.mp4" }],
    });
    expect(result.ok).toBe(true);
    const path = shared[0]?.[0] as string;
    expect(path.startsWith(join(dir, "share"))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("bytes:v1");
    // The next share clears the previous one's files.
    await files.share({ format: "mp4", files: [{ assetId: "v2", name: "reel.mp4" }] });
    expect(existsSync(path)).toBe(false);
  });

  it("reveals only files it wrote", async () => {
    const { files, revealed, dir } = setup();
    files.reveal(["/etc/passwd"]);
    expect(revealed).toEqual([]);
    const result = await files.save({ format: "png", files: [{ assetId: "a1", name: "p.png" }] });
    if (!result.ok) throw new Error("save failed");
    files.reveal(result.paths);
    expect(revealed).toEqual([join(dir, "chosen.jpg")]);
  });

  it("numbers names until one is free", () => {
    const taken = new Set(["/x/a.jpg", "/x/a 2.jpg"]);
    expect(uniquePath("/x", "a.jpg", (p) => taken.has(p))).toBe("/x/a 3.jpg");
  });
});

describe("publishing sync on focus", () => {
  it("asks once, then not again within the interval, and not while the host is down", async () => {
    let now = 1_000_000;
    let up = true;
    const fetchFn = vi.fn(async () => new Response("{}"));
    const sync = new PublishingSync({
      target: () => (up ? { port: 8790, ownerSecret: "s" } : null),
      fetch: fetchFn as unknown as typeof fetch,
      now: () => now,
      minIntervalMs: 30_000,
    });
    expect(await sync.focused()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8790/api/publishing/sync");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Studio-Owner"]).toBe("s");
    now += 5_000;
    expect(await sync.focused()).toBe(false);
    now += 30_000;
    up = false;
    expect(await sync.focused()).toBe(false);
    up = true;
    expect(await sync.focused()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("logs a failure and keeps working", async () => {
    const log = vi.fn();
    const sync = new PublishingSync({
      target: () => ({ port: 1, ownerSecret: "s" }),
      fetch: (async () => {
        throw new Error("refused");
      }) as unknown as typeof fetch,
      log,
    });
    expect(await sync.focused()).toBe(false);
    expect(log).toHaveBeenCalledWith("publishing sync: refused");
  });
});
