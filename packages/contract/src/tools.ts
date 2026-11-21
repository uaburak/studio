import { z } from "zod";
import { Timestamp } from "./common.ts";

/**
 * In-app tools (the "Araçlar" manager): the command-line programs Studio uses but does not carry,
 * installed on the Mac from their official sources by the worker (`tool.install` /
 * `tool.uninstall` jobs), so a brand-new Mac needs no Homebrew, Xcode or terminal.
 *
 * The worker reports every tool's status as `worker.tools` (on connect, after each job and while
 * an install runs); the hub keeps the latest list and shows it in presence as `tools` and at
 * `GET /api/tools`. Nothing downloads by itself: every install is an explicit action.
 *
 * Install layout (shared by the Mac app and the worker, `toolsBinDir`):
 *   <state>/tools/<id>/<version>/…   one folder per installed version (atomic rename)
 *   <state>/tools/<id>/current.json  what is installed (version, binaries, source)
 *   <state>/tools/bin/<name>         symlinks to the current version's binaries; first on PATH
 * where <state> is `~/Library/Application Support/Studio`.
 */

export const ToolId = z
  .enum(["claude", "gemini", "chromium", "ffmpeg", "python", "cloudflared", "whisper"])
  .meta({ id: "ToolId" });
export type ToolId = z.infer<typeof ToolId>;

/**
 * - `installed`: usable (Studio's own copy or one already on the Mac).
 * - `missing`: not found; `installable` says whether "Kur" can install it.
 * - `outdated`: Studio's copy is older than the pinned version (an update is offered).
 * - `installing`: a `tool.install` / `tool.uninstall` job runs (see `progress`).
 * - `failed`: the last install failed (`error`); the tool is otherwise missing.
 */
export const ToolState = z
  .enum(["installed", "missing", "outdated", "installing", "failed"])
  .meta({ id: "ToolState" });
export type ToolState = z.infer<typeof ToolState>;

export const ToolStatus = z
  .object({
    id: ToolId,
    label: z.string(),
    /** What Studio uses it for (Turkish, one sentence). */
    purpose: z.string(),
    /** Where it comes from, for people ("Anthropic (claude.ai)"). */
    source: z.string(),
    /** The official page or release the download comes from. */
    sourceUrl: z.string(),
    /** Approximate download size in bytes (null: decided at install time). */
    sizeBytes: z.number().int().min(0).nullable(),
    state: ToolState,
    /** Installed version (null: unknown or missing). */
    version: z.string().nullable(),
    /** The version an install puts in (null: the official channel's newest at install time). */
    targetVersion: z.string().nullable(),
    /** The binary Studio uses. */
    path: z.string().nullable(),
    /** Studio's own copy (`studio`) or one already on the Mac (`system`, never replaced). */
    location: z.enum(["studio", "system"]).nullable(),
    /** "Kur" / "Güncelle" can run on this Mac. */
    installable: z.boolean(),
    /** Studio's own copy can be removed. */
    removable: z.boolean(),
    /** Optional for Studio (whisper, cloudflared …): nothing breaks without it. */
    optional: z.boolean(),
    /** Extra information (Turkish), e.g. why it cannot be installed in the app yet. */
    note: z.string().nullable(),
    /** The last failure (Turkish), with `state: "failed"`. */
    error: z.string().nullable(),
    /** 0..1 while installing. */
    progress: z.number().min(0).max(1).nullable(),
    /** The running install / uninstall job. */
    jobId: z.string().nullable(),
  })
  .meta({ id: "ToolStatus" });
export type ToolStatus = z.infer<typeof ToolStatus>;

/** `GET /api/tools` and the answer of `POST /api/tools/refresh`. */
export const ToolsControl = z
  .object({
    tools: z.array(ToolStatus),
    /** The Mac worker is connected (installs can run). */
    online: z.boolean(),
    /** When the worker last reported the list (null: never). */
    reportedAt: Timestamp.nullable(),
    /** Workers a refresh was sent to (0 for GET). */
    sent: z.number().int().min(0),
  })
  .meta({ id: "ToolsControl" });
export type ToolsControl = z.infer<typeof ToolsControl>;

/** `tool.install`: install (or with `update`, replace Studio's copy with) a tool. */
export const ToolInstallPayload = z
  .object({
    toolId: ToolId,
    /** Replace Studio's own copy even when it is current (Güncelle / yeniden kur). */
    update: z.boolean().optional(),
  })
  .meta({ id: "ToolInstallPayload" });
export type ToolInstallPayload = z.infer<typeof ToolInstallPayload>;

/** `tool.uninstall`: remove Studio's own copy (a copy already on the Mac is never touched). */
export const ToolUninstallPayload = z
  .object({ toolId: ToolId })
  .meta({ id: "ToolUninstallPayload" });
export type ToolUninstallPayload = z.infer<typeof ToolUninstallPayload>;

/** Output of `tool.install` / `tool.uninstall`: the tool's status afterwards. */
export const ToolJobOutput = z
  .object({ tool: ToolStatus, message: z.string() })
  .meta({ id: "ToolJobOutput" });
export type ToolJobOutput = z.infer<typeof ToolJobOutput>;

/** `POST /api/tools/{id}/install` body. */
export const ToolInstallRequest = z
  .object({ update: z.boolean().optional() })
  .meta({ id: "ToolInstallRequest" });
export type ToolInstallRequest = z.infer<typeof ToolInstallRequest>;

// --- paths shared by the Mac app and the worker ------------------------------------------------

/** `~/Library/Application Support/Studio` (macOS only; Studio is a Mac app). */
export function studioStateDir(home: string): string {
  return `${home.replace(/\/+$/, "")}/Library/Application Support/Studio`;
}

/** `<state>/tools`: where Studio installs its tools. */
export function studioToolsDir(stateDir: string): string {
  return `${stateDir.replace(/\/+$/, "")}/tools`;
}

/** `<tools>/bin`: the current version of every tool, first on every child's PATH. */
export function toolsBinDir(toolsDir: string): string {
  return `${toolsDir.replace(/\/+$/, "")}/bin`;
}

/** PATH with Studio's tools first (Studio's own copy wins over the system's, P1). */
export function pathWithTools(path: string, toolsDir: string): string {
  const bin = toolsBinDir(toolsDir);
  return [bin, ...path.split(":").filter((p) => p && p !== bin)].join(":");
}

// --- the manifest ------------------------------------------------------------------------------

export type ToolArch = "arm64" | "x64";

/** A pinned download: verified by SHA-256 before anything is unpacked. */
export interface PinnedArtifact {
  url: string;
  sha256: string;
  size: number;
  archive: "zip" | "tar.gz" | "tgz";
  /** `[path inside the archive, name in tools/bin]`. */
  binaries: readonly (readonly [string, string])[];
}

export interface ToolManifestEntry {
  id: ToolId;
  label: string;
  purpose: string;
  source: string;
  sourceUrl: string;
  optional: boolean;
  /** Names Studio looks for on the Mac (PATH, Homebrew, ~/.local/bin). */
  commands: readonly string[];
  /** Arguments that print the version (`--version`). */
  versionArgs: readonly string[];
  /**
   * How it installs:
   * - `pinned`: the artifacts below (version + SHA-256 in this file).
   * - `claude-channel`: Anthropic's native installer channel (`stable`), checked against its
   *   release manifest's SHA-256 (what https://claude.ai/install.sh does) and Anthropic's
   *   Developer ID signature; never redistributed by Studio.
   * - `npm`: the official npm registry tarball, checked against the registry's sha512 integrity.
   * - `playwright`: the bundled Playwright installer (Chromium headless shell).
   * - `none`: not installable in the app yet (`note` says why).
   */
  kind: "pinned" | "claude-channel" | "npm" | "playwright" | "none";
  version: string | null;
  sizeBytes: number | null;
  artifacts?: Partial<Record<ToolArch, PinnedArtifact>>;
  /** Apple Developer ID team that signs the binaries (checked with `codesign`), when signed. */
  teamId?: Partial<Record<ToolArch, string>>;
  npmPackage?: string;
  channelUrl?: string;
  note?: string;
  /** An extra file the tool needs (whisper's model), pinned like an artifact. */
  extra?: { url: string; sha256: string; size: number; name: string; label: string };
}

/**
 * Pinned versions and hashes: the one place to bump them.
 *
 * To bump a pinned tool: take the new release's URL, download it, run
 * `shasum -a 256 <file>` and `stat -f %z <file>` (or read the release's own published digest:
 * `gh release view --repo <owner/repo> --json assets` lists `sha256:` digests, Martin Riedl's
 * builds have `<file>.sha256` next to them, python-build-standalone publishes SHA256SUMS), then
 * change `version`, `url`, `sha256` and `size` together. `pnpm -C apps/worker tools:e2e` downloads,
 * verifies and runs every pinned tool in a temporary folder (never the real state folder).
 */
export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  {
    id: "claude",
    label: "Claude Code",
    purpose: "Claude ile sohbet ve üretim.",
    source: "Anthropic (claude.ai)",
    sourceUrl: "https://claude.ai/install.sh",
    optional: false,
    commands: ["claude"],
    versionArgs: ["--version"],
    kind: "claude-channel",
    version: null,
    sizeBytes: 345_000_000,
    channelUrl: "https://downloads.claude.ai/claude-code-releases",
    teamId: { arm64: "Q6L2SF6YDW", x64: "Q6L2SF6YDW" },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    purpose: "Gemini modelleriyle sohbet (Google hesabıyla).",
    source: "Google (npm: @google/gemini-cli)",
    sourceUrl: "https://www.npmjs.com/package/@google/gemini-cli",
    optional: true,
    commands: ["gemini"],
    versionArgs: ["--version"],
    kind: "npm",
    version: null,
    sizeBytes: 20_000_000,
    npmPackage: "@google/gemini-cli",
  },
  {
    id: "chromium",
    label: "Chromium",
    purpose: "Görselleri ve Reels karelerini oluşturur.",
    source: "Playwright (Microsoft)",
    sourceUrl: "https://playwright.dev/docs/browsers",
    optional: false,
    commands: [],
    versionArgs: [],
    kind: "playwright",
    version: null,
    sizeBytes: 100_000_000,
  },
  {
    id: "ffmpeg",
    label: "ffmpeg",
    purpose: "Reels videolarını birleştirir.",
    source: "FFmpeg, Martin Riedl'in imzalı macOS derlemesi",
    sourceUrl: "https://ffmpeg.martin-riedl.de/",
    optional: false,
    commands: ["ffmpeg"],
    versionArgs: ["-version"],
    kind: "pinned",
    version: "9.1",
    sizeBytes: 28_623_086,
    artifacts: {
      arm64: {
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1795207104_9.1/ffmpeg.zip",
        sha256: "1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1",
        size: 28_623_086,
        archive: "zip",
        binaries: [["ffmpeg", "ffmpeg"]],
      },
      x64: {
        url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1795212433_9.1/ffmpeg.zip",
        sha256: "35b3d82cccc2c1d644d49d15f5e57eb913a08ef68f798042c90eecec62c51f1e",
        size: 34_064_287,
        archive: "zip",
        binaries: [["ffmpeg", "ffmpeg"]],
      },
    },
    teamId: { arm64: "KU3N25YGLU", x64: "KU3N25YGLU" },
  },
  {
    id: "python",
    label: "Python",
    purpose: "Kod motoru (Python ile çizim) için; paketleri PyPI'dan kurulur.",
    source: "python-build-standalone (Astral) + PyPI",
    sourceUrl: "https://github.com/astral-sh/python-build-standalone/releases/tag/20261110",
    optional: true,
    commands: [],
    versionArgs: ["--version"],
    kind: "pinned",
    version: "3.12.16",
    sizeBytes: 25_237_581,
    artifacts: {
      arm64: {
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-aarch64-apple-darwin-install_only_stripped.tar.gz",
        sha256: "2f11b8aa3726bdbd87dd9eb76568412faddf4f47e26913fa45d6a2e424972acd",
        size: 25_237_581,
        archive: "tar.gz",
        binaries: [["python/bin/python3", "studio-python3"]],
      },
      x64: {
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-apple-darwin-install_only_stripped.tar.gz",
        sha256: "b78a4c479f1964ec484880bee567568266f68da102269fb93a05fe8716b45f91",
        size: 24_957_926,
        archive: "tar.gz",
        binaries: [["python/bin/python3", "studio-python3"]],
      },
    },
  },
  {
    id: "cloudflared",
    label: "cloudflared",
    purpose: "Uzaktan erişim (Cloudflare Tunnel) için.",
    source: "Cloudflare (GitHub sürümü)",
    sourceUrl: "https://github.com/cloudflare/cloudflared/releases/tag/2026.11.1",
    optional: true,
    commands: ["cloudflared"],
    versionArgs: ["--version"],
    kind: "pinned",
    version: "2026.11.1",
    sizeBytes: 19_898_712,
    artifacts: {
      arm64: {
        url: "https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-darwin-arm64.tgz",
        sha256: "02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462",
        size: 19_898_712,
        archive: "tgz",
        binaries: [["cloudflared", "cloudflared"]],
      },
      x64: {
        url: "https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-darwin-amd64.tgz",
        sha256: "5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f",
        size: 21_857_340,
        archive: "tgz",
        binaries: [["cloudflared", "cloudflared"]],
      },
    },
  },
  {
    id: "whisper",
    label: "whisper.cpp",
    purpose: "İsteğe bağlı: Reels altyazıları için konuşmayı yerelde yazıya döker (yoksa Gemini).",
    source: "whisper.cpp (ggml-org) + model: Hugging Face ggerganov/whisper.cpp",
    sourceUrl: "https://github.com/ggml-org/whisper.cpp/releases",
    optional: true,
    commands: ["whisper-cli", "whisper-cpp"],
    versionArgs: ["--help"],
    kind: "none",
    version: null,
    sizeBytes: 487_601_967,
    note: "whisper.cpp macOS için hazır program yayımlamıyor; uygulama içinden kurulamaz. Mac'te whisper-cli varsa model buradan indirilebilir.",
    extra: {
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
      sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
      size: 487_601_967,
      name: "ggml-small.bin",
      label: "ggml-small modeli",
    },
  },
];

export function toolManifest(id: ToolId): ToolManifestEntry {
  const entry = TOOL_MANIFEST.find((t) => t.id === id);
  if (!entry) throw new Error(`unknown tool ${id}`);
  return entry;
}

/** "~80 MB" for a consent card or a row. */
export function formatToolSize(bytes: number | null): string {
  if (bytes === null) return "boyutu kurulumda belli olur";
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${Math.max(1, Math.round(mb))} MB`;
}

/** A feature's missing tool, as a feature shows it ("ffmpeg gerekli · Kur"). */
export function toolRequiredText(id: ToolId): string {
  return `${toolManifest(id).label} gerekli · Ayarlar → Gelişmiş → Araçlar'dan Kur`;
}
