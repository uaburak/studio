import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// S1: the Claude-desktop style settings sheet. Window-free: the sheet's view is
/// loaded but never put in a window or presented.
@MainActor
private func makeApp() async -> (AppModel, AppSettings, UserDefaults) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.tests.s1.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), tunnelTokens: InMemoryTunnelTokenStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return (app, settings, defaults)
}

@MainActor
private func makeSheet(_ app: AppModel, _ settings: AppSettings, section: SettingsSection? = nil) -> SettingsSheetViewController {
    let sheet = SettingsSheetViewController(app: app, settings: settings, host: nil, section: section) {}
    _ = sheet.view
    return sheet
}

@Suite("Settings sections and catalog")
struct SettingsSectionTests {
    @Test func sectionsInSidebarOrder() {
        #expect(SettingsSection.allCases.map(\.title) == [
            "Markalar", "Kullanım",
            "Görünüm", "Yapay zekâ", "Bildirimler",
            "Hesaplar", "Yayın",
            "Cihazlar", "Gelişmiş", "Hakkında",
        ])
        #expect(SettingsSection.groups == [
            [.brands, .usage],
            [.appearance, .ai, .notifications],
            [.accounts, .publishing],
            [.devices, .macServer, .about],
        ])
        #expect(SettingsSection.default == .brands)
    }

    @Test @MainActor func everySectionHasAnIconAndRows() {
        for section in SettingsSection.allCases {
            #expect(NSImage(systemSymbolName: section.symbol, accessibilityDescription: nil) != nil, "\(section) icon")
            #expect(SettingsCatalog.items.contains { $0.section == section }, "\(section) has no fixed row")
        }
        let ids = SettingsCatalog.items.map(\.id)
        #expect(Set(ids).count == ids.count, "row ids are unique")
        for item in SettingsCatalog.items {
            #expect(item.id.hasPrefix(item.section.rawValue + "."), "\(item.id) belongs to \(item.section)")
            #expect(!item.title.isEmpty)
        }
    }

    @Test func panelFitsTheWindow() {
        #expect(SettingsLayout.panelSize(fitting: nil) == SettingsLayout.preferredSize)
        #expect(SettingsLayout.panelSize(fitting: NSSize(width: 1600, height: 1000)) == SettingsLayout.preferredSize)
        let small = SettingsLayout.panelSize(fitting: NSSize(width: 860, height: 560))
        #expect(small.width == 740 && small.height == 480)
        #expect(SettingsLayout.panelSize(fitting: NSSize(width: 500, height: 300)) == SettingsLayout.minimumSize)
    }
}

@Suite("Settings search")
struct SettingsSearchTests {
    @Test func turkishFolding() {
        #expect(SettingsSearch.normalize("Görünüm") == "gorunum")
        #expect(SettingsSearch.normalize("Yapay zekâ") == "yapay zeka")
        #expect(SettingsSearch.normalize("İzin ışık") == "izin isik")
        #expect(SettingsSearch.matches("gorunum", in: "Görünüm"))
        #expect(SettingsSearch.matches("  ", in: "anything"))
        #expect(SettingsSearch.matches("tünel anahtar", in: "Tünel adresi ve anahtarı"))
        #expect(!SettingsSearch.matches("tünel kod", in: "Tünel adresi ve anahtarı"))
    }

    @Test func findsRowsAcrossSections() {
        #expect(SettingsSearch.results(for: "").isEmpty)
        #expect(SettingsSearch.results(for: "tünel").map(\.section) == [.macServer])
        #expect(SettingsSearch.results(for: "tema").map(\.section) == [.appearance])

        // Destructive rows live in three sections.
        let deletes = SettingsSearch.results(for: "sil")
        #expect(deletes.map(\.section) == [.accounts, .publishing, .macServer])
        #expect(deletes.flatMap(\.items).map(\.id).contains("macServer.forgetAccess"))

        // Every word must match: the Claude sign-in row only, not the whole AI section.
        let claude = SettingsSearch.results(for: "claude giriş")
        #expect(claude.map(\.section) == [.ai])
        #expect(claude.first?.items.map(\.id) == ["ai.claude"])

        // A section name shows all of its rows (and rows elsewhere that use the word).
        let publishing = SettingsSearch.results(for: "yayin")
        #expect(publishing.first { $0.section == .publishing }?.items.count == SettingsCatalog.items.filter { $0.section == .publishing }.count)
        #expect(publishing.map(\.section).contains(.notifications), "\"Yayınlandı\" bildirimleri")
        #expect(SettingsSearch.results(for: "qqqzzz").isEmpty)
    }
}

@Suite("Settings navigation and deep links", .serialized)
@MainActor
struct SettingsNavigationTests {
    @Test func lastSectionPersists() {
        let defaults = UserDefaults(suiteName: "studio.tests.s1.nav.\(UUID().uuidString)")!
        let navigation = SettingsNavigation(defaults: defaults)
        #expect(navigation.lastSection == .default)
        navigation.lastSection = .devices
        #expect(SettingsNavigation(defaults: defaults).lastSection == .devices)
        #expect(navigation.initialSection(requested: nil) == .devices)
        #expect(navigation.initialSection(requested: .ai) == .ai)
        defaults.set("gone", forKey: SettingsNavigation.lastSectionKey)
        #expect(navigation.lastSection == .default)
    }

    @Test func openSettingsCarriesTheSection() async {
        let (app, _, _) = await makeApp()
        app.openSettings(.devices)
        #expect(app.settingsPresented)
        #expect(app.settingsRequestedSection == .devices)

        app.settingsPresented = false
        app.settingsRequestedSection = nil
        app.perform(.openSettings)
        #expect(app.settingsPresented)
        #expect(app.settingsRequestedSection == nil, "no issue: the last section")
    }

    @Test func connectionIssuesOpenTheFixingSection() {
        #expect(ConnectionIssue.hostFailed("x").settingsSection == .macServer)
        #expect(ConnectionIssue.unauthorized.settingsSection == .macServer)
        #expect(ConnectionIssue.workerOffline.settingsSection == .macServer)
        #expect(ConnectionIssue.claudeNotInstalled.settingsSection == .ai)
        #expect(ConnectionIssue.claudeSignedOut.settingsSection == .ai)
    }

    @Test func sheetOpensRequestedSectionAndRemembersSelection() async {
        let (app, settings, defaults) = await makeApp()
        app.openSettings(.accounts)
        let sheet = makeSheet(app, settings)
        #expect(sheet.selectedSection == .accounts)
        #expect(sheet.displayedSections == [.accounts])

        sheet.select(.ai)
        #expect(sheet.displayedSections == [.ai])
        #expect(defaults.string(forKey: SettingsNavigation.lastSectionKey) == "ai")

        // ⌘, next time: no deep link, the remembered section.
        app.settingsRequestedSection = nil
        let again = makeSheet(app, settings)
        #expect(again.selectedSection == .ai)
    }

    @Test func sheetSearchFiltersRowsAcrossSections() async {
        let (app, settings, _) = await makeApp()
        let sheet = makeSheet(app, settings, section: .ai)

        sheet.search("tema")
        #expect(sheet.displayedSections == [.appearance])
        #expect(sheet.pane(for: .appearance).visibleRowTitles == ["Tema", "Adın"])

        sheet.search("bildirim")
        #expect(sheet.displayedSections.contains(.notifications))
        #expect(sheet.pane(for: .notifications).visibleRowTitles.contains("macOS bildirimleri"))

        sheet.search("cloudflare")
        #expect(sheet.displayedSections.contains(.macServer))
        #expect(sheet.pane(for: .macServer).visibleRowTitles.contains("Cloudflare Access"))
        #expect(!sheet.pane(for: .macServer).visibleRowTitles.contains("Sunucu adresi"))

        sheet.search("qqqzzz")
        #expect(sheet.displayedSections.isEmpty)

        // Clearing returns to the selected section with every row back.
        sheet.search("")
        #expect(sheet.displayedSections == [.ai])
        #expect(sheet.pane(for: .appearance).visibleRowTitles == ["Tema", "Adın"])
        #expect(sheet.pane(for: .ai).visibleRowTitles.starts(with: ["Varsayılan model", "Varsayılan efor", "Claude Code", "Gemini"]))

        // Picking a section in the sidebar ends the search.
        sheet.search("tema")
        sheet.select(.macServer)
        #expect(sheet.searchQuery.isEmpty)
        #expect(sheet.pane(for: .macServer).visibleRowTitles.contains("Sunucu adresi"))
    }

    /// Window-free layout pass: every visible row fits the content column, its control
    /// stays inside the row, and descriptions wrap instead of pushing controls out.
    @Test func rowsFitTheContentColumn() async {
        let (app, settings, _) = await makeApp()
        let sheet = SettingsSheetViewController(app: app, settings: settings, host: nil, section: .brands, parentSize: NSSize(width: 860, height: 560)) {}
        let root = sheet.view
        let column = 740 - Theme.Settings.sidebarWidth - 1 - 2 * Theme.Settings.contentInset
        var problems: [String] = []
        for section in SettingsSection.allCases {
            sheet.select(section)
            root.layoutSubtreeIfNeeded()
            let pane = sheet.pane(for: section)
            if abs(pane.frame.width - column) >= 1 { problems.append("\(section) pane width \(pane.frame.width) != \(column)") }
            func rows(_ blocks: [SettingsBlock]) -> [SettingsRowView] {
                blocks.flatMap { block -> [SettingsRowView] in
                    if block.isHidden { return [] }
                    if let group = block as? SettingsGroupBlock { return rows(group.blocks) }
                    return (block as? SettingsRowView).map { [$0] } ?? []
                }
            }
            for row in rows(pane.blocks) {
                if row.frame.height < 2 * Theme.Settings.rowVerticalPadding { problems.append("\(section)/\(row.title) height \(row.frame.height)") }
                if abs(row.frame.width - column) >= 1 { problems.append("\(section)/\(row.title) width \(row.frame.width)") }
                if let accessory = row.accessory, !accessory.isHidden {
                    // Alignment rect: labels draw 2 pt outside it by design.
                    let rect = row.convert(accessory.alignmentRect(forFrame: accessory.frame), from: accessory.superview)
                    if rect.minX < 0 || rect.maxX > row.bounds.width + 1 { problems.append("\(section)/\(row.title) control at \(rect)") }
                }
            }
        }
        #expect(problems.isEmpty, "\(problems)")
    }
}
