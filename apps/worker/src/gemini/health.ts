/**
 * Gemini readiness probe: checks whether `GEMINI_API_KEY` is configured in the
 * worker environment and whether `gemini` CLI is installed on the Mac.
 * Never logs or exposes `GEMINI_API_KEY`.
 */
import { execFile } from "node:child_process";
import type { GeminiAccount, GeminiMode } from "@studio/contract";

const ENV_ALLOW = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"] as const;

export function buildGeminiEnv(
  parent: NodeJS.ProcessEnv,
  options: { apiKey?: string | undefined; extra?: Record<string, string> } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const val = parent[key];
    if (val) env[key] = val;
  }
  env.LANG ??= "en_US.UTF-8";
  if (options.apiKey) env.GEMINI_API_KEY = options.apiKey;
  if (options.extra) {
    for (const [k, v] of Object.entries(options.extra)) env[k] = v;
  }
  return env;
}

export function readGeminiCliVersion(
  bin = "gemini",
  env: Record<string, string> = buildGeminiEnv(process.env),
  timeoutMs = 3_000,
): Promise<string | null> {
  if (!env.PATH && !bin.includes("/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      bin,
      ["--version"],
      { env, timeout: timeoutMs, maxBuffer: 256_000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(null);
          return;
        }
        const text = `${String(stdout)}\n${String(stderr)}`.trim();
        const match = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)/.exec(text);
        if (match?.[1]) {
          resolve(match[1].slice(0, 64));
          return;
        }
        const first = text.split("\n")[0]?.trim();
        resolve(first ? first.slice(0, 64) : null);
      },
    );
  });
}

export interface CheckGeminiHealthOptions {
  apiKey?: string | undefined;
  /** Where `apiKey` came from: the vault (Ayarlar) or `.env`. */
  keySource?: "vault" | "env" | null | undefined;
  bin?: string | undefined;
  preferredMode?: "auto" | "api" | "cli" | undefined;
  defaultModel?: string | undefined;
  parentEnv?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  /** Test seams. */
  cliVersion?: () => Promise<string | null>;
  now?: () => Date;
}

export async function checkGeminiHealth(
  options: CheckGeminiHealthOptions = {},
): Promise<GeminiAccount> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const apiKeyConfigured = Boolean(options.apiKey && options.apiKey.trim().length > 0);
  const bin = options.bin ?? "gemini";
  const defaultModel = options.defaultModel ?? "gemini-2.5-flash-lite";
  const preferred = options.preferredMode ?? "auto";
  const env = buildGeminiEnv(options.parentEnv ?? {});
  const keySource = apiKeyConfigured ? (options.keySource ?? "env") : null;
  const keyLabel =
    keySource === "vault" ? "Studio kasasındaki API anahtarı" : ".env GEMINI_API_KEY";

  let cliVersion: string | null = null;
  try {
    cliVersion = options.cliVersion
      ? await options.cliVersion()
      : await readGeminiCliVersion(bin, env, options.timeoutMs ?? 3_000);
  } catch {
    cliVersion = null;
  }

  const mode: GeminiMode =
    apiKeyConfigured && cliVersion
      ? "both"
      : apiKeyConfigured
        ? "api"
        : cliVersion
          ? "cli"
          : "none";

  if (preferred === "api" && !apiKeyConfigured) {
    return {
      status: "not_configured",
      mode,
      apiKeyConfigured,
      keySource,
      cliVersion,
      defaultModel,
      detail: "Gemini API anahtarı yok (STUDIO_GEMINI_MODE=api): Ayarlar → Yapay zekâ'dan girin.",
      checkedAt,
    };
  }
  if (preferred === "cli" && !cliVersion) {
    return {
      status: "not_configured",
      mode,
      apiKeyConfigured,
      keySource,
      cliVersion,
      defaultModel,
      detail: `STUDIO_GEMINI_MODE=cli seçili ancak Mac'te \`${bin}\` komutu bulunamadı.`,
      checkedAt,
    };
  }

  const ready = apiKeyConfigured || cliVersion !== null;
  let detail: string;
  if (mode === "both") {
    detail = `${keyLabel} ve Gemini CLI (${cliVersion}) hazır · doğrudan API (${defaultModel})`;
  } else if (mode === "api") {
    detail = `${keyLabel} hazır · doğrudan API (${defaultModel})`;
  } else if (mode === "cli") {
    detail = `Gemini CLI (${cliVersion}) hazır · (${defaultModel})`;
  } else {
    detail = "Gemini API anahtarı yok: Ayarlar → Yapay zekâ'dan girin (ya da .env GEMINI_API_KEY)";
  }

  return {
    status: ready ? "ready" : "not_configured",
    mode,
    apiKeyConfigured,
    keySource,
    cliVersion,
    defaultModel,
    detail: detail.slice(0, 500),
    checkedAt,
  };
}
