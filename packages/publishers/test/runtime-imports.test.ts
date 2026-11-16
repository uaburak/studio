/**
 * The package must run in workerd: no Node built-ins, no Node globals.
 * (The typecheck also enforces this: tsconfig has no @types/node.)
 * This test reads files through Vite's glob import, so it needs no `node:fs` itself.
 */

import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FORBIDDEN: [string, RegExp][] = [
  ["node: import", /from\s+["']node:/],
  [
    "bare Node built-in import",
    /from\s+["'](fs|path|os|crypto|buffer|stream|http|https|url|util|child_process|events|zlib)(\/[^"']*)?["']/,
  ],
  ["require()", /\brequire\s*\(/],
  ["process global", /\bprocess\./],
  ["Buffer global", /\bBuffer\b/],
  ["__dirname", /__dirname|__filename/],
];

describe("runtime-agnostic sources", () => {
  it("found the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it.each(Object.entries(sources))("%s uses no Node-only APIs", (_file, text) => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const [label, re] of FORBIDDEN) expect(re.test(code), label).toBe(false);
  });

  it("only imports zod from outside the package", () => {
    const external = new Set<string>();
    for (const text of Object.values(sources)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const m of code.matchAll(/from\s+["']([^."'][^"']*)["']/g)) external.add(m[1] as string);
    }
    expect([...external]).toEqual(["zod"]);
  });
});
