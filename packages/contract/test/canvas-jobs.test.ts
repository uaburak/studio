// Canvas jobs (S1): the Mac app's canvas runner reads and edits a canvas version's Wecra document
// with Wecra's own write tools; it is not "the Mac worker".
import { describe, expect, it } from "vitest";
import {
  CANVAS_EDIT_TOOLS,
  CANVAS_JOB_TYPES,
  CanvasApplyOutput,
  CanvasApplyPayload,
  CanvasReadPayload,
  isCanvasRunner,
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPE_REQUIREMENTS,
  JobType,
  MAX_CANVAS_OPERATIONS,
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
    expect(isCanvasRunner(["canvas.apply", "chat.turn"])).toBe(false);
    expect(isCanvasRunner([])).toBe(false);
  });
});
