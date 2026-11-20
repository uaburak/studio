import StudioKit
import Testing
import UIKit
@testable import StudioIOS

/// Builds every screen off screen on sample data and lays it out (no window, no UI
/// automation): catches crashes in view setup, diffable snapshots and observation passes.
@Suite("StudioIOS screens build and lay out")
@MainActor
struct IOSViewSmokeTests {
    private func makeApp() async -> IOSAppModel {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let defaults = UserDefaults(suiteName: "studio.ios.smoke.\(UUID().uuidString)")!
        let settings = IOSAppSettings(defaults: defaults, tokenStore: InMemoryDeviceTokenStore(), useSampleData: true)
        let app = IOSAppModel(settings: settings, conversationService: backend, dataService: backend, notifier: IOSNotifier(delivering: .silent))
        await app.load()
        app.posts.month = MonthKey(year: 2026, month: 11)
        await app.posts.load()
        return app
    }

    /// Load, size like an iPhone 17, let observation passes run, lay out again.
    @discardableResult
    private func exercise(_ controller: UIViewController, nav: Bool = true) async -> UIViewController {
        let host: UIViewController = nav ? UINavigationController(rootViewController: controller) : controller
        host.loadViewIfNeeded()
        host.view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        controller.loadViewIfNeeded()
        controller.viewWillAppear(false)
        host.view.layoutIfNeeded()
        for _ in 0..<10 {
            try? await Task.sleep(for: .milliseconds(20))
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
        }
        #expect(controller.view.subviews.isEmpty == false)
        return host
    }

    @Test func rootDrawerAndRoutes() async {
        let app = await makeApp()
        let root = StudioRootViewController(app: app)
        root.loadViewIfNeeded()
        root.view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        root.view.layoutIfNeeded()
        #expect(root.chat?.model.isNew == true)
        #expect(root.mainNav.viewControllers.count == 1)

        app.open(.post("post-01"))
        for _ in 0..<50 where !(root.mainNav.topViewController is IOSPostDetailViewController) {
            try? await Task.sleep(for: .milliseconds(20))
        }
        #expect(app.pendingRoute == nil)
        #expect(root.mainNav.topViewController is IOSPostDetailViewController)
        #expect(root.mainNav.viewControllers.first is IOSChatViewController)

        app.open(.conversation("c-kasim"))
        for _ in 0..<50 where root.chat?.model.id != "c-kasim" { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(root.chat?.model.id == "c-kasim")
        #expect(root.mainNav.viewControllers.count == 1)
    }

    @Test func chatScreens() async throws {
        let app = await makeApp()
        await exercise(DrawerViewController(app: app), nav: false)
        let model = app.conversationModel("c-kasim")
        for _ in 0..<50 where model.state == nil { try? await Task.sleep(for: .milliseconds(20)) }
        let chat = IOSChatViewController(model: model)
        await exercise(chat)
        model.expandedPlans = Set(model.state?.plans.map(\.id) ?? [])
        model.composer.text = "@ima"
        model.composer.caret = 4
        try? await Task.sleep(for: .milliseconds(60))
        chat.view.layoutIfNeeded()

        let bayi = app.conversationModel("c-bayi")
        for _ in 0..<50 where bayi.state == nil { try? await Task.sleep(for: .milliseconds(20)) }
        await exercise(IOSChatViewController(model: bayi))
        await exercise(IOSChatViewController(model: app.newConversationModel()))
        await exercise(UsageSheetViewController(app: app, presence: { app.presence }))
        if let alias = model.state?.aliases.first {
            let items = (model.state?.aliases ?? []).map { PhotoViewerItem(assetId: $0.assetId, title: "@\($0.alias)", subtitle: $0.filename, aspect: nil) }
            await exercise(PhotoViewerViewController(images: app.images, items: items, index: 0, sourceFor: { _ in nil }))
        }
    }

    @Test func postScreens() async throws {
        let app = await makeApp()
        await exercise(IOSPostsViewController(app: app))
        for id in ["post-01", "post-02a", "post-07", "post-12a"] {
            let card = try #require(app.posts.card(id))
            let detail = IOSPostDetailViewController(app: app, card: card)
            await exercise(detail)
            detail.session.selectedLayerId = detail.session.editableLayers.first?.layerId
            try? await Task.sleep(for: .milliseconds(60))
            await exercise(CaptionEditorViewController(session: detail.session))
            await exercise(ScheduleSheetViewController(app: app, session: detail.session))
        }
        await exercise(LayerTextEditorViewController(text: "Başlık") { _ in })

        // A tile opens its tab like Instagram: the feed, Reels, stories (starting mid-list).
        let cards = app.posts.board.cards
        for type in [ContentType.post, .reel, .story] {
            let ids = cards.filter { type == .post ? ($0.content.type != .reel && $0.content.type != .story) : $0.content.type == type }.map(\.id)
            guard let start = ids.dropFirst().first ?? ids.first else { continue }
            let page: PostZoomPage = switch type {
            case .reel: PostReelsViewController(app: app, ids: ids, start: start, sourceFor: { _ in nil })
            case .story: PostStoryViewController(app: app, ids: ids, start: start, sourceFor: { _ in nil })
            default: PostFeedViewController(app: app, ids: ids, start: start, sourceFor: { _ in nil })
            }
            await exercise(page)
            let container = UIView(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
            #expect(page.pictureRect(in: container).width > 0)
            page.setContentHidden(true)
            page.setZoomProgress(0)
            page.setContentHidden(false)
            page.setZoomProgress(1)
            #expect(page.currentSource() == nil)
        }
    }

    @Test func feedCaptionCutsToThreeLines() {
        let long = String(repeating: "Toprağın verimi tohumla başlar. ", count: 20)
        let (cut, truncated) = PostFeedCell.caption(brand: "MTM Agro", text: long, width: 360, expanded: false)
        #expect(truncated)
        #expect(cut.string.hasPrefix("MTM Agro "))
        #expect(cut.string.hasSuffix("… devamı"))
        let (open, openTruncated) = PostFeedCell.caption(brand: "MTM Agro", text: long, width: 360, expanded: true)
        #expect(!openTruncated)
        #expect(open.string == "MTM Agro " + long)
        let (short, shortTruncated) = PostFeedCell.caption(brand: "MTM Agro", text: "Kısa.", width: 360, expanded: false)
        #expect(!shortTruncated)
        #expect(short.string == "MTM Agro Kısa.")
    }

    @Test func calendarBrandsAndSettings() async throws {
        let app = await makeApp()
        await app.calendar.load()
        let calendar = IOSCalendarViewController(app: app)
        await exercise(calendar)
        app.calendar.mode = .list
        try? await Task.sleep(for: .milliseconds(40))
        calendar.view.layoutIfNeeded()
        if let entry = app.calendar.entries.first {
            await exercise(RescheduleViewController(entry: entry) { _ in })
        }
        await exercise(IOSSettingsViewController(app: app))
        await exercise(JobsViewController(app: app))
        await exercise(BrandsViewController(app: app))
        await exercise(BrandProfileViewController(app: app, brandId: SampleData.mtm))
        await exercise(PairingSheetViewController(app: app, baseURL: URL(string: "http://192.168.1.10:8791"), serverName: "Mac") {})
        await exercise(PairingSheetViewController(app: app) {})
        await exercise(IOSAdvancedConnectionViewController(app: app))
        await exercise(PairingScannerViewController(app: app))
        await exercise(TextReaderViewController(title: "DESIGN.md", text: "# Başlık\n\nMetin"))
    }

    /// Every section of a brand's page and the sheets and lists it opens.
    @Test func brandPageSectionsAndSheets() async throws {
        let app = await makeApp()
        let page = BrandProfileViewController(app: app, brandId: SampleData.mtm)
        await exercise(page)
        await page.model.load()
        #expect(page.model.skills.count == 2)
        #expect(page.model.templates.count == 2)
        #expect(page.model.kit?.palette.isEmpty == false)
        for tab in BrandTab.allCases {
            page.show(tab)
            page.view.layoutIfNeeded()
            #expect(page.currentTab == tab)
            #expect(page.body.arrangedSubviews.isEmpty == false, "\(tab)")
        }
        let model = page.model
        let template = try #require(model.templates.first)
        let skill = try #require(model.skills.first)
        let kit = try #require(model.kit)
        await exercise(BrandSkillViewController(model: model, skillId: skill.id))
        await exercise(BrandSkillViewController(model: model, skillId: nil))
        await exercise(BrandChecksViewController(model: model))
        await exercise(BrandSpecialDaysViewController(model: model))
        await exercise(TemplateUseViewController(app: app, model: model, template: template))
        await exercise(TemplateSettingsViewController(model: model, template: template))
        await exercise(BrandMediaPickerViewController(app: app, brandId: SampleData.mtm, selected: nil) { _ in })
        await exercise(BrandFormViewController(mode: .create) { _, _, _ in nil })
        await exercise(BrandColorEditorViewController(color: kit.palette.first, defaultName: "renk-1") { _ in })
        await exercise(BrandFontEditorViewController(font: BrandKitFont(source: .system, assetId: nil, family: "Avenir Next"), fileName: nil, preview: nil) { _ in })
        await exercise(BrandTextEditorViewController(title: "Notlar", text: "", placeholder: "Not") { _ in nil })
        await exercise(BrandDayPickerViewController(title: "2027 Ramazan Bayramı", date: Date(), year: 2027, corrected: true) { _ in })

        // Saved as you go: a colour added on the phone reaches the backend.
        model.changeKit { $0.palette.append(BrandKitColor(name: "yeni-renk", hex: "#123456")) }
        model.flushKit()
        try? await Task.sleep(for: .milliseconds(100))
        let saved = try await app.dataService.brandKit(brandId: SampleData.mtm)
        #expect(saved.palette.contains { $0.name == "yeni-renk" })
    }
}
