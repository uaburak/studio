/**
 * The code engine (Faz 4): the static checks (TypeScript and run.py's syntax tree), the macOS
 * sandbox with a real Python (skipped without one: no files outside the job, no home, the time
 * limit kills the run), the studio_brand helper in the real runtime (skipped without the
 * runtime: it records text boxes, fonts, slots; a filled slot draws the picture), the lint, and
 * the engine with a fake design model (no paid call) and a fake program runner: a traceback goes
 * back to the model, the stored program, a chat revision, the slot → picture job → approval
 * re-run of the program, the checks, readiness.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Asset,
  type BrandProfile,
  type Content,
  codeSlideSlots,
  isCodeSlideHtml,
  isEngineReady,
  type Job,
} from "@studio/contract";
import { colorValue } from "@studio/design-kit/brand";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { runContentChecks } from "../src/checks/pipeline.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeCallResult, ClaudeRunner } from "../src/claude/runner.ts";
import { buildBrandContext } from "../src/generate/brand.ts";
import { ALLOWED_MODULES, precheckProgram } from "../src/generate/code/check.ts";
import {
  type CodeInputs,
  codeSlideHtml,
  parseRunRecord,
  readCodeRecord,
  readCodeSource,
} from "../src/generate/code/document.ts";
import { lintCodeSlide } from "../src/generate/code/lint.ts";
import type { CodeProgramRunner } from "../src/generate/code/run.ts";
import {
  type CodeRuntime,
  CodeRuntimeError,
  codeEngineDir,
  execFileCapped,
  findSystemPython,
  readyRuntime,
  SETUP_HINT,
} from "../src/generate/code/runtime.ts";
import {
  createJobDir,
  runInSandbox,
  type SandboxResult,
  sandboxProfile,
} from "../src/generate/code/sandbox.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "../src/generate/handler.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createContentRenderHandler, type RenderCapable } from "../src/render/handler.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const kit = (rel: string) => path.join(KIT_FIXTURES, rel);
const ENGINE_DIR = codeEngineDir() as string;

// --- the static checks ----------------------------------------------------------------------

const DRAWING = `import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import skia
import cv2
import os.path
from os import path
import studio_brand as sb

img = sb.canvas(1)
sb.text(img, sb.SAFE_LEFT, 200, "import os; eval('x') open(", role="display", size=96)
img = img.filter(ImageFilter.GaussianBlur(2))
name = os.path.basename("a/b.png")
sb.save(img)
`;

const REFUSED: [string, RegExp][] = [
  ["import subprocess\nsubprocess.run(['ls'])", /subprocess/],
  [
    "import os\nos.system('ls')",
    /import of 'os'|import of 'os' is not allowed|os \(only os\.path\)/,
  ],
  ["import os.path\nos.system('ls')", /os/],
  ["import socket\ns = socket.socket()", /socket/],
  ["import ctypes", /ctypes/],
  ["x = eval('1+1')", /eval/],
  ["exec('print(1)')", /exec/],
  ["data = open('/etc/passwd').read()", /open/],
  ["f = getattr(math, 'sqrt')", /getattr/],
  ["print(().__class__.__bases__[0].__subclasses__())", /dunder/],
  ["from numpy import ctypeslib", /numpy|ctypes/],
  ["import PIL.ImageGrab", /ImageGrab/],
  ["__import__('os')", /__import__/],
  ["from . import x", /relative/],
];

describe("the code engine's static pre-check (TypeScript)", () => {
  it("lets a drawing program through, words inside strings included", () => {
    expect(precheckProgram(DRAWING)).toEqual([]);
  });

  it("refuses processes, sockets, native code, eval/exec/open, getattr and dunder escapes", () => {
    for (const [program, why] of REFUSED) {
      const problems = precheckProgram(program);
      expect(problems.length, program).toBeGreaterThan(0);
      expect(problems.join("\n"), program).toMatch(why);
    }
  });

  it("allows the same modules as run.py", () => {
    const runPy = readFileSync(path.join(ENGINE_DIR, "run.py"), "utf8");
    const block = /ALLOWED_MODULES = \{([\s\S]*?)\n\}/.exec(runPy)?.[1] ?? "";
    const python = [...block.matchAll(/"([\w_]+)"/g)].map((m) => m[1]);
    expect(new Set(python)).toEqual(new Set(ALLOWED_MODULES));
  });
});

// --- real Python: run.py's check, the sandbox ---------------------------------------------------

const system = process.platform === "darwin" ? await findSystemPython() : null;

describe.skipIf(!system)("run.py's syntax-tree check (real Python)", () => {
  const check = async (program: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "code-check-"));
    writeFileSync(path.join(dir, "p.py"), program);
    const res = await execFileCapped(
      system?.python as string,
      ["-I", "-B", path.join(ENGINE_DIR, "run.py"), "--check", path.join(dir, "p.py")],
      { timeoutMs: 20_000 },
    );
    return JSON.parse(res.stdout) as { ok: boolean; problems: string[] };
  };

  it("passes a drawing program and refuses the unsafe ones, also those the regexes miss", async () => {
    expect(await check(DRAWING)).toEqual({ ok: true, problems: [] });
    for (const [program] of REFUSED) expect((await check(program)).ok, program).toBe(false);
    // An f-string hides the call from a line scan; the syntax tree sees it.
    const hidden = await check("import os.path\nx = f\"{os.system('ls')}\"\n");
    expect(hidden.problems.join("\n")).toMatch(/os\.system|\.system/);
    const viaFormat = await check('x = "{0.__class__.__subclasses__}".format(())\n');
    expect(viaFormat.ok).toBe(false);
  });
});

/** A bare virtualenv (no packages): enough for run.py and the sandbox. */
async function bareRuntime(): Promise<Pick<
  CodeRuntime,
  "python" | "venv" | "basePrefix" | "executable" | "engineDir"
> | null> {
  if (!system) return null;
  const venv = path.join(mkdtempSync(path.join(tmpdir(), "code-venv-")), "venv");
  const res = await execFileCapped(system.python, ["-m", "venv", "--without-pip", venv], {
    timeoutMs: 60_000,
  });
  if (res.code !== 0) return null;
  return {
    python: path.join(venv, "bin", "python"),
    venv,
    basePrefix: system.basePrefix,
    executable: system.executable,
    engineDir: ENGINE_DIR,
  };
}

const bare = await bareRuntime();

describe.skipIf(!bare)("the sandbox (sandbox-exec, real Python)", () => {
  const run = async (program: string, timeoutMs = 20_000) => {
    const root = mkdtempSync(path.join(tmpdir(), "code-runs-"));
    const jobDir = await createJobDir(root, "job");
    const res = await runInSandbox({
      runtime: bare as CodeRuntime,
      jobDir,
      program,
      input: { artboard: { width: 10, height: 10 } },
      timeoutMs,
    });
    return { res, jobDir };
  };

  it("writes only into its own output folder", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "code-outside-"));
    const root = mkdtempSync(path.join(tmpdir(), "code-runs-"));
    const jobDir = await createJobDir(root, "job");
    const out = path.join(jobDir, "out");
    const res = await runInSandbox({
      runtime: bare as CodeRuntime,
      jobDir,
      program: [
        "import pathlib",
        `pathlib.Path(${JSON.stringify(path.join(out, "ok.txt"))}).write_text("ok")`,
        `pathlib.Path(${JSON.stringify(path.join(outside, "escape.txt"))}).write_text("x")`,
      ].join("\n"),
      input: {},
    });
    expect(res.status).toBe("error");
    expect(res.traceback).toMatch(/PermissionError|Operation not permitted/);
    expect(readdirSync(outside)).toEqual([]);
    expect(res.extraFiles).toEqual(["ok.txt"]);
  });

  it("cannot read the user's home or files outside the job", async () => {
    const secretDir = mkdtempSync(path.join(tmpdir(), "code-secret-"));
    writeFileSync(path.join(secretDir, "token.txt"), "s3cret");
    const home = await run(
      `import pathlib\nprint(sorted(p.name for p in pathlib.Path(${JSON.stringify(homedir())}).iterdir()))`,
    );
    expect(home.res.status).toBe("error");
    expect(home.res.traceback).toMatch(/PermissionError|Operation not permitted/);
    const secret = await run(
      `import pathlib\nprint(pathlib.Path(${JSON.stringify(path.join(secretDir, "token.txt"))}).read_text())`,
    );
    expect(secret.res.status).toBe("error");
    expect(secret.res.stdout).not.toContain("s3cret");
  });

  it("kills a run that takes too long", async () => {
    const started = Date.now();
    const { res } = await run("while True:\n    pass\n", 1_500);
    expect(res.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("refuses an unsafe program before it runs (run.py's check)", async () => {
    const { res } = await run("import subprocess\nsubprocess.run(['/bin/ls'])\n");
    expect(res.status).toBe("rejected");
    expect(res.problems.join("\n")).toContain("subprocess");
  });

  it("allows only the interpreter, the venv, the job's folders and system paths", async () => {
    const profile = sandboxProfile({
      pythonChain: ["/v/bin/python", "/opt/py/bin/python3.12"],
      venv: "/v",
      basePrefix: "/opt/py",
      executable: "/opt/py/bin/python3.12",
      python: "/v/bin/python",
      jobDir: "/j",
      inputDir: "/j/input",
      outDir: "/j/out",
      tmpDir: "/j/tmp",
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toMatch(
      /\(allow file-write\*\s+\(subpath "\/j\/out"\)\s+\(subpath "\/j\/tmp"\)/,
    );
    expect(profile).not.toMatch(/allow file-write\*[^;]*"\/j\/input"/);
    expect(profile).toContain("(allow network-outbound (remote ip))");
    expect(profile).not.toContain("network-bind");
    expect(profile).not.toContain("network-inbound");
    expect(profile).not.toContain("process-fork");
    expect(profile).not.toContain(homedir());
  });
});

// --- the helper in the real runtime ------------------------------------------------------------

const APP_STATE = path.join(homedir(), "Library", "Application Support", "Studio", "worker");
const realRuntime =
  process.platform === "darwin"
    ? await readyRuntime(process.env.STUDIO_CODE_ENGINE_TEST_STATE_DIR ?? APP_STATE)
    : null;

describe.skipIf(!realRuntime)("studio_brand in the real runtime", () => {
  it("draws with the brand's WOFF2 subsets, records text, slots and fonts; a filled slot gets the picture", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "code-real-"));
    const jobDir = await createJobDir(root, "job");
    const fonts = path.join(jobDir, "input", "fonts");
    const files = ["archivo-latin-wdth-normal.woff2", "archivo-latin-ext-wdth-normal.woff2"].map(
      (f) => {
        const target = path.join(fonts, f);
        writeFileSync(target, readFileSync(kit(`venta/fonts/${f}`)));
        return { path: target, weight: null, style: "normal" };
      },
    );
    const picture = path.join(jobDir, "input", "pictures", "slot-ai-image.png");
    writeFileSync(
      picture,
      await sharp({ create: { width: 400, height: 300, channels: 3, background: "#2255AA" } })
        .png()
        .toBuffer(),
    );
    const program = [
      "import studio_brand as sb",
      "for n in (1, 2):",
      "    img = sb.canvas(n, background='paper')",
      "    sb.text(img, sb.SAFE_LEFT, 160, 'Toprağınız kışa hazır mı? Şimdi İğdır', role='display', size=88, weight=800, color='ink', max_width=sb.SAFE_WIDTH, id='headline')",
      "    sb.text(img, 1000, 1200, 'Taşan yazı', role='display', size=40, color='ink', id='overflow')",
      "    sb.slot(img, 96, 560, 888, 666, ratio='4:3', id='ai-image' if n == 1 else 'photo')",
      "    sb.save(img)",
    ].join("\n");
    const res = await runInSandbox({
      runtime: realRuntime as CodeRuntime,
      jobDir,
      program,
      input: {
        artboard: { width: 1080, height: 1350 },
        safeArea: { top: 80, right: 80, bottom: 80, left: 80 },
        colors: { paper: "#F4EFE4", ink: "#1E3A2B", mist: "#E0D9C8" },
        usage: { background: "paper", text: "ink", slotFill: "mist" },
        fonts: { display: { family: "Archivo", files, defaultWeight: 700 } },
        pictures: [],
        slots: { "ai-image": picture },
        slides: { min: 1, max: 2 },
      },
      timeoutMs: 60_000,
    });
    expect(res.status, res.stderr).toBe("ok");
    expect([...res.slides.keys()]).toEqual([1, 2]);
    const record = parseRunRecord(res.record);
    const s1 = record.slides.get(1);
    const headline = s1?.texts.find((t) => t.id === "headline");
    expect(headline).toMatchObject({ family: "Archivo", fontSize: 88, weight: "800", lines: 2 });
    expect(headline?.rect.x).toBeGreaterThanOrEqual(79);
    expect(headline?.rect.x).toBeLessThan(110);
    expect(headline?.background?.median).toEqual([244, 239, 228]);
    expect(s1?.slots).toEqual([
      expect.objectContaining({ id: "ai-image", state: "filled", ratio: "4:3" }),
    ]);
    expect(record.slides.get(2)?.slots[0]).toMatchObject({ id: "photo", state: "empty" });
    // The filled slot shows the picture (blue), the empty one the brand's slot colour.
    const pixel = async (n: number) => {
      const { data } = await sharp(res.slides.get(n) as string)
        .extract({ left: 500, top: 900, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      return [...data.subarray(0, 3)];
    };
    expect(await pixel(1)).toEqual([0x22, 0x55, 0xaa]);
    expect(await pixel(2)).toEqual([0xe0, 0xd9, 0xc8]);
    // The latin-ext subset drew ğ / İ / ş (the latin file has no glyph for them).
    const report = lintCodeSlide(s1 ?? null, {
      width: 1080,
      height: 1350,
      safeArea: { top: 80, right: 80, bottom: 80, left: 80 },
      brandFonts: ["Archivo"],
    });
    expect(report.issues.map((i) => i.rule)).toContain("text-outside-artboard");
    expect(report.issues.find((i) => i.layer === "headline")).toBeUndefined();
    expect(report.layers.find((l) => l.id === "headline")?.text?.contrast?.median).toBeGreaterThan(
      7,
    );
  });

  it("returns a program's traceback", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "code-real-"));
    const jobDir = await createJobDir(root, "job");
    const res = await runInSandbox({
      runtime: realRuntime as CodeRuntime,
      jobDir,
      program:
        "import studio_brand as sb\nimg = sb.canvas(1)\nsb.text(img, 0, 0, 'x', role='nope')\n",
      input: {
        artboard: { width: 1080, height: 1350 },
        colors: { paper: "#FFFFFF" },
        usage: { background: "paper" },
        fonts: { text: { family: "Helvetica Neue", files: [] } },
        slides: { min: 1, max: 1 },
      },
    });
    expect(res.status).toBe("error");
    expect(res.traceback).toContain('File "program.py", line 3');
    expect(res.traceback).toContain("unknown font role 'nope'");
  });

  it("reports a paragraph that wrapped into the heading under it (real generated program)", async () => {
    // The program a real code generation stored (neutral default brand): the lead paragraph
    // wrapped to four lines, its last line ("destekler.") sits on "İÇERİK VE FORMÜL" — the ink
    // boxes are 11 px apart, the line boxes collide. The lint passed it before.
    const { api } = createFakeApi({ brands: [fakeBrand()] });
    const brand = buildBrandContext({
      brand: fakeBrand(),
      profile: null,
      api,
      cacheDir: mkdtempSync(path.join(tmpdir(), "code-neutral-")),
    });
    const root = mkdtempSync(path.join(tmpdir(), "code-real-"));
    const jobDir = await createJobDir(root, "job");
    const product = path.join(jobDir, "input", "pictures", "1-product.png");
    writeFileSync(
      product,
      await sharp({ create: { width: 600, height: 750, channels: 3, background: "#DDDDDD" } })
        .png()
        .toBuffer(),
    );
    const fonts: Record<string, unknown> = {};
    for (const [role, spec] of Object.entries(brand.tokens.font))
      fonts[role] = {
        family: spec.family,
        files: [],
        system: spec.system === true,
        defaultWeight: spec.default?.weight ?? null,
      };
    const colors: Record<string, string> = {};
    for (const [name, token] of Object.entries(brand.tokens.color))
      colors[name] = colorValue(token);
    const safeArea = { top: 64, right: 64, bottom: 64, left: 64 };
    const res = await runInSandbox({
      runtime: realRuntime as CodeRuntime,
      jobDir,
      program: readFileSync(
        fileURLToPath(new URL("./fixtures/code-overlap-program.py", import.meta.url)),
        "utf8",
      ),
      input: {
        version: 1,
        artboard: { width: 1080, height: 1350 },
        safeArea,
        slides: { min: 1, max: 1 },
        language: "tr",
        colors,
        usage: brand.tokens.usage ?? {},
        type: brand.tokens.type,
        fonts,
        pictures: [
          {
            name: "product/venta-boro-1",
            kind: "ürün: Venta Boro",
            label: "Venta Boro (kapak)",
            width: null,
            height: null,
            note: null,
            path: product,
          },
        ],
        slots: {},
        allowedNumbers: [],
        seed: 7,
      },
      timeoutMs: 60_000,
    });
    expect(res.status, res.stderr).toBe("ok");
    const s1 = parseRunRecord(res.record).slides.get(1) ?? null;
    const lead = s1?.texts.find((t) => t.text.startsWith("Çiçeklenme ve döllenme"));
    const heading = s1?.texts.find((t) => t.text === "İÇERİK VE FORMÜL");
    expect(lead?.lines).toBe(4);
    // The recorded line boxes follow the wrapped lines and the line spacing (28 px × 1.38).
    expect(lead?.lineBox?.y).toBeCloseTo(368, 0);
    expect(lead?.lineBox?.h).toBeGreaterThanOrEqual(4 * 28 * 1.38 - 0.5);
    // The ink alone does not touch …
    expect((lead?.rect.y ?? 0) + (lead?.rect.h ?? 0)).toBeLessThan(heading?.rect.y ?? 0);
    const report = lintCodeSlide(s1, {
      width: 1080,
      height: 1350,
      safeArea,
      brandFonts: brand.fontFamilies,
      systemFonts: brand.manifest.systemFontFamilies,
    });
    // … but the lint reports the collision, and only that one (the feature blocks are spaced).
    const overlaps = report.issues.filter((i) => i.rule === "text-overlap");
    expect(overlaps.map((i) => [i.layer, i.data?.other])).toEqual([[lead?.id, heading?.id]]);
    expect(overlaps[0]?.severity).toBe("error");
    expect(report.issues.filter((i) => i.rule.startsWith("font-"))).toEqual([]);
  });
});

// --- lint of a recorded slide ----------------------------------------------------------------

describe("the code slide lint", () => {
  it("measures what the helper recorded with the SVG engine's rules, plus contrast", () => {
    const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
    const text = (id: string, t: string, rect: ReturnType<typeof box>, extra = {}) => ({
      id,
      text: t,
      rect,
      fontSize: 64,
      weight: "700",
      family: "Archivo",
      color: "rgb(30, 58, 43)",
      lines: 1,
      legal: false,
      background: { median: [244, 239, 228], dark: [240, 235, 225], light: [250, 245, 235] },
      maxWidth: null,
      ...extra,
    });
    const report = lintCodeSlide(
      {
        texts: [
          text("headline", "Hasat", box(96, 160, 600, 80)),
          text("off", "Taşan", box(900, 300, 400, 80)),
          text("edge", "Kenar", box(20, 600, 300, 80)),
          text("tiny", "küçük", box(96, 900, 200, 20), { fontSize: 16 }),
          text("font", "Yabancı", box(96, 1000, 300, 60), { family: "Comic Sans" }),
          text("num", "%45 verim", box(96, 1100, 300, 60)),
          text("pale", "Soluk", box(96, 300, 300, 60), { color: "rgb(240, 236, 226)" }),
          text("wide", "Uzunkelime", box(96, 1180, 500, 60), { maxWidth: 300 }),
        ],
        images: [],
        slots: [
          {
            id: "ai-image",
            state: "empty",
            ratio: "4:3",
            label: "AI görsel",
            rect: box(96, 560, 888, 500),
            radius: 0,
          },
        ],
        fonts: [{ family: "Archivo", status: "loaded" }],
      },
      {
        width: 1080,
        height: 1350,
        safeArea: { top: 80, right: 80, bottom: 80, left: 80 },
        brandFonts: ["Archivo", "Montserrat"],
        allowedNumbers: ["11"],
      },
    );
    const by = (layer: string) => report.issues.filter((i) => i.layer === layer).map((i) => i.rule);
    expect(by("headline")).toEqual([]);
    expect(by("off")).toContain("text-outside-artboard");
    expect(by("edge")).toContain("safe-area");
    expect(by("tiny")).toContain("min-font-size");
    expect(by("font")).toContain("font-family");
    expect(by("num")).toContain("unverified-number");
    expect(by("pale")).toContain("contrast");
    expect(by("wide")).toContain("text-overflow-box");
    expect(by("ai-image")).toEqual(expect.arrayContaining(["slot-empty", "slot-ratio-mismatch"]));
    expect(report.ok).toBe(false);
  });
});

// --- the engine with a fake model and a fake runner ------------------------------------------

function ventaProfile(): { profile: BrandProfile; files: Map<string, Uint8Array> } {
  const tokens = JSON.parse(readFileSync(kit("venta/brand.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const facts = JSON.parse(readFileSync(kit("venta/facts.json"), "utf8"));
  const fileAssets: Record<string, string> = {};
  const files = new Map<string, Uint8Array>();
  for (const dir of ["fonts", "logos", "assets"]) {
    for (const name of readdirSync(kit(`venta/${dir}`))) {
      if (!/\.(woff2|png)$/.test(name)) continue;
      const id = `file_${dir}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
      fileAssets[`${dir}/${name}`] = id;
      files.set(id, new Uint8Array(readFileSync(kit(`venta/${dir}/${name}`))));
    }
  }
  return {
    files,
    profile: {
      id: "prof_1",
      brandId: "brand_1",
      version: 2,
      status: "approved",
      isCurrent: true,
      tokens: { ...tokens, fileAssets, facts },
      designRules: "DESIGN.md",
      voice: "VOICE.md",
      createdAt: NOW,
      updatedAt: NOW,
      approvedAt: NOW,
    },
  };
}

const usage = {
  inputTokens: 5,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  durationMs: 1,
  durationApiMs: 1,
  wallMs: 1,
};
const result = (output: unknown): ClaudeCallResult => ({
  output,
  text: "",
  model: "claude-opus-5-5",
  cliVersion: "2.1.292",
  usage,
  rateLimit: undefined,
});

/**
 * A program for the fake runner: `# RAISE: …` makes it fail with a traceback; `# TEXT: id|text|x`
 * records a headline at x; `# SLOT: id` records an image slot.
 */
function program(lines: string[]): string {
  return ["import studio_brand as sb", "img = sb.canvas(1)", ...lines, "sb.save(img)", ""].join(
    "\n",
  );
}

function design(prog: string, extra: Record<string, unknown> = {}) {
  return {
    program: prog,
    caption: "Toprağınız kışa hazır mı?",
    hashtags: ["hasat", "#Toprak", "hasat"],
    rationale: "Işıklı bir zemin, tek büyük başlık.",
    critique: [],
    changes: [],
    ...extra,
  };
}

interface Seen {
  program: string;
  input: Record<string, unknown>;
}

function fakeRunner(seen: Seen[] = []): CodeProgramRunner {
  return {
    async run(req) {
      seen.push({ program: req.program, input: req.input });
      const out = path.join(req.jobDir, "out");
      await mkdir(out, { recursive: true });
      const base: SandboxResult = {
        status: "ok",
        exitCode: 0,
        stdout: "",
        stderr: "",
        traceback: null,
        problems: [],
        slides: new Map(),
        record: null,
        extraFiles: [],
        durationMs: 5,
      };
      const raise = /# RAISE: (.+)/.exec(req.program);
      if (raise)
        return {
          ...base,
          status: "error",
          exitCode: 1,
          traceback: `Traceback (most recent call last):\n  File "program.py", line 3, in <module>\nNameError: ${raise[1]}`,
        };
      const art = req.input.artboard as { width: number; height: number };
      const slots = (req.input.slots ?? {}) as Record<string, string>;
      const fonts = req.input.fonts as Record<string, { family: string; files: unknown[] }>;
      const display = fonts.display?.family ?? "Archivo";
      const texts = [...req.program.matchAll(/# TEXT: ([^|]+)\|([^|]+)\|(\d+)/g)].map((m) => ({
        id: m[1],
        text: m[2],
        rect: { x: Number(m[3]), y: 180, w: 700, h: 110 },
        fontSize: 96,
        weight: "800",
        family: display,
        color: "rgb(30, 58, 43)",
        lines: 1,
        legal: false,
        background: { median: [244, 239, 228], dark: [244, 239, 228], light: [244, 239, 228] },
      }));
      const slotRecords = [...req.program.matchAll(/# SLOT: (\S+)/g)].map((m) => ({
        id: m[1],
        state: slots[m[1] as string] ? "filled" : "empty",
        ratio: "4:3",
        label: "AI görsel",
        rect: { x: 96, y: 560, w: 888, h: 666 },
        radius: 0,
      }));
      const file = path.join(out, "slide-1.png");
      const fill = Object.keys(slots).length ? "#2255AA" : "#E0D9C8";
      await writeFile(
        file,
        await sharp({
          create: { width: art.width, height: art.height, channels: 3, background: "#F4EFE4" },
        })
          .composite([
            {
              input: await sharp({
                create: { width: 888, height: 666, channels: 3, background: fill },
              })
                .png()
                .toBuffer(),
              left: 96,
              top: 560,
            },
          ])
          .png()
          .toBuffer(),
      );
      return {
        ...base,
        slides: new Map([[1, file]]),
        record: {
          version: 1,
          slides: { "1": { texts, images: [], slots: slotRecords, saved: true } },
          fonts: { [display]: { family: display, status: "loaded" } },
          warnings: [],
        },
      };
    },
  };
}

function draft(overrides: Partial<Content> = {}): Content {
  return {
    id: "content_1",
    brandId: "brand_1",
    type: "post",
    title: "Kış bakımı",
    brief: "Kış öncesi toprak bakımı",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: null,
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function setup(content: Content = draft()) {
  const { profile, files } = ventaProfile();
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  for (const [id, bytes] of files)
    state.assets.set(id, { bytes, contentType: "application/octet-stream" });
  state.profiles.set("brand_1", profile);
  state.contents.set(content.id, content);
  return { api, state };
}

const noRenderer: RenderCapable = {
  async renderAndLint() {
    throw new Error("a code slide is never rendered by Chromium here");
  },
};

function deps(
  api: ContentGenerateDeps["api"],
  runner: ClaudeRunner,
  codeRunner: CodeProgramRunner,
  env: Record<string, string> = {},
): ContentGenerateDeps {
  return {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings(env),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-code-")),
    renderer: () => noRenderer as never,
    checkModelCaller: null,
    codeRunner,
  };
}

function job(payload: Record<string, unknown>, id = "job_code"): { job: Job; ctx: JobContext } {
  const j: Job = {
    id,
    type: "content.generate",
    status: "running",
    payload: {
      brandId: "brand_1",
      contentId: "content_1",
      brief: "Kış öncesi toprak bakımı",
      ...payload,
    },
    brandId: "brand_1",
    contentId: "content_1",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    job: j,
    ctx: {
      jobId: j.id,
      job: j,
      attempt: 1,
      workerId: "mac",
      signal: new AbortController().signal,
      progress: () => {},
      log: () => {},
    },
  };
}

const textOfCall = (c: ClaudeCallOptions | undefined) =>
  (c?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");

describe("the code engine (content.generate, engine: code)", () => {
  it("writes the program, feeds a traceback back, critiques the renders and stores the program", async () => {
    const { api, state } = setup();
    const calls: ClaudeCallOptions[] = [];
    const answers = [
      design(program(["# RAISE: name 'gradient' is not defined"])),
      design(program(["# TEXT: headline|TAŞAN başlık|700"]), { changes: ["gradient tanımlandı"] }),
      design(program(["# TEXT: headline|Hasat zamanı|96"]), {
        critique: [{ issue: "Başlık taşıyor", severity: "high", fix: "Kısalt" }],
      }),
    ];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result(answers[calls.length - 1]);
    };
    const seen: Seen[] = [];
    const handler = createContentGenerateHandler(deps(api, runner, fakeRunner(seen)));
    const { job: j, ctx } = job({ engine: "code" });
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;

    expect(calls.map((c) => c.label)).toEqual([
      "code-generate-ontent_1",
      "code-revise1-ontent_1",
      "code-revise2-ontent_1",
    ]);
    expect(calls[0]?.system).toContain("import studio_brand as sb");
    expect(calls[0]?.system).toContain('role "display" = "Archivo"');
    expect(calls[0]?.system).toContain('"logo/');
    expect(calls[0]?.system).toContain("<facts_json>");
    expect(calls[0]?.webAccess).toBe(true);
    // The traceback goes back to the model (it counts as a pass).
    const fix = textOfCall(calls[1]);
    expect(fix).toContain("<run_error>");
    expect(fix).toContain("NameError: name 'gradient' is not defined");
    expect(fix).toContain("<current_program>");
    // Then the lint of the render (the headline runs off the artboard).
    const revise = textOfCall(calls[2]);
    expect(revise).toContain("text-outside-artboard");
    expect(calls[2]?.content.some((b) => b.type === "image")).toBe(true);

    // The run's input: the brand's font files (WOFF2 subsets), colours, the logo pictures.
    const input = seen[0]?.input as Record<string, unknown>;
    const fonts = input.fonts as Record<
      string,
      { family: string; files: { path: string; style: string }[] }
    >;
    expect(fonts.display?.family).toBe("Archivo");
    expect(fonts.display?.files.map((f) => path.basename(f.path))).toEqual([
      "1-archivo-latin-wdth-normal.woff2",
      "2-archivo-latin-ext-wdth-normal.woff2",
      "3-archivo-latin-wdth-italic.woff2",
      "4-archivo-latin-ext-wdth-italic.woff2",
    ]);
    expect(fonts.display?.files[2]?.style).toBe("italic");
    expect((input.colors as Record<string, string>).ink).toMatch(/^#/);
    expect((input.pictures as { name: string }[]).some((p) => p.name.startsWith("logo/"))).toBe(
      true,
    );

    // The version: the renders shown, the program and its inputs on the first slide.
    expect(state.versionCreates).toHaveLength(1);
    const created = state.versionCreates[0];
    expect(created?.origin).toBe("generated");
    const html = created?.slides[0]?.html ?? "";
    expect(isCodeSlideHtml(html)).toBe(true);
    expect(html).toContain('<img src="/media/asset_gen_1.jpg"');
    const source = readCodeSource(created?.slides ?? []);
    expect(source?.program).toContain("# TEXT: headline|Hasat zamanı|96");
    expect(source?.inputs).toMatchObject({ size: { width: 1080, height: 1350 }, slots: {} });
    expect(readCodeRecord(html)?.texts[0]).toMatchObject({ id: "headline", text: "Hasat zamanı" });
    expect(created?.renderedAssetIds).toEqual(["asset_gen_1"]);
    expect(created?.layouts?.[0]).not.toBeNull();
    expect(state.contents.get("content_1")?.caption).toBe(
      "Toprağınız kışa hazır mı?\n\n#hasat #Toprak",
    );
    expect(out).toMatchObject({
      engine: "code",
      version: 1,
      lintClean: true,
      passes: [
        { pass: "v1", errors: 1, run: "error" },
        { pass: "v2", errors: 1 },
        { pass: "v3", errors: 0 },
      ],
      critique: ["high: Başlık taşıyor"],
    });
    expect(state.jobs.some((x) => x.type === "image.generate")).toBe(false);
  });

  it("refuses an unsafe program before running it and says so when no pass fixes it", async () => {
    const { api, state } = setup();
    const runner: ClaudeRunner = async () =>
      result(design("import subprocess\nsubprocess.run(['ls'])\n"));
    const seen: Seen[] = [];
    const handler = createContentGenerateHandler(deps(api, runner, fakeRunner(seen)));
    const { job: j, ctx } = job({ engine: "code" });
    await expect(handler.run(j.payload as never, ctx)).rejects.toThrow(/güvenlik denetiminden/);
    expect(seen).toHaveLength(0);
    expect(state.versionCreates).toHaveLength(0);
  });

  it("queues the consented AI picture for the slot; approving re-runs the program with it", async () => {
    const { api, state } = setup();
    const runner: ClaudeRunner = async () =>
      result(design(program(["# TEXT: headline|Hasat|96", "# SLOT: ai-image"])));
    const seen: Seen[] = [];
    const codeRunner = fakeRunner(seen);
    const handler = createContentGenerateHandler(deps(api, runner, codeRunner));
    const { job: j, ctx } = job({
      engine: "code",
      imageSlot: "ai_generate",
      slotImage: { consented: true },
      conversationId: "conv_1",
    });
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;
    const image = state.jobs.find((x) => x.type === "image.generate");
    expect(image?.payload).toMatchObject({
      aspectRatio: "1:1",
      approval: {
        kind: "product_image",
        contentId: "content_1",
        slotId: "ai-image",
        conversationId: "conv_1",
      },
    });
    expect(out.slotImages).toMatchObject({ jobs: [{ slotId: "ai-image" }] });
    const v1 = state.versions.find((v) => v.version === 1);
    expect(codeSlideSlots(v1?.slides[0]?.html)).toEqual([
      { id: "ai-image", state: "empty", ratio: "4:3", label: "AI görsel" },
    ]);

    // The approve route queues content.render { version, slotAssignments } on the code version.
    state.assets.set("asset_pic", {
      bytes: new Uint8Array(
        await sharp({ create: { width: 64, height: 48, channels: 3, background: "#2255AA" } })
          .png()
          .toBuffer(),
      ),
      contentType: "image/png",
    });
    state.assetRecords.push({
      id: "asset_pic",
      brandId: "brand_1",
      kind: "image",
      source: "generated",
      objectKey: "brands/brand_1/asset_pic",
      mimeType: "image/png",
      bytes: 10,
      sha256: "0".repeat(64),
      width: 1024,
      height: 1024,
      durationMs: null,
      originalFilename: null,
      createdAt: NOW,
    } as Asset);
    const render = createContentRenderHandler({ ...deps(api, runner, codeRunner) });
    const payload = {
      format: "jpeg" as const,
      version: 1,
      slotAssignments: { "ai-image": "asset_pic" },
      note: "Onaylanan görsel kod motorunun yuvasına yerleştirildi",
    };
    const rendered = await render.run(payload, {
      ...ctx,
      jobId: "job_render",
      job: { ...ctx.job, id: "job_render", type: "content.render", payload },
    });
    expect(rendered).toMatchObject({ version: 2 });
    // The same program ran again, with the picture as that slot's input.
    expect(seen).toHaveLength(seen.length);
    const rerun = seen.at(-1);
    expect(rerun?.program).toBe(seen[0]?.program);
    expect(Object.keys((rerun?.input.slots ?? {}) as object)).toEqual(["ai-image"]);
    const v2 = state.versions.find((v) => v.version === 2);
    expect(v2?.origin).toBe("manual_edit");
    expect(v2?.note).toContain("Onaylanan görsel kod motorunun yuvasına yerleştirildi");
    const html = v2?.slides[0]?.html ?? "";
    expect(isCodeSlideHtml(html)).toBe(true);
    expect(codeSlideSlots(html)[0]?.state).toBe("filled");
    expect(readCodeSource(v2?.slides ?? [])?.inputs?.slots).toEqual({ "ai-image": "asset_pic" });
    expect(v2?.slides[0]?.renderedAssetId).toBeTruthy();
    // A layer patch is refused on a code version.
    const patch = {
      format: "jpeg" as const,
      version: 2,
      patches: [{ op: "setText", layer: "headline", text: "y" }],
    };
    await expect(
      render.run(patch as never, {
        ...ctx,
        jobId: "job_patch",
        job: { ...ctx.job, id: "job_patch", type: "content.render", payload: patch },
      }),
    ).rejects.toThrow(/sohbetten/);
  });

  it("revises a stored code post from the chat (revise_post: base version + instruction, no engine)", async () => {
    const inputs: CodeInputs = {
      version: 1,
      size: { width: 1080, height: 1350 },
      safeArea: { top: 80, right: 80, bottom: 80, left: 80 },
      slides: { min: 1, max: 1 },
      language: "tr",
      profileVersion: 2,
      pictures: [],
      slots: { "ai-image": "asset_pic" },
    };
    const baseProgram = program(["# TEXT: headline|Hasat|96", "# SLOT: ai-image"]);
    const html = codeSlideHtml({
      index: 1,
      width: 1080,
      height: 1350,
      src: "/media/asset_render.jpg",
      record: null,
      program: baseProgram,
      inputs,
      lang: "tr",
    });
    const { api, state } = setup(
      draft({
        caption: "Eski açıklama",
        currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
      }),
    );
    state.assets.set("asset_render", {
      bytes: new Uint8Array(
        await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#fff" } })
          .jpeg()
          .toBuffer(),
      ),
      contentType: "image/jpeg",
    });
    state.assets.set("asset_pic", { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    state.versions.push({
      id: "ver_1",
      contentId: "content_1",
      version: 1,
      origin: "generated",
      contentHash: "a".repeat(64),
      slideCount: 1,
      note: null,
      jobId: "job_old",
      createdAt: NOW,
      updatedAt: NOW,
      slides: [{ html, width: 1080, height: 1350, renderedAssetId: "asset_render", layers: null }],
    });
    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result(
        design(program(["# TEXT: headline|Kış geldi|96", "# SLOT: ai-image"]), {
          caption: "Eski açıklama",
          hashtags: [],
          changes: ["Başlık değişti"],
        }),
      );
    };
    const seen: Seen[] = [];
    const handler = createContentGenerateHandler(deps(api, runner, fakeRunner(seen)));
    const { job: j, ctx } = job(
      { baseVersion: 1, instructions: "Başlığı “Kış geldi” yap" },
      "job_revise",
    );
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;
    expect(calls.map((c) => c.label)).toEqual(["code-edit-ontent_1"]);
    const prompt = textOfCall(calls[0]);
    expect(prompt).toContain("<instruction>");
    expect(prompt).toContain("Kış geldi");
    expect(prompt).toContain("<current_program>");
    expect(prompt).toContain("# TEXT: headline|Hasat|96");
    expect(calls[0]?.content.some((b) => b.type === "image")).toBe(true);
    expect(out).toMatchObject({ engine: "code", revised: true, baseVersion: 1, version: 2 });
    const v2 = state.versionCreates.at(-1);
    expect(v2?.origin).toBe("ai_edit");
    // The approved picture of the base stays in its slot.
    expect(Object.keys((seen[0]?.input.slots ?? {}) as object)).toEqual(["ai-image"]);
    expect(readCodeSource(v2?.slides ?? [])?.program).toContain("Kış geldi");
  });

  it("checks a code version on demand from its record, without Python or Chromium", async () => {
    const html = codeSlideHtml({
      index: 1,
      width: 1080,
      height: 1350,
      src: "/media/asset_render.jpg",
      record: {
        texts: [
          {
            id: "headline",
            text: "TAŞAN başlık",
            rect: { x: 700, y: 180, w: 900, h: 110 },
            fontSize: 96,
            weight: "800",
            family: "Archivo",
            color: "rgb(30, 58, 43)",
            lines: 1,
            legal: false,
            background: null,
          },
        ],
        images: [],
        slots: [],
        fonts: [{ family: "Archivo", status: "loaded" }],
      },
      program: program([]),
      lang: "tr",
    });
    const { api, state } = setup(
      draft({ currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) } }),
    );
    state.assets.set("asset_render", {
      bytes: new Uint8Array(
        await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#fff" } })
          .jpeg()
          .toBuffer(),
      ),
      contentType: "image/jpeg",
    });
    state.versions.push({
      id: "ver_1",
      contentId: "content_1",
      version: 1,
      origin: "generated",
      contentHash: "a".repeat(64),
      slideCount: 1,
      note: null,
      jobId: null,
      createdAt: NOW,
      updatedAt: NOW,
      slides: [{ html, width: 1080, height: 1350, renderedAssetId: null, layers: null }],
    });
    const runner: ClaudeRunner = async () => {
      throw new Error("no AI call expected");
    };
    const seen: Seen[] = [];
    const res = await runContentChecks({
      deps: deps(api, runner, fakeRunner(seen)),
      jobId: null,
      trigger: "manual",
      contentId: "content_1",
      fix: true,
      signal: new AbortController().signal,
    });
    const rules = (res.run?.results ?? []).map((r) => String(r.evidence?.rule ?? ""));
    expect(rules).toContain("text-outside-artboard");
    for (const contractRule of ["artboard-count", "brand-css-missing", "lang"])
      expect(rules).not.toContain(contractRule);
    expect(res.fixedVersion).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("fails clearly, with the setup path, when the Python runtime is not there", async () => {
    expect(await readyRuntime(mkdtempSync(path.join(tmpdir(), "worker-empty-")))).toBeNull();
    const { api, state } = setup();
    const runner: ClaudeRunner = async () => result(design(program(["# TEXT: headline|Hasat|96"])));
    const missing: CodeProgramRunner = {
      async run() {
        throw new CodeRuntimeError(
          `Kod motoru için Python ortamı hazır değil: bu Mac'te Python 3 (3.9 ya da yenisi) bulunamadı. ${SETUP_HINT}`,
        );
      },
    };
    const handler = createContentGenerateHandler(deps(api, runner, missing));
    const { job: j, ctx } = job({ engine: "code" });
    await expect(handler.run(j.payload as never, ctx)).rejects.toThrow(
      /Python ortamı hazır değil.*Python gerekli/,
    );
    expect(state.versionCreates).toHaveLength(0);
  });

  it("is ready; Reels are refused clearly", async () => {
    expect(isEngineReady("code")).toBe(true);
    const { api } = setup();
    const runner: ClaudeRunner = async () => {
      throw new Error("no AI call expected");
    };
    const handler = createContentGenerateHandler(deps(api, runner, fakeRunner()));
    const reel = job({ engine: "code", type: "reel" });
    await expect(handler.run(reel.job.payload as never, reel.ctx)).rejects.toThrow(/Reels/);
  });
});
