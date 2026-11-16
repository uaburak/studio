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
    let app = IOSAppModel(settings: settings, conversationService: backend, dataService: backend)
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

@Suite("StudioIOS Pure UIKit Models")
@MainActor
struct IOSModelTests {
    @Test func tabNavigationBrandSelectionAndSettingsPersist() async throws {
        let (app, _, tokenStore) = await makeIOSApp()
        #expect(app.brands.count == 4)
        #expect(app.currentBrandId == SampleData.mtm)
        #expect(app.selectedTab == .chat)

        app.selectedTab = .posts
        #expect(app.selectedTab == .posts)

        app.selectBrand("b-koc")
        #expect(app.currentBrandId == "b-koc")

        app.settings.appearance = .dark
        #expect(app.settings.appearance.interfaceStyle == .dark)

        // Paired credential builds DeviceTokenAuth client cleanly
        try tokenStore.save(DeviceCredential(
            token: "dev-tok-123",
            deviceId: "d-1",
            serverURL: URL(string: "http://192.168.1.25:8791")!,
            serverName: "Burak MacBook Pro"
        ))
        #expect(app.settings.savedCredential?.serverName == "Burak MacBook Pro")
        app.settings.useRemoteControlURL = true
        #expect(app.settings.makeClient().baseURL.absoluteString == "https://social.burakkoc.net")
    }

    @Test func chatSendsMessagesSlashUsageAndDecidesConsent() async throws {
        let (app, _, _) = await makeIOSApp()

        // Consent decision on c-bayi
        let bayiChat = app.conversationModel("c-bayi")
        await waitUntilIOS { bayiChat.state != nil }
        let msg = try #require(bayiChat.messages.first { $0.id == "m-b2" })
        let pending = try #require(msg.parts.compactMap { if case .consent(let c) = $0 { c } else { nil } }.first)
        #expect(pending.state == .pending)

        await bayiChat.decideConsent(message: msg, consent: pending, allow: true)
        await waitUntilIOS {
            let updated = bayiChat.messages.first { $0.id == "m-b2" }
            let consent = updated?.parts.compactMap { if case .consent(let c) = $0 { c } else { nil } }.first
            return consent?.state == .allowed
        }

        // New conversation + /usage + regular turn with Claude/Gemini model choice
        let conv = try await app.createAndOpenConversation(title: "iPhone Sohbet")
        let chat = app.conversationModel(conv.id)
        await waitUntilIOS { chat.state != nil }

        chat.agentChoice = IOSAgentChoice(model: .geminiFlash, effort: .high)
        await chat.send(overrideText: "/usage")
        await waitUntilIOS { chat.messages.count == 2 }
        #expect(chat.messages.last?.plainText.contains("Gemini:") == true)

        chat.composerText = "Kasım için 3 hikaye öner"
        await chat.send()
        await waitUntilIOS { chat.activeRun != nil }
        #expect(chat.activeRun?.requestedModel == .geminiFlash)
        #expect(chat.activeRun?.effort == .high)
    }

    @Test func postDetailApprovesByHashEditsLayersAndSchedules() async throws {
        let (app, _, _) = await makeIOSApp()
        app.posts.month = MonthKey(year: 2026, month: 11)
        await app.posts.load()
        #expect(app.posts.counts[.all] == 12)

        // Ready post cryptographic hash approval + scheduling
        let readyCard = try #require(app.posts.card("post-02a"))
        let detail = IOSPostDetailModel(app: app, card: readyCard)
        #expect(detail.canApprove)
        await detail.approve()
        #expect(detail.content.status == .approved)

        await detail.schedulePost()
        #expect(detail.content.status == .scheduled)

        // Quick text layer edit creates new version and resets to draft
        let titleLayerIdx = try #require(detail.editableLayers.firstIndex { $0.layerId == "title" })
        detail.editableLayers[titleLayerIdx].text = "DOĞRU SAKLAMA YENİ"
        #expect(detail.hasLayerChanges)
        await detail.applyLayerEdits()
        #expect(detail.card.content.currentVersion?.version == 2)
        #expect(detail.content.status == .draft)
    }
}
