import AppKit
import StudioKit

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }

    private var settings: AppSettings!
    private var model: AppModel!
    private var host: LocalHost!
    private var mainWindowController: MainWindowController?

    private var termSource: (any DispatchSourceSignal)?
    private var terminating = false
    private var menuObservation: ObservationToken?

    private weak var inspectorMenuItem: NSMenuItem?
    private var appearanceItems: [AppearancePreference: NSMenuItem] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        let s = AppSettings()
        self.settings = s
        self.model = AppModel(settings: s)
        self.host = LocalHost(configuration: { s.hostConfiguration })

        buildMainMenu()
        s.applyAppearance()

        // SIGTERM quits gracefully so supervised children stop cleanly.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        termSource = source

        if SnapshotMode.isActive {
            SnapshotMode.run()
            return
        }

        let underTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        if underTest {
            return
        }

        NSApp.setActivationPolicy(.regular)
        let wc = MainWindowController(app: model, settings: settings, host: host)
        self.mainWindowController = wc
        wc.showWindow(nil)
        wc.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        didShowMainWindow()

        menuObservation = observe { [weak self] in
            self?.syncMenus()
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            if self.settings.hostEnabled && !self.settings.useSampleData {
                ActiveHost.current = self.host
                self.host.onAPIURLChange = { [weak self] url in
                    guard let self, self.settings.hostAPIURL != url else { return }
                    self.settings.hostAPIURL = url
                    self.model.reconnect()
                }
                await self.host.start()
                self.settings.hostAPIURL = self.host.apiURL
                self.model.reconnect(reload: false)
            }
            await self.model.load()
            self.model.applyLaunchRoute()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating, let host = ActiveHost.current, host.ownsChildren else { return .terminateNow }
        terminating = true
        Task { @MainActor in
            await host.stop()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !SnapshotMode.isActive
    }

    private func didShowMainWindow() {
        let args = ProcessInfo.processInfo.arguments
        if !SnapshotMode.isActive, let index = args.firstIndex(of: "--window-id-file"), index + 1 < args.count {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if let window = NSApp.windows.first(where: { $0.identifier?.rawValue.contains("main") == true || $0.isMainWindow }) ?? NSApp.windows.first {
                    try? String(window.windowNumber).write(toFile: args[index + 1], atomically: true, encoding: .utf8)
                }
            }
        }
    }

    // MARK: - Main Menu Bar (Turkish)

    private func buildMainMenu() {
        let mainMenu = NSMenu()

        // 1. Studio
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: "Studio")
        appMenu.addItem(withTitle: "Studio Hakkında", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "Ayarlar…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Studio'yu Gizle", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Diğerlerini Gizle", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "Tümünü Göster", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Studio'dan Çık", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // 2. Dosya
        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "Dosya")
        let newChat = NSMenuItem(title: "Yeni sohbet", action: #selector(startNewChat), keyEquivalent: "n")
        newChat.target = self
        fileMenu.addItem(newChat)
        let search = NSMenuItem(title: "Ara…", action: #selector(openSearch), keyEquivalent: "k")
        search.target = self
        fileMenu.addItem(search)
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Kapat", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        // 3. Düzen (standard responder chain selectors so NSTextView / NSTextField shortcuts work!)
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Düzen")
        editMenu.addItem(withTitle: "Geri Al", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Yinele", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Kes", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Kopyala", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Yapıştır", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Tümünü Seç", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // 4. Görünüm
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "Görünüm")
        let sidebarToggle = NSMenuItem(title: "Kenar çubuğunu aç/kapat", action: #selector(toggleSidebarMenu), keyEquivalent: "s")
        sidebarToggle.keyEquivalentModifierMask = [.command, .control]
        sidebarToggle.target = self
        viewMenu.addItem(sidebarToggle)

        let inspectorToggle = NSMenuItem(title: "Sağ paneli gizle", action: #selector(toggleInspectorMenu), keyEquivalent: "i")
        inspectorToggle.keyEquivalentModifierMask = [.command, .option]
        inspectorToggle.target = self
        viewMenu.addItem(inspectorToggle)
        self.inspectorMenuItem = inspectorToggle

        viewMenu.addItem(.separator())
        let appearanceSubItem = NSMenuItem(title: "Görünüm", action: nil, keyEquivalent: "")
        let appearanceSubMenu = NSMenu(title: "Görünüm")
        for pref in AppearancePreference.allCases {
            let item = NSMenuItem(title: pref.label, action: #selector(pickAppearanceMenu(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = pref.rawValue
            appearanceItems[pref] = item
            appearanceSubMenu.addItem(item)
        }
        appearanceSubItem.submenu = appearanceSubMenu
        viewMenu.addItem(appearanceSubItem)

        let cycleAppearance = NSMenuItem(title: "Görünümü değiştir", action: #selector(cycleAppearanceMenu), keyEquivalent: "l")
        cycleAppearance.keyEquivalentModifierMask = [.command, .shift]
        cycleAppearance.target = self
        viewMenu.addItem(cycleAppearance)

        viewMenu.addItem(.separator())
        let fullScreen = NSMenuItem(title: "Tam Ekran", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreen)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // 5. Git
        let goMenuItem = NSMenuItem()
        let goMenu = NSMenu(title: "Git")
        let back = NSMenuItem(title: "Geri", action: #selector(goBackMenu), keyEquivalent: "[")
        back.target = self
        goMenu.addItem(back)
        let forward = NSMenuItem(title: "İleri", action: #selector(goForwardMenu), keyEquivalent: "]")
        forward.target = self
        goMenu.addItem(forward)
        goMenu.addItem(.separator())
        let posts = NSMenuItem(title: "Postlar", action: #selector(openPostsMenu), keyEquivalent: "p")
        posts.keyEquivalentModifierMask = [.command, .shift]
        posts.target = self
        goMenu.addItem(posts)
        let calendar = NSMenuItem(title: "Takvim", action: #selector(openCalendarMenu), keyEquivalent: "k")
        calendar.keyEquivalentModifierMask = [.command, .shift]
        calendar.target = self
        goMenu.addItem(calendar)
        let media = NSMenuItem(title: "Medya", action: #selector(openMediaMenu), keyEquivalent: "m")
        media.keyEquivalentModifierMask = [.command, .shift]
        media.target = self
        goMenu.addItem(media)
        goMenuItem.submenu = goMenu
        mainMenu.addItem(goMenuItem)

        // 6. Pencere
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Pencere")
        windowMenu.addItem(withTitle: "Küçült", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Büyüt", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Tümünü Öne Getir", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    private func syncMenus() {
        inspectorMenuItem?.title = model.inspectorPresented ? "Sağ paneli gizle" : "Sağ paneli göster"
        for (pref, item) in appearanceItems {
            item.state = settings.appearance == pref ? .on : .off
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(goBackMenu): return model?.canGoBack ?? false
        case #selector(goForwardMenu): return model?.canGoForward ?? false
        default: return true
        }
    }

    // MARK: Menu Actions

    @objc private func openSettings() { model.settingsPresented = true }
    @objc private func startNewChat() { model.startNewChat() }
    @objc private func openSearch() { model.searchPresented = true }
    @objc private func toggleSidebarMenu() { model.toggleSidebar() }
    @objc private func toggleInspectorMenu() { model.toggleInspector() }
    @objc private func goBackMenu() { model.goBack() }
    @objc private func goForwardMenu() { model.goForward() }
    @objc private func openPostsMenu() { model.navigate(to: .posts) }
    @objc private func openCalendarMenu() { model.navigate(to: .calendar) }
    @objc private func openMediaMenu() { model.navigate(to: .media) }

    @objc private func pickAppearanceMenu(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let pref = AppearancePreference(rawValue: raw) else { return }
        settings.appearance = pref
    }

    @objc private func cycleAppearanceMenu() {
        settings.appearance = settings.appearance.next
    }
}
