/**
 * The chat agent's tool-manager tools (contract tools.ts): `list_tools` reads what the Mac has
 * (ffmpeg, Claude Code, Python …) and `install_tool` installs one from its official source.
 * `install_tool` always asks a consent card first ("ffmpeg kurulsun mu? Kaynak: …, ~29 MB"),
 * through the chat's consent mechanism, so it works the same from the Mac app and the iPhone; on
 * approval it starts the `tool.install` job (POST /api/tools/{id}/install) and waits for it.
 */
import {
  ApiError,
  formatToolSize,
  isTerminalJobStatus,
  type Job,
  ToolId,
  type ToolStatus,
} from "@studio/contract";
import { z } from "zod";
import type { StudioApi } from "../api.ts";
import type { StudioToolDefinition } from "./tools.ts";

export const TOOL_MANAGER_TOOLS: readonly StudioToolDefinition[] = [
  {
    name: "list_tools",
    description:
      "Mac'teki araçların durumunu okur (Claude Code, Gemini CLI, Chromium, ffmpeg, Python, cloudflared, whisper.cpp): kurulu mu, sürüm, Studio'nun kopyası mı Mac'inki mi, kaynak ve boyut. Bir özellik bir araç yüzünden çalışmadığında (ör. Reels → ffmpeg, kod motoru → Python) önce buna bak.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "install_tool",
    description:
      "Bir aracı Mac'e resmi kaynağından kurar (ya da `update: true` ile Studio'nun kopyasını günceller). Kullanıcıya kaynak ve boyutla izin (consent) kartı gösterir ve yanıtını bekler; onay gelirse kurulumu başlatır ve bitmesini bekler. Mac'te zaten kurulu bir aracı kurmaz. Yalnızca kullanıcı istediğinde ya da bir özellik bu araç olmadan çalışamadığında kullan.",
    inputSchema: {
      type: "object",
      required: ["toolId"],
      properties: {
        toolId: {
          type: "string",
          enum: ToolId.options,
          description: "Kurulacak araç.",
        },
        update: {
          type: "boolean",
          description: "Studio'nun kurulu kopyasını yenisiyle değiştir (Güncelle).",
        },
      },
    },
  },
];

const InstallToolInput = z.object({
  toolId: ToolId,
  update: z.boolean().optional(),
});

export interface ToolManagerToolEnv {
  api: StudioApi;
  signal: AbortSignal;
  /** The chat's consent card (pending → allowed / denied / expired). */
  consent(input: {
    title: string;
    detail: string;
  }): Promise<{ allowed: true } | { allowed: false; reason: "denied_by_owner" | "expired" }>;
  /** Wait for the job outside the turn's clock (TurnWaits). */
  idle<T>(fn: () => Promise<T>): Promise<T>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Update the running step's summary ("ffmpeg indiriliyor… 12/29 MB"). */
  progress(summary: string): Promise<void>;
  jobPollMs?: number;
  /** How long to wait for the install (default 20 minutes). */
  jobTimeoutMs?: number;
}

function brief(t: ToolStatus) {
  return {
    id: t.id,
    label: t.label,
    state: t.state,
    version: t.version,
    location: t.location,
    installable: t.installable,
    purpose: t.purpose,
    source: t.source,
    size: formatToolSize(t.sizeBytes),
    ...(t.note ? { note: t.note } : {}),
    ...(t.error ? { error: t.error } : {}),
  };
}

export async function listToolsTool(env: ToolManagerToolEnv) {
  const control = await env.api.client.tools.list({ signal: env.signal });
  const missing = control.tools.filter((t) => t.state !== "installed");
  return {
    data: {
      ok: true,
      macOnline: control.online,
      tools: control.tools.map(brief),
      ...(control.tools.length === 0
        ? { note: "Mac'teki worker araç listesini henüz bildirmedi." }
        : {}),
    },
    summary:
      control.tools.length === 0
        ? "Liste yok"
        : missing.length === 0
          ? "Hepsi kurulu"
          : `Eksik: ${missing.map((t) => t.label).join(", ")}`,
  };
}

export async function installToolTool(
  env: ToolManagerToolEnv,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; summary: string; label?: string }> {
  const parsed = InstallToolInput.parse(args);
  const control = await env.api.client.tools.list({ signal: env.signal });
  const tool = control.tools.find((t) => t.id === parsed.toolId);
  if (!control.online) {
    throw new Error("Mac'teki worker bağlı değil; araç şu an kurulamaz.");
  }
  if (!tool) throw new Error(`${parsed.toolId} için durum bilgisi yok (worker henüz bildirmedi).`);
  if (tool.state === "installed" && (tool.location === "system" || !parsed.update)) {
    return {
      data: { ok: true, alreadyInstalled: true, tool: brief(tool) },
      summary: `${tool.label} zaten kurulu${tool.version ? ` (${tool.version})` : ""}`,
      label: "Araç zaten kurulu",
    };
  }
  if (tool.state === "installing") {
    return {
      data: { ok: true, installing: true, jobId: tool.jobId, tool: brief(tool) },
      summary: `${tool.label} zaten kuruluyor`,
      label: "Araç kuruluyor",
    };
  }
  if (!tool.installable) {
    return {
      data: {
        ok: false,
        installable: false,
        tool: brief(tool),
        note: tool.note ?? `${tool.label} uygulama içinden kurulamaz.`,
      },
      summary: `${tool.label} uygulama içinden kurulamaz`,
      label: "Araç kurulamaz",
    };
  }

  const verb = parsed.update || tool.state === "outdated" ? "güncellensin mi" : "kurulsun mu";
  const decision = await env.consent({
    title: `${tool.label} ${verb}?`,
    detail: `Kaynak: ${tool.source} (${tool.sourceUrl}) · ${formatToolSize(tool.sizeBytes)}. ${tool.purpose}${tool.note ? ` ${tool.note}` : ""}`,
  });
  if (!decision.allowed) {
    return {
      data: {
        ok: false,
        allowed: false,
        reason: decision.reason,
        note:
          decision.reason === "denied_by_owner"
            ? `Kullanıcı ${tool.label} kurulumuna izin vermedi.`
            : "İzin kartı yanıtlanmadı; kurulmadı.",
      },
      summary: decision.reason === "denied_by_owner" ? "İzin verilmedi" : "Onay süresi doldu",
      label: "Araç kurulmadı",
    };
  }

  let job: Job;
  try {
    job = await env.api.client.tools.install(
      tool.id,
      parsed.update || tool.state === "outdated" ? { update: true } : {},
      { signal: env.signal },
    );
  } catch (error) {
    if (error instanceof ApiError) throw new Error(`Kurulum başlatılamadı: ${error.message}`);
    throw error;
  }
  await env.progress(`${tool.label} kuruluyor…`);

  const final = await env.idle(async () => {
    const pollMs = env.jobPollMs ?? 2_000;
    const deadline = Date.now() + (env.jobTimeoutMs ?? 20 * 60_000);
    let current = job;
    let said = "";
    for (;;) {
      env.signal.throwIfAborted();
      if (isTerminalJobStatus(current.status)) return current;
      if (Date.now() > deadline) return current;
      await env.sleep(pollMs, env.signal);
      current = await env.api.client.jobs.get(job.id, { signal: env.signal });
      const line = current.progressMessage ?? "";
      if (line && line !== said) {
        said = line;
        await env.progress(line);
      }
    }
  });

  if (final.status === "succeeded") {
    const message =
      typeof final.output?.message === "string" ? final.output.message : `${tool.label} kuruldu.`;
    return {
      data: { ok: true, installed: true, jobId: final.id, message },
      summary: message,
      label: `${tool.label} kuruldu`,
    };
  }
  if (!isTerminalJobStatus(final.status)) {
    return {
      data: {
        ok: true,
        installed: false,
        jobId: final.id,
        note: "Kurulum sürüyor; bitince Ayarlar → Gelişmiş → Araçlar'da görünür.",
      },
      summary: "Kurulum sürüyor",
      label: `${tool.label} kuruluyor`,
    };
  }
  throw new Error(`${tool.label} kurulamadı: ${final.error ?? final.status}`.slice(0, 500));
}
