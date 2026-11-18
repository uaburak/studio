// Ayarlar → Hesaplar (connecting Instagram / Facebook / LinkedIn with the owner's own Meta and
// LinkedIn apps), Gelişmiş (tunnel token) and Hakkında (version, folders): the main-process
// side, reached through the preload bridge.
//
// Secrets (App Secret, Client Secret, OAuth codes, user / page tokens, the tunnel token) stay in
// the main process: the renderer sends a typed secret once to be saved and never gets one back.
// The OAuth flow runs in main (loopback listener on :8793, system browser, API calls to
// 127.0.0.1), so the user token Meta returns never reaches the page.

export type ConnectPlatform = "meta" | "linkedin";

/** A Facebook Page the owner can pick (its token stays in the main process). */
export interface MetaPageChoice {
  pageId: string;
  pageName: string;
  canPublish: boolean;
  instagram: { igUserId: string; username: string } | null;
}

export interface MetaPageSelectionValue {
  pageId: string;
  facebook: boolean;
  instagram: boolean;
}

/** Where a connect flow (or the last check / disconnect) stands. */
export type AccountsPhase =
  | { kind: "idle" }
  /** The login page is open in the browser; the loopback listener waits on :8793. */
  | { kind: "waiting"; platform: ConnectPlatform; brandId: string }
  /** The API exchanges the Facebook code and lists the Pages. */
  | { kind: "exchanging"; brandId: string }
  /** The owner picks which Pages / Instagram accounts to connect. */
  | {
      kind: "picking";
      brandId: string;
      pages: MetaPageChoice[];
      missingScopes: string[];
      longLived: boolean;
      initial: MetaPageSelectionValue[];
    }
  /** Tokens are being written to the API's vault. */
  | { kind: "connecting"; brandId: string }
  | { kind: "finished"; message: string }
  | { kind: "failed"; message: string };

export interface AccountsState {
  phase: AccountsPhase;
  /** Accounts with a running check or disconnect. */
  busyAccountIds: string[];
  /** Bumped whenever accounts changed on the server (connect, check, disconnect). */
  revision: number;
}

/** The owner's Meta / LinkedIn apps: ids are not secret; secrets only report that they exist. */
export interface PublishingApps {
  meta: { appId: string; hasSecret: boolean };
  linkedIn: { clientId: string; hasSecret: boolean };
}

export type SaveResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface AccountsBridge {
  state(): Promise<AccountsState>;
  onChange(listener: (state: AccountsState) => void): () => void;
  apps(): Promise<PublishingApps>;
  /** `secret` empty or missing keeps the stored one. */
  saveMetaApp(input: { appId: string; secret?: string }): Promise<SaveResult<PublishingApps>>;
  saveLinkedInApp(input: {
    clientId: string;
    secret?: string;
  }): Promise<SaveResult<PublishingApps>>;
  forgetMetaSecret(): Promise<PublishingApps>;
  /** Facebook Login in the browser → Page picker (phase `picking`). */
  connectMeta(brandId: string): Promise<void>;
  /** LinkedIn OAuth in the browser → the API vaults the 60-day token. */
  connectLinkedIn(brandId: string): Promise<void>;
  confirmMeta(selections: MetaPageSelectionValue[]): Promise<void>;
  cancel(): Promise<void>;
  /** Clears a finished / failed message. */
  dismiss(): Promise<void>;
  check(account: { id: string; platform: string }): Promise<void>;
  disconnect(accountId: string): Promise<void>;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  /** ~/Library/Application Support/Studio */
  stateDir: string;
  logsDir: string;
  /** The Mac user's full name (the greeting's fallback; "" when unknown). */
  userName?: string;
}

/** Outcome of Yedekle / Yedekten geri yükle (`message` is shown as is; empty when cancelled). */
export interface BackupResult {
  status: "done" | "cancelled" | "failed";
  message: string;
}

export interface SystemBridge {
  info(): Promise<AppInfo>;
  /** Opens the data or logs folder in Finder (fixed targets only). */
  reveal(target: "data" | "logs"): Promise<void>;
  tunnelToken: {
    has(): Promise<boolean>;
    save(token: string): Promise<SaveResult<true>>;
    forget(): Promise<void>;
  };
  /** Absent in an app started before backups existed. */
  backup?: {
    /** Save dialog → a zip of the data and keys (the host pauses for a moment). */
    create(): Promise<BackupResult>;
    /** Open dialog → the backup replaces the current data (the current one is kept aside). */
    restore(): Promise<BackupResult>;
  };
}

export const ACCOUNTS_IPC = {
  state: "accounts:state",
  changed: "accounts:changed",
  apps: "accounts:apps",
  saveMetaApp: "accounts:save-meta-app",
  saveLinkedInApp: "accounts:save-linkedin-app",
  forgetMetaSecret: "accounts:forget-meta-secret",
  connectMeta: "accounts:connect-meta",
  connectLinkedIn: "accounts:connect-linkedin",
  confirmMeta: "accounts:confirm-meta",
  cancel: "accounts:cancel",
  dismiss: "accounts:dismiss",
  check: "accounts:check",
  disconnect: "accounts:disconnect",
  systemInfo: "system:info",
  systemReveal: "system:reveal",
  tunnelHas: "system:tunnel-has",
  tunnelSave: "system:tunnel-save",
  tunnelForget: "system:tunnel-forget",
  backupCreate: "system:backup-create",
  backupRestore: "system:backup-restore",
} as const;

// --- OAuth constants shared by main (flow) and renderer (setup guides) ---------------------------

/** Fixed so the owner registers it once in the Meta / LinkedIn app. */
export const OAUTH_PORT = 8793;
export const OAUTH_HOST = "localhost";
export const META_CALLBACK_PATH = "/meta/callback";
export const LINKEDIN_CALLBACK_PATH = "/linkedin/callback";
export const META_REDIRECT_URI = `http://${OAUTH_HOST}:${OAUTH_PORT}${META_CALLBACK_PATH}`;
export const LINKEDIN_REDIRECT_URI = `http://${OAUTH_HOST}:${OAUTH_PORT}${LINKEDIN_CALLBACK_PATH}`;
/** LinkedIn member tokens live 60 days. */
export const LINKEDIN_TOKEN_DAYS = 60;

/** What the owner must create, and where (StudioKit's PublishingSetupGuide). */
export const SETUP_GUIDE = {
  meta: [
    "developers.facebook.com/apps adresinde “Uygulama oluştur” → kullanım durumu: “Diğer” → tür: “İşletme”.",
    "Ürün ekle: “Facebook Girişi” (Facebook Login for Business değil, klasik giriş) ve “Instagram Graph API”.",
    `Facebook Girişi → Ayarlar → Geçerli OAuth Yönlendirme URI'leri: ${META_REDIRECT_URI}`,
    "Uygulama Ayarları → Temel: Uygulama Kimliği'ni (App ID) ve Uygulama Gizli Anahtarı'nı (App Secret) kopyalayıp aşağıya girin.",
    "Instagram hesabı Profesyonel (İşletme/İçerik üreticisi) olmalı ve bir Facebook Sayfasına bağlı olmalı.",
    "Uygulama “Geliştirme” modunda kalabilir; giriş yapan hesap uygulamada yönetici/geliştirici olmalı. Başkalarının hesapları için Meta uygulama incelemesi gerekir.",
  ],
  linkedIn: [
    "linkedin.com/developers/apps adresinde “Create app” (bir LinkedIn Sayfası ile ilişkilendirmeniz istenir).",
    "Products sekmesinde “Sign In with LinkedIn using OpenID Connect” ve “Share on LinkedIn” ürünlerini ekleyin.",
    `Auth sekmesi → Authorized redirect URLs: ${LINKEDIN_REDIRECT_URI}`,
    "Auth sekmesindeki Client ID ve Client Secret'ı aşağıya girin. Erişim anahtarı 60 gün geçerlidir; Studio bitmeden hatırlatır.",
  ],
  cloud: [
    "Terminalde apps/cloud-publisher klasöründe README'deki “Kurulum” adımlarını uygulayın (wrangler login, R2 kovası, gizli anahtarlar, wrangler deploy).",
    "PUBLISHER_TOKEN için ürettiğiniz değeri ve Worker'ın adresini (ör. https://publish.ornek.com) aşağıya girin.",
    "Kaydedince Studio adresi ve anahtarı dener; onaylanan zamanlamalar buluta gönderilir ve Mac kapalıyken de paylaşılır.",
  ],
} as const;
