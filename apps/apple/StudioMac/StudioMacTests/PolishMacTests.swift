import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// P4: menus and their validation, global search, session restoration, connection status
/// and the accessibility helpers. Window-free: nothing here opens a window.
@MainActor
private func makeApp(defaults: UserDefaults? = nil) async -> (AppModel, SampleBackend, UserDefaults) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = defaults ?? UserDefaults(suiteName: "studio.tests.p4.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return (app, backend, defaults)
}

private func brand(_ id: String, _ name: String, slug: String? = nil) -> Brand {
    Brand(id: id, name: name, slug: slug ?? name.lowercased(), createdAt: .now, updatedAt: .now)
}

private func conversation(_ id: String, _ title: String, brandId: String? = nil, minutesAgo: Double = 0) -> Conversation {
    let date = Date().addingTimeInterval(-minutesAgo * 60)
    return Conversation(id: id, brandId: brandId, title: title, lastActivityAt: date, createdAt: date, updatedAt: date)
}

// MARK: - Menu validation

@Suite("Main menu and validation")
@MainActor
struct MenuValidationTests {
    @Test func sheetDisablesWindowCommandsButKeepsAppearance() {
        var state = MenuState(canGoBack: true, canGoForward: true, brandIds: ["a", "b"], currentBrandId: "a", switchableBrandIds: ["a", "b"])
        #expect(MenuValidator.isEnabled(.newChat, in: state))
        #expect(MenuValidator.isEnabled(.selectBrand(1), in: state))
        #expect(MenuValidator.isEnabled(.back, in: state))
        state.sheetOpen = true
        for command: MenuCommand in [.newChat, .search, .settings, .newBrand, .brandSettings, .selectBrand(0), .back, .posts, .reload] {
            #expect(!MenuValidator.isEnabled(command, in: state), "\(command) should be off under a sheet")
        }
        #expect(MenuValidator.isEnabled(.appearance, in: state))
        #expect(MenuValidator.isEnabled(.shortcuts, in: state))
    }

    @Test func brandAndHistoryRules() {
        let state = MenuState(canGoBack: false, canGoForward: false, brandIds: ["a", "b"], currentBrandId: nil, switchableBrandIds: ["a"], isSample: true, isLoading: true)
        #expect(!MenuValidator.isEnabled(.back, in: state))
        #expect(!MenuValidator.isEnabled(.forward, in: state))
        #expect(!MenuValidator.isEnabled(.brandSettings, in: state), "no current brand")
        #expect(MenuValidator.isEnabled(.selectBrand(0), in: state))
        #expect(!MenuValidator.isEnabled(.selectBrand(1), in: state), "locked by attached images")
        #expect(!MenuValidator.isEnabled(.selectBrand(5), in: state), "no such brand")
        #expect(!MenuValidator.isEnabled(.reload, in: state), "already loading")
        #expect(!MenuValidator.isEnabled(.onboarding, in: state), "sample data")
        #expect(!MenuValidator.isEnabled(.revealLogs, in: state), "no host")
        #expect(!MenuValidator.isEnabled(.newChat, in: MenuState(hasWindow: false)))
    }

    @Test func mainMenuHasStandardItemsAndUniqueShortcuts() async throws {
        let (app, _, _) = await makeApp()
        let delegate = AppDelegate()
        delegate.attach(model: app, settings: app.settings)
        let menu = delegate.makeMainMenu()
        #expect(menu.items.map(\.title) == ["Studio", "Dosya", "Düzen", "Görüntü", "Git", "Marka", "Pencere", "Yardım"])

        var all: [NSMenuItem] = []
        func walk(_ m: NSMenu) { for item in m.items { all.append(item); if let sub = item.submenu { walk(sub) } } }
        walk(menu)

        func find(_ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem? {
            all.first { $0.keyEquivalent == key && $0.keyEquivalentModifierMask == mods }
        }
        #expect(find("n")?.title == "Yeni Sohbet")
        #expect(find("f")?.title == "Bul…")
        #expect(find("k")?.action == find("f")?.action, "⌘K opens the same search")
        #expect(find(",")?.title == "Ayarlar…")
        #expect(find("s", [.command, .control]) != nil)
        #expect(find("f", [.command, .control])?.action == #selector(NSWindow.toggleFullScreen(_:)))
        #expect(find("z")?.action == Selector(("undo:")))
        #expect(find("z", [.command, .shift])?.action == Selector(("redo:")))
        #expect(find("v")?.action == #selector(NSText.paste(_:)))
        #expect(find("w")?.action == #selector(NSWindow.performClose(_:)))
        #expect(find("r")?.title == "Yenile")
        // ⌘1…⌘4: the four sample brands, alphabetical.
        let brandItems = (1...4).compactMap { find(String($0)) }
        #expect(brandItems.map(\.title) == ["burakkoc.net", "Finvo", "Koç Chords", "MTM Agro"])
        #expect(brandItems.last?.state == .on, "MTM Agro is the current brand")

        // No two items share a shortcut.
        let shortcuts = all.filter { !$0.keyEquivalent.isEmpty }.map { "\($0.keyEquivalentModifierMask.rawValue)-\($0.keyEquivalent.lowercased())" }
        #expect(Set(shortcuts).count == shortcuts.count, "duplicate shortcuts: \(shortcuts)")
    }

    @Test func validationAndBrandShortcutAgainstTheModel() async throws {
        let (app, _, _) = await makeApp()
        let delegate = AppDelegate()
        delegate.attach(model: app, settings: app.settings)
        delegate.assumeWindowForTesting = true
        let menu = delegate.makeMainMenu()
        var all: [NSMenuItem] = []
        func walk(_ m: NSMenu) { for item in m.items { all.append(item); if let sub = item.submenu { walk(sub) } } }
        walk(menu)
        let back = try #require(all.first { $0.title == "Geri" })
        let brandSettings = try #require(all.first { $0.title == "Marka Ayarları…" })
        let finvo = try #require(all.first { $0.title == "Finvo" })

        #expect(!delegate.validateMenuItem(back), "no history yet")
        #expect(delegate.validateMenuItem(brandSettings))
        #expect(delegate.validateMenuItem(finvo))

        delegate.selectBrandMenu(finvo)
        #expect(app.currentBrandId == "b-finvo")

        app.navigate(to: .posts)
        #expect(delegate.validateMenuItem(back))

        // A new chat with an attached image is tied to its brand.
        app.startNewChat()
        app.newChat.composer.add([try ImageImport.from(data: try #require(SampleImages.png(seed: "p4")), filename: "p4.png")])
        let mtm = try #require(all.first { $0.title == "MTM Agro" })
        #expect(!delegate.validateMenuItem(mtm))
        #expect(delegate.validateMenuItem(finvo), "the current brand stays enabled")
    }

    @Test func switchingBrandLeavesAnotherBrandsConversation() async throws {
        let (app, _, _) = await makeApp()
        app.navigate(to: .conversation(SampleData.kasimConversation))
        #expect(app.switchToBrand("b-koc"))
        #expect(app.currentBrandId == "b-koc")
        #expect(app.route == .newChat)
        #expect(!app.switchToBrand(at: 99))
    }

    @Test func shortcutGuideListsTheMenuShortcuts() {
        let text = ShortcutGuide.text
        for key in ["⌘N", "⌘F", "⌘,", "⌘1 … ⌘9", "⌘Z", "⌃⌘S"] { #expect(text.contains(key)) }
    }
}

// MARK: - Global search

@Suite("Global search")
@MainActor
struct GlobalSearchTests {
    @Test func normalisesTurkishCaseAndDiacritics() {
        #expect(GlobalSearch.normalize("Kasım ŞENLİĞİ") == "kasim senligi")
        #expect(GlobalSearch.normalize("IŞIK Çağrı Ödülü") == "isik cagri odulu")
        #expect(GlobalSearch.tokens("  bor   ÇİNKO ") == ["bor", "cinko"])
    }

    @Test func findsBrandsConversationsAndPostCaptions() {
        let brands = [brand("b1", "MTM Agro", slug: "mtm-agro"), brand("b2", "Finvo")]
        let conversations = [
            conversation("c1", "Kasım planı", brandId: "b1", minutesAgo: 5),
            conversation("c2", "Hasat sezonu", brandId: "b1", minutesAgo: 1),
        ]
        let posts = [
            SearchablePost(contentId: "p1", brandId: "b1", title: "Bor ve çinko", caption: "Bitki ikisinden de yararlanır.", updatedAt: .now),
            SearchablePost(contentId: "p2", brandId: "b2", title: "Saklama", caption: "Gübreyi kuru ve serin bir yerde saklayın. Açılan torbayı kapalı tutun.", updatedAt: .now),
        ]

        let kasim = GlobalSearch.results(query: "kasim", brands: brands, conversations: conversations, posts: posts)
        #expect(kasim == [.conversation(conversations[0])])

        let agro = GlobalSearch.results(query: "agro", brands: brands, conversations: conversations, posts: posts)
        #expect(agro.map(\.id) == ["brand:b1"])

        // Caption text matches, with a snippet around the hit.
        let serin = GlobalSearch.results(query: "SERİN yer", brands: brands, conversations: conversations, posts: posts)
        #expect(serin.count == 1)
        guard case .post(let post, let snippet)? = serin.first else { Issue.record("no post hit"); return }
        #expect(post.contentId == "p2")
        #expect(snippet?.contains("serin bir yerde") == true)

        // A title hit outranks a caption hit and carries no snippet.
        let mixed = GlobalSearch.results(
            query: "çinko",
            brands: [], conversations: [],
            posts: posts + [SearchablePost(contentId: "p3", brandId: "b2", title: "Yeni ürün", caption: "Çinko içerir.", updatedAt: .now)]
        )
        #expect(mixed.map(\.id) == ["post:p1", "post:p3"])
        if case .post(_, let first)? = mixed.first { #expect(first == nil) }

        // Every word must match.
        #expect(GlobalSearch.results(query: "kasım hasat", brands: brands, conversations: conversations, posts: posts).isEmpty)
    }

    @Test func emptyQueryListsRecentConversations() {
        let conversations = (0..<10).map { conversation("c\($0)", "Sohbet \($0)", minutesAgo: Double($0)) }
        let results = GlobalSearch.results(query: " ", brands: [brand("b", "B")], conversations: conversations, posts: [])
        #expect(results.count == GlobalSearch.recentConversations)
        #expect(results.first == .conversation(conversations[0]))
    }

    @Test func currentBrandPostsComeFirstOnEqualScore() {
        let old = Date(timeIntervalSinceNow: -3600)
        let posts = [
            SearchablePost(contentId: "other", brandId: "b2", title: "Bayi duyurusu", caption: "", updatedAt: .now),
            SearchablePost(contentId: "mine", brandId: "b1", title: "Bayi buluşması", caption: "", updatedAt: old),
        ]
        let results = GlobalSearch.results(query: "bayi", brands: [], conversations: [], posts: posts, currentBrandId: "b1")
        #expect(results.map(\.id) == ["post:mine", "post:other"])
    }

    @Test func snippetTrimsAroundTheMatch() {
        let text = String(repeating: "a ", count: 60) + "hedef kelime" + String(repeating: " b", count: 60)
        let snippet = GlobalSearch.snippet(text, around: "hedef", radius: 10)
        #expect(snippet?.hasPrefix("…") == true)
        #expect(snippet?.hasSuffix("…") == true)
        #expect(snippet?.contains("hedef") == true)
        #expect(GlobalSearch.snippet("", around: "x") == nil)
    }

    @Test func searchModelLoadsEveryBrandsPosts() async throws {
        let (app, backend, _) = await makeApp()
        await app.search.load()
        var all = 0
        for brand in app.brands { all += try await backend.contents(brandId: brand.id).count }
        #expect(app.search.posts.count == all)
        #expect(all > 0)
        #expect(app.search.postsError == nil)
        #expect(!app.search.isLoadingPosts)

        // A caption-only word finds the post through the palette's search.
        let hits = GlobalSearch.results(query: "güneş almayan", brands: app.brands, conversations: app.conversations, posts: app.search.posts)
        #expect(hits.contains { if case .post(let p, _) = $0 { p.title == "Doğru saklama rehberi" } else { false } })
    }

    @Test func openPostFromSearchSwitchesBrandAndOpensDetail() async throws {
        let (app, _, _) = await makeApp()
        await app.search.load()
        let target = try #require(app.search.posts.first { $0.brandId == SampleData.mtm })
        app.selectBrand("b-finvo")
        await app.openPost(contentId: target.contentId, brandId: target.brandId)
        #expect(app.currentBrandId == SampleData.mtm)
        #expect(app.route == .posts)
        #expect(app.detail?.content.id == target.contentId)
    }
}

// MARK: - Session restoration

@Suite("Session and window restoration")
@MainActor
struct SessionRestoreTests {
    @Test func snapshotRoundTripAndFallbacks() {
        let defaults = UserDefaults(suiteName: "studio.tests.p4.session.\(UUID().uuidString)")!
        let store = SessionStore(defaults: defaults)
        #expect(store.load() == nil)
        let snapshot = SessionSnapshot(route: .conversation("c1"), brandId: "b1", sidebarPresented: false, inspectorPresented: true)
        store.save(snapshot)
        #expect(store.load() == snapshot)
        #expect(snapshot.route(existingConversations: ["c1"]) == .conversation("c1"))
        #expect(snapshot.route(existingConversations: []) == .newChat, "archived conversation falls back")
        #expect(snapshot.brand(existing: ["b2"]) == nil)
        #expect(SessionSnapshot(route: .calendar, brandId: nil, sidebarPresented: true, inspectorPresented: true).route(existingConversations: []) == .calendar)
        store.clear()
        #expect(store.load() == nil)
    }

    @Test func appRestoresLastConversationBrandAndPanels() async throws {
        let (first, _, defaults) = await makeApp()
        first.restoreSession()
        #expect(first.isTrackingSession)
        first.navigate(to: .conversation(SampleData.hasatConversation))
        first.toggleInspector()
        first.toggleSidebar()

        let (second, _, _) = await makeApp(defaults: defaults)
        #expect(!second.sidebarPresented, "panels restore at init, before the window is built")
        #expect(!second.inspectorPresented)
        #expect(second.route == .newChat, "nothing restored before the first load finished")
        second.restoreSession()
        #expect(second.route == .conversation(SampleData.hasatConversation))
        #expect(!second.canGoBack, "restoring is not a navigation")
        #expect(second.currentBrandId == second.conversations.first { $0.id == SampleData.hasatConversation }?.brandId)
    }

    @Test func restoresScreenAndBrandButNotOverAnOwnerNavigation() async throws {
        let (first, _, defaults) = await makeApp()
        first.restoreSession()
        first.selectBrand("b-koc")
        first.navigate(to: .media)

        let (second, _, _) = await makeApp(defaults: defaults)
        second.restoreSession()
        #expect(second.route == .media)
        #expect(second.currentBrandId == "b-koc")

        let (third, _, _) = await makeApp(defaults: defaults)
        third.navigate(to: .posts) // the owner moved while the server was starting
        third.restoreSession()
        #expect(third.route == .posts)
    }

    @Test func sampleDataKeepsItsOwnSessionKey() async throws {
        let (app, _, defaults) = await makeApp()
        app.restoreSession()
        app.navigate(to: .calendar)
        #expect(defaults.data(forKey: SessionStore.key + ".sample") != nil)
        #expect(defaults.data(forKey: SessionStore.key) == nil)
    }

    @Test func savedFrameIsPulledBackOnScreen() {
        let visible = NSRect(x: 0, y: 0, width: 1440, height: 875)
        let min = NSSize(width: 860, height: 560)
        let offscreen = MainWindowController.clamped(NSRect(x: 3000, y: -400, width: 1600, height: 1000), to: visible, minSize: min)
        #expect(visible.contains(offscreen))
        #expect(offscreen.size == NSSize(width: 1440, height: 875))
        let tiny = MainWindowController.clamped(NSRect(x: 10, y: 10, width: 200, height: 100), to: visible, minSize: min)
        #expect(tiny.size == min)
        let fine = NSRect(x: 100, y: 100, width: 1000, height: 700)
        #expect(MainWindowController.clamped(fine, to: visible, minSize: min) == fine)
    }
}

// MARK: - Connection status

@Suite("Connection and server status")
@MainActor
struct ConnectionStatusTests {
    private let signedIn = ClaudeAccount(status: .signedIn, checkedAt: .now)

    @Test func priorityHostThenAPIThenWorkerThenClaude() {
        let online = WorkerPresence(online: true, claude: signedIn)
        #expect(ConnectionIssue.evaluate(isSample: true, hostStatus: .error("x"), loadError: .offline, presence: nil) == nil)
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: .starting("API"), loadError: .offline, presence: nil) == .hostStarting("API"))
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: .error("node bulunamadı"), loadError: nil, presence: online) == .hostFailed("node bulunamadı"))
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: .running, loadError: .offline, presence: online) == .apiUnreachable)
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: nil, loadError: .timedOut, presence: nil) == .apiUnreachable)
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: nil, loadError: .unauthorized(status: 403), presence: nil) == .unauthorized)
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: .running, loadError: nil, presence: nil) == nil, "presence unknown is not offline")
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: .running, loadError: nil, presence: WorkerPresence(online: false)) == .workerOffline)
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: .running, loadError: nil, presence: WorkerPresence(online: true, claude: ClaudeAccount(status: .signedOut, checkedAt: .now))) == .claudeSignedOut)
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: .attached, loadError: nil, presence: online) == nil)
        #expect(ConnectionIssue.evaluate(isSample: false, hostStatus: nil, loadError: .cancelled, presence: online) == nil)
    }

    @Test func everyIssueHasHonestTurkishCopyAndAFix() {
        let issues: [ConnectionIssue] = [.hostStarting("API"), .hostFailed("x"), .apiUnreachable, .unauthorized, .apiError("x"),
                                         .workerOffline, .claudeSignedOut, .claudeSigningIn, .claudeNotInstalled]
        for issue in issues {
            #expect(!issue.message.isEmpty)
            #expect(!issue.shortLabel.isEmpty)
            #expect(issue.isBusy || !issue.actions.isEmpty, "\(issue) needs a way out")
        }
        #expect(ConnectionIssue.apiUnreachable.actions == [.retry])
        #expect(ConnectionIssue.claudeSignedOut.actions == [.signInClaude])
        #expect(ConnectionIssue.hostFailed("x").actions.first == .restartHost)
    }

    @Test func statusSummary() {
        #expect(ServerStatusSummary.make(isSample: true, issue: nil, presence: nil).text == "Örnek veri")
        #expect(ServerStatusSummary.make(isSample: false, issue: nil, presence: nil).text == "Bağlanıyor…")
        #expect(ServerStatusSummary.make(isSample: false, issue: .workerOffline, presence: nil) == ServerStatusSummary(text: "Arka plan çalışmıyor", needsOwner: true))
        #expect(ServerStatusSummary.make(isSample: false, issue: nil, presence: WorkerPresence(online: true, queueLength: 2)).text == "Mac hazır · 2 iş sırada")
    }

    @Test func dismissedIssueStaysHiddenUntilItChanges() async throws {
        let (app, _, _) = await makeApp()
        // Sample data never reports issues.
        #expect(app.connectionIssue == nil)
        app.dismissedIssue = .workerOffline
        #expect(app.visibleConnectionIssue == nil)
    }

    @Test func retryActionReloads() async throws {
        let (app, _, _) = await makeApp()
        app.dismissedIssue = .apiUnreachable
        app.perform(.retry)
        #expect(app.dismissedIssue == nil)
        app.perform(.openSettings)
        #expect(app.settingsPresented)
    }
}

// MARK: - Accessibility and components

@Suite("Accessibility helpers")
@MainActor
struct AccessibilityHelperTests {
    @Test func iconButtonsAreNamedForVoiceOver() {
        #expect(GlyphButton.spokenLabel(fromToolTip: "Ayarlar (⌘,)") == "Ayarlar")
        #expect(GlyphButton.spokenLabel(fromToolTip: "Sağ panel (sol)") == "Sağ panel (sol)", "only shortcut parentheses are dropped")
        let close = GlyphButton(symbol: "xmark")
        #expect(close.accessibilityLabel() == "Kapat")
        let prev = GlyphButton(symbol: "chevron.left")
        prev.toolTip = "Önceki ay (⌘←)"
        #expect(prev.accessibilityLabel() == "Önceki ay")
        let explicit = GlyphButton(symbol: "plus")
        explicit.setAccessibilityLabel("Görsel ekle")
        explicit.toolTip = "Ekle"
        #expect(explicit.accessibilityLabel() == "Görsel ekle", "an explicit label wins over the tooltip")
        #expect(explicit.accessibilityRole() == .button)
    }

    @Test func pillButtonLabelFollowsTitle() {
        let pill = PillButton(title: "Kaydet")
        pill.title = "Kaydediliyor"
        #expect(pill.accessibilityLabel() == "Kaydediliyor")
        var pressed = 0
        let action = PillButton(title: "Yeniden dene") { pressed += 1 }
        #expect(action.accessibilityPerformPress())
        #expect(pressed == 1)
        action.isEnabled = false
        #expect(!action.accessibilityPerformPress())
        #expect(pressed == 1)
    }

    @Test func bannerRetryAndActions() {
        let banner = InlineErrorBannerView(message: "Sunucuya ulaşılamıyor.")
        #expect(banner.actionTitles.isEmpty)
        var retried = false
        banner.onRetry = { retried = true }
        #expect(banner.actionTitles == ["Yeniden dene"])
        banner.actions.first?.handler()
        #expect(retried)
        banner.actions = [BannerAction(title: "Yeniden başlat") {}, BannerAction(title: "Ayarlar…") {}]
        #expect(banner.actionTitles == ["Yeniden başlat", "Ayarlar…"])
        banner.message = "Yeni"
        #expect(banner.accessibilityLabel() == "Yeni")
    }

    @Test func glassBecomesOpaqueWhenTransparencyIsReduced() {
        let tint = NSColor(white: 1, alpha: 0.72)
        #expect(GlassContainerView.effectiveTint(tint, reduceTransparency: false) == tint)
        #expect(GlassContainerView.effectiveTint(tint, reduceTransparency: true)?.alphaComponent == 1)
        #expect(GlassContainerView.effectiveTint(nil, reduceTransparency: true)?.alphaComponent == 1)
        #expect(GlassContainerView.effectiveTint(nil, reduceTransparency: false) == nil)
    }

    @Test func composerPasteIsEnabledForImages() throws {
        let board = NSPasteboard(name: NSPasteboard.Name("studio.tests.p4.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.setString("metin", forType: .string)
        #expect(!ComposerNSTextView.pasteAcceptsImages(action: #selector(NSText.paste(_:)), pasteboard: board, canAttach: true))
        board.clearContents()
        board.setData(try #require(SampleImages.png(seed: "paste")), forType: .png)
        #expect(ComposerNSTextView.pasteAcceptsImages(action: #selector(NSText.paste(_:)), pasteboard: board, canAttach: true))
        #expect(!ComposerNSTextView.pasteAcceptsImages(action: #selector(NSText.paste(_:)), pasteboard: board, canAttach: false))
        #expect(!ComposerNSTextView.pasteAcceptsImages(action: #selector(NSText.copy(_:)), pasteboard: board, canAttach: true))
    }

    @Test func chatConnectionTroubleThreshold() {
        #expect(!ChatViewController.isTroubled(.live))
        #expect(!ChatViewController.isTroubled(.connecting(attempt: 1)))
        #expect(ChatViewController.isTroubled(.connecting(attempt: 3)))
        #expect(ChatViewController.isTroubled(.waiting(failures: 2, retryIn: .seconds(4))))
        #expect(ChatViewController.isTroubled(.polling))
    }
}
