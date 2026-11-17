import { describe, expect, it, vi } from "vitest";
import {
  activeVersion,
  approveBlocker,
  canApprove,
  type EditorApi,
  editBlocker,
  isViewingCurrent,
  PostEditor,
  slideLayers,
} from "../../src/renderer/features/post-detail/editor.ts";
import { contentFor, FakeContentApi, hashedVersion, slide, version } from "./post-fixtures.ts";

async function setup(options: { versions?: number } = {}) {
  const fake = new FakeContentApi();
  const versions = [];
  for (let n = 1; n <= (options.versions ?? 1); n++) versions.push(await hashedVersion("p1", n));
  const current = versions.at(-1);
  if (!current) throw new Error("no version");
  const c = contentFor(current);
  fake.add(c, versions);
  const onChange = vi.fn();
  const editor = new PostEditor(fake.api as unknown as EditorApi, c, current, {
    pollMs: 0,
    nudgeMs: 5,
    workerOnline: () => false,
    onChange,
  });
  await editor.load();
  return { fake, editor, onChange };
}

/** Wait until the editor is idle (edits run as background promises). */
async function idle(editor: PostEditor) {
  for (let i = 0; i < 200; i++) {
    if (editor.getSnapshot().activity.kind === "idle") return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("editor never became idle");
}

describe("post editor", () => {
  it("loads the versions and verifies the current version's hash", async () => {
    const { editor } = await setup({ versions: 3 });
    const s = editor.getSnapshot();
    expect(s.summaries.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(s.hashState).toBe("ok");
    expect(s.approvableHash).toBe(s.content.currentVersion?.contentHash);
    expect(canApprove(s)).toBe(true);
  });

  it("switches versions: an old one is read only until it is restored", async () => {
    const { editor, fake } = await setup({ versions: 2 });
    await editor.selectVersion(1);
    let s = editor.getSnapshot();
    expect(activeVersion(s)?.version).toBe(1);
    expect(isViewingCurrent(s)).toBe(false);
    expect(editBlocker(s)).toMatch(/Eski bir sürüm/);
    expect(approveBlocker(s)).toMatch(/Eski bir sürüm/);
    // Edits are refused with the reason.
    editor.setText("headline", "Yeni");
    expect(editor.getSnapshot().error).toMatch(/Eski bir sürüm/);
    expect(fake.createdJobs).toHaveLength(0);

    await editor.showCurrent();
    expect(isViewingCurrent(editor.getSnapshot())).toBe(true);

    await editor.selectVersion(1);
    await editor.restoreDisplayed();
    s = editor.getSnapshot();
    expect(s.content.currentVersion?.version).toBe(3);
    expect(activeVersion(s)?.version).toBe(3);
    expect(s.notice).toBe("v1, v3 olarak geri yüklendi.");
    expect(s.undo.at(-1)).toEqual({ before: 2, after: 3, name: "v1 geri yükle" });
  });

  it("sends edits as content.render patches on the shown version and adopts the result", async () => {
    const { editor, fake, onChange } = await setup();
    editor.setText("headline", "Kış geliyor");
    await idle(editor);
    expect(fake.createdJobs[0]).toEqual({
      type: "content.render",
      payload: {
        format: "jpeg",
        version: 1,
        patches: [{ slide: 0, op: "setText", layer: "headline", text: "Kış geliyor" }],
      },
    });
    const s = editor.getSnapshot();
    expect(s.content.currentVersion?.version).toBe(2);
    expect(activeVersion(s)?.version).toBe(2);
    expect(s.undo).toEqual([{ before: 1, after: 2, name: "Metni değiştir" }]);
    expect(onChange).toHaveBeenCalled();
    // An unchanged text is not sent.
    editor.setText("headline", "Hasat bitti,\ntoprak hazır mı?");
    expect(fake.createdJobs).toHaveLength(1);
  });

  it("queues an edit sent while another renders and sends it on the new version", async () => {
    const { editor, fake } = await setup();
    editor.setHidden("sub", true);
    editor.setColor("headline", "#ff6a00");
    await idle(editor);
    await idle(editor);
    expect(fake.createdJobs.map((j) => (j.payload.patches as { op: string }[])[0]?.op)).toEqual([
      "setVisibility",
      "setColor",
    ]);
    expect(fake.createdJobs[1]?.payload.version).toBe(2);
    expect(fake.createdJobs[1]?.payload.patches).toEqual([
      {
        slide: 0,
        op: "setColor",
        layer: "headline",
        property: "color",
        value: { literal: "#ff6a00" },
      },
    ]);
    expect(editor.getSnapshot().content.currentVersion?.version).toBe(3);
  });

  it("moves, resizes and resets layers with absolute transforms", async () => {
    const { editor, fake } = await setup();
    // `sub` already carries translate 12 -8, scale 1.1.
    editor.move("sub", 10, 0);
    expect(editor.getSnapshot().previewBoxes.sub).toEqual({ x: 90, y: 1150, w: 600, h: 60 });
    await idle(editor);
    expect(fake.createdJobs[0]?.payload.patches).toEqual([
      { slide: 0, op: "transform", layer: "sub", translate: { x: 22, y: -8 }, scale: 1.1 },
    ]);
    editor.resetTransform("headline"); // identity already: nothing to send
    expect(fake.createdJobs).toHaveLength(1);
    editor.resize("headline", 2);
    await idle(editor);
    expect(fake.createdJobs[1]?.payload.patches).toEqual([
      { slide: 0, op: "transform", layer: "headline", translate: { x: 400, y: 100 }, scale: 2 },
    ]);
  });

  it("collects arrow nudges into one move", async () => {
    const { editor, fake } = await setup();
    editor.nudge("headline", 1, 0);
    editor.nudge("headline", 1, 0);
    editor.nudge("headline", 0, 10);
    expect(fake.createdJobs).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    await idle(editor);
    expect(fake.createdJobs).toHaveLength(1);
    expect(fake.createdJobs[0]?.payload.patches).toEqual([
      { slide: 0, op: "transform", layer: "headline", translate: { x: 2, y: 10 }, scale: null },
    ]);
  });

  it("undoes and redoes edits by restoring versions", async () => {
    const { editor } = await setup();
    editor.setText("headline", "A");
    await idle(editor);
    await editor.undo();
    let s = editor.getSnapshot();
    // v1 restored as v3 (same slides), the step moves to redo.
    expect(s.content.currentVersion?.version).toBe(3);
    expect(slideLayers(s).find((l) => l.layerId === "headline")?.text).toBe(
      "Hasat bitti,\ntoprak hazır mı?",
    );
    expect(s.redo).toHaveLength(1);
    expect(s.notice).toBe("Geri alındı: Metni değiştir");
    await editor.redo();
    s = editor.getSnapshot();
    expect(s.content.currentVersion?.version).toBe(4);
    expect(s.undo).toHaveLength(1);
    expect(s.redo).toHaveLength(0);
  });

  it("approves with the verified hash only", async () => {
    const { editor, fake } = await setup();
    expect(await editor.approve()).toBe(true);
    expect(fake.approveCalls).toEqual([
      { id: "p1", hash: editor.getSnapshot().approvableHash as string },
    ]);
    const s = editor.getSnapshot();
    expect(s.content.status).toBe("approved");
    expect(approveBlocker(s)).toBe("Bu post onaylandı.");
  });

  it("refuses to approve when the shown slides do not match the server's hash", async () => {
    const fake = new FakeContentApi();
    const v = version("p1", 1, [slide()]); // contentHash "000…": not the slides' hash
    const c = contentFor(v);
    fake.add(c, [v]);
    const editor = new PostEditor(fake.api as unknown as EditorApi, c, v, { pollMs: 0 });
    await editor.load();
    const s = editor.getSnapshot();
    expect(s.hashState).toBe("mismatch");
    expect(approveBlocker(s)).toMatch(/eşleşmiyor/);
    expect(await editor.approve()).toBe(false);
    expect(fake.approveCalls).toHaveLength(0);
  });

  it("tells a verified version apart from an approvable one", async () => {
    const fake = new FakeContentApi();
    const v = await hashedVersion("p1", 1);
    const failed = contentFor(v, { status: "failed" });
    fake.add(failed, [v]);
    const editor = new PostEditor(fake.api as unknown as EditorApi, failed, v, { pollMs: 0 });
    await editor.load();
    const s = editor.getSnapshot();
    expect(s.hashState).toBe("ok");
    expect(s.approvableHash).toBeNull();
    expect(canApprove(s)).toBe(false);
  });

  it("saves the caption and says when the approval was lifted", async () => {
    const { editor, fake } = await setup();
    await editor.approve();
    expect(await editor.saveCaption("Yeni açıklama\n\n#hasat")).toBe(true);
    expect(fake.updateCalls).toEqual([{ id: "p1", input: { caption: "Yeni açıklama\n\n#hasat" } }]);
    expect(editor.getSnapshot().notice).toBe("Açıklama kaydedildi; onay yeniden gerekiyor.");
  });

  it("asks the AI for a revision of the current version and adopts it", async () => {
    const { editor, fake } = await setup();
    expect(await editor.sendInstruction("  Başlığı kısalt ")).toBe(true);
    expect(fake.createdJobs[0]).toMatchObject({
      type: "content.generate",
      payload: {
        instructions: "Başlığı kısalt",
        baseVersion: 1,
        title: "Hasat sonrası toprak bakımı",
      },
    });
    const s = editor.getSnapshot();
    expect(s.content.currentVersion?.version).toBe(2);
    expect(s.notice).toBe("AI düzenlemesi v2 olarak kaydedildi.");
    expect(s.undo.at(-1)?.name).toBe("AI düzenlemesi");
  });

  it("reports a failed render and clears the preview", async () => {
    const { editor, fake } = await setup();
    fake.failNextJob = "Render başarısız";
    editor.move("headline", 5, 5);
    await idle(editor);
    const s = editor.getSnapshot();
    expect(s.error).toBe("Taşı: Render başarısız");
    expect(s.previewBoxes).toEqual({});
    expect(s.content.currentVersion?.version).toBe(1);
  });

  it("keeps reels and published posts out of the layer editor", async () => {
    const fake = new FakeContentApi();
    const v = await hashedVersion("p1", 1);
    const published = contentFor(v, { status: "published" });
    fake.add(published, [v]);
    const editor = new PostEditor(fake.api as unknown as EditorApi, published, v, { pollMs: 0 });
    expect(editBlocker(editor.getSnapshot())).toBe("Yayındaki post düzenlenemez.");
    const reel = new PostEditor(
      fake.api as unknown as EditorApi,
      contentFor(v, { type: "reel" }),
      v,
    );
    expect(editBlocker(reel.getSnapshot())).toMatch(/Reels/);
  });

  it("follows a newer current version made elsewhere", async () => {
    const { editor, fake } = await setup();
    const v2 = await hashedVersion("p1", 2);
    fake.versions.set("p1", [...(fake.versions.get("p1") ?? []), v2]);
    fake.contents.set("p1", contentFor(v2));
    await editor.refresh();
    const s = editor.getSnapshot();
    expect(activeVersion(s)?.version).toBe(2);
    expect(s.current?.version).toBe(2);
    expect(s.hashState).toBe("ok");
  });
});
