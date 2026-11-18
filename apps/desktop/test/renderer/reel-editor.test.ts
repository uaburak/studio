// The Reels editor (port of StudioKit's ReelDraft and StudioMac's ReelEditorView): the patch it
// sends (only what changed, in the contract's ReelSpecPatch shape), what blocks re-rendering,
// and the `content.render` mp4 job the post editor sends with it.
import {
  encodeReelSpec,
  ReelSpec,
  type ReelSpecInput,
  ReelSpecPatch,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  type EditorApi,
  PostEditor,
  reelEditBlocker,
} from "../../src/renderer/features/post-detail/editor.ts";
import {
  addOverlay,
  addScene,
  clockText,
  draftPatch,
  draftProblems,
  draftTotalMs,
  parseSeconds,
  REEL_CTA_MS,
  reelDraft,
  removeScene,
  secondsText,
  showsCaptionsSwitch,
  updateOverlay,
  updateScene,
} from "../../src/renderer/features/post-detail/reel-draft.ts";
import { contentFor, FakeContentApi, slide, version } from "./post-fixtures.ts";

function spec(over: Partial<ReelSpecInput> = {}): ReelSpec {
  return ReelSpec.parse({
    recipe: "motion_graphics",
    hook: "Toprak dinlenmeli",
    cta: "mtmagro.com",
    scenes: [
      { headline: "Hasat bitti", durationMs: 2_500 },
      { headline: "Toprak yorgun", durationMs: 3_000 },
    ],
    durationMs: 7_300,
    ...over,
  });
}

function reelHtml(s: ReelSpec, video = "vid1"): string {
  return `<!doctype html><html><body><main data-artboard data-video-asset-id="${video}" data-cover-asset-id="cov1" data-duration-ms="${s.durationMs}" data-reel-recipe="${s.recipe}" data-reel-spec-b64="${encodeReelSpec(s)}"></main></body></html>`;
}

describe("reel draft", () => {
  it("sends nothing until something changes, then only the changed fields", () => {
    const d = reelDraft(spec());
    expect(draftPatch(d)).toBeNull();
    const edited = { ...d, hook: "  Toprak da dinlenir  " };
    expect(draftPatch(edited)).toEqual({ hook: "Toprak da dinlenir" });
    // Changing a scene sends every scene (arrays replace), trimmed, with all four fields.
    const scenes = updateScene(d, 1, { headline: " Toprak susuz ", durationMs: 4_000 });
    const patch = draftPatch(scenes);
    expect(patch).toEqual({
      scenes: [
        { eyebrow: "", headline: "Hasat bitti", subhead: "", durationMs: 2_500 },
        { eyebrow: "", headline: "Toprak susuz", subhead: "", durationMs: 4_000 },
      ],
    });
    // The worker's schema accepts it.
    expect(ReelSpecPatch.safeParse(patch).success).toBe(true);
  });

  it("counts motion-graphics length from the scenes and the closing card", () => {
    const d = reelDraft(spec());
    expect(draftTotalMs(d)).toBe(2_500 + 3_000 + REEL_CTA_MS);
    expect(draftTotalMs({ ...d, cta: "  " })).toBe(5_500);
    expect(clockText(draftTotalMs(d))).toBe("0:07");
  });

  it("edits the footage length and overlays of a footage edit", () => {
    const d = reelDraft(
      spec({
        recipe: "footage_edit",
        scenes: [],
        durationMs: 12_000,
        overlays: [{ text: "Önce", startMs: 0, endMs: 2_000 }],
      }),
    );
    expect(draftTotalMs(d)).toBe(12_000);
    const longer = { ...d, durationMs: 15_000 };
    expect(draftPatch(longer)).toEqual({ durationMs: 15_000 });
    const added = addOverlay(d);
    expect(added.overlays).toHaveLength(2);
    expect(added.overlays[1]).toEqual({ text: "Yeni metin", startMs: 2_000, endMs: 4_500 });
    expect(draftPatch(added)?.overlays).toHaveLength(2);
    expect(showsCaptionsSwitch(d)).toBe(true);
  });

  it("never sends durationMs for motion graphics (the scenes decide it)", () => {
    const d = reelDraft(spec());
    expect(draftPatch({ ...d, durationMs: 20_000 })).toBeNull();
  });

  it("sends a changed voice-over text and the captions switch", () => {
    const d = reelDraft(
      spec({ recipe: "narration", scenes: [], narrationScript: "Toprak dinlenmeli." }),
    );
    expect(draftPatch({ ...d, narrationScript: " Toprak dinlenmeli. " })).toBeNull();
    expect(draftPatch({ ...d, narrationScript: "Toprak su ister." })).toEqual({
      narrationScript: "Toprak su ister.",
    });
    expect(draftPatch({ ...d, captions: false })).toEqual({ captions: false });
  });

  it("lists what blocks re-rendering", () => {
    const d = reelDraft(spec());
    expect(draftProblems(d)).toEqual([]);
    expect(draftProblems(updateScene(d, 0, { headline: " " }))).toContain(
      "Sahne 1: başlık boş.",
    );
    expect(draftProblems(updateScene(d, 0, { durationMs: 500 }))).toContain(
      "Sahne 1: süre 0,8–20 sn olmalı.",
    );
    const footage = reelDraft(
      spec({
        recipe: "footage_edit",
        scenes: [],
        durationMs: 5_000,
        overlays: [{ text: "x", startMs: 1_000, endMs: 2_000 }],
      }),
    );
    expect(draftProblems(updateOverlay(footage, 0, { endMs: 500 }))).toContain(
      "Metin 1: bitiş başlangıçtan sonra olmalı.",
    );
    expect(draftProblems(updateOverlay(footage, 0, { startMs: 6_000, endMs: 7_000 }))).toContain(
      "Metin 1: video bittikten sonra başlıyor.",
    );
    expect(draftProblems({ ...footage, durationMs: 120_000 })).toContain(
      "Video en fazla 90 sn olabilir.",
    );
    expect(draftProblems({ ...d, hook: "x".repeat(141) })).toContain(
      "Kanca en fazla 140 karakter.",
    );
  });

  it("keeps at least one scene and at most eight", () => {
    let d = reelDraft(spec({ scenes: [{ headline: "Tek", durationMs: 3_000 }] }));
    expect(removeScene(d, 0).scenes).toHaveLength(1);
    for (let i = 0; i < 10; i++) d = addScene(d);
    expect(d.scenes).toHaveLength(8);
  });

  it("reads and writes seconds with a decimal comma", () => {
    expect(secondsText(2_500)).toBe("2,5");
    expect(secondsText(3_000)).toBe("3");
    expect(parseSeconds("2,5")).toBe(2_500);
    expect(parseSeconds("1.25")).toBe(1_250);
    expect(parseSeconds("")).toBeNull();
    expect(parseSeconds("-1")).toBeNull();
    expect(parseSeconds("abc")).toBeNull();
  });
});

describe("reel re-render", () => {
  async function setup(s: ReelSpec = spec(), video = "vid1") {
    const fake = new FakeContentApi();
    const v1 = version("r1", 1, [slide({ html: reelHtml(s, video), width: 1080, height: 1920 })]);
    const c = contentFor(v1, { id: "r1", type: "reel" });
    fake.add(c, [v1]);
    const editor = new PostEditor(fake.api as unknown as EditorApi, c, v1, { pollMs: 0 });
    await editor.load();
    return { fake, editor };
  }

  it("sends content.render with format mp4 and the reel patch, and adopts the new version", async () => {
    const { fake, editor } = await setup();
    const ok = await editor.renderReel({ hook: "Yeni kanca" });
    expect(ok).toBe(true);
    expect(fake.createdJobs.at(-1)).toEqual({
      type: "content.render",
      payload: { format: "mp4", version: 1, reel: { hook: "Yeni kanca" } },
    });
    const s = editor.getSnapshot();
    expect(s.content.currentVersion?.version).toBe(2);
    expect(s.undo.at(-1)).toEqual({ before: 1, after: 2, name: "Reels düzenlemesi" });
    expect(s.notice).toBe("Video v2 olarak kaydedildi.");
    expect(s.activity.kind).toBe("idle");
  });

  it("refuses a reel without a video or an editable spec", async () => {
    const { editor, fake } = await setup(spec(), "");
    expect(reelEditBlocker(editor.getSnapshot())).toMatch(/Video üretilince/);
    expect(await editor.renderReel({ hook: "x" })).toBe(false);
    expect(fake.createdJobs).toHaveLength(0);
  });

  it("says why a failed render failed", async () => {
    const { editor, fake } = await setup();
    fake.failNextJob = "ffmpeg durdu";
    expect(await editor.renderReel({ cta: "Son" })).toBe(false);
    expect(editor.getSnapshot().error).toMatch(/^Video: /);
    expect(editor.getSnapshot().activity.kind).toBe("idle");
  });
});
