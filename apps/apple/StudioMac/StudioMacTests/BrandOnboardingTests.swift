import AppKit
import StudioKit
import Testing
@testable import StudioMac

@MainActor
private func makeApp() async -> (AppModel, SampleBackend, UserDefaults) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.p2.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), tunnelTokens: InMemoryTunnelTokenStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return (app, backend, defaults)
}

@MainActor
private func waitUntil(_ condition: () -> Bool, timeout: Double = 3) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
}

private func png(_ seed: String) throws -> UploadFile {
    UploadFile(filename: "\(seed).png", mimeType: "image/png", data: try #require(SampleImages.png(seed: seed)), width: 540, height: 675)
}

/// Tokens shaped like the worker's brand.analyze output.
private let workerTokens: JSONObject = [
    "status": .string("approved"),
    "color": .object([
        "paper": .object(["value": .string("#FFFFFF"), "use": .string("zemin")]),
        "accent": .object(["value": .string("#FF6A00"), "use": .string("tek vurgu")]),
        "brand-green": .string("#3E9B3A"),
    ]),
    "font": .object([
        "display": .object(["family": .string("Archivo"), "files": .array([.string("fonts/archivo.woff2")]), "license": .string("Archivo: OFL")]),
        "text": .object(["family": .string("Inter"), "files": .array([])]),
    ]),
    "space": .object(["margin": .number(72), "gutter": .number(24), "unit": .number(8), "scale": .array([])]),
    "radius": .object(["sm": .number(8), "md": .number(16)]),
    "facts": .object(["allowedNumbers": .array([.string("10"), .number(6132)]), "statements": .array([.string("A")]), "forbidden": .array([])]),
]

@Suite("P2: profile editing rules")
@MainActor
struct ProfileEditingTests {
    @Test func tokenRowsCoverColoursFontsSpacingAndRadii() {
        let rows = ProfileTokens.rows(workerTokens)
        #expect(rows.map(\.id) == [
            "color.paper.value", "color.accent.value", "color.brand-green",
            "font.display.family", "font.display.license", "font.text.family",
            "space.margin", "space.gutter", "space.unit",
            "radius.sm", "radius.md",
        ])
        #expect(rows.first { $0.id == "color.accent.value" }?.note == "tek vurgu")
        #expect(rows.first { $0.id == "font.display.family" }?.note == "1 dosya")
        #expect(rows.first { $0.id == "space.margin" }?.value == "72")
    }

    @Test func settingTokensValidatesAndNormalises() throws {
        let accent = try #require(ProfileTokens.rows(workerTokens).first { $0.id == "color.accent.value" })
        let changed = try ProfileTokens.setting(workerTokens, path: accent.path, kind: .color, value: "f60")
        #expect(ProfileTokens.rows(changed).first { $0.id == "color.accent.value" }?.value == "#FF6600")
        // The colour's "use" note survives.
        #expect(changed["color"]?["accent"]?["use"]?.stringValue == "tek vurgu")
        #expect(throws: ProfileEditError.self) { try ProfileTokens.setting(workerTokens, path: accent.path, kind: .color, value: "turuncu") }
        #expect(throws: ProfileEditError.self) { try ProfileTokens.setting(workerTokens, path: ["space", "margin"], kind: .number, value: "-4") }
        #expect(throws: ProfileEditError.self) { try ProfileTokens.setting(workerTokens, path: ["font", "display", "family"], kind: .text, value: "<b>") }
        let margin = try ProfileTokens.setting(workerTokens, path: ["space", "margin"], kind: .number, value: "64,5")
        #expect(margin["space"]?["margin"]?.doubleValue == 64.5)
    }

    @Test func factsRoundTripAndParse() {
        var draft = ProfileDraft(tokens: workerTokens)
        #expect(draft.facts.allowedNumbers == ["10", "6132"])
        draft.facts.allowedNumbers = ProfileFacts.numbers(from: "10, %20 ;\n10 , 3.5")
        draft.facts.statements = ProfileFacts.lines(from: "Bir\n\n İki ")
        #expect(draft.facts == ProfileFacts(allowedNumbers: ["10", "%20", "3.5"], statements: ["Bir", "İki"], forbidden: []))
        #expect(draft.tokens["color"] == workerTokens["color"])
    }

    @Test func starterTokensAreCompleteAndUseTheKit() {
        let kit = BrandKit(brandId: "b", fonts: [BrandKitFont(assetId: "f", family: "Archivo", role: .display)], palette: [BrandKitColor(name: "accent", hex: "#FF6A00")])
        let tokens = ProfileTokens.starter(kit: kit, brand: nil)
        #expect(tokens["color"]?["accent"]?["value"]?.stringValue == "#FF6A00")
        #expect(tokens["color"]?["paper"]?["value"]?.stringValue == "#FFFFFF")
        #expect(tokens["font"]?["display"]?["family"]?.stringValue == "Archivo")
        #expect(tokens["font"]?["text"]?["family"]?.stringValue == "Helvetica Neue")
        #expect(tokens["usage"]?["accent"]?.stringValue == "accent")
    }

    @Test func kitFilesPickMimeTypesAndRefuseWrongFiles() throws {
        let font = try BrandKitFiles.upload(data: Data("wOF2".utf8), filename: "Archivo-Bold.woff2", slot: .font)
        #expect(font.mimeType == "font/woff2")
        #expect(throws: BrandKitFiles.Failure.self) { try BrandKitFiles.upload(data: Data([1]), filename: "x.zip", slot: .font) }
        let svg = try BrandKitFiles.upload(data: Data("<svg xmlns='http://www.w3.org/2000/svg'></svg>".utf8), filename: "logo.svg", slot: .logo)
        #expect(svg.mimeType == "image/svg+xml")
        #expect(throws: BrandKitFiles.Failure.self) { try BrandKitFiles.upload(data: Data("hello".utf8), filename: "logo.svg", slot: .logo) }
        let image = try BrandKitFiles.upload(data: try #require(SampleImages.png(seed: "s")), filename: "post.png", slot: .sample)
        #expect(image.mimeType == "image/png")
        #expect(image.width == 540)
        #expect(BrandSettingsModel.looksLikeNegativeLogo("logo-beyaz.png"))
        #expect(!BrandSettingsModel.looksLikeNegativeLogo("logo.png"))
        #expect(BrandSettingsModel.normalizedHandle(" mtmagro ", platform: .instagram) == "@mtmagro")
        #expect(BrandSettingsModel.normalizedHandle("MTM Agro", platform: .facebook) == "MTM Agro")
    }
}

@Suite("P2: brand settings, kit and analysis")
@MainActor
struct BrandSettingsTests {
    @Test func kitUploadsAutosaveAndUnlockAnalysis() async throws {
        let (app, backend, _) = await makeApp()
        let brand = try await app.createNewBrand(name: "Kit Markası", language: "en")
        #expect(brand.defaultLanguage == "en")
        let model = BrandSettingsModel(app: app, brandId: brand.id, tab: .kit)
        model.saveDelay = .zero
        model.pollInterval = .milliseconds(10)
        await model.load()
        #expect(model.analysisBlocker?.contains("en az 3") == true)

        await model.upload(try png("logo-beyaz"), slot: .logo)
        for seed in ["a", "b"] { await model.upload(try png(seed), slot: .sample) }
        #expect(model.analysisBlocker?.contains("şu an 2") == true)
        await model.upload(try png("c"), slot: .sample)
        model.addColor(hex: "ff6a00")
        model.setColorName(at: 0, "Ana Vurgu")
        model.setSampleCaption(model.kit.samples[0].assetId, "Hasat başladı")
        model.setNotes("Siyah beyaz, tek turuncu.")
        #expect(await model.saveKitNow())

        let stored = try await backend.brandKit(brandId: brand.id)
        #expect(stored.samples.count == 3)
        #expect(stored.samples.first?.caption == "Hasat başladı")
        #expect(stored.logos.first?.background == .dark) // "beyaz" in the file name
        #expect(stored.palette == [BrandKitColor(name: "ana-vurgu", hex: "#FF6A00")])
        #expect(stored.notes == "Siyah beyaz, tek turuncu.")
        #expect(model.analysisBlocker == nil)

        // A bad colour blocks saving and analysis with a reason.
        model.setColorHex(at: 0, "turuncu")
        #expect(model.kitProblem?.contains("#RRGGBB") == true)
        #expect(await model.saveKitNow() == false)
        #expect(model.analysisBlocker != nil)
        model.setColorHex(at: 0, "#FF6A00")

        // Extract: a draft appears, the profile tab opens on it.
        await model.startAnalysis()
        await waitUntil { if case .succeeded = model.analysis { true } else { false } }
        #expect(model.analysis == .succeeded(version: 1))
        await waitUntil { model.selectedVersion == 1 }
        #expect(model.tab == .profile)
        #expect(model.selectedProfile?.status == .draft)
        #expect(model.draft.tokens["color"]?["ana-vurgu"]?["value"]?.stringValue == "#FF6A00")

        // Edit tokens and facts, save, approve: it becomes current.
        let accent = try #require(model.tokenRows.first { $0.id == "color.accent.value" })
        #expect(model.setToken(accent, to: "#123") == nil)
        #expect(model.setToken(accent, to: "mavi") != nil)
        model.setAllowedNumbers("10, 20")
        model.draft.voice = "# Ses\nKısa."
        #expect(model.draftDirty)
        await model.saveDraft()
        #expect(!model.draftDirty)
        await model.approveSelected()
        #expect(model.currentProfile?.version == 1)
        #expect(model.currentProfile?.tokens["color"]?["accent"]?["value"]?.stringValue == "#112233")
        #expect(ProfileFacts(tokens: model.currentProfile?.tokens ?? [:]).allowedNumbers == ["10", "20"])
        #expect(model.setToken(accent, to: "#000000") != nil) // approved: read-only

        // New draft from the approved version, approve it, then make v1 current again.
        await model.newDraftFromSelected()
        #expect(model.selectedVersion == 2)
        #expect(model.isEditable)
        await model.approveSelected()
        #expect(model.currentProfile?.version == 2)
        model.select(1)
        await model.approveSelected()
        #expect(model.currentProfile?.version == 1)
        #expect(model.profiles.filter(\.isCurrent).count == 1)
        model.stop()
    }

    @Test func blankDraftStartsFromValidTokens() async throws {
        let (app, _, _) = await makeApp()
        let brand = try await app.createNewBrand(name: "Boş Taslak")
        let model = BrandSettingsModel(app: app, brandId: brand.id)
        await model.load()
        #expect(model.profiles.isEmpty)
        await model.newDraftFromSelected()
        #expect(model.selectedProfile?.version == 1)
        #expect(model.tokenRows.contains { $0.id == "color.accent.value" })
        #expect(model.tokenRows.contains { $0.id == "font.display.family" })
    }

    @Test func generalArchiveRestoreAndAccounts() async throws {
        let (app, backend, _) = await makeApp()
        let first = try #require(app.brands.first { $0.id == SampleData.mtm })
        app.selectBrand(first.id)
        let brand = try await app.createNewBrand(name: "Arşiv Deneme")
        #expect(app.currentBrandId == brand.id)
        let model = BrandSettingsModel(app: app, brandId: brand.id)
        await model.load()

        model.nameDraft = "Arşiv Deneme 2"
        model.slugDraft = "Bad Slug"
        #expect(model.generalProblem != nil)
        model.slugDraft = "arsiv-deneme-2"
        model.languageDraft = "de"
        await model.saveGeneral()
        #expect(app.brand(brand.id)?.name == "Arşiv Deneme 2")
        #expect(app.brand(brand.id)?.defaultLanguage == "de")
        #expect(!model.generalDirty)

        await model.saveHandle("arsivdeneme", for: .instagram)
        #expect(model.account(for: .instagram)?.handle == "@arsivdeneme")
        #expect(model.account(for: .instagram)?.status == .pending)
        await model.saveHandle("@yeniad", for: .instagram)
        #expect(model.accounts.filter { $0.platform == .instagram }.count == 1)
        #expect(model.account(for: .instagram)?.handle == "@yeniad")
        let id = try #require(model.account(for: .instagram)?.id)
        await model.disableAccount(id)
        #expect(model.account(for: .instagram) == nil)

        await model.archive()
        #expect(model.isArchived)
        #expect(!app.brands.contains { $0.id == brand.id })
        #expect(app.archivedBrands.contains { $0.id == brand.id })
        #expect(app.currentBrandId != brand.id)
        #expect(app.currentBrandId != nil)
        #expect(model.analysisBlocker?.contains("Arşiv") == true)
        #expect(try await backend.archivedBrands().contains { $0.id == brand.id })

        await model.restore()
        #expect(app.brands.contains { $0.id == brand.id })
        #expect(!app.archivedBrands.contains { $0.id == brand.id })
    }

    @Test func brandSwitchingAndLegacyProfileEntryPoint() async throws {
        let (app, _, _) = await makeApp()
        let other = try #require(app.brands.first { $0.id != app.currentBrandId })
        app.navigate(to: .posts)
        app.selectBrand(other.id)
        #expect(app.currentBrandId == other.id)
        #expect(app.expandedBrands.contains(other.id))
        app.selectBrand("missing")
        #expect(app.currentBrandId == other.id)

        app.brandProfileTarget = BrandProfileTarget(brandId: other.id, startAnalysis: true)
        #expect(app.brandSettingsTarget == BrandSettingsTarget(brandId: other.id, tab: .kit, startAnalysis: true))
        #expect(app.brandProfileTarget == nil)
    }

    @Test func runningAnalysisIsFollowedAfterReopening() async throws {
        let (app, _, _) = await makeApp()
        let model = BrandSettingsModel(app: app, brandId: SampleData.mtm)
        model.pollInterval = .milliseconds(10)
        defer { model.stop() }
        let queued = Job(id: "job-x", type: .brandAnalyze, status: .running, brandId: SampleData.mtm, createdAt: .now, updatedAt: .now, progress: 0.5, progressMessage: "Sentezleniyor")
        model.track(queued)
        #expect(model.analysis == .running(jobId: "job-x", progress: 0.5, message: "Sentezleniyor"))
        #expect(model.isAnalyzing)
        model.stop()
        let failed = Job(id: "job-y", type: .brandAnalyze, status: .failed, brandId: SampleData.mtm, createdAt: .now, updatedAt: .now, error: "Örnek post görselleri okunamadı")
        model.track(failed)
        #expect(model.analysis == .failed("Profil çıkarılamadı: Örnek post görselleri okunamadı"))
    }
}

@Suite("P2: first-run flow")
@MainActor
struct OnboardingTests {
    @Test func showsOnlyWhenSomethingNeedsSetup() {
        #expect(OnboardingModel.needsSetup(brandCount: 0, claude: .signedIn))
        #expect(OnboardingModel.needsSetup(brandCount: 2, claude: .signedOut))
        #expect(OnboardingModel.needsSetup(brandCount: 2, claude: .notInstalled))
        #expect(!OnboardingModel.needsSetup(brandCount: 2, claude: .signedIn))
        #expect(!OnboardingModel.needsSetup(brandCount: 1, claude: nil))
        #expect(!OnboardingModel.needsSetup(brandCount: 1, claude: .signingIn))
    }

    @Test func stepSkipAndCompletionPersist() async {
        let defaults = UserDefaults(suiteName: "studio.onboarding.\(UUID().uuidString)")!
        let first = OnboardingModel(defaults: defaults)
        #expect(first.step == .welcome)
        first.advance()
        first.advance()
        #expect(first.step == .server)
        first.skip()

        let second = OnboardingModel(defaults: defaults)
        #expect(second.step == .server) // resumes
        #expect(second.isSkipped)
        #expect(!second.isCompleted)
        second.goBack()
        #expect(second.step == .claude)
        second.finish()

        let third = OnboardingModel(defaults: defaults)
        #expect(third.isCompleted)
        third.reopen() // Help menu after completion starts over
        #expect(third.step == .welcome)
    }

    @Test func claudeLoginPollsUntilSignedIn() async throws {
        let (app, _, _) = await makeApp()
        let model = app.onboarding
        model.pollInterval = .milliseconds(10)
        await model.startClaudeLogin()
        await waitUntil { !model.isSigningIn }
        #expect(model.claude?.status == .signedIn)
        #expect(model.isClaudeReady)
        #expect(model.claudeError == nil)
        #expect(OnboardingModel.describeLoginError(StudioAPIError.server(status: 409, code: .conflict, message: "x", issues: [])).contains("Mac worker"))
    }

    @Test func firstBrandStepCreatesBrandAndInstagramAccount() async throws {
        let (app, _, _) = await makeApp()
        let model = app.onboarding
        model.go(to: .brand)
        model.brandName = "Yeni Müşteri"
        #expect(model.brandSlug == "yeni-musteri")
        model.instagramHandle = "yenimusteri"
        #expect(model.brandProblem == nil)
        await model.createBrand()
        let id = try #require(model.createdBrandId)
        #expect(app.currentBrandId == id)
        #expect(model.step == .done)
        #expect(app.accounts.contains { $0.brandId == id && $0.handle == "@yenimusteri" && $0.platform == .instagram })
        model.openBrandKit()
        #expect(model.isCompleted)
        #expect(!app.onboardingPresented)
        #expect(app.brandSettingsTarget == BrandSettingsTarget(brandId: id, tab: .kit))
    }
}
