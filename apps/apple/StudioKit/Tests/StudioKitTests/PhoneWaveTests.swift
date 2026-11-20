import CoreGraphics
import Foundation
import ImageIO
import Synchronization
import Testing
import UniformTypeIdentifiers
@testable import StudioKit

/// Faz 6 (M5–M7) and the new server states as the phone reads them.
@Suite("Phone wave E")
struct PhoneWaveTests {
    private func client(_ handler: @escaping StubURLProtocol.Handler) -> (APIClient, String) {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host, handler: handler)
        return (APIClient(baseURL: URL(string: "http://\(host):8787/")!, session: session), host)
    }

    private static func json(_ text: String) -> Data { Data(text.utf8) }

    // MARK: Thumbnails and downsampling (M5)

    @Test func thumbnailWidthsRoundUpLikeTheServer() {
        #expect(AssetThumbnail.width(for: 1) == 160)
        #expect(AssetThumbnail.width(for: 480) == 480)
        #expect(AssetThumbnail.width(for: 481) == 640)
        #expect(AssetThumbnail.width(for: 5000) == 1280)
        #expect(AssetThumbnail.width(points: 200, scale: 3) == 640)
        #expect(AssetThumbnail.width(for: .nan) == 480)
    }

    @Test func thumbnailURLAndFallbackToTheOriginal() async throws {
        let (api, host) = client { request, _ in
            if request.url?.path.hasSuffix("/thumbnail") == true {
                return .init(status: 415, body: Self.json(#"{"error":{"code":"unsupported_media_type","message":"image/heic files have no thumbnail"}}"#))
            }
            return .init(status: 200, body: Data([1, 2, 3]), headers: ["Content-Type": "image/heic"])
        }
        let url = try api.assetThumbnailURL("a 1", width: 500)
        #expect(url.path == "/api/assets/a%201/thumbnail" || url.absoluteString.contains("/api/assets/a%201/thumbnail"))
        #expect(url.query == "w=640")
        let data = try await api.assetThumbnailData("a1", width: 300)
        #expect(data == Data([1, 2, 3]))
        let paths = StubURLProtocol.recorded(host: host).compactMap { $0.0.url?.path }
        #expect(paths == ["/api/assets/a1/thumbnail", "/api/assets/a1/content"])
    }

    @Test func thumbnailErrorsOtherThanUnsupportedAreThrown() async throws {
        let (api, _) = client { _, _ in .init(status: 500, body: Self.json(#"{"error":{"code":"internal","message":"boom"}}"#)) }
        await #expect(throws: StudioAPIError.self) { _ = try await api.assetThumbnailData("a1", width: 300) }
    }

    private static func png(width: Int, height: Int) throws -> Data {
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0.4, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    @Test func downsamplesToTheShownWidth() throws {
        let data = try Self.png(width: 1080, height: 1350)
        #expect(ImageDownsampler.pixelSize(of: data) == CGSize(width: 1080, height: 1350))
        let small = try #require(ImageDownsampler.downsample(data, width: 160))
        #expect(small.width == 160)
        #expect(small.height == 200)
        #expect(ImageDownsampler.memoryCost(small) >= 160 * 200 * 4)
        // Never enlarged.
        let full = try #require(ImageDownsampler.downsample(data, width: 2000))
        #expect(full.width == 1080)
        #expect(ImageDownsampler.downsample(Data("not a picture".utf8), width: 100) == nil)
    }

    @Test func maxPixelSizeFollowsTheAspect() {
        #expect(ImageDownsampler.maxPixelSize(forWidth: 640, imageSize: CGSize(width: 1080, height: 1350)) == 800)
        #expect(ImageDownsampler.maxPixelSize(forWidth: 640, imageSize: CGSize(width: 2000, height: 1000)) == 640)
        #expect(ImageDownsampler.maxPixelSize(forWidth: 640, imageSize: CGSize(width: 300, height: 600)) == 600)
    }

    // MARK: Streaming reels (M5)

    @Test func mediaLoaderRanges() {
        #expect(AuthenticatedMediaLoader.rangeHeader(offset: 0, length: 2, toEnd: false) == "bytes=0-1")
        #expect(AuthenticatedMediaLoader.rangeHeader(offset: 100, length: 50, toEnd: false) == "bytes=100-149")
        #expect(AuthenticatedMediaLoader.rangeHeader(offset: 100, length: 50, toEnd: true) == "bytes=100-")
        #expect(AuthenticatedMediaLoader.rangeHeader(offset: 0, length: 0, toEnd: true) == nil)
        #expect(AuthenticatedMediaLoader.totalLength(contentRange: "bytes 0-1/5242880", status: 206, expectedLength: 2) == 5_242_880)
        #expect(AuthenticatedMediaLoader.totalLength(contentRange: nil, status: 200, expectedLength: 900) == 900)
        #expect(AuthenticatedMediaLoader.totalLength(contentRange: "bytes 0-1/*", status: 206, expectedLength: 2) == nil)
        #expect(AuthenticatedMediaLoader.contentType(mimeType: "video/mp4") == UTType.mpeg4Movie.identifier)
        #expect(AuthenticatedMediaLoader.contentType(mimeType: nil) == UTType.mpeg4Movie.identifier)
        let loader = AuthenticatedMediaLoader(source: URL(string: "https://social.example.net/api/assets/v1/content")!, headers: [:])
        #expect(loader.makeAsset().url.scheme == AuthenticatedMediaLoader.scheme)
    }

    // MARK: Uploads that survive leaving the app

    private final class FakeTransport: UploadTransport, @unchecked Sendable {
        let calls = Mutex<[URLRequest]>([])
        let failures: [any Error]
        let status: Int
        let body: Data
        init(failures: [any Error], status: Int = 201, body: Data) {
            self.failures = failures
            self.status = status
            self.body = body
        }

        func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
            let index = calls.withLock { $0.append(request); return $0.count - 1 }
            if index < failures.count { throw failures[index] }
            progress?(0.5)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            return (self.body, response)
        }
    }

    @Test func uploadsAreRetriedAfterADroppedConnection() async throws {
        let asset = try Fixture.data("asset")
        let api = APIClient(baseURL: URL(string: "http://mac.local:8791")!)
        let transport = FakeTransport(failures: [URLError(.networkConnectionLost)], body: asset)
        api.useUploads(transport: transport, retry: UploadRetryPolicy(maxAttempts: 3, initialDelay: .milliseconds(1)))
        let progress = ProgressBox()
        let file = UploadFile(filename: "a.png", mimeType: "image/png", data: Data([1, 2]))
        let uploaded = try await api.uploadAsset(file, brandId: "b1") { progress.add($0) }
        #expect(uploaded.kind == .image)
        #expect(transport.calls.withLock { $0.count } == 2)
        #expect(progress.values.last == 1)
        // The request follows the Mac's new address between attempts.
        #expect(transport.calls.withLock { $0.allSatisfy { $0.url?.path == "/api/assets" && $0.httpMethod == "POST" } })
    }

    @Test func refusedUploadsAreNotRetried() async throws {
        let api = APIClient(baseURL: URL(string: "http://mac.local:8791")!)
        let transport = FakeTransport(failures: [], status: 400, body: Self.json(#"{"error":{"code":"validation_error","message":"too big"}}"#))
        api.useUploads(transport: transport, retry: UploadRetryPolicy(maxAttempts: 3, initialDelay: .milliseconds(1)))
        await #expect(throws: StudioAPIError.self) {
            _ = try await api.uploadAsset(UploadFile(filename: "a.png", mimeType: "image/png", data: Data([1])), brandId: "b1")
        }
        #expect(transport.calls.withLock { $0.count } == 1)
    }

    @Test func retryPolicy() {
        let policy = UploadRetryPolicy(maxAttempts: 4, initialDelay: .seconds(2))
        #expect(policy.delay(beforeAttempt: 1) == .zero)
        #expect(policy.delay(beforeAttempt: 2) == .seconds(2))
        #expect(policy.delay(beforeAttempt: 3) == .seconds(4))
        #expect(UploadRetryPolicy.isRetryable(.offline))
        #expect(UploadRetryPolicy.isRetryable(.http(status: 503)))
        #expect(!UploadRetryPolicy.isRetryable(.http(status: 413)))
        #expect(!UploadRetryPolicy.isRetryable(.cancelled))
    }

    // MARK: Trash, retry, plan results (new server states)

    @Test func trashedRowsDecodeAndLeaveTheBoard() throws {
        var trashed = try Fixture.decode(Content.self, "content")
        #expect(trashed.deletedAt == nil)
        let raw = try JSONSerialization.jsonObject(with: Fixture.data("content")) as! [String: Any]
        var withDeleted = raw
        withDeleted["deletedAt"] = "2026-11-18T10:00:00.000Z"
        let decoded = try StudioJSON.decoder().decode(Content.self, from: JSONSerialization.data(withJSONObject: withDeleted))
        #expect(decoded.deletedAt != nil)
        trashed.deletedAt = Date()
        var kept = try Fixture.decode(Content.self, "content")
        kept.id = "kept"
        let board = PostBoard(contents: [trashed, kept], versions: [:], plans: [], schedules: [])
        #expect(board.cards.map(\.id) == ["kept"])

        var asset = try JSONSerialization.jsonObject(with: Fixture.data("asset")) as! [String: Any]
        asset["deletedAt"] = "2026-11-18T10:00:00.000Z"
        #expect(try StudioJSON.decoder().decode(Asset.self, from: JSONSerialization.data(withJSONObject: asset)).deletedAt != nil)
    }

    @Test func restoreRetryAndSpendEndpoints() async throws {
        let content = try Fixture.data("content")
        let job = #"{"id":"j2","type":"content.generate","status":"queued","payload":{},"brandId":"b1","contentId":"c1","createdAt":"2026-11-18T10:00:00.000Z","updatedAt":"2026-11-18T10:00:00.000Z"}"#
        let spend = #"""
        {"provider":"gemini","currency":"USD",
         "today":{"costUsd":0.12,"calls":3,"unpricedCalls":0,"inputTokens":10,"outputTokens":5,"thoughtsTokens":0},
         "month":{"costUsd":4.2,"calls":40,"unpricedCalls":1,"inputTokens":100,"outputTokens":50,"thoughtsTokens":0},
         "byModel":[{"model":"gemini-2.5-flash","provider":"gemini","costUsd":3,"calls":30,"unpricedCalls":0,"inputTokens":1,"outputTokens":1,"thoughtsTokens":0}],
         "byProvider":[{"provider":"gemini","costUsd":3,"calls":30,"unpricedCalls":0,"inputTokens":1,"outputTokens":1,"thoughtsTokens":0},
                       {"provider":"elevenlabs","costUsd":1.2,"calls":10,"unpricedCalls":1,"inputTokens":1,"outputTokens":0,"thoughtsTokens":0},
                       {"provider":"sora","costUsd":0,"calls":0,"unpricedCalls":0,"inputTokens":0,"outputTokens":0,"thoughtsTokens":0}],
         "budget":{"monthlyUsd":20,"remainingUsd":15.8,"usedPercent":21,"warning":false,"stopAtBudget":true,"exhausted":false},
         "balance":{"known":false,"remainingUsd":null,"billingUrl":"https://aistudio.google.com/usage"},
         "pricingVersion":"2026-11-01","dayStart":"2026-11-17T21:00:00.000Z","monthStart":"2026-10-31T21:00:00.000Z"}
        """#
        let prefs = #"{"claudeLimit":"ask","monthlyBudgetUsd":20,"stopAtBudget":true,"limitDecision":{"choice":"gemini","until":"2026-11-18T15:00:00.000Z","decidedAt":"2026-11-18T10:00:00.000Z"},"updatedAt":null}"#
        let (api, host) = client { request, _ in
            switch request.url?.path {
            case "/api/contents/c1/restore": return .init(status: 200, body: content)
            case "/api/jobs/j1/retry": return .init(status: 201, body: Self.json(job))
            case "/api/ai/spend": return .init(status: 200, body: Self.json(spend))
            case "/api/ai/preferences", "/api/ai/claude-limit/decision": return .init(status: 200, body: Self.json(prefs))
            default: return .init(status: 404, body: Self.json(#"{"error":{"code":"not_found","message":"no"}}"#))
            }
        }
        #expect(try await api.restoreContent("c1").title == "Venta Borinc")
        #expect(try await api.retryJob("j1").id == "j2")
        let summary = try await api.aiSpend(timeZone: TimeZone(identifier: "Europe/Istanbul")!)
        #expect(summary.budget.monthlyUsd == 20)
        #expect(summary.byProvider?.last?.provider == .unknown)
        #expect(summary.providerLines.first?.name == "Gemini")
        #expect(summary.providerLines[1].name == "ElevenLabs")
        #expect(summary.budgetLine == "$4,20 / $20,00 (%21)")
        let preferences = try await api.aiPreferences()
        #expect(preferences.limitDecision?.choice == .gemini)
        _ = try await api.decideClaudeLimit(ClaudeLimitDecisionCreate(choice: .wait))

        let recorded = StubURLProtocol.recorded(host: host)
        #expect(recorded.map { $0.0.httpMethod ?? "" } == ["POST", "POST", "GET", "GET", "POST"])
        let spendQuery = recorded[2].0.url?.query
        #expect(spendQuery == "tzOffset=-180")
        #expect(try JSONSerialization.jsonObject(with: recorded[4].1) as? [String: String] == ["choice": "wait"])
    }

    @Test func spendWithoutBudgetOrProviderTotals() {
        let summary = AISpendSummary(
            today: AISpendTotals(), month: AISpendTotals(costUsd: 1.5, calls: 2),
            byModel: [AISpendModel(model: "gpt-image-1", provider: .openai, costUsd: 1.5, calls: 2, unpricedCalls: 0)],
            monthStart: Date())
        #expect(summary.budgetLine == "$1,50 · bütçe yok")
        #expect(summary.providerLines.map(\.name) == ["OpenAI"])
        #expect(AISpendSummary.usd(0.001) == "<$0,01")
    }

    @Test func planGenerateResultCarriesSkippedItems() throws {
        let plans = try JSONSerialization.jsonObject(with: Fixture.data("plan-list")) as! [String: Any]
        let plan = (plans["items"] as! [[String: Any]])[0]
        let items = plan["items"] as! [[String: Any]]
        let old = try StudioJSON.decoder().decode(PlanGenerateResult.self, from: JSONSerialization.data(withJSONObject: ["plan": plan, "jobs": []]))
        #expect(old.skipped.isEmpty)
        #expect(old.skippedSummary == nil)
        let firstId = items[0]["id"] as! String
        let body: [String: Any] = ["plan": plan, "jobs": [], "skipped": [["itemId": firstId, "reason": "generated"], ["itemId": "x", "reason": "brand_new"]]]
        let result = try StudioJSON.decoder().decode(PlanGenerateResult.self, from: JSONSerialization.data(withJSONObject: body))
        #expect(result.skipped.map(\.reason) == [.generated, .unknown])
        let summary = try #require(result.skippedSummary)
        #expect(summary.hasPrefix("2 post atlandı: \(items[0]["title"] as! String) (tasarımı hazır)"))
    }

    @Test func handMadeItemsAreAcceptedWithoutGeneration() throws {
        let plans = try JSONSerialization.jsonObject(with: Fixture.data("plan-list")) as! [String: Any]
        var plan = (plans["items"] as! [[String: Any]])[0]
        var items = plan["items"] as! [[String: Any]]
        // Older servers send no `generate`: every item is designed.
        let old = try StudioJSON.decoder().decode(Plan.self, from: JSONSerialization.data(withJSONObject: plan))
        #expect(old.items.allSatisfy { !$0.isHandMade })
        #expect(old.acceptGeneratesByDefault)
        for i in items.indices { items[i]["generate"] = false }
        plan["items"] = items
        let manual = try StudioJSON.decoder().decode(Plan.self, from: JSONSerialization.data(withJSONObject: plan))
        #expect(manual.items.allSatisfy { $0.isHandMade })
        #expect(manual.designedItems.isEmpty)
        #expect(!manual.acceptGeneratesByDefault)
        #expect(PlanGenerateSkipReason(rawValue: "manual") == .manual)
        #expect(PlanGenerateSkipReason.manual.label == "elle yüklenecek")
    }

    // MARK: "Üretilemedi"

    private func job(_ status: JobStatus, type: JobType = .contentGenerate, error: String? = nil, at: Date) -> Job {
        Job(id: "j-\(status.rawValue)", type: type, status: status, contentId: "c1", createdAt: at, updatedAt: at, finishedAt: at, error: error)
    }

    @Test func failedGenerationWithoutAVersion() throws {
        var content = try Fixture.decode(Content.self, "content")
        content.currentVersion = nil
        let failed = PostCard(content: content, job: job(.failed, error: "worker w1 lost the job", at: Date()))
        #expect(failed.state == .generationFailed)
        #expect(failed.state.label == "Üretilemedi")
        #expect(failed.generationFailure?.jobId == "j-failed")
        #expect(failed.generationFailure?.reason == "Mac'teki işçi işi yarıda bıraktı.")
        #expect(PostListFilter.failed.matches(failed.state))
        // A stopped job is not a failure; a running one is "Üretiliyor".
        #expect(PostCard(content: content, job: job(.cancelled, at: Date())).state == .draft)
        #expect(PostCard(content: content, job: job(.running, at: Date())).state == .generating)
    }

    @Test func failedRevisionAfterTheVersionShows() throws {
        let content = try Fixture.decode(Content.self, "content")
        var version = try Fixture.decode(ContentVersion.self, "content-version")
        version.createdAt = Date(timeIntervalSince1970: 1_000)
        let later = PostCard(content: content, version: version, job: job(.failed, at: Date(timeIntervalSince1970: 2_000)))
        #expect(later.generationFailure != nil)
        version.createdAt = Date(timeIntervalSince1970: 3_000)
        let settled = PostCard(content: content, version: version, job: job(.failed, at: Date(timeIntervalSince1970: 2_000)))
        #expect(settled.generationFailure == nil)
        // Without the loaded version a post with a design shows no failure.
        #expect(PostCard(content: content, job: job(.failed, at: Date())).generationFailure == nil)
    }

    @Test func failureTextStaysTurkish() {
        #expect(GenerationFailure.text(nil) == "Neden bildirilmedi.")
        #expect(GenerationFailure.text("Marka profili bulunamadı") == "Marka profili bulunamadı")
        #expect(GenerationFailure.text("Claude usage limit reached") == "Yapay zekâ kullanım sınırına takıldı.")
        #expect(GenerationFailure.text("render failed: chromium crashed") == "Görsel oluşturulamadı.")
        #expect(GenerationFailure.text("something odd") == "İş başarısız oldu.")
    }

    // MARK: Targeted refresh (M6)

    @Test func onlyPostJobsRefreshAPost() {
        let at = Date()
        #expect(PostRefreshPlanner.affectedContent(of: job(.succeeded, at: at)) == "c1")
        #expect(PostRefreshPlanner.affectedContent(of: job(.succeeded, type: .contentRender, at: at)) == "c1")
        #expect(PostRefreshPlanner.affectedContent(of: job(.succeeded, type: .chatTurn, at: at)) == nil)
        #expect(PostRefreshPlanner.affectedContent(of: job(.failed, type: .brandAnalyze, at: at)) == nil)
        let image = Job(id: "i", type: .imageGenerate, status: .succeeded, payload: ["targetContentId": .string("c9")], createdAt: at, updatedAt: at)
        #expect(PostRefreshPlanner.affectedContent(of: image) == "c9")
    }

    // MARK: Background check and the Claude limit (M7)

    @Test func claudeLimitDecodesAndAnnouncesOncePerWindow() throws {
        let presence = #"""
        {"online":true,"lastSeenAt":null,"workers":[],"currentJobs":[],"queueLength":2,
         "claude":{"status":"signed_in","email":null,"plan":null,"cliVersion":null,"loginUrl":null,"detail":null,
                   "limit":{"resetsAt":"2026-11-18T15:00:00.000Z","mode":"ask","decision":null,"waiting":2,"geminiReady":true},
                   "checkedAt":"2026-11-18T10:00:00.000Z"}}
        """#
        let decoded = try StudioJSON.decoder().decode(WorkerPresence.self, from: Self.json(presence))
        let limit = try #require(decoded.claude?.limit)
        #expect(limit.needsDecision)
        #expect(limit.waiting == 2)
        var tracker = ActivityNoticeTracker()
        let notices = tracker.claudeLimitNotices(decoded)
        #expect(notices.count == 1)
        #expect(notices.first?.kind == .waitingOnYou)
        #expect(notices.first?.id.hasPrefix(ActivityNoticeTracker.claudeLimitPrefix) == true)
        #expect(notices.first?.body.contains("2 iş bekliyor") == true)
        #expect(tracker.claudeLimitNotices(decoded).isEmpty)
        var answered = limit
        answered.decision = .wait
        #expect(ActivityNoticeTracker.claudeLimitNotice(answered) == nil)
        #expect(ActivityNoticeTracker.claudeLimitNotice(nil) == nil)
    }

    @Test func waitingNoticesFromAMessagePage() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let state = try #require(await backend.state(of: "c-bayi"))
        let notices = ActivityNoticeTracker.waitingNotices(conversation: state.conversation, messages: state.messages.reversed())
        #expect(notices.count == 1)
        #expect(notices.first?.conversationId == "c-bayi")
        #expect(notices.first?.id.hasPrefix("consent:") == true)
    }

    @Test func timeZoneOffsetMatchesJavaScript() {
        #expect(APIClient.tzOffset(TimeZone(identifier: "Europe/Istanbul")!) == -180)
        #expect(APIClient.tzOffset(TimeZone(identifier: "UTC")!) == 0)
    }
}
