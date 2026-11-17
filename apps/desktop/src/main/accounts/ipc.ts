// IPC of Ayarlar → Hesaplar / Gelişmiş / Hakkında (wave 2C): the connect flows, the owner's app
// credentials, the tunnel token, version and folders. Registered once from main/index.ts.
import type { IpcMain } from "electron";
import {
  ACCOUNTS_IPC,
  type AppInfo,
  type MetaPageSelectionValue,
  type SaveResult,
} from "../../shared/accounts-ipc.ts";
import type { SecretStore } from "./secrets.ts";
import { type AccountsService, describeError } from "./service.ts";

export interface SystemDeps {
  info(): AppInfo;
  openPath(path: string): Promise<unknown>;
  secrets: SecretStore;
  /** Remote Control picks up a new tunnel token on the next host start. */
  onTunnelTokenChange?(): void;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function selections(value: unknown): MetaPageSelectionValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      pageId: str(s.pageId),
      facebook: s.facebook === true,
      instagram: s.instagram === true,
    }))
    .filter((s) => s.pageId.length > 0)
    .slice(0, 100);
}

/** A Cloudflare tunnel token is one long base64 line. */
export function validateTunnelToken(raw: string): string {
  const token = raw.trim();
  if (token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    throw new Error("Tünel anahtarı geçersiz görünüyor (CLOUDFLARE_TUNNEL_TOKEN tek satırdır).");
  }
  return token;
}

export function registerAccountsIpc(
  ipc: Pick<IpcMain, "handle">,
  service: AccountsService,
  system: SystemDeps,
  send: (channel: string, value: unknown) => void,
): void {
  service.onChange((state) => send(ACCOUNTS_IPC.changed, state));
  ipc.handle(ACCOUNTS_IPC.state, () => service.state());
  ipc.handle(ACCOUNTS_IPC.apps, () => service.apps());
  ipc.handle(ACCOUNTS_IPC.saveMetaApp, (_e, input: { appId?: unknown; secret?: unknown }) =>
    service.saveMetaApp({ appId: str(input?.appId), secret: str(input?.secret) }),
  );
  ipc.handle(ACCOUNTS_IPC.saveLinkedInApp, (_e, input: { clientId?: unknown; secret?: unknown }) =>
    service.saveLinkedInApp({ clientId: str(input?.clientId), secret: str(input?.secret) }),
  );
  ipc.handle(ACCOUNTS_IPC.forgetMetaSecret, () => service.forgetMetaSecret());
  // Flows run in the background; their progress arrives as state changes.
  ipc.handle(ACCOUNTS_IPC.connectMeta, (_e, brandId: unknown) => {
    if (str(brandId)) void service.runMetaConnect(str(brandId));
  });
  ipc.handle(ACCOUNTS_IPC.connectLinkedIn, (_e, brandId: unknown) => {
    if (str(brandId)) void service.runLinkedInConnect(str(brandId));
  });
  ipc.handle(ACCOUNTS_IPC.confirmMeta, (_e, value: unknown) => {
    void service.confirmMeta(selections(value));
  });
  ipc.handle(ACCOUNTS_IPC.cancel, () => service.cancel());
  ipc.handle(ACCOUNTS_IPC.dismiss, () => service.dismiss());
  ipc.handle(ACCOUNTS_IPC.check, (_e, account: { id?: unknown; platform?: unknown }) => {
    if (str(account?.id))
      void service.check({ id: str(account.id), platform: str(account.platform) });
  });
  ipc.handle(ACCOUNTS_IPC.disconnect, (_e, id: unknown) => {
    if (str(id)) void service.disconnect(str(id));
  });

  ipc.handle(ACCOUNTS_IPC.systemInfo, () => system.info());
  ipc.handle(ACCOUNTS_IPC.systemReveal, (_e, target: unknown) => {
    const info = system.info();
    const path = target === "logs" ? info.logsDir : target === "data" ? info.stateDir : null;
    if (path) return system.openPath(path).then(() => undefined);
  });
  ipc.handle(ACCOUNTS_IPC.tunnelHas, () => system.secrets.has("cloudflare-tunnel-token"));
  ipc.handle(ACCOUNTS_IPC.tunnelSave, async (_e, raw: unknown): Promise<SaveResult<true>> => {
    try {
      await system.secrets.save("cloudflare-tunnel-token", validateTunnelToken(str(raw)));
      system.onTunnelTokenChange?.();
      return { ok: true, value: true };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  });
  ipc.handle(ACCOUNTS_IPC.tunnelForget, async () => {
    await system.secrets.delete("cloudflare-tunnel-token");
    system.onTunnelTokenChange?.();
  });
}
