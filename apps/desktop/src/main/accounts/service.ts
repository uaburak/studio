// Connecting social accounts with the owner's own Meta / LinkedIn apps (the AppKit app's
// AccountsModel), in the main process:
//
// - Meta: Facebook Login in the system browser → loopback redirect on :8793 → the API exchanges
//   the code (long-lived with the App Secret) and lists the Pages → the owner picks Pages and
//   Instagram accounts → the API vaults the Page tokens. The user token stays in this process.
// - LinkedIn: OAuth in the browser → the API exchanges the code, reads the member and vaults the
//   60-day token.
// - Check (token health, live when the platform can be asked) and disconnect.
import type {
  AccountsPhase,
  AccountsState,
  MetaPageSelectionValue,
  PublishingApps,
  SaveResult,
} from "../../shared/accounts-ipc.ts";
import { LINKEDIN_TOKEN_DAYS } from "../../shared/accounts-ipc.ts";
import { platformName, tokenHealthLabel } from "../../shared/token-health.ts";
import type { AccountsApi } from "./api.ts";
import { type AppIds, validateClientId, validateMetaAppId } from "./apps-store.ts";
import { LoopbackError } from "./loopback.ts";
import {
  LINKEDIN_CALLBACK_PATH,
  LINKEDIN_REDIRECT_URI,
  linkedInAuthorizeUrl,
  META_CALLBACK_PATH,
  META_REDIRECT_URI,
  metaAuthorizeUrl,
  newState,
  parseLinkedInCallback,
  parseMetaCallback,
} from "./oauth.ts";
import type { SecretStore } from "./secrets.ts";

export interface AccountsServiceDeps {
  api: AccountsApi;
  secrets: SecretStore;
  ids: { get(): Promise<AppIds>; set(patch: Partial<AppIds>): Promise<AppIds> };
  openExternal(url: string): void | Promise<void>;
  /** Listens on the loopback port, calls `onReady` once listening, resolves with the redirect. */
  waitForCallback(
    path: string,
    options: { signal: AbortSignal; onReady: () => void },
  ): Promise<URL>;
  newState?: () => string;
}

interface Exchange {
  brandId: string;
  userAccessToken: string;
  expiresAt: string | null;
  longLived: boolean;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCancel(error: unknown): boolean {
  return (
    (error instanceof LoopbackError && error.reason === "cancelled") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

const BUSY_PHASES = new Set<AccountsPhase["kind"]>([
  "waiting",
  "exchanging",
  "picking",
  "connecting",
]);

export class AccountsService {
  private value: AccountsState = { phase: { kind: "idle" }, busyAccountIds: [], revision: 0 };
  private listeners = new Set<(state: AccountsState) => void>();
  private flow: AbortController | null = null;
  private exchange: Exchange | null = null;

  constructor(private readonly deps: AccountsServiceDeps) {}

  // --- state -----------------------------------------------------------------------------------

  state(): AccountsState {
    return this.value;
  }

  onChange(listener: (state: AccountsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<AccountsState>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener(this.value);
  }

  private setPhase(phase: AccountsPhase): void {
    this.set({ phase });
  }

  private changed(): void {
    this.set({ revision: this.value.revision + 1 });
  }

  /** A check / disconnect result never replaces a running connect flow (the picker). */
  private report(phase: AccountsPhase): void {
    if (BUSY_PHASES.has(this.value.phase.kind)) return;
    this.setPhase(phase);
  }

  private busy(id: string, on: boolean): void {
    const ids = this.value.busyAccountIds.filter((x) => x !== id);
    this.set({ busyAccountIds: on ? [...ids, id] : ids });
  }

  // --- app credentials ---------------------------------------------------------------------------

  async apps(): Promise<PublishingApps> {
    const ids = await this.deps.ids.get();
    const [metaSecret, linkedInSecret] = await Promise.all([
      this.deps.secrets.has("meta-app-secret"),
      this.deps.secrets.has("linkedin-client-secret"),
    ]);
    return {
      meta: { appId: ids.metaAppId, hasSecret: metaSecret },
      linkedIn: { clientId: ids.linkedInClientId, hasSecret: linkedInSecret },
    };
  }

  async saveMetaApp(input: {
    appId: string;
    secret?: string;
  }): Promise<SaveResult<PublishingApps>> {
    try {
      const appId = validateMetaAppId(input.appId);
      const secret = input.secret?.trim();
      if (secret) await this.deps.secrets.save("meta-app-secret", secret);
      await this.deps.ids.set({ metaAppId: appId });
      return { ok: true, value: await this.apps() };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  async saveLinkedInApp(input: {
    clientId: string;
    secret?: string;
  }): Promise<SaveResult<PublishingApps>> {
    try {
      const clientId = validateClientId(input.clientId);
      const secret = input.secret?.trim();
      if (secret) await this.deps.secrets.save("linkedin-client-secret", secret);
      await this.deps.ids.set({ linkedInClientId: clientId });
      return { ok: true, value: await this.apps() };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  async forgetMetaSecret(): Promise<PublishingApps> {
    await this.deps.secrets.delete("meta-app-secret");
    return this.apps();
  }

  // --- flows -------------------------------------------------------------------------------------

  cancel(): void {
    this.flow?.abort();
    this.flow = null;
    this.exchange = null;
    this.setPhase({ kind: "idle" });
  }

  dismiss(): void {
    const kind = this.value.phase.kind;
    if (kind === "finished" || kind === "failed") this.setPhase({ kind: "idle" });
  }

  private beginFlow(): AbortController {
    this.flow?.abort();
    this.exchange = null;
    const controller = new AbortController();
    this.flow = controller;
    return controller;
  }

  private browserLogin(path: string, url: string, signal: AbortSignal): Promise<URL> {
    return this.deps.waitForCallback(path, {
      signal,
      onReady: () => void this.deps.openExternal(url),
    });
  }

  /** Facebook Login → Pages to pick (phase `picking`). */
  async runMetaConnect(brandId: string): Promise<void> {
    const { metaAppId } = await this.deps.ids.get();
    if (!metaAppId) {
      this.setPhase({
        kind: "failed",
        message: "Önce Meta uygulamasının Kimliğini girin (Uygulamalar sekmesi).",
      });
      return;
    }
    const controller = this.beginFlow();
    const { signal } = controller;
    try {
      const secret = await this.deps.secrets.load("meta-app-secret");
      const state = (this.deps.newState ?? newState)();
      this.setPhase({ kind: "waiting", platform: "meta", brandId });
      const callback = await this.browserLogin(
        META_CALLBACK_PATH,
        metaAuthorizeUrl(metaAppId, state, secret !== null),
        signal,
      );
      const parsed = parseMetaCallback(callback, state);
      if (signal.aborted) return;
      this.setPhase({ kind: "exchanging", brandId });
      const result = await this.deps.api.exchangeMeta({
        appId: metaAppId,
        ...(secret ? { appSecret: secret } : {}),
        ...("code" in parsed
          ? { code: parsed.code, redirectUri: META_REDIRECT_URI }
          : { accessToken: parsed.accessToken }),
      });
      if (signal.aborted) return;
      if (result.pages.length === 0) {
        this.setPhase({
          kind: "failed",
          message:
            "Bu Facebook hesabının yönettiği bir Sayfa bulunamadı. Instagram hesabı bir Sayfaya bağlı olmalı ve girişte Sayfalara izin verilmeli.",
        });
        return;
      }
      const existing = await this.deps.api.listAccounts(brandId).catch(() => []);
      const connected = new Set(existing.map((a) => a.externalId).filter(Boolean));
      const single = result.pages.length === 1;
      const initial: MetaPageSelectionValue[] = result.pages
        .filter((page) => page.canPublish)
        .map((page) => ({
          pageId: page.pageId,
          facebook: connected.has(page.pageId) || single,
          instagram: page.instagram !== null && (connected.has(page.instagram.igUserId) || single),
        }));
      this.exchange = {
        brandId,
        userAccessToken: result.userAccessToken,
        expiresAt: result.expiresAt,
        longLived: result.longLived,
      };
      this.setPhase({
        kind: "picking",
        brandId,
        // Page tokens never leave this process.
        pages: result.pages.map((page) => ({
          pageId: page.pageId,
          pageName: page.pageName,
          canPublish: page.canPublish,
          instagram: page.instagram
            ? { igUserId: page.instagram.igUserId, username: page.instagram.username }
            : null,
        })),
        missingScopes: result.missingScopes,
        longLived: result.longLived,
        initial,
      });
    } catch (error) {
      if (signal.aborted || isCancel(error)) {
        if (this.flow === controller) this.setPhase({ kind: "idle" });
        return;
      }
      this.setPhase({ kind: "failed", message: describeError(error) });
    } finally {
      if (this.flow === controller && this.value.phase.kind !== "picking") this.flow = null;
    }
  }

  /** Vault the picked Pages / Instagram accounts for the brand. */
  async confirmMeta(selections: MetaPageSelectionValue[]): Promise<void> {
    const exchange = this.exchange;
    if (!exchange || this.value.phase.kind !== "picking") return;
    const picked = selections
      .filter((s) => s.facebook || s.instagram)
      .sort((a, b) => a.pageId.localeCompare(b.pageId));
    if (picked.length === 0) return;
    this.setPhase({ kind: "connecting", brandId: exchange.brandId });
    try {
      const result = await this.deps.api.discoverMeta({
        brandId: exchange.brandId,
        userAccessToken: exchange.userAccessToken,
        autoConnect: true,
        selections: picked,
        userTokenExpiresAt: exchange.expiresAt,
      });
      this.exchange = null;
      this.flow = null;
      this.changed();
      if (result.connectedAccounts.length === 0) {
        this.setPhase({
          kind: "failed",
          message:
            "Seçilen hesaplar bağlanamadı: başka bir markaya bağlı ya da Sayfada yayın yetkiniz yok.",
        });
        return;
      }
      const names = result.connectedAccounts.map(
        (a) => `${platformName(a.platform)} · ${a.handle}`,
      );
      this.setPhase({
        kind: "finished",
        message:
          `Bağlandı: ${names.join(", ")}.` +
          (exchange.longLived
            ? ""
            : " App Secret girilmediği için anahtar yaklaşık bir saat geçerli; uzun ömürlü bağlantı için App Secret ekleyin."),
      });
    } catch (error) {
      this.exchange = null;
      this.flow = null;
      this.setPhase({ kind: "failed", message: describeError(error) });
    }
  }

  async runLinkedInConnect(brandId: string): Promise<void> {
    const { linkedInClientId } = await this.deps.ids.get();
    const secret = linkedInClientId ? await this.deps.secrets.load("linkedin-client-secret") : null;
    if (!linkedInClientId || !secret) {
      this.setPhase({
        kind: "failed",
        message:
          "Önce LinkedIn uygulamasının Client ID ve Client Secret değerlerini girin (Uygulamalar sekmesi).",
      });
      return;
    }
    const controller = this.beginFlow();
    const { signal } = controller;
    try {
      const state = (this.deps.newState ?? newState)();
      this.setPhase({ kind: "waiting", platform: "linkedin", brandId });
      const callback = await this.browserLogin(
        LINKEDIN_CALLBACK_PATH,
        linkedInAuthorizeUrl(linkedInClientId, state),
        signal,
      );
      const code = parseLinkedInCallback(callback, state);
      if (signal.aborted) return;
      this.setPhase({ kind: "connecting", brandId });
      const account = await this.deps.api.linkedInOAuth({
        brandId,
        clientId: linkedInClientId,
        clientSecret: secret,
        code,
        redirectUri: LINKEDIN_REDIRECT_URI,
      });
      this.changed();
      this.setPhase({
        kind: "finished",
        message: `LinkedIn bağlandı: ${account.handle}. Anahtar ${LINKEDIN_TOKEN_DAYS} gün geçerli; bitmeden hatırlatılır.`,
      });
    } catch (error) {
      if (signal.aborted || isCancel(error)) {
        if (this.flow === controller) this.setPhase({ kind: "idle" });
        return;
      }
      this.setPhase({ kind: "failed", message: describeError(error) });
    } finally {
      if (this.flow === controller) this.flow = null;
    }
  }

  // --- check / disconnect ------------------------------------------------------------------------

  /** Token health; live when the platform can be asked (Meta needs the App Secret). */
  async check(account: { id: string; platform: string }): Promise<void> {
    this.busy(account.id, true);
    try {
      let input: { live: boolean; appId?: string; appSecret?: string } = { live: true };
      if (account.platform !== "linkedin") {
        const secret = await this.deps.secrets.load("meta-app-secret");
        const { metaAppId } = await this.deps.ids.get();
        input =
          secret && metaAppId
            ? { live: true, appId: metaAppId, appSecret: secret }
            : { live: false };
      }
      const checked = await this.deps.api.checkAccount(account.id, input);
      this.changed();
      this.report({
        kind: "finished",
        message: `${checked.handle}: ${tokenHealthLabel(checked)}.`,
      });
    } catch (error) {
      this.report({ kind: "failed", message: describeError(error) });
    } finally {
      this.busy(account.id, false);
    }
  }

  async disconnect(accountId: string): Promise<void> {
    this.busy(accountId, true);
    try {
      const account = await this.deps.api.disconnectAccount(accountId);
      this.changed();
      this.report({
        kind: "finished",
        message: `${account.handle} bağlantısı kesildi; erişim anahtarı silindi.`,
      });
    } catch (error) {
      this.report({ kind: "failed", message: describeError(error) });
    } finally {
      this.busy(accountId, false);
    }
  }
}
