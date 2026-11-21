// The tool manager (contract tools.ts): status of every tool Studio uses on the Mac, and the
// installs / removals the `tool.install` / `tool.uninstall` jobs run. Everything runs on the Mac,
// so an install can be started from the Mac app, the iPhone or the chat alike.
//
// Rules: nothing downloads by itself (only a job installs); every download is verified
// (pinned SHA-256, the official channel's SHA-256, npm's sha512 integrity, Apple Developer ID team
// with `codesign`) before anything is unpacked or run; an install is built in `tools/.tmp/` and
// moved into place with a rename, then `tools/bin/<name>` is switched with a rename of a fresh
// symlink; a copy the Mac already has (Homebrew, PATH) is never installed over nor removed.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  TOOL_MANIFEST,
  type ToolArch,
  type ToolId,
  type ToolManifestEntry,
  type ToolStatus,
  toolsBinDir,
} from "@studio/contract";
import { execFileCapped } from "../generate/code/runtime.ts";
import { downloadVerified, ToolVerifyError } from "./download.ts";
import { findSystemExecutable, isExecutableFile } from "./paths.ts";

export { ToolVerifyError };

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal },
) => Promise<ExecResult>;

/** What Studio's copy of a tool is (`tools/<id>/current.json`). */
export interface InstallRecord {
  id: ToolId;
  version: string;
  /** Folder of this version (`tools/<id>/<version>`). */
  dir: string;
  /** `[path inside dir, name in tools/bin]`. */
  binaries: [string, string][];
  /** Extra files (whisper's model), absolute. */
  files?: string[];
  source: string;
  sha256?: string;
  installedAt: string;
}

export interface ChromiumHooks {
  /** The headless shell revision the bundled playwright-core wants (null: unknown). */
  revision(): string | null;
  /** Where it is installed (Studio's browsers folder or Playwright's cache). */
  find(): { path: string; location: "studio" | "system" } | null;
  /** Install into Studio's browsers folder; progress 0..1. */
  install(onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void>;
  /** Remove Studio's copy. */
  remove(): Promise<void>;
}

export interface PythonHooks {
  /** A Python 3.9+ already on the Mac (Homebrew / STUDIO_CODE_PYTHON; never the CLT stub). */
  systemPython(): Promise<{ python: string; version: string } | null>;
  /** The code engine's virtualenv is built and current. */
  ready(): Promise<boolean>;
  /** Build the code engine's virtualenv from `python` (pip installs from PyPI). */
  setup(python: string, signal: AbortSignal, log: (line: string) => void): Promise<void>;
  /** Drop the virtualenv (it pointed at Studio's Python, which is being removed). */
  remove(): Promise<void>;
}

export interface WhisperHooks {
  /** whisper-cli on the Mac (it cannot be installed in the app). */
  binary(): string | null;
  /** A ggml model the worker would use (any folder it searches). */
  model(): string | null;
}

export interface ToolManagerOptions {
  toolsDir: string;
  arch?: ToolArch;
  fetch?: typeof globalThis.fetch;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  /** Node to run npm tools with (Electron in Node mode when packaged). */
  node?: { executable: string; args: string[]; env: Record<string, string> };
  chromium?: ChromiumHooks;
  python?: PythonHooks;
  whisper?: WhisperHooks;
  manifest?: readonly ToolManifestEntry[];
  /** Skip `codesign` (tests; never in the app). */
  skipSignatureCheck?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface InstallContext {
  jobId: string;
  signal: AbortSignal;
  progress(value: number, message?: string): void;
}

interface Active {
  jobId: string;
  progress: number;
  message: string | null;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ToolManager {
  readonly toolsDir: string;
  private readonly arch: ToolArch;
  private readonly fetch: typeof globalThis.fetch;
  private readonly exec: ExecFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly manifest: readonly ToolManifestEntry[];
  private readonly active = new Map<ToolId, Active>();
  private readonly failures = new Map<ToolId, string>();
  private readonly versionCache = new Map<string, { mtime: number; version: string | null }>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly o: ToolManagerOptions) {
    this.toolsDir = o.toolsDir;
    this.arch = o.arch ?? (process.arch === "arm64" ? "arm64" : "x64");
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.exec = o.exec ?? execFileCapped;
    this.env = o.env ?? process.env;
    this.manifest = o.manifest ?? TOOL_MANIFEST;
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? (() => {});
  }

  get binDir(): string {
    return toolsBinDir(this.toolsDir);
  }

  /** Called when a status changed (an install started, progressed or ended). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  entry(id: ToolId): ToolManifestEntry {
    const e = this.manifest.find((m) => m.id === id);
    if (!e) throw new Error(`bilinmeyen araç: ${id}`);
    return e;
  }

  // --- records ---------------------------------------------------------------------------------

  private recordFile(id: ToolId): string {
    return path.join(this.toolsDir, id, "current.json");
  }

  /** Studio's copy, when its record is there and its binaries / files still exist. */
  record(id: ToolId): InstallRecord | null {
    try {
      const r = JSON.parse(readFileSync(this.recordFile(id), "utf8")) as InstallRecord;
      if (r.id !== id || typeof r.version !== "string" || !Array.isArray(r.binaries)) return null;
      for (const [rel] of r.binaries) {
        if (!isExecutableFile(path.join(r.dir, rel))) return null;
      }
      for (const f of r.files ?? []) if (!existsSync(f)) return null;
      return r;
    } catch {
      return null;
    }
  }

  // --- status ----------------------------------------------------------------------------------

  async statuses(): Promise<ToolStatus[]> {
    const out: ToolStatus[] = [];
    for (const e of this.manifest) out.push(await this.status(e.id));
    return out;
  }

  /** The first line's version-looking token of `<bin> <args>` (cached by path + mtime). */
  private async probeVersion(bin: string, args: readonly string[]): Promise<string | null> {
    if (args.length === 0) return null;
    let mtime = 0;
    try {
      mtime = (await stat(bin)).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.versionCache.get(bin);
    if (cached && cached.mtime === mtime) return cached.version;
    let version: string | null = null;
    try {
      const res = await this.exec(bin, args, {
        timeoutMs: 8_000,
        env: { PATH: this.env.PATH ?? "/usr/bin:/bin", HOME: this.env.HOME ?? "/tmp" },
      });
      const text = `${res.stdout}\n${res.stderr}`;
      version = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(text)?.[1] ?? null;
    } catch {
      version = null;
    }
    this.versionCache.set(bin, { mtime, version });
    return version;
  }

  async status(id: ToolId): Promise<ToolStatus> {
    const e = this.entry(id);
    const active = this.active.get(id) ?? null;
    const failure = this.failures.get(id) ?? null;
    const base = {
      id,
      label: e.label,
      purpose: e.purpose,
      source: e.source,
      sourceUrl: e.sourceUrl,
      sizeBytes: this.sizeOf(e),
      targetVersion: e.kind === "pinned" ? e.version : null,
      optional: e.optional,
      progress: active ? active.progress : null,
      jobId: active?.jobId ?? null,
    };
    const finish = (s: {
      state: ToolStatus["state"];
      version: string | null;
      path: string | null;
      location: ToolStatus["location"];
      installable: boolean;
      removable: boolean;
      note: string | null;
    }): ToolStatus => {
      let state = s.state;
      if (active) state = "installing";
      else if (failure && (state === "missing" || state === "outdated")) state = "failed";
      return {
        ...base,
        ...s,
        state,
        note: active?.message ?? s.note,
        error: !active && state === "failed" ? failure : null,
      };
    };

    if (id === "chromium") {
      const hooks = this.o.chromium;
      const found = hooks?.find() ?? null;
      const revision = hooks?.revision() ?? null;
      return finish({
        state: found ? "installed" : "missing",
        version: revision,
        path: found?.path ?? null,
        location: found?.location ?? null,
        installable: Boolean(hooks) && !found,
        removable: found?.location === "studio",
        note: hooks ? null : "Bu worker Chromium kuramıyor.",
      });
    }

    if (id === "python") {
      const rec = this.record(id);
      const managedPython = rec ? path.join(rec.dir, rec.binaries[0]?.[0] ?? "") : null;
      const system = rec ? null : ((await this.o.python?.systemPython()) ?? null);
      const ready = (await this.o.python?.ready()) ?? false;
      const pythonPath = managedPython ?? system?.python ?? null;
      const outdated = rec !== null && e.version !== null && rec.version !== e.version;
      return finish({
        state: !pythonPath ? "missing" : !ready ? "missing" : outdated ? "outdated" : "installed",
        version: rec?.version ?? system?.version ?? null,
        path: pythonPath,
        location: rec ? "studio" : system ? "system" : null,
        installable: Boolean(this.o.python) && (!ready || outdated || rec !== null),
        removable: rec !== null,
        note:
          pythonPath && !ready
            ? "Python var; kod motorunun paketleri (Pillow, numpy, OpenCV, skia) PyPI'dan kurulacak."
            : null,
      });
    }

    if (id === "whisper") {
      const bin = this.o.whisper?.binary() ?? findSystemExecutable(e.commands, this.env);
      const rec = this.record(id);
      const model = rec?.files?.[0] ?? this.o.whisper?.model() ?? null;
      return finish({
        state: bin && model ? "installed" : "missing",
        version: bin ? await this.probeVersion(bin, []) : null,
        path: bin,
        location: bin ? "system" : null,
        installable: Boolean(bin) && !model && Boolean(e.extra),
        removable: rec !== null,
        note: !bin
          ? (e.note ?? null)
          : !model
            ? `whisper-cli var, model yok: ${e.extra?.label ?? "model"} indirilebilir (Hugging Face).`
            : null,
      });
    }

    const rec = this.record(id);
    if (rec) {
      const bin = path.join(rec.dir, rec.binaries[0]?.[0] ?? "");
      const outdated = e.kind === "pinned" && e.version !== null && rec.version !== e.version;
      return finish({
        state: outdated ? "outdated" : "installed",
        version: rec.version,
        path: bin,
        location: "studio",
        installable: e.kind !== "none",
        removable: true,
        note: null,
      });
    }
    const system = findSystemExecutable(e.commands, this.env);
    if (system) {
      return finish({
        state: "installed",
        version: await this.probeVersion(system, e.versionArgs),
        path: system,
        location: "system",
        installable: false,
        removable: false,
        note: "Mac'te zaten kurulu; Studio onun yerine kurmaz.",
      });
    }
    return finish({
      state: "missing",
      version: null,
      path: null,
      location: null,
      installable: e.kind !== "none" && this.installableHere(e),
      removable: false,
      note: e.kind === "none" ? (e.note ?? null) : null,
    });
  }

  private installableHere(e: ToolManifestEntry): boolean {
    if (e.kind === "pinned") return Boolean(e.artifacts?.[this.arch]);
    if (e.kind === "npm") return Boolean(this.o.node);
    return true;
  }

  private sizeOf(e: ToolManifestEntry): number | null {
    if (e.kind === "pinned") return e.artifacts?.[this.arch]?.size ?? e.sizeBytes;
    if (e.id === "whisper") return e.extra?.size ?? e.sizeBytes;
    return e.sizeBytes;
  }

  // --- install ---------------------------------------------------------------------------------

  async install(
    id: ToolId,
    ctx: InstallContext,
    options: { update?: boolean } = {},
  ): Promise<{ tool: ToolStatus; message: string }> {
    if (this.active.has(id)) throw new Error(`${this.entry(id).label} zaten kuruluyor.`);
    const before = await this.status(id);
    if (before.location === "system" && before.state === "installed" && id !== "python") {
      return { tool: before, message: `${before.label} Mac'te zaten kurulu (${before.path}).` };
    }
    if (before.state === "installed" && before.location === "studio" && !options.update) {
      return { tool: before, message: `${before.label} zaten kurulu (${before.version}).` };
    }
    if (!before.installable && before.state !== "outdated") {
      throw new Error(before.note ?? `${before.label} uygulama içinden kurulamaz.`);
    }
    this.active.set(id, { jobId: ctx.jobId, progress: 0, message: null });
    this.failures.delete(id);
    this.changed();
    try {
      const message = await this.perform(id, ctx, options);
      this.active.delete(id);
      this.changed();
      return { tool: await this.status(id), message };
    } catch (error) {
      this.active.delete(id);
      if (!ctx.signal.aborted) this.failures.set(id, messageOf(error));
      this.changed();
      throw error;
    }
  }

  private report(id: ToolId, ctx: InstallContext, value: number, message: string): void {
    const a = this.active.get(id);
    const clamped = Math.max(0, Math.min(1, value));
    if (a) {
      a.progress = clamped;
      a.message = message;
    }
    ctx.progress(clamped, message);
    this.changed();
  }

  private async perform(
    id: ToolId,
    ctx: InstallContext,
    options: { update?: boolean },
  ): Promise<string> {
    const e = this.entry(id);
    await mkdir(path.join(this.toolsDir, ".tmp"), { recursive: true });
    const tmp = path.join(this.toolsDir, ".tmp", `${id}-${randomBytes(6).toString("hex")}`);
    await mkdir(tmp, { recursive: true });
    try {
      switch (e.kind) {
        case "pinned":
          if (id === "python") return await this.installPython(e, tmp, ctx, options);
          return await this.installPinned(e, tmp, ctx);
        case "claude-channel":
          return await this.installClaude(e, tmp, ctx);
        case "npm":
          return await this.installNpm(e, tmp, ctx);
        case "playwright":
          return await this.installChromium(ctx);
        case "none":
          if (id === "whisper") return await this.installWhisperModel(e, tmp, ctx);
          throw new Error(e.note ?? `${e.label} uygulama içinden kurulamaz.`);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private downloadProgress(id: ToolId, ctx: InstallContext, label: string, share = 0.8) {
    return (received: number, total: number | null) => {
      const mb = (received / 1_000_000).toFixed(0);
      const fraction = total ? received / total : 0;
      this.report(
        id,
        ctx,
        fraction * share,
        total
          ? `${label} indiriliyor… ${mb}/${(total / 1_000_000).toFixed(0)} MB`
          : `${label} indiriliyor… ${mb} MB`,
      );
    };
  }

  private async extract(archive: string, into: string, signal: AbortSignal): Promise<void> {
    await mkdir(into, { recursive: true });
    // bsdtar (macOS' own /usr/bin/tar) reads zip and tar.gz alike; never a shell.
    const res = await this.exec("/usr/bin/tar", ["-xf", archive, "-C", into], {
      timeoutMs: 300_000,
      signal,
    });
    if (res.code !== 0) throw new Error(`arşiv açılamadı: ${res.stderr.trim().slice(-300)}`);
  }

  /** Apple Developer ID check of a downloaded binary: valid signature of the expected team. */
  private async checkSignature(file: string, teamId: string | undefined): Promise<void> {
    if (!teamId || this.o.skipSignatureCheck) return;
    const verify = await this.exec("/usr/bin/codesign", ["--verify", "--strict", file], {
      timeoutMs: 60_000,
    });
    if (verify.code !== 0) {
      throw new ToolVerifyError(
        `imza doğrulanamadı (${path.basename(file)}): ${verify.stderr.trim().slice(-200)}; kurulmadı`,
      );
    }
    const info = await this.exec("/usr/bin/codesign", ["-dv", "--verbose=2", file], {
      timeoutMs: 60_000,
    });
    const text = `${info.stdout}\n${info.stderr}`;
    const team = /TeamIdentifier=([A-Z0-9]+)/.exec(text)?.[1] ?? null;
    if (team !== teamId || !/Authority=Developer ID Application/.test(text)) {
      throw new ToolVerifyError(
        `imza beklenen geliştiricinin değil (${team ?? "imzasız"} ≠ ${teamId}); kurulmadı`,
      );
    }
  }

  /** Drop the quarantine flag of what we downloaded and verified ourselves (best effort). */
  private async unquarantine(dir: string): Promise<void> {
    try {
      await this.exec("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dir], {
        timeoutMs: 60_000,
      });
    } catch {
      // nothing to remove, or no xattr: Node's downloads are not quarantined anyway
    }
  }

  /** Runs `<bin> <versionArgs>`; a binary that does not start is not installed. */
  private async smoke(bin: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
    if (args.length === 0) return;
    const res = await this.exec(bin, args, {
      timeoutMs: 60_000,
      env: env ?? { PATH: "/usr/bin:/bin", HOME: this.env.HOME ?? "/tmp" },
    });
    if (res.code !== 0) {
      throw new Error(
        `${path.basename(bin)} çalışmadı (çıkış ${res.code}): ${(res.stderr || res.stdout).trim().slice(-300)}`,
      );
    }
  }

  /**
   * Move a built folder into `tools/<id>/<version>` (rename), point `tools/bin` at its binaries
   * (a fresh symlink renamed over the old one), record it, and drop older versions.
   */
  private async commit(
    id: ToolId,
    version: string,
    built: string,
    binaries: [string, string][],
    extra: Pick<InstallRecord, "source" | "sha256" | "files">,
  ): Promise<InstallRecord> {
    const toolRoot = path.join(this.toolsDir, id);
    const dir = path.join(toolRoot, version);
    await mkdir(toolRoot, { recursive: true });
    const previous = this.record(id);
    if (existsSync(dir)) {
      const aside = path.join(this.toolsDir, ".tmp", `${id}-old-${randomBytes(4).toString("hex")}`);
      await rename(dir, aside);
      await rm(aside, { recursive: true, force: true });
    }
    await rename(built, dir);
    await mkdir(this.binDir, { recursive: true });
    for (const [rel, name] of binaries) {
      const link = path.join(this.binDir, name);
      const tmpLink = `${link}.tmp-${randomBytes(4).toString("hex")}`;
      await symlink(path.join(dir, rel), tmpLink);
      await rename(tmpLink, link);
    }
    // A binary the previous version had and this one does not.
    for (const [, name] of previous?.binaries ?? []) {
      if (!binaries.some(([, n]) => n === name))
        await rm(path.join(this.binDir, name), { force: true });
    }
    const record: InstallRecord = {
      id,
      version,
      dir,
      binaries,
      ...extra,
      installedAt: this.now().toISOString(),
    };
    const recTmp = `${this.recordFile(id)}.tmp`;
    await writeFile(recTmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(recTmp, this.recordFile(id));
    for (const name of await readdir(toolRoot)) {
      if (name === version || name === "current.json" || name === "models") continue;
      await rm(path.join(toolRoot, name), { recursive: true, force: true });
    }
    return record;
  }

  private async installPinned(
    e: ToolManifestEntry,
    tmp: string,
    ctx: InstallContext,
    last = true,
  ): Promise<string> {
    const artifact = e.artifacts?.[this.arch];
    if (!artifact || !e.version) throw new Error(`${e.label} bu Mac (${this.arch}) için yok.`);
    const file = path.join(tmp, `download.${artifact.archive}`);
    this.log(`${e.id}: ${artifact.url}`);
    await downloadVerified(
      artifact.url,
      file,
      { sha256: artifact.sha256, size: artifact.size },
      {
        fetch: this.fetch,
        signal: ctx.signal,
        onProgress: this.downloadProgress(e.id, ctx, e.label),
      },
    );
    this.report(e.id, ctx, 0.82, "Doğrulandı, açılıyor…");
    const root = path.join(tmp, "root");
    await this.extract(file, root, ctx.signal);
    const binaries: [string, string][] = artifact.binaries.map(([a, b]) => [a, b]);
    for (const [rel] of binaries) {
      const bin = path.join(root, rel);
      if (!isExecutableFile(bin) && existsSync(bin)) await chmod(bin, 0o755);
      if (!isExecutableFile(bin)) throw new Error(`arşivde ${rel} yok`);
      await this.checkSignature(bin, e.teamId?.[this.arch]);
    }
    await this.unquarantine(root);
    this.report(e.id, ctx, 0.9, "Deneniyor…");
    const first = binaries[0];
    if (first) await this.smoke(path.join(root, first[0]), e.versionArgs);
    await this.commit(e.id, e.version, root, binaries, {
      source: artifact.url,
      sha256: artifact.sha256,
    });
    if (last) this.report(e.id, ctx, 1, "Kuruldu");
    return `${e.label} ${e.version} kuruldu.`;
  }

  private async installPython(
    e: ToolManifestEntry,
    tmp: string,
    ctx: InstallContext,
    options: { update?: boolean },
  ): Promise<string> {
    const hooks = this.o.python;
    if (!hooks) throw new Error("Bu worker kod motorunu kuramıyor.");
    let rec = this.record("python");
    const system = rec ? null : await hooks.systemPython();
    const needsDownload = options.update || (rec ? rec.version !== e.version : system === null);
    if (needsDownload) {
      await this.installPinned(e, tmp, ctx, false);
      rec = this.record("python");
    }
    const python = rec ? path.join(rec.dir, rec.binaries[0]?.[0] ?? "") : system?.python;
    if (!python) throw new Error("Python kurulamadı.");
    this.report(
      "python",
      ctx,
      needsDownload ? 0.92 : 0.1,
      "Kod motorunun paketleri kuruluyor (PyPI)…",
    );
    await hooks.setup(python, ctx.signal, (line) => {
      this.log(`python: ${line}`);
      const a = this.active.get("python");
      if (a) this.report("python", ctx, Math.min(0.98, a.progress + 0.02), `Paketler: ${line}`);
    });
    this.report("python", ctx, 1, "Kuruldu");
    return needsDownload
      ? `Python ${e.version} ve kod motorunun paketleri kuruldu.`
      : "Kod motorunun paketleri Mac'teki Python ile kuruldu.";
  }

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const res = await this.fetch(url, { signal });
    if (!res.ok) throw new Error(`okunamadı (HTTP ${res.status}): ${url}`);
    return res.json();
  }

  private async getText(url: string, signal: AbortSignal): Promise<string> {
    const res = await this.fetch(url, { signal });
    if (!res.ok) throw new Error(`okunamadı (HTTP ${res.status}): ${url}`);
    return (await res.text()).trim();
  }

  /** Claude Code the way https://claude.ai/install.sh does it: channel → manifest → binary. */
  private async installClaude(
    e: ToolManifestEntry,
    tmp: string,
    ctx: InstallContext,
  ): Promise<string> {
    const base = e.channelUrl;
    if (!base) throw new Error("Claude Code'un kanal adresi yok.");
    const version = await this.getText(`${base}/stable`, ctx.signal);
    if (!SEMVER.test(version))
      throw new ToolVerifyError("Claude Code kanalı geçersiz sürüm döndü.");
    const platform = `darwin-${this.arch}`;
    const manifest = (await this.getJson(`${base}/${version}/manifest.json`, ctx.signal)) as {
      platforms?: Record<string, { checksum?: unknown; size?: unknown }>;
    };
    const entry = manifest.platforms?.[platform];
    const checksum = typeof entry?.checksum === "string" ? entry.checksum : "";
    const size = typeof entry?.size === "number" ? entry.size : undefined;
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
      throw new ToolVerifyError(`Claude Code sürüm listesinde ${platform} yok.`);
    }
    const root = path.join(tmp, "root");
    await mkdir(root, { recursive: true });
    const bin = path.join(root, "claude");
    const url = `${base}/${version}/${platform}/claude`;
    this.log(`claude: ${url}`);
    await downloadVerified(
      url,
      bin,
      { sha256: checksum, ...(size !== undefined ? { size } : {}) },
      {
        fetch: this.fetch,
        signal: ctx.signal,
        onProgress: this.downloadProgress("claude", ctx, e.label),
      },
    );
    await chmod(bin, 0o755);
    this.report("claude", ctx, 0.85, "İmza doğrulanıyor…");
    await this.checkSignature(bin, e.teamId?.[this.arch]);
    await this.unquarantine(root);
    await this.smoke(bin, e.versionArgs, {
      PATH: "/usr/bin:/bin",
      HOME: this.env.HOME ?? "/tmp",
      DISABLE_AUTOUPDATER: "1",
    });
    await this.commit("claude", version, root, [["claude", "claude"]], {
      source: url,
      sha256: checksum,
    });
    this.report("claude", ctx, 1, "Kuruldu");
    return `Claude Code ${version} kuruldu. Ayarlar → Yapay zekâ'dan Claude'a giriş yap.`;
  }

  /** An npm package with a self-contained bundle (Gemini CLI): tarball + integrity + launcher. */
  private async installNpm(
    e: ToolManifestEntry,
    tmp: string,
    ctx: InstallContext,
  ): Promise<string> {
    const node = this.o.node;
    if (!node || !e.npmPackage) throw new Error(`${e.label} için Node yok.`);
    const meta = (await this.getJson(
      `https://registry.npmjs.org/${e.npmPackage.replace("/", "%2f")}/latest`,
      ctx.signal,
    )) as {
      version?: unknown;
      bin?: unknown;
      dist?: { tarball?: unknown; integrity?: unknown };
      dependencies?: Record<string, string>;
    };
    const version = typeof meta.version === "string" ? meta.version : "";
    const tarball = typeof meta.dist?.tarball === "string" ? meta.dist.tarball : "";
    const integrity = typeof meta.dist?.integrity === "string" ? meta.dist.integrity : "";
    if (!SEMVER.test(version) || !tarball.startsWith("https://registry.npmjs.org/") || !integrity) {
      throw new ToolVerifyError(`${e.label}: npm kaydı beklenen biçimde değil.`);
    }
    if (meta.dependencies && Object.keys(meta.dependencies).length > 0) {
      throw new Error(
        `${e.label} ${version} artık tek parça değil (bağımlılıkları var); kurulmadı.`,
      );
    }
    const binRel =
      typeof meta.bin === "string"
        ? meta.bin
        : meta.bin && typeof meta.bin === "object"
          ? Object.values(meta.bin as Record<string, unknown>).find((v) => typeof v === "string")
          : undefined;
    if (typeof binRel !== "string" || binRel.includes("..")) {
      throw new ToolVerifyError(`${e.label}: çalıştırılacak dosya bulunamadı.`);
    }
    const file = path.join(tmp, "package.tgz");
    await downloadVerified(
      tarball,
      file,
      { integrity },
      {
        fetch: this.fetch,
        signal: ctx.signal,
        onProgress: this.downloadProgress(e.id, ctx, e.label),
      },
    );
    this.report(e.id, ctx, 0.82, "Doğrulandı, açılıyor…");
    const root = path.join(tmp, "root");
    await this.extract(file, root, ctx.signal);
    const entry = path.join(root, "package", binRel);
    if (!existsSync(entry)) throw new Error(`paketin içinde ${binRel} yok`);
    const smokeEnv = {
      PATH: "/usr/bin:/bin",
      HOME: tmp,
      ...node.env,
    };
    await this.smoke(node.executable, [...node.args, entry, ...e.versionArgs], smokeEnv);
    // The launcher runs the bundle with Studio's own Node (Electron in Node mode when packaged).
    const command = e.commands[0] ?? e.id;
    const finalEntry = path.join(this.toolsDir, e.id, version, "package", binRel);
    const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
    const envPrefix = Object.entries(node.env)
      .map(([k, v]) => `${k}=${q(v)} `)
      .join("");
    const launcher = `#!/bin/sh\n# Studio: ${e.npmPackage}@${version} (${tarball})\nexec env ${envPrefix}${q(node.executable)} ${node.args.map(q).join(" ")} ${q(finalEntry)} "$@"\n`;
    await writeFile(path.join(root, command), launcher, { mode: 0o755 });
    await this.commit(e.id, version, root, [[command, command]], { source: tarball });
    this.report(e.id, ctx, 1, "Kuruldu");
    return `${e.label} ${version} kuruldu.`;
  }

  private async installChromium(ctx: InstallContext): Promise<string> {
    const hooks = this.o.chromium;
    if (!hooks) throw new Error("Bu worker Chromium kuramıyor.");
    this.report("chromium", ctx, 0, "Chromium indiriliyor…");
    await hooks.install(
      (fraction) =>
        this.report(
          "chromium",
          ctx,
          fraction,
          `Chromium indiriliyor… %${Math.round(fraction * 100)}`,
        ),
      ctx.signal,
    );
    if (!hooks.find()) throw new Error("Chromium kurulumu bitti ama tarayıcı bulunamadı.");
    this.report("chromium", ctx, 1, "Kuruldu");
    return `Chromium (sürüm ${hooks.revision() ?? "?"}) kuruldu.`;
  }

  private async installWhisperModel(
    e: ToolManifestEntry,
    tmp: string,
    ctx: InstallContext,
  ): Promise<string> {
    const extra = e.extra;
    if (!extra) throw new Error(e.note ?? "whisper.cpp kurulamaz.");
    const bin = this.o.whisper?.binary() ?? findSystemExecutable(e.commands, this.env);
    if (!bin) throw new Error(e.note ?? "whisper.cpp kurulamaz.");
    const root = path.join(tmp, "root");
    await mkdir(path.join(root, "models"), { recursive: true });
    const file = path.join(root, "models", extra.name);
    await downloadVerified(
      extra.url,
      file,
      { sha256: extra.sha256, size: extra.size },
      {
        fetch: this.fetch,
        signal: ctx.signal,
        onProgress: this.downloadProgress(e.id, ctx, extra.label, 0.98),
      },
    );
    const finalFile = path.join(this.toolsDir, e.id, "models-v1", "models", extra.name);
    await this.commit(e.id, "models-v1", root, [], {
      source: extra.url,
      sha256: extra.sha256,
      files: [finalFile],
    });
    this.report(e.id, ctx, 1, "Model indirildi");
    return `${extra.label} indirildi; Reels altyazıları yerelde yazılabilir.`;
  }

  // --- uninstall -------------------------------------------------------------------------------

  async uninstall(id: ToolId, ctx: InstallContext): Promise<{ tool: ToolStatus; message: string }> {
    if (this.active.has(id)) throw new Error(`${this.entry(id).label} şu an kuruluyor.`);
    const label = this.entry(id).label;
    this.active.set(id, { jobId: ctx.jobId, progress: 0, message: "Kaldırılıyor…" });
    this.changed();
    try {
      if (id === "chromium") {
        const found = this.o.chromium?.find();
        if (found?.location !== "studio") throw new Error("Studio'nun kendi Chromium kopyası yok.");
        await this.o.chromium?.remove();
      } else {
        const rec = this.record(id);
        const root = path.join(this.toolsDir, id);
        if (!rec && !existsSync(root)) throw new Error(`Studio'nun kendi ${label} kopyası yok.`);
        if (id === "python") await this.o.python?.remove();
        await this.removeLinksInto(root);
        const aside = path.join(
          this.toolsDir,
          ".tmp",
          `${id}-rm-${randomBytes(4).toString("hex")}`,
        );
        await mkdir(path.dirname(aside), { recursive: true });
        await rename(root, aside);
        await rm(aside, { recursive: true, force: true });
      }
      this.failures.delete(id);
      this.active.delete(id);
      this.changed();
      ctx.progress(1, "Kaldırıldı");
      return { tool: await this.status(id), message: `Studio'nun ${label} kopyası kaldırıldı.` };
    } catch (error) {
      this.active.delete(id);
      this.changed();
      throw error;
    }
  }

  /** Remove every `tools/bin` symlink that points into `root`. */
  private async removeLinksInto(root: string): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.binDir);
    } catch {
      return;
    }
    for (const name of names) {
      const link = path.join(this.binDir, name);
      try {
        if (!(await lstat(link)).isSymbolicLink()) continue;
        const target = path.resolve(this.binDir, await readlink(link));
        if (target.startsWith(`${root}${path.sep}`)) await rm(link, { force: true });
      } catch {
        // gone meanwhile
      }
    }
  }

  /** Leftovers of an interrupted install (`tools/.tmp`), removed at start. */
  cleanLeftovers(): void {
    try {
      for (const name of readdirSync(path.join(this.toolsDir, ".tmp"))) {
        void rm(path.join(this.toolsDir, ".tmp", name), { recursive: true, force: true });
      }
    } catch {
      // none
    }
  }
}
