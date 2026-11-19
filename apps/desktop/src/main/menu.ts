// The macOS menu bar (Turkish). Commands that act on the window's content are forwarded to
// the renderer as `MenuCommand`s; the shortcuts match Claude Code's.
import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/ipc.ts";

export function buildMenu(
  send: (command: MenuCommand) => void,
  options: { isDev: boolean; getWindow: () => BrowserWindow | null },
): Menu {
  const item = (
    label: string,
    command: MenuCommand,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => send(command),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about", label: "Studio Hakkında" },
        { type: "separator" },
        item("Ayarlar…", "settings", "Cmd+,"),
        { type: "separator" },
        { role: "services", label: "Servisler" },
        { type: "separator" },
        { role: "hide", label: "Studio'yu Gizle" },
        { role: "hideOthers", label: "Diğerlerini Gizle" },
        { role: "unhide", label: "Tümünü Göster" },
        { type: "separator" },
        { role: "quit", label: "Studio'dan Çık" },
      ],
    },
    {
      label: "Dosya",
      submenu: [
        item("Yeni sohbet", "new-chat", "Cmd+N"),
        item("Ara…", "search", "Cmd+K"),
        { type: "separator" },
        item("Yeniden adlandır", "rename"),
        { type: "separator" },
        { role: "close", label: "Pencereyi Kapat" },
      ],
    },
    {
      label: "Düzen",
      submenu: [
        { role: "undo", label: "Geri Al" },
        { role: "redo", label: "Yinele" },
        { type: "separator" },
        { role: "cut", label: "Kes" },
        { role: "copy", label: "Kopyala" },
        { role: "paste", label: "Yapıştır" },
        { role: "selectAll", label: "Tümünü Seç" },
      ],
    },
    {
      label: "Görünüm",
      submenu: [
        item("Kenar çubuğu", "toggle-sidebar", "Cmd+\\"),
        item("Sağ panel", "toggle-panel", "Alt+Cmd+I"),
        { type: "separator" },
        item("Geri", "back", "Cmd+["),
        item("İleri", "forward", "Cmd+]"),
        { type: "separator" },
        { role: "togglefullscreen", label: "Tam Ekran" },
        ...(options.isDev
          ? ([
              { type: "separator" },
              item("Bileşen galerisi", "gallery", "Alt+Cmd+G"),
              { role: "reload", label: "Yeniden yükle" },
              { role: "toggleDevTools", label: "Geliştirici araçları" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      // The AppKit app's Git menu. On the post canvas ⇧⌘K / ⇧⌘P stay Wecra's (place image,
      // pixel preview): the page marks them used and the renderer skips the command.
      label: "Git",
      submenu: [
        item("Profil", "go-posts", "Shift+Cmd+P"),
        item("Takvim", "go-calendar", "Shift+Cmd+K"),
        item("Medya", "go-media", "Shift+Cmd+M"),
        { type: "separator" },
        item("Yeni marka…", "new-brand", "Shift+Cmd+N"),
        item("Marka ayarları", "brand-settings", "Shift+Cmd+B"),
      ],
    },
    {
      label: "Pencere",
      role: "windowMenu",
    },
    {
      // Not role "help": macOS would put its help search on ⇧⌘/ (the AppKit app's shortcut list).
      label: "Yardım",
      submenu: [
        item("Klavye kısayolları", "help-shortcuts", "Shift+Cmd+/"),
        item("Başlangıç rehberi…", "help-onboarding"),
        { type: "separator" },
        item("Studio günlüklerini göster", "help-logs"),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
