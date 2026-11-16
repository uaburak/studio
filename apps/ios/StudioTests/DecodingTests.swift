import Foundation
import Testing
@testable import Studio

/// Decodes responses captured from the running local API (Fixtures/*.json).
@Suite("Decoding real API responses")
struct DecodingTests {
    @Test func health() throws {
        let health = try Fixture.decode(HealthResponse.self, "health")
        #expect(health.service == "studio-api")
        #expect(health.checks.db == "ok")
    }

    @Test func brands() throws {
        let brand = try Fixture.decode(Brand.self, "brand")
        #expect(brand.status == .active)
        #expect(brand.slug.hasPrefix("ios-fixture-"))
        let page = try Fixture.decode(Page<Brand>.self, "brand-list")
        #expect(page.items.count == 1)
    }

    @Test func socialAccounts() throws {
        let account = try Fixture.decode(SocialAccount.self, "social-account")
        #expect(account.platform == .instagram)
        #expect(account.status == .pending)
        #expect(account.externalId == nil)
        _ = try Fixture.decode(Page<SocialAccount>.self, "social-account-list")
    }

    @Test func contentLifecycle() throws {
        let created = try Fixture.decode(Content.self, "content-created")
        #expect(created.status == .draft)
        #expect(created.currentVersion == nil)
        #expect(created.approval == nil)
        #expect(created.type == .carousel)

        let withVersion = try Fixture.decode(Content.self, "content-with-version")
        #expect(withVersion.currentVersion?.version == 1)

        let approved = try Fixture.decode(Content.self, "content-approved")
        #expect(approved.status == .approved)
        #expect(approved.approval?.contentHash == withVersion.currentVersion?.contentHash)

        let scheduled = try Fixture.decode(Content.self, "content-scheduled")
        #expect(scheduled.status == .scheduled)

        let list = try Fixture.decode(Page<Content>.self, "content-list")
        #expect(list.items.first?.id == created.id)
        #expect(list.nextCursor == nil)
    }

    @Test func versions() throws {
        let version = try Fixture.decode(ContentVersion.self, "version")
        #expect(version.slideCount == 2)
        #expect(version.slides.count == 2)
        #expect(version.slides[0].renderedAssetId != nil)
        #expect(version.slides[1].renderedAssetId == nil)
        #expect(version.origin == .generated)
        #expect(version.note == "İlk sürüm")
        let list = try Fixture.decode(Page<ContentVersionSummary>.self, "version-list")
        #expect(list.items.first?.contentHash == version.contentHash)
    }

    @Test func jobsAndPresence() throws {
        let job = try Fixture.decode(Job.self, "job-created")
        #expect(job.type == .contentGenerate)
        #expect(job.status == .queued)
        #expect(job.payload["title"]?.stringValue == "Hasat sezonu")
        #expect(job.maxAttempts == 3)
        let cancelled = try Fixture.decode(Job.self, "job-cancelled")
        #expect(cancelled.status == .cancelled)
        #expect(cancelled.cancelRequestedAt != nil)
        _ = try Fixture.decode(Page<Job>.self, "job-list")

        let presence = try Fixture.decode(WorkerPresence.self, "presence")
        #expect(presence.online == false)
        #expect(presence.workers.isEmpty)
    }

    @Test func assets() throws {
        let asset = try Fixture.decode(Asset.self, "asset")
        #expect(asset.mimeType == "image/png")
        #expect(asset.width == 1)
        #expect(asset.durationMs == nil)
    }

    @Test func schedules() throws {
        let schedule = try Fixture.decode(Schedule.self, "schedule")
        #expect(schedule.status == .pending)
        #expect(schedule.cancelledAt == nil)
        let cancelled = try Fixture.decode(Schedule.self, "schedule-cancelled")
        #expect(cancelled.status == .cancelled)
        #expect(cancelled.cancelledAt != nil)
        _ = try Fixture.decode(Page<Schedule>.self, "schedule-list")
    }

    @Test("Every captured error decodes into the single error type", arguments: [
        ("error-not-found", 404, APIErrorCode.notFound),
        ("error-validation", 400, .validationError),
        ("error-hash-mismatch", 409, .hashMismatch),
        ("error-invalid-transition", 409, .invalidTransition),
        ("error-unsupported-media", 415, .unsupportedMediaType),
    ])
    func errors(name: String, status: Int, code: APIErrorCode) throws {
        let error = APIError.from(status: status, body: try Fixture.data(name))
        guard case .server(let gotStatus, let gotCode, let message, _) = error else {
            Issue.record("expected .server, got \(error)")
            return
        }
        #expect(gotStatus == status)
        #expect(gotCode == code)
        #expect(!message.isEmpty)
        #expect(error.localizedDescription.isEmpty == false)
    }

    @Test func validationIssuesAreKept() throws {
        let error = APIError.from(status: 400, body: try Fixture.data("error-validation"))
        guard case .server(_, _, _, let issues) = error else { Issue.record("not a server error"); return }
        #expect(issues.map(\.path) == ["brandId", "type", "title"])
    }

    @Test func streamFrames() throws {
        let snapshot = try JobStreamMessage.decode(Fixture.text("stream-snapshot"))
        guard case .snapshot(let jobs, let presence) = snapshot else { Issue.record("not a snapshot"); return }
        #expect(!jobs.isEmpty)
        #expect(presence.online == false)

        let updated = try JobStreamMessage.decode(Fixture.text("stream-job-updated"))
        guard case .jobUpdated(let job) = updated else { Issue.record("not job.updated"); return }
        #expect(job.status == .queued)

        let pong = try JobStreamMessage.decode(Fixture.text("stream-pong"))
        guard case .pong = pong else { Issue.record("not pong"); return }
    }

    @Test func unknownStreamFrameIsReportedNotFatal() {
        #expect(throws: JobStreamMessage.DecodeError.unknownType("something.new")) {
            try JobStreamMessage.decode(#"{"type":"something.new"}"#)
        }
    }

    @Test func unknownEnumValuesDecodeAsUnknown() throws {
        var json = try Fixture.text("content-created")
        json = json.replacingOccurrences(of: "\"status\": \"draft\"", with: "\"status\": \"archived_later\"")
            .replacingOccurrences(of: "\"instagram\"", with: "\"tiktok\"")
        let content = try StudioJSON.decoder().decode(Content.self, from: Data(json.utf8))
        #expect(content.status == .unknown)
        #expect(content.targetPlatforms == [.unknown])
        #expect(!Platform.knownCases.contains(.unknown))
    }

    @Test func timestampsRoundTrip() throws {
        let date = try #require(Timestamp.parse("2026-11-16T10:06:31.177Z"))
        #expect(Timestamp.format(date) == "2026-11-16T10:06:31.177Z")
        #expect(Timestamp.parse("2026-11-16T10:06:31Z") != nil)
        #expect(Timestamp.parse("16.11.2026") == nil)
    }

    @Test func requestBodiesEncodeAsTheContractExpects() throws {
        let body = ScheduleCreate(
            contentId: "c", socialAccountId: "a", platform: nil,
            scheduledAt: try #require(Timestamp.parse("2026-11-20T07:00:00.000Z")))
        let json = String(decoding: try StudioJSON.encoder().encode(body), as: UTF8.self)
        #expect(json == #"{"contentId":"c","scheduledAt":"2026-11-20T07:00:00.000Z","socialAccountId":"a"}"#)

        let transition = String(decoding: try StudioJSON.encoder().encode(ContentTransition(to: .inReview)), as: UTF8.self)
        #expect(transition == #"{"to":"in_review"}"#)
    }

    @Test func generatePayloadMatchesTheWebApp() throws {
        let content = try Fixture.decode(Content.self, "content-created")
        let payload = GeneratePayload.make(for: content, assetIds: ["a1"])
        #expect(payload["brief"]?.stringValue == content.brief)
        #expect(payload["title"]?.stringValue == content.title)
        #expect(payload["type"]?.stringValue == "carousel")
        #expect(payload["targetPlatforms"] == ["instagram"])
        #expect(payload["assetIds"] == ["a1"])
        #expect(payload["baseVersion"] == nil)
        #expect(GeneratePayload.make(for: content, assetIds: [])["assetIds"] == nil)
    }
}
