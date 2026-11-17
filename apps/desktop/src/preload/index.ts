// The only bridge between the sandboxed renderer and the main process: a small, typed API
// (`window.studio`). No Node APIs reach the page.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
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
};

contextBridge.exposeInMainWorld("studio", bridge);
