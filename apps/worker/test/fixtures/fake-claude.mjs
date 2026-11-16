#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Usage: fake-claude.mjs <scenario.json> [claude args...]
// scenario: { lines?: string[], fixture?: string, delayMs?: number, exitCode?: number,
//             stderr?: string, hang?: boolean, record?: string }
// Records argv, the environment and stdin to `record`, then prints the stream-json lines.
import { readFileSync, writeFileSync } from "node:fs";

const [scenarioPath, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

if (scenario.sigintFile) {
  // Record how the run was stopped; `ignoreSigint` makes the worker escalate to SIGKILL.
  process.on("SIGINT", () => {
    writeFileSync(scenario.sigintFile, "SIGINT");
    if (!scenario.ignoreSigint) process.exit(130);
  });
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", async () => {
  if (scenario.record) {
    writeFileSync(
      scenario.record,
      JSON.stringify({ args, env: process.env, stdin, cwd: process.cwd() }),
    );
  }
  const lines = scenario.fixture
    ? readFileSync(scenario.fixture, "utf8").split("\n").filter(Boolean)
    : (scenario.lines ?? []);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
    if (scenario.delayMs) await new Promise((r) => setTimeout(r, scenario.delayMs));
  }
  if (scenario.stderr) process.stderr.write(scenario.stderr);
  if (scenario.hang) {
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = scenario.exitCode ?? 0;
});
