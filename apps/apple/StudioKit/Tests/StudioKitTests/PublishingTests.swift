import Foundation
import Testing
@testable import StudioKit

@Suite("P3 publishing: API calls, schedule state, notices, OAuth, calendar math")
struct PublishingTests {
    private func client(_ handler: @escaping StubURLProtocol.Handler) -> (APIClient, String) {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host, handler: handler)
        return (APIClient(baseURL: URL(string: "http://\(host):8790/")!, auth: NoAuth(), session: session), host)
    }

    private static let scheduleJSON = """
    {"id":"s1","contentId":"c1","brandId":"b1","platform":"instagram","socialAccountId":"a1","versionId":"v1",
     "contentHash":"\(String(repeating: "a", count: 64))","scheduledAt":"2026-11-20T09:00:00.000Z","status":"pending",
     "delivery":"cloud","cloudSyncedAt":"2026-11-16T20:00:00.000Z","lastError":null,"cancelledAt":null,
     "createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}
    """

    @Test func decodesDeliveryFieldsAndMovesASchedule() async throws {
        let (api, host) = client { _, _ in .init(status: 200, body: Data(Self.scheduleJSON.utf8)) }
        let target = Date(timeIntervalSince1970: 1_795_000_000)
        let moved = try await api.reschedule("s1", to: target)
        #expect(moved.delivery == .cloud)
        #expect(moved.cloudSyncedAt != nil)
        let (request, body) = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.httpMethod == "PATCH")
        #expect(request.url?.path == "/api/schedules/s1")
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(json?["scheduledAt"] as? String == Timestamp.format(target))
    }

    @Test func preflightAndPublishNowBodies() async throws {
        let preflight = """
        {"mode":"local","ok":false,"errors":[],"targets":[{"socialAccountId":"a1","platform":"instagram","handle":"@mtm",
         "kind":"instagram.image","ok":false,"errors":[{"code":"LOCAL_MEDIA_NOT_PUBLIC","path":"","message":"Instagram görseli herkese açık bir adresten indirir"}],"warnings":[]}]}
        """
        let (api, host) = client { request, _ in
            .init(status: 200, body: Data((request.url?.path == "/api/schedules/preflight" ? preflight : "{}").utf8))
        }
        let result = try await api.preflight(SchedulePreflightInput(contentId: "c1", socialAccountIds: ["a1"]))
        #expect(result.ok == false)
        #expect(result.target("a1")?.errors.first?.code == "LOCAL_MEDIA_NOT_PUBLIC")
        let body = try #require(StubURLProtocol.recorded(host: host).first?.1)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(json?["contentId"] as? String == "c1")
        #expect(json?["socialAccountIds"] as? [String] == ["a1"])
    }

    @Test func publishLogFeedQuery() async throws {
        let feed = """
        {"items":[{"log":{"id":"l1","scheduleId":"s1","attempt":1,"status":"succeeded","externalPostId":"179","permalink":"https://www.instagram.com/p/X/","error":null,
          "startedAt":"2026-11-16T10:00:00.000Z","finishedAt":"2026-11-16T10:00:05.000Z","createdAt":"2026-11-16T10:00:00.000Z"},
          "schedule":\(Self.scheduleJSON),"contentTitle":"Hasat","accountHandle":"@mtm"}]}
        """
        let (api, host) = client { _, _ in .init(status: 200, body: Data(feed.utf8)) }
        let since = Date(timeIntervalSince1970: 1_795_000_000)
        let items = try await api.publishLogs(brandId: "b1", finishedAfter: since)
        #expect(items.count == 1)
        let query = URLComponents(url: try #require(StubURLProtocol.recorded(host: host).first?.0.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.contains(URLQueryItem(name: "finishedAfter", value: Timestamp.format(since))))
        let notices = NoticePlanner.notices(for: items)
        #expect(notices == [StudioNotice(id: "publish:l1:ok", kind: .published, title: "Yayınlandı: Hasat", body: "Instagram · @mtm", url: "https://www.instagram.com/p/X/")])
    }

    private func schedule(status: ScheduleStatus, delivery: ScheduleDelivery? = nil, synced: Bool = false, error: String? = nil) -> Schedule {
        Schedule(
            id: "s", contentId: "c", brandId: "b", platform: .instagram, socialAccountId: "a", versionId: "v",
            contentHash: "h", scheduledAt: Date(), status: status, permalink: status == .published ? "https://x/p/1" : nil,
            delivery: delivery, cloudSyncedAt: synced ? Date() : nil, lastError: error, createdAt: Date(), updatedAt: Date())
    }

    @Test func scheduleStateInWords() {
        #expect(ScheduleDisplayState(schedule(status: .pending), mode: .local) == .waitingOnMac)
        #expect(ScheduleDisplayState(schedule(status: .pending), mode: .local).detail?.contains("Mac açık olmalı") == true)
        #expect(ScheduleDisplayState(schedule(status: .pending), mode: .cloud) == .sendingToCloud(error: nil))
        #expect(ScheduleDisplayState(schedule(status: .pending, delivery: .cloud, synced: true), mode: .cloud) == .inCloud)
        let refused = ScheduleDisplayState(schedule(status: .pending, delivery: .cloud, error: "Oran desteklenmiyor"), mode: .cloud)
        #expect(refused.needsOwner)
        #expect(refused.label == "Buluta gönderilemedi")
        #expect(ScheduleDisplayState(schedule(status: .failed, error: "Token geçersiz"), mode: .local) == .failed(reason: "Token geçersiz"))
        #expect(ScheduleDisplayState(schedule(status: .failed), mode: .local).canRetry)
        #expect(ScheduleDisplayState(schedule(status: .published), mode: .local) == .published(permalink: "https://x/p/1"))
        #expect(!ScheduleDisplayState(schedule(status: .publishing), mode: .cloud).canCancel)
    }

    @Test func jobAndTokenNotices() throws {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        var job = Job(id: "j1", type: .contentGenerate, status: .succeeded, payload: [:], createdAt: now, updatedAt: now)
        #expect(NoticePlanner.notice(for: job, previous: .running)?.kind == .jobFinished)
        #expect(NoticePlanner.notice(for: job, previous: .succeeded) == nil)
        job.status = .failed
        job.error = "Claude yanıt vermedi"
        #expect(NoticePlanner.notice(for: job, previous: .running)?.body == "Claude yanıt vermedi")
        job.type = .chatTurn
        #expect(NoticePlanner.notice(for: job, previous: .running) == nil)

        let soon = SocialAccount(id: "a1", brandId: "b", platform: .linkedin, handle: "Burak", status: .connected, createdAt: now, updatedAt: now,
                                 hasToken: true, tokenExpiresAt: now.addingTimeInterval(3 * 86_400), tokenHealth: .valid)
        let fine = SocialAccount(id: "a2", brandId: "b", platform: .facebook, handle: "MTM", status: .connected, createdAt: now, updatedAt: now,
                                 hasToken: true, tokenExpiresAt: nil, tokenHealth: .valid)
        let broken = SocialAccount(id: "a3", brandId: "b", platform: .instagram, handle: "@mtm", status: .needsReauth, createdAt: now, updatedAt: now)
        let notices = NoticePlanner.tokenNotices(accounts: [soon, fine, broken], now: now)
        #expect(notices.map(\.kind) == [.tokenExpiring, .tokenInvalid])
        #expect(notices[0].body.contains("3 gün"))
        #expect(notices[0].id == NoticePlanner.tokenNotices(accounts: [soon], now: now.addingTimeInterval(60))[0].id)
    }

    @Test func metaLoginURLsAndCallbacks() throws {
        let url = MetaLogin.authorizeURL(appId: "123", state: "st", hasSecret: true)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(url.host == "www.facebook.com")
        #expect(items.contains(URLQueryItem(name: "redirect_uri", value: "http://localhost:8793/meta/callback")))
        #expect(items.contains(URLQueryItem(name: "response_type", value: "code")))
        #expect(items.first { $0.name == "scope" }?.value?.contains("instagram_content_publish") == true)
        #expect(MetaLogin.authorizeURL(appId: "123", state: "st", hasSecret: false).absoluteString.contains("response_type=token"))

        let ok = MetaLogin.parseCallback(URL(string: "http://localhost:8793/meta/callback?code=AQ123&state=st")!, expectedState: "st")
        #expect(try ok.get().code == "AQ123")
        let implicit = MetaLogin.parseCallback(URL(string: "http://localhost:8793/meta/callback?access_token=EAAxyz&expires_in=5400&state=st")!, expectedState: "st")
        #expect(try implicit.get() == MetaLogin.Callback(accessToken: "EAAxyz", expiresIn: 5400))
        let wrongState = MetaLogin.parseCallback(URL(string: "http://localhost:8793/meta/callback?code=AQ&state=other")!, expectedState: "st")
        #expect(throws: OAuthCallbackError.stateMismatch) { try wrongState.get() }
        let denied = MetaLogin.parseCallback(URL(string: "http://localhost:8793/meta/callback?error=access_denied&error_description=Permissions+error&state=st")!, expectedState: "st")
        #expect(throws: OAuthCallbackError.denied("Permissions error")) { try denied.get() }

        let li = LinkedInLogin.authorizeURL(clientId: "li", state: "s2")
        #expect(li.absoluteString.contains("scope=openid%20profile%20w_member_social"))
        #expect(try LinkedInLogin.parseCallback(URL(string: "http://localhost:8793/linkedin/callback?code=LI1&state=s2")!, expectedState: "s2").get() == "LI1")
    }

    @Test func calendarDragMath() throws {
        let tz = try #require(TimeZone(identifier: "Europe/Istanbul"))
        let cal = CalendarMath.calendar(timeZone: tz)
        let original = try #require(cal.date(from: DateComponents(year: 2026, month: 11, day: 20, hour: 9, minute: 45)))
        let targetDay = try #require(cal.date(from: DateComponents(year: 2026, month: 11, day: 24)))
        let moved = CalendarMath.move(original, toDay: targetDay, calendar: cal)
        #expect(cal.dateComponents([.year, .month, .day, .hour, .minute], from: moved) == DateComponents(year: 2026, month: 11, day: 24, hour: 9, minute: 45))
        let movedHour = CalendarMath.move(original, toDay: targetDay, hour: 18, calendar: cal)
        #expect(cal.component(.hour, from: movedHour) == 18)
        #expect(cal.component(.minute, from: movedHour) == 45)
        let week = CalendarMath.weekDays(containing: original, calendar: cal)
        #expect(week.count == 7)
        #expect(cal.component(.weekday, from: week[0]) == 2) // Monday
        #expect(cal.component(.day, from: week[0]) == 16)
        let now = original
        let def = CalendarMath.defaultTime(on: original, now: now, calendar: cal)
        #expect(cal.component(.hour, from: def) == 10)
    }

    @Test func secretStoreRoundTrip() throws {
        let store = InMemorySecretStore()
        try store.save("s3cret", name: PublishingSecret.metaAppSecret)
        #expect(try store.load(PublishingSecret.metaAppSecret) == "s3cret")
        try store.delete(PublishingSecret.metaAppSecret)
        #expect(try store.load(PublishingSecret.metaAppSecret) == nil)
    }
}

/// Against the private API used by `apps/worker/scripts/e2e-publish.ts` (never 8787/8790):
/// `STUDIO_LIVE_PUBLISH_API_URL=http://127.0.0.1:8797 STUDIO_LIVE_PUBLISH_SINCE=<feedSince> swift test --filter LivePublishing`
@Suite("Live publish feed → notices", .enabled(if: LivePublish.baseURL != nil))
struct LivePublishingTests {
    @Test func publishedAttemptBecomesANotice() async throws {
        let client = APIClient(baseURL: try #require(LivePublish.baseURL))
        let status = try await client.publishingStatus()
        #expect(status.vaultReady)
        let since = LivePublish.since ?? Date().addingTimeInterval(-3600)
        let items = try await client.publishLogs(finishedAfter: since)
        let notices = NoticePlanner.notices(for: items)
        let published = try #require(notices.first { $0.kind == .published })
        #expect(published.title.hasPrefix("Yayınlandı: "))
        #expect(published.url?.hasPrefix("https://") == true)
        print("LIVE NOTICE:", published.title, "|", published.body, "|", published.url ?? "-")
    }
}

enum LivePublish {
    static var baseURL: URL? {
        guard let raw = ProcessInfo.processInfo.environment["STUDIO_LIVE_PUBLISH_API_URL"], let url = URL(string: raw),
              url.host == "127.0.0.1", url.port != 8787, url.port != 8790 else { return nil }
        return url
    }

    static var since: Date? {
        ProcessInfo.processInfo.environment["STUDIO_LIVE_PUBLISH_SINCE"].flatMap { Timestamp.parse($0) }
    }
}
