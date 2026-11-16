/**
 * Startup self-test: `claude auth status` (free) and, unless a recent run proved it,
 * one tiny structured call. The result decides whether the worker announces the
 * Claude-backed job types to the hub; jobs then wait in the queue instead of failing.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildClaudeEnv, type ClaudeEnvOptions } from "./args.ts";
import { ClaudeError, ClaudeUsageLimitError } from "./errors.ts";
import type { ClaudeRunner } from "./runner.ts";

export type ClaudeHealthState =
  /** Logged in and the tiny call worked (or worked recently). */
  | "ok"
  /** Logged in, but the usage window is used up; calls are parked until `resetsAt`. */
  | "limited"
  /** Not logged in / token expired: Claude jobs are not announced. */
  | "unauthenticated"
  /** The binary is missing or the call failed for another reason. */
  | "error";

export interface ClaudeHealth {
  state: ClaudeHealthState;
  /** Turkish one-liner for logs, the hub and the UI. */
  message: string;
  checkedAt: string;
  cliVersion?: string;
  subscriptionType?: string;
  authMethod?: string;
  /** Present when the tiny call ran now (not taken from the cache). */
  callMs?: number;
  resetsAt?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  /** Raw failure text when the command itself failed. */
  error?: string;
}

export interface SelfTestOptions {
  bin?: string;
  env?: ClaudeEnvOptions;
  parentEnv?: NodeJS.ProcessEnv;
  runner: ClaudeRunner;
  model?: string;
  /** `auto`: tiny call only when the cached success is older than `maxAgeMs` or the CLI changed. */
  callMode?: "auto" | "always" | "never";
  stateDir: string;
  maxAgeMs?: number;
  /** Test seams. */
  authStatus?: () => Promise<AuthStatus>;
  cliVersion?: () => Promise<string | undefined>;
  now?: () => Date;
}

const CACHE_FILE = "claude-health.json";

function run(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env, timeout: timeoutMs, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")), code });
      },
    );
  });
}

/** `claude auth status --json`; only the fields we need are kept (no e-mail, no org). */
export async function readAuthStatus(
  bin = "claude",
  env: Record<string, string> = buildClaudeEnv(process.env),
): Promise<AuthStatus> {
  const res = await run(bin, ["auth", "status", "--json"], env, 20_000);
  try {
    const data = JSON.parse(res.stdout) as Record<string, unknown>;
    return {
      loggedIn: data.loggedIn === true,
      ...(typeof data.authMethod === "string" ? { authMethod: data.authMethod } : {}),
      ...(typeof data.subscriptionType === "string"
        ? { subscriptionType: data.subscriptionType }
        : {}),
    };
  } catch {
    return {
      loggedIn: false,
      error: (res.stderr || res.stdout).trim().slice(0, 300) || `exit ${res.code}`,
    };
  }
}

export async function readCliVersion(
  bin = "claude",
  env: Record<string, string> = buildClaudeEnv(process.env),
): Promise<string | undefined> {
  const res = await run(bin, ["--version"], env, 20_000);
  return /(\d+\.\d+\.\d+)/.exec(res.stdout)?.[1];
}

interface CacheEntry {
  okAt: string;
  cliVersion?: string;
}

async function readCache(stateDir: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(path.join(stateDir, CACHE_FILE), "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(stateDir: string, entry: CacheEntry): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, CACHE_FILE), JSON.stringify(entry, null, 2));
}

export async function claudeSelfTest(options: SelfTestOptions): Promise<ClaudeHealth> {
  const now = options.now ?? (() => new Date());
  const bin = options.bin ?? "claude";
  const env = buildClaudeEnv(options.parentEnv ?? process.env, options.env);
  const checkedAt = now().toISOString();
  const cliVersion = await (options.cliVersion ?? (() => readCliVersion(bin, env)))().catch(
    () => undefined,
  );
  if (!cliVersion && !options.cliVersion) {
    return {
      state: "error",
      message: `Mac'te \`${bin}\` komutu bulunamadı ya da çalışmadı. Claude Code kurulu mu?`,
      checkedAt,
    };
  }
  const auth = await (options.authStatus ?? (() => readAuthStatus(bin, env)))();
  const base = {
    checkedAt,
    ...(cliVersion ? { cliVersion } : {}),
    ...(auth.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
    ...(auth.authMethod ? { authMethod: auth.authMethod } : {}),
  };
  if (!auth.loggedIn) {
    return {
      ...base,
      state: "unauthenticated",
      message: "Claude oturumu yok/süresi doldu: Mac'te `claude auth login` çalıştırın.",
    };
  }
  const mode = options.callMode ?? "auto";
  if (mode === "never") {
    return { ...base, state: "ok", message: "Claude oturumu açık (deneme çağrısı atlandı)." };
  }
  if (mode === "auto") {
    const cache = await readCache(options.stateDir);
    const fresh =
      cache &&
      cache.cliVersion === cliVersion &&
      now().getTime() - Date.parse(cache.okAt) < (options.maxAgeMs ?? 6 * 3_600_000);
    if (fresh) {
      return {
        ...base,
        state: "ok",
        message: `Claude oturumu açık (son deneme çağrısı ${cache.okAt}).`,
      };
    }
  }
  const started = Date.now();
  try {
    const res = await options.runner({
      label: "self-test",
      system: "You are a health check. Answer only with the requested JSON.",
      content: [{ type: "text", text: 'Return {"ok": true}.' }],
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      ...(options.model ? { model: options.model } : {}),
      timeoutMs: 120_000,
    });
    const ok = (res.output as { ok?: unknown } | null)?.ok === true;
    if (!ok) {
      return { ...base, state: "error", message: "Claude deneme çağrısı beklenen yanıtı vermedi." };
    }
    await writeCache(options.stateDir, {
      okAt: checkedAt,
      ...(cliVersion ? { cliVersion } : {}),
    }).catch(() => undefined);
    return {
      ...base,
      state: "ok",
      message: "Claude oturumu açık, deneme çağrısı başarılı.",
      callMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof ClaudeUsageLimitError) {
      return {
        ...base,
        state: "limited",
        message: "Claude kullanım sınırı dolu; işler sıfırlanana kadar bekletilecek.",
        resetsAt: error.resetsAt.toISOString(),
      };
    }
    if (error instanceof ClaudeError && error.code === "auth") {
      return {
        ...base,
        state: "unauthenticated",
        message: "Claude oturumu yok/süresi doldu: Mac'te `claude auth login` çalıştırın.",
      };
    }
    return {
      ...base,
      state: "error",
      message: `Claude deneme çağrısı başarısız: ${(error as Error).message.slice(0, 200)}`,
    };
  }
}
