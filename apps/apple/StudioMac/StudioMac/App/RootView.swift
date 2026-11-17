import AppKit
import StudioKit

// MARK: - MainWindowController

/// The main window, Claude Code style: no visible title, a transparent compact title bar (an
/// empty `.unifiedCompact` toolbar only sizes it, so the traffic lights sit centred in a
/// `Theme.topBarHeight` bar) and the content running underneath. `TopBarView` draws the bar.
final class MainWindowController: NSWindowController {
    let app: AppModel
    let settings: AppSettings
    let host: LocalHost?
    let rootViewController: RootViewController

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

    /// The title bar's height (the top bar matches it).
    static func titlebarHeight(of window: NSWindow) -> CGFloat {
        window.frame.height - window.contentLayoutRect.height
    }

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
        Self.applyChrome(to: window)
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
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Transparent title bar over the content, no separator, an empty compact toolbar.
    static func applyChrome(to window: NSWindow) {
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        let toolbar = NSToolbar(identifier: "studio.main.toolbar")
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        window.toolbarStyle = .unifiedCompact
    }
}

// MARK: - RootViewController & MainSplitViewController & DetailContainerViewController

final class RootViewController: NSViewController {
    let app: AppModel
    let settings: AppSettings
    let host: LocalHost?
    let splitController: MainSplitViewController

    /// The window's one title bar (Claude Code): navigation, title, tools, the panel's header.
    private(set) var topBar: TopBarView!
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

        topBar = TopBarView(app: app, split: splitController)
        root.addSubview(topBar)

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

            topBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: root.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: Theme.topBarHeight),

            searchOverlay.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            searchOverlay.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            searchOverlay.topAnchor.constraint(equalTo: root.topAnchor),
            searchOverlay.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            settingsBackdrop.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            settingsBackdrop.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            settingsBackdrop.topAnchor.constraint(equalTo: root.topAnchor),
            settingsBackdrop.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            bannerStack.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            bannerStack.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 8),
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
                view.addSubview(overlay, positioned: .below, relativeTo: topBar)
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

/// Hairline dividers in Studio's own colour (the top bar continues them up).
final class StudioSplitView: NSSplitView {
    override var dividerColor: NSColor { Theme.hairline }
}

/// Three columns, Claude Code style: a flush sidebar (its own background, full height under the
/// title bar), the content, and the toggleable right panel. Collapsed states follow (and are
/// saved through) `AppModel.sidebarPresented` / `inspectorPresented`; the panel's "expand"
/// follows `AppModel.inspectorExpanded`.
final class MainSplitViewController: NSSplitViewController {
    private unowned let app: AppModel
    let sidebarItem: NSSplitViewItem
    let contentItem: NSSplitViewItem
    let inspectorItem: NSSplitViewItem

    /// Normal and expanded right panel: the most it can be dragged to.
    static let inspectorMaximum: CGFloat = 440
    static let inspectorExpandedMaximum: CGFloat = 720

    private var observation: ObservationToken?
    private var kvoTokens: [NSKeyValueObservation] = []
    private var appliedInitialWidths = false
    private var appliedExpanded = false

    init(app: AppModel, settings: AppSettings) {
        self.app = app
        let sidebarVC = SidebarViewController(app: app, settings: settings)
        let detailVC = DetailContainerViewController(app: app)
        let inspectorVC = InfoPanelViewController(app: app)

        // A plain item, not `sidebarWithViewController`: the sidebar sits flush against the
        // window edge with its own calm background instead of a floating glass panel.
        sidebarItem = NSSplitViewItem(viewController: sidebarVC)
        sidebarItem.minimumThickness = 220
        sidebarItem.maximumThickness = 340
        sidebarItem.canCollapse = true
        sidebarItem.holdingPriority = NSLayoutConstraint.Priority(260)
        sidebarItem.allowsFullHeightLayout = true
        sidebarItem.titlebarSeparatorStyle = .none
        sidebarItem.isCollapsed = !app.sidebarPresented

        contentItem = NSSplitViewItem(viewController: detailVC)
        contentItem.minimumThickness = 420
        contentItem.titlebarSeparatorStyle = .none
        if #available(macOS 26.0, *) {
            contentItem.automaticallyAdjustsSafeAreaInsets = true
        }

        // A plain item too: `inspectorWithViewController` wraps the panel in a floating Liquid
        // Glass container; Claude Code's right panel is flat and flush like the sidebar.
        inspectorItem = NSSplitViewItem(viewController: inspectorVC)
        inspectorItem.minimumThickness = 260
        inspectorItem.maximumThickness = Self.inspectorMaximum
        inspectorItem.canCollapse = true
        inspectorItem.holdingPriority = NSLayoutConstraint.Priority(260)
        inspectorItem.allowsFullHeightLayout = true
        inspectorItem.titlebarSeparatorStyle = .none
        inspectorItem.isCollapsed = !app.inspectorPresented

        super.init(nibName: nil, bundle: nil)
        let split = StudioSplitView()
        split.isVertical = true
        split.dividerStyle = .thin
        splitView = split
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        splitView.dividerStyle = .thin
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
            let expanded = self.app.inspectorExpanded
            if expanded != self.appliedExpanded {
                self.appliedExpanded = expanded
                self.applyInspectorWidth()
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

    override func viewDidAppear() {
        super.viewDidAppear()
        applyInitialWidths()
    }

    /// First appearance: the sidebar at `Theme.sidebarWidth`, the right panel at `Theme.inspectorWidth`.
    private func applyInitialWidths() {
        guard !appliedInitialWidths, splitView.bounds.width > 0 else { return }
        appliedInitialWidths = true
        if !sidebarItem.isCollapsed {
            splitView.setPosition(Theme.sidebarWidth, ofDividerAt: 0)
        }
        if !inspectorItem.isCollapsed {
            splitView.setPosition(splitView.bounds.width - Theme.inspectorWidth - splitView.dividerThickness, ofDividerAt: 1)
        }
    }

    /// The panel's header "expand": wider, or back to `Theme.inspectorWidth`.
    private func applyInspectorWidth() {
        let expanded = app.inspectorExpanded
        inspectorItem.maximumThickness = expanded ? Self.inspectorExpandedMaximum : Self.inspectorMaximum
        guard !inspectorItem.isCollapsed, splitView.bounds.width > 0 else { return }
        let target = expanded ? Theme.inspectorExpandedWidth : Theme.inspectorWidth
        splitView.setPosition(splitView.bounds.width - target - splitView.dividerThickness, ofDividerAt: 1)
    }

    /// Width of the right panel as laid out now (0 when closed; tests).
    var inspectorWidth: CGFloat {
        inspectorItem.isCollapsed ? 0 : inspectorItem.viewController.view.frame.width
    }

    override func toggleSidebar(_ sender: Any?) {
        app.toggleSidebar()
    }

    override func toggleInspector(_ sender: Any?) {
        app.toggleInspector()
    }

    /// The sidebar is a plain item, so the split view controller would not enable
    /// "toggle sidebar" by itself; Studio handles it through the app model.
    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(toggleSidebar(_:)) || item.action == #selector(toggleInspector(_:)) { return true }
        return super.validateUserInterfaceItem(item)
    }
}

final class DetailContainerViewController: NSViewController {
    private unowned let app: AppModel
    private lazy var startVC = StartViewController(app: app)
    private lazy var postsVC = PostsViewController(app: app)
    private lazy var calendarVC = CalendarViewController(app: app)
    private lazy var mediaVC = MediaViewController(app: app)
    private var chatControllers: [EntityID: ChatViewController] = [:]
    /// The screen shown now (tests).
    private(set) weak var activeChild: NSViewController?
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
        // Drop cached chat view controllers whose models were cleared (e.g. reconnect). The one on
        // screen is rebuilt too: it would stay bound to a stopped model and never update again.
        let validIds = Set(app.conversationModels.keys)
        for key in Array(chatControllers.keys) where !validIds.contains(key) {
            chatControllers[key] = nil
            if route == .conversation(key) { renderedRoute = nil }
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
