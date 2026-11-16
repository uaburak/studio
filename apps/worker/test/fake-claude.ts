import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
export const REAL_STREAM = fileURLToPath(
  new URL("./fixtures/real-structured-stream.jsonl", import.meta.url),
);

export interface Scenario {
  lines?: string[];
  fixture?: string;
  delayMs?: number;
  exitCode?: number;
  stderr?: string;
  hang?: boolean;
  /** Written ("SIGINT") when the fake gets SIGINT. */
  sigintFile?: string;
  /** Keep running after SIGINT (the worker must escalate to SIGKILL). */
  ignoreSigint?: boolean;
}

export interface FakeClaude {
  bin: string;
  dir: string;
  /** What the fake saw: its argv, environment, stdin and cwd. */
  recorded(): { args: string[]; env: Record<string, string>; stdin: string; cwd: string };
}

/** A `claude` executable (shell wrapper around fake-claude.mjs) that plays a scenario. */
export function fakeClaude(scenario: Scenario): FakeClaude {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"));
  const record = path.join(dir, "record.json");
  const scenarioPath = path.join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, record }));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${scenarioPath}" "$@"\n`);
  chmodSync(bin, 0o755);
  return {
    bin,
    dir,
    recorded: () => JSON.parse(readFileSync(record, "utf8")),
  };
}

/** stream-json lines of a successful structured call. */
export function structuredLines(output: unknown, extra: { partial?: string[] } = {}): string[] {
  const init = {
    type: "system",
    subtype: "init",
    model: "claude-opus-5-5",
    claude_code_version: "2.1.292",
    tools: ["StructuredOutput"],
    apiKeySource: "none",
  };
  const partial = (extra.partial ?? []).map((p) =>
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: p },
      },
    }),
  );
  const start = JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "StructuredOutput", input: {} },
    },
  });
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 1000,
    result: JSON.stringify(output),
    structured_output: output,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100,
    },
    modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 20 } },
  };
  return [
    JSON.stringify(init),
    ...(partial.length ? [start, ...partial] : []),
    JSON.stringify(result),
  ];
}
