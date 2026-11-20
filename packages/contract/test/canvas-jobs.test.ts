// Canvas jobs (S1): the Mac app's canvas runner reads and edits a canvas version's Wecra document
// with Wecra's own write tools; it is not "the Mac worker".
import { describe, expect, it } from "vitest";
import {
  CANVAS_EDIT_TOOLS,
  CANVAS_JOB_TYPES,
  CanvasApplyOutput,
  CanvasApplyPayload,
  CanvasCreatePayload,
  CanvasReadPayload,
  CONTENT_DETAIL_FIELDS,
  ContentDetailsPayload,
  canvasFormatFor,
  canvasFrameRef,
  isCanvasRunner,
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPE_REQUIREMENTS,
  JobType,
  MAX_CANVAS_OPERATIONS,
  resolveCanvasFrameRefs,
} from "../src/index.ts";

describe("canvas jobs", () => {
  it("are job types of a post, validated on creation", () => {
    for (const type of CANVAS_JOB_TYPES) {
      expect(JobType.options).toContain(type);
      expect(JOB_TYPE_REQUIREMENTS[type]).toEqual({ brand: true, content: true });
      expect(JOB_PAYLOAD_SCHEMAS[type]).toBeDefined();
    }
  });

  it("name Wecra's write tools only, a bounded list, against a base version", () => {
    const op = { tool: "update_nodes", args: { updates: [{ nodeId: "7:2", characters: "A" }] } };
    expect(CanvasApplyPayload.parse({ version: 3, operations: [op] })).toEqual({
      version: 3,
      operations: [op],
    });
    expect(CANVAS_EDIT_TOOLS).not.toContain("run_command");
    expect(
      CanvasApplyPayload.safeParse({ version: 3, operations: [{ tool: "run_command", args: {} }] })
        .success,
    ).toBe(false);
    expect(CanvasApplyPayload.safeParse({ version: 3, operations: [] }).success).toBe(false);
    expect(
      CanvasApplyPayload.safeParse({
        version: 3,
        operations: Array.from({ length: MAX_CANVAS_OPERATIONS + 1 }, () => op),
      }).success,
    ).toBe(false);
    expect(CanvasApplyPayload.safeParse({ operations: [op] }).success).toBe(false);
    expect(CanvasReadPayload.parse({})).toEqual({});
    expect(
      CanvasApplyOutput.parse({
        contentId: "p1",
        version: 4,
        baseVersion: 3,
        slides: 1,
        checkJobId: null,
        results: [{ tool: "update_nodes", ok: true, summary: "update_nodes: everything applied." }],
      }).results[0]?.touched,
    ).toEqual([]);
  });

  it("tell the canvas runner apart from the Mac worker", () => {
    expect(isCanvasRunner(["canvas.read", "canvas.apply"])).toBe(true);
    expect(isCanvasRunner(["canvas.read", "canvas.apply", "canvas.create"])).toBe(true);
    expect(isCanvasRunner(["content.details"])).toBe(false);
    expect(isCanvasRunner(["canvas.apply", "chat.turn"])).toBe(false);
    expect(isCanvasRunner([])).toBe(false);
  });
});

describe("canvas.create (the Wecra engine, a blank canvas)", () => {
  it("makes blank frames, optionally designed with Wecra's operations on `frame:N`", () => {
    expect(CanvasCreatePayload.parse({ slides: 1, width: 1080, height: 1350 })).toEqual({
      slides: 1,
      width: 1080,
      height: 1350,
      operations: [],
      origin: "generated",
    });
    expect(
      CanvasCreatePayload.parse({ slides: 3, width: 1080, height: 1080, origin: "manual_edit" })
        .origin,
    ).toBe("manual_edit");
    expect(
      CanvasCreatePayload.safeParse({ slides: 1, width: 1080, height: 1350, origin: "ai_edit" })
        .success,
    ).toBe(false);
    expect(CanvasCreatePayload.safeParse({ slides: 21, width: 1080, height: 1350 }).success).toBe(
      false,
    );
    expect(CanvasCreatePayload.safeParse({ slides: 1, width: 5000, height: 1350 }).success).toBe(
      false,
    );
  });

  it("puts each frame's id where an operation names `frame:N`", () => {
    const args = {
      parentId: canvasFrameRef(2),
      nodes: [{ type: "TEXT", characters: "frame:1", children: [{ type: "FRAME" }] }],
      nodeIds: ["frame:1", "12:3", "frame:9"],
      updates: [{ nodeId: "frame:1", fills: "#ffffff" }],
    };
    expect(resolveCanvasFrameRefs(args, ["1:10", "1:20"])).toEqual({
      parentId: "1:20",
      // A text that only looks like a reference stays.
      nodes: [{ type: "TEXT", characters: "frame:1", children: [{ type: "FRAME" }] }],
      nodeIds: ["1:10", "12:3", "frame:9"],
      updates: [{ nodeId: "1:10", fills: "#ffffff" }],
    });
  });
});

describe("content.details (Bilgileri üret)", () => {
  it("names the fields it may write, all of them by default", () => {
    expect(ContentDetailsPayload.parse({})).toEqual({});
    expect(ContentDetailsPayload.parse({ fields: ["caption", "altText"] }).fields).toEqual([
      "caption",
      "altText",
    ]);
    expect(ContentDetailsPayload.safeParse({ fields: ["slides"] }).success).toBe(false);
    expect(CONTENT_DETAIL_FIELDS).toEqual(["title", "caption", "altText", "firstComment"]);
    expect(JOB_TYPE_REQUIREMENTS["content.details"]).toEqual({ brand: true, content: true });
    expect(JOB_PAYLOAD_SCHEMAS["content.details"]).toBe(ContentDetailsPayload);
  });
});

describe("blank canvas formats", () => {
  it("4:5 feed posts, square when asked, vertical stories", () => {
    expect(canvasFormatFor("post")).toEqual({ width: 1080, height: 1350 });
    expect(canvasFormatFor("carousel", "Kare format, 5 slayt")).toEqual({
      width: 1080,
      height: 1080,
    });
    expect(canvasFormatFor("post", "1:1 olsun")).toEqual({ width: 1080, height: 1080 });
    expect(canvasFormatFor("post", "1080x1080")).toEqual({ width: 1080, height: 1080 });
    expect(canvasFormatFor("post", "kare kare anlat")).toEqual({ width: 1080, height: 1350 });
    expect(canvasFormatFor("story", "kare format")).toEqual({ width: 1080, height: 1920 });
  });
});
