import AppKit
import StudioKit

/// One continuous title bar across the window, Claude Code style (pure AppKit, drawn in the
/// content under a transparent compact title bar, so the traffic lights sit in it):
/// - Over the sidebar: sidebar toggle, back / forward, the Sohbet | Postlar pill (glass)
/// - Over the content: the screen or conversation title with its ⌄ menu; on the right the tool
///   icons (Ayrıntılar, Arka plan işleri, Takvim, Medya, Marka, iPhone, …)
/// - Over the right panel (when open): its title and actions (temizle, genişlet, kapat),
///   after a vertical hairline.
/// The segments follow the split view's dividers; a hairline runs under the content and the
/// panel while the sidebar column continues up into the bar. Empty areas drag the window.
final class TopBarView: NSView {
    private unowned let app: AppModel
    private weak var split: MainSplitViewController?

    private let sidebarSegment = BarSegmentView()
    private let centerSegment = BarSegmentView()
    private let panelSegment = BarSegmentView()
    private let bottomHairline = BarSegmentView()
    private let sidebarDivider = BarSegmentView()
    private let panelDivider = BarSegmentView()

    private let cluster = NSStackView()
    let sidebarButton = BarIconButton(symbol: "sidebar.left", title: "Kenar çubuğu")
    let backButton = BarIconButton(symbol: "chevron.left", title: "Geri")
    let forwardButton = BarIconButton(symbol: "chevron.right", title: "İleri")
    let modePill = ModePillControl()

    let titleControl = TopBarTitleControl()
    private let toolsStack = NSStackView()
    /// The tool icons in order (tests).
    private(set) var toolButtons: [(tool: TopBarTool, button: BarIconButton)] = []
    private var titleLeadingConstraint: NSLayoutConstraint!
    private var clusterLeadingConstraint: NSLayoutConstraint!

    private let panelTitleLabel = NSTextField(labelWithString: "")
    private let panelActionsStack = NSStackView()
    /// The panel header shown now (tests).
    private(set) var panelHeader: PanelHeader?
    /// Segment geometry of the last layout pass (tests).
    private(set) var layoutState: TopBarLayout?

    private var observation: ObservationToken?
    private static let windowNotifications: [Notification.Name] = [
        NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification, NSWindow.didResizeNotification,
    ]

    init(app: AppModel, split: MainSplitViewController?) {
        self.app = app
        self.split = split
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.toolbar)
        setAccessibilityLabel("Üst çubuk")
        build()
        observation = observe { [weak self] in self?.sync() }
        if let splitView = split?.splitView {
            // Selector-based: removed automatically when the bar goes away.
            NotificationCenter.default.addObserver(self, selector: #selector(geometryChanged), name: NSSplitView.didResizeSubviewsNotification, object: splitView)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func geometryChanged(_ notification: Notification) {
        needsLayout = true
    }

    // MARK: Building

    private func build() {
        sidebarSegment.backgroundColor = Theme.sidebarBackground
        centerSegment.backgroundColor = Theme.canvas
        panelSegment.backgroundColor = Theme.canvas
        for line in [bottomHairline, sidebarDivider, panelDivider] { line.backgroundColor = Theme.hairline }
        for view in [sidebarSegment, centerSegment, panelSegment] { addSubview(view) }

        // Leading cluster: ▤ ‹ › [💬|▦]
        sidebarButton.onPress = { [weak app] _ in app?.toggleSidebar() }
        backButton.onPress = { [weak app] _ in app?.goBack() }
        backButton.toolTip = "Geri (⌘[)"
        forwardButton.onPress = { [weak app] _ in app?.goForward() }
        forwardButton.toolTip = "İleri (⌘])"
        modePill.onSelect = { [weak app] mode in app?.switchMode(mode) }
        cluster.orientation = .horizontal
        cluster.alignment = .centerY
        cluster.spacing = 0
        for view in [sidebarButton, backButton, forwardButton, modePill] as [NSView] { cluster.addArrangedSubview(view) }
        cluster.setCustomSpacing(TopBarMetrics.pillGap, after: forwardButton)
        cluster.translatesAutoresizingMaskIntoConstraints = false
        addSubview(cluster)
        clusterLeadingConstraint = cluster.leadingAnchor.constraint(equalTo: leadingAnchor, constant: TopBarMetrics.defaultZoomMaxX + TopBarMetrics.afterTrafficLights)
        NSLayoutConstraint.activate([
            clusterLeadingConstraint,
            cluster.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        // Centre: title ⌄ … tools
        titleControl.buildMenu = { [weak self] in
            guard let self else { return NSMenu() }
            return TopBarMenus.titleMenu(app: self.app) { [weak self] in self?.window }
        }
        toolsStack.orientation = .horizontal
        toolsStack.alignment = .centerY
        toolsStack.spacing = 4
        toolsStack.translatesAutoresizingMaskIntoConstraints = false
        toolButtons = TopBarTool.allCases.map { tool in
            let button = BarIconButton(symbol: tool.symbol, title: tool.title)
            button.toolTip = tool.help
            button.firesOnMouseDown = tool.action == .moreMenu
            button.onPress = { [weak self] sender in self?.perform(tool, from: sender) }
            toolsStack.addArrangedSubview(button)
            return (tool, button)
        }
        centerSegment.addSubview(titleControl)
        centerSegment.addSubview(toolsStack)
        titleLeadingConstraint = titleControl.leadingAnchor.constraint(equalTo: centerSegment.leadingAnchor, constant: TopBarLayout.titleGap)
        // Breakable: the segments are sized by the bar's layout pass and start at zero width.
        let titleBeforeTools = titleControl.trailingAnchor.constraint(lessThanOrEqualTo: toolsStack.leadingAnchor, constant: -8)
        titleBeforeTools.priority = NSLayoutConstraint.Priority(999)
        NSLayoutConstraint.activate([
            titleLeadingConstraint,
            titleControl.centerYAnchor.constraint(equalTo: centerSegment.centerYAnchor),
            titleBeforeTools,
            toolsStack.trailingAnchor.constraint(equalTo: centerSegment.trailingAnchor, constant: -10),
            toolsStack.centerYAnchor.constraint(equalTo: centerSegment.centerYAnchor),
        ])

        // Right panel header: title … 🗑 ⤢ ✕
        panelTitleLabel.font = Theme.TopBar.titleFont
        panelTitleLabel.textColor = Theme.textPrimary
        panelTitleLabel.lineBreakMode = .byTruncatingTail
        panelTitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        panelTitleLabel.translatesAutoresizingMaskIntoConstraints = false
        panelActionsStack.orientation = .horizontal
        panelActionsStack.alignment = .centerY
        panelActionsStack.spacing = 4
        panelActionsStack.translatesAutoresizingMaskIntoConstraints = false
        panelSegment.addSubview(panelTitleLabel)
        panelSegment.addSubview(panelActionsStack)
        let panelTitleBeforeActions = panelTitleLabel.trailingAnchor.constraint(lessThanOrEqualTo: panelActionsStack.leadingAnchor, constant: -8)
        panelTitleBeforeActions.priority = NSLayoutConstraint.Priority(999)
        NSLayoutConstraint.activate([
            panelTitleLabel.leadingAnchor.constraint(equalTo: panelSegment.leadingAnchor, constant: 13),
            panelTitleLabel.centerYAnchor.constraint(equalTo: panelSegment.centerYAnchor),
            panelTitleBeforeActions,
            panelActionsStack.trailingAnchor.constraint(equalTo: panelSegment.trailingAnchor, constant: -8),
            panelActionsStack.centerYAnchor.constraint(equalTo: panelSegment.centerYAnchor),
        ])

        for line in [bottomHairline, sidebarDivider, panelDivider] { addSubview(line) }
    }

    // MARK: State

    private func sync() {
        backButton.isEnabled = app.canGoBack
        forwardButton.isEnabled = app.canGoForward
        sidebarButton.toolTip = app.sidebarPresented ? "Kenar çubuğunu gizle (⌃⌘S)" : "Kenar çubuğunu göster (⌃⌘S)"
        modePill.selected = app.mode
        titleControl.titleText = app.title
        if case .conversation(let id) = app.route {
            titleControl.onRename = { [weak app] title in
                guard let app else { return }
                Task { await app.renameConversation(id, to: title) }
            }
        } else {
            titleControl.onRename = nil
        }
        window?.title = app.title

        let presented = app.inspectorPresented
        let pane = app.inspectorPane
        for (tool, button) in toolButtons {
            button.isActive = tool.isActive(panelPresented: presented, pane: pane)
        }

        let header = PanelHeader.make(pane: pane, expanded: app.inspectorExpanded, finishedCount: app.panelJobs().finished.count)
        if header != panelHeader {
            panelHeader = header
            panelTitleLabel.stringValue = header.title
            panelActionsStack.arrangedSubviews.forEach {
                panelActionsStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            for action in header.actions {
                let button = BarIconButton(symbol: action.symbol, title: action.help, pointSize: 13)
                button.toolTip = action.help
                button.isEnabled = action != .clearFinished || header.clearEnabled
                button.onPress = { [weak self] _ in self?.perform(action) }
                panelActionsStack.addArrangedSubview(button)
            }
        }
        _ = app.sidebarPresented
        needsLayout = true
    }

    // MARK: Actions

    func perform(_ tool: TopBarTool, from anchor: NSView? = nil) {
        switch tool.action {
        case .togglePanel(let pane):
            app.togglePanel(pane)
        case .moreMenu:
            guard let anchor else { return }
            TopBarMenus.moreMenu(app: app).popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: anchor)
        }
    }

    func perform(_ action: PanelHeader.Action) {
        switch action {
        case .clearFinished: app.clearFinishedJobs()
        case .refresh:
            Task { [app] in await app.calendar.load() }
        case .upload:
            app.media.pickAndUploadFiles()
        case .brandSettings:
            if let brandId = app.currentBrandId { app.openBrandSettings(brandId) } else { app.newBrandPresented = true }
        case .expand, .collapse: app.toggleInspectorExpanded()
        case .close: app.closePanel()
        }
    }

    // MARK: Layout

    /// Right edge of the traffic lights (+ a gap), in bar coordinates.
    private var leadingInset: CGFloat {
        guard let window else { return TopBarMetrics.defaultZoomMaxX + TopBarMetrics.afterTrafficLights }
        if window.styleMask.contains(.fullScreen) { return TopBarMetrics.bareInset }
        guard let zoom = window.standardWindowButton(.zoomButton), zoom.window === window, !zoom.isHidden, let holder = zoom.superview else {
            return TopBarMetrics.bareInset
        }
        let inWindow = holder.convert(zoom.frame, to: nil)
        return convert(inWindow, from: nil).maxX + TopBarMetrics.afterTrafficLights
    }

    /// Sidebar right edge and panel left edge from the split view (nil: collapsed).
    private func dividerPositions() -> (sidebarMaxX: CGFloat?, panelMinX: CGFloat?) {
        guard let split, split.isViewLoaded else { return (nil, nil) }
        func frame(_ item: NSSplitViewItem) -> NSRect? {
            let view = item.viewController.view
            guard !item.isCollapsed, view.superview != nil, !view.isHidden, view.frame.width > 1 else { return nil }
            return convert(view.bounds, from: view)
        }
        return (frame(split.sidebarItem)?.maxX, frame(split.inspectorItem)?.minX)
    }

    override func layout() {
        super.layout()
        let positions = dividerPositions()
        let clusterSize = cluster.fittingSize
        let state = TopBarLayout(
            width: bounds.width,
            sidebarMaxX: positions.sidebarMaxX,
            panelMinX: positions.panelMinX,
            leadingInset: leadingInset,
            clusterWidth: clusterSize.width
        )
        layoutState = state
        let height = bounds.height
        let divider = split?.splitView.dividerThickness ?? 1

        sidebarSegment.isHidden = state.sidebarMaxX == nil
        sidebarSegment.frame = NSRect(x: 0, y: 0, width: state.sidebarFrameWidth, height: height)
        centerSegment.frame = NSRect(x: state.centerMinX, y: 0, width: state.centerMaxX - state.centerMinX, height: height)
        panelSegment.isHidden = state.panelMinX == nil
        panelSegment.frame = NSRect(x: state.panelMinX ?? bounds.width, y: 0, width: state.panelWidth, height: height)

        bottomHairline.frame = NSRect(x: state.centerMinX, y: 0, width: max(0, bounds.width - state.centerMinX), height: 1)
        sidebarDivider.isHidden = state.sidebarMaxX == nil
        sidebarDivider.frame = NSRect(x: state.sidebarMaxX ?? 0, y: 0, width: divider, height: height)
        panelDivider.isHidden = state.panelMinX == nil
        panelDivider.frame = NSRect(x: (state.panelMinX ?? 0) - divider, y: 0, width: divider, height: height)

        if clusterLeadingConstraint.constant != state.leadingInset {
            clusterLeadingConstraint.constant = state.leadingInset
        }
        if titleLeadingConstraint.constant != state.titleLeading {
            titleLeadingConstraint.constant = state.titleLeading
        }
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        for name in Self.windowNotifications {
            NotificationCenter.default.removeObserver(self, name: name, object: nil)
        }
        guard let newWindow else { return }
        for name in Self.windowNotifications {
            NotificationCenter.default.addObserver(self, selector: #selector(geometryChanged), name: name, object: newWindow)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.title = app.title
        needsLayout = true
    }

    // MARK: Window dragging

    /// Labels and backgrounds belong to the bar (so they drag the window); controls keep their clicks.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        var view: NSView? = hit
        while let current = view, current !== self {
            if current is TopBarInteractive { return current }
            view = current.superview
        }
        return self
    }

    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
            return
        }
        window.performDrag(with: event)
    }
}

/// Views of the bar that take their own clicks (everything else drags the window).
protocol TopBarInteractive: NSView {}

/// A bar background / hairline that never moves the window by itself (the bar does).
final class BarSegmentView: ThemedView {
    override var mouseDownCanMoveWindow: Bool { false }
    /// Full radius: every control in the bar is a capsule.
    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }
}

// MARK: - BarIconButton

/// 28 pt square icon button of the top bar: monochrome SF Symbol, rounded hover fill, and a
/// steady fill while its pane or screen is open (Claude Code's top bar icons).
final class BarIconButton: NSControl, TopBarInteractive {
    var symbolName: String { didSet { updateImage() } }
    /// Its pane / screen is open.
    var isActive = false {
        didSet {
            guard isActive != oldValue else { return }
            refreshStyle()
            setAccessibilityValue(isActive ? "açık" : nil)
        }
    }
    /// Menus open on mouse down (like a pop-up button); actions fire on mouse up inside.
    var firesOnMouseDown = false
    var onPress: ((BarIconButton) -> Void)?

    private let pointSize: CGFloat
    private let imageView = NSImageView()
    private var hovering = false { didSet { refreshStyle() } }
    private var pressed = false { didSet { refreshStyle() } }
    private var trackingArea: NSTrackingArea?

    override var isEnabled: Bool {
        didSet { refreshStyle() }
    }

    init(symbol: String, title: String, pointSize: CGFloat = TopBarMetrics.iconPointSize) {
        self.symbolName = symbol
        self.pointSize = pointSize
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerCurve = .continuous
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)

        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: TopBarMetrics.buttonSize),
            heightAnchor.constraint(equalToConstant: TopBarMetrics.buttonSize),
            imageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        updateImage()
        refreshStyle()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var mouseDownCanMoveWindow: Bool { false }
    /// Full radius: every control in the bar is a capsule.
    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }

    private func updateImage() {
        imageView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: pointSize, weight: .regular))
    }

    private func refreshStyle() {
        let fill: NSColor? = if isActive {
            Theme.barButtonActive
        } else if isEnabled && (hovering || pressed) {
            Theme.barButtonHover
        } else {
            nil
        }
        layer?.backgroundColor = fill.map { resolvedCGColor($0) }
        imageView.contentTintColor = isActive ? Theme.textPrimary : Theme.textSecondary
        alphaValue = isEnabled ? 1 : 0.35
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshStyle()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false; pressed = false }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        if firesOnMouseDown {
            fire()
            return
        }
        pressed = true
        window?.trackEvents(matching: [.leftMouseDragged, .leftMouseUp], timeout: NSEvent.foreverDuration, mode: .eventTracking) { [weak self] next, stop in
            guard let self, let next else { stop.pointee = true; return }
            let inside = self.bounds.contains(self.convert(next.locationInWindow, from: nil))
            self.pressed = inside
            if next.type == .leftMouseUp {
                self.pressed = false
                stop.pointee = true
                if inside { self.fire() }
            }
        }
    }

    /// Presses the button (VoiceOver, keyboard, tests).
    func fire() {
        guard isEnabled else { return }
        onPress?(self)
    }

    override var acceptsFirstResponder: Bool { KeyboardFocus.accepts(isEnabled: isEnabled) }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
    override func keyDown(with event: NSEvent) {
        if isEnabled, KeyboardFocus.isActivation(event) { fire() } else { super.keyDown(with: event) }
    }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        fire()
        return true
    }
}

// MARK: - ModePillControl

/// Sohbet | Postlar: a small glass pill with two icon segments, the selected one filled
/// (Claude Code's Chat | Code switch).
final class ModePillControl: NSView, TopBarInteractive {
    var selected: AppMode? {
        didSet {
            guard selected != oldValue else { return }
            for segment in segments { segment.isSelected = segment.mode == selected }
        }
    }
    var onSelect: ((AppMode) -> Void)?

    private let glass = GlassContainerView(cornerRadius: 14, interactive: true, tint: Theme.modePillTrack)
    private(set) var segments: [ModePillSegment] = []

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.radioGroup)
        setAccessibilityLabel("Mod")
        addSubview(glass)

        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 0
        row.translatesAutoresizingMaskIntoConstraints = false
        segments = AppMode.allCases.map { mode in
            let segment = ModePillSegment(mode: mode)
            segment.onPress = { [weak self] in self?.onSelect?(mode) }
            row.addArrangedSubview(segment)
            return segment
        }
        glass.contentContainer.addSubview(row)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: TopBarMetrics.pillWidth),
            heightAnchor.constraint(equalToConstant: TopBarMetrics.pillHeight),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.centerXAnchor.constraint(equalTo: glass.contentContainer.centerXAnchor),
            row.centerYAnchor.constraint(equalTo: glass.contentContainer.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var mouseDownCanMoveWindow: Bool { false }
    /// Full radius: every control in the bar is a capsule.
    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }
    /// The border between the segments does nothing (and does not drag the window).
    override func mouseDown(with event: NSEvent) {}
}

final class ModePillSegment: NSControl, TopBarInteractive {
    let mode: AppMode
    var isSelected = false {
        didSet {
            refreshStyle()
            setAccessibilityValue(isSelected ? 1 : 0)
        }
    }
    var onPress: (() -> Void)?

    private let imageView = NSImageView()
    private var hovering = false { didSet { refreshStyle() } }
    private var trackingArea: NSTrackingArea?

    init(mode: AppMode) {
        self.mode = mode
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerCurve = .continuous
        toolTip = mode.help
        setAccessibilityElement(true)
        setAccessibilityRole(.radioButton)
        setAccessibilityLabel(mode.title)

        imageView.image = NSImage(systemSymbolName: mode.symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: (TopBarMetrics.pillWidth - 6) / 2),
            heightAnchor.constraint(equalToConstant: TopBarMetrics.pillHeight - 6),
            imageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        refreshStyle()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var mouseDownCanMoveWindow: Bool { false }
    /// Full radius: every control in the bar is a capsule.
    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }

    private func refreshStyle() {
        let fill: NSColor? = isSelected ? Theme.modePillSelection : (hovering ? Theme.barButtonHover : nil)
        layer?.backgroundColor = fill.map { resolvedCGColor($0) }
        imageView.contentTintColor = isSelected ? Theme.textPrimary : Theme.textSecondary
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshStyle()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { onPress?() }

    override var acceptsFirstResponder: Bool { KeyboardFocus.accepts(isEnabled: isEnabled) }
    override func keyDown(with event: NSEvent) {
        if KeyboardFocus.isActivation(event) { onPress?() } else { super.keyDown(with: event) }
    }
    override func accessibilityPerformPress() -> Bool {
        onPress?()
        return true
    }
}

// MARK: - TopBarTitleControl

/// "Kasım planı ⌄": the conversation or screen title; the chevron menu holds the conversation's
/// actions (rename, archive) or the screen's brand and month.
final class TopBarTitleControl: NSControl, TopBarInteractive {
    var titleText = "" {
        didSet {
            guard titleText != oldValue else { return }
            label.stringValue = titleText
            setAccessibilityLabel("\(titleText): seçenekler")
            invalidateIntrinsicContentSize()
        }
    }
    var buildMenu: (() -> NSMenu)?
    /// Set for a conversation: double-clicking the title renames it in place (Claude Code).
    var onRename: ((String) -> Void)?
    var canRenameInline: Bool { onRename != nil && window != nil }

    private let label = NSTextField(labelWithString: "")
    private let chevron = NSImageView()
    private var editor: NSTextField?
    private var hovering = false { didSet { refreshStyle() } }
    private var trackingArea: NSTrackingArea?

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerCurve = .continuous
        toolTip = "Sohbet, marka ve ekran seçenekleri"
        setAccessibilityElement(true)
        setAccessibilityRole(.popUpButton)

        label.font = Theme.TopBar.titleFont
        label.textColor = Theme.textPrimary
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        chevron.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
        chevron.contentTintColor = Theme.textSecondary
        chevron.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = NSStackView(views: [label, chevron])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: TopBarMetrics.buttonSize),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Plain title (tests).
    var labelText: String { label.stringValue }

    override var mouseDownCanMoveWindow: Bool { false }
    /// Full radius: every control in the bar is a capsule.
    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }

    private func refreshStyle() {
        layer?.backgroundColor = hovering ? resolvedCGColor(Theme.barButtonHover) : nil
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshStyle()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    /// The chevron (or anywhere when the title can't be renamed) opens the menu; on the title,
    /// a double-click renames and a single click does nothing (Claude Code).
    override func mouseDown(with event: NSEvent) {
        guard editor == nil else { return }
        let point = convert(event.locationInWindow, from: nil)
        let onChevron = point.x >= chevron.frame.minX - 6
        if onRename != nil, !onChevron {
            if event.clickCount >= 2 { beginRename() }
            return
        }
        showMenu()
    }

    private func showMenu() {
        guard let menu = buildMenu?() else { return }
        // Opens under the title, aligned with its left edge, like Claude Code.
        menu.popUp(positioning: nil, at: NSPoint(x: label.frame.minX - 4, y: isFlipped ? bounds.maxY + 4 : -4), in: self)
        hovering = false
    }

    /// The title becomes a text field: Return saves, Esc or clicking away cancels.
    func beginRename() {
        guard editor == nil, onRename != nil else { return }
        let field = InlineRenameField(string: titleText)
        field.font = label.font
        field.textColor = Theme.textPrimary
        field.isBordered = false
        field.drawsBackground = true
        field.backgroundColor = Theme.fill
        field.focusRingType = .none
        field.wantsLayer = true
        field.layer?.cornerRadius = 5
        field.translatesAutoresizingMaskIntoConstraints = false
        field.onFinish = { [weak self] commit in self?.endRename(commit: commit) }
        addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: label.leadingAnchor, constant: -3),
            field.centerYAnchor.constraint(equalTo: centerYAnchor),
            field.widthAnchor.constraint(equalToConstant: max(label.frame.width + 60, 220)),
        ])
        label.isHidden = true
        chevron.isHidden = true
        editor = field
        window?.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)
    }

    private func endRename(commit: Bool) {
        guard let field = editor else { return }
        editor = nil
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        field.removeFromSuperview()
        label.isHidden = false
        chevron.isHidden = false
        if commit, !text.isEmpty, text != titleText {
            titleText = text
            onRename?(text)
        }
    }

    override func accessibilityPerformPress() -> Bool {
        showMenu()
        return true
    }

    override func accessibilityPerformShowMenu() -> Bool { accessibilityPerformPress() }
}

/// The title's in-place editor: Return commits, Esc cancels, losing focus commits.
final class InlineRenameField: NSTextField, NSTextFieldDelegate {
    var onFinish: ((Bool) -> Void)?
    private var finished = false

    convenience init(string: String) {
        self.init(frame: .zero)
        stringValue = string
        delegate = self
        cell?.isScrollable = true
        cell?.wraps = false
    }

    private func finish(_ commit: Bool) {
        guard !finished else { return }
        finished = true
        onFinish?(commit)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) { finish(true); return true }
        if selector == #selector(NSResponder.cancelOperation(_:)) { finish(false); return true }
        return false
    }

    func controlTextDidEndEditing(_ obj: Notification) { finish(true) }
}

extension NSView {
    /// First descendant of a type (depth first).
    func firstDescendant<T: NSView>(of type: T.Type) -> T? {
        for sub in subviews {
            if let match = sub as? T { return match }
            if let match = sub.firstDescendant(of: type) { return match }
        }
        return nil
    }
}
