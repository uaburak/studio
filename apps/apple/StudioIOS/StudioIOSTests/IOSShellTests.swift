import StudioKit
import Testing
import UIKit
@testable import StudioIOS

/// Hidden test windows stay alive for the rest of the run (they own the roots).
@MainActor private var keptWindows: [UIWindow] = []

/// The Claude-style shell: the chat as root, the drawer, pages pushed from it, the
/// composer, the greeting. Off screen, on sample data; no window, no UI automation.
@Suite("StudioIOS shell (chat root + drawer)")
@MainActor
struct IOSShellTests {
    private func makeApp(uploadDelay: Duration = .zero) async -> IOSAppModel {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: uploadDelay)
        let defaults = UserDefaults(suiteName: "studio.ios.shell.\(UUID().uuidString)")!
        let settings = IOSAppSettings(defaults: defaults, tokenStore: InMemoryDeviceTokenStore(), useSampleData: true)
        let app = IOSAppModel(settings: settings, conversationService: backend, dataService: backend, notifier: IOSNotifier(delivering: .silent))
        await app.load()
        app.posts.month = MonthKey(year: 2026, month: 11)
        await app.posts.load()
        return app
    }

    /// A root sized like an iPhone 17 in a hidden window (the keyboard layout guide needs
    /// one), laid out, with observation passes run. Nothing is shown or captured.
    private func makeRoot(_ app: IOSAppModel) async -> StudioRootViewController {
        let root = StudioRootViewController(app: app)
        let frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            let window = UIWindow(windowScene: scene)
            window.frame = frame
            window.rootViewController = root
            window.isHidden = true
            keptWindows.append(window)
        }
        root.loadViewIfNeeded()
        root.view.frame = frame
        await settle(root.view)
        return root
    }


    private func settle(_ view: UIView, passes: Int = 6) async {
        view.layoutIfNeeded()
        for _ in 0..<passes {
            try? await Task.sleep(for: .milliseconds(20))
            view.setNeedsLayout()
            view.layoutIfNeeded()
        }
    }

    private func waitUntil(_ condition: () -> Bool, timeout: Double = 3) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    /// Views (ours, not UIKit's private ones) whose Auto Layout position is ambiguous.
    private func ambiguousViews(in root: UIView) -> [String] {
        var found: [String] = []
        func walk(_ view: UIView) {
            guard !view.isHidden else { return }
            let name = NSStringFromClass(type(of: view))
            if !name.hasPrefix("_"), view.hasAmbiguousLayout {
                found.append("\(name) \(view.frame)")
            }
            view.subviews.forEach(walk)
        }
        walk(root)
        return found
    }

    private func titles(_ elements: [UIMenuElement]) -> [String] {
        elements.flatMap { element -> [String] in
            if let menu = element as? UIMenu { return [menu.title] + titles(menu.children) }
            return [element.title]
        }.filter { !$0.isEmpty }
    }

    // MARK: Greeting

    @Test func greetingByHour() {
        let expected: [(ClosedRange<Int>, StudioGreeting.Period)] = [(0...4, .night), (5...11, .morning), (12...17, .afternoon), (18...21, .evening), (22...23, .night)]
        for (hours, period) in expected {
            for hour in hours { #expect(StudioGreeting.period(hour: hour) == period, "saat \(hour)") }
        }
        #expect(StudioGreeting.text(hour: 8, name: "Burak") == "Günaydın, Burak")
        #expect(StudioGreeting.text(hour: 8, name: "Burak", variant: 1) == "Güne nereden başlayalım, Burak?")
        #expect(StudioGreeting.text(hour: 14, name: "Burak") == "İyi günler, Burak")
        #expect(StudioGreeting.text(hour: 19, name: "Burak") == "İyi akşamlar, Burak")
        #expect(StudioGreeting.text(hour: 20, name: nil) == "İyi akşamlar")
        #expect(StudioGreeting.text(hour: 0, name: "Burak") == "Gece mesaisi mi, Burak?")
        #expect(StudioGreeting.text(hour: 3, name: "  ") == "Gece mesaisi mi?")
        for hour in 0..<24 {
            for variant in 0..<4 {
                #expect(StudioGreeting.text(hour: hour, name: "Burak", variant: variant).contains("Burak"))
                let anonymous = StudioGreeting.text(hour: hour, name: nil, variant: variant)
                #expect(!anonymous.hasSuffix(",") && !anonymous.contains(",?") && !anonymous.contains(" ,"), "\(anonymous)")
            }
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let lateNight = calendar.date(from: DateComponents(year: 2026, month: 11, day: 17, hour: 0, minute: 28))!
        #expect(StudioGreeting.period(hour: calendar.component(.hour, from: lateNight)) == .night)
        #expect(StudioGreeting.text(at: lateNight, name: "Burak", calendar: calendar).contains("Burak"))

        #expect(StudioGreeting.ownerName(fromMacName: "Burak MacBook Pro") == "Burak")
        #expect(StudioGreeting.ownerName(fromMacName: "Burak’s MacBook Air") == "Burak")
        #expect(StudioGreeting.ownerName(fromMacName: "Burak's Mac mini") == "Burak")
        #expect(StudioGreeting.ownerName(fromMacName: "Burak adlı kişinin MacBook Pro’su") == "Burak")
        #expect(StudioGreeting.ownerName(fromMacName: "MacBook Pro (Burak)") == "Burak")
        #expect(StudioGreeting.ownerName(fromMacName: "burak-MacBook-Pro") == "Burak")
        #expect(StudioGreeting.ownerName(fromMacName: "Studio Mac") == nil)
        #expect(StudioGreeting.ownerName(fromMacName: "MacBook Pro") == nil)
        #expect(StudioGreeting.ownerName(fromMacName: "iMac") == nil)
    }

    // MARK: Drawer

    @Test func drawerOpensAndCloses() async {
        let app = await makeApp()
        let root = await makeRoot(app)
        let width = root.drawerWidth
        #expect(width == DrawerMath.width(for: 402))
        #expect(!root.isDrawerOpen)
        #expect(root.drawer.view.isHidden)
        #expect(root.mainNav.view.superview?.transform.tx == 0)

        // The hamburger opens it: the chat slides right and is dimmed.
        root.chat?.onOpenDrawer?()
        #expect(root.isDrawerOpen)
        #expect(root.drawerProgress == 1)
        #expect(!root.drawer.view.isHidden)
        #expect(root.mainNav.view.superview?.transform.tx == width)
        #expect(root.mainNav.view.accessibilityElementsHidden)
        #expect(!root.drawer.view.accessibilityElementsHidden)

        // Tapping the dimmed chat closes it.
        let scrim = root.mainNav.view.superview?.subviews.last as? UIControl
        #expect(scrim != nil)
        scrim?.sendActions(for: .touchUpInside)
        #expect(!root.isDrawerOpen)
        #expect(root.drawerProgress == 0)
        #expect(root.mainNav.view.superview?.transform.tx == 0)
        #expect(!root.mainNav.view.accessibilityElementsHidden)

        // VoiceOver escape closes it too.
        root.setDrawer(open: true, animated: false)
        #expect(root.accessibilityPerformEscape())
        #expect(!root.isDrawerOpen)

        // On a pushed page the edge swipe is the back gesture: the drawer stays shut.
        root.show(.posts)
        root.setDrawer(open: true, animated: false)
        #expect(!root.isDrawerOpen)

        // Dragging: progress follows the finger, a flick decides.
        #expect(DrawerMath.progress(start: 0, translation: width / 2, width: width) == 0.5)
        #expect(DrawerMath.progress(start: 1, translation: -2 * width, width: width) == 0)
        #expect(DrawerMath.settlesOpen(progress: 0.3, velocity: 800))
        #expect(!DrawerMath.settlesOpen(progress: 0.8, velocity: -800))
        #expect(DrawerMath.settlesOpen(progress: 0.6, velocity: 0))
        #expect(!DrawerMath.settlesOpen(progress: 0.4, velocity: 0))
        #expect(DrawerMath.width(for: 402) == 310)
        #expect(DrawerMath.width(for: 1024) == 360)
    }

    @Test func everyFormerTabIsReachableFromTheDrawer() async throws {
        let app = await makeApp()
        let root = await makeRoot(app)
        let drawer = root.drawer
        #expect(IOSDestination.drawerRows == [.posts, .calendar, .brands, .jobs])

        for destination in IOSDestination.allCases {
            root.setDrawer(open: true, animated: false)
            #expect(root.isDrawerOpen)
            drawer.select(.destination(destination))
            #expect(!root.isDrawerOpen, "\(destination)")
            let top = try #require(root.mainNav.topViewController)
            #expect(destination.isShown(by: top), "\(destination) → \(type(of: top))")
            #expect(root.mainNav.viewControllers.count == 2)
            #expect(root.mainNav.viewControllers.first is IOSChatViewController)
            top.loadViewIfNeeded()
            top.view.frame = root.view.bounds
            await settle(top.view, passes: 3)
            #expect(top.view.subviews.isEmpty == false)
            root.mainNav.popToRootViewController(animated: false)
        }

        // Postlar → a post (back returns to the grid), Markalar → a profile.
        app.open(.posts)
        await waitUntil { root.mainNav.topViewController is IOSPostsViewController }
        app.open(.post("post-02a"))
        await waitUntil { root.mainNav.topViewController is IOSPostDetailViewController }
        #expect(root.mainNav.viewControllers.map { String(describing: type(of: $0)) } == ["IOSChatViewController", "IOSPostsViewController", "IOSPostDetailViewController"])

        app.open(.brand(SampleData.mtm))
        await waitUntil { root.mainNav.topViewController is BrandProfileViewController }
        #expect((root.mainNav.topViewController as? BrandProfileViewController)?.brandId == SampleData.mtm)
        #expect(root.mainNav.viewControllers.count == 3)

        app.open(.calendar)
        await waitUntil { root.mainNav.topViewController is IOSCalendarViewController }
        #expect(root.mainNav.viewControllers.count == 2)

        // History rows open conversations at the root; "Yeni sohbet" returns home.
        drawer.select(.conversation("c-bayi"))
        #expect(root.chat?.model.id == "c-bayi")
        #expect(root.mainNav.viewControllers.count == 1)
        drawer.onNewChat?()
        #expect(root.chat?.model.isNew == true)
        let home = try #require(root.chat)
        app.open(.newConversation)
        await waitUntil { app.pendingRoute == nil }
        #expect(root.chat === home, "an empty new chat on screen is kept")
    }

    @Test func drawerListsSearchesAndShowsState() async throws {
        let app = await makeApp()
        let root = await makeRoot(app)
        let drawer = root.drawer
        root.setDrawer(open: true, animated: false)
        await settle(root.view)
        #expect(drawer.listedConversations.map(\.id) == app.visibleConversations.map(\.id))
        #expect(drawer.tableView.numberOfSections == 2)
        // The brand row, then the pages.
        #expect(drawer.tableView.numberOfRows(inSection: 0) == 1 + IOSDestination.drawerRows.count)
        #expect(drawer.tableView.numberOfRows(inSection: 1) == max(1, app.visibleConversations.count))

        // Tapping the brand row opens the brand list in place; picking one closes it.
        drawer.select(.brandPicker)
        await settle(root.view)
        #expect(drawer.brandsExpanded)
        let extra = app.brands.count + (app.currentBrandId != nil ? 1 : 0)
        #expect(drawer.tableView.numberOfRows(inSection: 0) == 1 + extra + IOSDestination.drawerRows.count)
        if let other = app.brands.first(where: { $0.id != app.currentBrandId }) {
            drawer.select(.brandOption(other.id))
            await settle(root.view)
            #expect(app.currentBrandId == other.id)
            #expect(!drawer.brandsExpanded)
        } else {
            drawer.select(.brandPicker)
            await settle(root.view)
        }
        #expect(drawer.tableView.numberOfRows(inSection: 0) == 1 + IOSDestination.drawerRows.count)

        let title = try #require(app.visibleConversations.first?.displayTitle)
        let word = try #require(title.split(separator: " ").first.map(String.init))
        drawer.search(word.uppercased(with: Locale(identifier: "tr_TR")))
        await settle(root.view, passes: 2)
        #expect(drawer.isSearching)
        #expect(drawer.tableView.numberOfRows(inSection: 0) == 0)
        #expect(drawer.listedConversations.contains { $0.displayTitle == title })
        drawer.search("zzz-yok")
        #expect(drawer.listedConversations.isEmpty)
        #expect(drawer.tableView.numberOfRows(inSection: 1) == 1)
        drawer.setSearching(false)
        #expect(drawer.query.isEmpty)
        #expect(drawer.listedConversations.count == app.visibleConversations.count)

        let now = Date()
        let samples = ["Kasım planı", "IŞIK kampanyası", "Bayi duyurusu", "Yeni ürün: Çinko"].enumerated().map { index, title in
            Conversation(id: "s\(index)", brandId: nil, title: title, lastActivityAt: now, createdAt: now, updatedAt: now)
        }
        #expect(ConversationSearch.filter(samples, query: "kasim").map(\.id) == ["s0"])
        #expect(ConversationSearch.filter(samples, query: "ışık").map(\.id) == ["s1"])
        #expect(ConversationSearch.filter(samples, query: "isik").map(\.id) == ["s1"])
        #expect(ConversationSearch.filter(samples, query: "BAYİ").map(\.id) == ["s2"])
        #expect(ConversationSearch.filter(samples, query: "ürün çinko").map(\.id) == ["s3"])
        #expect(ConversationSearch.filter(samples, query: "  ").count == 4)

        // Layout of the open drawer and the root has no ambiguous constraints.
        #expect(ambiguousViews(in: root.view).isEmpty, "\(ambiguousViews(in: root.view))")
    }

    // MARK: Chat screen

    @Test func homeAndConversationChrome() async throws {
        let app = await makeApp()
        app.settings.ownerName = "Burak"
        let root = await makeRoot(app)
        let home = try #require(root.chat)
        await settle(root.view)
        #expect(!home.home.isHidden)
        #expect(home.home.greetingLabel.text == StudioGreeting.text(at: Date(), name: "Burak"))
        #expect(home.navigationItem.leftBarButtonItem === home.drawerItem)
        #expect(home.navigationItem.rightBarButtonItems?.count == 1)
        #expect(home.navigationItem.rightBarButtonItems?.first === home.brandItem)
        let homeMenu = titles(home.homeMenu())
        for expected in ["Marka", "Model", "Düşünme", "Kullanım ve durum"] {
            #expect(homeMenu.contains(expected), "\(expected) in \(homeMenu)")
        }
        #expect(home.composer.interactions.contains { $0 is UIScrollEdgeElementContainerInteraction })
        #expect(ambiguousViews(in: root.view).isEmpty, "\(ambiguousViews(in: root.view))")

        root.showConversation("c-kasim")
        let chat = try #require(root.chat)
        await waitUntil { chat.model.state != nil }
        await settle(root.view)
        #expect(chat.home.isHidden)
        #expect(chat.navigationItem.rightBarButtonItems?.count == 2)
        #expect(chat.navigationItem.rightBarButtonItems?.contains { $0 === chat.newChatItem } == true)
        let menu = titles(chat.conversationMenu())
        for expected in ["Marka", "Model", "Düşünme", "Kullanım ve durum", "Kullanımı sor (/usage)", "Yeniden adlandır", "Sohbeti paylaş", "Arşivle"] {
            #expect(menu.contains(expected), "\(expected) in \(menu)")
        }
        #expect(chat.transcript().contains("Sen: "))
        #expect(ambiguousViews(in: root.view).isEmpty, "\(ambiguousViews(in: root.view))")
    }

    @Test func composerSendAndAttachStates() async throws {
        #expect(ComposerPrimaryAction.resolve(hasContent: false, canSend: false, isSending: false, isRunning: false) == .idle)
        #expect(ComposerPrimaryAction.resolve(hasContent: true, canSend: true, isSending: false, isRunning: false) == .send(enabled: true))
        #expect(ComposerPrimaryAction.resolve(hasContent: true, canSend: false, isSending: false, isRunning: false) == .send(enabled: false))
        #expect(ComposerPrimaryAction.resolve(hasContent: true, canSend: true, isSending: true, isRunning: false) == .sending)
        #expect(ComposerPrimaryAction.resolve(hasContent: true, canSend: true, isSending: false, isRunning: true) == .stop)
        #expect(!ComposerPrimaryAction.send(enabled: false).isEnabled)
        #expect(!ComposerPrimaryAction.idle.isVisible && ComposerPrimaryAction.stop.isEnabled)
        #expect(ComposerPrimaryAction.send(enabled: true).symbol == "arrow.up")

        let app = await makeApp(uploadDelay: .milliseconds(400))
        let root = await makeRoot(app)
        let chat = try #require(root.chat)
        let composer = chat.composer
        let model = chat.model
        await settle(root.view, passes: 2)
        // At rest: one row with + and the mic only; no second voice button.
        #expect(composer.primaryAction == .idle)
        #expect(composer.primaryButton.isHidden)
        #expect(!composer.micButton.isHidden && !composer.attachButton.isHidden)
        #expect(!composer.isExpanded && composer.modelButton.isHidden)

        // Attaching: photos, files, paste (camera only on a device).
        let attach = titles(composer.attachMenu().children)
        #expect(attach.contains("Fotoğraflar") && attach.contains("Dosyalar") && attach.contains("Panodan yapıştır"))
        #expect(attach.contains("Kamera") == ImagePicking.cameraAvailable)

        // Typing turns the primary button into send.
        model.composer.text = "Kasım için 3 hikaye öner"
        await settle(root.view, passes: 2)
        #expect(composer.primaryAction == .send(enabled: true))
        #expect(composer.primaryButton.accessibilityLabel == "Gönder")
        #expect(!composer.primaryButton.isHidden)
        // Text opens the two-row layout with the model pill.
        #expect(composer.isExpanded && !composer.modelButton.isHidden)
        #expect(composer.modelButton.accessibilityValue?.contains(model.selection.model.displayName) == true)

        // An image still uploading blocks sending.
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 50)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 50))
        }
        model.composer.add([image])
        await settle(root.view, passes: 2)
        #expect(model.composer.isUploading)
        #expect(composer.primaryAction == .send(enabled: false))
        #expect(!composer.primaryButton.isEnabled)
        await waitUntil { !model.composer.isUploading }
        await settle(root.view, passes: 2)
        #expect(composer.primaryAction == .send(enabled: true))

        // Sending makes the new chat a conversation and the primary button stops the run.
        composer.primaryButton.sendActions(for: .touchUpInside)
        await waitUntil { model.id != nil && model.composer.isEmpty }
        #expect(model.id != nil)
        await settle(root.view, passes: 3)
        #expect(composer.primaryAction == (model.activeRun != nil ? .stop : .idle))
        #expect(!composer.textView.isFirstResponder)
        #expect(chat.navigationItem.rightBarButtonItems?.count == 2)

        // Without a brand, + explains why and offers the brands page.
        app.currentBrandId = nil
        let brandless = app.newConversationModel()
        let brandlessComposer = ChatComposerView(model: brandless)
        let menu = brandlessComposer.attachMenu()
        #expect(menu.title.contains("marka"))
        let pick = try #require(menu.children.first as? UIAction)
        #expect(pick.title == "Marka seç")
        UIButton().sendAction(pick)
        #expect(app.pendingRoute == .brands)
    }

    @Test func messagesReadLikeABook() throws {
        let text = ChatText.assistant("# Başlık\nİlk paragraf **kalın** ve `kod`.\n\n- Birinci madde uzun bir cümle\n2. İkinci\n```\nlet x = 1\n```\nSon.", aliases: [])
        let string = text.string as NSString
        #expect(!text.string.hasSuffix("\n"))
        #expect(!text.string.contains("**") && !text.string.contains("```") && !text.string.contains("# "))

        let body = try #require(text.attribute(.font, at: string.range(of: "İlk").location, effectiveRange: nil) as? UIFont)
        // New York (the system serif), not SF.
        #expect(body.fontName == IOSTheme.serif(ChatText.bodySize).fontName, "\(body.fontName)")
        #expect(IOSTheme.serif(17).fontName != IOSTheme.font(17).fontName)
        let heading = try #require(text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        #expect(heading.fontDescriptor.symbolicTraits.contains(.traitBold))
        #expect(heading.pointSize > body.pointSize)

        let bullet = try #require(text.attribute(.paragraphStyle, at: string.range(of: "Birinci").location, effectiveRange: nil) as? NSParagraphStyle)
        #expect(bullet.headIndent >= 20, "hanging indent")
        #expect(bullet.firstLineHeadIndent < bullet.headIndent)
        #expect(string.range(of: "•\tBirinci").location != NSNotFound)
        #expect(string.range(of: "2.\tİkinci").location != NSNotFound)
        let paragraph = try #require(text.attribute(.paragraphStyle, at: string.range(of: "İlk").location, effectiveRange: nil) as? NSParagraphStyle)
        #expect(paragraph.lineSpacing >= 4)

        #expect(MessageSpeaker.speakable("## Başlık\n- **Kalın** madde\n[bağlantı](https://x.y)\n```\nkod\n```\nSon") == "Başlık\nKalın madde\nbağlantı\nSon")
    }

    @Test func chatMessageViewsLayOutWithoutAmbiguity() async throws {
        let app = await makeApp()
        let root = await makeRoot(app)
        for id in ["c-kasim", "c-bayi"] {
            root.showConversation(id)
            let chat = try #require(root.chat)
            await waitUntil { chat.model.state != nil }
            // Open every tool-step group so the expanded rows lay out too.
            for message in chat.model.messages {
                for group in 0..<4 { chat.model.expandedSteps.insert("\(message.id):\(group)") }
            }
            await settle(root.view)
            #expect(ambiguousViews(in: root.view).isEmpty, "\(id): \(ambiguousViews(in: root.view))")
        }
    }
}
