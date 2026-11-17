import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// The Claude Code title bar: tools → actions, the panel header, segment geometry, the mode
/// pill, the window chrome it relies on, and the composer's send / stop and status line.
/// Window-free except the chrome test (an offscreen window that is never shown).
@MainActor
private func makeApp(defaults: UserDefaults? = nil) async -> (AppModel, UserDefaults) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = defaults ?? UserDefaults(suiteName: "studio.tests.topbar.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return (app, defaults)
}

@MainActor
private func settle() async {
    for _ in 0..<6 { try? await Task.sleep(for: .milliseconds(15)) }
}

@MainActor
private func all<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
    view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + all(type, in: $0) }
}

@MainActor
private func ambiguous(in view: NSView) -> [NSView] {
    (view.hasAmbiguousLayout ? [view] : []) + view.subviews.flatMap { ambiguous(in: $0) }
}

/// The split view and the bar over it, as `RootViewController` stacks them (no window).
@MainActor
private func makeChrome(_ app: AppModel, width: CGFloat = 1440) -> (NSView, MainSplitViewController, TopBarView) {
    let root = NSView(frame: CGRect(x: 0, y: 0, width: width, height: 900))
    let split = MainSplitViewController(app: app, settings: app.settings)
    split.view.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(split.view)
    let bar = TopBarView(app: app, split: split)
    root.addSubview(bar)
    NSLayoutConstraint.activate([
        split.view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
        split.view.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        split.view.topAnchor.constraint(equalTo: root.topAnchor),
        split.view.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
        bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        bar.topAnchor.constraint(equalTo: root.topAnchor),
        bar.heightAnchor.constraint(equalToConstant: Theme.topBarHeight),
    ])
    root.layoutSubtreeIfNeeded()
    split.splitView.setPosition(Theme.sidebarWidth, ofDividerAt: 0)
    split.splitView.setPosition(width - Theme.inspectorWidth - split.splitView.dividerThickness, ofDividerAt: 1)
    root.layoutSubtreeIfNeeded()
    bar.layoutSubtreeIfNeeded()
    return (root, split, bar)
}

// MARK: - Pure content

@Suite("Top bar: tools, panel header and geometry")
@MainActor
struct TopBarContentTests {
    @Test func everyToolSwitchesTheRightPanelOnly() {
        #expect(TopBarTool.allCases.map(\.symbol) == ["list.bullet", "clock.arrow.circlepath", "calendar", "photo.on.rectangle", "tag", "iphone", "ellipsis"])
        #expect(TopBarTool.allCases.map(\.action) == [
            .togglePanel(.details), .togglePanel(.jobs), .togglePanel(.calendar), .togglePanel(.media), .togglePanel(.brand), .togglePanel(.phone), .moreMenu,
        ], "no icon navigates the centre")
        #expect(TopBarTool.allCases.compactMap(\.pane) == RightPanelPane.allCases, "one icon per pane, in order")
        #expect(TopBarTool.allCases.map(\.title) == ["Ayrıntılar", "Arka plan işleri", "Takvim", "Medya", "Marka", "iPhone", "Diğer seçenekler"])
        #expect(TopBarTool.allCases.allSatisfy { !$0.help.isEmpty && !$0.title.isEmpty })
        for symbol in TopBarTool.allCases.map(\.symbol) + AppMode.allCases.map(\.symbol) + Platform.allCases.map(\.panelSymbol) {
            #expect(NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil, "SF Symbol \(symbol)")
        }

        // Only the open pane's icon gets the rounded fill.
        for tool in TopBarTool.allCases {
            for pane in RightPanelPane.allCases {
                #expect(tool.isActive(panelPresented: true, pane: pane) == (tool.pane == pane), "\(tool) on \(pane)")
                #expect(!tool.isActive(panelPresented: false, pane: pane), "closed panel: nothing highlighted")
            }
        }
    }

    @Test func panelHeaderTitlesAndActions() {
        let details = PanelHeader.make(pane: .details, expanded: false, finishedCount: 4)
        #expect(details.title == "Ayrıntılar")
        #expect(details.actions == [.expand, .close])
        let jobs = PanelHeader.make(pane: .jobs, expanded: true, finishedCount: 0)
        #expect(jobs.title == "Arka plan işleri")
        #expect(jobs.actions == [.clearFinished, .collapse, .close])
        #expect(!jobs.clearEnabled, "nothing to clear")
        #expect(PanelHeader.make(pane: .jobs, expanded: false, finishedCount: 2).clearEnabled)
        #expect(PanelHeader.make(pane: .calendar, expanded: false, finishedCount: 0) == PanelHeader(title: "Takvim", actions: [.refresh, .expand, .close], clearEnabled: false))
        #expect(PanelHeader.make(pane: .media, expanded: false, finishedCount: 0).actions == [.upload, .expand, .close])
        #expect(PanelHeader.make(pane: .brand, expanded: true, finishedCount: 0) == PanelHeader(title: "Marka", actions: [.brandSettings, .collapse, .close], clearEnabled: false))
        #expect(PanelHeader.make(pane: .phone, expanded: false, finishedCount: 0) == PanelHeader(title: "iPhone", actions: [.expand, .close], clearEnabled: false))
        #expect(RightPanelPane.allCases.allSatisfy { PanelHeader.make(pane: $0, expanded: false, finishedCount: 0).actions.last == .close }, "every pane closes from its header")
        let actions: [PanelHeader.Action] = [.clearFinished, .refresh, .upload, .brandSettings, .expand, .collapse, .close]
        #expect(actions.map(\.symbol) == [
            "trash", "arrow.clockwise", "plus", "gearshape", "arrow.up.left.and.arrow.down.right", "arrow.down.right.and.arrow.up.left", "xmark",
        ])
        for action in actions {
            #expect(NSImage(systemSymbolName: action.symbol, accessibilityDescription: nil) != nil)
            #expect(!action.help.isEmpty)
        }
    }

    @Test func segmentsFollowTheDividers() {
        // Both panels open: the title starts just right of the sidebar edge (Claude Code: ~20 pt).
        let open = TopBarLayout(width: 1424, sidebarMaxX: 265, panelMinX: 1068, leadingInset: 73, clusterWidth: 174)
        #expect(open.centerMinX == 265)
        #expect(open.centerMaxX == 1068)
        #expect(open.titleLeading == TopBarLayout.titleGap)
        #expect(open.panelWidth == 356)
        // Sidebar hidden: the title moves after the cluster instead of under it.
        let bare = TopBarLayout(width: 1424, sidebarMaxX: nil, panelMinX: nil, leadingInset: 73, clusterWidth: 174)
        #expect(bare.centerMinX == 0)
        #expect(bare.centerMaxX == 1424)
        #expect(bare.titleLeading == 73 + 174 + TopBarLayout.clusterGap)
        #expect(bare.panelWidth == 0)
        // A narrow sidebar still keeps the title clear of the cluster.
        let narrow = TopBarLayout(width: 1000, sidebarMaxX: 220, panelMinX: nil, leadingInset: 73, clusterWidth: 174)
        #expect(narrow.centerMinX + narrow.titleLeading >= 73 + 174)
    }

    @Test func modePillFollowsTheRoute() {
        #expect(AppMode.of(.newChat) == .chat)
        #expect(AppMode.of(.conversation("c")) == .chat)
        #expect(AppMode.of(.posts) == .posts)
        #expect(AppMode.of(.calendar) == nil)
        #expect(AppMode.of(.media) == nil)
        #expect(AppMode.allCases.map(\.title) == ["Sohbet", "Postlar"])
    }

    @Test func composerSendAndStopStyles() {
        let running = ComposerActionStyle.make(running: true, busy: false, canSend: false)
        #expect(running.symbol == "stop.fill")
        #expect(running.enabled)
        let ready = ComposerActionStyle.make(running: false, busy: false, canSend: true)
        #expect(ready.symbol == "arrow.up.circle.fill")
        #expect(ready.enabled)
        #expect(ready.tint == Theme.accent, "send is the primary action: orange")
        let empty = ComposerActionStyle.make(running: false, busy: false, canSend: false)
        #expect(!empty.enabled)
        #expect(empty.tint == Theme.textTertiary)
        let sending = ComposerActionStyle.make(running: false, busy: true, canSend: true)
        #expect(sending.spinner)
        #expect(!sending.enabled)
    }
}

// MARK: - App model: modes, panes, jobs

@Suite("Top bar: navigation, modes and panes")
@MainActor
struct TopBarModelTests {
    @Test func backAndForwardWalkTheVisitedScreens() async throws {
        let (app, _) = await makeApp()
        #expect(!app.canGoBack && !app.canGoForward)
        app.navigate(to: .posts)
        app.navigate(to: .calendar)
        app.navigate(to: .conversation(SampleData.kasimConversation))
        app.goBack()
        app.goBack()
        #expect(app.route == .posts)
        #expect(app.canGoForward)
        app.goForward()
        #expect(app.route == .calendar)
        app.navigate(to: .media) // a new visit drops the forward history
        #expect(!app.canGoForward)
        app.goBack()
        #expect(app.route == .calendar)
        app.navigate(to: .calendar) // same screen: not a visit
        #expect(app.canGoForward)
    }

    @Test func sohbetReturnsToTheLastConversationAndPostlarOpensTheBoard() async throws {
        let (app, _) = await makeApp()
        #expect(app.mode == .chat)
        app.switchMode(.posts)
        #expect(app.route == .posts)
        #expect(app.mode == .posts)
        app.switchMode(.chat)
        #expect(app.route == .newChat, "no conversation yet: a new chat")

        app.navigate(to: .conversation(SampleData.hasatConversation))
        app.navigate(to: .calendar)
        #expect(app.mode == nil)
        app.switchMode(.chat)
        #expect(app.route == .conversation(SampleData.hasatConversation))
        app.switchMode(.chat) // already there
        #expect(app.route == .conversation(SampleData.hasatConversation))
    }

    @Test func toolIconsTogglePanesAndThePaneIsRemembered() async throws {
        let (app, defaults) = await makeApp()
        app.restoreSession()
        #expect(app.inspectorPresented && app.inspectorPane == .details)
        app.togglePanel(.details)
        #expect(!app.inspectorPresented, "the open pane's icon closes the panel")
        app.togglePanel(.jobs)
        #expect(app.inspectorPresented && app.inspectorPane == .jobs)
        app.togglePanel(.details)
        #expect(app.inspectorPresented && app.inspectorPane == .details, "another icon switches the pane")
        app.togglePanel(.jobs)
        app.toggleInspectorExpanded()
        #expect(app.inspectorExpanded)
        app.closePanel()
        #expect(!app.inspectorPresented)
        app.togglePanel(.jobs)

        let (next, _) = await makeApp(defaults: defaults)
        #expect(next.inspectorPresented)
        #expect(next.inspectorPane == .jobs, "the pane comes back next launch")
        #expect(SessionSnapshot(screen: .posts).pane == .details, "older snapshots open the details pane")
    }

    @Test func jobsPaneContentFiltersBrandWindowAndClearing() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func job(_ id: String, _ status: JobStatus, brand: EntityID?, endedMinutesAgo: Double? = nil) -> Job {
            Job(id: id, type: .contentGenerate, status: status, brandId: brand, createdAt: now.addingTimeInterval(-7200),
                updatedAt: now.addingTimeInterval(-(endedMinutesAgo ?? 0) * 60), finishedAt: endedMinutesAgo.map { now.addingTimeInterval(-$0 * 60) })
        }
        let jobs = [
            job("run", .running, brand: "a"),
            job("queue", .queued, brand: nil),
            job("other", .running, brand: "b"),
            job("done", .succeeded, brand: "a", endedMinutesAgo: 10),
            job("fail", .failed, brand: "a", endedMinutesAgo: 30),
            job("old", .succeeded, brand: "a", endedMinutesAgo: 60 * 30),
        ]
        let content = JobsPaneContent.make(jobs: jobs, brandId: "a", clearedAt: nil, now: now)
        #expect(content.running.map(\.id) == ["run"])
        #expect(content.queued.map(\.id) == ["queue"], "jobs without a brand show everywhere")
        #expect(content.finished.map(\.id) == ["done", "fail"], "older than a day drops out")
        #expect(content.activeCount == 2)
        let cleared = JobsPaneContent.make(jobs: jobs, brandId: "a", clearedAt: now.addingTimeInterval(-20 * 60), now: now)
        #expect(cleared.finished.map(\.id) == ["done"], "only what finished after the clear stays")
        #expect(JobsPaneContent.make(jobs: [], brandId: nil, clearedAt: nil, now: now).isEmpty)
        #expect(JobsPaneContent.statusText(.failed) == "hata")
    }
}

// MARK: - Views

@Suite("Top bar: views and window chrome")
@MainActor
struct TopBarViewTests {
    @Test func barLaysOutItsSegmentsOverTheSplitView() async throws {
        let (app, _) = await makeApp()
        app.navigate(to: .conversation(SampleData.kasimConversation))
        let (root, split, bar) = makeChrome(app)
        await settle()
        bar.layoutSubtreeIfNeeded()

        let state = try #require(bar.layoutState)
        let sidebarView = split.sidebarItem.viewController.view
        let panelView = split.inspectorItem.viewController.view
        let sidebarFrame = sidebarView.convert(sidebarView.bounds, to: bar)
        let panelFrame = panelView.convert(panelView.bounds, to: bar)
        #expect(state.sidebarMaxX == sidebarFrame.maxX)
        #expect(state.panelMinX == panelFrame.minX)
        #expect(!sequence(first: panelView, next: { $0.superview }).contains { $0 is NSGlassEffectView }, "flat panel, no floating glass")
        #expect(abs(state.panelWidth - Theme.inspectorWidth) <= 1)

        // Title right of the sidebar edge, tools at the content's right end, panel header over the panel.
        #expect(bar.titleControl.labelText == "Kasım planı")
        let titleFrame = bar.titleControl.convert(bar.titleControl.bounds, to: bar)
        #expect(titleFrame.minX == state.centerMinX + TopBarLayout.titleGap)
        let lastTool = try #require(bar.toolButtons.last?.button)
        let toolFrame = lastTool.convert(lastTool.bounds, to: bar)
        #expect(toolFrame.maxX <= panelFrame.minX - 8 && toolFrame.maxX >= panelFrame.minX - 14)
        #expect(bar.toolButtons.map(\.tool) == TopBarTool.allCases)
        #expect(bar.toolButtons.first { $0.tool == .details }?.button.isActive == true, "the open pane's icon is highlighted")
        #expect(bar.panelHeader?.title == "Ayrıntılar")
        let labels = all(NSTextField.self, in: bar).map(\.stringValue)
        #expect(labels.contains("Ayrıntılar"))

        // Everything is vertically centred in the bar (the traffic lights' line).
        for view in [bar.sidebarButton, bar.backButton, bar.modePill, bar.titleControl, lastTool] as [NSView] {
            let frame = view.convert(view.bounds, to: bar)
            #expect(abs(frame.midY - Theme.topBarHeight / 2) <= 0.5, "\(view) centred")
        }
        // The cluster sits after the traffic lights, inside the sidebar column.
        let toggleFrame = bar.sidebarButton.convert(bar.sidebarButton.bounds, to: bar)
        #expect(toggleFrame.minX == TopBarMetrics.defaultZoomMaxX + TopBarMetrics.afterTrafficLights)
        let pillFrame = bar.modePill.convert(bar.modePill.bounds, to: bar)
        #expect(pillFrame.maxX < state.centerMinX)
        #expect(pillFrame.width == TopBarMetrics.pillWidth && pillFrame.height == TopBarMetrics.pillHeight)
        #expect(bar.modePill.segments.map(\.isSelected) == [true, false])

        root.layoutSubtreeIfNeeded()
        #expect(ambiguous(in: bar).isEmpty, "ambiguous: \(ambiguous(in: bar))")
    }

    @Test func toolsAndHeaderActionsDriveTheModel() async throws {
        let (app, _) = await makeApp()
        let (_, _, bar) = makeChrome(app)
        func button(_ tool: TopBarTool) -> BarIconButton? { bar.toolButtons.first { $0.tool == tool }?.button }

        button(.jobs)?.fire()
        #expect(app.inspectorPresented && app.inspectorPane == .jobs)
        await settle()
        #expect(bar.panelHeader?.title == "Arka plan işleri")
        #expect(bar.panelHeader?.actions == [.clearFinished, .expand, .close])
        #expect(bar.panelHeader?.clearEnabled == true, "the sample has finished jobs")
        #expect(button(.jobs)?.isActive == true)
        #expect(button(.details)?.isActive == false)

        bar.perform(.expand)
        #expect(app.inspectorExpanded)
        bar.perform(.clearFinished)
        #expect(app.panelJobs().finished.isEmpty)
        await settle()
        #expect(bar.panelHeader?.clearEnabled == false)
        bar.perform(.close)
        #expect(!app.inspectorPresented)

        // Takvim, Medya, Marka, iPhone: the panel switches, the centre stays where it was.
        app.navigate(to: .conversation(SampleData.kasimConversation))
        for tool in [TopBarTool.calendar, .media, .brand, .phone] {
            button(tool)?.fire()
            #expect(app.inspectorPresented && app.inspectorPane == tool.pane, "\(tool) opens its pane")
            #expect(app.route == .conversation(SampleData.kasimConversation), "\(tool) leaves the conversation in the centre")
            await settle()
            #expect(button(tool)?.isActive == true)
            #expect(bar.toolButtons.filter { $0.button.isActive }.count == 1, "one highlighted icon")
            #expect(bar.panelHeader?.title == tool.pane?.title)
        }
        #expect(!app.settingsPresented, "the iPhone icon no longer opens Settings")
        #expect(app.brandSettingsTarget == nil, "the Marka icon no longer opens the brand sheet")
        button(.phone)?.fire()
        #expect(!app.inspectorPresented, "the selected icon closes the panel")
        await settle()
        #expect(bar.toolButtons.allSatisfy { !$0.button.isActive })

        // Header actions of the new panes.
        button(.brand)?.fire()
        bar.perform(.brandSettings)
        #expect(app.brandSettingsTarget?.brandId == app.currentBrandId)
        app.brandSettingsTarget = nil

        bar.backButton.fire()
        #expect(app.route == .newChat)
        await settle()
        #expect(!bar.backButton.isEnabled)
        #expect(bar.forwardButton.isEnabled)

        _ = bar.modePill.segments.last?.accessibilityPerformPress()
        #expect(app.route == .posts)
        bar.sidebarButton.fire()
        #expect(!app.sidebarPresented)
    }

    @Test func titleMenuHoldsTheConversationActions() async throws {
        let (app, _) = await makeApp()
        app.navigate(to: .conversation(SampleData.kasimConversation))
        let menu = TopBarMenus.titleMenu(app: app) { nil }
        let titles = menu.items.map(\.title)
        #expect(Array(titles.prefix(2)) == [ConversationActions.renameTitle, ConversationActions.archiveTitle])
        #expect(titles.contains("Bu markanın postları"))

        app.navigate(to: .posts)
        let brands = TopBarMenus.titleMenu(app: app) { nil }.items.filter { $0.state == .on }.map(\.title)
        #expect(brands.contains(app.brand(app.currentBrandId)?.name ?? "-"))
        let more = TopBarMenus.moreMenu(app: app).items.map(\.title)
        #expect(more.contains("Postları yenile"))
        #expect(more.contains("Ayarlar…"))
    }

    @Test func sidebarHiddenMovesTheTitleAfterTheCluster() async throws {
        let (app, _) = await makeApp()
        app.sidebarPresented = false
        app.inspectorPresented = false
        let (_, _, bar) = makeChrome(app, width: 1100)
        await settle()
        bar.layoutSubtreeIfNeeded()
        let state = try #require(bar.layoutState)
        #expect(state.sidebarMaxX == nil)
        #expect(state.panelMinX == nil)
        let pill = bar.modePill.convert(bar.modePill.bounds, to: bar)
        let title = bar.titleControl.convert(bar.titleControl.bounds, to: bar)
        #expect(title.minX >= pill.maxX + TopBarLayout.clusterGap - 0.5)
        #expect(bar.panelHeader != nil)
        #expect(ambiguous(in: bar).isEmpty, "ambiguous: \(ambiguous(in: bar))")
    }

    @Test func compactTitleBarCentresTheTrafficLightsInTheBar() throws {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        MainWindowController.applyChrome(to: window)
        window.layoutIfNeeded()
        #expect(window.titlebarAppearsTransparent)
        #expect(window.toolbar?.items.isEmpty == true, "the toolbar only sizes the title bar")
        #expect(MainWindowController.titlebarHeight(of: window) == Theme.topBarHeight)
        let zoom = try #require(window.standardWindowButton(.zoomButton))
        let frame = try #require(zoom.superview).convert(zoom.frame, to: nil)
        #expect(abs((window.frame.height - frame.midY) - Theme.topBarHeight / 2) <= 1, "traffic lights on the bar's centre line")
        #expect(frame.maxX < Theme.sidebarWidth - TopBarMetrics.afterTrafficLights - 174, "the cluster fits after the lights inside the sidebar column")
    }

    @Test func rootViewHostsTheBarAboveTheSplitView() async throws {
        let (app, _) = await makeApp()
        let root = RootViewController(app: app, settings: app.settings, host: nil)
        root.view.frame = CGRect(x: 0, y: 0, width: 1440, height: 900)
        root.view.layoutSubtreeIfNeeded()
        await settle()
        root.view.layoutSubtreeIfNeeded()
        let bar = try #require(root.topBar)
        #expect(bar.frame.height == Theme.topBarHeight)
        #expect(bar.frame.maxY == root.view.bounds.maxY, "pinned to the top")
        let barIndex = try #require(root.view.subviews.firstIndex { $0 === bar })
        let splitIndex = try #require(root.view.subviews.firstIndex { $0 === root.splitController.view })
        #expect(barIndex > splitIndex, "drawn over the split view")
        #expect(ambiguous(in: bar).isEmpty, "ambiguous: \(ambiguous(in: bar))")
    }

    @Test func composerIsOneRoundedFortyFourPointGlassField() async throws {
        let (app, _) = await makeApp()
        let composer = ComposerControlView(model: app.newChat.composer, imageStore: nil, onSend: {})
        composer.frame = CGRect(x: 0, y: 0, width: Theme.columnMaxWidth + 2 * Theme.composerOverhang, height: 200)
        composer.layoutSubtreeIfNeeded()
        #expect(composer.fittingSize.height == Theme.composerHeight)
        let glass = try #require(all(GlassContainerView.self, in: composer).first { !$0.isHidden && $0.cornerRadius == Theme.composerRadius })
        #expect(glass.tint == Theme.composerGlassTint)
        // "+" on the left; send / stop then the microphone on the right (Claude Code's order).
        let buttons = all(GlyphButton.self, in: composer).filter { !$0.isHidden }.sorted { $0.convert($0.bounds, to: composer).minX < $1.convert($1.bounds, to: composer).minX }
        #expect(buttons.map(\.symbolName) == ["plus", "arrow.up.circle.fill", "mic"])
        #expect(ambiguous(in: composer).isEmpty, "ambiguous: \(ambiguous(in: composer))")
    }

    @Test func statusLineShowsModelAndEffortAndHidesAHealthyMac() async throws {
        let (app, _) = await makeApp()
        let footer = ComposerFooterControlView(newChat: app.newChat, app: app)
        footer.frame = CGRect(x: 0, y: 0, width: 700, height: 20)
        await settle()
        footer.layoutSubtreeIfNeeded()
        #expect(footer.agentTitle.hasPrefix(app.newChat.agentChoice.model.displayName))
        #expect(footer.agentTitle.hasSuffix(app.newChat.agentChoice.effort.displayName))
        #expect(!footer.macStatusShown, "Mac ready and the model's provider signed in: nothing on the left")
        #expect(ambiguous(in: footer).isEmpty)
    }
}
