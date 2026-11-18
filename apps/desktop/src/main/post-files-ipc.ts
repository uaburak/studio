// Electron side of post export (post-files.ts): the save / folder dialogs, the macOS share menu
// and Finder, wired to the page's `window.studio.postFiles`.
import { join } from "node:path";
import { app, type BrowserWindow, dialog, ipcMain, ShareMenu, shell } from "electron";
import { POST_FILES_IPC, type PostFilesRequest } from "../shared/post-files.ts";
import { dialogFilter, PostFiles } from "./post-files.ts";

export function setupPostFiles(options: {
  window(): BrowserWindow | null;
  target(): { port: number; ownerSecret: string } | null;
}): PostFiles {
  const files = new PostFiles({
    target: options.target,
    chooseFile: async (suggestedName, format) => {
      const settings = {
        title: "Dışa aktar",
        buttonLabel: "Kaydet",
        defaultPath: join(app.getPath("downloads"), suggestedName),
        filters: [dialogFilter(format)],
      };
      const w = options.window();
      const result = w
        ? await dialog.showSaveDialog(w, settings)
        : await dialog.showSaveDialog(settings);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    chooseFolder: async (count) => {
      const settings = {
        title: "Dışa aktar",
        buttonLabel: "Bu klasöre kaydet",
        message: `${count} dosya bu klasöre kaydedilecek.`,
        defaultPath: app.getPath("downloads"),
        properties: ["openDirectory" as const, "createDirectory" as const],
      };
      const w = options.window();
      const result = w
        ? await dialog.showOpenDialog(w, settings)
        : await dialog.showOpenDialog(settings);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    shareDir: join(app.getPath("temp"), "Studio-Paylas"),
    showShareMenu: (filePaths) => {
      const w = options.window();
      const menu = new ShareMenu({ filePaths });
      menu.popup(w ? { window: w } : {});
    },
    showInFolder: (path) => shell.showItemInFolder(path),
  });
  ipcMain.handle(POST_FILES_IPC.save, (_e, request: PostFilesRequest) => files.save(request));
  ipcMain.handle(POST_FILES_IPC.share, (_e, request: PostFilesRequest) => files.share(request));
  ipcMain.handle(POST_FILES_IPC.reveal, (_e, paths: unknown) => files.reveal(paths));
  return files;
}
