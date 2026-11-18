/**
 * Live acceptance run of the tool-using chat agent (task A5) against a PRIVATE local API:
 *
 *   seed: brand, a product photo (alias @urun), an Instagram account, an approved post ->
 *   turn 1: the real worker (src/main.ts, real `claude`) answers, looks at the photo
 *           (list_aliases, view_alias), proposes a plan (propose_plan) and asks for consent
 *           before scheduling (schedule_content); this script answers the consent card
 *           through the API after >60 s (proves a long hold) ->
 *   turn 2: a second message continues the same Claude session (`--resume`).
 *
 * Exactly two model calls (the self-test is skipped; `/usage` makes none). Output: transcript,
 * results and the raw stream of turn 1 (sanitized, as a parser fixture) under STUDIO_E2E_OUT.
 *
 *   STUDIO_E2E_API=http://127.0.0.1:8797 STUDIO_WORKER_TOKEN=<test token> \
 *   STUDIO_OWNER_SECRET=<the API's --var STUDIO_OWNER_SECRET> \
 *   STUDIO_E2E_STATE=$S/worker STUDIO_E2E_OUT=$S/out pnpm --filter @studio/worker exec tsx scripts/e2e-agent.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeContentHash, createApiClient, type Message } from "@studio/contract";
import { OwnerWebSocket, ownerFetch, requireOwnerSecret } from "./owner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, "..");
const ROOT = path.resolve(WORKER_DIR, "../..");
const PHOTO = path.join(ROOT, "spikes/gemini-image/refs/venta-borinc.png");

const apiBase = process.env.STUDIO_E2E_API ?? "";
const token = process.env.STUDIO_WORKER_TOKEN ?? "";
const stateDir = process.env.STUDIO_E2E_STATE ?? "";
const outDir = path.resolve(process.env.STUDIO_E2E_OUT ?? path.join(stateDir, "out"));
const model = process.env.STUDIO_E2E_MODEL ?? "sonnet";
const holdMs = Number(process.env.STUDIO_E2E_CONSENT_WAIT_MS ?? 65_000);
if (!apiBase || !token || !stateDir) {
  console.error("set STUDIO_E2E_API, STUDIO_WORKER_TOKEN and STUDIO_E2E_STATE");
  process.exit(2);
}
if (/:(8787|8790|8791)\b/.test(apiBase)) {
  console.error("refusing to run against a shared API (8787 dev, 8790/8791 the Mac host)");
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

function startWorker(): ChildProcess {
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
    STUDIO_WORKER_ID: "a5-e2e",
    STUDIO_STATE_DIR: stateDir,
    STUDIO_CLAUDE_LOG_STREAMS: "1",
    STUDIO_CLAUDE_SELFTEST: "never", // no extra model call
    STUDIO_SCHEDULE_POLL_INTERVAL_S: "0",
    STUDIO_LOG_LEVEL: "info",
  };
  const tsx = path.join(WORKER_DIR, "node_modules/.bin/tsx");
  const child = spawn(tsx, ["src/main.ts"], {
    cwd: WORKER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logFile);
  child.stderr?.pipe(logFile);
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (/claude|job .* (started|succeeded|failed)|ERROR|WARN|mcp/.test(line)) {
        console.log(`  [worker] ${line.slice(25, 260)}`);
      }
    }
  });
  return child;
}

async function waitForWorker() {
  for (let i = 0; i < 120; i++) {
    const presence = await api.workers.presence();
    const w = presence.workers.find((x) => x.workerId === "a5-e2e");
    if (w?.capabilities.includes("chat.turn")) {
      log(
        `worker online (${w.workerVersion}); presence.claude: ${presence.claude?.status ?? "-"} ${presence.claude?.plan ?? ""}`,
      );
      return;
    }
    await sleep(1000);
  }
  throw new Error("worker did not announce chat.turn");
}

async function seed() {
  const brand = await api.brands.create({
    name: `A5 e2e ${new Date().toISOString().slice(11, 19)}`,
  });
  const photo = await api.assets.upload({
    brandId: brand.id,
    file: new File([readFileSync(PHOTO)], "venta-borinc.png", { type: "image/png" }),
  });
  const account = await api.socialAccounts.create({
    brandId: brand.id,
    platform: "instagram",
    handle: "@a5_e2e_deneme",
  });
  const content = await api.contents.create({
    brandId: brand.id,
    type: "post",
    title: "Kış bakımı ipuçları",
    brief: "Toprağı kışa hazırlamak için üç ipucu",
    targetPlatforms: ["instagram"],
  });
  const slides = [
    { html: "<html><body><h1>Kış bakımı</h1></body></html>", width: 1080, height: 1350 },
  ];
  await api.contents.versions.create(content.id, { origin: "generated", slides });
  // No check run for a hand-made version: approve past the checks gate (E7).
  const approved = await api.contents.approve(content.id, {
    hash: await computeContentHash(slides),
    acknowledgeChecks: true,
  });
  const conversation = await api.conversations.create({
    brandId: brand.id,
    title: "A5 canlı deneme",
  });
  log(
    `seeded brand ${brand.id}, photo ${photo.id}, account ${account.id}, content ${approved.id} (${approved.status}), conversation ${conversation.id}`,
  );
  return { brand, photo, account, content: approved, conversation };
}

async function waitRun(runId: string, onTick?: (msgs: Message[]) => Promise<void>) {
  for (;;) {
    try {
      const run = await api.agentRuns.get(runId);
      if (onTick) {
        const msgs = (await api.conversations.messages.list(run.conversationId, { limit: 20 }))
          .items;
        await onTick(msgs.reverse());
      }
      if (!["queued", "running"].includes(run.status)) return run;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error; // fetch failed: the API restarts; retry
      log(`API not reachable (${error.message}); retrying`);
    }
    await sleep(1000);
  }
}

function describe(message: Message): string {
  return message.parts
    .map((p) => {
      switch (p.type) {
        case "text":
          return `text: ${p.text.replace(/\s+/g, " ").slice(0, 400)}`;
        case "tool_step":
          return `tool_step ${p.name} [${p.state}] ${p.label}${p.summary ? ` — ${p.summary}` : ""}`;
        case "consent":
          return `consent ${p.tool} [${p.state}] ${p.title}${p.detail ? ` — ${p.detail}` : ""}`;
        case "progress":
          return `progress ${p.stepId} [${p.state}] ${p.label}${p.detail ? ` (${p.detail})` : ""}`;
        case "plan_proposal":
          return `plan_proposal ${p.planId}`;
        default:
          return p.type;
      }
    })
    .join("\n    ");
}

/** The turn's raw stream, sanitized for a test fixture (home path, image data). */
function sanitizeStream(raw: string): string {
  const home = homedir();
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      const scrub = (v: unknown): unknown => {
        if (typeof v === "string") return v.split(home).join("/Users/x");
        if (Array.isArray(v)) return v.map(scrub);
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          if (o.type === "image" && typeof o.data === "string") return { ...o, data: "<base64>" };
          if (o.type === "base64" && typeof o.data === "string") return { ...o, data: "<base64>" };
          return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, scrub(x)]));
        }
        return v;
      };
      return JSON.stringify(scrub(event));
    })
    .join("\n");
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const seeded = await seed();
  const worker = startWorker();
  const results: Record<string, unknown> = {};
  try {
    await waitForWorker();
    const text1 =
      "Merhaba! Sırayla üç şey istiyorum. 1) Sohbetteki görselleri list_aliases ile listele, sonra @urun görseline view_alias ile bak ve görselde ne olduğunu tek cümleyle söyle. " +
      "2) Aralık 2026 için yalnızca 3 postluk kısa bir içerik planı öner (propose_plan); ürün postunda @urun kullanılsın. " +
      `3) Onaylı "${seeded.content.title}" postunu (contentId: ${seeded.content.id}) Instagram hesabında (socialAccountId: ${seeded.account.id}) 2026-12-01T07:00:00Z zamanına zamanla (schedule_content). Kısa yaz.`;
    const sent1 = await api.conversations.messages.send(seeded.conversation.id, {
      text: text1,
      attachments: [{ assetId: seeded.photo.id, alias: "urun" }],
      model: model as "sonnet",
      effort: "low",
    });
    log(`turn 1 sent (run ${sent1.run.id}, ${model}/low)`);
    let consentSeenAt = 0;
    let answered = false;
    const run1 = await waitRun(sent1.run.id, async (msgs) => {
      const assistant = msgs.find((m) => m.runId === sent1.run.id);
      const card = assistant?.parts.find((p) => p.type === "consent");
      if (!assistant || card?.type !== "consent" || answered) return;
      if (card.state !== "pending") return;
      if (!consentSeenAt) {
        consentSeenAt = Date.now();
        log(
          `consent card: ${card.title} — ${card.detail ?? ""}; answering in ${Math.round(holdMs / 1000)} s`,
        );
      }
      if (Date.now() - consentSeenAt >= holdMs) {
        answered = true;
        const res = await api.conversations.messages.consent(seeded.conversation.id, assistant.id, {
          consentId: card.consentId,
          allow: true,
        });
        const after = res.message.parts.find((p) => p.type === "consent");
        log(
          `consent answered via API after ${Math.round((Date.now() - consentSeenAt) / 1000)} s: ${after?.type === "consent" ? after.state : "?"}`,
        );
      }
    });
    const msgs1 = (
      await api.conversations.messages.list(seeded.conversation.id, { limit: 20 })
    ).items.reverse();
    const answer1 = msgs1.find((m) => m.runId === sent1.run.id);
    log(
      `turn 1 ${run1.status}; model ${run1.model}; parts:\n    ${answer1 ? describe(answer1) : "-"}`,
    );
    const conv1 = await api.conversations.get(seeded.conversation.id);
    const schedules = await api.schedules.list({ contentId: seeded.content.id });
    const plans = await api.plans.list({ conversationId: seeded.conversation.id });
    log(`agentSession after turn 1: ${JSON.stringify(conv1.agentSession)}`);
    log(
      `schedules: ${schedules.items.map((s) => `${s.platform} ${s.scheduledAt} ${s.status}`).join(", ") || "none"}; plans: ${plans.items.map((p) => `${p.items.length} items ${p.status}`).join(", ")}`,
    );
    const job1 = run1.jobId ? await api.jobs.get(run1.jobId) : undefined;
    results.turn1 = {
      run: run1,
      output: job1?.output,
      parts: answer1?.parts,
      agentSession: conv1.agentSession,
    };

    const sent2 = await api.conversations.messages.send(seeded.conversation.id, {
      text: "Teşekkürler! Planın ürün postunun başlığını tek cümleyle tekrar söyler misin?",
      model: model as "sonnet",
      effort: "low",
    });
    log(`turn 2 sent (run ${sent2.run.id})`);
    const run2 = await waitRun(sent2.run.id);
    const msgs2 = (
      await api.conversations.messages.list(seeded.conversation.id, { limit: 20 })
    ).items.reverse();
    const answer2 = msgs2.find((m) => m.runId === sent2.run.id);
    const job2 = run2.jobId ? await api.jobs.get(run2.jobId) : undefined;
    const conv2 = await api.conversations.get(seeded.conversation.id);
    log(
      `turn 2 ${run2.status}; output resumedSession=${String((job2?.output as { resumedSession?: boolean } | undefined)?.resumedSession)} sessionId=${String((job2?.output as { sessionId?: string } | undefined)?.sessionId)}; parts:\n    ${answer2 ? describe(answer2) : "-"}`,
    );
    log(`agentSession after turn 2: ${JSON.stringify(conv2.agentSession)}`);
    results.turn2 = {
      run: run2,
      output: job2?.output,
      parts: answer2?.parts,
      agentSession: conv2.agentSession,
    };

    const presence = await api.workers.presence();
    log(
      `presence.usage: ${JSON.stringify(presence.usage?.windows.map((w) => [w.kind, w.usedPercent, w.limited]))} (${presence.usage?.source})`,
    );
    results.presence = {
      usage: presence.usage,
      claude: presence.claude
        ? { status: presence.claude.status, plan: presence.claude.plan }
        : null,
    };

    // Raw streams (one per Claude call) -> the parser fixture.
    const logs = path.join(stateDir, "claude-logs");
    const files = readdirSync(logs)
      .filter((f) => f.endsWith(".stream.jsonl"))
      .sort();
    results.claudeCalls = files.length;
    log(`claude calls (stream logs): ${files.length}`);
    const sessionOf = (f: string) =>
      (
        JSON.parse(readFileSync(path.join(logs, f), "utf8").split("\n")[0] ?? "{}") as {
          session_id?: string;
        }
      ).session_id;
    log(`session ids per call: ${files.map(sessionOf).join(", ")}`);
    if (files[0]) {
      writeFileSync(
        path.join(outDir, "real-agent-turn.stream.jsonl"),
        `${sanitizeStream(readFileSync(path.join(logs, files[0]), "utf8"))}\n`,
      );
    }
  } finally {
    worker.kill("SIGINT");
    await sleep(1500);
    writeFileSync(
      path.join(outDir, "transcript.md"),
      `# A5 canlı deneme\n\n${transcript.join("\n")}\n`,
    );
    writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
