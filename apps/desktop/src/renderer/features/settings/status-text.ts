// What Ayarlar → Yapay zekâ / Gelişmiş and the onboarding say about the Mac's Claude and Gemini
// sign-ins and the host (the AppKit AIPaneView / MacServerSectionView wording). Pure.
import type { ClaudeAccount, GeminiAccount } from "@studio/contract";
import type { HostSnapshot, ServicePhase } from "../../../shared/ipc.ts";

export interface ClaudeStatus {
  lines: string[];
  /** Main button: title and whether it is the orange one. */
  action: { title: string; primary: boolean };
  /** "Bağlantıyı aç": the CLI printed a sign-in page. */
  loginUrl: string | null;
  canLogin: boolean;
}

export function claudeStatus(
  account: ClaudeAccount | null | undefined,
  online: boolean,
  detail: string,
): ClaudeStatus {
  if (!account) {
    return {
      lines: [
        online ? "Durum okunuyor…" : "Arka plan çalışmıyor; Studio hazır olunca okunur.",
        detail,
      ],
      action: { title: "Giriş yap", primary: false },
      loginUrl: null,
      canLogin: online,
    };
  }
  const lines: string[] = [];
  let action = { title: "Giriş yap", primary: true };
  switch (account.status) {
    case "signed_in": {
      const identity = [account.email, account.plan ? `(${account.plan})` : null]
        .filter(Boolean)
        .join(" ");
      lines.push(identity ? `Giriş yapıldı: ${identity}` : "Giriş yapıldı.");
      action = { title: "Hesabı değiştir", primary: false };
      break;
    }
    case "signed_out":
      lines.push("Giriş yapılmadı; sohbet ve içerik üretimi çalışmaz.");
      break;
    case "signing_in":
      lines.push("Tarayıcıda giriş bekleniyor…");
      action = { title: "Yeniden dene", primary: false };
      break;
    case "not_installed":
      lines.push("Bu Mac'te Claude Code kurulu değil.");
      action = { title: "Giriş yap", primary: false };
      break;
    default:
      lines.push("Bağlantı hatası.");
  }
  const notes = [account.cliVersion ? `CLI ${account.cliVersion}` : null, account.detail || null]
    .filter(Boolean)
    .join(" · ");
  if (notes) lines.push(notes);
  return {
    lines,
    action,
    loginUrl: account.loginUrl && account.status !== "signed_in" ? account.loginUrl : null,
    canLogin: online && account.status !== "not_installed",
  };
}

export function geminiStatusLines(
  account: GeminiAccount | null | undefined,
  online: boolean,
  detail: string,
): string[] {
  if (!account) {
    return [
      online ? "Durum okunuyor…" : "Arka plan çalışmıyor; Studio hazır olunca okunur.",
      detail,
    ];
  }
  const lines: string[] = [];
  if (account.status === "ready") {
    const cli = `Gemini CLI${account.cliVersion ? ` ${account.cliVersion}` : ""}`;
    const source =
      account.mode === "api"
        ? ".env GEMINI_API_KEY"
        : account.mode === "cli"
          ? cli
          : account.mode === "both"
            ? `.env GEMINI_API_KEY + ${cli}`
            : "";
    lines.push(source ? `Hazır · ${source}` : "Hazır.");
  } else if (account.status === "not_configured") {
    lines.push("Yapılandırılmadı.", detail);
  } else {
    lines.push("Hata.");
  }
  const notes = [
    account.defaultModel ? `Varsayılan model: ${account.defaultModel}` : null,
    account.detail || null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (notes) lines.push(notes);
  return lines;
}

export function phaseText(phase: ServicePhase): string {
  switch (phase.kind) {
    case "idle":
      return "bekliyor";
    case "running":
      return "çalışıyor";
    case "restarting":
      return `yeniden başlıyor (${Math.round(phase.delayMs / 1000)} sn)`;
    case "failed":
      return "durdu (hata)";
    case "stopped":
      return "durdu";
  }
}

const SERVICE_LABELS: Record<string, string> = {
  api: "API",
  gateway: "Yerel ağ geçidi",
  worker: "Worker",
  tunnel: "Tünel",
};

/** "Durum" row of Gelişmiş: status, address, then each service's phase. */
export function hostStatusText(host: HostSnapshot | null): { text: string; error: boolean } {
  if (!host) return { text: "Okunuyor…", error: false };
  const address = host.apiPort ? `http://127.0.0.1:${host.apiPort}` : "";
  let text: string;
  switch (host.status.kind) {
    case "running":
      text = `Çalışıyor · ${address}`;
      break;
    case "attached":
      text = `Bu Mac'te zaten çalışan Studio sunucusuna bağlandı · ${address}`;
      break;
    case "starting":
      text = `Başlatılıyor: ${host.status.message}…`;
      break;
    case "error":
      text = `Hata: ${host.status.message}`;
      break;
    default:
      text = "Durdu.";
  }
  const phases = (["api", "gateway", "worker", "tunnel"] as const)
    .filter((s) => host.services[s])
    .map((s) => `${SERVICE_LABELS[s]}: ${phaseText(host.services[s] as ServicePhase)}`)
    .join(" · ");
  if (phases) text += `\n${phases}`;
  return { text, error: host.status.kind === "error" };
}
