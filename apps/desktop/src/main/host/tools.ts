// Tools the worker needs that Studio.app does not carry (S3, P1), as the Mac app sees them before
// the worker runs. Installing them is the worker's job (`tool.install`, Ayarlar → Gelişmiş →
// Araçlar, the chat's `install_tool`; apps/worker/src/tools): this file only finds them.
//
// - Chromium (Playwright's headless shell) for rendering: found in the state folder
//   (`<state>/browsers`, where Studio installs it) or Playwright's own cache
//   (`~/Library/Caches/ms-playwright`, a developer's install); the worker gets
//   PLAYWRIGHT_BROWSERS_PATH from here.
// - Everything else: Studio's own `<state>/tools/bin` first, then the login shell's PATH plus
//   Homebrew's folders (the same order as the worker, contract `pathWithTools`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { studioStateDir, studioToolsDir, toolsBinDir } from "@studio/contract";
import type { ChromiumStatus, ToolInfo } from "../../shared/system-ipc.ts";
import type { ChildLayout } from "./layout.ts";

export type { ChromiumStatus, ToolInfo };

/** The playwright-core the worker uses (dev: the worker's own; packaged: the bundled one). */
export function playwrightCoreDir(layout: ChildLayout): string {
  return layout.mode === "packaged"
    ? join(layout.root, "node_modules", "playwright-core")
    : join(layout.root, "apps", "worker", "node_modules", "playwright-core");
}

/** The headless shell revision a playwright-core wants (browsers.json), null when unreadable. */
export function chromiumRevision(playwrightDir: string): string | null {
  try {
    const data = JSON.parse(readFileSync(join(playwrightDir, "browsers.json"), "utf8")) as {
      browsers?: { name?: string; revision?: string }[];
    };
    const shell = data.browsers?.find((b) => b.name === "chromium-headless-shell");
    return typeof shell?.revision === "string" ? shell.revision : null;
  } catch {
    return null;
  }
}

export function stateBrowsersDir(stateDir: string): string {
  return join(stateDir, "browsers");
}

export function playwrightCacheDir(home = homedir()): string {
  return join(home, "Library", "Caches", "ms-playwright");
}

/** Whether `<dir>` holds a complete headless shell of `revision`. */
export function hasHeadlessShell(dir: string, revision: string): boolean {
  return existsSync(join(dir, `chromium_headless_shell-${revision}`, "INSTALLATION_COMPLETE"));
}

/** Where Chromium is for this layout, and the worker's PLAYWRIGHT_BROWSERS_PATH. */
export function findChromium(
  layout: ChildLayout,
  stateDir: string,
  home = homedir(),
): Omit<ChromiumStatus, "progress"> {
  const revision = chromiumRevision(playwrightCoreDir(layout));
  const state = stateBrowsersDir(stateDir);
  if (revision && hasHeadlessShell(state, revision)) {
    return {
      state: "ready",
      revision,
      browsersPath: state,
      location: "state",
      message: `Chromium hazır (Studio'nun klasöründe, sürüm ${revision}).`,
    };
  }
  if (revision && hasHeadlessShell(playwrightCacheDir(home), revision)) {
    return {
      state: "ready",
      revision,
      browsersPath: null,
      location: "cache",
      message: `Chromium hazır (Playwright önbelleğinde, sürüm ${revision}).`,
    };
  }
  return {
    state: "missing",
    revision,
    // Point the worker at the state folder, where an install from Settings goes.
    browsersPath: state,
    location: null,
    message:
      "Chromium gerekli · Görseller ve Reels için Ayarlar → Gelişmiş → Araçlar'dan Kur (~100 MB).",
  };
}

/** The worker's PLAYWRIGHT_BROWSERS_PATH (none when Playwright's default cache has it). */
export function chromiumEnv(layout: ChildLayout, stateDir: string): Record<string, string> {
  const found = findChromium(layout, stateDir);
  return found.browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: found.browsersPath } : {};
}

// --- command-line tools -------------------------------------------------------------------------

/** Studio's own tools, then PATH, Homebrew and the user's folders (Finder-launched apps get a short PATH). */
export function toolDirs(path: string, home = homedir()): string[] {
  const own = toolsBinDir(studioToolsDir(studioStateDir(home)));
  const dirs = [own, ...path.split(":").filter((d) => d && d !== own)];
  for (const extra of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".studio", "bin"),
  ]) {
    if (!dirs.includes(extra)) dirs.push(extra);
  }
  return dirs;
}

/** A whisper.cpp ggml model in the folders the worker searches (transcribe.ts). */
export function findWhisperModel(home = homedir()): string | null {
  const dirs = [
    join(home, ".studio", "models"),
    "/opt/homebrew/share/whisper-cpp",
    "/opt/homebrew/share/whisper-cpp/models",
    "/usr/local/share/whisper-cpp",
    "/usr/local/share/whisper-cpp/models",
  ];
  for (const dir of dirs) {
    try {
      const hit = readdirSync(dir).find((n) => /^ggml-.*\.bin$/.test(n));
      if (hit) return join(dir, hit);
    } catch {
      // not there
    }
  }
  return null;
}

/** How the in-app tools install (the worker's `tool.install`). */
export const IN_APP = "Ayarlar → Gelişmiş → Araçlar → Kur";

/** What the self-test reports about the tools Studio uses but does not carry. */
export function detectTools(
  path: string,
  which: (tool: string, path: string) => string | null,
  home = homedir(),
): ToolInfo[] {
  const search = toolDirs(path, home).join(":");
  const find = (...names: string[]) => {
    for (const name of names) {
      const hit = which(name, search);
      if (hit) return hit;
    }
    return null;
  };
  const tool = (
    id: string,
    label: string,
    found: string | null,
    ok: string,
    missing: string,
    install: string | null,
  ): ToolInfo => ({
    id,
    label,
    state: found ? "ok" : "missing",
    path: found,
    detail: found ? ok : missing,
    install: found ? null : install,
  });
  const whisper = find("whisper-cli", "whisper-cpp");
  const model = whisper ? findWhisperModel(home) : null;
  return [
    tool(
      "ffmpeg",
      "ffmpeg",
      find("ffmpeg"),
      "Reels videoları birleştirilebilir.",
      "Reels videoları için gerekli.",
      IN_APP,
    ),
    {
      ...tool(
        "whisper",
        "whisper.cpp",
        whisper,
        model
          ? "Klipteki konuşma yazıya dökülebilir."
          : "Kurulu ama model yok: bir ggml modelini ~/.studio/models/ altına koy (ör. ggml-small.bin).",
        "İsteğe bağlı: Reels altyazıları için konuşmayı yerelde yazıya döker (yoksa Gemini kullanılır).",
        null,
      ),
    },
    tool(
      "claude",
      "Claude Code",
      find("claude"),
      "Sohbet ve üretim Claude ile çalışabilir.",
      "Claude ile sohbet ve üretim için gerekli.",
      IN_APP,
    ),
    tool(
      "gemini",
      "Gemini CLI",
      find("gemini"),
      "Gemini CLI hazır.",
      "İsteğe bağlı (Gemini API anahtarı da yeterli).",
      IN_APP,
    ),
    tool(
      "codex",
      "Codex CLI",
      find("codex"),
      "Codex CLI hazır.",
      "İsteğe bağlı. Kurmak için:",
      "brew install codex",
    ),
    tool(
      "cloudflared",
      "cloudflared",
      find("cloudflared"),
      "Uzaktan erişim tüneli kurulabilir.",
      "Yalnızca uzaktan erişim (Cloudflare Tunnel) için.",
      IN_APP,
    ),
  ];
}
