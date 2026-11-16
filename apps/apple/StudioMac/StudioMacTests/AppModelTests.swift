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

    @Test func modelAndEffortPersistPerConversationAndDefaultToTheLastUsed() async throws {
        let (app, _) = await makeApp()
        let store = app.settings.agentChoices
        #expect(store.last == .fallback)

        let first = app.conversationModel(SampleData.hasatConversation)
        await waitUntil { first.state != nil }
        #expect(first.agentChoice == .fallback)
        first.agentChoice.model = .haiku
        first.agentChoice.effort = .xhigh
        #expect(store.choice(for: SampleData.hasatConversation) == AgentChoice(model: .haiku, effort: .xhigh))
        #expect(store.last == AgentChoice(model: .haiku, effort: .xhigh))

        // The turn carries the choice to the server.
        first.composer.text = "kısa tut"
        await first.send()
        #expect(first.error == nil)
        await waitUntil { first.activeRun != nil }
        #expect(first.activeRun?.requestedModel == .haiku)
        #expect(first.activeRun?.effort == .xhigh)

        // Another conversation starts from the last used choice and keeps its own.
        let second = app.conversationModel(SampleData.kasimConversation)
        #expect(second.agentChoice == AgentChoice(model: .haiku, effort: .xhigh))
        second.agentChoice.model = .sonnet
        #expect(store.choice(for: SampleData.hasatConversation).model == .haiku)
        #expect(store.choice(for: SampleData.kasimConversation).model == .sonnet)

        // A new chat sends the last used choice and remembers it for the new conversation.
        app.newChat.composer.text = "Aralık planını çıkar"
        await app.newChat.send()
        guard case .conversation(let id) = app.route else {
            Issue.record("expected to open the new conversation")
            return
        }
        #expect(store.choice(for: id) == AgentChoice(model: .sonnet, effort: .xhigh))
        let created = app.conversationModel(id)
        await waitUntil { created.activeRun != nil }
        #expect(created.activeRun?.requestedModel == .sonnet)
    }

    @Test func usageTextAndColours() {
        #expect(UsageIndicator.percentText(42.4) == "%42")
        #expect(UsagePopover.title(.fiveHour) == "5 saatlik")
        #expect(UsagePopover.title(.weekly) == "Haftalık")
        #expect(UsagePopover.usedText(UsageWindow(kind: .weekly, usedPercent: 91, limited: false)) == "%91 kullanıldı")
        #expect(UsagePopover.usedText(UsageWindow(kind: .weekly, limited: true)) == "Sınıra ulaşıldı")
        #expect(UsagePopover.usedText(UsageWindow(kind: .other)) == "—")
        #expect(AgentEffort.knownCases.map(\.displayName) == ["Düşük", "Orta", "Yüksek", "Çok yüksek"])
        #expect(AgentModel.knownCases.map(\.displayName) == ["Opus", "Sonnet", "Haiku", "Gemini Flash-Lite", "Gemini Flash", "Gemini Pro"])
        #expect(AgentChoice.fallback.model == .geminiFlashLite)
    }

    @Test func decidesConsentAndReflectsInConversationState() async throws {
        let (app, _) = await makeApp()
        let conversation = app.conversationModel("c-bayi")
        await waitUntil { conversation.state != nil }

        let message = try #require(conversation.messages.first { $0.id == "m-b2" })
        let pending = try #require(message.parts.compactMap { if case .consent(let c) = $0 { c } else { nil } }.first)
        #expect(pending.state == .pending)

        await conversation.decideConsent(message: message, consent: pending, allow: true)
        #expect(conversation.error == nil)

        await waitUntil {
            guard let msg = conversation.messages.first(where: { $0.id == "m-b2" }) else { return false }
            let card = msg.parts.compactMap { part -> ConsentPart? in
                if case .consent(let c) = part { return c }
                return nil
            }.first
            return card?.state == .allowed
        }
        let updated = try #require(conversation.messages.first { $0.id == "m-b2" })
        let allowed = try #require(updated.parts.compactMap { if case .consent(let c) = $0 { c } else { nil } }.first)
        #expect(allowed.state == .allowed)
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
        // "Onaylandı" counts approved posts only; the scheduled one has its own filter.
        #expect(app.posts.counts[.approved] == 5)
        #expect(app.posts.counts[.scheduled] == 1)
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
