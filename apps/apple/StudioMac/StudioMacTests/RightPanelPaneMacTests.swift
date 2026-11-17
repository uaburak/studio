import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// The right panel's panes (Takvim, Medya, Marka, iPhone), the in-window Settings panel and its
/// tabs + table sections. Window-free: views are laid out offscreen and never shown.
@MainActor
private func makeApp(defaults: UserDefaults? = nil) async -> (AppModel, UserDefaults) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = defaults ?? UserDefaults(suiteName: "studio.tests.panes.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), tunnelTokens: InMemoryTunnelTokenStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return (app, defaults)
}

@MainActor
private func waitUntil(_ condition: () -> Bool, timeout: Double = 3) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
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

/// A pane laid out like the panel lays it out (offscreen).
@MainActor
private func layOut(_ pane: NSView, width: CGFloat = Theme.inspectorWidth) {
    let host = NSView(frame: CGRect(x: 0, y: 0, width: width, height: 900))
    host.addSubview(pane)
    NSLayoutConstraint.activate([
        pane.leadingAnchor.constraint(equalTo: host.leadingAnchor),
        pane.trailingAnchor.constraint(equalTo: host.trailingAnchor),
        pane.topAnchor.constraint(equalTo: host.topAnchor),
        pane.bottomAnchor.constraint(equalTo: host.bottomAnchor),
    ])
    host.layoutSubtreeIfNeeded()
}

private func entry(_ id: String, _ day: CalendarDay, _ kind: CalendarModel.CalendarEntry.DotKind, time: String = "09:00", platform: Platform? = .instagram) -> CalendarModel.CalendarEntry {
    CalendarModel.CalendarEntry(
        id: id, day: day, timeText: time, title: "Post \(id)", platformText: platform?.displayName ?? "Instagram, Facebook",
        accountHandle: nil, statusLabel: "Zamanlandı", dotKind: kind, permalink: nil, canCancel: false,
        scheduleId: "sch-\(id)", contentId: "post-\(id)", platform: platform
    )
}

// MARK: - Panel selection

@Suite("Right panel: selection and memory")
@MainActor
struct RightPanelSelectionTests {
    @Test func iconsSelectTogglesAndTheLastPaneIsRemembered() async throws {
        let (app, defaults) = await makeApp()
        app.restoreSession()
        app.navigate(to: .conversation(SampleData.kasimConversation))
        for pane in RightPanelPane.allCases where pane != app.inspectorPane {
            app.togglePanel(pane)
            #expect(app.inspectorPresented && app.inspectorPane == pane)
            #expect(app.route == .conversation(SampleData.kasimConversation), "the centre never changes")
        }
        app.togglePanel(.phone)
        #expect(!app.inspectorPresented, "the selected icon closes the panel")
        #expect(app.inspectorPane == .phone, "and keeps the pane for next time")
        app.togglePanel(.media)
        #expect(app.inspectorPresented && app.inspectorPane == .media)

        let (next, _) = await makeApp(defaults: defaults)
        #expect(next.inspectorPane == .media, "Medya comes back next launch")
        #expect(RightPanelPane.allCases.map(\.title) == ["Ayrıntılar", "Arka plan işleri", "Takvim", "Medya", "Marka", "iPhone"])
        #expect(SessionSnapshot(route: .posts, brandId: nil, sidebarPresented: true, inspectorPresented: true, inspectorPane: .brand).pane == .brand)
    }

    @Test func panelControllerSwapsInEachPaneView() async throws {
        let (app, _) = await makeApp()
        let controller = InfoPanelViewController(app: app)
        let view = controller.view
        view.frame = CGRect(x: 0, y: 0, width: Theme.inspectorWidth, height: 900)
        let expected: [(RightPanelPane, PanelPaneView.Type)] = [
            (.calendar, CalendarPaneView.self), (.media, MediaPaneView.self), (.brand, BrandPaneView.self), (.phone, PhonePaneView.self),
        ]
        for (pane, expectedType) in expected {
            app.togglePanel(pane)
            await settle()
            #expect(controller.shownPane == pane)
            let shown = try #require(controller.paneView)
            #expect(ObjectIdentifier(type(of: shown)) == ObjectIdentifier(expectedType), "\(pane) shows \(expectedType)")
            #expect(shown.superview === view)
            #expect(controller.sectionTitles.isEmpty)
            view.layoutSubtreeIfNeeded()
            #expect(abs(shown.frame.width - Theme.inspectorWidth) < 1)
        }
        app.togglePanel(.details)
        await settle()
        #expect(controller.paneView == nil, "Ayrıntılar is built by the controller again")
        #expect(controller.sectionTitles.first == "Ortam")
    }
}

// MARK: - Takvim

@Suite("Right panel: Takvim")
@MainActor
struct CalendarPaneTests {
    @Test func miniMonthStartsOnMondayWithDotsAndAgenda() throws {
        let month = MonthKey(year: 2026, month: 11) // 1 Kasım 2026 is a Sunday
        let today = CalendarDay(year: 2026, month: 11, day: 17)
        let entries = [
            entry("a", today, .scheduled, time: "09:30"),
            entry("b", today, .error, time: "08:00", platform: .facebook),
            entry("c", today, .scheduled, time: "18:00", platform: nil),
            entry("d", CalendarDay(year: 2026, month: 11, day: 20), .published),
            entry("e", CalendarDay(year: 2026, month: 12, day: 1), .scheduled),
        ]
        let mini = MiniCalendar.make(month: month, selected: today, entries: entries, today: today)
        #expect(mini.title == "Kasım 2026")
        #expect(mini.cells.count % 7 == 0)
        #expect(mini.weeks.count == 6)
        #expect(mini.cells.prefix(6).allSatisfy { $0.day == nil }, "Monday first: six blanks before Sunday the 1st")
        #expect(mini.cells[6].day == CalendarDay(year: 2026, month: 11, day: 1))
        #expect(mini.cells.compactMap(\.day).count == 30)

        let todayCell = try #require(mini.cells.first { $0.day == today })
        #expect(todayCell.isToday && todayCell.isSelected)
        #expect(todayCell.dots == [.error, .scheduled], "one dot per kind, problems first")
        #expect(todayCell.count == 3)
        #expect(mini.cells.first { $0.day?.day == 20 }?.dots == [.published])
        #expect(mini.cells.allSatisfy { $0.day?.month != 12 }, "next month's posts stay out")

        #expect(mini.agendaTitle == "17 Kasım Salı")
        #expect(mini.agenda.map(\.id) == ["a", "b", "c"], "in the calendar's order")
        #expect(mini.agenda.first?.platform == .instagram)
        #expect(mini.agenda.last?.platform == nil)

        // A day of another month: no agenda; the default day of a month.
        let other = MiniCalendar.make(month: month.next, selected: today, entries: entries, today: today)
        #expect(other.agendaTitle == nil && other.agenda.isEmpty)
        #expect(MiniCalendar.defaultDay(in: month, entries: entries, today: today) == today)
        #expect(MiniCalendar.defaultDay(in: month.next, entries: entries, today: today) == CalendarDay(year: 2026, month: 12, day: 1))
        #expect(MiniCalendar.defaultDay(in: MonthKey(year: 2027, month: 2), entries: entries, today: today) == CalendarDay(year: 2027, month: 2, day: 1))
        #expect(MiniCalendar.dayTitle(CalendarDay(year: 2026, month: 11, day: 1)) == "1 Kasım Pazar")
    }

    @Test func paneLoadsShowsTheMonthAndOpensTheFullCalendar() async throws {
        let (app, _) = await makeApp()
        let pane = CalendarPaneView(app: app)
        layOut(pane)
        await waitUntil { app.calendar.loadedBrand == app.currentBrandId }
        await settle()
        pane.layoutSubtreeIfNeeded()
        let content = try #require(pane.content)
        #expect(pane.grid.cellViews.count == content.cells.count)
        #expect(pane.grid.frame.height == MiniMonthGridView.headerHeight + CGFloat(content.weeks.count) * MiniMonthGridView.rowHeight)

        // The sample's pending Instagram schedule on 30 Kasım 2026.
        let scheduled = CalendarDay(year: 2026, month: 11, day: 30)
        pane.select(scheduled)
        await settle()
        #expect(pane.content?.agenda.contains { $0.scheduleId == "sch-1" && $0.platform == .instagram && $0.canMove } == true)
        #expect(pane.content?.cells.first { $0.day == scheduled }?.dots.contains(.scheduled) == true)
        pane.layoutSubtreeIfNeeded()
        let rows = all(AgendaRowView.self, in: pane)
        #expect(rows.contains { $0.item.scheduleId == "sch-1" })
        #expect(rows.allSatisfy { $0.frame.height == 30 && $0.frame.width > 300 })
        #expect(ambiguous(in: pane).isEmpty, "ambiguous: \(ambiguous(in: pane))")

        let route = app.route
        rows.first?.performTap()
        await waitUntil { app.detail != nil }
        #expect(app.detail?.content.id == "post-12a", "the post opens over the centre")
        #expect(app.route == route, "the centre screen stays")
        app.detail = nil

        pane.openFullCalendar()
        #expect(app.route == .calendar)
        #expect(app.calendar.selectedDay == scheduled)
        #expect(app.calendar.month == scheduled.monthKey)
    }
}

// MARK: - Medya

@Suite("Right panel: Medya")
@MainActor
struct MediaPaneTests {
    @Test func searchAndGridGeometry() {
        let now = Date()
        func asset(_ id: String, _ name: String, kind: AssetKind = .image, source: AssetSource = .upload, minutesAgo: Double) -> Asset {
            Asset(id: id, brandId: "b", kind: kind, source: source, objectKey: id, mimeType: kind == .video ? "video/mp4" : "image/png", bytes: 1, sha256: "", width: 10, height: 10,
                  originalFilename: name, createdAt: now.addingTimeInterval(-minutesAgo * 60))
        }
        let assets = [
            asset("1", "Tarla gün batımı.png", minutesAgo: 30),
            asset("2", "depo.jpg", minutesAgo: 10),
            asset("3", "uretilen.png", source: .generated, minutesAgo: 20),
            asset("4", "tanitim.mp4", kind: .video, minutesAgo: 5),
        ]
        #expect(MediaPaneContent.filter(assets, query: "").map(\.id) == ["4", "2", "3", "1"], "newest first")
        #expect(MediaPaneContent.filter(assets, query: "tarla").map(\.id) == ["1"])
        #expect(MediaPaneContent.filter(assets, query: "GÜN batimi").map(\.id) == ["1"], "Turkish-aware, every word")
        #expect(MediaPaneContent.filter(assets, query: "ai").map(\.id) == ["3"])
        #expect(MediaPaneContent.filter(assets, query: "video").map(\.id) == ["4"])
        #expect(MediaPaneContent.isImage(assets[0]) && !MediaPaneContent.isImage(assets[3]))

        #expect(MediaPaneContent.tileSide(width: 329) == 105)
        #expect(MediaPaneContent.gridHeight(count: 0, width: 329) == 0)
        #expect(MediaPaneContent.gridHeight(count: 4, width: 329) == CGFloat(105 * 2 + 6))
        #expect(MediaPanelActions.fileBaseName(assets[0]) == "Tarla gün batımı")
        #expect(MediaPanelActions.fileBaseName(asset("5", "a/b:c.png", minutesAgo: 1)) == "a-b-c")
    }

    @Test func paneLoadsFiltersAndTilesDragAsFiles() async throws {
        let (app, _) = await makeApp()
        let pane = MediaPaneView(app: app)
        layOut(pane)
        await waitUntil { app.media.loadedBrand == app.currentBrandId && !app.media.assets.isEmpty }
        await settle()
        pane.layoutSubtreeIfNeeded()
        let count = app.media.assets.count
        #expect(count >= 2)
        #expect(pane.shownAssets.count == count)
        #expect(pane.grid.tiles.count == count)
        let side = MediaPaneContent.tileSide(width: pane.grid.frame.width)
        #expect(pane.grid.tiles.allSatisfy { abs($0.frame.width - side) < 0.5 && abs($0.frame.height - side) < 0.5 }, "square tiles")
        #expect(pane.grid.frame.height == MediaPaneContent.gridHeight(count: count, width: pane.grid.frame.width))

        let reused = pane.grid.tiles.first { $0.asset.originalFilename == "tarla.jpg" }
        pane.search("tarla")
        #expect(pane.shownAssets.map(\.originalFilename) == ["tarla.jpg"])
        #expect(pane.grid.tiles.count == 1)
        #expect(pane.grid.tiles.first === reused, "tiles are reused, not rebuilt")
        pane.search("")
        #expect(pane.grid.tiles.count == count)
        #expect(pane.searchField.stringValue.isEmpty)
        pane.layoutSubtreeIfNeeded()
        #expect(ambiguous(in: pane).isEmpty, "ambiguous: \(ambiguous(in: pane))")

        // Dropping a tile on the composer imports a file like any dropped image.
        #expect(NSPasteboard.PasteboardType.studioAsset.rawValue == "net.burakkoc.studio.asset")
        #expect(MediaPanelActions.activeComposer(app) === app.newChat.composer)
        app.navigate(to: .conversation(SampleData.kasimConversation))
        #expect(MediaPanelActions.activeComposer(app) === app.conversationModel(SampleData.kasimConversation).composer)
        app.navigate(to: .posts)
        #expect(MediaPanelActions.activeComposer(app) == nil)

        // "Tümü" opens the full media screen.
        try #require(all(PaneLinkView.self, in: pane).first { $0.title == "Tümü" }).performTap()
        #expect(app.route == .media)
    }
}

// MARK: - Marka

@Suite("Right panel: Marka")
@MainActor
struct BrandPaneTests {
    @Test func cardPrefersTheProfileAndFallsBackToTheKit() throws {
        let now = Date()
        let brand = Brand(id: "b", name: "MTM Agro", slug: "mtm-agro", createdAt: now, updatedAt: now)
        let kit = BrandKit(
            brandId: "b",
            logos: [BrandKitLogo(assetId: "logo-dark", background: .dark), BrandKitLogo(assetId: "logo", background: .light)],
            fonts: [BrandKitFont(assetId: "f1", family: "Archivo", role: .display), BrandKitFont(assetId: "f2", family: "archivo", role: .text), BrandKitFont(assetId: "f3", family: "Inter", role: .any)],
            palette: [BrandKitColor(name: "accent", hex: "#ff6a00"), BrandKitColor(name: "ink", hex: "0a0a0a")]
        )
        let accounts = [
            SocialAccount(id: "ig", brandId: "b", platform: .instagram, handle: "mtmagro", status: .connected, createdAt: now, updatedAt: now, hasToken: true, tokenHealth: .valid),
            SocialAccount(id: "li", brandId: "b", platform: .linkedin, handle: "MTM", status: .needsReauth, createdAt: now, updatedAt: now, hasToken: true),
        ]
        let fromKit = BrandCardContent.make(brand: brand, kit: kit, profile: nil, accounts: accounts)
        #expect(fromKit.initials == "MA")
        #expect(fromKit.logoAssetId == "logo", "a logo for light backgrounds first")
        #expect(fromKit.swatches == [.init(name: "accent", hex: "#FF6A00"), .init(name: "ink", hex: "#0A0A0A")])
        #expect(fromKit.fonts == ["Archivo (Başlık)", "Inter"])
        #expect(fromKit.profileLine == "Profil yok")
        #expect(fromKit.voice == nil)
        #expect(fromKit.platforms.map(\.platform) == [.instagram, .facebook, .linkedin])
        #expect(fromKit.platforms[0] == .init(platform: .instagram, value: "@mtmagro", connected: true, needsOwner: false))
        #expect(fromKit.platforms[1].value == "Bağlı değil" && !fromKit.platforms[1].connected)
        #expect(fromKit.platforms[2].needsOwner && fromKit.platforms[2].value == "Yeniden bağla")

        let profile = BrandProfile(
            id: "p", brandId: "b", version: 3, status: .approved, isCurrent: true,
            tokens: [
                "color": .object(["paper": .string("#ffffff"), "accent": .object(["value": .string("#FF6A00"), "use": .string("vurgu")])]),
                "font": .object(["display": .object(["family": .string("Archivo")]), "text": .object(["family": .string("Inter")])]),
            ],
            voice: "# Ses\n- Sıcak ve net konuşur. Tarımı bilen bir dost gibi.\n- Kısa cümleler.",
            createdAt: now, updatedAt: now
        )
        let fromProfile = BrandCardContent.make(brand: brand, kit: kit, profile: profile, accounts: [])
        #expect(fromProfile.profileLine == "Onaylı profil · v3")
        #expect(fromProfile.swatches.map(\.name) == ["paper", "accent"])
        #expect(fromProfile.fonts == ["Archivo (Başlık)", "Inter (Gövde)"])
        #expect(fromProfile.voice == "Ses Sıcak ve net konuşur. Tarımı bilen bir dost gibi. Kısa cümleler.")

        let long = String(repeating: "Bu bir cümle. ", count: 40)
        let summary = try #require(BrandCardContent.summary(long))
        #expect(summary.count <= BrandCardContent.voiceLimit && summary.hasSuffix("."))
        #expect(BrandCardContent.initials("finvo") == "F")
        #expect(BrandCardContent.initials("—") == "?")
    }

    @Test func paneShowsTheWorkingBrandAndItsActions() async throws {
        let (app, _) = await makeApp()
        let pane = BrandPaneView(app: app)
        layOut(pane)
        let brandName = try #require(app.brand(app.currentBrandId)?.name)
        #expect(pane.content?.name == brandName)
        await settle()
        pane.layoutSubtreeIfNeeded()
        #expect(pane.content?.platforms.count == 3)
        #expect(ambiguous(in: pane).isEmpty, "ambiguous: \(ambiguous(in: pane))")

        let buttons = all(PillButton.self, in: pane)
        try #require(buttons.first { $0.title == "Marka profili" }).onAction?()
        #expect(app.brandSettingsTarget == BrandSettingsTarget(brandId: app.currentBrandId!, tab: .profile))
        app.brandSettingsTarget = nil
        try #require(buttons.first { $0.title == "AI ile analiz et" }).onAction?()
        #expect(app.brandSettingsTarget?.startAnalysis == true)
        #expect(app.brandSettingsTarget?.tab == .kit)
    }
}

// MARK: - iPhone

@Suite("Right panel: iPhone")
@MainActor
struct PhonePaneTests {
    @Test func pairingCardStacksForTheNarrowPanel() async throws {
        let (app, _) = await makeApp()
        let pane = PhonePaneView(app: app)
        layOut(pane)
        await settle()
        pane.layoutSubtreeIfNeeded()
        #expect(pane.card.frame.width > 300, "the card takes the panel's width")
        #expect(!pane.card.displayedTitle.isEmpty)
        #expect(ambiguous(in: pane).isEmpty, "ambiguous: \(ambiguous(in: pane))")
        try #require(all(PaneLinkView.self, in: pane).first { $0.title == "Ayarlar" }).performTap()
        #expect(app.settingsPresented && app.settingsRequestedSection == .devices)
    }
}

// MARK: - Settings panel (in the window)

@Suite("Settings panel in the window", .serialized)
@MainActor
struct SettingsPanelTests {
    @Test func clickingASidebarSectionKeepsThePanelOpen() async throws {
        let (app, _) = await makeApp()
        let root = RootViewController(app: app, settings: app.settings, host: nil)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1424, height: 949), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentViewController = root
        window.setFrame(NSRect(x: 0, y: 0, width: 1424, height: 949), display: false)
        root.view.layoutSubtreeIfNeeded()
        await settle()
        app.openSettings(.appearance)
        await settle()
        root.view.layoutSubtreeIfNeeded()
        let panel = try #require(root.settingsPanel)
        let row = try #require(panel.sidebar.rows.first { $0.section == .notifications })
        let point = row.convert(NSPoint(x: row.bounds.midX, y: row.bounds.midY), to: nil)
        let hit = window.contentView?.superview?.hitTest(point)
        #expect(hit === row, "the row itself takes the click, not its label")
        let down = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        row.mouseDown(with: down)
        row.mouseUp(with: down)
        await settle()
        #expect(app.settingsPresented, "a click on a section must not close Settings")
        #expect(root.settingsPanel?.selectedSection == .notifications)
        window.close()
    }

    @Test func opensOverTheWindowAndClosesWithEscapeOrTheBackdrop() async throws {
        let (app, _) = await makeApp()
        let root = RootViewController(app: app, settings: app.settings, host: nil)
        root.view.frame = CGRect(x: 0, y: 0, width: 1424, height: 949)
        root.view.layoutSubtreeIfNeeded()
        await settle()
        #expect(root.settingsPanel == nil)

        app.openSettings(.devices)
        await settle()
        let panel = try #require(root.settingsPanel)
        #expect(root.children.contains(panel), "a child of the window's root, not a sheet window")
        #expect(panel.presentingViewController == nil)
        #expect(panel.selectedSection == .devices)
        root.view.layoutSubtreeIfNeeded()
        #expect(panel.view.frame.size == NSSize(width: 1020, height: 800), "Claude's size in a 1424×949 window")
        let frame = panel.view.convert(panel.view.bounds, to: root.view)
        #expect(abs(frame.midX - root.view.bounds.midX) < 1 && abs(frame.midY - root.view.bounds.midY) < 1, "centred")
        let backdrop = try #require(root.view.subviews.first { $0 is SettingsBackdropView })
        #expect(!backdrop.isHidden)
        #expect(ambiguous(in: panel.view).isEmpty, "ambiguous: \(ambiguous(in: panel.view))")

        // The panel follows the size it is given (RootViewController.viewDidLayout passes the window's).
        panel.fit(parentSize: NSSize(width: 900, height: 620))
        #expect(panel.panelSize == NSSize(width: 780, height: 540))
        panel.fit(parentSize: NSSize(width: 1424, height: 949))
        #expect(panel.panelSize == SettingsLayout.preferredSize)

        // Esc clears a search first, then closes.
        panel.search("tema")
        panel.handleEscape()
        #expect(panel.searchQuery.isEmpty)
        #expect(app.settingsPresented)
        panel.handleEscape()
        #expect(!app.settingsPresented)
        await settle()
        #expect(root.settingsPanel == nil)
        #expect(!root.children.contains(panel))

        // ⌘, again, then a click on the dimmed window closes it.
        app.openSettings()
        await settle()
        #expect(root.settingsPanel != nil)
        #expect(root.settingsPanel?.selectedSection == .devices, "the last section")
        (backdrop as? SettingsBackdropView)?.onClick?()
        #expect(!app.settingsPresented)
        await settle()
        #expect(root.settingsPanel == nil)
    }

    /// In a real (offscreen, never shown) window, resizing the window resizes the open panel.
    @Test func panelFollowsTheWindowSize() async throws {
        let (app, _) = await makeApp()
        let root = RootViewController(app: app, settings: app.settings, host: nil)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1424, height: 949), styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.contentViewController = root
        window.setContentSize(NSSize(width: 1424, height: 949))
        app.openSettings(.appearance)
        await settle()
        window.layoutIfNeeded()
        let panel = try #require(root.settingsPanel)
        #expect(panel.view.frame.size == SettingsLayout.preferredSize)

        window.setContentSize(NSSize(width: 1300, height: 660))
        window.layoutIfNeeded()
        let expected = SettingsLayout.panelSize(fitting: root.view.bounds.size)
        #expect(root.view.bounds.height == 660, "the window's content follows the window")
        #expect(panel.panelSize == expected)
        #expect(panel.view.frame.size == expected)
        #expect(panel.view.frame.height == 580, "never taller than the window minus its margins")
        app.settingsPresented = false
        await settle()
        window.contentViewController = nil
    }

    @Test func windowCommandsAreOffWhileSettingsIsOpen() async throws {
        let (app, _) = await makeApp()
        let delegate = AppDelegate()
        delegate.attach(model: app, settings: app.settings)
        delegate.assumeWindowForTesting = true
        #expect(!delegate.menuState().sheetOpen)
        app.settingsPresented = true
        #expect(delegate.menuState().sheetOpen, "Settings covers the window like a sheet")
        let menu = delegate.makeMainMenu()
        var items: [NSMenuItem] = []
        func walk(_ m: NSMenu) { for item in m.items { items.append(item); if let sub = item.submenu { walk(sub) } } }
        walk(menu)
        let newChat = try #require(items.first { $0.title == "Yeni Sohbet" })
        #expect(!delegate.validateMenuItem(newChat))
        app.settingsPresented = false
        #expect(delegate.validateMenuItem(newChat))

        // ⌘\ toggles the sidebar (Claude Code), next to ⌃⌘S.
        let sidebar = try #require(items.first { $0.keyEquivalent == "\\" && $0.keyEquivalentModifierMask == .command })
        #expect(sidebar.action == items.first { $0.title == "Kenar Çubuğunu Gizle" }?.action)
        #expect(sidebar.isHidden && sidebar.allowsKeyEquivalentWhenHidden)
        #expect(items.first { $0.keyEquivalent == "i" && $0.keyEquivalentModifierMask == [.command, .option] } != nil, "⌥⌘I: right panel")
        #expect(items.first { $0.keyEquivalent == "[" }?.title == "Geri")
        #expect(items.first { $0.keyEquivalent == "]" }?.title == "İleri")
    }
}

// MARK: - Tabs + table sections

@Suite("Settings: tabs and tables", .serialized)
@MainActor
struct SettingsTableTests {
    private func makeSheet(_ app: AppModel, section: SettingsSection, size: NSSize = NSSize(width: 1424, height: 949)) -> SettingsSheetViewController {
        let sheet = SettingsSheetViewController(app: app, settings: app.settings, host: nil, section: section, parentSize: size) {}
        _ = sheet.view
        return sheet
    }

    @Test func columnWidthsShareTheRowAndShrinkTogether() {
        let columns: [SettingsTableBlock.Column] = [.init(title: "A", width: nil), .init(title: "B", width: 100), .init(title: "C", width: 150)]
        let wide = SettingsTableBlock.columnWidths(columns, total: 800)
        #expect(wide[1] == 100 && wide[2] == 150)
        #expect(wide[0] == 800 - 2 * SettingsTableBlock.horizontalPadding - 2 * SettingsTableBlock.gap - 250)
        let narrow = SettingsTableBlock.columnWidths(columns, total: 380)
        #expect(narrow[0] >= SettingsTableBlock.minFlexibleWidth - 1, "the name column keeps room")
        #expect(narrow[1] < 100 && narrow[2] < 150)
        #expect(narrow.reduce(0, +) <= 380 - 2 * SettingsTableBlock.horizontalPadding - 2 * SettingsTableBlock.gap + 1)
    }

    @Test func brandsTableHasTabsSearchAndRows() async throws {
        let (app, _) = await makeApp()
        let sheet = makeSheet(app, section: .brands)
        sheet.view.layoutSubtreeIfNeeded()
        let pane = try #require(sheet.pane(for: .brands) as? BrandsSectionView)
        #expect(pane.toolbar.tabs.titles == ["Etkin", "Arşiv"])
        #expect(Set(pane.table.shownRowIDs) == Set(app.brands.map(\.id)))
        #expect(pane.table.columns.map(\.title) == ["Marka", "Dil", "Hesaplar", ""])

        pane.searchLocally("finvo")
        #expect(pane.table.shownRowIDs == ["b-finvo"])
        pane.searchLocally("")

        pane.toolbar.tabs.select(1)
        #expect(pane.tab == .archived)
        await settle()
        #expect(Set(pane.table.shownRowIDs) == Set(app.archivedBrands.map(\.id)))
        pane.show(.active)

        // The settings search reaches into the table.
        sheet.search("koç chords")
        #expect(sheet.displayedSections.contains(.brands))
        #expect(pane.table.shownRowIDs == ["b-koc"])
        sheet.search("yeni marka")
        #expect(sheet.displayedSections.contains(.brands), "the toolbar holds “+ Yeni marka”")
        sheet.search("")
        #expect(pane.table.shownRowIDs.count == app.brands.count)

        sheet.view.layoutSubtreeIfNeeded()
        let rows = pane.table.rowViews
        #expect(rows.allSatisfy { $0.frame.height == SettingsTableBlock.rowHeight })
        for row in rows {
            for cell in row.cells {
                #expect(cell.frame.maxX <= row.bounds.width + 1, "\(row.rowID) cell inside the row")
            }
        }
        #expect(ambiguous(in: pane).isEmpty, "ambiguous: \(ambiguous(in: pane))")
    }

    @Test func accountsTableListsAccountsAndMissingPlatformsAndAppsMoveToTheirTab() async throws {
        let (app, _) = await makeApp()
        let sheet = makeSheet(app, section: .accounts)
        sheet.view.layoutSubtreeIfNeeded()
        let pane = try #require(sheet.pane(for: .accounts) as? AccountsSectionView)
        #expect(pane.usesTable)
        #expect(pane.toolbar?.tabs.titles == ["Hesaplar", "Uygulamalar"])
        let accounts = app.accounts(of: app.currentBrandId)
        #expect(pane.accountsTable.shownRowIDs.filter { !$0.hasPrefix("missing-") }.sorted() == accounts.map(\.id).sorted())
        let missing = Platform.knownCases.filter { platform in !accounts.contains { $0.platform == platform && $0.status != .disabled } }
        #expect(pane.accountsTable.shownRowIDs.filter { $0.hasPrefix("missing-") } == missing.map { "missing-\($0.rawValue)" })

        // Hesaplar tab: the brand picker and the table; the app credentials wait in Uygulamalar.
        #expect(pane.visibleRowTitles.contains(SettingsCatalog.accountsBrand.title))
        #expect(!pane.visibleRowTitles.contains(SettingsCatalog.metaApp.title))
        pane.show(.apps)
        #expect(pane.visibleRowTitles.contains(SettingsCatalog.metaApp.title))
        #expect(pane.visibleRowTitles.contains(SettingsCatalog.linkedInApp.title))
        #expect(!pane.visibleRowTitles.contains(SettingsCatalog.accountsBrand.title))
        #expect(pane.accountsTable.isHidden)
        pane.show(.accounts)

        // A search still finds a row of the other tab.
        sheet.search("meta uygulaması")
        #expect(sheet.displayedSections.contains(.accounts))
        #expect(pane.visibleRowTitles.contains(SettingsCatalog.metaApp.title))
        sheet.search("mtmagro")
        #expect(pane.accountsTable.shownRowIDs == ["sa-ig"])
        sheet.search("")

        // "+ Bağla" lists both connect flows; unconfigured apps point to their tab.
        let items = pane.connectMenuItems()
        #expect(items.map(\.title).prefix(2) == ["Instagram ve Facebook…", "LinkedIn…"])

        sheet.view.layoutSubtreeIfNeeded()
        #expect(ambiguous(in: pane).isEmpty, "ambiguous: \(ambiguous(in: pane))")
    }

    @Test func rowsCarryTagsAndTheSheetHasNoAmbiguousLayout() async throws {
        let (app, _) = await makeApp()
        let row = SettingsRowView(title: "macOS bildirimleri", detail: "x")
        row.tagText = "Bu Mac"
        #expect(all(SettingsTagView.self, in: row).map(\.text) == ["Bu Mac"])
        row.tagText = nil
        #expect(all(SettingsTagView.self, in: row).isEmpty)

        let sheet = makeSheet(app, section: .ai)
        for section in SettingsSection.allCases {
            sheet.select(section)
            sheet.view.layoutSubtreeIfNeeded()
            #expect(ambiguous(in: sheet.view).isEmpty, "\(section) ambiguous: \(ambiguous(in: sheet.view))")
        }
    }
}
