// Faz 2 on the Mac: "Boş tuvalden yeni post" makes a draft post of the brand and a blank canvas
// job (no AI) in the size picked; "Bilgileri üret" queues a `content.details` job, says how it
// goes and what it wrote, and is refused where it can't run; a blank canvas or the details job
// refetch the post, a blank canvas locks the canvas while it is being made.
import type { Job } from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import {
  detailsBlocker,
  detailsState,
  latestDetailsJob,
} from "../../src/renderer/features/post-editor/details.ts";
import { versionJobRunning } from "../../src/renderer/features/post-editor/edit-lock.ts";
import {
  BLANK_FORM,
  blankCanvasJob,
  blankFormat,
  blankSlides,
  createBlankCanvasPost,
} from "../../src/renderer/features/posts/blank-canvas.ts";

const job = (o: Partial<Job>): Job =>
  ({
    id: "j1",
    type: "content.details",
    status: "running",
    payload: {},
    contentId: "c1",
    brandId: "b1",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    ...o,
  }) as Job;

describe("Boş tuvalden yeni post", () => {
  it("sizes the blank canvas by type and size", () => {
    expect(blankFormat({ kind: "post", size: "portrait" })).toEqual({ width: 1080, height: 1350 });
    expect(blankFormat({ kind: "carousel", size: "square" })).toEqual({
      width: 1080,
      height: 1080,
    });
    expect(blankFormat({ kind: "story", size: "square" })).toEqual({ width: 1080, height: 1920 });
    expect(blankSlides({ kind: "post", slides: 5 })).toBe(1);
    expect(blankSlides({ kind: "carousel", slides: 1 })).toBe(2);
    expect(blankSlides({ kind: "carousel", slides: 40 })).toBe(20);
    expect(blankCanvasJob({ ...BLANK_FORM, kind: "carousel", slides: 4 })).toEqual({
      baseVersion: null,
      slides: 4,
      width: 1080,
      height: 1350,
      origin: "manual_edit",
      note: "Boş tuval.",
    });
  });

  it("creates the brand's draft post and its canvas.create job (no AI job)", async () => {
    const api = {
      contents: { create: vi.fn(async (input: object) => ({ id: "c9", ...input })) },
      jobs: { create: vi.fn(async (input: object) => ({ id: "j9", ...input })) },
    };
    const res = await createBlankCanvasPost(api as never, "b1", {
      title: "  ",
      kind: "story",
      size: "portrait",
      slides: 3,
    });
    expect(api.contents.create).toHaveBeenCalledWith({
      brandId: "b1",
      type: "story",
      title: "Yeni post",
      brief: "",
      targetPlatforms: ["instagram"],
    });
    expect(api.jobs.create).toHaveBeenCalledTimes(1);
    expect(api.jobs.create.mock.calls[0]?.[0]).toMatchObject({
      type: "canvas.create",
      brandId: "b1",
      contentId: "c9",
      payload: { slides: 1, width: 1080, height: 1920, origin: "manual_edit" },
    });
    expect(res.content.id).toBe("c9");
    // While it is made the canvas waits (the version comes from the job).
    expect(
      versionJobRunning([job({ type: "canvas.create", contentId: "c9", status: "queued" })], "c9"),
    ).toBe(true);
  });
});

describe("Bilgileri üret", () => {
  it("follows the post's latest job: progress, what was written, a failure", () => {
    const jobs = [
      job({ id: "old", status: "failed", error: "x", createdAt: "2026-11-20T09:00:00.000Z" }),
      job({ id: "new", status: "running", progress: 0.4 }),
      job({ id: "other", contentId: "c2" }),
    ];
    expect(latestDetailsJob(jobs, "c1")?.id).toBe("new");
    expect(detailsState(latestDetailsJob(jobs, "c1"))).toEqual({
      kind: "running",
      message: "Bilgiler yazılıyor…",
      progress: 0.4,
    });
    expect(
      detailsState(
        job({
          status: "succeeded",
          output: {
            contentId: "c1",
            version: 2,
            written: ["title", "caption"],
            title: "T",
            caption: "C",
            hashtags: [],
            altTexts: [],
            firstComment: null,
            notes: ["Elle yazılmış alternatif metinler korundu."],
          },
        }),
      ),
    ).toEqual({
      kind: "done",
      message: "Yazıldı: başlık, açıklama ve hashtag'ler. Tasarım değişmedi.",
      notes: ["Elle yazılmış alternatif metinler korundu."],
    });
    expect(detailsState(job({ status: "failed", error: "Claude yok" }))).toEqual({
      kind: "failed",
      message: "Claude yok",
    });
    expect(detailsState(null)).toEqual({ kind: "idle" });
  });

  it("is refused for published posts, posts without a design, while running or with an unsaved caption", () => {
    const ok = { status: "draft", hasVersion: true, running: false, captionDirty: false };
    expect(detailsBlocker(ok)).toBeNull();
    expect(detailsBlocker({ ...ok, status: "published" })).toMatch(/Yayınlanan/);
    expect(detailsBlocker({ ...ok, hasVersion: false })).toMatch(/tasarım/);
    expect(detailsBlocker({ ...ok, running: true })).toMatch(/yazılıyor/);
    expect(detailsBlocker({ ...ok, captionDirty: true })).toMatch(/kaydet/);
    // A details job never makes a version: the canvas stays editable meanwhile.
    expect(versionJobRunning([job({ status: "running" })], "c1")).toBe(false);
  });
});
