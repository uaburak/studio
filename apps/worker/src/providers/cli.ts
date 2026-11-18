/**
 * Shared bits of the CLI-backed providers (Codex CLI, Antigravity CLI): a clean environment
 * (no API keys leak into a CLI that signs in with an account), a short command runner, the
 * provider error type and a background sign-in controller (`codex login`, `agy acp --login`).
 */
import { type ChildProcess, execFile, spawn as nodeSpawn } from "node:child_process";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";

const ENV_ALLOW = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
] as const;

/** Allow-listed parent environment: never API keys, so a CLI uses its own sign-in. */
export function buildCliEnv(
  parent: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const value = parent[key];
    if (value) env[key] = value;
  }
  env.LANG ??= "en_US.UTF-8";
  env.NO_COLOR = "1";
  return { ...env, ...extra };
}

export interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
  notFound: boolean;
  timedOut: boolean;
}

export type CmdRunner = (
  bin: string,
  args: string[],
  options: { env: Record<string, string>; timeoutMs: number; cwd?: string },
) => Promise<CmdResult>;

export const execCmd: CmdRunner = (bin, args, options) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 2_000_000,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        const notFound = e?.code === "ENOENT";
        const code = typeof e?.code === "number" ? e.code : e ? 1 : 0;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code,
          notFound,
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });

export function firstVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)/.exec(text)?.[1]?.slice(0, 64) ?? null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal ANSI escape codes
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** First `https://` URL in CLI output (the sign-in page). */
export function extractUrl(text: string): string | null {
  const match = /(https:\/\/[^\s"'<>)\]]+)/.exec(text.replace(ANSI_ESCAPE, ""));
  return match?.[1] ? match[1].replace(/[.,;]+$/, "").slice(0, 2_000) : null;
}

export type ProviderErrorCode = "auth" | "rate_limit" | "transient" | "timeout" | "spawn" | "api";

/** A failed call of a Codex / OpenAI / Antigravity driver (messages never carry keys). */
export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly provider: "codex" | "openai" | "antigravity",
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

const PROVIDER_NAMES = { codex: "Codex", openai: "OpenAI", antigravity: "Antigravity" } as const;

/** Turkish user-facing explanation (never includes keys). */
export function describeProviderError(error: ProviderError): string {
  const name = PROVIDER_NAMES[error.provider];
  switch (error.code) {
    case "auth":
      return error.provider === "openai"
        ? "OpenAI API anahtarı kabul edilmedi: Ayarlar → Yapay zekâ'dan anahtarı denetleyin."
        : `${name} oturumu kapalı: Ayarlar → Yapay zekâ'dan giriş yapın.`;
    case "rate_limit":
      return `${name} kullanım / hız sınırına ulaşıldı. Biraz sonra tekrar deneyin ya da başka bir model seçin.`;
    case "transient":
      return `${name} şu an yanıt veremiyor (geçici hata). Yeniden denenecek.`;
    case "timeout":
      return `${name} çağrısı zaman aşımına uğradı.`;
    case "spawn":
      return `${name} CLI bu Mac'te çalıştırılamadı: ${error.message.slice(0, 200)}`;
    default:
      return `${name} çağrısı başarısız oldu: ${error.message.slice(0, 300)}`;
  }
}

/** Classify a CLI / HTTP failure text. */
export function classifyFailure(text: string): ProviderErrorCode {
  if (
    /\b401\b|unauthori[sz]ed|not logged in|not signed in|authentication required|invalid api key|incorrect api key|please (?:log|sign) ?in/i.test(
      text,
    )
  )
    return "auth";
  if (/\b429\b|rate[ _-]?limit|usage limit|quota|resource_exhausted|too many requests/i.test(text))
    return "rate_limit";
  if (/\b5\d\d\b|timed? ?out|econnreset|network|temporarily|unavailable|overloaded/i.test(text))
    return "transient";
  return "api";
}

// --- background sign-in ------------------------------------------------------------------------

export interface LoginState {
  running: boolean;
  url: string | null;
  /** Turkish one-liner after the process ended (timeout, failure). */
  outcome: string | null;
}

export interface CliLoginOptions {
  bin: string;
  args: string[];
  env: () => Record<string, string>;
  /** Poll: true once signed in (the controller then stops the login process). */
  probe: () => Promise<boolean>;
  onChange: (state: LoginState) => void;
  onDone: () => void | Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  logger?: Logger;
  spawn?: typeof nodeSpawn;
  label: string;
}

/** Runs a CLI's browser sign-in in the background (`codex login`, `agy acp --login`). */
export class CliLoginController {
  private child: ChildProcess | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private state: LoginState = { running: false, url: null, outcome: null };

  constructor(private readonly options: CliLoginOptions) {}

  latest(): LoginState {
    return this.state;
  }

  start(): LoginState {
    if (this.child) return this.state;
    const logger = this.options.logger ?? silentLogger;
    const spawn = this.options.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawn(this.options.bin, this.options.args, {
        env: this.options.env(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.on("error", () => undefined);
    } catch (error) {
      this.set({
        running: false,
        url: null,
        outcome: `Giriş başlatılamadı: ${(error as Error).message}`,
      });
      return this.state;
    }
    this.child = child;
    this.set({ running: true, url: null, outcome: null });

    let output = "";
    const onChunk = (chunk: string) => {
      if (this.child !== child) return;
      if (output.length < 16_000) output += chunk;
      const url = extractUrl(output);
      if (url && url !== this.state.url) this.set({ ...this.state, url });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onChunk);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", onChunk);

    this.poll = setInterval(() => {
      if (this.child !== child) return;
      void this.options
        .probe()
        .then((ok) => {
          if (ok && this.child === child) {
            logger.info(`${this.options.label}: signed in; ending the background login`);
            child.kill("SIGINT");
          }
        })
        .catch(() => undefined);
    }, this.options.pollMs ?? 3_000);
    this.poll.unref?.();

    let timedOut = false;
    this.timer = setTimeout(
      () => {
        if (this.child !== child) return;
        timedOut = true;
        logger.warn(`${this.options.label}: sign-in timed out`);
        child.kill("SIGTERM");
      },
      this.options.timeoutMs ?? 10 * 60_000,
    );
    this.timer.unref?.();

    const end = (outcome: string | null) => {
      if (this.child !== child) return;
      clearTimeout(this.timer);
      clearInterval(this.poll);
      this.child = undefined;
      this.set({ running: false, url: null, outcome });
      void Promise.resolve(this.options.onDone()).catch(() => undefined);
    };
    child.on("error", (err) => {
      const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      end(notFound ? `\`${this.options.bin}\` bulunamadı.` : `Giriş başarısız: ${err.message}`);
    });
    child.on("close", () => end(timedOut ? "Giriş süresi doldu; tekrar deneyebilirsiniz." : null));
    return this.state;
  }

  stop(): void {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  private set(next: LoginState): void {
    this.state = next;
    this.options.onChange(next);
  }
}
