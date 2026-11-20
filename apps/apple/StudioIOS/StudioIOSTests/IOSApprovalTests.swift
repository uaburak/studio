import Foundation
import StudioKit
import Testing
import UIKit
@testable import StudioIOS

/// The app model lives as long as the app does; screens hold it `unowned` and finish their async
/// work after a test returns, so the tests keep theirs alive too.
@MainActor private var liveApps: [IOSAppModel] = []

@MainActor
private func makeApp() async -> (IOSAppModel, SampleBackend) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.ios.approvals.\(UUID().uuidString)")!
    let settings = IOSAppSettings(defaults: defaults, tokenStore: InMemoryDeviceTokenStore(), useSampleData: true)
    let app = IOSAppModel(settings: settings, conversationService: backend, dataService: backend, notifier: IOSNotifier(delivering: .silent))
    await app.load()
    liveApps.append(app)
    return (app, backend)
}

@MainActor
private func waitFor(_ condition: () -> Bool, timeout: Double = 3) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline {
        try? await Task.sleep(for: .milliseconds(20))
    }
}

/// "Onay bekleyenler", the chat card's data, `@` names and the post badge on the sample backend.
@Suite("StudioIOS approvals")
@MainActor
struct IOSApprovalTests {
    @Test func loadsPendingAndDecides() async throws {
        let (app, _) = await makeApp()
        #expect(app.approvals.count == 3)
        #expect(app.approvals.pending.first?.id == "apr-tarla")
        #expect(app.approvals.subject(of: app.approvals.records["apr-venta"]!) == "Venta Borinc")
        #expect(app.approvals.subject(of: app.approvals.records["apr-boro"]!) == "Boro")
        // The post shows "Onay bekliyor".
        #expect(app.posts.card("post-01")?.content.waitingApprovals == 1)

        let venta = try #require(app.approvals.records["apr-venta"])
        #expect(await app.approvals.approve(venta, assetId: "asset-aday-venta-2") == nil)
        #expect(app.approvals.count == 2)
        #expect(app.approvals.records["apr-venta"]?.status == .approved)
        await waitFor { app.posts.card("post-01")?.content.waitingApprovals == 0 }
        #expect(app.posts.card("post-01")?.content.waitingApprovals == 0)

        // Deciding again tells what happened instead of a raw error.
        let problem = await app.approvals.reject(venta, note: nil)
        #expect(problem?.contains("Onaylandı") == true)

        let tarla = try #require(app.approvals.records["apr-tarla"])
        #expect(await app.approvals.regenerate(tarla, preserveLabel: true, instructions: "daha sıcak") == nil)
        // The old one is superseded; the new pictures arrive as a new pending request (job feed).
        await waitFor { app.approvals.pending.contains { $0.contentId == "post-06" && $0.id != "apr-tarla" } }
        #expect(app.approvals.records["apr-tarla"]?.status == .superseded)
        #expect(app.approvals.pending.contains { $0.contentId == "post-06" && $0.id != "apr-tarla" })
    }

    @Test func chatCardsReadTheirRequests() async throws {
        let (app, _) = await makeApp()
        let chat = app.conversationModel(SampleData.gorselConversation)
        await waitFor { !chat.messages.isEmpty }
        let ids = chat.messages.flatMap(\.approvalIds)
        #expect(ids == ["apr-venta", "apr-tarla"])
        // A card for a request the list does not hold reads it once.
        app.approvals.reset()
        #expect(app.approvals.approval("apr-venta") == nil)
        await waitFor { app.approvals.records["apr-venta"] != nil }
        #expect(app.approvals.approval("apr-venta")?.kind == .productImage)
        #expect(app.approvals.approval("missing") == nil)
        await waitFor { app.approvals.isMissing("missing") }
        #expect(app.approvals.isMissing("missing"))

        // The card builds for every status.
        var approval = try #require(app.approvals.records["apr-venta"])
        for status in [ApprovalStatus.pending, .approved, .rejected, .superseded] {
            approval.status = status
            let view = ApprovalViews.card(approval, app: app, host: { nil })
            #expect(view is IOSCardView)
        }
    }

    @Test func composerOffersProductsAndPosts() async throws {
        let (app, _) = await makeApp()
        #expect(app.mentionCandidates.contains { $0.slug == "venta-borinc" && $0.kind == .product })
        let chat = app.conversationModel(SampleData.hasatConversation)
        await waitFor { chat.state != nil }
        chat.refreshComposerState()
        chat.composer.text = "@ven"
        chat.composer.caret = 4
        #expect(chat.composer.suggestions.first?.entity?.slug == "venta-borinc")
        let first = try #require(chat.composer.suggestions.first)
        chat.composer.choose(first)
        #expect(chat.composer.text == "@venta-borinc ")
        // File aliases still come first for their own names.
        chat.composer.text = "@ima"
        chat.composer.caret = 4
        #expect(chat.composer.suggestions.first?.alias == "image")
        #expect(chat.composer.suggestions.first?.entity == nil)
    }

    @Test func sentEntityMentionsAreLinks() {
        let mention = MessageEntityMention(kind: .content, id: "post-01", name: "venta-borinc-2", start: 4, end: 19)
        let text = ChatText.user("Bak @venta-borinc-2 olsun", mentions: [], entityMentions: [mention], aliases: [])
        let link = text.attribute(.link, at: 5, effectiveRange: nil) as? URL
        #expect(link?.absoluteString == "studio-entity://content/post-01")
        #expect(text.string == "Bak @venta-borinc-2 olsun")
    }

    @Test func routesAndScreen() async throws {
        let (app, _) = await makeApp()
        #expect(IOSRoute.approvals(contentId: nil) != .approvals(contentId: "post-01"))
        let screen = IOSApprovalsViewController(app: app)
        screen.loadViewIfNeeded()
        await waitFor { app.approvals.hasLoaded }
        #expect(screen.contentId == nil)
        let one = IOSApprovalsViewController(app: app, contentId: "post-01")
        one.loadViewIfNeeded()
        #expect(one.title == "Onay bekleyenler")

        let root = StudioRootViewController(app: app)
        root.loadViewIfNeeded()
        root.follow(.approvals(contentId: nil))
        #expect(root.mainNav.topViewController is IOSApprovalsViewController)
        root.follow(.conversationMessage(SampleData.gorselConversation, messageId: "m-g2"))
        #expect(root.chat?.model.id == SampleData.gorselConversation)
    }

    @Test func brandEngineAndStyle() async throws {
        let (app, backend) = await makeApp()
        let saved = try await backend.updateBrand(SampleData.mtm, .engine(.html))
        #expect(saved.defaultEngine == .html)
        let asks = try await backend.updateBrand(SampleData.mtm, .engine(nil))
        #expect(asks.defaultEngine == nil)
        let styled = try await backend.updateBrand(SampleData.mtm, BrandUpdate(imageStylePreset: "vintage"))
        #expect(styled.imageStylePreset == "vintage")
        #expect(BrandProfileViewController.styleValue(nil) == "Yok")
        #expect(BrandProfileViewController.styleValue(String(repeating: "a", count: 40)).count == 24)
        _ = app
    }
}
