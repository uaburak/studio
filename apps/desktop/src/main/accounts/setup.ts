// Real wiring of the accounts / system IPC (Electron's safeStorage, shell, the loopback
// listener). Kept apart so the logic above stays testable without Electron.
import { join } from "node:path";
import { app, ipcMain, safeStorage, shell } from "electron";
import { createAccountsApi } from "./api.ts";
import { AppIdsStore } from "./apps-store.ts";
import { registerAccountsIpc } from "./ipc.ts";
import { waitForCallback } from "./loopback.ts";
import { AppKitKeychain, type Cipher, FileSecretStore, type SecretStore } from "./secrets.ts";
import { AccountsService } from "./service.ts";

const cipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
};

/** The secret store of this app (also the host's tunnel token source). */
export function createSecretStore(stateDir: string): SecretStore {
  return new FileSecretStore(join(stateDir, "desktop-secrets.json"), cipher, new AppKitKeychain());
}

export function setupAccounts(input: {
  stateDir: string;
  logsDir: string;
  secrets: SecretStore;
  apiPort: () => number | null;
  send: (channel: string, value: unknown) => void;
}): AccountsService {
  const service = new AccountsService({
    api: createAccountsApi(input.apiPort),
    secrets: input.secrets,
    ids: new AppIdsStore(join(input.stateDir, "desktop-accounts.json")),
    openExternal: (url) => shell.openExternal(url),
    waitForCallback: (path, options) => waitForCallback(path, options),
  });
  registerAccountsIpc(
    ipcMain,
    service,
    {
      info: () => ({
        version: app.getVersion(),
        electron: process.versions.electron ?? "",
        chrome: process.versions.chrome ?? "",
        node: process.versions.node ?? "",
        stateDir: input.stateDir,
        logsDir: input.logsDir,
      }),
      openPath: (path) => shell.openPath(path),
      secrets: input.secrets,
    },
    input.send,
  );
  return service;
}
