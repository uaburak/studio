import AppKit
import StudioKit
import Testing
@testable import StudioMac

@MainActor
private func makeApp() async -> (AppModel, SampleBackend) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.tests.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return (app, backend)
}

@MainActor
private func image(_ seed: String) throws -> ImportedImage {
    try ImageImport.from(data: try #require(SampleImages.png(seed: seed)), filename: "\(seed).png")
}

@MainActor
private func waitUntil(_ condition: () -> Bool, timeout: Double = 3) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
}

@Suite("App models with the sample backend")
@MainActor
struct AppModelTests {
    @Test func loadsBrandsConversationsAndGroupsTheSidebar() async throws {
        let (app, _) = await makeApp()
        #expect(app.brands.count == 4)
        #expect(app.currentBrandId == SampleData.mtm)
        #expect(app.sidebarBrands.first?.id == SampleData.mtm)
        #expect(app.conversations(of: SampleData.mtm).map(\.title) == ["Kasım planı", "Venta Borinc lansmanı", "Hasat sezonu serisi", "Bayi duyurusu"])
        #expect(app.expandedBrands == [SampleData.mtm])
    }

    @Test func navigationHistory() async throws {
        let (app, _) = await makeApp()
        app.navigate(to: .conversation(SampleData.kasimConversation))
        app.navigate(to: .posts)
        #expect(app.canGoBack)
        app.goBack()
        #expect(app.route == .conversation(SampleData.kasimConversation))
        app.goForward()
        #expect(app.route == .posts)
        app.sidebarSelection = .conversation(SampleData.hasatConversation)
        #expect(app.route == .conversation(SampleData.hasatConversation))
        #expect(!app.canGoForward)
    }

    @Test func composerAliasesUploadsAndSendGate() async throws {
        let (app, _) = await makeApp()
        let conversation = app.conversationModel(SampleData.hasatConversation)
        await waitUntil { conversation.state != nil }
        let composer = conversation.composer
        // The conversation already has `image` and `image-1`: drafts continue the numbering.
        composer.add([try image("a"), try image("b")])
        #expect(composer.drafts.map(\.alias) == ["image-2", "image-3"])
        await waitUntil { !composer.isUploading }
        #expect(composer.drafts.allSatisfy { $0.asset != nil })

        // Rename: invalid and taken names are refused; a valid one is accepted.
        #expect(composer.rename(composer.drafts[0].id, to: "Kötü İsim") != nil)
        #expect(composer.rename(composer.drafts[0].id, to: "image-1") != nil)
        #expect(composer.rename(composer.drafts[0].id, to: "kapak") == nil)
        // A removed draft's number is not reused.
        composer.remove(composer.drafts[1].id)
        composer.add([try image("c")])
        #expect(composer.drafts.map(\.alias) == ["kapak", "image-4"])
        await waitUntil { !composer.isUploading }

        // Mentions resolve against drafts and sent aliases; unknown names stay text.
        composer.text = "@kapak ve @image tarladan, @bilinmeyen"
        let mentions = MentionText.resolve(composer.text, aliases: composer.knownTargets)
        #expect(mentions.map(\.alias) == ["kapak", "image"])

        #expect(composer.canSend)
        await conversation.send()
        #expect(conversation.error == nil)
        #expect(composer.drafts.isEmpty)
        await waitUntil { conversation.state?.aliases.count == 4 }
        #expect(conversation.state?.aliases.map(\.alias) == ["image", "image-1", "kapak", "image-4"])
        let sent = try #require(conversation.messages.last)
        #expect(sent.mentions?.map(\.alias) == ["kapak", "image"])
        // No worker can run chat turns in the sample: the run waits, honestly.
        #expect(conversation.activeRun?.status == .queued)
        #expect(conversation.runWaitingForMac)
    }

    @Test func sendIsBlockedWhileUploading() async throws {
        let backend = SampleBackend(data: SampleData(), uploadDelay: .seconds(5))
        let settings = AppSettings(defaults: UserDefaults(suiteName: "studio.tests.\(UUID().uuidString)")!, credentials: InMemoryCredentialStore(), useSampleData: true)
        let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
        await app.load()
        let composer = app.newChat.composer
        composer.add([try image("slow")])
        composer.text = "merhaba"
        #expect(composer.isUploading)
        #expect(!composer.canSend)
        #expect(composer.sendBlockedReason == "Görseller yükleniyor…")
        composer.remove(composer.drafts[0].id)
        #expect(composer.canSend)
    }

    @Test func newChatCreatesTheConversationAndOpensIt() async throws {
        let (app, _) = await makeApp()
        app.newChat.composer.text = "Aralık planını çıkar"
        await app.newChat.send()
        guard case .conversation(let id) = app.route else {
            Issue.record("expected to open the new conversation")
            return
        }
        #expect(app.conversations.first { $0.id == id }?.title == "Aralık planını çıkar")
        #expect(app.conversations.first { $0.id == id }?.brandId == SampleData.mtm)
    }

    @Test func postsCountsAndApproveAll() async throws {
        let (app, _) = await makeApp()
        app.posts.month = MonthKey(year: 2026, month: 11)
        await app.posts.load()
        #expect(app.posts.counts[.all] == 12)
        #expect(app.posts.approvable.count == 3)
        await app.posts.approveReady()
        #expect(app.posts.error == nil)
        #expect(app.posts.approvable.isEmpty)
        #expect(app.posts.counts[.approved] == 6)
    }

    @Test func postDetailEditsCaptionAndApproves() async throws {
        let (app, _) = await makeApp()
        await app.posts.load()
        let card = try #require(app.posts.card("post-02a"))
        let detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        #expect(detail.canApprove)
        detail.captionDraft = "Yeni açıklama."
        detail.hashtagsDraft = "mtmagro, #saklama"
        await detail.saveCaption()
        #expect(detail.content.caption == "Yeni açıklama.\n\n#mtmagro #saklama")
        await detail.approve()
        #expect(detail.content.status == .approved)
        #expect(app.posts.card("post-02a")?.state == .approved)
    }

    @Test func appearancePreferencePersists() {
        let defaults = UserDefaults(suiteName: "studio.tests.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
        #expect(settings.appearance == .system)
        settings.appearance = .dark
        #expect(AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true).appearance == .dark)
        #expect(AppearancePreference.dark.next == .system)
    }
}
