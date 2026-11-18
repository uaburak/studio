/**
 * End-to-end acceptance run against a PRIVATE local API (never the shared one):
 *
 *   seed brand "MTM Agro" + provisional profile (from spikes/design-render/brand/venta, brand files
 *   uploaded as assets) + the Venta Borinc photo -> conversation -> user message with @image ->
 *   the real worker (spawned: src/main.ts, real headless Claude) answers and proposes a plan ->
 *   accept at most N items -> generate -> save renders + transcript under docs/e2e/.
 *
 * Usage (API started separately with its own --persist-to and WORKER_TOKEN):
 *   STUDIO_E2E_API=http://127.0.0.1:8797 STUDIO_WORKER_TOKEN=<test token> \
 *   STUDIO_OWNER_SECRET=<the API's --var STUDIO_OWNER_SECRET> \
 *   STUDIO_E2E_STATE=/tmp/a4-worker-state pnpm --filter @studio/worker e2e
 * Options: STUDIO_E2E_ITEMS (default 3), STUDIO_E2E_OUT (default docs/e2e).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConversationStreamMessage,
  createApiClient,
  type Job,
  type Plan,
  type PlanItem,
} from "@studio/contract";
import sharp from "sharp";
import { OwnerWebSocket, ownerFetch, requireOwnerSecret } from "./owner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, "..");
const ROOT = path.resolve(WORKER_DIR, "../..");
const VENTA = path.join(ROOT, "spikes/design-render/brand/venta");
const PHOTO = path.join(ROOT, "spikes/gemini-image/refs/venta-borinc.png");
const MESSAGE =
  "MTM için kasım ayının postlarını planla, ürün postunda @image kullan, diğer görselleri ben yükleyeceğim";

const apiBase = process.env.STUDIO_E2E_API ?? "";
const token = process.env.STUDIO_WORKER_TOKEN ?? "";
const stateDir = process.env.STUDIO_E2E_STATE ?? "";
const maxItems = Number(process.env.STUDIO_E2E_ITEMS ?? 3);
const outDir = path.resolve(process.env.STUDIO_E2E_OUT ?? path.join(WORKER_DIR, "docs/e2e"));
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
  console.log(`[e2e ${stamp}] ${line}`);
  transcript.push(`- \`${stamp}\` ${line}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function file(p: string, type: string, name = path.basename(p)): File {
  return new File([readFileSync(p)], name, { type });
}

// ---------------------------------------------------------------- seed
async function seed() {
  const existing = (await api.brands.list({ limit: 100 })).items.find((b) => b.slug === "mtm-agro");
  const brand =
    existing ??
    (await api.brands.create({ name: "MTM Agro", slug: "mtm-agro", defaultLanguage: "tr" }));
  log(`brand ${brand.name} (${brand.id})`);

  const fileAssets: Record<string, string> = {};
  const uploads: [string, string, "font" | "logo" | "image"][] = [];
  for (const name of readdirSync(path.join(VENTA, "fonts"))) {
    if (name.endsWith(".woff2")) uploads.push([`fonts/${name}`, "font/woff2", "font"]);
  }
  for (const name of readdirSync(path.join(VENTA, "logos"))) {
    if (name.endsWith(".png")) uploads.push([`logos/${name}`, "image/png", "logo"]);
  }
  uploads.push(["assets/product-venta-borinc.png", "image/png", "image"]);
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
  }
  log(`uploaded ${uploads.length} brand files (fonts, stand-in logos, product photo) as assets`);

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
  const approved = await api.brandProfiles.approve(brand.id, profile.version);
  log(
    `brand profile v${approved.version} approved (tokens.status = provisional, derived from the Venta pack)`,
  );

  const meta = await sharp(PHOTO).metadata();
  const photo = await api.assets.upload({
    brandId: brand.id,
    kind: "image",
    ...(meta.width && meta.height ? { width: meta.width, height: meta.height } : {}),
    file: file(PHOTO, "image/png"),
  });
  log(`uploaded ${path.basename(PHOTO)} (${meta.width}x${meta.height}) as asset ${photo.id}`);
  return { brand, photo };
}

// ---------------------------------------------------------------- worker
function startWorkerProcess(): ChildProcess {
  mkdirSync(stateDir, { recursive: true });
  const logFile = createWriteStream(path.join(stateDir, "worker.log"));
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    STUDIO_HUB_URL: `${apiBase.replace(/^http/, "ws")}/api/hub`,
    STUDIO_WORKER_TOKEN: token,
    STUDIO_WORKER_ID: "a4-e2e",
    STUDIO_STATE_DIR: stateDir,
    STUDIO_CLAUDE_LOG_STREAMS: "1",
    STUDIO_LOG_LEVEL: "info",
  };
  const tsx = path.join(WORKER_DIR, "node_modules/.bin/tsx");
  // No --env-file: the developer's apps/worker/.env must not leak into the test worker.
  const child = spawn(tsx, ["src/main.ts"], {
    cwd: WORKER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logFile);
  child.stderr?.pipe(logFile);
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (/claude|job .* (started|succeeded|failed)|ERROR|WARN/.test(line))
        console.log(`  [worker] ${line.slice(25)}`);
    }
  });
  return child;
}

async function waitForWorker() {
  for (let i = 0; i < 120; i++) {
    const presence = await api.workers.presence();
    const w = presence.workers.find((x) => x.workerId === "a4-e2e");
    if (w) {
      log(`worker online: version ${w.workerVersion}, capabilities ${w.capabilities.join(", ")}`);
      if (!w.capabilities.includes("chat.turn"))
        throw new Error("worker did not announce chat.turn (Claude self-test failed?)");
      return;
    }
    await sleep(1000);
  }
  throw new Error("worker did not connect");
}

// ---------------------------------------------------------------- main
async function main() {
  mkdirSync(outDir, { recursive: true });
  const { brand, photo } = await seed();
  const worker = startWorkerProcess();
  const stopWorker = async () => {
    if (worker.exitCode !== null) return;
    worker.kill("SIGTERM");
    for (let i = 0; i < 40 && worker.exitCode === null; i++) await sleep(250);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  };
  process.on("SIGINT", () => void stopWorker().then(() => process.exit(130)));
  try {
    await waitForWorker();
    const conversation = await api.conversations.create({
      brandId: brand.id,
      title: "Kasım planı",
    });

    // Follow the conversation like the app does: count deltas and when they arrive.
    const frames: { at: number; frame: ConversationStreamMessage }[] = [];
    const watch = api.conversations.watch(conversation.id, {
      onMessage: (frame) => frames.push({ at: Date.now(), frame }),
    });
    await sleep(500);

    const sentAt = Date.now();
    const sent = await api.conversations.messages.send(conversation.id, {
      text: MESSAGE,
      attachments: [{ assetId: photo.id }],
      clientMessageId: `e2e-${Date.now()}`,
    });
    log(
      `user: "${MESSAGE}" + attachment @${sent.message.parts.find((p) => p.type === "attachment")?.alias ?? "?"}`,
    );
    log(
      `mentions resolved by the API: ${(sent.message.mentions ?? []).map((m) => `@${m.alias}`).join(", ") || "(none)"}`,
    );

    let run = sent.run;
    while (run.status === "queued" || run.status === "running") {
      await sleep(1000);
      run = await api.agentRuns.get(run.id);
    }
    const firstDelta = frames.find((f) => f.frame.type === "text.delta");
    const deltaCount = frames.filter((f) => f.frame.type === "text.delta").length;
    log(
      `chat turn ${run.status} in ${((Date.now() - sentAt) / 1000).toFixed(1)} s; first text delta after ${firstDelta ? ((firstDelta.at - sentAt) / 1000).toFixed(1) : "?"} s; ${deltaCount} delta frames; usage ${JSON.stringify(run.usage)}`,
    );
    if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);

    const messages = (
      await api.conversations.messages.list(conversation.id, { limit: 10 })
    ).items.reverse();
    const assistant = messages.find((m) => m.runId === run.id);
    const reply = assistant?.parts
      .filter((p) => p.type === "text")
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    log(`assistant:\n\n> ${(reply ?? "").replace(/\n/g, "\n> ")}\n`);

    const plans = (await api.plans.list({ conversationId: conversation.id })).items;
    const plan = plans[0] as Plan | undefined;
    if (!plan) throw new Error("no plan was proposed");
    log(
      `plan "${plan.title}" ${plan.periodStart}..${plan.periodEnd}, ${plan.items.length} items (status ${plan.status}):`,
    );
    for (const item of plan.items) {
      transcript.push(
        `  ${item.position + 1}. ${item.date ?? "-"} · ${item.contentType} · ${item.platforms.join("/")} · **${item.title}** · ${item.pillar ?? "-"} · görsel: ${item.imageSlot}${item.imageBrief ? ` (${item.imageBrief})` : ""}\n     ${item.brief}`,
      );
    }

    // Accept at most N items: the @image product post, then a carousel, then others.
    const chosen: PlanItem[] = [];
    const pick = (fn: (i: PlanItem) => boolean) => {
      const item = plan.items.find((i) => fn(i) && !chosen.includes(i));
      if (item && chosen.length < maxItems) chosen.push(item);
    };
    pick((i) => /@image\b/.test(i.imageBrief ?? ""));
    pick((i) => i.contentType === "carousel");
    pick((i) => i.imageSlot === "none");
    while (chosen.length < Math.min(maxItems, plan.items.length)) pick(() => true);
    const skip = plan.items.filter((i) => !chosen.includes(i)).map((i) => i.id);
    const accepted = await api.plans.accept(plan.id, {
      revision: plan.revision,
      skipItemIds: skip,
    });
    log(
      `accepted ${chosen.length} item(s): ${chosen.map((i) => `${i.position + 1}. ${i.title}`).join("; ")} (${skip.length} skipped)`,
    );

    const generated = await api.plans.generate(accepted.id, { itemIds: chosen.map((i) => i.id) });
    log(`queued ${generated.jobs.length} content.generate job(s)`);
    const results: Job[] = [];
    for (const job of generated.jobs) {
      let current = job;
      let lastMessage = "";
      const started = Date.now();
      while (current.status === "queued" || current.status === "running") {
        await sleep(3000);
        current = await api.jobs.get(job.id);
        if (current.progressMessage && current.progressMessage !== lastMessage) {
          lastMessage = current.progressMessage;
          console.log(`  [job ${job.id.slice(-6)}] ${current.progressMessage}`);
        }
      }
      log(
        `content.generate ${job.id} ${current.status} after ${((Date.now() - started) / 1000).toFixed(0)} s${current.error ? `: ${current.error}` : ""}`,
      );
      results.push(current);
    }
    watch.close();

    // Save renders + a contact sheet.
    const tiles: { file: string; label: string }[] = [];
    const summaries: Record<string, unknown>[] = [];
    for (const [n, job] of results.entries()) {
      const item = accepted.items.find((i) => i.contentId === job.contentId);
      const out = (job.output ?? {}) as Record<string, unknown>;
      summaries.push({
        item: item?.title,
        jobId: job.id,
        status: job.status,
        error: job.error ?? null,
        ...out,
      });
      if (job.status !== "succeeded" || !job.contentId) continue;
      const content = await api.contents.get(job.contentId);
      const version = await api.contents.versions.get(
        job.contentId,
        content.currentVersion?.version ?? 1,
      );
      for (const [i, slide] of version.slides.entries()) {
        if (!slide.renderedAssetId) continue;
        const res = await ownerFetch(api.assets.contentUrl(slide.renderedAssetId));
        const name = `${n + 1}-${item?.contentType ?? content.type}-slide-${i + 1}.jpg`;
        writeFileSync(path.join(outDir, name), new Uint8Array(await res.arrayBuffer()));
        tiles.push({ file: path.join(outDir, name), label: `${n + 1}.${i + 1} ${content.title}` });
      }
      log(
        `post ${n + 1} "${content.title}": v${version.version}, ${version.slides.length} slide(s), lint ${out.lintClean ? "clean" : `${String(out.errors)} error(s)`}, ${String(out.warnings)} warning(s), ${String(out.calls)} Claude calls, ${Math.round(Number((out.timings as { totalMs?: number } | undefined)?.totalMs ?? 0) / 1000)} s; caption: ${content.caption.replace(/\n/g, " ").slice(0, 160)}…`,
      );
    }
    if (tiles.length) {
      const tw = 360;
      const th = 450;
      const cols = Math.min(4, tiles.length);
      const rows = Math.ceil(tiles.length / cols);
      const composites = await Promise.all(
        tiles.map(async (t, i) => ({
          input: await sharp(t.file)
            .resize(tw, th, { fit: "contain", background: "#ececec" })
            .toBuffer(),
          left: 16 + (i % cols) * (tw + 16),
          top: 16 + Math.floor(i / cols) * (th + 16),
        })),
      );
      await sharp({
        create: {
          width: 16 + cols * (tw + 16),
          height: 16 + rows * (th + 16),
          channels: 3,
          background: "#ececec",
        },
      })
        .composite(composites)
        .jpeg({ quality: 86 })
        .toFile(path.join(outDir, "overview.jpg"));
    }
    writeFileSync(
      path.join(outDir, "results.json"),
      `${JSON.stringify({ conversationId: conversation.id, planId: plan.id, run: { id: run.id, status: run.status, usage: run.usage }, posts: summaries }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(outDir, "transcript.md"),
      `# A4 uçtan uca çalıştırma\n\n${new Date().toISOString()}\n\n${transcript.join("\n")}\n`,
    );
    log(
      `saved ${tiles.length} render(s), overview.jpg, results.json, transcript.md to ${path.relative(ROOT, outDir)}`,
    );
  } finally {
    await stopWorker();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    writeFileSync(
      path.join(outDir, "transcript.md"),
      `# A4 uçtan uca çalıştırma (BAŞARISIZ)\n\n${transcript.join("\n")}\n\n${String(error)}\n`,
    );
    process.exit(1);
  },
);
