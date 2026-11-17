// Ayarlar → Hesaplar as data (pure): one table row per account of every active brand, plus a
// "Bağla" row for each platform a brand has no live account on; what each row says and offers.
import type { Brand, Platform, SocialAccount } from "@studio/contract";
import type { AccountsPhase, PublishingApps } from "../../../shared/accounts-ipc.ts";
import {
  platformName,
  tokenHealthLabel,
  tokenHint,
  tokenNeedsOwner,
} from "../../../shared/token-health.ts";

export const PLATFORMS: Platform[] = ["instagram", "facebook", "linkedin"];

export function platformKind(platform: string): string {
  return (
    {
      instagram: "Instagram · İş hesabı",
      facebook: "Facebook · Sayfa",
      linkedin: "LinkedIn · Profil",
    }[platform] ?? platformName(platform)
  );
}

/** `@handle` on Instagram; the platform's name when there is no handle. */
export function shownHandle(account: Pick<SocialAccount, "handle" | "platform">): string {
  const handle = account.handle.trim();
  if (!handle) return platformName(account.platform);
  return account.platform === "instagram" && !handle.startsWith("@") ? `@${handle}` : handle;
}

/** The owner's app for the platform is saved (Meta: App ID; LinkedIn: Client ID + Secret). */
export function appConfigured(platform: string, apps: PublishingApps | null | undefined): boolean {
  if (!apps) return false;
  return platform === "linkedin"
    ? apps.linkedIn.clientId.length > 0 && apps.linkedIn.hasSecret
    : apps.meta.appId.length > 0;
}

export type AccountAction = "connect" | "reconnect" | "none";

export interface AccountRowModel {
  kind: "account";
  id: string;
  account: SocialAccount;
  brandId: string;
  brandName: string;
  title: string;
  platform: Platform;
  status: string;
  /** Orange: the owner must act (reconnect). */
  needsOwner: boolean;
  healthy: boolean;
  hint: string | null;
  action: AccountAction;
  configured: boolean;
  dimmed: boolean;
  busy: boolean;
  searchText: string;
}

export interface MissingRowModel {
  kind: "missing";
  id: string;
  brandId: string;
  brandName: string;
  platform: Platform;
  title: string;
  status: string;
  configured: boolean;
  searchText: string;
}

export type AccountsTableRow = AccountRowModel | MissingRowModel;

export function accountRows(input: {
  brands: Brand[];
  accounts: SocialAccount[];
  apps: PublishingApps | null | undefined;
  busyIds?: string[];
  now?: Date;
}): AccountsTableRow[] {
  const now = input.now ?? new Date();
  const busy = new Set(input.busyIds ?? []);
  const brands = input.brands
    .filter((b) => b.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
  const rows: AccountsTableRow[] = [];
  for (const brand of brands) {
    const own = input.accounts.filter((a) => a.brandId === brand.id);
    for (const account of own) {
      const needsOwner = tokenNeedsOwner(account, now);
      const disabled = account.status === "disabled";
      const status = tokenHealthLabel(account, now);
      const title = shownHandle(account);
      rows.push({
        kind: "account",
        id: `account:${account.id}`,
        account,
        brandId: brand.id,
        brandName: brand.name,
        title,
        platform: account.platform,
        status,
        needsOwner,
        healthy: !needsOwner && !disabled,
        hint: tokenHint(account),
        // Never connected (no token yet) → "Bağla"; a token that went bad → "Yeniden bağla".
        action:
          disabled || account.hasToken === false || account.status === "pending"
            ? "connect"
            : needsOwner
              ? "reconnect"
              : "none",
        configured: appConfigured(account.platform, input.apps),
        dimmed: disabled,
        busy: busy.has(account.id),
        searchText: `${title} ${platformKind(account.platform)} ${brand.name} ${status} hesap`,
      });
    }
    for (const platform of PLATFORMS) {
      if (own.some((a) => a.platform === platform && a.status !== "disabled")) continue;
      const configured = appConfigured(platform, input.apps);
      rows.push({
        kind: "missing",
        id: `missing:${brand.id}:${platform}`,
        brandId: brand.id,
        brandName: brand.name,
        platform,
        title: platformName(platform),
        status: configured ? "Bağlı değil" : "Uygulama gerekli",
        configured,
        searchText: `${platformName(platform)} ${brand.name} bağla hesap ekle`,
      });
    }
  }
  return rows;
}

/** Connect flows are per Meta app (Instagram + Facebook together) or LinkedIn. */
export function connectPlatform(platform: string): "meta" | "linkedin" {
  return platform === "linkedin" ? "linkedin" : "meta";
}

/** A flow is waiting on the browser or the API: no second one may start. */
export function flowBusy(phase: AccountsPhase): boolean {
  return (
    phase.kind === "waiting" ||
    phase.kind === "exchanging" ||
    phase.kind === "connecting" ||
    phase.kind === "picking"
  );
}

export function phaseLine(phase: AccountsPhase): string | null {
  switch (phase.kind) {
    case "waiting":
      return `Tarayıcıda ${phase.platform === "linkedin" ? "LinkedIn" : "Facebook"} girişi bekleniyor… Girişten sonra Studio'ya dön.`;
    case "exchanging":
      return "Sayfalar ve Instagram hesapları okunuyor…";
    case "connecting":
      return "Hesaplar bağlanıyor, erişim anahtarları şifreli kasaya yazılıyor…";
    default:
      return null;
  }
}

export function pickedCount(selections: { facebook: boolean; instagram: boolean }[]): number {
  return selections.reduce((n, s) => n + (s.facebook ? 1 : 0) + (s.instagram ? 1 : 0), 0);
}

/** Numbered setup steps ("1. …"). */
export function numbered(steps: readonly string[]): string {
  return steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

export interface TokenNotice {
  id: string;
  title: string;
  body: string;
}

/**
 * macOS notices for accounts whose token is invalid or runs out within 7 days (StudioKit's
 * NoticePlanner.tokenNotices): one per account, state and day.
 */
export function tokenNotices(accounts: SocialAccount[], now: Date = new Date()): TokenNotice[] {
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
    });
  }
  return notices;
}
