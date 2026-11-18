// The canvas's save model with Wecra's real engine (headless): edits are kept as the post's one
// draft on this Mac and never make a version on their own (S5 / E12); a version only on ⌘S,
// approve / schedule / chat (flush) and closing the post; undo back to the saved state is clean
// (E19); a draft comes back when the post opens, or is offered when it was made on an older
// version; a locked canvas is Wecra's viewer mode (E3); a new version arriving while the canvas
// has unsaved edits asks (E4); closing writes the draft first and says when the version could not
// be made (E14); pictures are the brand's assets, uploaded once (E13); hidden / wrong-size frames
// never become a version (E15); a bundle this Wecra can't read falls back (E19).
import type { WNode } from "@shared/agents/web/convert";
import { writeZip } from "@shared/fig/zip";
import type { ContentVersion } from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import { EditorController } from "@/editor/controller";
import { type DocumentSource, memoryDocumentSource } from "@/editor/documentSource";
import { pageFrames } from "@/editor/exporting";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import {
  linkKnownImages,
  shareImages,
} from "../../src/renderer/features/post-editor/wecra/assets.ts";
import {
  BundleImages,
  decodeBundle,
  encodeBundle,
  loadBundle,
} from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import { frameBlocker, postFormat } from "../../src/renderer/features/post-editor/wecra/frames.ts";
import { documentHash, sha256Hex } from "../../src/renderer/features/post-editor/wecra/hash.ts";
import {
  finishSlide,
  importSlides,
  slideSpec,
} from "../../src/renderer/features/post-editor/wecra/import.ts";
import { WecraPostSession } from "../../src/renderer/features/post-editor/wecra/session.ts";
import { memoryDrafts } from "../../src/renderer/lib/bridge.ts";

// PNG encoding needs an OffscreenCanvas (the browser's): the engine's pixels, as raw bytes here.
vi.mock("@/editor/exporting", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/editor/exporting")>();
  return {
    ...original,
    encodePixels: async (p: { width: number; height: number }) =>
      new TextEncoder().encode(`png ${p.width}x${p.height}`),
  };
});

const SIZE = { width: 1080, height: 1350 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

function first<T>(list: readonly T[]): T {
  const item = list[0];
  if (item === undefined) throw new Error("empty");
  return item;
}

const box = (i: number, rest: Partial<WNode>): WNode => ({
  kind: "box",
  i,
  tag: "div",
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  d: "block",
  pos: "absolute",
  pad: [0, 0, 0, 0],
  bw: [0, 0, 0, 0],
  mar: [0, 0, 0, 0],
  rad: [0, 0, 0, 0],
  gap: [0, 0],
  sh: [],
  c: {},
  children: [],
  ...rest,
});

/** A slide frame with a badge (a filled shape), as Wecra's walker would capture it. */
function slideTree(): WNode {
  return box(0, {
    tag: "main",
    w: 1080,
    h: 1350,
    pos: "relative",
    c: { bg: "#f4efe4" },
    children: [box(1, { x: 880, y: 80, w: 120, h: 120, c: { bg: "#2f5d2b" } })],
  });
}

async function editorOn(source: DocumentSource, sessionID: number) {
  const engine = await Engine.create(null, { sessionID });
  expect(engine.load(await source.load())).toBe(0);
  engine.on("DOCUMENT_CHANGED", (e) =>
    source.onChanges(e.message, { kind: e.kind, label: e.label }),
  );
  return { ed: new EditorController(engine, new EngineStore(engine), source), engine };
}

/** A document of `count` slides, as a bundle (what a version saved from the canvas carries). */
async function documentBundle(count = 1, images = new BundleImages()): Promise<Uint8Array> {
  const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), { sessionID: 3, images });
  const { ed, engine } = await editorOn(source, 3);
  const layers = ["", "badge"];
  await importSlides(
    ed,
    Array.from({ length: count }, (_, index) => {
      const { spec } = slideSpec(slideTree(), (i) => layers[i] || null, index);
      return { index, ...SIZE, spec: finishSlide(spec, index, SIZE), fonts: [], missing: [] };
    }),
  );
  return encodeBundle(engine.encodeDocumentKiwi(), images, []);
}

function version(n: number, assetId: string, slides = 1): ContentVersion {
  return {
    id: `v${n}`,
    contentId: "p1",
    version: n,
    origin: "manual_edit",
    contentHash: "0".repeat(64),
    slideCount: slides,
    note: null,
    jobId: null,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    slides: Array.from({ length: slides }, () => ({
      html: "<main data-artboard></main>",
      ...SIZE,
      renderedAssetId: `render-${n}`,
      layers: null,
    })),
    editorDocument: { kind: "wecra", assetId, format: 2 },
  } as ContentVersion;
}

/** An in-memory API: asset uploads, versions, jobs (each call recorded). */
function fakeApi() {
  const assets = new Map<string, Uint8Array>();
  const calls: { type: string; input: Record<string, unknown> }[] = [];
  let n = 0;
  let next = 10;
  const api = {
    failCreate: null as string | null,
    calls,
    assets,
    uploads: () => calls.filter((c) => c.type === "upload").map((c) => c.input),
    versionsCreated: () => calls.filter((c) => c.type === "version").map((c) => c.input),
    client: {
      assets: {
        upload: async (input: {
          file: Blob;
          kind?: string;
          source?: string;
          filename?: string;
        }) => {
          const id = `asset-${++n}`;
          assets.set(id, new Uint8Array(await input.file.arrayBuffer()));
          calls.push({
            type: "upload",
            input: { id, kind: input.kind, source: input.source, name: input.filename },
          });
          return { id, mimeType: input.file.type } as never;
        },
        contentUrl: (id: string) => `/api/assets/${id}/content`,
      },
      jobs: {
        create: async (input: Record<string, unknown>) => {
          calls.push({ type: "job", input });
          return {} as never;
        },
      },
      contents: {
        versions: {
          create: async (_id: string, input: Record<string, unknown>) => {
            if (api.failCreate) throw new Error(api.failCreate);
            calls.push({ type: "version", input });
            const v = ++next;
            return { id: `v${v}`, version: v } as never;
          },
          get: async (_id: string, number: number) => {
            calls.push({ type: "get", input: { number } });
            return {
              ...version(number, "none"),
              editorDocument: null,
              slides: [{ html: "<main data-artboard></main>", ...SIZE }],
            } as never;
          },
        },
      },
    },
  };
  return api;
}

type Api = ReturnType<typeof fakeApi>;

function newSession(
  api: Api,
  options: {
    drafts?: ReturnType<typeof memoryDrafts>;
    type?: "post" | "carousel" | "story";
    report?: (m: string) => void;
  } = {},
) {
  const drafts = options.drafts ?? memoryDrafts();
  const refresh = vi.fn(async () => {});
  const session = new WecraPostSession({
    api: api.client as never,
    content: () => ({ id: "p1", brandId: "b1", type: options.type ?? "post", title: "Post" }),
    kit: () => ({ css: "", files: {} }),
    refresh,
    drafts,
    draftMs: 0,
    fetchAsset: async (id) => {
      const bytes = api.assets.get(id);
      if (!bytes) throw new Error(`no asset ${id}`);
      return bytes;
    },
    ...(options.report ? { report: options.report } : {}),
  });
  return { session, drafts, refresh };
}

let sessions = 20;

/** Opens `v` in `session` and brings Wecra's editor up on it (as EditorApp does). */
async function show(session: WecraPostSession, v: ContentVersion) {
  await session.open(v);
  const source = session.source;
  if (!source) throw new Error(`no document (${session.getState().phase})`);
  const { ed, engine } = await editorOn(source, ++sessions);
  await session.attach(ed);
  return { ed, engine, frame: first(pageFrames(ed)).ref };
}

/** A post whose current version (v2) was saved from the canvas. */
async function savedPost(options: Parameters<typeof newSession>[1] & { slides?: number } = {}) {
  const api = fakeApi();
  api.assets.set("doc-2", await documentBundle(options.slides ?? 1));
  const s = newSession(api, options);
  const v2 = version(2, "doc-2", options.slides ?? 1);
  return { api, v2, ...s };
}

const nameOf = (engine: Engine, guid: string) =>
  (engine.readNode(guid) as { name?: string } | null)?.name;

describe("drafts, not versions (S5)", () => {
  it("keeps an edit as the post's one draft on this Mac: no upload, no version, no job", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const { engine, frame } = await show(session, v2);
    expect(session.getState()).toMatchObject({ phase: "ready", dirty: false, version: 2 });
    engine.setProps([frame], { name: "Kapak" } as never);
    expect(session.getState().dirty).toBe(true);
    await session.writeDraft();
    expect(api.calls).toEqual([]);
    const draft = drafts.items.get("p1");
    expect(draft).toMatchObject({ contentId: "p1", baseVersion: 2, baseVersionId: "v2" });
    expect(draft?.docHash).not.toBe(draft?.baseHash);
    expect(session.getState().draftSavedAt).toEqual(draft?.savedAt);
    // Another edit replaces the same draft (one per post).
    engine.setProps([frame], { name: "Kapak 2" } as never);
    await session.writeDraft();
    expect(drafts.items.size).toBe(1);
    expect(api.calls).toEqual([]);
  });

  it("is clean again after undoing back to the saved state: the draft goes, ⌘S makes nothing", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Kapak" } as never);
    await session.writeDraft();
    expect(drafts.items.has("p1")).toBe(true);
    engine.command("UNDO");
    expect(nameOf(engine, frame)).toBe("Kare 1");
    await session.writeDraft();
    expect(session.getState().dirty).toBe(false);
    expect(drafts.items.has("p1")).toBe(false);
    // Saving now (dirty or not) makes no version.
    engine.setProps([frame], { name: "X" } as never);
    engine.command("UNDO");
    expect(await session.save()).toBe(true);
    expect(api.versionsCreated()).toEqual([]);
    expect(session.getState().dirty).toBe(false);
  });

  it("makes a version on ⌘S (renders + the bundle) and the draft goes; flush makes none when clean", async () => {
    const { api, v2, session, drafts, refresh } = await savedPost();
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Kapak" } as never);
    await session.writeDraft();
    expect(await session.save()).toBe(true);
    expect(api.versionsCreated()).toHaveLength(1);
    expect(api.uploads().map((u) => u.name)).toEqual(["kare-1.png", "post.wecra"]);
    expect(session.getState()).toMatchObject({ dirty: false, saving: false, version: 11 });
    expect(drafts.items.has("p1")).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Approve / schedule / a chat message flush: nothing unsaved, nothing made.
    expect(await session.flush()).toBe(true);
    expect(api.versionsCreated()).toHaveLength(1);
    // An edit then flush (what Onayla does first): one more version.
    engine.setProps([frame], { name: "Kapak 2" } as never);
    expect(await session.flush()).toBe(true);
    expect(api.versionsCreated()).toHaveLength(2);
  });

  it("puts the draft back when the post opens again (Vazgeç drops it)", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const before = await show(session, v2);
    before.engine.setProps([before.frame], { name: "Kapak" } as never);
    await session.writeDraft();
    session.dispose();

    const again = newSession(api, { drafts }).session;
    const { engine, frame } = await show(again, v2);
    expect(nameOf(engine, frame)).toBe("Kapak");
    expect(again.getState()).toMatchObject({
      dirty: true,
      draft: { kind: "restored", baseVersion: 2 },
    });
    expect(api.versionsCreated()).toEqual([]);
    // Vazgeç: the version as saved, the draft gone.
    await again.discardDraft();
    expect(drafts.items.has("p1")).toBe(false);
    const reopened = again.source;
    if (!reopened) throw new Error("no document");
    const back = await editorOn(reopened, 99);
    await again.attach(back.ed);
    expect(nameOf(back.engine, first(pageFrames(back.ed)).ref)).toBe("Kare 1");
    expect(again.getState()).toMatchObject({ dirty: false, draft: null });
  });

  it("offers a draft made on an older version (read only until answered) and opens it on request", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const before = await show(session, v2);
    before.engine.setProps([before.frame], { name: "Eski taslak" } as never);
    await session.writeDraft();
    // The AI made v3 meanwhile.
    api.assets.set("doc-3", await documentBundle());
    const v3 = version(3, "doc-3");
    const later = newSession(api, { drafts }).session;
    const { engine, frame } = await show(later, v3);
    expect(nameOf(engine, frame)).toBe("Kare 1");
    expect(later.getState()).toMatchObject({
      dirty: false,
      readOnly: true,
      draft: { kind: "offer", reason: "older", baseVersion: 2 },
    });
    // Wecra's viewer mode: the canvas refuses edits while the question waits.
    expect(engine.setProps([frame], { name: "Y" } as never)).not.toBe(0);
    expect(nameOf(engine, frame)).toBe("Kare 1");
    // Taslağı aç: the draft's document on the canvas, unsaved, now v3's draft.
    await later.openDraft();
    const source = later.source;
    if (!source) throw new Error("no document");
    const opened = await editorOn(source, 98);
    await later.attach(opened.ed);
    expect(nameOf(opened.engine, first(pageFrames(opened.ed)).ref)).toBe("Eski taslak");
    expect(later.getState()).toMatchObject({ dirty: true, readOnly: false, draft: null });
    expect(drafts.items.get("p1")?.baseVersion).toBe(3);
  });

  it("deletes an offered draft on Sil and unlocks the canvas", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const before = await show(session, v2);
    before.engine.setProps([before.frame], { name: "Eski" } as never);
    await session.writeDraft();
    api.assets.set("doc-3", await documentBundle());
    const later = newSession(api, { drafts }).session;
    const { engine, frame } = await show(later, version(3, "doc-3"));
    await later.deleteDraft();
    expect(drafts.items.has("p1")).toBe(false);
    expect(later.getState()).toMatchObject({ readOnly: false, draft: null });
    expect(engine.setProps([frame], { name: "Yeni" } as never)).toBe(0);
  });
});

describe("read only (E3)", () => {
  it("opens a locked post in Wecra's viewer mode: no edit, no draft, no version; unlocking edits", async () => {
    const { api, v2, session, drafts } = await savedPost();
    session.setReadOnly(true);
    const { engine, frame } = await show(session, v2);
    expect(session.getState().readOnly).toBe(true);
    expect(engine.setProps([frame], { name: "Kapak" } as never)).not.toBe(0);
    expect(session.getState().dirty).toBe(false);
    expect(await session.save("Ad")).toBe(false);
    expect(session.getState().saveError).toMatch(/salt okunur/);
    expect(api.calls).toEqual([]);
    expect(drafts.items.size).toBe(0);
    session.setReadOnly(false);
    expect(engine.setProps([frame], { name: "Kapak" } as never)).toBe(0);
    expect(session.getState().dirty).toBe(true);
  });

  it("offers (never applies) a same-version draft while the post is locked", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const before = await show(session, v2);
    before.engine.setProps([before.frame], { name: "Kapak" } as never);
    await session.writeDraft();
    const locked = newSession(api, { drafts }).session;
    locked.setReadOnly(true);
    const { engine, frame } = await show(locked, v2);
    expect(nameOf(engine, frame)).toBe("Kare 1");
    expect(locked.getState().draft).toMatchObject({ kind: "offer", reason: "locked" });
    // Unlocked ("Düzenle" confirmed): Taslağı aç.
    locked.setReadOnly(false);
    await locked.openDraft();
    const source = locked.source;
    if (!source) throw new Error("no document");
    const opened = await editorOn(source, 97);
    await locked.attach(opened.ed);
    expect(nameOf(opened.engine, first(pageFrames(opened.ed)).ref)).toBe("Kapak");
  });
});

describe("a new version while the canvas has unsaved edits (E4)", () => {
  it("asks: the canvas stays, the draft is written; “Benimkini kaydet” makes a version on top", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const { engine, frame } = await show(session, v2);
    const source = session.source;
    engine.setProps([frame], { name: "Benim" } as never);
    api.assets.set("doc-3", await documentBundle());
    await session.open(version(3, "doc-3"));
    expect(session.source).toBe(source);
    expect(session.getState()).toMatchObject({ incoming: { version: 3 }, version: 2, dirty: true });
    expect(drafts.items.get("p1")?.baseVersion).toBe(2);
    // Approving meanwhile waits for the answer.
    expect(await session.flush()).toBe(false);
    expect(session.getState().saveError).toMatch(/yeni gelen sürüm/);
    expect(await session.resolveIncoming("mine")).toBe(true);
    expect(api.versionsCreated()).toHaveLength(1);
    expect(session.getState()).toMatchObject({ incoming: null, dirty: false, version: 11 });
    expect(nameOf(engine, frame)).toBe("Benim");
  });

  it("drops the question when the canvas's own save lands on top of the arrived version", async () => {
    const { api, v2, session } = await savedPost();
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Benim" } as never);
    let release: (() => void) | null = null;
    const create = api.client.contents.versions.create;
    api.client.contents.versions.create = async (id, input) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return create(id, input);
    };
    const saving = session.save();
    api.assets.set("doc-3", await documentBundle());
    await session.open(version(3, "doc-3"));
    expect(session.getState().incoming).toEqual({ version: 3 });
    await vi.waitFor(() => expect(release).not.toBeNull());
    (release as (() => void) | null)?.();
    expect(await saving).toBe(true);
    expect(session.getState()).toMatchObject({ incoming: null, dirty: false, version: 11 });
  });

  it("“Yeni sürümü aç”: the new version opens and the edits stay a draft, offered", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Benim" } as never);
    api.assets.set("doc-3", await documentBundle());
    await session.open(version(3, "doc-3"));
    await session.resolveIncoming("theirs");
    expect(session.getState()).toMatchObject({
      version: 3,
      incoming: null,
      draft: { kind: "offer", reason: "older", baseVersion: 2 },
    });
    expect(drafts.items.get("p1")?.baseVersion).toBe(2);
    expect(api.versionsCreated()).toEqual([]);
  });

  it("keeps the draft when an older version is looked at, and puts it back on the current one", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Benim" } as never);
    api.assets.set("doc-1", await documentBundle());
    session.setReadOnly(true); // an older version is read only
    await show(session, version(1, "doc-1"));
    expect(drafts.items.get("p1")?.baseVersion).toBe(2);
    expect(session.getState()).toMatchObject({ version: 1, draft: null, dirty: false });
    session.setReadOnly(false);
    const back = await show(session, v2);
    expect(nameOf(back.engine, back.frame)).toBe("Benim");
    expect(session.getState().draft).toMatchObject({ kind: "restored" });
  });
});

describe("closing the post (E14)", () => {
  it("writes the draft, then makes the version; the draft goes", async () => {
    const { api, v2, session, drafts } = await savedPost();
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Kapak" } as never);
    await session.close();
    expect(api.versionsCreated()).toHaveLength(1);
    expect(drafts.items.has("p1")).toBe(false);
  });

  it("keeps the draft and says so when the version can't be made", async () => {
    const report = vi.fn();
    const { api, v2, session, drafts } = await savedPost({ report });
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Kapak" } as never);
    api.failCreate = "Sunucu yanıt vermedi";
    await session.close();
    expect(api.versionsCreated()).toEqual([]);
    expect(drafts.items.get("p1")?.baseVersion).toBe(2);
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/Sunucu yanıt vermedi.*taslak/));
  });

  it("writes the draft synchronously when the page unloads", async () => {
    const { v2, session, drafts } = await savedPost();
    const { engine, frame } = await show(session, v2);
    engine.setProps([frame], { name: "Kapak" } as never);
    session.saveDraftSync();
    expect(drafts.items.get("p1")).toMatchObject({ baseVersion: 2, docHash: null });
  });
});

describe("pictures as the brand's assets (E13)", () => {
  it("uploads each picture once and keeps references in the bundle; unchanged pictures are reused", async () => {
    const images = new BundleImages();
    const sha1 = await images.put(PNG);
    const upload = vi.fn(async () => ({ id: "pic-1" }));
    const used = [sha1];
    expect(await shareImages(images, used, upload)).toEqual({ uploaded: 1, reused: 0, inside: 0 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(images.assets.get(sha1)).toMatchObject({ assetId: "pic-1", mimeType: "image/png" });
    // A second save: nothing to upload.
    expect(await shareImages(images, used, upload)).toEqual({ uploaded: 0, reused: 0, inside: 0 });
    expect(upload).toHaveBeenCalledTimes(1);

    // The bundle: the document and a reference, no picture inside.
    const { message } = decodeBundle(await documentBundle());
    const { ed, engine } = await editorOn(
      memoryDocumentSource(message, { sessionID: 60, images }),
      60,
    );
    engine.setProps([first(pageFrames(ed)).ref], { fillPaints: imageFill(sha1) } as never);
    const doc = encodeBundle(engine.encodeDocumentKiwi(), images, []);
    const back = decodeBundle(doc);
    expect(back.meta.assets?.[sha1]).toMatchObject({ assetId: "pic-1" });
    expect(back.images.map.has(sha1)).toBe(false);
    expect(back.pending).toEqual([sha1]);
    // Opened again: the picture read from its asset; a save after it uploads nothing.
    const loaded = await loadBundle(doc, async (id) => {
      expect(id).toBe("pic-1");
      return PNG;
    });
    expect(loaded.images.map.get(sha1)).toEqual(PNG);
    const again = vi.fn(async () => ({ id: "pic-2" }));
    await shareImages(loaded.images, [sha1], again);
    expect(again).not.toHaveBeenCalled();
  });

  it("reuses an asset the import read (same bytes) and keeps unknown files inside", async () => {
    const images = new BundleImages();
    const sha1 = await images.put(PNG);
    images.remember({
      assetId: "media-7",
      sha256: await sha256Hex(PNG),
      mimeType: "image/png",
      bytes: PNG.byteLength,
    });
    const odd = await images.put(new Uint8Array([1, 2, 3, 4]));
    // Linked as soon as the import is done: a draft then keeps a reference, not the bytes.
    expect(await linkKnownImages(images)).toBe(1);
    expect(images.assets.get(sha1)?.assetId).toBe("media-7");
    images.assets.delete(sha1);
    const upload = vi.fn(async () => ({ id: "x" }));
    expect(await shareImages(images, [sha1, odd], upload)).toEqual({
      uploaded: 0,
      reused: 1,
      inside: 1,
    });
    expect(upload).not.toHaveBeenCalled();
    expect(images.assets.get(sha1)?.assetId).toBe("media-7");
  });

  it("still opens a format 1 bundle (every picture inside)", async () => {
    const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), { sessionID: 4 });
    const { engine } = await editorOn(source, 4);
    const sha1 = "a".repeat(40);
    const meta = {
      format: 1,
      kind: "wecra",
      wecra: { appVersion: "1.0.0", commit: "x", abiVersion: 1 },
      slides: [],
      images: [sha1],
      sourceVersion: 1,
    };
    const old = writeZip([
      { name: "meta.json", data: new TextEncoder().encode(JSON.stringify(meta)) },
      { name: "document.kiwi", data: engine.encodeDocumentKiwi() },
      { name: `images/${sha1}`, data: PNG },
    ]);
    const decoded = await loadBundle(old, async () => {
      throw new Error("no asset is read for a format 1 bundle");
    });
    expect(decoded.meta.format).toBe(1);
    expect(decoded.images.map.get(sha1)).toEqual(PNG);
    expect(decoded.meta.sourceVersion).toBe(1);
  });

  it("makes a save upload the canvas's new picture once", async () => {
    const { api, v2, session } = await savedPost();
    const { engine, frame } = await show(session, v2);
    const sha1 = await session.images.put(PNG);
    engine.setProps([frame], { fillPaints: imageFill(sha1) } as never);
    // (jsdom can't decode the picture: the frames are drawn as they are, as when closing.)
    expect(await session.save(undefined, { closing: true })).toBe(true);
    const pictures = () => api.uploads().filter((u) => u.name === "tuval-gorseli.png");
    expect(pictures()).toEqual([expect.objectContaining({ kind: "image", source: "upload" })]);
    const bundleId = api.versionsCreated()[0]?.editorDocument as { assetId: string };
    const meta = decodeBundle(api.assets.get(bundleId.assetId) as Uint8Array).meta;
    expect(Object.keys(meta.assets ?? {})).toEqual([sha1]);
    // Another edit and save: the picture is not uploaded again.
    engine.setProps([frame], { name: "Kapak" } as never);
    expect(await session.save(undefined, { closing: true })).toBe(true);
    expect(pictures()).toHaveLength(1);
    expect(api.versionsCreated()).toHaveLength(2);
  });
});

describe("frames (E15)", () => {
  it("never saves a hidden frame's post (it would drop the slide): the draft keeps it", async () => {
    const { api, session, drafts } = await savedPost({ type: "carousel", slides: 2 });
    api.assets.set("doc-2", await documentBundle(2));
    const { ed, engine } = await show(session, version(2, "doc-2", 2));
    const second = pageFrames(ed)[1]?.ref as string;
    engine.setProps([second], { visible: false } as never);
    expect(await session.save()).toBe(false);
    expect(session.getState().saveError).toMatch(/gizli/);
    expect(api.versionsCreated()).toEqual([]);
    expect(drafts.items.has("p1")).toBe(true);
  });

  it("keeps a post's frames at its format and its type's slide count", () => {
    const frame = (name: string, width = 1080, height = 1350, visible = true) => ({
      guid: name,
      name,
      width,
      height,
      visible,
    });
    const portrait = postFormat("post", { width: 1080, height: 1350 });
    expect(postFormat("story", { width: 1080, height: 1350 })).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(frameBlocker("post", [frame("Kare 1")], portrait)).toBeNull();
    expect(frameBlocker("post", [frame("Kare 1", 1080, 1300)], portrait)).toMatch(
      /1080×1300 px; bu postun kareleri 1080×1350/,
    );
    // A second frame on a single post: explained, never saved (the type can't change).
    expect(frameBlocker("post", [frame("Kare 1"), frame("Kare 2")], portrait)).toMatch(
      /tek kare.*carousel/,
    );
    // A carousel: 2–20 frames, any added or removed within that.
    expect(frameBlocker("carousel", [frame("Kare 1")], portrait)).toMatch(/en az 2 kare/);
    expect(
      frameBlocker("carousel", [frame("Kare 1"), frame("Kare 2"), frame("Kare 3")], portrait),
    ).toBeNull();
    expect(
      frameBlocker(
        "carousel",
        Array.from({ length: 21 }, (_, i) => frame(`K${i}`)),
        portrait,
      ),
    ).toMatch(/En fazla 20/);
    expect(
      frameBlocker("carousel", [frame("Kare 1"), frame("Kare 2", 1080, 1350, false)], portrait),
    ).toMatch(/“Kare 2” gizli/);
  });
});

describe("a bundle this Wecra can't read (E19)", () => {
  it("imports the HTML version it came from again, and says the canvas edits are not in it", async () => {
    const api = fakeApi();
    api.assets.set("doc-5", new Uint8Array([0x50, 0x4b, 1, 2, 3]));
    const { session } = newSession(api);
    const v5 = {
      ...version(5, "doc-5"),
      slides: [
        {
          html: '<html><head><meta name="studio:editor" content="wecra"><meta name="studio:source-version" content="3"></head></html>',
          ...SIZE,
          renderedAssetId: "render-5",
          layers: null,
        },
      ],
    } as ContentVersion;
    await session.open(v5);
    expect(api.calls.find((c) => c.type === "get")?.input).toEqual({ number: 3 });
    expect(session.getState()).toMatchObject({ phase: "importing", origin: "import" });
    expect(session.getState().warnings.join(" ")).toMatch(/v3 HTML'sinden yeniden kuruldu/);
  });

  it("shows the version's renders read only when there is no HTML version to go back to", async () => {
    const api = fakeApi();
    api.assets.set("doc-5", new Uint8Array([0x50, 0x4b, 1, 2, 3]));
    const { session } = newSession(api);
    await session.open(version(5, "doc-5"));
    expect(session.getState().phase).toBe("fallback");
    expect(session.source).toBeNull();
    expect(session.getState().fallback).toMatchObject({
      message: expect.stringMatching(/düzenlenemez/),
      images: [{ src: "/api/assets/render-5/content", width: 1080, height: 1350 }],
    });
  });
});

describe("the document's hash", () => {
  it("is the same whichever editor session wrote the snapshot", async () => {
    const bytes = await documentBundle();
    const { message } = decodeBundle(bytes);
    const a = await editorOn(memoryDocumentSource(structuredClone(message), { sessionID: 41 }), 41);
    const b = await editorOn(memoryDocumentSource(structuredClone(message), { sessionID: 42 }), 42);
    expect(await documentHash(a.engine.encodeDocumentKiwi())).toBe(
      await documentHash(b.engine.encodeDocumentKiwi()),
    );
  });
});

function hexBytes(hash: string): number[] {
  return Array.from({ length: 20 }, (_, i) => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16));
}

/** An image fill of the picture `sha1` (Wecra writes the hash as 20 bytes). */
function imageFill(sha1: string) {
  return [
    {
      type: "IMAGE",
      image: { hash: hexBytes(sha1) },
      imageScaleMode: "FILL",
      opacity: 1,
      visible: true,
    },
  ];
}
