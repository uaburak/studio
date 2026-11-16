import AppKit
import StudioKit
import Testing
@testable import StudioMac

@MainActor
private func makeWave2App() async -> (AppModel, SampleBackend, UserDefaults, InMemoryTunnelTokenStore) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.wave2.\(UUID().uuidString)")!
    let tunnelStore = InMemoryTunnelTokenStore()
    let settings = AppSettings(
        defaults: defaults,
        credentials: InMemoryCredentialStore(),
        tunnelTokens: tunnelStore,
        useSampleData: true
    )
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return (app, backend, defaults, tunnelStore)
}

@MainActor
private func waitCondition(_ condition: () -> Bool, timeout: Double = 3) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline {
        try? await Task.sleep(for: .milliseconds(20))
    }
}

@Suite("Wave 2B: StudioMac Calendar, Media, BrandProfile, PostDetail Layers & Remote Control")
@MainActor
struct Wave2MacTests {
    @Test func sidebarAndRoutesNavigateToCalendarAndMedia() async throws {
        let (app, _, _, _) = await makeWave2App()
        app.sidebarSelection = .calendar
        #expect(app.route == .calendar)
        #expect(app.title == "Takvim")

        app.sidebarSelection = .media
        #expect(app.route == .media)
        #expect(app.title == "Medya")

        let grid = CalendarModel.monthGridDays(for: MonthKey(year: 2026, month: 11))
        #expect(grid.count % 7 == 0)
        #expect(grid.compactMap { $0 }.count == 30)

        app.calendar.month = MonthKey(year: 2026, month: 11)
        await app.calendar.load()
        #expect(!app.calendar.monthEntries.isEmpty)
        let scheduled = try #require(app.calendar.monthEntries.first { $0.scheduleId == "sch-1" })
        #expect(scheduled.canCancel)
        await app.calendar.cancelSchedule("sch-1")
        #expect(!app.calendar.monthEntries.contains { $0.scheduleId == "sch-1" })
    }

    @Test func mediaLibraryFiltersAndTracksAIImageGeneration() async throws {
        let (app, backend, _, _) = await makeWave2App()
        await app.media.load()
        let initialCount = app.media.assets.count
        #expect(initialCount >= 2)
        #expect(app.media.counts[.images] == initialCount)

        _ = try await backend.generateAIImage(
            brandId: SampleData.mtm,
            prompt: "Venta Borinc torbası tarlada",
            aspectRatio: "4:5",
            imageSize: "2K",
            referenceAssetIds: [],
            preserveProductLabel: true,
            targetContentId: nil,
            targetSlotId: nil
        )
        await app.media.load()
        #expect(app.media.assets.count == initialCount + 1)
        #expect(app.media.assets.contains { $0.source == .generated })
    }

    @Test func newBrandCreationAndBrandProfileEditorFlow() async throws {
        let (app, _, _, _) = await makeWave2App()
        let newBrand = try await app.createNewBrand(name: "Anadolu Tohum")
        #expect(newBrand.slug == "anadolu-tohum")
        #expect(app.currentBrandId == newBrand.id)

        let profileModel = BrandSettingsModel(app: app, brandId: SampleData.mtm, tab: .profile)
        profileModel.pollInterval = .milliseconds(10)
        await profileModel.load()
        #expect(profileModel.profiles.count == 2)
        #expect(profileModel.selectedProfile?.version == 1)

        // Edit v2 draft and approve it
        profileModel.select(2)
        profileModel.draft.designRules = "# Yeni Kurallar"
        await profileModel.saveDraft()
        await profileModel.approveSelected()
        #expect(profileModel.selectedProfile?.isCurrent == true)
        #expect(profileModel.selectedProfile?.status == .approved)
        #expect(profileModel.selectedProfile?.designRules == "# Yeni Kurallar")
    }

    @Test func postDetailSlotFillAndDirectLayerEditingCreateVersions() async throws {
        let (app, _, _, _) = await makeWave2App()
        await app.posts.load()
        let card = try #require(app.posts.card("post-01"))
        #expect(card.needsImage)

        let detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        await waitCondition { !detail.versionSummaries.isEmpty && detail.activity == .idle }

        // Upload a picture into the slot -> fillSlot patch -> v2 ready
        let png = try #require(SampleImages.png(seed: "slot-fill"))
        let imported = try ImageImport.from(data: png, filename: "urun.png")
        detail.placeImage(imported, into: "photo")
        await waitCondition { detail.card.content.currentVersion?.version == 2 && detail.activity == .idle }
        #expect(!detail.card.needsImage)
        #expect(detail.canApprove)

        // Edit the title layer -> setText patch -> v3
        detail.setText("title", "VENTA BORİNC YENİ")
        await waitCondition { detail.card.content.currentVersion?.version == 3 && detail.activity == .idle }
        #expect(detail.layers.first { $0.layerId == "title" }?.text == "VENTA BORİNC YENİ")
        #expect(detail.versionSummaries.map(\.version) == [3, 2, 1])

        // Switch version preview to v1
        await detail.selectVersion(1)
        #expect(detail.activeVersion?.version == 1)
        #expect(!detail.isViewingCurrentVersion)
        #expect(detail.editBlocker != nil)
    }

    @Test func remoteControlConfigurationAndCloudflaredTunnelArguments() throws {
        let defaults = UserDefaults(suiteName: "studio.rc.\(UUID().uuidString)")!
        let tunnelStore = InMemoryTunnelTokenStore()
        let settings = AppSettings(
            defaults: defaults,
            credentials: InMemoryCredentialStore(),
            tunnelTokens: tunnelStore,
            useSampleData: true
        )
        #expect(settings.remoteControlEnabled == false)
        #expect(settings.remoteHostname == "social.burakkoc.net")
        #expect(LocalHost.Service.tunnel.label == "Uzaktan erişim tüneli")

        settings.remoteControlEnabled = true
        settings.remoteHostname = "https://social.burakkoc.net/"
        try tunnelStore.save("  cf-tok-123456  ")

        let cfg = settings.hostConfiguration
        #expect(cfg.remoteControlEnabled == true)
        #expect(cfg.tunnelToken == "cf-tok-123456")

        let tokenArgs = LocalHost.tunnelArguments(
            token: cfg.tunnelToken,
            hostname: cfg.remoteHostname,
            localTargetURL: "http://127.0.0.1:8791"
        )
        #expect(tokenArgs == [
            "tunnel", "--no-autoupdate", "run", "--token", "cf-tok-123456", "--url", "http://127.0.0.1:8791",
        ])

        let namedArgs = LocalHost.tunnelArguments(
            token: nil,
            hostname: cfg.remoteHostname,
            localTargetURL: "http://127.0.0.1:8791"
        )
        #expect(namedArgs == [
            "tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:8791", "social.burakkoc.net",
        ])
    }
}
