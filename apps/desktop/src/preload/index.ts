// The only bridge between the sandboxed renderer and the main process: a small, typed API
// (`window.studio`). No Node APIs reach the page.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { ACCOUNTS_IPC as A } from "../shared/accounts-ipc.ts";
import {
  CANVAS_RUNNER_ARG,
  CANVAS_RUNNER_IPC,
  type CanvasRunnerBridge,
} from "../shared/canvas-runner.ts";
import { DRAFTS_IPC } from "../shared/drafts.ts";
import { FONTS_IPC } from "../shared/fonts.ts";
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
  rendererReady: () => ipcRenderer.send(IPC.rendererReady),
  onAppNotice: (listener) => subscribe(IPC.appNotice, listener),
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
  fonts: {
    list: (options) => ipcRenderer.invoke(FONTS_IPC.list, options),
    read: (postscriptName) => ipcRenderer.invoke(FONTS_IPC.read, postscriptName),
  },
  drafts: {
    save: (draft) => ipcRenderer.invoke(DRAFTS_IPC.save, draft),
    saveSync: (draft) => ipcRenderer.sendSync(DRAFTS_IPC.saveSync, draft) === true,
    load: (contentId) => ipcRenderer.invoke(DRAFTS_IPC.load, contentId),
    remove: (contentId) => ipcRenderer.invoke(DRAFTS_IPC.remove, contentId),
  },
  lifecycle: {
    onFlushRequest: (listener) => subscribe(DRAFTS_IPC.flushRequest, listener),
    flushDone: (id) => ipcRenderer.send(DRAFTS_IPC.flushDone, id),
  },
  system: {
    info: () => ipcRenderer.invoke(A.systemInfo),
    reveal: (target) => ipcRenderer.invoke(A.systemReveal, target),
    tunnelToken: {
      has: () => ipcRenderer.invoke(A.tunnelHas),
      save: (token) => ipcRenderer.invoke(A.tunnelSave, token),
      forget: () => ipcRenderer.invoke(A.tunnelForget),
    },
    backup: {
      create: () => ipcRenderer.invoke(A.backupCreate),
      restore: () => ipcRenderer.invoke(A.backupRestore),
    },
  },
};

// The hidden canvas runner's page (its window's extra argument) also gets the runner's channels.
const canvasRunner: CanvasRunnerBridge | undefined = process.argv.includes(CANVAS_RUNNER_ARG)
  ? {
      onJob: (listener) => subscribe(CANVAS_RUNNER_IPC.job, listener),
      onCancel: (listener) => subscribe(CANVAS_RUNNER_IPC.cancel, listener),
      ready: () => ipcRenderer.send(CANVAS_RUNNER_IPC.ready),
      progress: (update) => ipcRenderer.send(CANVAS_RUNNER_IPC.progress, update),
      done: (result) => ipcRenderer.send(CANVAS_RUNNER_IPC.done, result),
    }
  : undefined;

contextBridge.exposeInMainWorld("studio", canvasRunner ? { ...bridge, canvasRunner } : bridge);
