// The desktop's typecheck / test / build guard (E18): on a checkout without the vendored Wecra it
// says how to vendor it and stops — or, in the root's recursive run (`STUDIO_WECRA_OPTIONAL=1`),
// reports the desktop's part as skipped and runs only what needs no Wecra.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const GUARD = resolve(import.meta.dirname, "../../scripts/wecra-guard.mjs");

/** A desktop folder with the guard and (optionally) a vendored copy's VERSION.json. */
function checkout(vendored: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "wecra-guard-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(GUARD, join(root, "scripts/wecra-guard.mjs"));
  if (vendored) {
    const dir = join(root, "src/renderer/vendor/wecra-editor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "VERSION.json"), JSON.stringify({ commit: "abc", files: {} }));
    // The real check needs the real script; a stand-in that says the copy matches.
    writeFileSync(join(root, "scripts/vendor-wecra.mjs"), "process.exit(0);\n");
  }
  return root;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function run(root: string, args: string[], optional = false) {
  const env = { ...process.env };
  if (optional) env.STUDIO_WECRA_OPTIONAL = "1";
  else delete env.STUDIO_WECRA_OPTIONAL;
  const r = spawnSync(process.execPath, [join(root, "scripts/wecra-guard.mjs"), ...args], {
    env,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A command printing "RAN" (the word itself is not in its text, which the guard may quote). */
const node = () => [process.execPath, "-e", "console.log(String.fromCharCode(82, 65, 78))"];

describe("wecra-guard (E18)", () => {
  it("stops a desktop command on a checkout without Wecra, saying how to vendor it", () => {
    const root = checkout(false);
    roots.push(root);
    const r = run(root, ["--", ...node()]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Wecra düzenleyicisi bu kopyada yok");
    expect(r.out).toContain("Wecra's editor is not vendored");
    expect(r.out).toContain("node apps/desktop/scripts/vendor-wecra.mjs");
    expect(r.out).not.toMatch(/^RAN$/m);
  });

  it("reports the desktop as skipped in the root's run, and runs only what needs no Wecra", () => {
    const root = checkout(false);
    roots.push(root);
    const skipped = run(root, ["--", ...node()], true);
    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain("atlandı / skipped");
    expect(skipped.out).not.toMatch(/^RAN$/m);
    const without = run(
      root,
      ["--without", `${process.execPath} -e console.log(1+1)`, "--", ...node()],
      true,
    );
    expect(without.code).toBe(0);
    expect(without.out).toMatch(/^2$/m);
  });

  it("runs the command (its exit code) when Wecra is vendored and checks out", () => {
    const root = checkout(true);
    roots.push(root);
    const ok = run(root, ["--", ...node()]);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.out).toMatch(/^RAN$/m);
    const failing = run(root, ["--", process.execPath, "-e", "process.exit(3)"]);
    expect(failing.code).toBe(3);
  });
});
