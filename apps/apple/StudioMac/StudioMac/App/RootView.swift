import AppKit
import StudioKit

// MARK: - MainWindowController

final class MainWindowController: NSWindowController, NSToolbarDelegate {
    let app: AppModel
    let settings: AppSettings
    let host: LocalHost?
    let rootViewController: RootViewController

    private static let sidebarSeparatorId = NSToolbarItem.Identifier("studio.sidebarSeparator")
    private static let navGroupId = NSToolbarItem.Identifier("studio.navigation")
    private static let titleMenuId = NSToolbarItem.Identifier("studio.titleMenu")
    private static let inspectorId = NSToolbarItem.Identifier("studio.inspector")
    private static let moreMenuId = NSToolbarItem.Identifier("studio.moreMenu")
    static let frameAutosaveName = "StudioMainWindow"

    /// A saved frame from a screen that is gone (or a smaller one) is pulled back on screen.
    static func clamped(_ frame: NSRect, to visible: NSRect, minSize: NSSize) -> NSRect {
        var out = frame
        out.size.width = max(minSize.width, min(out.width, visible.width))
        out.size.height = max(minSize.height, min(out.height, visible.height))
        out.origin.x = min(max(out.minX, visible.minX), visible.maxX - out.width)
        out.origin.y = min(max(out.minY, visible.minY), visible.maxY - out.height)
        return out
    }

    private var backButton: NSButton?
    private var forwardButton: NSButton?
    private var titleMenuControl: ToolbarTitleMenuControl?
    private var inspectorButton: NSButton?
    private var observation: ObservationToken?

    init(app: AppModel, settings: AppSettings, host: LocalHost?) {
        self.app = app
        self.settings = settings
        self.host = host
        self.rootViewController = RootViewController(app: app, settings: settings, host: host)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.identifier = NSUserInterfaceItemIdentifier("main")
        window.title = "Studio"
        window.titleVisibility = .hidden
        window.toolbarStyle = .unified
        window.contentMinSize = NSSize(width: 860, height: 560)
        window.contentViewController = rootViewController
        window.setContentSize(NSSize(width: 1440, height: 900))
        window.center()
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.tabbingMode = .disallowed
        // Size and position survive relaunches (first launch: centred 1440x900).
        window.setFrameUsingName(Self.frameAutosaveName)
        window.setFrameAutosaveName(Self.frameAutosaveName)
        if let screen = window.screen ?? NSScreen.main {
            window.setFrame(Self.clamped(window.frame, to: screen.visibleFrame, minSize: window.minSize), display: false)
        }

        window.isReleasedWhenClosed = false // closing hides it; Studio keeps running (see applicationShouldTerminateAfterLastWindowClosed)
        super.init(window: window)

        let toolbar = NSToolbar(identifier: "studio.main.toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar

        observation = observe { [weak self] in
            self?.syncToolbar()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func syncToolbar() {
        window?.title = app.title
        backButton?.isEnabled = app.canGoBack
        forwardButton?.isEnabled = app.canGoForward
        titleMenuControl?.titleText = app.title
        inspectorButton?.toolTip = app.inspectorPresented ? "Sağ paneli gizle (⌥⌘I)" : "Sağ paneli göster (⌥⌘I)"
    }

    // MARK: NSToolbarDelegate

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            .toggleSidebar,
            Self.sidebarSeparatorId,
            Self.navGroupId,
            Self.titleMenuId,
            .flexibleSpace,
            Self.inspectorId,
            Self.moreMenuId,
        ]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch itemIdentifier {
        case Self.sidebarSeparatorId:
            return NSTrackingSeparatorToolbarItem(
                identifier: Self.sidebarSeparatorId,
                splitView: rootViewController.splitController.splitView,
                dividerIndex: 0
            )

        case Self.navGroupId:
            let backItem = NSToolbarItem(itemIdentifier: NSToolbarItem.Identifier("studio.back"))
            let back = NSButton(image: NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Geri")!, target: self, action: #selector(goBack))
            back.bezelStyle = .toolbar
            back.toolTip = "Geri (⌘[)"
            back.isEnabled = app.canGoBack
            backItem.view = back
            self.backButton = back

            let forwardItem = NSToolbarItem(itemIdentifier: NSToolbarItem.Identifier("studio.forward"))
            let forward = NSButton(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "İleri")!, target: self, action: #selector(goForward))
            forward.bezelStyle = .toolbar
            forward.toolTip = "İleri (⌘])"
            forward.isEnabled = app.canGoForward
            forwardItem.view = forward
            self.forwardButton = forward

            backItem.label = "Geri"
            forwardItem.label = "İleri"
            let group = NSToolbarItemGroup(itemIdentifier: Self.navGroupId)
            group.subitems = [backItem, forwardItem]
            group.label = "Gezinme"
            return group

        case Self.titleMenuId:
            let item = NSToolbarItem(itemIdentifier: Self.titleMenuId)
            let control = ToolbarTitleMenuControl(title: app.title) { [weak self] in
                self?.makeTitleMenu() ?? NSMenu()
            }
            control.toolTip = "Marka ve ekran seçenekleri"
            item.label = "Başlık"
            item.view = control
            if #available(macOS 26.0, *) {
                item.isBordered = false
            }
            self.titleMenuControl = control
            return item

        case Self.inspectorId:
            let item = NSToolbarItem(itemIdentifier: Self.inspectorId)
            let btn = NSButton(image: NSImage(systemSymbolName: "sidebar.right", accessibilityDescription: "Sağ panel")!, target: self, action: #selector(toggleInspector))
            btn.bezelStyle = .toolbar
            btn.toolTip = app.inspectorPresented ? "Sağ paneli gizle (⌥⌘I)" : "Sağ paneli göster (⌥⌘I)"
            item.label = "Sağ panel"
            item.view = btn
            self.inspectorButton = btn
            return item

        case Self.moreMenuId:
            let item = NSToolbarItem(itemIdentifier: Self.moreMenuId)
            let btn = ToolbarMenuIconControl(symbol: "ellipsis", help: "Diğer seçenekler") { [weak self] in
                self?.makeMoreMenu() ?? NSMenu()
            }
            item.label = "Diğer"
            item.view = btn
            return item

        default:
            return nil
        }
    }

    @objc private func goBack() { app.goBack() }
    @objc private func goForward() { app.goForward() }
    @objc private func toggleInspector() { app.toggleInspector() }

    // MARK: Title & More Menus

    private func makeTitleMenu() -> NSMenu {
        let menu = NSMenu()
        switch app.route {
        case .newChat:
            appendBrandItems(to: menu, disabled: !app.newChat.composer.drafts.isEmpty)
        case .posts:
            appendBrandItems(to: menu, disabled: false)
            let months = app.posts.months
            if months.count > 1 {
                menu.addItem(.separator())
                menu.addItem(.sectionHeader(title: "Ay"))
                let currentYear = MonthKey(Date()).year
                for month in months {
                    let item = NSMenuItem(title: TurkishFormat.monthTitle(month, currentYear: currentYear), action: #selector(pickMonth(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = "\(month.year)-\(month.month)"
                    item.state = app.posts.month == month ? .on : .off
                    menu.addItem(item)
                }
            }
        case .calendar, .media:
            appendBrandItems(to: menu, disabled: false)
        case .conversation(let id):
            let brand = app.brand(app.conversations.first { $0.id == id }?.brandId)
            let info = NSMenuItem(title: brand.map { "Marka: \($0.name)" } ?? "Markasız sohbet", action: nil, keyEquivalent: "")
            info.isEnabled = false
            menu.addItem(info)
            let postsItem = NSMenuItem(title: "Bu markanın postları", action: #selector(openCurrentConversationBrandPosts), keyEquivalent: "")
            postsItem.target = self
            postsItem.representedObject = brand?.id
            postsItem.isEnabled = brand != nil
            menu.addItem(postsItem)
        }
        return menu
    }

    private func appendBrandItems(to menu: NSMenu, disabled: Bool) {
        menu.addItem(.sectionHeader(title: "Marka"))
        for brand in app.brands {
            let item = NSMenuItem(title: brand.name, action: #selector(pickBrand(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = brand.id
            item.state = app.currentBrandId == brand.id ? .on : .off
            item.isEnabled = !(disabled && app.currentBrandId != brand.id)
            if disabled && app.currentBrandId != brand.id {
                item.toolTip = "Eklenmiş görseller markaya bağlı; markayı değiştirmek için önce onları kaldır."
            }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let addBrandItem = NSMenuItem(title: "+ Yeni Marka…", action: #selector(openNewBrandSheet), keyEquivalent: "")
        addBrandItem.target = self
        menu.addItem(addBrandItem)
        if let brandId = app.currentBrandId {
            let settingsItem = NSMenuItem(title: "Marka ayarları…", action: #selector(openCurrentBrandProfile), keyEquivalent: "")
            settingsItem.target = self
            settingsItem.representedObject = brandId
            menu.addItem(settingsItem)
        }
    }

    @objc private func openNewBrandSheet() {
        app.newBrandPresented = true
    }

    @objc private func openCurrentBrandProfile(_ sender: NSMenuItem) {
        guard let brandId = sender.representedObject as? EntityID else { return }
        app.openBrandSettings(brandId)
    }

    @objc private func pickBrand(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? EntityID else { return }
        app.selectBrand(id)
    }

    @objc private func pickMonth(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String else { return }
        let parts = raw.split(separator: "-")
        guard parts.count == 2, let y = Int(parts[0]), let m = Int(parts[1]) else { return }
        app.posts.month = MonthKey(year: y, month: m)
    }

    @objc private func openCurrentConversationBrandPosts(_ sender: NSMenuItem) {
        if let brandId = sender.representedObject as? EntityID {
            app.currentBrandId = brandId
        }
        app.navigate(to: .posts)
    }

    private func makeMoreMenu() -> NSMenu {
        let menu = NSMenu()
        switch app.route {
        case .conversation(let id):
            let rename = NSMenuItem(title: "Yeniden adlandır…", action: #selector(promptRenameConversation(_:)), keyEquivalent: "")
            rename.target = self
            rename.representedObject = id
            menu.addItem(rename)

            let archive = NSMenuItem(title: "Sohbeti arşivle", action: #selector(archiveConversation(_:)), keyEquivalent: "")
            archive.target = self
            archive.representedObject = id
            menu.addItem(archive)
            menu.addItem(.separator())

        case .posts:
            let refreshPosts = NSMenuItem(title: "Yenile", action: #selector(reloadPosts), keyEquivalent: "")
            refreshPosts.target = self
            menu.addItem(refreshPosts)
            menu.addItem(.separator())

        case .calendar:
            let refreshCal = NSMenuItem(title: "Takvimi yenile", action: #selector(reloadCalendar), keyEquivalent: "")
            refreshCal.target = self
            menu.addItem(refreshCal)
            menu.addItem(.separator())

        case .media:
            let refreshMedia = NSMenuItem(title: "Medyayı yenile", action: #selector(reloadMedia), keyEquivalent: "")
            refreshMedia.target = self
            menu.addItem(refreshMedia)
            menu.addItem(.separator())

        case .newChat:
            break
        }

        let reloadAll = NSMenuItem(title: "Verileri yenile", action: #selector(reloadData), keyEquivalent: "")
        reloadAll.target = self
        menu.addItem(reloadAll)

        let settingsItem = NSMenuItem(title: "Ayarlar…", action: #selector(openSettings), keyEquivalent: "")
        settingsItem.target = self
        menu.addItem(settingsItem)
        return menu
    }

    @objc private func promptRenameConversation(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? EntityID else { return }
        let model = app.conversationModel(id)
        let alert = NSAlert()
        alert.messageText = "Sohbeti yeniden adlandır"
        alert.addButton(withTitle: "Kaydet")
        alert.addButton(withTitle: "Vazgeç")
        let field = NSTextField(string: model.state?.conversation.title ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        if alert.runModal() == .alertFirstButtonReturn {
            let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !title.isEmpty {
                Task { await model.rename(to: title) }
            }
        }
    }

    @objc private func archiveConversation(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? EntityID else { return }
        let model = app.conversationModel(id)
        Task { await model.archive() }
    }

    @objc private func reloadPosts() {
        Task { await app.posts.load() }
    }

    @objc private func reloadCalendar() {
        Task { await app.calendar.load() }
    }

    @objc private func reloadMedia() {
        Task { await app.media.load() }
    }

    @objc private func reloadData() {
        Task { await app.load() }
    }

    @objc private func openSettings() {
        app.openSettings()
    }
}

// MARK: - Toolbar Custom Controls

private final class ToolbarTitleMenuControl: NSControl {
    var titleText: String {
        didSet {
            label.stringValue = titleText
            setAccessibilityLabel("\(titleText): marka ve ekran seçenekleri")
            invalidateIntrinsicContentSize()
        }
    }
    private let buildMenu: () -> NSMenu
    private let label = NSTextField(labelWithString: "")

    init(title: String, buildMenu: @escaping () -> NSMenu) {
        self.titleText = title
        self.buildMenu = buildMenu
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        setAccessibilityElement(true)
        setAccessibilityRole(.popUpButton)
        setAccessibilityLabel("\(title): marka ve ekran seçenekleri")
        label.stringValue = title
        label.font = Theme.titleFont
        label.textColor = Theme.textPrimary
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let chevron = NSImageView()
        chevron.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 8, weight: .semibold))
        chevron.contentTintColor = Theme.textSecondary

        let row = NSStackView(views: [label, chevron])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            widthAnchor.constraint(lessThanOrEqualToConstant: 320),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        let menu = buildMenu()
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: self)
    }

    override func accessibilityPerformPress() -> Bool {
        buildMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: self)
        return true
    }

    override func accessibilityPerformShowMenu() -> Bool { accessibilityPerformPress() }
}

private final class ToolbarMenuIconControl: NSControl {
    private let buildMenu: () -> NSMenu

    init(symbol: String, help: String, buildMenu: @escaping () -> NSMenu) {
        self.buildMenu = buildMenu
        super.init(frame: NSRect(x: 0, y: 0, width: 32, height: 28))
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = help
        setAccessibilityElement(true)
        setAccessibilityRole(.popUpButton)
        setAccessibilityLabel(help)

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: help)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .medium))
        icon.contentTintColor = Theme.textPrimary
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 32),
            heightAnchor.constraint(equalToConstant: 28),
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        let menu = buildMenu()
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: self)
    }

    override func accessibilityPerformPress() -> Bool {
        buildMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: self)
        return true
    }

    override func accessibilityPerformShowMenu() -> Bool { accessibilityPerformPress() }
}

// MARK: - RootViewController & MainSplitViewController & DetailContainerViewController

final class RootViewController: NSViewController {
    let app: AppModel
    let settings: AppSettings
    let host: LocalHost?
    let splitController: MainSplitViewController

    private let topBanner = InlineErrorBannerView()
    /// Server / API / worker / Claude problems: one honest banner with the fixing action.
    private let connectionBanner = InlineErrorBannerView()
    private var renderedIssue: ConnectionIssue?
    private let searchOverlay: SearchPaletteOverlayView
    private var postDetailOverlay: PostDetailOverlayView?
    private weak var activeSettingsSheet: SettingsSheetViewController?
    /// Dims the window under the settings panel.
    private let settingsBackdrop = ThemedView()
    private weak var activeNewBrandSheet: NewBrandSheetController?
    private weak var activeBrandSettingsSheet: BrandSettingsSheetController?
    private weak var activeOnboardingSheet: OnboardingSheetController?
    private weak var activeAccountSheet: AccountConnectSheetController?
    private weak var activeAIGeneratorSheet: AIImageGeneratorSheetController?

    private var observation: ObservationToken?

    init(app: AppModel, settings: AppSettings, host: LocalHost?) {
        self.app = app
        self.settings = settings
        self.host = host
        self.splitController = MainSplitViewController(app: app, settings: settings)
        self.searchOverlay = SearchPaletteOverlayView(app: app)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false

        addChild(splitController)
        splitController.view.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(splitController.view)

        searchOverlay.isHidden = true
        root.addSubview(searchOverlay)

        topBanner.isHidden = true
        topBanner.onDismiss = { [weak app] in app?.banner = nil }
        connectionBanner.isHidden = true
        connectionBanner.onDismiss = { [weak app] in app?.dismissedIssue = app?.connectionIssue }
        let bannerStack = NSStackView(views: [connectionBanner, topBanner])
        bannerStack.orientation = .vertical
        bannerStack.alignment = .centerX
        bannerStack.spacing = Theme.Spacing.s
        bannerStack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(bannerStack)

        settingsBackdrop.backgroundColor = Theme.Settings.backdrop
        settingsBackdrop.isHidden = true
        settingsBackdrop.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(settingsBackdrop)

        NSLayoutConstraint.activate([
            splitController.view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            splitController.view.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            splitController.view.topAnchor.constraint(equalTo: root.topAnchor),
            splitController.view.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            searchOverlay.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            searchOverlay.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            searchOverlay.topAnchor.constraint(equalTo: root.topAnchor),
            searchOverlay.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            settingsBackdrop.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            settingsBackdrop.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            settingsBackdrop.topAnchor.constraint(equalTo: root.topAnchor),
            settingsBackdrop.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            bannerStack.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            bannerStack.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor, constant: 8),
            bannerStack.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 16),
            topBanner.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            connectionBanner.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.syncOverlays()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        syncOverlays()
    }

    private func syncOverlays() {
        // Banner
        if let banner = app.banner {
            topBanner.message = banner
            topBanner.isHidden = false
        } else {
            topBanner.isHidden = true
        }
        syncConnectionBanner(app.visibleConnectionIssue)

        // Search palette
        let wasSearchHidden = searchOverlay.isHidden
        searchOverlay.isHidden = !app.searchPresented
        if app.searchPresented && wasSearchHidden {
            DispatchQueue.main.async { [weak self] in
                self?.searchOverlay.focusSearch()
            }
        }

        // Post detail overlay
        if let detailModel = app.detail {
            if postDetailOverlay?.model !== detailModel {
                postDetailOverlay?.removeFromSuperview()
                let overlay = PostDetailOverlayView(model: detailModel)
                view.addSubview(overlay, positioned: .below, relativeTo: searchOverlay)
                NSLayoutConstraint.activate([
                    overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                    overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                    overlay.topAnchor.constraint(equalTo: view.topAnchor),
                    overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                ])
                postDetailOverlay = overlay
                view.window?.makeFirstResponder(overlay)
            }
        } else if let existing = postDetailOverlay {
            existing.removeFromSuperview()
            postDetailOverlay = nil
        }

        // Settings sheet
        settingsBackdrop.isHidden = !app.settingsPresented
        if app.settingsPresented {
            if activeSettingsSheet == nil, view.window != nil {
                let sheet = SettingsSheetViewController(app: app, settings: settings, host: host, parentSize: view.bounds.size) { [weak self] in
                    self?.app.settingsPresented = false
                }
                activeSettingsSheet = sheet
                presentAsSheet(sheet)
            }
        } else if let sheet = activeSettingsSheet {
            dismiss(sheet)
            activeSettingsSheet = nil
        }

        // New Brand sheet
        if app.newBrandPresented {
            if activeNewBrandSheet == nil, view.window != nil {
                let sheet = NewBrandSheetController(app: app) { [weak self] in
                    self?.app.newBrandPresented = false
                }
                activeNewBrandSheet = sheet
                presentAsSheet(sheet)
            }
        } else if let sheet = activeNewBrandSheet {
            if sheet.presentingViewController != nil { dismiss(sheet) }
            activeNewBrandSheet = nil
        }

        // Brand settings sheet (general, kit, profile, accounts)
        if let target = app.brandSettingsTarget {
            if let sheet = activeBrandSettingsSheet, sheet.model.brandId != target.brandId {
                dismiss(sheet)
                activeBrandSettingsSheet = nil
            }
            if activeBrandSettingsSheet == nil, view.window != nil {
                let sheet = BrandSettingsSheetController(app: app, target: target) { [weak self] in
                    self?.app.brandSettingsTarget = nil
                }
                activeBrandSettingsSheet = sheet
                presentAsSheet(sheet)
            }
        } else if let sheet = activeBrandSettingsSheet {
            if sheet.presentingViewController != nil { dismiss(sheet) }
            activeBrandSettingsSheet = nil
        }

        // First-run flow
        if app.onboardingPresented {
            if activeOnboardingSheet == nil, view.window != nil {
                let sheet = OnboardingSheetController(app: app, host: host)
                activeOnboardingSheet = sheet
                presentAsSheet(sheet)
            }
        } else if let sheet = activeOnboardingSheet {
            if sheet.presentingViewController != nil { dismiss(sheet) }
            activeOnboardingSheet = nil
        }

        // Social Account Connect sheet
        if let accountTarget = app.accountConnectTarget {
            if activeAccountSheet == nil, view.window != nil {
                let sheet = AccountConnectSheetController(app: app, target: accountTarget) { [weak self] in
                    self?.app.accountConnectTarget = nil
                }
                activeAccountSheet = sheet
                presentAsSheet(sheet)
            }
        } else if let sheet = activeAccountSheet {
            dismiss(sheet)
            activeAccountSheet = nil
        }

        // AI Image Generator sheet
        if let aiTarget = app.aiGeneratorTarget {
            if activeAIGeneratorSheet == nil, view.window != nil {
                let sheet = AIImageGeneratorSheetController(app: app, target: aiTarget) { [weak self] in
                    self?.app.aiGeneratorTarget = nil
                }
                activeAIGeneratorSheet = sheet
                presentAsSheet(sheet)
            }
        } else if let sheet = activeAIGeneratorSheet {
            dismiss(sheet)
            activeAIGeneratorSheet = nil
        }
    }
}

extension RootViewController {
    fileprivate func syncConnectionBanner(_ issue: ConnectionIssue?) {
        guard issue != renderedIssue else { return }
        renderedIssue = issue
        guard let issue else {
            connectionBanner.isHidden = true
            return
        }
        connectionBanner.message = issue.message
        connectionBanner.isBusy = issue.isBusy
        connectionBanner.actions = issue.actions.map { action in
            BannerAction(title: Self.title(for: action)) { [weak app] in app?.perform(action) }
        }
        connectionBanner.isHidden = false
    }

    static func title(for action: ConnectionIssue.Action) -> String {
        switch action {
        case .retry: "Yeniden dene"
        case .restartHost: "Yeniden başlat"
        case .openSettings: "Ayarlar…"
        case .signInClaude: "Giriş yap"
        }
    }
}

final class MainSplitViewController: NSSplitViewController {
    private unowned let app: AppModel
    private let sidebarItem: NSSplitViewItem
    private let contentItem: NSSplitViewItem
    private let inspectorItem: NSSplitViewItem

    private var observation: ObservationToken?
    private var kvoTokens: [NSKeyValueObservation] = []

    init(app: AppModel, settings: AppSettings) {
        self.app = app
        let sidebarVC = SidebarViewController(app: app, settings: settings)
        let detailVC = DetailContainerViewController(app: app)
        let inspectorVC = InfoPanelViewController(app: app)

        sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebarVC)
        sidebarItem.minimumThickness = 200
        sidebarItem.maximumThickness = 320
        sidebarItem.canCollapse = true
        sidebarItem.isCollapsed = !app.sidebarPresented

        contentItem = NSSplitViewItem(viewController: detailVC)
        contentItem.minimumThickness = 420
        if #available(macOS 26.0, *) {
            contentItem.automaticallyAdjustsSafeAreaInsets = true
        }

        inspectorItem = NSSplitViewItem(inspectorWithViewController: inspectorVC)
        inspectorItem.minimumThickness = 240
        inspectorItem.maximumThickness = 360
        inspectorItem.canCollapse = true
        inspectorItem.isCollapsed = !app.inspectorPresented

        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        addSplitViewItem(sidebarItem)
        addSplitViewItem(contentItem)
        addSplitViewItem(inspectorItem)

        splitView.setPosition(Theme.sidebarWidth, ofDividerAt: 0)

        observation = observe { [weak self] in
            guard let self else { return }
            let wantSidebarCollapsed = !self.app.sidebarPresented
            if self.sidebarItem.isCollapsed != wantSidebarCollapsed {
                self.sidebarItem.isCollapsed = wantSidebarCollapsed
            }
            let wantInspectorCollapsed = !self.app.inspectorPresented
            if self.inspectorItem.isCollapsed != wantInspectorCollapsed {
                self.inspectorItem.isCollapsed = wantInspectorCollapsed
            }
        }

        kvoTokens = [
            sidebarItem.observe(\.isCollapsed, options: [.new]) { [weak self] _, change in
                guard let collapsed = change.newValue else { return }
                let presented = !collapsed
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if self.app.sidebarPresented != presented {
                        self.app.sidebarPresented = presented
                    }
                }
            },
            inspectorItem.observe(\.isCollapsed, options: [.new]) { [weak self] _, change in
                guard let collapsed = change.newValue else { return }
                let presented = !collapsed
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if self.app.inspectorPresented != presented {
                        self.app.inspectorPresented = presented
                    }
                }
            },
        ]
    }

    override func toggleSidebar(_ sender: Any?) {
        app.toggleSidebar()
    }
}

final class DetailContainerViewController: NSViewController {
    private unowned let app: AppModel
    private lazy var startVC = StartViewController(app: app)
    private lazy var postsVC = PostsViewController(app: app)
    private lazy var calendarVC = CalendarViewController(app: app)
    private lazy var mediaVC = MediaViewController(app: app)
    private var chatControllers: [EntityID: ChatViewController] = [:]
    private weak var activeChild: NSViewController?
    private var renderedRoute: Route?
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false
        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.syncRoute()
        }
    }

    private func syncRoute() {
        let route = app.route
        // Drop cached chat view controllers whose models were cleared (e.g. reconnect).
        let validIds = Set(app.conversationModels.keys)
        for key in Array(chatControllers.keys) where !validIds.contains(key) && route != .conversation(key) {
            chatControllers[key] = nil
        }

        guard route != renderedRoute else { return }
        renderedRoute = route

        let nextVC: NSViewController
        switch route {
        case .newChat:
            nextVC = startVC
        case .posts:
            nextVC = postsVC
        case .calendar:
            nextVC = calendarVC
        case .media:
            nextVC = mediaVC
        case .conversation(let id):
            if let cached = chatControllers[id] {
                nextVC = cached
            } else {
                let created = ChatViewController(model: app.conversationModel(id))
                chatControllers[id] = created
                nextVC = created
            }
        }

        if let current = activeChild {
            current.view.removeFromSuperview()
            current.removeFromParent()
        }
        addChild(nextVC)
        nextVC.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(nextVC.view)
        NSLayoutConstraint.activate([
            nextVC.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            nextVC.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            nextVC.view.topAnchor.constraint(equalTo: view.topAnchor),
            nextVC.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        activeChild = nextVC
    }
}
