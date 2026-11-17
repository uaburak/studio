// The only bridge between the sandboxed renderer and the main process: a small, typed API
// (`window.studio`). No Node APIs reach the page.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { ACCOUNTS_IPC as A } from "../shared/accounts-ipc.ts";
import { IPC, type StudioBridge } from "../shared/ipc.ts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: StudioBridge = {
  platform: process.platform,
  host: {
    get: () => ipcRenderer.invoke(IPC.hostGet),
    restart: () => ipcRenderer.invoke(IPC.hostRestart),
    onChange: (listener) => subscribe(IPC.hostChanged, listener),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    onChange: (listener) => subscribe(IPC.settingsChanged, listener),
  },
  notify: (notice) => ipcRenderer.invoke(IPC.notify, notice),
  onNoticeClicked: (listener) => subscribe(IPC.noticeClicked, listener),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  onMenuCommand: (listener) => subscribe(IPC.menuCommand, listener),
  onWindowState: (listener) => subscribe(IPC.windowState, listener),
  accounts: {
    state: () => ipcRenderer.invoke(A.state),
    onChange: (listener) => subscribe(A.changed, listener),
    apps: () => ipcRenderer.invoke(A.apps),
    saveMetaApp: (input) => ipcRenderer.invoke(A.saveMetaApp, input),
    saveLinkedInApp: (input) => ipcRenderer.invoke(A.saveLinkedInApp, input),
    forgetMetaSecret: () => ipcRenderer.invoke(A.forgetMetaSecret),
    connectMeta: (brandId) => ipcRenderer.invoke(A.connectMeta, brandId),
    connectLinkedIn: (brandId) => ipcRenderer.invoke(A.connectLinkedIn, brandId),
    confirmMeta: (selections) => ipcRenderer.invoke(A.confirmMeta, selections),
    cancel: () => ipcRenderer.invoke(A.cancel),
    dismiss: () => ipcRenderer.invoke(A.dismiss),
    check: (account) => ipcRenderer.invoke(A.check, account),
    disconnect: (id) => ipcRenderer.invoke(A.disconnect, id),
  },
  system: {
    info: () => ipcRenderer.invoke(A.systemInfo),
    reveal: (target) => ipcRenderer.invoke(A.systemReveal, target),
    tunnelToken: {
      has: () => ipcRenderer.invoke(A.tunnelHas),
      save: (token) => ipcRenderer.invoke(A.tunnelSave, token),
      forget: () => ipcRenderer.invoke(A.tunnelForget),
    },
  },
};

contextBridge.exposeInMainWorld("studio", bridge);
