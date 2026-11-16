/**
 * The isomorphic entry points must run in the browser (web editor) and in Node without a
 * headless browser: no Node built-ins, no Node globals, nothing from Playwright or sharp.
 * Two independent checks: a source scan, and a real esbuild browser bundle of each entry.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, string>;
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const isomorphic = files(SRC).filter((f) => !relative(SRC, f).startsWith("render"));
const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

const FORBIDDEN: [string, RegExp][] = [
  ["node: import", /from\s+["']node:/],
  [
    "bare Node built-in",
    /from\s+["'](fs|path|os|crypto|buffer|stream|http|https|url|util|child_process|events|zlib|worker_threads)(\/[^"']*)?["']/,
  ],
  ["playwright", /from\s+["']playwright/],
  ["sharp", /from\s+["']sharp["']/],
  ["render module", /from\s+["'][./]*render\//],
  ["require()", /\brequire\s*\(/],
  ["process global", /\bprocess\./],
  ["Buffer global", /\bBuffer\b/],
  ["__dirname", /__dirname|__filename/],
];

describe("isomorphic sources", () => {
  it("found the sources", () => {
    expect(isomorphic.length).toBeGreaterThan(25);
  });

  it.each(isomorphic.map((f) => [relative(SRC, f), f]))(
    "%s uses no Node-only API",
    (_rel, file) => {
      const code = strip(readFileSync(file, "utf8"));
      for (const [label, re] of FORBIDDEN) expect(re.test(code), label).toBe(false);
    },
  );

  it("only imports zod and parse5 from outside the package", () => {
    const external = new Set<string>();
    for (const f of isomorphic)
      for (const m of strip(readFileSync(f, "utf8")).matchAll(/from\s+["']([^."'][^"']*)["']/g))
        external.add((m[1] as string).split("/")[0] as string);
    expect([...external].sort()).toEqual(["parse5", "zod"]);
  });
});

const entries = Object.entries(PKG.exports).filter(
  ([k, v]) => v.endsWith(".ts") && k !== "./render",
);

describe("browser bundles", () => {
  it.each(entries)(
    "%s bundles for the browser without Node, Playwright or sharp",
    async (_name, entry) => {
      const res = await build({
        entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
        bundle: true,
        platform: "browser",
        format: "esm",
        write: false,
        metafile: true,
        logLevel: "silent",
      });
      expect(res.errors).toEqual([]);
      const inputs = Object.keys(res.metafile.inputs);
      expect(
        inputs.some((i) => /playwright|sharp|src\/render\//.test(i)),
        inputs.join("\n"),
      ).toBe(false);
      expect(inputs.some((i) => i.startsWith("node:"))).toBe(false);
    },
  );

  it("the render entry is Node-only (bundling it for the browser fails)", async () => {
    await expect(
      build({
        entryPoints: [fileURLToPath(new URL("../src/render/index.ts", import.meta.url))],
        bundle: true,
        platform: "browser",
        write: false,
        logLevel: "silent",
      }),
    ).rejects.toThrow();
  });
});
