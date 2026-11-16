/**
 * Claude account & background sign-in controller (`worker.claude` / `claude.login` / `claude.status`).
 *
 * Reads `claude --version` and `claude auth status --json` to build `ClaudeAccount`,
 * and spawns `claude auth login --claudeai` in the background when requested from the app,
 * extracting any `https://...` sign-in URL live and re-checking status upon exit.
 */
import { type ChildProcess, execFile, spawn as nodeSpawn } from "node:child_process";
import type { ClaudeAccount } from "@studio/contract";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";
import { buildClaudeEnv, type ClaudeEnvOptions } from "./args.ts";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface RawClaudeAuthInfo {
  cliVersion: string | null;
  notInstalled?: boolean;
  loggedIn: boolean;
  email?: string | null;
  subscriptionType?: string | null;
  error?: string | null;
}

export interface ClaudeAuthControllerOptions {
  bin?: string;
  env?: ClaudeEnvOptions;
  parentEnv?: NodeJS.ProcessEnv;
  loginTimeoutMs?: number;
  /** While signing in, re-read `claude auth status` this often (default 3 s). */
  loginPollMs?: number;
  logger?: Logger;
  onLoginComplete?: () => void | Promise<void>;
  /** Test seams. */
  probe?: () => Promise<RawClaudeAuthInfo>;
  spawn?: typeof nodeSpawn;
  now?: () => Date;
}

function formatPlan(subscriptionType: string | null | undefined): string | null {
  if (!subscriptionType) return null;
  const s = subscriptionType.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "max") return "Claude Max";
  if (lower === "pro") return "Claude Pro";
  if (lower === "team") return "Claude Team";
  if (lower === "enterprise") return "Claude Enterprise";
  if (lower === "free") return "Claude Free";
  return s.startsWith("Claude ")
    ? s.slice(0, 200)
    : `Claude ${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`.slice(0, 200);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal ANSI escape codes
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function extractLoginUrl(text: string): string | null {
  const clean = text.replace(ANSI_ESCAPE, "");
  const match = /(https:\/\/[^\s"'<>)\]]+)/.exec(clean);
  if (!match?.[1]) return null;
  return match[1].replace(/[.,;]+$/, "").slice(0, 2_000);
}

function execCmd(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number; notFound: boolean }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env, timeout: timeoutMs, maxBuffer: 1_000_000 },
      (err, stdout, stderr) => {
        const errCode = (err as NodeJS.ErrnoException | null)?.code;
        const notFound = errCode === "ENOENT";
        const code = typeof errCode === "number" ? errCode : err ? 1 : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr || (err?.message ?? "")),
          code,
          notFound,
        });
      },
    );
  });
}

export async function probeClaudeAccountInfo(
  bin = "claude",
  env: Record<string, string> = buildClaudeEnv(process.env),
): Promise<RawClaudeAuthInfo> {
  if (!env.PATH && !bin.includes("/")) {
    return { cliVersion: null, notInstalled: true, loggedIn: false };
  }
  const verRes = await execCmd(bin, ["--version"], env, 5_000);
  const cliVersion = /(\d+\.\d+\.\d+)/.exec(verRes.stdout)?.[1] ?? null;
  if (verRes.notFound || (!cliVersion && verRes.code !== 0)) {
    return { cliVersion: null, notInstalled: true, loggedIn: false };
  }
  const authRes = await execCmd(bin, ["auth", "status", "--json"], env, 10_000);
  try {
    const data = JSON.parse(authRes.stdout) as Record<string, unknown>;
    return {
      cliVersion,
      loggedIn: data.loggedIn === true,
      email: typeof data.email === "string" && data.email ? data.email.slice(0, 320) : null,
      subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : null,
    };
  } catch {
    const rawErr = (authRes.stderr || authRes.stdout).trim();
    if (/not logged in|logged out/i.test(rawErr)) {
      return { cliVersion, loggedIn: false };
    }
    return {
      cliVersion,
      loggedIn: false,
      error: rawErr.slice(0, 300) || `claude auth status çıkış kodu: ${authRes.code}`,
    };
  }
}

export class ClaudeAuthController {
  private current: ClaudeAccount;
  private loginChild: ChildProcess | undefined;
  private loginTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(account: ClaudeAccount) => void>();
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly options: ClaudeAuthControllerOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
    this.current = {
      status: "signed_out",
      email: null,
      plan: null,
      cliVersion: null,
      loginUrl: null,
      detail: "Claude durumu henüz kontrol edilmedi.",
      checkedAt: new Date(0).toISOString(),
    };
  }

  latest(): ClaudeAccount {
    return this.current;
  }

  onUpdate(fn: (account: ClaudeAccount) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async refresh(): Promise<ClaudeAccount> {
    if (this.loginChild) {
      // Keep the active signing_in state while the login flow is still running.
      this.emit(this.current);
      return this.current;
    }
    const bin = this.options.bin ?? "claude";
    const env = buildClaudeEnv(this.options.parentEnv ?? process.env, this.options.env);
    const checkedAt = this.now().toISOString();
    const info = await (this.options.probe
      ? this.options.probe()
      : probeClaudeAccountInfo(bin, env));

    let next: ClaudeAccount;
    if (info.notInstalled) {
      next = {
        status: "not_installed",
        email: null,
        plan: null,
        cliVersion: null,
        loginUrl: null,
        detail: `Mac'te \`${bin}\` komutu bulunamadı. Claude Code CLI kurulu değil.`,
        checkedAt,
      };
    } else if (info.error) {
      next = {
        status: "error",
        email: null,
        plan: null,
        cliVersion: info.cliVersion,
        loginUrl: null,
        detail: `Claude oturum durumu okunamadı: ${info.error}`.slice(0, 500),
        checkedAt,
      };
    } else if (info.loggedIn) {
      const plan = formatPlan(info.subscriptionType);
      next = {
        status: "signed_in",
        email: info.email ?? null,
        plan,
        cliVersion: info.cliVersion,
        loginUrl: null,
        detail: plan ? `Claude oturumu açık (${plan})` : "Claude oturumu açık",
        checkedAt,
      };
    } else {
      next = {
        status: "signed_out",
        email: null,
        plan: null,
        cliVersion: info.cliVersion,
        loginUrl: null,
        detail: "Claude oturumu kapalı. Ayarlar'dan giriş yapabilirsiniz.",
        checkedAt,
      };
    }

    this.set(next);
    return next;
  }

  /** Sync account state when a runtime call discovers an auth failure. */
  markSignedOut(detail?: string): void {
    if (this.loginChild) return;
    this.set({
      ...this.current,
      status: "signed_out",
      loginUrl: null,
      detail: (detail ?? "Claude oturumu yok ya da süresi doldu.").slice(0, 500),
      checkedAt: this.now().toISOString(),
    });
  }

  /** Start `claude auth login --claudeai` in background (no-op if already signing in). */
  startLogin(): ClaudeAccount {
    if (this.loginChild) {
      this.emit(this.current);
      return this.current;
    }
    const bin = this.options.bin ?? "claude";
    const env = buildClaudeEnv(this.options.parentEnv ?? process.env, this.options.env);
    const spawn = this.options.spawn ?? nodeSpawn;
    const timeoutMs = this.options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

    let child: ChildProcess;
    try {
      // stdin stays open (as in Wecra): the CLI waits for the browser instead of reading EOF.
      child = spawn(bin, ["auth", "login", "--claudeai"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.on("error", () => undefined);
    } catch (error) {
      const failed: ClaudeAccount = {
        status: "error",
        email: null,
        plan: null,
        cliVersion: this.current.cliVersion,
        loginUrl: null,
        detail: `Claude girişi başlatılamadı: ${(error as Error).message}`.slice(0, 500),
        checkedAt: this.now().toISOString(),
      };
      this.set(failed);
      return failed;
    }

    this.loginChild = child;
    this.set({
      status: "signing_in",
      email: null,
      plan: null,
      cliVersion: this.current.cliVersion,
      loginUrl: null,
      detail: "Tarayıcıda Claude girişi başlatılıyor…",
      checkedAt: this.now().toISOString(),
    });

    let output = "";
    const onChunk = (chunk: string) => {
      if (this.loginChild !== child) return;
      if (output.length < 16_000) output += chunk;
      const url = extractLoginUrl(output);
      if (url && url !== this.current.loginUrl) {
        this.set({
          ...this.current,
          status: "signing_in",
          loginUrl: url,
          detail: "Tarayıcıda Claude girişini tamamlayın.",
          checkedAt: this.now().toISOString(),
        });
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onChunk);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", onChunk);

    // Poll the status: once signed in, the background login is not needed any more.
    const probe = this.options.probe ?? (() => probeClaudeAccountInfo(bin, env));
    this.pollTimer = setInterval(() => {
      if (this.loginChild !== child) return;
      void probe()
        .then((info) => {
          if (info.loggedIn && this.loginChild === child) {
            this.logger.info("claude: signed in; ending the background login");
            child.kill("SIGINT");
          }
        })
        .catch(() => undefined);
    }, this.options.loginPollMs ?? 3_000);
    this.pollTimer.unref?.();

    let timedOut = false;
    this.loginTimer = setTimeout(() => {
      if (this.loginChild !== child) return;
      timedOut = true;
      this.logger.warn("claude auth login timed out");
      child.kill("SIGTERM");
    }, timeoutMs);
    this.loginTimer.unref?.();

    const finalize = () => {
      if (this.loginChild !== child) return;
      clearTimeout(this.loginTimer);
      clearInterval(this.pollTimer);
      this.loginTimer = undefined;
      this.loginChild = undefined;
      void (async () => {
        const refreshed = await this.refresh();
        if (timedOut && refreshed.status !== "signed_in") {
          this.set({
            ...refreshed,
            detail: "Claude giriş süresi doldu; tekrar deneyebilirsiniz.",
            checkedAt: this.now().toISOString(),
          });
        }
        await this.options.onLoginComplete?.();
      })().catch((err: unknown) => {
        this.logger.warn(`claude login post-check failed: ${(err as Error).message}`);
      });
    };

    child.on("error", (err) => {
      if (this.loginChild !== child) return;
      clearTimeout(this.loginTimer);
      clearInterval(this.pollTimer);
      this.loginTimer = undefined;
      this.loginChild = undefined;
      const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      this.set({
        status: notFound ? "not_installed" : "error",
        email: null,
        plan: null,
        cliVersion: notFound ? null : this.current.cliVersion,
        loginUrl: null,
        detail: notFound
          ? `Mac'te \`${bin}\` komutu bulunamadı.`
          : `Claude girişi başarısız: ${err.message}`.slice(0, 500),
        checkedAt: this.now().toISOString(),
      });
    });
    child.on("close", finalize);

    return this.current;
  }

  stop(): void {
    clearTimeout(this.loginTimer);
    clearInterval(this.pollTimer);
    this.loginTimer = undefined;
    const child = this.loginChild;
    this.loginChild = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }

  private set(next: ClaudeAccount): void {
    const changed = JSON.stringify(this.current) !== JSON.stringify(next);
    this.current = next;
    if (changed) this.emit(next);
  }

  private emit(account: ClaudeAccount): void {
    for (const fn of this.listeners) fn(account);
  }
}
