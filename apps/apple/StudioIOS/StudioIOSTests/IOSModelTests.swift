import StudioKit
import Testing
import UIKit
@testable import StudioIOS

@MainActor
private func makeIOSApp() async -> (IOSAppModel, SampleBackend, InMemoryDeviceTokenStore) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.ios.tests.\(UUID().uuidString)")!
    let tokenStore = InMemoryDeviceTokenStore()
    let settings = IOSAppSettings(defaults: defaults, tokenStore: tokenStore, useSampleData: true)
    let app = IOSAppModel(settings: settings, conversationService: backend, dataService: backend, notifier: IOSNotifier(delivering: .silent))
    await app.load()
    return (app, backend, tokenStore)
}

@MainActor
private func waitUntilIOS(_ condition: () -> Bool, timeout: Double = 3) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline {
        try? await Task.sleep(for: .milliseconds(20))
    }
}

@Suite("StudioIOS models")
@MainActor
struct IOSModelTests {
    @Test func brandSelectionSettingsAndConnection() async throws {
        let (app, _, tokenStore) = await makeIOSApp()
        #expect(app.brands.count == 4)
        #expect(app.currentBrandId == SampleData.mtm)
        #expect(app.pendingRoute == nil)
        #expect(app.connection == .connected)
        #expect(app.connection.title == "Mac'e bağlı")

        app.selectBrand("b-koc")
        #expect(app.currentBrandId == "b-koc")
        #expect(app.settings.lastBrandId == "b-koc")
        #expect(app.visibleConversations.allSatisfy { $0.brandId == "b-koc" || $0.brandId == nil })

        app.settings.appearance = .dark
        #expect(app.settings.appearance.interfaceStyle == .dark)
        app.settings.setNotice(.replies, enabled: false)
        #expect(!app.settings.isNoticeEnabled(.replies))
        #expect(app.settings.isNoticeEnabled(.waiting))

        try tokenStore.save(DeviceCredential(
            token: "dev-tok-123", deviceId: "d-1",
            serverURL: URL(string: "http://192.168.1.25:8791")!, serverName: "Deniz MacBook Pro"))
        app.settings.credentialChanged()
        #expect(app.settings.savedCredential?.serverName == "Deniz MacBook Pro")
        #expect(app.settings.makeClient().baseURL.absoluteString == "http://192.168.1.25:8791")
        // Gelişmiş → "Ek uzak adres" is one more address to try, not a switch away from the Mac's own.
        #expect(app.settings.manualRemoteURL == nil)
        app.settings.useRemoteControlURL = true
        // No default address: nothing to try until the owner types one.
        #expect(app.settings.remoteURLString.isEmpty)
        #expect(app.settings.manualRemoteURL == nil)
        app.settings.remoteURLString = "https://studio.example.com"
        #expect(app.settings.manualRemoteURL?.absoluteString == "https://studio.example.com")
        #expect(app.settings.makeClient().baseURL.absoluteString == "http://192.168.1.25:8791")
        app.settings.forgetPairing()
        #expect(app.settings.savedCredential == nil)

        app.open(.post("post-01"))
        #expect(app.pendingRoute == .post("post-01"))

        // The greeting name: typed, else guessed from the paired Mac's name.
        #expect(app.settings.greetingName == nil)
        try tokenStore.save(DeviceCredential(
            token: "dev-tok-456", deviceId: "d-2",
            serverURL: URL(string: "http://192.168.1.25:8791")!, serverName: "Deniz’s MacBook Pro"))
        app.settings.credentialChanged()
        #expect(app.settings.greetingName == "Deniz")
        app.settings.ownerName = "  Ayşe "
        #expect(app.settings.greetingName == "Ayşe")
        #expect(app.settings.defaults.string(forKey: IOSAppSettings.ownerNameKey) == "  Ayşe ")
    }

    @Test func chatSendsWithModelConsentAndQuestions() async throws {
        let (app, _, _) = await makeIOSApp()

        let bayi = app.conversationModel("c-bayi")
        await waitUntilIOS { bayi.state != nil }
        let message = try #require(bayi.messages.first { $0.id == "m-b2" })
        let pending = try #require(message.parts.compactMap { if case .consent(let c) = $0 { c } else { nil } }.first)
        #expect(pending.state == .pending)
        // The open consent card is announced once (waiting on you).
        #expect(app.notifier.posted.contains { $0.kind == .waitingOnYou && $0.conversationId == "c-bayi" })

        await bayi.decideConsent(message: message, consent: pending, allow: true)
        await waitUntilIOS {
            let updated = bayi.messages.first { $0.id == "m-b2" }
            return updated?.parts.contains { if case .consent(let c) = $0 { c.state == .allowed } else { false } } == true
        }

        // A new chat becomes a conversation with its first message and keeps the model choice.
        let chat = app.newConversationModel()
        #expect(chat.isNew)
        chat.selection = AgentSelection(model: .geminiFlash, effort: .high)
        chat.composer.text = "Kasım için 3 hikaye öner"
        #expect(chat.canSend)
        await chat.send()
        let id = try #require(chat.id)
        #expect(app.conversations.contains { $0.id == id })
        await waitUntilIOS { chat.activeRun != nil || chat.messages.count >= 2 }
        #expect(chat.messages.first?.plainText == "Kasım için 3 hikaye öner")
        #expect(app.selection(for: id) == AgentSelection(model: .geminiFlash, effort: .high))
        #expect(chat.composer.text.isEmpty)
    }

    @Test func composerUploadsMentionsAndRenames() async throws {
        let (app, _, _) = await makeIOSApp()
        let chat = app.conversationModel("c-kasim")
        await waitUntilIOS { chat.state != nil }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 50)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 50))
        }
        chat.composer.add([image, image])
        #expect(chat.composer.drafts.count == 2)
        await waitUntilIOS { !chat.composer.isUploading }
        #expect(chat.composer.drafts.allSatisfy { $0.asset != nil })
        let first = try #require(chat.composer.drafts.first)
        #expect(chat.composer.rename(first.id, to: "Tarla Fotoğrafı") == nil)
        #expect(chat.composer.drafts.first?.alias == "tarla-fotografi")
        #expect(chat.composer.rename(first.id, to: "9") != nil)

        chat.composer.text = "Bunu @tar"
        chat.composer.caret = 9
        #expect(chat.composer.isSuggesting)
        let suggestion = try #require(chat.composer.suggestions.first)
        #expect(suggestion.alias == "tarla-fotografi")
        chat.composer.choose(suggestion)
        #expect(chat.composer.text == "Bunu @tarla-fotografi ")

        let outgoing = chat.composer.makeMessage()
        #expect(outgoing.attachments.count == 2)
        #expect(outgoing.attachments.first?.alias == "tarla-fotografi")
        await chat.send()
        #expect(chat.composer.drafts.isEmpty)
        await waitUntilIOS { chat.state?.aliases.contains { $0.alias == "tarla-fotografi" } == true }
    }

    @Test func postsBoardDetailSessionAndCalendar() async throws {
        let (app, _, _) = await makeIOSApp()
        app.posts.month = MonthKey(year: 2026, month: 11)
        await app.posts.load()
        #expect(app.posts.counts[.all] == 12)
        #expect(app.posts.attentionCount > 0)

        let card = try #require(app.posts.card("post-02a"))
        let session = app.posts.session(for: card)
        session.pollInterval = .milliseconds(5)
        await session.load()
        await session.waitUntilIdle()
        #expect(session.canApprove)
        #expect(await session.approve())
        #expect(app.posts.card("post-02a")?.content.status == .approved)

        let accounts = session.schedulableAccounts(app.accounts).map(\.id)
        #expect(accounts.contains("sa-ig"))
        let created = await session.schedule(at: Date().addingTimeInterval(2 * 86_400), accountIds: ["sa-ig"])
        #expect(created.count == 1)
        #expect(app.posts.card("post-02a")?.content.status == .scheduled)

        await app.calendar.load()
        let entry = try #require(app.calendar.entries.first { $0.schedule?.id == created.first?.id })
        #expect(entry.canReschedule)
        let target = Date().addingTimeInterval(4 * 86_400)
        await app.calendar.reschedule(entry, to: target)
        #expect(app.calendar.entries.contains { $0.contentId == "post-02a" && $0.schedule?.scheduledAt == target })
        #expect(app.calendar.selectedDay == CalendarDay(target))

        // A layer edit makes a new version and the post needs approval again.
        let draftCard = try #require(app.posts.card("post-03a"))
        let editor = app.posts.session(for: draftCard)
        editor.pollInterval = .milliseconds(5)
        await editor.load()
        await editor.waitUntilIdle()
        editor.setText("title", "BOR VE ÇİNKO YENİ")
        await editor.waitUntilIdle()
        #expect(editor.content.currentVersion?.version == 2)
        #expect(app.posts.card("post-03a")?.version?.version == 2)
    }

    @Test func notificationsRouteAndJobNotices() async throws {
        #expect(IOSNotifier.route(from: ["conversationId": "c-1"]) == .conversation("c-1"))
        #expect(IOSNotifier.route(from: ["contentId": "p-1", "kind": "postReady"]) == .post("p-1"))
        #expect(IOSNotifier.route(from: ["kind": "published"]) == .calendar)
        #expect(IOSNotifier.route(from: ["kind": "brandProfileReady", "brandId": "b"]) == .brand("b"))
        let request = IOSNotifier.request(for: ActivityNotice(id: "job:1:succeeded", kind: .postReady, title: "Post hazır", body: "x", contentId: "p-1"))
        #expect(request.identifier == "job:1:succeeded")
        #expect(request.content.userInfo["contentId"] as? String == "p-1")
    }

    @Test func reelVideoIdIsReadFromTheSlide() {
        #expect(ReelVideo.assetId(in: #"<main data-artboard data-video-asset-id="vid-1" data-cover-asset-id="c"></main>"#) == "vid-1")
        #expect(ReelVideo.assetId(in: "<main></main>") == nil)
    }

    /// Widget links (N22) and finished shares (N20) lead to the right screen.
    @Test func studioLinksOpenTheirScreens() async throws {
        let (app, _, _) = await makeIOSApp()
        #expect(app.openLink(StudioLink.approvals(brandId: "b-koc").url))
        #expect(app.currentBrandId == "b-koc")
        #expect(app.pendingRoute == .postsFiltered(.ready))
        #expect(app.openLink(StudioLink.failures(brandId: nil).url))
        #expect(app.pendingRoute == .postsFiltered(.failed))
        #expect(app.openLink(StudioLink.post("c-1").url))
        #expect(app.pendingRoute == .post("c-1"))
        #expect(app.openLink(StudioLink.media(brandId: nil).url))
        #expect(app.pendingRoute == .media)
        #expect(!app.openLink(URL(string: "studio://open/nothing")!))
        #expect(IOSNotifier.route(from: ["link": StudioLink.conversation("conv-9").url.absoluteString]) == .conversation("conv-9"))
        #expect(IOSNotifier.route(from: ["link": StudioLink.products(brandId: nil).url.absoluteString]) == .products)
    }

    /// The settings the extensions read live in the shared defaults.
    @Test func sharedSettingsGoToTheSharedDefaults() throws {
        let own = try #require(UserDefaults(suiteName: "studio.ios.tests.own.\(UUID().uuidString)"))
        let shared = try #require(UserDefaults(suiteName: "studio.ios.tests.shared.\(UUID().uuidString)"))
        let settings = IOSAppSettings(defaults: own, sharedDefaults: shared, tokenStore: InMemoryDeviceTokenStore(), useSampleData: true)
        settings.lastBrandId = "b-1"
        settings.useRemoteControlURL = true
        settings.remoteURLString = "https://studio.ornek.com"
        settings.shareBrands([Brand(id: "b-1", name: "Koç", slug: "koc", createdAt: .now, updatedAt: .now)])
        #expect(shared.string(forKey: SharedSettingsKeys.lastBrand) == "b-1")
        #expect(SharedSettingsKeys.manualRemoteURL(in: shared)?.host() == "studio.ornek.com")
        #expect(SharedBrand.load(from: shared).map(\.name) == ["Koç"])
        #expect(own.object(forKey: SharedSettingsKeys.lastBrand) == nil)
    }

    /// Products and media on the sample backend.
    @Test func productsAndMediaModels() async throws {
        let (app, _, _) = await makeIOSApp()
        let products = IOSProductsModel(app: app)
        await products.load()
        #expect(products.products.isEmpty)
        let created = try await app.dataService.createProduct(brandId: app.currentBrandId!, BrandProductCreate(name: " Kompoze ", tags: ["a", "A"]))
        products.saved(created)
        #expect(products.products.map(\.name) == ["Kompoze"])
        #expect(await products.delete(created) == nil)
        #expect(products.products.isEmpty)

        let media = IOSMediaModel(app: app)
        await media.load()
        media.filter = .videos
        #expect(media.visible.allSatisfy { $0.kind == .video })
    }
}
