import { describe, expect, it } from "vitest";
import { nodeModeEnv } from "../src/chat/mcp-bridge.ts";

describe("Studio.app runs the worker with its own binary as Node", () => {
  it("passes ELECTRON_RUN_AS_NODE on to the bridge script a CLI starts", () => {
    expect(nodeModeEnv({ ELECTRON_RUN_AS_NODE: "1" })).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("adds nothing under a plain Node", () => {
    expect(nodeModeEnv({})).toEqual({});
  });
});
