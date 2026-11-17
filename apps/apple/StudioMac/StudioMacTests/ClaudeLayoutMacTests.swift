import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// The Claude Code layout: sidebar rows and footer, the right panel's texts (Ortam, Kullanım,
/// Bağlam, Hesaplar), the composer's model line and the panel toggles. Window-free: views are
/// laid out offscreen; nothing is shown.
@MainActor
private func makeApp(defaults: UserDefaults? = nil) async -> (AppModel, UserDefaults) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = defaults ?? UserDefaults(suiteName: "studio.tests.layout.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
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

private let clock = Date(timeIntervalSince1970: 1_800_000_000)

// MARK: - Sidebar

@Suite("Claude Code layout: sidebar")
@MainActor
struct SidebarLayoutTests {
    @Test func rowsAreActionsThenHistoryGroupedByBrand() async throws {
        let (app, _) = await makeApp()
        let rows = SidebarRows.build(app: app)
        #expect(Array(rows.prefix(6)) == SidebarAction.allCases.map { .action($0) })
        #expect(SidebarAction.allCases.map(\.title) == ["Yeni sohbet", "Ara", "Postlar", "Takvim", "Medya", "Markalar"])

        // The current brand comes first, expanded, with its conversations as single rows.
        let headers = rows.compactMap { if case .groupHeader(let g) = $0 { g } else { nil } }
        #expect(headers.map(\.brandId) == app.sidebarBrands.map(\.id))
        let mtm = try #require(headers.first)
        #expect(mtm.brandId == SampleData.mtm && mtm.expanded && mtm.current)
        #expect(headers.dropFirst().allSatisfy { !$0.expanded && !$0.current })
        let titles = rows.compactMap { if case .conversation(let c) = $0 { c.title } else { nil } }
        #expect(titles == app.conversations(of: SampleData.mtm).map(\.title))

        // Folding the group hides its conversations.
        app.toggleBrand(SampleData.mtm)
        let folded = SidebarRows.build(app: app)
        #expect(!folded.contains { if case .conversation = $0 { true } else { false } })
    }

    @Test func routeHighlightsItsRow() async throws {
        let (app, _) = await makeApp()
        let rows = SidebarRows.build(app: app)
        #expect(SidebarRows.index(of: .newChat, in: rows) == 0)
        #expect(SidebarRows.index(of: .posts, in: rows).map { rows[$0] } == .action(.posts))
        let kasim = try #require(SidebarRows.index(of: .conversation(SampleData.kasimConversation), in: rows))
        if case .conversation(let c) = rows[kasim] { #expect(c.id == SampleData.kasimConversation) } else { Issue.record("not a conversation row") }
        #expect(SidebarRows.index(of: .conversation("missing"), in: rows) == nil)
    }

    @Test func unbrandedConversationsGetTheirOwnGroup() {
        let date = Date()
        let lone = Conversation(id: "c-x", brandId: nil, title: "Serbest", lastActivityAt: date, createdAt: date, updatedAt: date)
        let rows = SidebarRows.build(brands: [], conversations: { _ in [] }, unbranded: [lone], expandedBrands: [], unbrandedExpanded: true, currentBrandId: nil, loadError: "Sunucuya ulaşılamıyor.")
        #expect(rows.contains(.groupHeader(SidebarGroup(brandId: nil, title: "Markasız", expanded: true, current: false))))
        #expect(rows.contains(.conversation(lone)))
        #expect(rows.last == .loadError("Sunucuya ulaşılamıyor."))
        let folded = SidebarRows.build(brands: [], conversations: { _ in [] }, unbranded: [lone], expandedBrands: [], unbrandedExpanded: false, currentBrandId: nil, loadError: nil)
        #expect(!folded.contains(.conversation(lone)))
    }

    @Test func footerShowsNameAndBrand() {
        #expect(SidebarFooter.title(owner: "Burak", brandName: "MTM Agro") == "Burak · MTM Agro")
        #expect(SidebarFooter.title(owner: "Burak", brandName: nil) == "Burak")
        #expect(SidebarFooter.title(owner: " Burak ", brandName: "") == "Burak")
        #expect(SidebarFooter.initial("Burak") == "B")
        #expect(SidebarFooter.initial("ışıl") == "I")
        // No name typed and none from the Claude account: a neutral fallback, never someone else's name.
        #expect(SidebarFooter.title(owner: nil, brandName: nil) == "Studio")
        #expect(SidebarFooter.title(owner: "  ", brandName: "MTM Agro") == "Studio · MTM Agro")
    }

    @Test func sidebarLaysOutOffscreenAndFollowsTheRoute() async throws {
        let (app, _) = await makeApp()
        let controller = SidebarViewController(app: app, settings: app.settings)
        let view = controller.view
        view.frame = CGRect(x: 0, y: 0, width: Theme.sidebarWidth, height: 820)
        view.layoutSubtreeIfNeeded()
        await settle()
        #expect(controller.rows == SidebarRows.build(app: app))

        let table = try #require(all(NSTableView.self, in: view).first)
        #expect(table.numberOfRows == controller.rows.count)
        #expect(table.selectedRow == 0, "the new chat screen highlights Yeni sohbet")

        app.navigate(to: .conversation(SampleData.hasatConversation))
        await settle()
        #expect(table.selectedRow == SidebarRows.index(of: .conversation(SampleData.hasatConversation), in: controller.rows))
        let selectedRow = try #require(table.rowView(atRow: table.selectedRow, makeIfNecessary: true))
        #expect(selectedRow is SidebarRowView)
        #expect(selectedRow.interiorBackgroundStyle == .normal, "grey selection keeps normal text colours")

        let labels = all(NSTextField.self, in: view).map(\.stringValue)
        #expect(labels.contains("Burak · MTM Agro"), "one line: name · brand (Claude Code footer)")
        #expect(!labels.contains("Örnek veri"), "no second status line under the name")
        #expect(all(NSControl.self, in: view).contains { $0.toolTip?.contains("Örnek veri") == true }, "the Mac server status stays in the footer's tooltip and menu")

        view.layoutSubtreeIfNeeded()
        #expect(ambiguous(in: view).isEmpty, "ambiguous: \(ambiguous(in: view))")
    }

    @Test func conversationMenuOffersRenameAndArchive() async throws {
        let (app, _) = await makeApp()
        let menu = ConversationActions.makeMenu(app: app, conversationId: SampleData.kasimConversation) { nil }
        #expect(menu.items.map(\.title) == ["Yeniden adlandır", "Arşivle"])
        #expect(menu.items.allSatisfy { $0.target != nil && $0.action != nil })
    }
}

// MARK: - Right panel texts

@Suite("Claude Code layout: right panel")
@MainActor
struct InspectorContentTests {
    @Test func usageMetersReadAsPercentUsedWithReset() {
        let usage = WorkerUsage(windows: [
            UsageWindow(kind: .fiveHour, usedPercent: 42.4, resetsAt: clock.addingTimeInterval(3 * 3600)),
            UsageWindow(kind: .weekly, usedPercent: 95),
            UsageWindow(kind: .other, limited: true),
            UsageWindow(kind: .weekly),
        ], source: "claude", observedAt: clock.addingTimeInterval(-120))

        let meters = InspectorContent.usageMeters(usage, now: clock)
        #expect(meters.map(\.title) == ["5 saatlik", "Haftalık", "Diğer", "Haftalık"])
        #expect(meters.map(\.usedText) == ["%42 kullanıldı", "%95 kullanıldı", "Sınıra ulaşıldı", "—"])
        #expect(abs(meters[0].fraction - 0.424) < 0.0001)
        #expect(meters.map(\.warning) == [false, true, true, false])
        #expect(meters[2].fraction == 1)
        #expect(meters[3].fraction == 0)
        #expect(meters[0].resetText?.hasPrefix("Sıfırlanma: ") == true)
        #expect(meters[0].resetText?.contains("3 saat") == true)
        #expect(meters[1].resetText == nil)
        #expect(InspectorContent.usageUpdated(usage, now: clock)?.hasPrefix("Güncellendi: ") == true)
        #expect(InspectorContent.usageMeters(nil).isEmpty)
    }

    @Test func usageNoteExplainsMissingData() {
        #expect(InspectorContent.usageNote(nil) == "Mac'e bağlanılıyor…")
        #expect(InspectorContent.usageNote(WorkerPresence(online: false)) == "Arka plan çalışmıyor.")
        #expect(InspectorContent.usageNote(WorkerPresence(online: true))?.hasPrefix("Henüz bildirilmedi") == true)
        let reported = WorkerPresence(online: true, usage: WorkerUsage(windows: [UsageWindow(kind: .weekly, usedPercent: 10)], source: "claude", observedAt: clock))
        #expect(InspectorContent.usageNote(reported) == nil)
        #expect(InspectorContent.usageUpdated(WorkerUsage(windows: [], source: "claude", observedAt: clock)) == nil)
    }

    @Test func barFillsInProportionAndNeverVanishesWhenUsed() {
        #expect(UsageBarView.fillWidth(fraction: 0.42, width: 200) == 84)
        #expect(UsageBarView.fillWidth(fraction: 0, width: 200) == 0)
        #expect(UsageBarView.fillWidth(fraction: 0.001, width: 200) == 4)
        #expect(UsageBarView.fillWidth(fraction: 1.5, width: 200) == 200)
        #expect(UsageBarView.fillWidth(fraction: 0.5, width: 0) == 0)
    }

    @Test func claudeAndGeminiAvailability() {
        let signedIn = WorkerPresence(online: true, claude: ClaudeAccount(status: .signedIn, email: "b@x.net", plan: "Claude Max", checkedAt: clock),
                                      gemini: GeminiAccount(status: .ready, mode: .api, apiKeyConfigured: true, checkedAt: clock))
        #expect(InspectorContent.providers(signedIn) == [
            PanelRow(label: "Claude", value: "Claude Max", help: AssistantStatus.claudeLine(signedIn)),
            PanelRow(label: "Gemini", value: "Hazır", help: AssistantStatus.geminiLine(signedIn)),
        ])
        let signedOut = WorkerPresence(online: true, claude: ClaudeAccount(status: .signedOut, checkedAt: clock),
                                       gemini: GeminiAccount(status: .notConfigured, mode: .none, apiKeyConfigured: false, checkedAt: clock))
        #expect(InspectorContent.claude(signedOut).value == "Giriş yap")
        #expect(InspectorContent.claude(signedOut).tone == .action)
        #expect(InspectorContent.gemini(signedOut).value == "Yapılandırılmadı")
        #expect(InspectorContent.gemini(signedOut).tone == .attention)
        #expect(InspectorContent.claude(WorkerPresence(online: false)).value == "Mac çevrimdışı")
        #expect(InspectorContent.gemini(WorkerPresence(online: true)).value == "Bekleniyor")
        #expect(InspectorContent.claude(WorkerPresence(online: true, claude: ClaudeAccount(status: .signedIn, checkedAt: clock))).value == "Giriş yapıldı")
    }

    @Test func environmentSummaryIsPlainWithOneAction() {
        let running = HostSnapshot(status: .running, apiPhase: .running(pid: 1), workerPhase: .running(pid: 2))
        func summary(_ host: HostSnapshot?, issue: ConnectionIssue? = nil, presence: WorkerPresence? = WorkerPresence(online: true), sample: Bool = false, enabled: Bool = true) -> EnvironmentSummary {
            InspectorContent.environmentSummary(isSample: sample, host: host, hostEnabled: enabled, issue: issue, presence: presence)
        }
        let ready = summary(running)
        #expect(ready.state == .ready)
        #expect(ready.row == PanelRow(label: "Arka plan", value: "Hazır", tone: .normal, help: ready.detail))
        #expect(ready.action == nil)

        let starting = summary(HostSnapshot(status: .starting("API başlatılıyor")), issue: .hostStarting("API başlatılıyor"), presence: nil)
        #expect(starting.value == "Hazırlanıyor")
        #expect(starting.row.tone == .muted)
        #expect(summary(running, presence: nil).value == "Hazırlanıyor", "no worker report yet: still preparing")
        #expect(summary(HostSnapshot(status: .running, apiPhase: .restarting(exitStatus: 1, delay: .seconds(2)))).value == "Hazırlanıyor")

        let failed = summary(HostSnapshot(status: .error("node bulunamadı")), issue: .hostFailed("node bulunamadı"))
        #expect(failed.value == "Sorun var")
        #expect(failed.row.tone == .attention)
        #expect(failed.action == .restartHost)
        #expect(failed.actionTitle == "Yeniden başlat")
        #expect(failed.detail?.contains("node") == false, "the technical reason stays under Gelişmiş")

        #expect(summary(HostSnapshot(status: .stopped)).action == .restartHost)
        #expect(summary(HostSnapshot(status: .running, workerPhase: .failed("exit 1"))).state == .problem)
        #expect(summary(running, issue: .workerOffline, presence: WorkerPresence(online: false)).action == .restartHost)
        // Another server (own host off): retry, or settings for a worker that is not there.
        #expect(summary(nil, issue: .apiUnreachable, enabled: false).action == .retry)
        #expect(summary(running, issue: .apiUnreachable, enabled: false).action == .retry)
        #expect(summary(nil, issue: .workerOffline, enabled: false).action == .openSettings)
        #expect(summary(nil, issue: .unauthorized).action == .openSettings)
        // Claude problems belong to the Claude row, not to the background.
        #expect(summary(running, issue: .claudeSignedOut).state == .ready)
        #expect(summary(nil, sample: true).value == "Örnek veri")

        // No technical words in the plain texts.
        for s in [ready, starting, failed, summary(nil, issue: .apiUnreachable), summary(nil, issue: .workerOffline), summary(nil, issue: .apiError("HTTP 500"))] {
            let text = [s.value, s.detail ?? "", s.actionTitle ?? ""].joined(separator: " ")
            for word in ["API", "Worker", "worker", "port", "127.0.0.1", "HTTP"] {
                #expect(!text.contains(word), "\(word) in \(text)")
            }
        }
    }

    @Test func environmentOfTheOwnHost() {
        let host = HostSnapshot(
            status: .running, apiURL: URL(string: "http://127.0.0.1:8790"), apiPhase: .running(pid: 10), tunnelPhase: .running(pid: 11),
            lanURLs: ["http://192.168.1.20:8791", "http://10.0.0.5:8791"], tunnelNote: "Aktif hedef"
        )
        let rows = InspectorContent.advancedEnvironment(
            isSample: false, host: host, hostEnabled: true, serverURL: nil, lanEnabled: true, remoteEnabled: true,
            remoteHostname: "https://social.burakkoc.net/", issue: nil, presence: WorkerPresence(online: true, queueLength: 2)
        )
        #expect(rows.map(\.label) == ["Sunucu", "API", "Worker", "Yerel ağ", "Uzaktan erişim"])
        #expect(rows.map(\.value) == ["Çalışıyor", "Çalışıyor", "Hazır · 2 sırada", "192.168.1.20:8791", "Açık · social.burakkoc.net"])
        #expect(rows[3].help == "http://192.168.1.20:8791, http://10.0.0.5:8791")

        // Off switches read as muted "Kapalı"; a tunnel that is on but not running needs setup.
        let off = InspectorContent.advancedEnvironment(
            isSample: false, host: HostSnapshot(status: .running, apiPhase: .running(pid: 1)), hostEnabled: true, serverURL: nil,
            lanEnabled: false, remoteEnabled: false, remoteHostname: "social.burakkoc.net", issue: nil, presence: nil
        )
        #expect(off.map(\.value) == ["Çalışıyor", "Çalışıyor", "Bekleniyor", "Kapalı", "Kapalı"])
        #expect(off.map(\.tone) == [.normal, .normal, .muted, .muted, .muted])
        let setup = InspectorContent.advancedEnvironment(
            isSample: false, host: HostSnapshot(status: .running), hostEnabled: true, serverURL: nil,
            lanEnabled: true, remoteEnabled: true, remoteHostname: "social.burakkoc.net", issue: nil, presence: WorkerPresence(online: false)
        )
        #expect(setup.first { $0.label == "Uzaktan erişim" }?.value == "Kurulum gerekli")
        #expect(setup.first { $0.label == "Worker" }?.tone == .attention)
    }

    @Test func environmentProblemsAndOtherServers() {
        let failed = InspectorContent.advancedEnvironment(
            isSample: false, host: HostSnapshot(status: .error("node bulunamadı")), hostEnabled: true, serverURL: nil,
            lanEnabled: true, remoteEnabled: false, remoteHostname: "x", issue: .hostFailed("node bulunamadı"), presence: nil
        )
        #expect(failed[0] == PanelRow(label: "Sunucu", value: "Hata", tone: .attention, help: "node bulunamadı"))

        let external = InspectorContent.advancedEnvironment(
            isSample: false, host: HostSnapshot(status: .running), hostEnabled: false, serverURL: URL(string: "https://studio.example.com"),
            lanEnabled: true, remoteEnabled: true, remoteHostname: "x", issue: .apiUnreachable, presence: nil
        )
        #expect(external.map(\.label) == ["Sunucu", "API", "Worker"], "LAN and tunnel belong to the own host only")
        #expect(external[0].value == "Harici · studio.example.com")
        #expect(external[1].value == "Ulaşılamıyor")
        #expect(external[1].tone == .attention)

        let sample = InspectorContent.advancedEnvironment(
            isSample: true, host: nil, hostEnabled: true, serverURL: nil, lanEnabled: true, remoteEnabled: true,
            remoteHostname: "x", issue: nil, presence: WorkerPresence(online: true)
        )
        #expect(sample.map(\.value) == ["Örnek veri", "Hazır"])
        #expect(InspectorContent.displayAddress("https://10.0.0.5:8791/") == "10.0.0.5:8791")
    }

    @Test func connectedAccountsAndActions() {
        func account(_ status: SocialAccountStatus, health: TokenHealthStatus? = nil, handle: String = "mtmagro") -> SocialAccount {
            SocialAccount(id: "a", brandId: "b", platform: .instagram, handle: handle, status: status, createdAt: clock, updatedAt: clock, tokenHealth: health)
        }
        #expect(InspectorContent.account(platform: .instagram, account: nil) == PanelRow(label: "Instagram", value: "Bağla", tone: .action, help: "Instagram hesabını bağla"))
        #expect(InspectorContent.account(platform: .instagram, account: account(.connected, health: .valid)).value == "mtmagro")
        #expect(InspectorContent.account(platform: .instagram, account: account(.connected, handle: " ")).value == "Bağlı")
        let expiring = InspectorContent.account(platform: .instagram, account: account(.connected, health: .expiringSoon))
        #expect(expiring.value == "Yakında doluyor")
        #expect(expiring.tone == .attention)
        #expect(InspectorContent.account(platform: .instagram, account: account(.needsReauth)).value == "Yeniden bağla")
        #expect(InspectorContent.account(platform: .linkedin, account: account(.pending)).tone == .muted)
    }

    @Test func contextOfAConversation() async throws {
        let (app, _) = await makeApp()
        let conversation = app.conversationModel(SampleData.hasatConversation)
        await waitUntil { conversation.state != nil }
        let state = try #require(conversation.state)
        let rows = InspectorContent.context(state: state, choice: AgentChoice(model: .opus, effort: .medium))
        #expect(Array(rows.map(\.label).prefix(5)) == ["Mesajlar", "Görseller", "Planlar", "Postlar", "Model"])
        #expect(rows[0].value.hasPrefix("\(state.messages.count)"))
        #expect(rows[1].value == "2")
        #expect(rows[4].value == "Opus Orta")
        #expect(InspectorContent.aliasLine(state) == "@image · @image-1")
        #expect(InspectorContent.context(state: nil, choice: .fallback).isEmpty)
        #expect(ComposerStatusText.title(AgentChoice(model: .geminiFlashLite, effort: .xhigh)) == "Gemini Flash-Lite Çok yüksek")
    }

    @Test func panelBuildsItsSectionsOffscreen() async throws {
        let (app, _) = await makeApp()
        await waitUntil { app.presence?.usage != nil }
        let controller = InfoPanelViewController(app: app)
        let view = controller.view
        view.frame = CGRect(x: 0, y: 0, width: Theme.inspectorWidth, height: 900)
        view.layoutSubtreeIfNeeded()
        await settle()
        #expect(controller.shownPane == .details)
        #expect(controller.sectionTitles == ["Ortam", "Kullanım", "Hesaplar"], "jobs moved to their own pane")

        let meters = all(UsageMeterView.self, in: view)
        #expect(meters.map(\.meter.title) == ["5 saatlik", "Haftalık"])
        let rows = all(PanelRowView.self, in: view)
        #expect(rows.contains { $0.labelText == "Arka plan" && $0.valueText == "Örnek veri" })
        #expect(rows.contains { $0.labelText == "Marka" && $0.valueText == "MTM Agro" })
        #expect(rows.contains { $0.labelText == "Instagram" && $0.valueText == "mtmagro" })
        #expect(rows.contains { $0.labelText == "Claude" })
        #expect(rows.contains { $0.labelText == "Gemini" })
        #expect(controller.shownEnvironment?.state == .sample)

        // Technical rows wait under a folded "Gelişmiş".
        #expect(!rows.contains { ["API", "Worker", "Sunucu"].contains($0.labelText) })
        let advanced = try #require(all(JobsDisclosureRowView.self, in: view).first { $0.title == "Gelişmiş" })
        #expect(!advanced.expanded)
        #expect(advanced.accessibilityValue() as? String == "Kapalı")
        advanced.performTap()
        await settle()
        #expect(controller.showAdvancedEnvironment)
        #expect(all(PanelRowView.self, in: view).contains { $0.labelText == "Worker" })
        try #require(all(JobsDisclosureRowView.self, in: view).first { $0.title == "Gelişmiş" }).performTap()
        await settle()
        #expect(!all(PanelRowView.self, in: view).contains { $0.labelText == "Worker" })

        app.navigate(to: .conversation(SampleData.hasatConversation))
        let conversation = app.conversationModel(SampleData.hasatConversation)
        await waitUntil { conversation.state != nil }
        await settle()
        #expect(controller.sectionTitles == ["Ortam", "Kullanım", "Bağlam", "Hesaplar"])
        #expect(all(PanelRowView.self, in: view).contains { $0.labelText == "Görseller" && $0.valueText == "2" })

        view.layoutSubtreeIfNeeded()
        let usageBars = all(UsageBarView.self, in: view)
        #expect(usageBars.count == 2)
        #expect(usageBars.allSatisfy { $0.frame.height == 4 && $0.frame.width > 200 })
        #expect(ambiguous(in: view).isEmpty, "ambiguous: \(ambiguous(in: view))")
    }

    @Test func jobsPaneListsRunningQueuedAndFoldedFinishedJobs() async throws {
        let (app, _) = await makeApp()
        let controller = InfoPanelViewController(app: app)
        let view = controller.view
        view.frame = CGRect(x: 0, y: 0, width: Theme.inspectorWidth, height: 900)
        app.togglePanel(.jobs)
        await settle()
        view.layoutSubtreeIfNeeded()
        #expect(controller.shownPane == .jobs)
        #expect(controller.sectionTitles == ["Çalışıyor", "Sırada", "Bitti"])
        #expect(all(JobsGroupLabel.self, in: view).map { "\($0.title) \($0.count)" } == ["Çalışıyor 1", "Sırada 1"])
        let cards = all(JobCardView.self, in: view)
        #expect(cards.map(\.titleText) == ["Bayi buluşması", "Uygulama zamanı"])
        #expect(cards.last?.valueText == "sırada")
        #expect(cards.allSatisfy { $0.frame.height == 42 && $0.frame.width > 300 })
        #expect(!all(PanelRowView.self, in: view).contains { $0.labelText == "Soru cevap" }, "finished jobs start folded")

        // "› Bitti 3" unfolds; the header's trash clears them.
        let toggle = try #require(all(JobsDisclosureRowView.self, in: view).first)
        toggle.performTap()
        await settle()
        #expect(all(PanelRowView.self, in: view).filter { $0.valueText == "bitti" }.count == 3)
        app.clearFinishedJobs()
        await settle()
        #expect(controller.sectionTitles == ["Çalışıyor", "Sırada"])
        view.layoutSubtreeIfNeeded()
        #expect(ambiguous(in: view).isEmpty, "ambiguous: \(ambiguous(in: view))")
    }
}

// MARK: - Panels

@Suite("Claude Code layout: panels")
@MainActor
struct PanelToggleTests {
    @Test func splitItemsFollowTheModelAndTheChoiceIsRemembered() async throws {
        let (app, defaults) = await makeApp()
        app.restoreSession()
        let split = MainSplitViewController(app: app, settings: app.settings)
        split.view.frame = CGRect(x: 0, y: 0, width: 1440, height: 900)
        split.view.layoutSubtreeIfNeeded()
        #expect(split.splitViewItems.count == 3)
        #expect(split.sidebarItem.behavior == .default, "flush sidebar, not a floating sidebar panel")
        #expect(split.inspectorItem.behavior == .default, "flush right panel, not a floating glass inspector")
        #expect(!split.sidebarItem.isCollapsed)
        #expect(!split.inspectorItem.isCollapsed)

        app.toggleInspector()
        await settle()
        #expect(split.inspectorItem.isCollapsed)
        app.toggleSidebar()
        await settle()
        #expect(split.sidebarItem.isCollapsed)

        // The toolbar's sidebar button stays enabled with a plain sidebar item.
        let toggle = NSMenuItem(title: "", action: #selector(NSSplitViewController.toggleSidebar(_:)), keyEquivalent: "")
        #expect(split.validateUserInterfaceItem(toggle))

        // Next launch: both panels come back the way they were left.
        let (next, _) = await makeApp(defaults: defaults)
        #expect(!next.inspectorPresented)
        #expect(!next.sidebarPresented)
        let nextSplit = MainSplitViewController(app: next, settings: next.settings)
        _ = nextSplit.view
        #expect(nextSplit.inspectorItem.isCollapsed)
        #expect(nextSplit.sidebarItem.isCollapsed)

        next.toggleInspector()
        await settle()
        #expect(!nextSplit.inspectorItem.isCollapsed)
    }

    @Test func themeMetricsMatchTheReference() {
        #expect(Theme.sidebarWidth == 265)
        #expect(Theme.inspectorWidth == 357)
        #expect(Theme.topBarHeight == 40)
        #expect(SidebarRow.action(.newChat).height == 34)
        #expect(SidebarRow.groupHeader(SidebarGroup(brandId: nil, title: "x", expanded: true, current: false)).height == 34)
        #expect(SidebarRow.conversation(Conversation(id: "c", brandId: nil, title: "t", lastActivityAt: clock, createdAt: clock, updatedAt: clock)).height == 34)
        #expect(SidebarRow.conversation(Conversation(id: "c", brandId: nil, title: "t", lastActivityAt: clock, createdAt: clock, updatedAt: clock)).isHoverable)
        #expect(!SidebarRow.groupHeader(SidebarGroup(brandId: nil, title: "x", expanded: true, current: false)).isHoverable)
    }
}
