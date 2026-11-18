/**
 * Readiness of the Mac's other AI providers (presence `providers`): Codex CLI, OpenAI API (key in
 * the vault) and Antigravity CLI, plus their background sign-ins. Claude and Gemini keep their
 * own controllers (`worker.claude`, `worker.gemini`).
 */
import type { spawn as nodeSpawn } from "node:child_process";
import type { AiProviderStatus } from "@studio/contract";
import type { AgentSettings } from "../agent.ts";
import type { Logger } from "../log.ts";
import { type AntigravityProbe, probeAntigravity } from "./antigravity.ts";
import { buildCliEnv, CliLoginController, type LoginState } from "./cli.ts";
import { type CodexProbe, probeCodex } from "./codex.ts";
import { pickOpenAiModel } from "./openai.ts";

export interface ProvidersControllerOptions {
  settings: AgentSettings;
  logger: Logger;
  /** Test seams. */
  probeCodex?: () => Promise<CodexProbe>;
  probeAntigravity?: () => Promise<AntigravityProbe>;
  loginSpawn?: typeof nodeSpawn;
  loginTimeoutMs?: number;
  now?: () => Date;
}

const CODEX_INSTALL =
  "Codex CLI kurulu değil. Kurulum (yönetici şifresi gerekmez): `npm i -g --prefix ~/.local @openai/codex`.";
const AGY_INSTALL =
  "Antigravity CLI (`agy`) kurulu değil: https://antigravity.google/ adresinden kurulur.";
const AGY_NO_TOOLS =
  "Studio araçları (plan, post, zamanlama) bu sağlayıcıda yok: yalnızca metinle yanıtlar.";

export class ProvidersController {
  private codex: CodexProbe | null = null;
  private agy: AntigravityProbe | null = null;
  private checkedAt: string;
  private readonly listeners = new Set<(providers: AiProviderStatus[]) => void>();
  private readonly codexLogin: CliLoginController;
  private readonly agyLogin: CliLoginController;
  private refreshing: Promise<AiProviderStatus[]> | undefined;
  private last = "";

  constructor(private readonly options: ProvidersControllerOptions) {
    const { settings, logger } = options;
    this.checkedAt = new Date(0).toISOString();
    const env = () => buildCliEnv(settings.parentEnv);
    this.codexLogin = new CliLoginController({
      label: "codex",
      bin: settings.codexBin,
      args: ["login"],
      env,
      probe: async () => (await this.runCodexProbe()).loggedIn,
      onChange: () => this.emit(),
      onDone: async () => {
        await this.refresh();
      },
      logger,
      ...(options.loginSpawn ? { spawn: options.loginSpawn } : {}),
      ...(options.loginTimeoutMs !== undefined ? { timeoutMs: options.loginTimeoutMs } : {}),
    });
    this.agyLogin = new CliLoginController({
      label: "antigravity",
      bin: settings.antigravityBin,
      args: ["acp", "--login"],
      env,
      probe: async () => (await this.runAgyProbe()).loggedIn,
      onChange: () => this.emit(),
      onDone: async () => {
        await this.refresh();
      },
      logger,
      ...(options.loginSpawn ? { spawn: options.loginSpawn } : {}),
      ...(options.loginTimeoutMs !== undefined ? { timeoutMs: options.loginTimeoutMs } : {}),
    });
  }

  onChange(fn: (providers: AiProviderStatus[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  codexReady(): boolean {
    return this.codex?.loggedIn === true;
  }

  antigravityReady(): boolean {
    return this.agy?.loggedIn === true;
  }

  openaiReady(): boolean {
    return Boolean(this.options.settings.vault?.openai?.apiKey);
  }

  /** Probe Codex and Antigravity again (a few seconds; `agy models` asks Google). */
  refresh(): Promise<AiProviderStatus[]> {
    this.refreshing ??= (async () => {
      try {
        const [codex, agy] = await Promise.all([this.runCodexProbe(), this.runAgyProbe()]);
        this.codex = codex;
        this.agy = agy;
        this.checkedAt = this.now().toISOString();
        this.options.logger.info(
          `providers: codex ${codex.installed ? (codex.loggedIn ? "ready" : "signed out") : "not installed"}, ` +
            `antigravity ${agy.installed ? (agy.loggedIn ? "ready" : "signed out") : "not installed"}, ` +
            `openai ${this.openaiReady() ? "key stored" : "no key"}`,
        );
        this.emit();
        return this.list();
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** The stored keys changed: the OpenAI row follows the vault. */
  vaultChanged(): void {
    this.emit();
  }

  startCodexLogin(): AiProviderStatus[] {
    this.codexLogin.start();
    return this.list();
  }

  startAntigravityLogin(): AiProviderStatus[] {
    this.agyLogin.start();
    return this.list();
  }

  stop(): void {
    this.codexLogin.stop();
    this.agyLogin.stop();
  }

  list(): AiProviderStatus[] {
    return [this.codexStatus(), this.openaiStatus(), this.antigravityStatus()];
  }

  private codexStatus(): AiProviderStatus {
    const { settings } = this.options;
    const p = this.codex;
    const login = this.codexLogin.latest();
    const base = {
      provider: "codex" as const,
      cliVersion: p?.version ?? null,
      defaultModel: settings.codexModel ?? null,
      models: settings.codexModel ? [settings.codexModel] : [],
      loginUrl: null,
      tools: true,
      checkedAt: this.checkedAt,
    };
    if (login.running) {
      return {
        ...base,
        state: "signing_in",
        account: null,
        loginUrl: login.url,
        detail: "Tarayıcıda ChatGPT girişini tamamlayın.",
      };
    }
    if (!p) return { ...base, state: "error", account: null, detail: "Henüz denetlenmedi." };
    if (!p.installed)
      return { ...base, state: "not_installed", account: null, detail: CODEX_INSTALL };
    if (p.error) return { ...base, state: "error", account: null, detail: p.error };
    if (!p.loggedIn) {
      return {
        ...base,
        state: "signed_out",
        account: null,
        detail: login.outcome ?? "“Giriş yap” ChatGPT hesabıyla tarayıcıda oturum açar.",
      };
    }
    const account = p.method === "api_key" ? "API anahtarı (codex login)" : "ChatGPT hesabı";
    return {
      ...base,
      state: "ready",
      account,
      detail: `Codex CLI ${p.version ?? ""} · ${account} · Studio araçlarıyla`.replace(
        /\s+·/,
        " ·",
      ),
    };
  }

  private openaiStatus(): AiProviderStatus {
    const { settings } = this.options;
    const key = settings.vault?.openai;
    const models = (key?.models ?? []).filter((m) => /^(gpt|o\d)/.test(m)).slice(0, 100);
    const model = pickOpenAiModel(settings.openaiModel, key?.models ?? []);
    if (!key) {
      return {
        provider: "openai",
        state: "not_configured",
        account: null,
        cliVersion: null,
        defaultModel: model,
        models: [],
        loginUrl: null,
        tools: true,
        detail: "OpenAI API anahtarı girilmedi (Ayarlar → Yapay zekâ).",
        checkedAt: this.now().toISOString(),
      };
    }
    const listed = key.models.length === 0 || key.models.includes(model);
    return {
      provider: "openai",
      state: "ready",
      account: "API anahtarı",
      cliVersion: null,
      defaultModel: model,
      models,
      loginUrl: null,
      tools: true,
      detail: listed
        ? `Responses API · ${model} · kullanım OpenAI hesabından ücretlendirilir`
        : `${model} bu anahtarın model listesinde yok; STUDIO_OPENAI_MODEL ile başka bir model seçin.`,
      checkedAt: this.now().toISOString(),
    };
  }

  private antigravityStatus(): AiProviderStatus {
    const { settings } = this.options;
    const p = this.agy;
    const login: LoginState = this.agyLogin.latest();
    const base = {
      provider: "antigravity" as const,
      cliVersion: p?.version ?? null,
      defaultModel: settings.antigravityModel ?? null,
      models: p?.models ?? [],
      loginUrl: null,
      tools: false,
      checkedAt: this.checkedAt,
    };
    if (login.running) {
      return {
        ...base,
        state: "signing_in",
        account: null,
        loginUrl: login.url,
        detail: "Tarayıcıda Google girişini tamamlayın.",
      };
    }
    if (!p) return { ...base, state: "error", account: null, detail: "Henüz denetlenmedi." };
    if (!p.installed)
      return { ...base, state: "not_installed", account: null, detail: AGY_INSTALL };
    if (p.error) return { ...base, state: "error", account: null, detail: p.error };
    if (!p.loggedIn) {
      return {
        ...base,
        state: "signed_out",
        account: null,
        detail:
          login.outcome ??
          "“Giriş yap” Google girişini başlatır (olmazsa Terminal'de `agy` çalıştırın).",
      };
    }
    return {
      ...base,
      state: "ready",
      account: "Google hesabı",
      detail: `agy ${p.version ?? ""} · ${p.models.length} model · ${AGY_NO_TOOLS}`,
    };
  }

  private runCodexProbe(): Promise<CodexProbe> {
    const { settings } = this.options;
    return this.options.probeCodex
      ? this.options.probeCodex()
      : probeCodex(settings.codexBin, settings.parentEnv);
  }

  private runAgyProbe(): Promise<AntigravityProbe> {
    const { settings } = this.options;
    return this.options.probeAntigravity
      ? this.options.probeAntigravity()
      : probeAntigravity(settings.antigravityBin, settings.parentEnv);
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private emit(): void {
    const list = this.list();
    const key = JSON.stringify(list.map((p) => ({ ...p, checkedAt: undefined })));
    if (key === this.last) return;
    this.last = key;
    for (const fn of this.listeners) fn(list);
  }
}
