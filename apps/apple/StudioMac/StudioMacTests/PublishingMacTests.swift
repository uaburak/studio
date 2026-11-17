import AppKit
import Foundation
import StudioKit
import Testing
@testable import StudioMac

/// Records P3 calls; answers like the API would.
@MainActor
final class FakePublishingAPI: PublishingAPI {
    var status = PublishingStatus(mode: .local, cloud: .init(configured: false), vaultReady: true)
    var preflightResult: SchedulePreflight?
    var preflightTimes: [Date?] = []
    var feed: [PublishLogFeedItem] = []
    var rescheduled: [(EntityID, Date)] = []
    var created: [ScheduleCreate] = []
    var publishedNow: [(EntityID, [EntityID])] = []
    var approved: [(EntityID, String)] = []
    var exchanges: [MetaExchangeInput] = []
    var discovers: [MetaDiscoverInput] = []
    var linkedIn: [LinkedInOAuthInput] = []
    var checks: [(EntityID, SocialAccountCheckInput)] = []
    var cloudSaved: [(String, String)] = []
    var syncRequests = 0
    let backend: SampleBackend

    init(backend: SampleBackend) { self.backend = backend }

    private func schedule(_ id: EntityID, contentId: EntityID = "post-12a", account: EntityID = "sa-ig", at date: Date, status: ScheduleStatus = .pending) -> Schedule {
        Schedule(id: id, contentId: contentId, brandId: SampleData.mtm, platform: .instagram, socialAccountId: account, versionId: "v",
                 contentHash: "h", scheduledAt: date, status: status, createdAt: Date(), updatedAt: Date())
    }

    func publishingStatus() async throws -> PublishingStatus { status }
    func setCloudPublisher(url: String, token: String) async throws -> PublishingStatus {
        cloudSaved.append((url, token))
        status = PublishingStatus(mode: .cloud, cloud: .init(configured: true, url: url), vaultReady: true)
        return status
    }
    func clearCloudPublisher() async throws -> PublishingStatus { status = .unknownLocal; return status }
    func requestPublishingSync() async throws -> PublishingStatus { syncRequests += 1; return status }
    func preflight(contentId: EntityID, accountIds: [EntityID]?, scheduledAt: Date?) async throws -> SchedulePreflight {
        preflightTimes.append(scheduledAt)
        return preflightResult ?? SchedulePreflight(mode: .local, ok: true, targets: (accountIds ?? []).map {
            SchedulePreflightTarget(socialAccountId: $0, platform: .instagram, handle: "h", kind: "instagram.image", ok: true)
        })
    }
    func createSchedule(_ input: ScheduleCreate) async throws -> Schedule {
        created.append(input)
        return schedule("new-\(created.count)", contentId: input.contentId, account: input.socialAccountId, at: input.scheduledAt)
    }
    func publishNow(contentId: EntityID, accountIds: [EntityID]) async throws -> PublishNowResult {
        publishedNow.append((contentId, accountIds))
        let data = try JSONSerialization.data(withJSONObject: ["schedules": [], "jobs": []])
        return try StudioJSON.decoder().decode(PublishNowResult.self, from: data)
    }
    func reschedule(_ scheduleId: EntityID, to date: Date) async throws -> Schedule {
        rescheduled.append((scheduleId, date))
        return schedule(scheduleId, at: date)
    }
    func cancelSchedule(_ id: EntityID) async throws -> Schedule { try await backend.cancelSchedule(id) }
    func schedules(brandId: EntityID) async throws -> [Schedule] { try await backend.schedules(brandId: brandId) }
    func publishLogs(brandId: EntityID?, finishedAfter: Date?) async throws -> [PublishLogFeedItem] {
        guard let finishedAfter else { return feed }
        return feed.filter { ($0.log.finishedAt ?? .distantPast) > finishedAfter }
    }
    func approve(contentId: EntityID, hash: String) async throws -> Content {
        approved.append((contentId, hash))
        return try await backend.approve(contentId: contentId, hash: hash)
    }
    func exchangeMeta(_ input: MetaExchangeInput) async throws -> MetaExchangeResult {
        exchanges.append(input)
        return MetaExchangeResult(userAccessToken: "EAAlong-user", expiresAt: Date().addingTimeInterval(60 * 86_400), longLived: true, pages: [
            MetaDiscoveredPage(pageId: "p1", pageName: "MTM Agro", canPublish: true, instagram: .init(igUserId: "ig1", username: "mtmagro")),
            MetaDiscoveredPage(pageId: "p2", pageName: "Diğer", canPublish: true),
        ])
    }
    func discoverMeta(_ input: MetaDiscoverInput) async throws -> MetaDiscoverResult {
        discovers.append(input)
        let now = Date()
        return MetaDiscoverResult(pages: [], connectedAccounts: [
            SocialAccount(id: "new-ig", brandId: input.brandId, platform: .instagram, handle: "@mtmagro", externalId: "ig1", status: .connected, createdAt: now, updatedAt: now),
        ])
    }
    func linkedInOAuth(_ input: LinkedInOAuthInput) async throws -> SocialAccount {
        linkedIn.append(input)
        let now = Date()
        return SocialAccount(id: "li", brandId: input.brandId, platform: .linkedin, handle: "Burak Koç", externalId: "urn:li:person:1", status: .connected, createdAt: now, updatedAt: now)
    }
    func checkAccount(id: EntityID, _ input: SocialAccountCheckInput) async throws -> SocialAccount {
        checks.append((id, input))
        return try await backend.checkSocialAccountToken(id: id)
    }
    func disconnectAccount(id: EntityID) async throws -> SocialAccount { try await backend.updateSocialAccount(id, SocialAccountUpdate(status: .disabled)) }
    func socialAccounts() async throws -> [SocialAccount] { try await backend.socialAccounts(brandId: nil) }
}

@MainActor
final class RecordingPoster: NoticePoster {
    var posted: [StudioNotice] = []
    var requests = 0
    var granted: Bool? = nil
    func authorizationGranted() async -> Bool? { granted }
    func requestAuthorization() async -> Bool { requests += 1; granted = true; return true }
    func post(_ notice: StudioNotice) async { posted.append(notice) }
}

@MainActor
private func waitUntil(_ condition: () -> Bool, timeout: Double = 4) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
}

@MainActor
private func makeP3App() async -> (AppModel, FakePublishingAPI, RecordingPoster, UserDefaults) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.tests.p3.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    let fake = FakePublishingAPI(backend: backend)
    app.publishing.apiOverride = fake
    await app.load()
    let poster = RecordingPoster()
    return (app, fake, poster, defaults)
}

@Suite("P3: calendar, scheduling, publishing feed, accounts (window-free)")
@MainActor
struct PublishingMacTests {
    @Test func calendarDragMovesAPendingScheduleKeepingTheLocalTime() async throws {
        let (app, fake, _, _) = await makeP3App()
        await app.calendar.load()
        let entry = try #require(app.calendar.allEntries.first { $0.scheduleId == "sch-1" })
        #expect(entry.state == .waitingOnMac)
        #expect(entry.detail?.contains("Mac açık olmalı") == true)
        #expect(entry.canMove)
        let original = try #require(entry.scheduledAt)
        let cal = CalendarMath.calendar()
        let targetDay = try #require(cal.date(byAdding: .day, value: 3, to: original))

        let ok = await app.calendar.move(scheduleId: "sch-1", toDay: targetDay)
        #expect(ok)
        let (id, moved) = try #require(fake.rescheduled.first)
        #expect(id == "sch-1")
        #expect(cal.component(.hour, from: moved) == cal.component(.hour, from: original))
        #expect(cal.component(.minute, from: moved) == cal.component(.minute, from: original))
        #expect(cal.isDate(moved, inSameDayAs: targetDay))
        #expect(app.calendar.selectedDay == CalendarDay(moved))

        // Week view: drop on an hour row.
        let ok2 = await app.calendar.move(scheduleId: "sch-1", toDay: targetDay, hour: 18)
        #expect(ok2)
        #expect(cal.component(.hour, from: fake.rescheduled[1].1) == 18)

        // The past is refused with a Turkish message, without calling the API.
        let yesterday = try #require(cal.date(byAdding: .day, value: -2, to: Date()))
        let refused = await app.calendar.move(scheduleId: "sch-1", toDay: yesterday)
        #expect(!refused)
        #expect(app.calendar.error == "Geçmiş bir zamana taşınamaz.")
        #expect(fake.rescheduled.count == 2)
    }

    @Test func weekViewListsTheWeekAndNavigates() async throws {
        let (app, _, _, _) = await makeP3App()
        await app.calendar.load()
        let entry = try #require(app.calendar.allEntries.first { $0.scheduleId == "sch-1" })
        app.calendar.viewMode = .week
        app.calendar.weekAnchor = try #require(entry.scheduledAt)
        #expect(app.calendar.listedEntries.contains { $0.scheduleId == "sch-1" })
        #expect(app.calendar.weekDays.count == 7)
        app.calendar.next()
        #expect(!app.calendar.listedEntries.contains { $0.scheduleId == "sch-1" })
        #expect(CalendarModel.weekRowHour(for: CalendarMath.calendar().date(from: DateComponents(year: 2026, month: 11, day: 20, hour: 3))!) == 6)
    }

    @Test func scheduleSheetBlocksOnPlatformRulesThenSchedulesInLocalTime() async throws {
        let (app, fake, poster, defaults) = await makeP3App()
        app.publishing.notifierForTests(poster: poster, defaults: defaults)
        let date = CalendarMath.defaultTime(on: Date().addingTimeInterval(2 * 86_400))
        let model = ScheduleSheetModel(app: app, request: ScheduleSheetRequest(brandId: SampleData.mtm, contentId: nil, date: date), api: fake)
        fake.preflightResult = SchedulePreflight(mode: .local, ok: false, targets: [
            SchedulePreflightTarget(socialAccountId: "sa-ig", platform: .instagram, handle: "mtmagro", kind: "instagram.image", ok: false,
                                    errors: [PreflightIssue(code: "LOCAL_MEDIA_NOT_PUBLIC", message: "Instagram görseli herkese açık bir adresten indirir")]),
        ])
        await model.load()
        try await Task.sleep(for: .milliseconds(100))
        #expect(model.content != nil)
        #expect(model.content?.status.isSchedulable == true)
        if model.selectedAccounts.contains("sa-ig") {
            #expect(model.blockingReason?.contains("herkese açık") == true)
            #expect(!model.canSchedule)
        }

        fake.preflightResult = nil
        model.selectedAccounts = ["sa-ig"]
        model.schedulePreflight(immediately: true)
        try await Task.sleep(for: .milliseconds(100))
        // The planned time goes with the check (per-day limits); a new time is checked again.
        #expect(fake.preflightTimes.last == date)
        let nextDay = date.addingTimeInterval(86_400)
        model.date = nextDay
        try await Task.sleep(for: .milliseconds(400))
        #expect(fake.preflightTimes.last == nextDay)
        model.date = date
        try await Task.sleep(for: .milliseconds(400))
        #expect(model.canSchedule)
        let ok = await model.schedule()
        #expect(ok)
        #expect(fake.created.first?.scheduledAt == date)
        #expect(fake.created.first?.socialAccountId == "sa-ig")
        // Permission is asked in context (the first schedule), once.
        #expect(poster.requests == 1)
    }

    @Test func schedulingAPostAlreadyWaitingMovesItsScheduleInsteadOfAddingOne() async throws {
        let (app, fake, _, _) = await makeP3App()
        // post-12a already waits on Instagram (sch-1): "Zamanla" on it changes that time.
        let date = CalendarMath.defaultTime(on: Date().addingTimeInterval(3 * 86_400))
        let model = ScheduleSheetModel(app: app, request: ScheduleSheetRequest(brandId: SampleData.mtm, contentId: "post-12a", date: date, accountIds: ["sa-ig"]), api: fake)
        await model.load()
        try await Task.sleep(for: .milliseconds(100))
        #expect(await model.schedule())
        #expect(fake.created.isEmpty, "no second schedule for the same post and account")
        #expect(fake.rescheduled.map(\.0) == ["sch-1"])
        #expect(fake.rescheduled.first?.1 == date)
    }

    @Test func publishNowAsksForConfirmationTextAndCallsTheAPI() async throws {
        let (app, fake, _, _) = await makeP3App()
        let model = ScheduleSheetModel(app: app, request: ScheduleSheetRequest(brandId: SampleData.mtm, contentId: "post-12a"), api: fake)
        await model.load()
        model.selectedAccounts = ["sa-ig"]
        model.schedulePreflight(immediately: true)
        try await Task.sleep(for: .milliseconds(100))
        #expect(model.publishNowConfirmation.contains("hemen paylaşılacak"))
        #expect(model.publishNowConfirmation.contains("Instagram · mtmagro"))
        let ok = await model.publishNow()
        #expect(ok)
        #expect(fake.publishedNow.first?.0 == "post-12a")
        #expect(fake.publishedNow.first?.1 == ["sa-ig"])
    }

    @Test func feedBecomesNotificationsOnceAndJobsNotify() async throws {
        let (app, fake, poster, defaults) = await makeP3App()
        app.publishing.notifierForTests(poster: poster, defaults: defaults)
        let finished = Date()
        let json = """
        {"log":{"id":"l1","scheduleId":"sch-1","attempt":1,"status":"succeeded","externalPostId":"179","permalink":"https://www.instagram.com/p/X/","error":null,
          "startedAt":"\(Timestamp.format(finished.addingTimeInterval(-5)))","finishedAt":"\(Timestamp.format(finished))","createdAt":"\(Timestamp.format(finished))"},
         "schedule":{"id":"sch-1","contentId":"post-12a","brandId":"b-mtm","platform":"instagram","socialAccountId":"sa-ig","versionId":"v","contentHash":"h",
          "scheduledAt":"\(Timestamp.format(finished))","status":"published","permalink":"https://www.instagram.com/p/X/","cancelledAt":null,
          "createdAt":"\(Timestamp.format(finished))","updatedAt":"\(Timestamp.format(finished))"},
         "contentTitle":"Kasım duyurusu","accountHandle":"mtmagro"}
        """
        fake.feed = [try StudioJSON.decoder().decode(PublishLogFeedItem.self, from: Data(json.utf8))]
        app.publishing.feedCursor = finished.addingTimeInterval(-60)
        let first = await app.publishing.pollFeed()
        #expect(first.map(\.kind) == [.published])
        #expect(poster.posted.first?.url == "https://www.instagram.com/p/X/")
        // Cursor moved; the same event is never posted twice.
        #expect(app.publishing.feedCursor == fake.feed[0].log.finishedAt)
        app.publishing.feedCursor = finished.addingTimeInterval(-60)
        let second = await app.publishing.pollFeed()
        #expect(second.isEmpty)
        #expect(poster.posted.count == 1)

        // Job feed: a running content.generate that succeeds → one notice.
        var job = Job(id: "j-gen", type: .contentGenerate, status: .running, payload: [:], createdAt: finished, updatedAt: finished)
        app.publishing.jobChanged(job)
        job.status = .succeeded
        app.publishing.jobChanged(job)
        try await Task.sleep(for: .milliseconds(50))
        #expect(poster.posted.last?.kind == .jobFinished)

        // Turned off: nothing is posted.
        app.publishing.notifier.enabled = false
        let quiet = await app.publishing.notifier.post([StudioNotice(id: "x", kind: .published, title: "t", body: "b")])
        #expect(quiet.isEmpty)
    }

    @Test func clickedNotificationsCarryThePostAndOpenIt() async throws {
        // What a notification carries and what a click opens.
        let failed = StudioNotice(id: "p:1:failed", kind: .publishFailed, title: "Yayınlanamadı: Hasat", body: "x", contentId: "post-12a", brandId: SampleData.mtm)
        #expect(NoticeDestination.from(userInfo: NoticeDestination.userInfo(for: failed)) == .post(contentId: "post-12a", brandId: SampleData.mtm))
        let published = StudioNotice(id: "p:1:ok", kind: .published, title: "t", body: "b", url: "https://www.instagram.com/p/X/", contentId: "post-12a", brandId: SampleData.mtm)
        #expect(NoticeDestination.from(userInfo: NoticeDestination.userInfo(for: published)) == .post(contentId: "post-12a", brandId: SampleData.mtm),
                "a published post opens in Studio, not only in the browser")
        let oldPublished = StudioNotice(id: "p:2:ok", kind: .published, title: "t", body: "b", url: "https://www.instagram.com/p/Y/")
        #expect(NoticeDestination.from(userInfo: NoticeDestination.userInfo(for: oldPublished)) == .link(URL(string: "https://www.instagram.com/p/Y/")!))
        let token = StudioNotice(id: "t", kind: .tokenInvalid, title: "t", body: "b")
        #expect(NoticeDestination.from(userInfo: NoticeDestination.userInfo(for: token)) == .accounts)
        #expect(NoticeDestination.from(userInfo: NoticeDestination.userInfo(for: StudioNotice(id: "j", kind: .jobFinished, title: "t", body: "b"))) == .app)
        #expect(NoticeDestination.from(userInfo: ["url": "file:///etc/passwd"]) == .app, "only web links leave the app")
        #expect(NoticeDestination.from(userInfo: [:]) == .app)

        // The notifier hands a click to the app.
        let (app, _, poster, defaults) = await makeP3App()
        app.publishing.notifierForTests(poster: poster, defaults: defaults)
        var clicked: [NoticeDestination] = []
        app.publishing.notifier.onOpen = { clicked.append($0) }
        app.publishing.notifier.open(.accounts)
        #expect(clicked == [.accounts])

        // The app opens the post in its brand, even from another brand on the posts screen.
        app.navigate(to: .posts)
        app.selectBrand("b-koc")
        await app.posts.loadLatest()
        #expect(app.posts.loadedBrandId == "b-koc")
        app.openNotice(.post(contentId: "post-12a", brandId: SampleData.mtm))
        await waitUntil { app.detail?.content.id == "post-12a" }
        #expect(app.currentBrandId == SampleData.mtm)
        #expect(app.route == .posts)
        #expect(app.detail?.content.id == "post-12a")
        #expect(app.banner == nil)

        app.openNotice(.accounts)
        #expect(app.settingsPresented)
    }

    @Test func notificationClickedWhileLoadingOpensAfterTheBrandsArrive() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let defaults = UserDefaults(suiteName: "studio.tests.p3.notice.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
        let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
        // Launched by the click: nothing is loaded yet.
        app.openNotice(.post(contentId: "post-12a", brandId: SampleData.mtm))
        #expect(app.pendingNotice == .post(contentId: "post-12a", brandId: SampleData.mtm))
        #expect(app.detail == nil)
        await app.load()
        app.restoreSession()
        app.openPendingNotice()
        #expect(app.pendingNotice == nil)
        await waitUntil { app.detail?.content.id == "post-12a" }
        #expect(app.detail?.content.id == "post-12a")
        #expect(app.route == .posts)
    }

    @Test func metaConnectPicksPagesPerBrand() async throws {
        let (app, fake, _, defaults) = await makeP3App()
        let secrets = InMemorySecretStore()
        let accounts = AccountsModel(app: app, defaults: defaults, secrets: secrets)
        accounts.apiOverride = fake
        try accounts.saveMetaApp(appId: "1234567890", secret: "app-secret-1")
        #expect(throws: (any Error).self) { try accounts.saveMetaApp(appId: "abc", secret: nil) }
        var opened: URL?
        accounts.waitForCallback = { path, url in
            opened = url
            #expect(path == "/meta/callback")
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value ?? ""
            return URL(string: "http://localhost:8793/meta/callback?code=CODE1&state=\(state)")!
        }
        await accounts.runMetaConnect(brandId: SampleData.mtm)
        #expect(accounts.phase == .picking)
        #expect(opened?.absoluteString.contains("response_type=code") == true)
        #expect(fake.exchanges.first?.code == "CODE1")
        #expect(fake.exchanges.first?.appSecret == "app-secret-1")
        #expect(fake.exchanges.first?.redirectUri == "http://localhost:8793/meta/callback")

        accounts.toggle(pageId: "p1", facebook: false, instagram: true)
        accounts.toggle(pageId: "p2", facebook: false, instagram: false)
        #expect(accounts.pickedCount == 1)
        await accounts.confirmMetaSelection()
        let discover = try #require(fake.discovers.first)
        #expect(discover.brandId == SampleData.mtm)
        #expect(discover.userAccessToken == "EAAlong-user")
        #expect(discover.selections == [MetaPageSelection(pageId: "p1", facebook: false, instagram: true)])
        if case .finished(let message) = accounts.phase { #expect(message.contains("@mtmagro")) } else { Issue.record("not finished: \(accounts.phase)") }
        #expect(accounts.exchange == nil) // the user token is dropped from memory

        // A wrong state (another tab) is refused.
        accounts.waitForCallback = { _, _ in URL(string: "http://localhost:8793/meta/callback?code=X&state=other")! }
        await accounts.runMetaConnect(brandId: SampleData.mtm)
        if case .failed(let message) = accounts.phase { #expect(message.contains("bu oturuma ait değil")) } else { Issue.record("expected failure") }
    }

    @Test func linkedInConnectAndLiveHealthCheckUseKeychainSecrets() async throws {
        let (app, fake, _, defaults) = await makeP3App()
        let accounts = AccountsModel(app: app, defaults: defaults, secrets: InMemorySecretStore())
        accounts.apiOverride = fake
        #expect(!accounts.linkedInConfigured)
        accounts.startLinkedInConnect(brandId: SampleData.mtm)
        if case .failed(let message) = accounts.phase { #expect(message.contains("Client ID")) } else { Issue.record("expected guidance") }

        try accounts.saveLinkedInApp(clientId: "li-client", secret: "li-secret")
        accounts.waitForCallback = { _, url in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value ?? ""
            return URL(string: "http://localhost:8793/linkedin/callback?code=LI&state=\(state)")!
        }
        await accounts.runLinkedInConnect(brandId: SampleData.mtm)
        #expect(fake.linkedIn.first?.clientSecret == "li-secret")
        #expect(fake.linkedIn.first?.code == "LI")

        try accounts.saveMetaApp(appId: "99", secret: "meta-secret")
        let ig = try #require(app.accounts.first { $0.id == "sa-ig" })
        await accounts.check(ig)
        #expect(fake.checks.first?.1 == SocialAccountCheckInput(live: true, appId: "99", appSecret: "meta-secret"))
    }

    @Test func loopbackServerCatchesTheRedirectAndRelaysTheFragment() async throws {
        // A port the system says is free (a random one collided with other apps' listeners).
        let port = UInt16(try #require(HostEnvironment.freePort(address: "127.0.0.1")))
        let server = OAuthLoopbackServer(port: port)
        async let callback = server.waitForCallback(path: "/meta/callback", timeout: 10) {
            Task {
                // The implicit flow first lands without a query: the page relays the fragment.
                let (relay, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/meta/callback")!)
                #expect(String(decoding: relay, as: UTF8.self).contains("location.hash"))
                _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/favicon.ico")!)
                _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/meta/callback?access_token=EAAx&expires_in=5400&state=s")!)
            }
        }
        let url = try await callback
        #expect(url.absoluteString == "http://localhost:\(port)/meta/callback?access_token=EAAx&expires_in=5400&state=s")
        #expect(try MetaLogin.parseCallback(url, expectedState: "s").get().accessToken == "EAAx")
    }
}
