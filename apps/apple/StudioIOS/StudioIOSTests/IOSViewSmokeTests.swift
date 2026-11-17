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
            await exercise(AliasPreviewViewController(model: model, assetId: alias.assetId, alias: alias))
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
}
