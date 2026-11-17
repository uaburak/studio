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
        // A clicked notification brings the window forward and opens its post (or the accounts).
        model.publishing.notifier.onOpen = { [weak self] destination in self?.openNotice(destination) }

        // One window, no tabs: keeps "Sekme Çubuğunu Göster" out of the Görüntü menu.
        NSWindow.allowsAutomaticWindowTabbing = false
        buildMainMenu()
        s.applyAppearance()

        // SIGTERM quits gracefully so supervised children stop cleanly.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        // Not `NSApp.terminate` right here: inside a main-queue callout, `.terminateLater`
        // spins a nested event loop while the main queue is busy, so the main-actor task that
        // stops the children never runs (the app hung on `kill <pid>`). A run-loop perform
        // calls it from the event loop, like ⌘Q.
        source.setEventHandler { NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0) }
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
                self.model.host = self.host
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
            self.model.restoreSession()
            self.model.applyLaunchRoute()
            // Studio was opened by clicking a notification: show its post now.
            self.model.openPendingNotice()
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

    /// Closing the window keeps Studio running: the Mac server must stay up for the
    /// iPhone and for scheduled posts. Quit (⌘Q) stops it; the Dock icon reopens the window.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func openNotice(_ destination: NoticeDestination) {
        if case .link(let url) = destination {
            NSWorkspace.shared.open(url)
            return
        }
        NSApp.activate()
        if let window = mainWindow {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
        model.openNotice(destination)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { mainWindow?.makeKeyAndOrderFront(nil) }
        return true
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

    /// Test seam: wire a model without launching the window.
    func attach(model: AppModel, settings: AppSettings) {
        self.model = model
        self.settings = settings
    }

    private func buildMainMenu() {
        NSApp.mainMenu = makeMainMenu()
        NSApp.servicesMenu = servicesMenu
    }

    private var servicesMenu: NSMenu?
    private weak var brandMenu: NSMenu?
    private var brandMenuSignature: [String] = []

    private func item(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        return item
    }

    /// The whole menu bar: Studio, Dosya, Düzen, Görüntü, Git, Marka, Pencere, Yardım.
    func makeMainMenu() -> NSMenu {
        let mainMenu = NSMenu()
        appearanceItems = [:]

        // 1. Studio
        let appMenu = NSMenu(title: "Studio")
        appMenu.addItem(item("Studio Hakkında", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Ayarlar…", #selector(openSettings), ",", target: self))
        appMenu.addItem(.separator())
        let services = NSMenu(title: "Hizmetler")
        let servicesItem = NSMenuItem(title: "Hizmetler", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        servicesMenu = services
        appMenu.addItem(servicesItem)
        appMenu.addItem(.separator())
        appMenu.addItem(item("Studio'yu Gizle", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Diğerlerini Gizle", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        appMenu.addItem(item("Tümünü Göster", #selector(NSApplication.unhideAllApplications(_:))))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Studio'dan Çık", #selector(NSApplication.terminate(_:)), "q"))
        add(appMenu, to: mainMenu)

        // 2. Dosya
        let fileMenu = NSMenu(title: "Dosya")
        fileMenu.addItem(item("Yeni Sohbet", #selector(startNewChat), "n", target: self))
        fileMenu.addItem(.separator())
        fileMenu.addItem(item("Kapat", #selector(NSWindow.performClose(_:)), "w"))
        add(fileMenu, to: mainMenu)

        // 3. Düzen: standard responder-chain selectors, so text views, the composer
        // (images paste as attachments) and the post editor (version undo) all work.
        let editMenu = NSMenu(title: "Düzen")
        editMenu.addItem(item("Geri Al", Selector(("undo:")), "z"))
        editMenu.addItem(item("Yinele", Selector(("redo:")), "z", [.command, .shift]))
        editMenu.addItem(.separator())
        editMenu.addItem(item("Kes", #selector(NSText.cut(_:)), "x"))
        editMenu.addItem(item("Kopyala", #selector(NSText.copy(_:)), "c"))
        editMenu.addItem(item("Yapıştır", #selector(NSText.paste(_:)), "v"))
        editMenu.addItem(item("Yapıştır ve Stili Eşleştir", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]))
        editMenu.addItem(item("Sil", #selector(NSText.delete(_:))))
        editMenu.addItem(item("Tümünü Seç", #selector(NSText.selectAll(_:)), "a"))
        editMenu.addItem(.separator())
        editMenu.addItem(item("Bul…", #selector(openSearch), "f", target: self))
        // ⌘K opens the same palette (Claude-style); hidden but active.
        let altSearch = item("Ara…", #selector(openSearch), "k", target: self)
        altSearch.isHidden = true
        altSearch.allowsKeyEquivalentWhenHidden = true
        editMenu.addItem(altSearch)
        add(editMenu, to: mainMenu)

        // 4. Görüntü
        let viewMenu = NSMenu(title: "Görüntü")
        viewMenu.addItem(item("Kenar Çubuğunu Gizle", #selector(toggleSidebarMenu), "s", [.command, .control], target: self))
        // ⌘\ toggles the sidebar too (Claude Code); hidden but active.
        let altSidebar = item("Kenar Çubuğu", #selector(toggleSidebarMenu), "\\", target: self)
        altSidebar.isHidden = true
        altSidebar.allowsKeyEquivalentWhenHidden = true
        viewMenu.addItem(altSidebar)
        let inspectorToggle = item("Sağ Paneli Gizle", #selector(toggleInspectorMenu), "i", [.command, .option], target: self)
        viewMenu.addItem(inspectorToggle)
        inspectorMenuItem = inspectorToggle
        viewMenu.addItem(.separator())
        let appearanceSubItem = NSMenuItem(title: "Görünüm", action: nil, keyEquivalent: "")
        let appearanceSubMenu = NSMenu(title: "Görünüm")
        for pref in AppearancePreference.allCases {
            let entry = item(pref.label, #selector(pickAppearanceMenu(_:)), target: self)
            entry.representedObject = pref.rawValue
            appearanceItems[pref] = entry
            appearanceSubMenu.addItem(entry)
        }
        appearanceSubMenu.addItem(.separator())
        appearanceSubMenu.addItem(item("Sıradaki Görünüm", #selector(cycleAppearanceMenu), "l", [.command, .shift], target: self))
        appearanceSubItem.submenu = appearanceSubMenu
        viewMenu.addItem(appearanceSubItem)
        viewMenu.addItem(.separator())
        viewMenu.addItem(item("Yenile", #selector(reloadMenu), "r", target: self))
        viewMenu.addItem(.separator())
        viewMenu.addItem(item("Tam Ekrana Geç", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        add(viewMenu, to: mainMenu)

        // 5. Git
        let goMenu = NSMenu(title: "Git")
        goMenu.addItem(item("Geri", #selector(goBackMenu), "[", target: self))
        goMenu.addItem(item("İleri", #selector(goForwardMenu), "]", target: self))
        goMenu.addItem(.separator())
        goMenu.addItem(item("Postlar", #selector(openPostsMenu), "p", [.command, .shift], target: self))
        goMenu.addItem(item("Takvim", #selector(openCalendarMenu), "k", [.command, .shift], target: self))
        goMenu.addItem(item("Medya", #selector(openMediaMenu), "m", [.command, .shift], target: self))
        add(goMenu, to: mainMenu)

        // 6. Marka (brand list with ⌘1…⌘9 is filled by syncBrandMenu)
        let brands = NSMenu(title: "Marka")
        brands.autoenablesItems = true
        add(brands, to: mainMenu)
        brandMenu = brands
        brandMenuSignature = []
        syncBrandMenu()

        // 7. Pencere
        let windowMenu = NSMenu(title: "Pencere")
        windowMenu.addItem(item("Küçült", #selector(NSWindow.performMiniaturize(_:)), "m"))
        windowMenu.addItem(item("Büyüt", #selector(NSWindow.performZoom(_:))))
        windowMenu.addItem(.separator())
        windowMenu.addItem(item("Studio Penceresi", #selector(showMainWindowMenu), "0", target: self))
        windowMenu.addItem(.separator())
        windowMenu.addItem(item("Tümünü Öne Getir", #selector(NSApplication.arrangeInFront(_:))))
        add(windowMenu, to: mainMenu)
        NSApp?.windowsMenu = windowMenu

        // 8. Yardım
        let helpMenu = NSMenu(title: "Yardım")
        helpMenu.addItem(item("Klavye Kısayolları", #selector(showShortcutsMenu), "/", [.command, .shift], target: self))
        helpMenu.addItem(item("Başlangıç Rehberi…", #selector(openOnboardingMenu), target: self))
        helpMenu.addItem(.separator())
        helpMenu.addItem(item("Studio Günlüklerini Göster", #selector(revealLogsMenu), target: self))
        add(helpMenu, to: mainMenu)
        NSApp?.helpMenu = helpMenu

        return mainMenu
    }

    private func add(_ menu: NSMenu, to bar: NSMenu) {
        let holder = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        bar.addItem(holder)
    }

    /// Rebuilds the Marka menu when the brands change (titles, order, current brand).
    func syncBrandMenu() {
        guard let menu = brandMenu, let model else { return }
        let ordered = model.brandMenuOrder
        let signature = ordered.map { "\($0.id)|\($0.name)" } + [model.currentBrandId ?? "-"]
        guard signature != brandMenuSignature else { return }
        brandMenuSignature = signature
        menu.removeAllItems()
        if ordered.isEmpty {
            let empty = NSMenuItem(title: "Henüz marka yok", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        }
        for (index, brand) in ordered.enumerated() {
            let entry = item(brand.name, #selector(selectBrandMenu(_:)), index < 9 ? String(index + 1) : "", target: self)
            entry.tag = index
            entry.state = brand.id == model.currentBrandId ? .on : .off
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        menu.addItem(item("Yeni Marka…", #selector(openNewBrandMenu), "n", [.command, .shift], target: self))
        menu.addItem(item("Marka Ayarları…", #selector(openBrandSettingsMenu), "b", [.command, .shift], target: self))
        menu.addItem(item("Marka Kiti…", #selector(openBrandKitMenu), target: self))
        menu.addItem(item("Marka Profili…", #selector(openBrandProfileMenu), target: self))
    }

    private func syncMenus() {
        inspectorMenuItem?.title = model.inspectorPresented ? "Sağ Paneli Gizle" : "Sağ Paneli Göster"
        for (pref, item) in appearanceItems {
            item.state = settings.appearance == pref ? .on : .off
        }
        syncBrandMenu()
    }

    // MARK: Validation

    private var mainWindow: NSWindow? { mainWindowController?.window }

    func menuState() -> MenuState {
        guard let model else { return MenuState(hasWindow: false) }
        let ordered = model.brandMenuOrder.map(\.id)
        let window = mainWindow
        return MenuState(
            canGoBack: model.canGoBack,
            canGoForward: model.canGoForward,
            brandIds: ordered,
            currentBrandId: model.currentBrandId,
            switchableBrandIds: Set(ordered.filter { model.canSwitchBrand(to: $0) }),
            // The settings panel lives in the window (no attached sheet) but covers it the same way.
            sheetOpen: window?.attachedSheet != nil || model.settingsPresented,
            hasWindow: window != nil || assumeWindowForTesting,
            isSample: model.isSample,
            isLoading: model.isLoading,
            hasHostLogs: model.host != nil
        )
    }

    /// Tests run without the window; menus still validate against the model.
    var assumeWindowForTesting = false

    static func command(for menuItem: NSMenuItem) -> MenuCommand? {
        switch menuItem.action {
        case #selector(startNewChat): .newChat
        case #selector(openSearch): .search
        case #selector(openSettings): .settings
        case #selector(openNewBrandMenu): .newBrand
        case #selector(openBrandSettingsMenu): .brandSettings
        case #selector(openBrandKitMenu): .brandKit
        case #selector(openBrandProfileMenu): .brandProfile
        case #selector(selectBrandMenu(_:)): .selectBrand(menuItem.tag)
        case #selector(goBackMenu): .back
        case #selector(goForwardMenu): .forward
        case #selector(openPostsMenu): .posts
        case #selector(openCalendarMenu): .calendar
        case #selector(openMediaMenu): .media
        case #selector(toggleSidebarMenu): .toggleSidebar
        case #selector(toggleInspectorMenu): .toggleInspector
        case #selector(pickAppearanceMenu(_:)), #selector(cycleAppearanceMenu): .appearance
        case #selector(reloadMenu): .reload
        case #selector(openOnboardingMenu): .onboarding
        case #selector(showShortcutsMenu): .shortcuts
        case #selector(revealLogsMenu): .revealLogs
        default: nil
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let command = Self.command(for: menuItem) else { return true }
        return MenuValidator.isEnabled(command, in: menuState())
    }

    // MARK: Menu Actions

    @objc func openSettings() { model.openSettings() }
    @objc func startNewChat() { model.startNewChat() }
    @objc func openSearch() { model.searchPresented = true }
    @objc func toggleSidebarMenu() { model.toggleSidebar() }
    @objc func toggleInspectorMenu() { model.toggleInspector() }
    @objc func goBackMenu() { model.goBack() }
    @objc func goForwardMenu() { model.goForward() }
    @objc func openPostsMenu() { model.navigate(to: .posts) }
    @objc func openCalendarMenu() { model.navigate(to: .calendar) }
    @objc func openMediaMenu() { model.navigate(to: .media) }
    @objc func openNewBrandMenu() { model.newBrandPresented = true }
    @objc func openOnboardingMenu() { model.onboarding.reopen() }
    @objc func reloadMenu() { Task { await model.reloadCurrentScreen() } }

    @objc func selectBrandMenu(_ sender: NSMenuItem) {
        if !model.switchToBrand(at: sender.tag) { NSSound.beep() }
    }

    @objc func openBrandSettingsMenu() {
        guard let id = model.currentBrandId else { return }
        model.openBrandSettings(id)
    }

    @objc func openBrandKitMenu() {
        guard let id = model.currentBrandId else { return }
        model.openBrandSettings(id, tab: .kit)
    }

    @objc func openBrandProfileMenu() {
        guard let id = model.currentBrandId else { return }
        model.openBrandSettings(id, tab: .profile)
    }

    @objc func pickAppearanceMenu(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let pref = AppearancePreference(rawValue: raw) else { return }
        settings.appearance = pref
    }

    @objc func cycleAppearanceMenu() {
        settings.appearance = settings.appearance.next
    }

    @objc func showMainWindowMenu() {
        mainWindow?.makeKeyAndOrderFront(nil)
    }

    @objc func showShortcutsMenu() {
        let alert = NSAlert()
        alert.messageText = "Klavye kısayolları"
        alert.informativeText = ShortcutGuide.text
        alert.addButton(withTitle: "Tamam")
        if let window = mainWindow, window.attachedSheet == nil {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    @objc func revealLogsMenu() {
        guard let host = model.host else { return }
        let logs = host.logsDirectory
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([logs])
    }
}
