/**
 * Reels end-to-end run (P6) against a PRIVATE local API (never the shared :8787):
 *
 *   seed brand (Venta pack: fonts, logos, product photo → approved profile) + a sample footage
 *   clip made with ffmpeg + macOS `say` → the real worker (spawned src/main.ts) renders one reel
 *   per recipe from a ready `reel.spec` (no AI call, no paid API), then one editor change
 *   (`content.render` with a `reel` patch) and one cancellation → MP4s, covers and the
 *   15-point Reels checks under docs/e2e/reels/.
 *
 * Usage (API started separately with its own --persist-to and WORKER_TOKEN):
 *   STUDIO_E2E_API=http://127.0.0.1:8797 STUDIO_WORKER_TOKEN=<test token> \
 *   STUDIO_OWNER_SECRET=<the API's --var STUDIO_OWNER_SECRET> \
 *   STUDIO_E2E_STATE=$S/worker pnpm --filter @studio/worker exec tsx scripts/e2e-reels.ts
 * Env: FFMPEG / FFPROBE for the checks (default: the bake-off's pinned binaries).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createApiClient,
  type Job,
  type ReelSpecInput,
  readReelVersionInfo,
} from "@studio/contract";
import sharp from "sharp";
import { OwnerWebSocket, ownerFetch, requireOwnerSecret } from "./owner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, "..");
const ROOT = path.resolve(WORKER_DIR, "../..");
const VENTA = path.join(ROOT, "spikes/design-render/brand/venta");
const TOOLS = path.join(ROOT, "spikes/video-bakeoff/tools/node_modules");
const FFMPEG = process.env.FFMPEG ?? path.join(TOOLS, "ffmpeg-static/ffmpeg");
const FFPROBE = process.env.FFPROBE ?? path.join(TOOLS, "@ffprobe-installer/darwin-arm64/ffprobe");

const apiBase = process.env.STUDIO_E2E_API ?? "";
const token = process.env.STUDIO_WORKER_TOKEN ?? "";
const stateDir = process.env.STUDIO_E2E_STATE ?? "";
const outDir = path.resolve(process.env.STUDIO_E2E_OUT ?? path.join(WORKER_DIR, "docs/e2e/reels"));
if (!apiBase || !token || !stateDir) {
  console.error("set STUDIO_E2E_API, STUDIO_WORKER_TOKEN and STUDIO_E2E_STATE");
  process.exit(2);
}
if (/:8787\b/.test(apiBase)) {
  console.error("refusing to run against the shared dev API on :8787; start a private one");
  process.exit(2);
}

requireOwnerSecret();
const api = createApiClient({ baseUrl: apiBase, fetch: ownerFetch, WebSocket: OwnerWebSocket });
const t0 = Date.now();
const transcript: string[] = [];
const log = (line: string) => {
  const stamp = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`;
  console.log(`[reels ${stamp}] ${line}`);
  transcript.push(`- \`${stamp}\` ${line}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = (p: string, type: string, name = path.basename(p)) =>
  new File([readFileSync(p)], name, { type });

// ---------------------------------------------------------------- seed
async function seed() {
  const brand = await api.brands.create({
    name: "MTM Agro",
    slug: `mtm-reels-${Date.now().toString(36)}`,
    defaultLanguage: "tr",
  });
  const fileAssets: Record<string, string> = {};
  const uploads: [string, string, "font" | "logo" | "image"][] = [];
  for (const name of readdirSync(path.join(VENTA, "fonts"))) {
    if (name.endsWith(".woff2")) uploads.push([`fonts/${name}`, "font/woff2", "font"]);
  }
  for (const name of readdirSync(path.join(VENTA, "logos"))) {
    if (name.endsWith(".png")) uploads.push([`logos/${name}`, "image/png", "logo"]);
  }
  uploads.push(["assets/product-venta-borinc.png", "image/png", "image"]);
  let productId = "";
  for (const [rel, mime, kind] of uploads) {
    const meta = mime.startsWith("image/")
      ? await sharp(path.join(VENTA, rel)).metadata()
      : undefined;
    const asset = await api.assets.upload({
      brandId: brand.id,
      kind,
      source: "ingested",
      ...(meta?.width && meta.height ? { width: meta.width, height: meta.height } : {}),
      file: file(path.join(VENTA, rel), mime),
    });
    fileAssets[rel] = asset.id;
    if (rel.startsWith("assets/")) productId = asset.id;
  }
  const tokens = JSON.parse(readFileSync(path.join(VENTA, "brand.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const facts = JSON.parse(readFileSync(path.join(VENTA, "facts.json"), "utf8"));
  const profile = await api.brandProfiles.create(brand.id, {
    tokens: { ...tokens, status: "provisional", fileAssets, facts },
    designRules: readFileSync(path.join(VENTA, "DESIGN.md"), "utf8"),
    voice: readFileSync(path.join(VENTA, "VOICE.md"), "utf8"),
  });
  await api.brandProfiles.approve(brand.id, profile.version);
  log(
    `brand ${brand.name} (${brand.id}), ${uploads.length} brand files, profile v${profile.version} approved`,
  );
  return { brand, productId };
}

/** 14 s landscape test footage with a Turkish voice track (ffmpeg testsrc2 + macOS say). */
async function makeSampleClip(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "reels-clip-"));
  const aiff = path.join(dir, "voice.aiff");
  execFileSync("/usr/bin/say", [
    "-v",
    "Yelda",
    "-o",
    aiff,
    "Bugün tarladayız. Bor eksikliği yapraklarda böyle görünür. Doğru zamanda doğru besleme, verimi korur.",
  ]);
  const clip = path.join(dir, "tarla.mp4");
  execFileSync(FFMPEG, [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=25:duration=14",
    "-i",
    aiff,
    "-filter_complex",
    "[0:v]hue=s=0.6,eq=brightness=-0.05[v];[1:a]apad[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    "14",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ]);
  return clip;
}

// ---------------------------------------------------------------- worker
const WORKER_ID = "p6-reels-e2e";
function startWorker(): ChildProcess {
  mkdirSync(stateDir, { recursive: true });
  const logFile = createWriteStream(path.join(stateDir, "worker.log"));
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    // A login-shell-like PATH without ffmpeg/whisper: the worker must find ffmpeg itself.
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    STUDIO_HUB_URL: `${apiBase.replace(/^http/, "ws")}/api/hub`,
    STUDIO_WORKER_TOKEN: token,
    STUDIO_WORKER_ID: WORKER_ID,
    STUDIO_STATE_DIR: stateDir,
    STUDIO_CLAUDE_BIN: path.join(process.env.HOME ?? "", ".local/bin/claude"),
    // No model call at start-up: only `claude auth status`.
    STUDIO_CLAUDE_SELFTEST: "never",
    STUDIO_SCHEDULE_POLL_INTERVAL_S: "0",
    STUDIO_LOG_LEVEL: "info",
  };
  // No --env-file: the developer's .env (API keys) must not leak into the test worker.
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: WORKER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logFile);
  child.stderr?.pipe(logFile);
  return child;
}

async function waitForWorker() {
  for (let i = 0; i < 120; i++) {
    const w = (await api.workers.presence()).workers.find((x) => x.workerId === WORKER_ID);
    if (w) {
      log(`worker online: ${w.workerVersion}; capabilities ${w.capabilities.join(", ")}`);
      if (!w.capabilities.includes("content.generate")) {
        throw new Error("worker did not announce content.generate (Claude not signed in?)");
      }
      return;
    }
    await sleep(1000);
  }
  throw new Error("worker did not connect");
}

async function waitJob(
  id: string,
  label: string,
  onProgress?: (j: Job) => Promise<void>,
): Promise<Job> {
  let last = "";
  for (;;) {
    const job = await api.jobs.get(id);
    const line =
      `${job.status} ${job.progress !== null && job.progress !== undefined ? `${Math.round(job.progress * 100)}%` : ""} ${job.progressMessage ?? ""}`.trim();
    if (line !== last && !/Kareler render ediliyor \(\d+\//.test(job.progressMessage ?? "")) {
      log(`  ${label}: ${line}`);
    }
    last = line;
    if (onProgress) await onProgress(job);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await sleep(700);
  }
}

function verify(mp4: string, seconds: number): { pass: boolean; summary: string; json: unknown } {
  const jsonPath = mp4.replace(/\.mp4$/, ".checks.json");
  let out = "";
  let pass = true;
  try {
    out = execFileSync(
      "python3",
      [
        path.join(HERE, "verify-reels.py"),
        mp4,
        "--duration",
        seconds.toFixed(3),
        "--json",
        jsonPath,
      ],
      {
        env: { ...process.env, FFMPEG, FFPROBE },
      },
    ).toString();
  } catch (error) {
    pass = false;
    out = String((error as { stdout?: Buffer }).stdout ?? error);
  }
  return { pass, summary: out.trim(), json: JSON.parse(readFileSync(jsonPath, "utf8")) };
}

// ---------------------------------------------------------------- reels
function specs(productId: string, clipId: string): Record<string, ReelSpecInput> {
  return {
    motion_graphics: {
      recipe: "motion_graphics",
      hook: "Bor eksikliği verimi sessizce düşürür",
      cta: "Doğru zamanda doğru besleme",
      heroAssetId: productId,
      scenes: [
        {
          eyebrow: "MTM Agro",
          headline: "Bor eksikliği verimi sessizce düşürür",
          subhead: "",
          durationMs: 2600,
        },
        {
          eyebrow: "Venta Borinc",
          headline: "Çiçeklenmede bor ve çinko",
          subhead: "Meyve tutumu için kritik iki element.",
          durationMs: 3000,
        },
        {
          eyebrow: "",
          headline: "Yapraktan uygulama, hızlı etki",
          subhead: "Tarlada pratik, bitkide etkili.",
          durationMs: 2600,
        },
      ],
      durationMs: 10000,
    },
    footage_edit: {
      recipe: "footage_edit",
      hook: "Tarlada bor eksikliği nasıl görünür?",
      cta: "MTM Agro",
      clipAssetId: clipId,
      overlays: [
        { text: "Yapraklarda şekil bozukluğu", startMs: 2600, endMs: 6200 },
        { text: "Çiçeklenmede dökülme", startMs: 6200, endMs: 9200 },
        { text: "Doğru zamanda doğru besleme", startMs: 9200, endMs: 12000 },
      ],
      durationMs: 12000,
    },
    narration: {
      recipe: "narration",
      hook: "Çiçeklenmede bor neden önemli?",
      cta: "Venta Borinc ile tanışın",
      heroAssetId: productId,
      narrationScript:
        "Çiçeklenme döneminde bor eksikliği meyve tutumunu düşürür. Venta Borinc, bor ve çinkoyu birlikte verir. Yapraktan uygulayın, bitkiniz farkı hemen hissetsin.",
      scenes: [
        { eyebrow: "", headline: "Meyve tutumu düşer", subhead: "", durationMs: 3000 },
        { eyebrow: "", headline: "Bor + çinko birlikte", subhead: "", durationMs: 3000 },
        { eyebrow: "", headline: "Yapraktan uygulama", subhead: "", durationMs: 3000 },
      ],
      durationMs: 10000,
    },
  };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const { brand, productId } = await seed();
  const clipPath = await makeSampleClip();
  const clip = await api.assets.upload({
    brandId: brand.id,
    kind: "video",
    file: file(clipPath, "video/mp4"),
  });
  log(
    `sample footage ${path.basename(clipPath)} (14 s, 1920×1080, Turkish voice) → asset ${clip.id}`,
  );

  const worker = startWorker();
  const stop = async () => {
    if (worker.exitCode !== null) return;
    worker.kill("SIGTERM");
    for (let i = 0; i < 40 && worker.exitCode === null; i++) await sleep(250);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(130)));
  const results: Record<string, unknown>[] = [];
  let failed = false;
  try {
    await waitForWorker();
    const all = specs(productId, clip.id);
    for (const [recipe, spec] of Object.entries(all)) {
      const content = await api.contents.create({
        brandId: brand.id,
        type: "reel",
        title: spec.hook ?? recipe,
        brief: spec.hook ?? "",
        targetPlatforms: ["instagram", "facebook"],
      });
      const started = Date.now();
      const job = await api.jobs.create({
        type: "content.generate",
        brandId: brand.id,
        contentId: content.id,
        payload: { brief: spec.hook ?? "", type: "reel", reel: { spec } },
      });
      log(`${recipe}: content.generate ${job.id}`);
      const done = await waitJob(job.id, recipe);
      const seconds = (Date.now() - started) / 1000;
      if (done.status !== "succeeded") {
        failed = true;
        log(`${recipe}: ${done.status} — ${done.error}`);
        results.push({ recipe, status: done.status, error: done.error });
        continue;
      }
      results.push(await collect(recipe, content.id, done, seconds));
    }

    // Editor change: new hook + shorter scenes → content.render (no AI) → new MP4.
    const motion = results.find((r) => r.recipe === "motion_graphics" && r.status === "succeeded");
    if (motion) {
      const contentId = motion.contentId as string;
      const c = await api.contents.get(contentId);
      const v = await api.contents.versions.get(contentId, c.currentVersion?.version ?? 1);
      const spec = readReelVersionInfo(v.slides[0]?.html ?? "").spec;
      if (!spec) throw new Error("motion reel has no spec");
      const scenes = spec.scenes.map((s, i) =>
        i === 0
          ? { ...s, headline: "Bor eksikliğini erken fark edin", durationMs: 3000 }
          : { ...s, durationMs: 2400 },
      );
      const started = Date.now();
      const job = await api.jobs.create({
        type: "content.render",
        brandId: brand.id,
        contentId,
        payload: { format: "mp4", reel: { hook: "Bor eksikliğini erken fark edin", scenes } },
      });
      log(`edit: content.render ${job.id} (hook + scene durations)`);
      const done = await waitJob(job.id, "edit");
      if (done.status !== "succeeded") {
        failed = true;
        log(`edit: ${done.status} — ${done.error}`);
      } else {
        results.push(
          await collect("motion_graphics-edit", contentId, done, (Date.now() - started) / 1000),
        );
      }
    }

    // Optional: ask the chat agent for a reel (real Claude, sonnet/low: the turn + the planner).
    if (process.env.STUDIO_E2E_CHAT === "1") {
      const conversation = await api.conversations.create({
        brandId: brand.id,
        title: "Reels isteği",
      });
      const text =
        "Venta Borinc için yaklaşık 8 saniyelik hareketli grafik bir Reels hazırla: çiçeklenmede bor ve çinkonun önemi. Instagram için. Bitince kısaca haber ver.";
      const started = Date.now();
      const sent = await api.conversations.messages.send(conversation.id, {
        text,
        model: "sonnet",
        effort: "low",
      });
      log(`chat: "${text}" (run ${sent.run.id}, sonnet/low)`);
      let run = sent.run;
      while (run.status === "queued" || run.status === "running") {
        await sleep(1500);
        run = await api.agentRuns.get(run.id);
      }
      const messages = (await api.conversations.messages.list(conversation.id, { limit: 10 }))
        .items;
      const answer = messages.find((m) => m.runId === run.id);
      const tools = (answer?.parts ?? [])
        .filter((p) => p.type === "tool_step")
        .map((p) => (p.type === "tool_step" ? `${p.name}:${p.state}` : ""));
      const reply = (answer?.parts ?? [])
        .map((p) => (p.type === "text" ? p.text : ""))
        .join(" ")
        .trim();
      log(
        `chat: run ${run.status} in ${((Date.now() - started) / 1000).toFixed(1)} s; tools ${tools.join(", ")}`,
      );
      log(`chat: assistant: ${reply.slice(0, 400)}`);
      const reels = (
        await api.contents.list({ brandId: brand.id, type: "reel", limit: 50 })
      ).items.filter((c) => !Object.values(all).some((sp) => sp.hook === c.title));
      const created = reels.find((c) => c.title !== "İptal denemesi");
      if (!created) {
        failed = true;
        log("chat: no reel content was created");
      } else {
        const jobs = (await api.jobs.list({ contentId: created.id, limit: 5 })).items;
        const job = jobs.find((j) => j.type === "content.generate");
        const done = job ? await waitJob(job.id, "chat reel") : null;
        if (done?.status === "succeeded") {
          results.push(
            await collect("chat-motion_graphics", created.id, done, (Date.now() - started) / 1000),
          );
        } else {
          failed = true;
          log(`chat reel: ${done?.status ?? "no job"} — ${done?.error ?? ""}`);
        }
      }
    }

    // Cancellation while frames are being rendered.
    const content = await api.contents.create({
      brandId: brand.id,
      type: "reel",
      title: "İptal denemesi",
      brief: "",
      targetPlatforms: ["instagram"],
    });
    const job = await api.jobs.create({
      type: "content.generate",
      brandId: brand.id,
      contentId: content.id,
      payload: { brief: "", type: "reel", reel: { spec: all.narration } },
    });
    let asked = false;
    const done = await waitJob(job.id, "cancel", async (j) => {
      if (!asked && (j.progress ?? 0) >= 0.45) {
        asked = true;
        await api.jobs.cancel(j.id);
        log(`cancel: requested at ${Math.round((j.progress ?? 0) * 100)}%`);
      }
    });
    const versions = (await api.contents.versions.list(content.id, {})).items.length;
    log(`cancel: job ${done.status}; versions stored ${versions}`);
    results.push({ recipe: "cancel", status: done.status, versionsStored: versions });
    if (done.status !== "cancelled" || versions !== 0) failed = true;
  } finally {
    await stop();
    writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(
      path.join(outDir, "transcript.md"),
      `# Reels uçtan uca (P6)\n\nÖzel API: ${apiBase.replace(/\/\/.*@/, "//")} · ${new Date().toISOString()}\n\n${transcript.join("\n")}\n`,
    );
  }
  if (failed) process.exit(1);
}

async function collect(recipe: string, contentId: string, job: Job, seconds: number) {
  const out = job.output as Record<string, unknown>;
  const c = await api.contents.get(contentId);
  const v = await api.contents.versions.get(contentId, c.currentVersion?.version ?? 1);
  const info = readReelVersionInfo(v.slides[0]?.html ?? "");
  const videoId = info.videoAssetId ?? "";
  const coverId = info.coverAssetId ?? "";
  const video = await ownerFetch(`${apiBase}/api/assets/${videoId}/content`);
  const mp4 = path.join(outDir, `${recipe}.mp4`);
  writeFileSync(mp4, new Uint8Array(await video.arrayBuffer()));
  const cover = await ownerFetch(`${apiBase}/api/assets/${coverId}/content`);
  writeFileSync(
    path.join(outDir, `${recipe}-cover.jpg`),
    new Uint8Array(await cover.arrayBuffer()),
  );
  const durationMs = info.durationMs ?? 0;
  const check = verify(mp4, durationMs / 1000);
  log(
    `${recipe}: v${v.version} (${v.origin}) ${(durationMs / 1000).toFixed(1)} s, ${Math.round(Number(out.bytes ?? 0) / 1024)} KiB, ${out.frames ?? "?"} frames, ${seconds.toFixed(1)} s wall; voice ${out.voice ?? "-"}, transcript ${out.transcript ?? "-"}; checks ${check.pass ? "PASS" : "FAIL"} (${check.summary.split("\n").at(-1)})`,
  );
  for (const w of (out.warnings as string[] | undefined) ?? []) log(`  ${recipe} note: ${w}`);
  log(`  ${recipe} version note: ${v.note}`);
  if (!check.pass) {
    for (const line of check.summary.split("\n").filter((l) => l.startsWith("FAIL")))
      log(`  ${line}`);
  }
  // Contact sheet: 6 frames.
  const sheet = path.join(outDir, `${recipe}-frames.jpg`);
  execFileSync(FFMPEG, [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    mp4,
    "-vf",
    `fps=${(6 / Math.max(1, durationMs / 1000)).toFixed(4)},scale=270:480,tile=6x1`,
    "-frames:v",
    "1",
    sheet,
  ]);
  return {
    recipe,
    status: "succeeded",
    contentId,
    version: v.version,
    origin: v.origin,
    durationMs,
    videoAssetId: videoId,
    coverAssetId: coverId,
    wallSeconds: Number(seconds.toFixed(1)),
    output: out,
    checksPass: check.pass,
    checks: (check.json as { checks: unknown }).checks,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
