// The in-app tool manager (src/tools): the manifest, verified downloads, discovery order (Studio's
// own copy vs the Mac's), the install / uninstall job flow with fake downloads, and the chat's
// consent-gated `install_tool`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JOB_PAYLOAD_SCHEMAS,
  type Job,
  pathWithTools,
  TOOL_MANIFEST,
  type ToolManifestEntry,
  ToolStatus,
  type ToolStatus as ToolStatusT,
} from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import type { StudioApi } from "../src/api.ts";
import { installToolTool, type ToolManagerToolEnv } from "../src/chat/tool-manager-tools.ts";
import { STUDIO_TOOLS } from "../src/chat/tools.ts";
import { silentLogger } from "../src/log.ts";
import { MemoryOutbox } from "../src/outbox.ts";
import type { JobContext } from "../src/registry.ts";
import { downloadVerified, parseInstallProgress, ToolVerifyError } from "../src/tools/download.ts";
import { ToolManager } from "../src/tools/manager.ts";
import { findSystemExecutable } from "../src/tools/paths.ts";
import { ToolService } from "../src/tools/service.ts";
import { findExecutable } from "../src/video/ffmpeg.ts";
import { startWorker } from "../src/worker.ts";
import { fakeSocketFactory } from "./fake-socket.ts";

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A .tgz with one executable `bin/demo` printing `demo <version>`. */
function demoArchive(version: string): Buffer {
  const dir = tmp("studio-demo-src-");
  mkdirSync(path.join(dir, "bin"));
  const script = path.join(dir, "bin", "demo");
  writeFileSync(script, `#!/bin/sh\necho "demo ${version}"\n`);
  chmodSync(script, 0o755);
  const out = path.join(tmp("studio-demo-tgz-"), "demo.tgz");
  execFileSync("/usr/bin/tar", ["-czf", out, "-C", dir, "bin"]);
  return readFileSync(out);
}

function serving(files: Record<string, Buffer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = files[url];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(new Uint8Array(body), {
      headers: { "content-length": String(body.length) },
    });
  }) as typeof fetch;
}

function demoEntry(
  over: Partial<ToolManifestEntry> & { sha: string; size: number },
): ToolManifestEntry {
  return {
    id: "cloudflared",
    label: "Demo",
    purpose: "test",
    source: "test",
    sourceUrl: "https://example.com",
    optional: true,
    commands: ["demo"],
    versionArgs: ["--version"],
    kind: "pinned",
    version: "1.0.0",
    sizeBytes: over.size,
    artifacts: {
      arm64: {
        url: "https://example.com/demo.tgz",
        sha256: over.sha,
        size: over.size,
        archive: "tgz",
        binaries: [["bin/demo", "demo"]],
      },
    },
    ...over,
  };
}

function ctx(jobId = "job-1") {
  const progress: [number, string | undefined][] = [];
  return {
    progress,
    c: {
      jobId,
      signal: new AbortController().signal,
      progress: (v: number, m?: string) => progress.push([v, m]),
    },
  };
}

describe("the tool manifest", () => {
  it("pins every downloadable tool with an https URL, a SHA-256 and a size", () => {
    const ids = TOOL_MANIFEST.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOOL_MANIFEST) {
      if (t.kind === "pinned") {
        expect(t.version, t.id).toBeTruthy();
        for (const a of Object.values(t.artifacts ?? {})) {
          expect(a.url.startsWith("https://"), t.id).toBe(true);
          expect(a.sha256, t.id).toMatch(/^[a-f0-9]{64}$/);
          expect(a.size, t.id).toBeGreaterThan(0);
          expect(a.binaries.length, t.id).toBeGreaterThan(0);
        }
        expect(t.artifacts?.arm64, `${t.id} arm64`).toBeTruthy();
      }
      if (t.extra) expect(t.extra.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(TOOL_MANIFEST.find((t) => t.id === "claude")?.channelUrl).toMatch(/^https:\/\//);
    expect(JOB_PAYLOAD_SCHEMAS["tool.install"]?.safeParse({ toolId: "ffmpeg" }).success).toBe(true);
    expect(JOB_PAYLOAD_SCHEMAS["tool.install"]?.safeParse({ toolId: "brew" }).success).toBe(false);
  });

  it("puts Studio's tools first on PATH", () => {
    expect(pathWithTools("/usr/bin:/x/tools/bin:/bin", "/x/tools")).toBe(
      "/x/tools/bin:/usr/bin:/bin",
    );
  });

  it("reads installer progress", () => {
    expect(parseInstallProgress("|■■■■  |  40% of 90 MiB\n|■■■■■■|  55% of")).toBe(55);
    expect(parseInstallProgress("Downloading")).toBeNull();
  });
});

describe("verified downloads", () => {
  it("refuses a checksum mismatch and leaves nothing behind", async () => {
    const dir = tmp("studio-dl-");
    const file = path.join(dir, "x.bin");
    const body = Buffer.from("hello");
    const fetchFn = serving({ "https://example.com/x": body });
    await expect(
      downloadVerified(
        "https://example.com/x",
        file,
        { sha256: "0".repeat(64) },
        { fetch: fetchFn },
      ),
    ).rejects.toBeInstanceOf(ToolVerifyError);
    expect(existsSync(file)).toBe(false);
    const ok = await downloadVerified(
      "https://example.com/x",
      file,
      { sha256: sha256(body), size: 5 },
      { fetch: fetchFn },
    );
    expect(ok.bytes).toBe(5);
    // npm-style integrity
    const integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`;
    await expect(
      downloadVerified("https://example.com/x", file, { integrity }, { fetch: fetchFn }),
    ).resolves.toMatchObject({ bytes: 5 });
    await expect(
      downloadVerified("http://example.com/x", file, { sha256: sha256(body) }, { fetch: fetchFn }),
    ).rejects.toThrow(/https/);
  });

  it("an install with a wrong hash fails, records the error and installs nothing", async () => {
    const archive = demoArchive("1.0.0");
    const toolsDir = path.join(tmp("studio-tools-"), "tools");
    const manager = new ToolManager({
      toolsDir,
      arch: "arm64",
      env: { PATH: "/usr/bin:/bin", HOME: tmp("studio-home-") },
      fetch: serving({ "https://example.com/demo.tgz": archive }),
      manifest: [demoEntry({ sha: "f".repeat(64), size: archive.length })],
    });
    await expect(manager.install("cloudflared", ctx().c)).rejects.toThrow(/SHA-256/);
    expect(existsSync(path.join(toolsDir, "bin", "demo"))).toBe(false);
    expect(existsSync(path.join(toolsDir, "cloudflared"))).toBe(false);
    const status = await manager.status("cloudflared");
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/SHA-256/);
  });
});

describe("discovery order", () => {
  it("counts a copy on the Mac as installed and never installs over it", async () => {
    const home = tmp("studio-home-");
    const sys = path.join(home, "sysbin");
    mkdirSync(sys);
    writeFileSync(path.join(sys, "demo"), `#!/bin/sh\necho "demo 0.9.1"\n`);
    chmodSync(path.join(sys, "demo"), 0o755);
    const toolsDir = path.join(home, "tools");
    const env = { PATH: `${sys}:/usr/bin:/bin`, HOME: home, STUDIO_TOOLS_DIR: toolsDir };
    const archive = demoArchive("1.0.0");
    const manager = new ToolManager({
      toolsDir,
      arch: "arm64",
      env,
      fetch: serving({ "https://example.com/demo.tgz": archive }),
      manifest: [demoEntry({ sha: sha256(archive), size: archive.length })],
    });
    const status = await manager.status("cloudflared");
    expect(status).toMatchObject({
      state: "installed",
      location: "system",
      path: path.join(sys, "demo"),
      version: "0.9.1",
      installable: false,
      removable: false,
    });
    ToolStatus.parse(status);
    const result = await manager.install("cloudflared", ctx().c);
    expect(result.message).toMatch(/zaten kurulu/);
    expect(existsSync(path.join(toolsDir, "bin", "demo"))).toBe(false);
  });

  it("Studio's own tools/bin wins over PATH for the worker, and is not 'system'", () => {
    const home = tmp("studio-home-");
    const toolsDir = path.join(home, "tools");
    const bin = path.join(toolsDir, "bin");
    const sys = path.join(home, "sys");
    for (const d of [bin, sys]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "ffmpeg"), "#!/bin/sh\n");
      chmodSync(path.join(d, "ffmpeg"), 0o755);
    }
    const env = { PATH: `${sys}:/usr/bin`, HOME: home, STUDIO_TOOLS_DIR: toolsDir };
    expect(findExecutable(["ffmpeg"], env)).toBe(path.join(bin, "ffmpeg"));
    expect(findSystemExecutable(["ffmpeg"], { ...env, PATH: `${bin}:${sys}` })).toBe(
      path.join(sys, "ffmpeg"),
    );
  });
});

describe("install / uninstall jobs (fake downloads)", () => {
  it("downloads, verifies, unpacks, links tools/bin, reports progress, updates and removes", async () => {
    const home = tmp("studio-home-");
    const toolsDir = path.join(home, "tools");
    const v1 = demoArchive("1.0.0");
    const v2 = demoArchive("2.0.0");
    const files: Record<string, Buffer> = { "https://example.com/demo.tgz": v1 };
    let entry = demoEntry({ sha: sha256(v1), size: v1.length });
    const service = new ToolService({
      stateDir: path.join(home, "worker"),
      env: { PATH: "/usr/bin:/bin", HOME: home, STUDIO_TOOLS_DIR: toolsDir },
      overrides: {
        toolsDir,
        arch: "arm64",
        fetch: ((u: string | URL | Request) => serving(files)(u)) as typeof fetch,
        manifest: [entry],
      },
    });
    const changes = vi.fn();
    service.manager.onChange(changes);
    const progress: number[] = [];
    const jobCtx = (id: string): JobContext => ({
      jobId: id,
      job: {} as Job,
      attempt: 1,
      workerId: "w",
      signal: new AbortController().signal,
      progress: (v) => progress.push(v),
      log: () => {},
    });
    const out = await service.installHandler().run({ toolId: "cloudflared" }, jobCtx("j1"));
    expect(out.tool).toMatchObject({ state: "installed", version: "1.0.0", location: "studio" });
    expect(progress.at(-1)).toBe(1);
    expect(changes).toHaveBeenCalled();
    const link = path.join(toolsDir, "bin", "demo");
    expect(execFileSync(link, [], { encoding: "utf8" }).trim()).toBe("demo 1.0.0");
    expect(existsSync(path.join(toolsDir, ".tmp"))).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(toolsDir, "cloudflared", "current.json"), "utf8")),
    ).toMatchObject({ version: "1.0.0", sha256: sha256(v1) });

    // A newer pin: "outdated", then the update replaces it atomically (old version folder gone).
    files["https://example.com/demo.tgz"] = v2;
    entry = { ...entry, version: "2.0.0" };
    entry.artifacts = {
      arm64: {
        ...(entry.artifacts?.arm64 as NonNullable<typeof entry.artifacts>["arm64"] & object),
        sha256: sha256(v2),
        size: v2.length,
      },
    };
    (service.manager as unknown as { manifest: ToolManifestEntry[] }).manifest = [entry];
    expect((await service.manager.status("cloudflared")).state).toBe("outdated");
    await service.installHandler().run({ toolId: "cloudflared", update: true }, jobCtx("j2"));
    expect(execFileSync(link, [], { encoding: "utf8" }).trim()).toBe("demo 2.0.0");
    expect(existsSync(path.join(toolsDir, "cloudflared", "1.0.0"))).toBe(false);

    const removed = await service.uninstallHandler().run({ toolId: "cloudflared" }, jobCtx("j3"));
    expect(removed.tool.state).toBe("missing");
    expect(existsSync(link)).toBe(false);
    expect(existsSync(path.join(toolsDir, "cloudflared"))).toBe(false);
  });

  it("shows 'installing' with the job and progress while it runs", async () => {
    const home = tmp("studio-home-");
    const toolsDir = path.join(home, "tools");
    const archive = demoArchive("1.0.0");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchFn = (async (u: string | URL | Request) => {
      await gate;
      return serving({ "https://example.com/demo.tgz": archive })(u);
    }) as typeof fetch;
    const manager = new ToolManager({
      toolsDir,
      arch: "arm64",
      env: { PATH: "/usr/bin:/bin", HOME: home },
      fetch: fetchFn,
      manifest: [demoEntry({ sha: sha256(archive), size: archive.length })],
    });
    const running = manager.install("cloudflared", ctx("job-9").c);
    await new Promise((r) => setTimeout(r, 20));
    expect(await manager.status("cloudflared")).toMatchObject({
      state: "installing",
      jobId: "job-9",
    });
    await expect(manager.install("cloudflared", ctx("job-10").c)).rejects.toThrow(/zaten/);
    release();
    await running;
    expect((await manager.status("cloudflared")).state).toBe("installed");
  });
});

describe("chat install_tool", () => {
  const ffmpeg: ToolStatusT = {
    id: "ffmpeg",
    label: "ffmpeg",
    purpose: "Reels videolarını birleştirir.",
    source: "FFmpeg",
    sourceUrl: "https://ffmpeg.martin-riedl.de/",
    sizeBytes: 28_623_086,
    state: "missing",
    version: null,
    targetVersion: "9.1",
    path: null,
    location: null,
    installable: true,
    removable: false,
    optional: false,
    note: null,
    error: null,
    progress: null,
    jobId: null,
  };

  function env(decision: "allow" | "deny" | "expire", tools: ToolStatusT[] = [ffmpeg]) {
    const install = vi.fn(async () => ({ id: "job-1", status: "queued" }) as Job);
    const get = vi.fn(
      async () =>
        ({
          id: "job-1",
          status: "succeeded",
          output: { message: "ffmpeg 9.1 kuruldu." },
        }) as unknown as Job,
    );
    const consent = vi.fn(async (_input: { title: string; detail: string }) =>
      decision === "allow"
        ? ({ allowed: true } as const)
        : ({
            allowed: false,
            reason: decision === "deny" ? "denied_by_owner" : "expired",
          } as const),
    );
    const api = {
      client: {
        tools: { list: async () => ({ tools, online: true, reportedAt: null, sent: 0 }), install },
        jobs: { get },
      },
    } as unknown as StudioApi;
    const e: ToolManagerToolEnv = {
      api,
      signal: new AbortController().signal,
      consent,
      idle: (fn) => fn(),
      sleep: async () => {},
      progress: async () => {},
      jobPollMs: 1,
    };
    return { e, install, consent };
  }

  it("is offered to the agent", () => {
    expect(STUDIO_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_tools", "install_tool"]),
    );
  });

  it("asks a consent card with source and size, then installs and waits", async () => {
    const { e, install, consent } = env("allow");
    const out = await installToolTool(e, { toolId: "ffmpeg" });
    expect(consent).toHaveBeenCalledTimes(1);
    const card = consent.mock.calls[0]?.[0];
    expect(card?.title).toBe("ffmpeg kurulsun mu?");
    expect(card?.detail).toContain("Kaynak: FFmpeg (https://ffmpeg.martin-riedl.de/)");
    expect(card?.detail).toContain("~29 MB");
    expect(install).toHaveBeenCalledWith("ffmpeg", {}, expect.anything());
    expect(out.data).toMatchObject({ ok: true, installed: true, message: "ffmpeg 9.1 kuruldu." });
  });

  it("installs nothing when the owner says no or does not answer", async () => {
    for (const d of ["deny", "expire"] as const) {
      const { e, install } = env(d);
      const out = await installToolTool(e, { toolId: "ffmpeg" });
      expect(install).not.toHaveBeenCalled();
      expect(out.data).toMatchObject({ ok: false, allowed: false });
    }
  });

  it("does not ask for a tool the Mac already has, nor one that cannot be installed", async () => {
    const sys = { ...ffmpeg, state: "installed" as const, location: "system" as const };
    const a = env("allow", [sys]);
    expect((await installToolTool(a.e, { toolId: "ffmpeg" })).data).toMatchObject({
      alreadyInstalled: true,
    });
    expect(a.consent).not.toHaveBeenCalled();
    const whisper = { ...ffmpeg, id: "whisper" as const, installable: false, note: "kurulamaz" };
    const b = env("allow", [whisper]);
    expect((await installToolTool(b.e, { toolId: "whisper" })).data).toMatchObject({
      installable: false,
    });
    expect(b.consent).not.toHaveBeenCalled();
  });
});

describe("the worker reports its tools", () => {
  it("announces tool.install / tool.uninstall, sends worker.tools on connect and on tools.status", async () => {
    const home = tmp("studio-home-");
    const service = new ToolService({
      stateDir: path.join(home, "worker"),
      env: { PATH: "/nonexistent", HOME: home, STUDIO_TOOLS_DIR: path.join(home, "tools") },
      overrides: { toolsDir: path.join(home, "tools") },
    });
    const fake = fakeSocketFactory();
    const worker = startWorker({
      config: {
        hubUrl: "ws://hub.test/api/hub",
        token: "t",
        workerId: "mac-tools",
        concurrency: 1,
        heartbeatIntervalMs: 15_000,
        shutdownTimeoutMs: 1000,
        stateDir: path.join(home, "worker"),
        backoff: { baseMs: 100, maxMs: 1000, jitter: 0 },
        pingIntervalMs: 5000,
        logLevel: "error",
      },
      logger: silentLogger,
      socketFactory: fake.factory,
      outbox: new MemoryOutbox(),
      tools: service,
    });
    const socket = fake.last();
    socket?.simulateOpen();
    const hello = socket?.sent[0];
    expect(hello?.type === "hello" && hello.capabilities).toEqual(
      expect.arrayContaining(["tool.install", "tool.uninstall"]),
    );
    const toolsFrames = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        const frames = socket?.sent.filter((m) => m.type === "worker.tools") ?? [];
        if (frames.length >= n) return frames;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("no worker.tools frame");
    };
    const [first] = await toolsFrames(1);
    expect(first?.type === "worker.tools" && first.tools.map((t) => t.id)).toEqual(
      TOOL_MANIFEST.map((t) => t.id),
    );
    socket?.simulateMessage({ type: "worker.command", command: "tools.status" });
    await toolsFrames(2);
    worker.stop();
  });
});
