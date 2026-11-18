// Tools the worker needs that Studio.app does not carry (S3, P1), and what Settings says about
// them:
//
// - Chromium (Playwright's headless shell) for rendering: found in the state folder
//   (`<state>/browsers`, where Studio installs it) or Playwright's own cache
//   (`~/Library/Caches/ms-playwright`, a developer's install). When neither has the revision the
//   bundled playwright-core wants, Settings offers to install it into the state folder with the
//   bundled installer (`playwright-core install --only-shell chromium`), never on its own.
// - ffmpeg and whisper.cpp for Reels: the login shell's PATH plus Homebrew's folders; Settings
//   gives the one-line `brew install`.
// - The AI CLIs (claude, gemini, codex, agy) and cloudflared: the login shell's PATH (read in the
//   background, environment.ts).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChromiumStatus, ToolInfo } from "../../shared/system-ipc.ts";
import type { ChildLayout, NodeRuntime } from "./layout.ts";

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
      "Görselleri ve Reels'i oluşturmak için Chromium gerekiyor (yaklaşık 100 MB). Ayarlar → Gelişmiş → Araçlar'dan “Chromium'u indir”e tıkla.",
  };
}

/** The worker's PLAYWRIGHT_BROWSERS_PATH (none when Playwright's default cache has it). */
export function chromiumEnv(layout: ChildLayout, stateDir: string): Record<string, string> {
  const found = findChromium(layout, stateDir);
  return found.browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: found.browsersPath } : {};
}

/** Percent values in the installer's output ("… 42% of 90 MiB"). */
export function parseInstallProgress(text: string): number | null {
  const matches = [...text.matchAll(/(\d{1,3})%/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  const value = Number(last);
  return value >= 0 && value <= 100 ? value : null;
}

/**
 * Installs the headless shell into the state folder with the layout's own playwright-core (the
 * only network use of this module; started by the owner from Settings).
 */
export class ChromiumInstaller {
  private status: ChromiumStatus | null = null;
  private running: Promise<ChromiumStatus> | null = null;

  constructor(
    private readonly o: {
      stateDir: string;
      layout: () => ChildLayout | null;
      runtime: (layout: ChildLayout) => Promise<NodeRuntime | null>;
      onChange?: (status: ChromiumStatus) => void;
      log?: (message: string) => void;
    },
  ) {}

  current(): ChromiumStatus {
    if (this.status && (this.status.state === "installing" || this.status.state === "failed")) {
      return this.status;
    }
    const layout = this.o.layout();
    if (!layout) {
      return {
        state: "missing",
        revision: null,
        browsersPath: null,
        location: null,
        progress: null,
        message: "Studio'nun sunucu dosyaları bulunamadı.",
      };
    }
    return { ...findChromium(layout, this.o.stateDir), progress: null };
  }

  private set(status: ChromiumStatus): void {
    this.status = status;
    this.o.onChange?.(status);
  }

  install(): Promise<ChromiumStatus> {
    if (this.running) return this.running;
    this.running = this.perform().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async perform(): Promise<ChromiumStatus> {
    const layout = this.o.layout();
    const runtime = layout ? await this.o.runtime(layout) : null;
    const before = this.current();
    if (!layout || !runtime) {
      const failed: ChromiumStatus = {
        ...before,
        state: "failed",
        message: "Chromium kurulamadı: Node çalıştırılamıyor.",
      };
      this.set(failed);
      return failed;
    }
    const target = stateBrowsersDir(this.o.stateDir);
    mkdirSync(target, { recursive: true });
    this.set({
      ...before,
      state: "installing",
      progress: 0,
      browsersPath: target,
      message: "Chromium indiriliyor…",
    });
    const cli = join(playwrightCoreDir(layout), "cli.js");
    const code = await new Promise<number>((resolve) => {
      const child = spawn(
        runtime.executable,
        [...runtime.args, cli, "install", "--only-shell", "chromium"],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: homedir(),
            ...runtime.env,
            PLAYWRIGHT_BROWSERS_PATH: target,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.o.log?.(`chromium install: ${text.trim()}`);
        const progress = parseInstallProgress(text);
        if (progress !== null && this.status?.state === "installing") {
          this.set({ ...this.status, progress, message: `Chromium indiriliyor… %${progress}` });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", () => resolve(-1));
      child.once("exit", (exitCode) => resolve(exitCode ?? -1));
    });
    this.status = null;
    const after = this.current();
    if (code === 0 && after.state === "ready") {
      this.set(after);
      return after;
    }
    const failed: ChromiumStatus = {
      ...after,
      state: "failed",
      progress: null,
      message: `Chromium kurulamadı (çıkış kodu ${code}). İnternet bağlantısını denetleyip tekrar dene; ayrıntı desktop.log'da.`,
    };
    this.set(failed);
    return failed;
  }
}

// --- command-line tools -------------------------------------------------------------------------

/** Homebrew and Studio's own tool folders (Finder-launched apps get a short PATH). */
export function toolDirs(path: string, home = homedir()): string[] {
  const dirs = path.split(":").filter(Boolean);
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

/** What Settings shows about the tools Studio uses but does not carry. */
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
      "Reels videoları için gerekli. Terminalde kur (Homebrew yoksa önce https://brew.sh):",
      "brew install ffmpeg",
    ),
    {
      ...tool(
        "whisper",
        "whisper.cpp",
        whisper,
        model
          ? "Klipteki konuşma yazıya dökülebilir."
          : "Kurulu ama model yok: bir ggml modelini ~/.studio/models/ altına koy (ör. ggml-small.bin).",
        "İsteğe bağlı: Reels altyazıları için konuşmayı yerelde yazıya döker (yoksa Gemini kullanılır). Kurmak için:",
        "brew install whisper-cpp",
      ),
    },
    tool(
      "claude",
      "Claude Code",
      find("claude"),
      "Sohbet ve üretim Claude ile çalışabilir.",
      "Claude ile sohbet ve üretim için gerekli. Kurmak için:",
      "curl -fsSL https://claude.ai/install.sh | bash",
    ),
    tool(
      "gemini",
      "Gemini CLI",
      find("gemini"),
      "Gemini CLI hazır.",
      "İsteğe bağlı (Gemini API anahtarı da yeterli). Kurmak için:",
      "brew install gemini-cli",
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
      "Yalnızca uzaktan erişim (Cloudflare Tunnel) için. Kurmak için:",
      "brew install cloudflared",
    ),
  ];
}
