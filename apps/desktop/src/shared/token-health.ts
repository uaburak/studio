// Social account health in words (Ayarlar → Hesaplar, the connect results): the AppKit app's
// TokenHealthText. Pure; used by the main process (check results) and the renderer (table).
import type { SocialAccount } from "@studio/contract";

type AccountHealth = Pick<
  SocialAccount,
  "status" | "hasToken" | "tokenHealth" | "tokenExpiresAt" | "platform"
>;

const DAY = 86_400_000;

const HEALTH_LABELS: Record<string, string> = {
  valid: "Geçerli",
  expiring_soon: "Yakında doluyor",
  invalid: "Yeniden giriş gerekli",
  missing_scopes: "Eksik yetki",
};

export function platformName(platform: string): string {
  return (
    { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn" }[platform] ?? platform
  );
}

export function tokenHealthLabel(account: AccountHealth, now: Date = new Date()): string {
  if (account.status === "disabled") return "Bağlantı kesildi";
  if (account.hasToken === false) return "Bağlı değil";
  if (account.status === "needs_reauth") return "Yeniden bağlanmalı";
  const health = account.tokenHealth ?? "unchecked";
  let text = health === "unchecked" ? "Bağlı" : (HEALTH_LABELS[health] ?? "Bağlı");
  if (account.tokenExpiresAt) {
    const days = Math.ceil((Date.parse(account.tokenExpiresAt) - now.getTime()) / DAY);
    text += days > 0 ? ` · ${days} gün kaldı` : " · süresi doldu";
  }
  return text;
}

/** Orange only when the owner must act. */
export function tokenNeedsOwner(account: AccountHealth, now: Date = new Date()): boolean {
  if (account.status === "disabled") return false;
  if (account.status === "needs_reauth" || account.hasToken === false) return true;
  if (
    account.tokenHealth === "invalid" ||
    account.tokenHealth === "missing_scopes" ||
    account.tokenHealth === "expiring_soon"
  )
    return true;
  return account.tokenExpiresAt
    ? Date.parse(account.tokenExpiresAt) - now.getTime() < 7 * DAY
    : false;
}

export function tokenHint(account: AccountHealth): string | null {
  if (account.status === "needs_reauth" || account.tokenHealth === "invalid") {
    return "Erişim anahtarı geçersiz ya da süresi doldu; “Yeniden bağla” ile girişi yenileyin.";
  }
  if (account.tokenHealth === "missing_scopes") {
    return "Yayın için gereken izinlerden bazıları verilmemiş; yeniden bağlarken tüm izinleri onaylayın.";
  }
  if (account.tokenHealth === "expiring_soon") {
    return account.platform === "linkedin"
      ? "LinkedIn anahtarı 60 gün geçerlidir; bitmeden yeniden bağlayın."
      : "Erişim yakında doluyor; yeniden bağlayın.";
  }
  return null;
}

type TokenAccount = AccountHealth & Pick<SocialAccount, "id" | "handle">;

/** Notice route of Ayarlar → Hesaplar (the page opens settings at that section). */
export const ACCOUNTS_ROUTE = "settings:accounts";

export interface TokenNotice {
  id: string;
  title: string;
  body: string;
  route: string;
}

/**
 * macOS notices for accounts whose token is invalid or runs out within 7 days (StudioKit's
 * NoticePlanner.tokenNotices): one per account, state and day. Posted by the main process, so
 * they also come while the window is closed; a click opens Ayarlar → Hesaplar.
 */
export function tokenNotices(
  accounts: readonly TokenAccount[],
  now: Date = new Date(),
): TokenNotice[] {
  const day = Math.floor(now.getTime() / 86_400_000);
  const notices: TokenNotice[] = [];
  for (const account of accounts) {
    if (account.status === "disabled" || account.hasToken === false) continue;
    const name = `${platformName(account.platform)} · ${account.handle}`;
    if (account.status === "needs_reauth" || account.tokenHealth === "invalid") {
      notices.push({
        id: `token:${account.id}:invalid:${day}`,
        title: "Hesap yeniden bağlanmalı",
        body: `${name}: erişim anahtarı geçersiz. Ayarlar → Hesaplar'dan yeniden bağlayın.`,
        route: ACCOUNTS_ROUTE,
      });
      continue;
    }
    const expires = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : null;
    const soon =
      account.tokenHealth === "expiring_soon" ||
      (expires !== null && expires - now.getTime() < 7 * 86_400_000);
    if (!soon) continue;
    const left =
      expires !== null ? Math.max(0, Math.ceil((expires - now.getTime()) / 86_400_000)) : null;
    notices.push({
      id: `token:${account.id}:expiring:${day}`,
      title: "Hesap bağlantısı yakında doluyor",
      body: `${name}: ${left !== null ? `${left} gün içinde` : "yakında"} yeniden bağlanmalı.`,
      route: ACCOUNTS_ROUTE,
    });
  }
  return notices;
}
