import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// A sample post turned into a reel version as the worker stores it (P6): cover + MP4 ids,
/// duration, recipe and the base64 `ReelSpec`.
@MainActor
private func makeReelApp(durationMs: Int, platforms: [Platform], videoId: String) async throws -> (AppModel, SampleBackend) {
    var data = SampleData(now: .now)
    let index = try #require(data.contents.firstIndex { $0.id == "post-01" })
    data.contents[index].type = .reel
    data.contents[index].targetPlatforms = platforms
    var version = try #require(data.versions["post-01"])
    let cover = version.slides.first?.renderedAssetId ?? "cover-1"
    let spec = """
    {"v":1,"recipe":"motion_graphics","hook":"Bor eksikliği verimi düşürür","cta":"MTM Agro",\
    "scenes":[{"eyebrow":"","headline":"Bor eksikliği verimi düşürür","subhead":"","durationMs":3000},\
    {"eyebrow":"","headline":"Çiçeklenmede kritik","subhead":"","durationMs":\(durationMs - 4800)}],\
    "overlays":[],"narrationScript":"","words":[],"captions":true,"durationMs":\(durationMs),\
    "clipAssetId":null,"clipStartMs":0,"audioAssetId":null,"heroAssetId":null,"voice":null,"voiceAssetId":null,"coverAtMs":null}
    """
    let b64 = Data(spec.utf8).base64EncodedString()
    let html = "<main data-artboard data-reel=\"1\" data-video-asset-id=\"\(videoId)\" data-cover-asset-id=\"\(cover)\" data-reel-recipe=\"motion_graphics\" data-duration-ms=\"\(durationMs)\" data-reel-spec-b64=\"\(b64)\" style=\"width:1080px;height:1920px\"></main>"
    version.slides = [Slide(html: html, width: 1080, height: 1920, renderedAssetId: cover)]
    version.slideCount = 1
    data.versions["post-01"] = version
    let backend = SampleBackend(data: data, uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.reels.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    app.posts.month = MonthKey(year: 2026, month: 11)
    await app.posts.load()
    return (app, backend)
}

@MainActor
private func waitUntil(_ condition: () -> Bool, timeout: Double = 4) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(15)) }
}

@MainActor
private func all<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
    if let match = view as? T { return [match] }
    return view.subviews.flatMap { all(type, in: $0) }
}

@Suite("Mac reels: player, editor, export, grid card, platform limits (sample backend, no windows)")
@MainActor
struct ReelsMacTests {
    @Test func openedReelShowsCoverPlayButtonAndEditor() async throws {
        let videoId = "vid-test-\(UUID().uuidString)"
        // A cached MP4 (the app downloads once into Caches/Studio/Reels).
        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Studio/Reels", isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let cached = cache.appendingPathComponent("\(videoId).mp4")
        try Data("mp4".utf8).write(to: cached)
        defer { try? FileManager.default.removeItem(at: cached) }

        let (app, backend) = try await makeReelApp(durationMs: 12_000, platforms: [.instagram], videoId: videoId)
        let card = try #require(app.posts.card("post-01"))
        let model = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        app.detail = model
        let overlay = PostDetailOverlayView(model: model)
        overlay.frame = CGRect(x: 0, y: 0, width: 1280, height: 820)
        overlay.layoutSubtreeIfNeeded()
        await waitUntil { model.videoPreviewURL != nil }

        #expect(model.isReel)
        #expect(model.reelInfo?.videoAssetId == videoId)
        #expect(model.videoPreviewURL == cached)
        let labels = all(NSTextField.self, in: overlay).filter { !$0.isHiddenOrHasHiddenAncestor }.map(\.stringValue)
        #expect(labels.contains("0:12 · Hareketli grafik"))
        let play = try #require(all(GlyphButton.self, in: overlay).first { $0.symbolName == "play.fill" })
        #expect(!play.isHiddenOrHasHiddenAncestor && play.isEnabled)

        // Düzenle shows the reel editor (not the layer list) with the scenes.
        model.tab = .edit
        for _ in 0..<10 { try? await Task.sleep(for: .milliseconds(15)) }
        overlay.layoutSubtreeIfNeeded()
        let editor = try #require(all(ReelEditorView.self, in: overlay).first)
        #expect(!editor.isHiddenOrHasHiddenAncestor)
        let fields = all(NSTextField.self, in: editor).filter(\.isEditable).map(\.stringValue)
        #expect(fields.contains("Bor eksikliği verimi düşürür"))
        #expect(fields.contains("Çiçeklenmede kritik"))
        let render = try #require(all(PillButton.self, in: editor).first { $0.title == "Videoyu yeniden oluştur" })
        #expect(!render.isEnabled) // nothing changed yet

        // An edit enables it and goes out as content.render mp4 with only the changed fields.
        model.updateReelDraft { $0.hook = "Bor eksikliğini erken fark edin"; $0.scenes[1].durationMs = 2_500 }
        #expect(model.reelDraft?.totalMs == 7_300)
        for _ in 0..<10 { try? await Task.sleep(for: .milliseconds(15)) }
        overlay.layoutSubtreeIfNeeded()
        #expect(render.isEnabled)
        await model.rerenderReel()
        let job = try #require(try await backend.jobs(brandId: nil).first { $0.type == .contentRender })
        #expect(job.payload["format"] == .string("mp4"))
        #expect(job.payload["reel"]?["hook"] == .string("Bor eksikliğini erken fark edin"))
        #expect(job.payload["reel"]?["scenes"]?.arrayValue?.count == 2)
        #expect(job.payload["reel"]?["cta"] == nil)

        // "Neyi değiştireyim?" is open for reels.
        let instruction = try #require(all(NSTextField.self, in: overlay).first { $0.placeholderString == "Neyi değiştireyim?" })
        #expect(instruction.isEnabled)
    }

    @Test func videoDownloadFailureIsShownAndPlayStaysOff() async throws {
        let (app, _) = try await makeReelApp(durationMs: 9_000, platforms: [.instagram], videoId: "missing-video")
        let card = try #require(app.posts.card("post-01"))
        let model = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        let overlay = PostDetailOverlayView(model: model)
        overlay.frame = CGRect(x: 0, y: 0, width: 1280, height: 820)
        overlay.layoutSubtreeIfNeeded()
        await waitUntil { model.videoError != nil }
        #expect(model.videoError?.hasPrefix("Video indirilemedi") == true)
        let play = try #require(all(GlyphButton.self, in: overlay).first { $0.symbolName == "play.fill" })
        for _ in 0..<6 { try? await Task.sleep(for: .milliseconds(15)) }
        // Nothing to play: the same button downloads again (it stayed disabled for good before).
        #expect(play.isEnabled)
        #expect(play.toolTip?.hasPrefix("Video indirilemedi") == true)
        #expect(play.toolTip?.contains("Yeniden denemek") == true)
        #expect(!model.showReelVideo)
        model.retryReelVideo()
        #expect(model.videoError == nil)
        await waitUntil { model.videoError != nil }
        #expect(model.videoError?.hasPrefix("Video indirilemedi") == true)
        #expect(!model.showReelVideo)
    }

    @Test func facebookLimitBlocksSchedulingALongReel() async throws {
        let (app, _) = try await makeReelApp(durationMs: 95_000, platforms: [.instagram, .facebook], videoId: "v")
        let card = try #require(app.posts.card("post-01"))
        let model = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        #expect(model.reelPlatformIssues == ["Facebook Reels en fazla 90 sn olabilir; bu video 95 sn."])
        let facebook = model.schedulableAccounts.filter { $0.platform == .facebook }.map(\.id)
        guard !facebook.isEmpty else { return } // sample brand without a Facebook account
        model.scheduleAccounts = Set(facebook)
        await model.schedule()
        #expect(model.error == "Facebook Reels en fazla 90 sn olabilir; bu video 95 sn.")
    }

    @Test func gridCardShowsPlayGlyphAndDuration() async throws {
        let (app, _) = try await makeReelApp(durationMs: 12_400, platforms: [.instagram], videoId: "v")
        let card = try #require(app.posts.card("post-01"))
        let view = PostPlaceholderView(imageStore: app.images, card: card, scale: 1)
        view.frame = CGRect(x: 0, y: 0, width: 200, height: 250)
        view.layoutSubtreeIfNeeded()
        #expect(all(NSTextField.self, in: view).map(\.stringValue).contains("0:12"))
        #expect(all(NSImageView.self, in: view).contains { $0.image?.accessibilityDescription == "Video" })
        #expect(view.accessibilityLabel() == "Reels, 12,4 sn")
    }
}
