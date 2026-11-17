import CoreGraphics
import Foundation
import Testing
@testable import StudioKit

/// Shared logic the iPhone app runs on (P5): the post edit session, the calendar
/// agenda and rescheduling, activity notices, model choice memory and mention helpers.
@Suite("Phone parity: edit session, calendar, notices, composer helpers")
@MainActor
struct PhoneParityTests {
    private func makeSession(_ contentId: EntityID) async throws -> (PostEditSession, SampleBackend) {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let content = try await backend.content(contentId)
        let version = try await backend.version(contentId: contentId, version: content.currentVersion!.version)
        let session = PostEditSession(service: backend, card: PostCard(content: content, version: version))
        session.pollInterval = .milliseconds(5)
        session.nudgeDebounce = .milliseconds(20)
        await session.load()
        await session.waitUntilIdle()
        return (session, backend)
    }

    @Test func editsBecomeVersionsAndUndoRestoresThem() async throws {
        let (session, _) = try await makeSession("post-02a")
        #expect(session.versionSummaries.first?.version == 1)
        #expect(session.layers.contains { $0.layerId == "title" })
        #expect(session.layerBoxes != nil) // measured by the first load

        var changes = 0
        session.onCardChange = { _ in changes += 1 }
        session.setText("title", "YENİ BAŞLIK")
        await session.waitUntilIdle()
        #expect(session.content.currentVersion?.version == 2)
        #expect(session.layers.first { $0.layerId == "title" }?.text == "YENİ BAŞLIK")
        #expect(session.canUndo && !session.canRedo)
        #expect(changes > 0)

        session.setHidden("eyebrow", true)
        await session.waitUntilIdle()
        #expect(session.content.currentVersion?.version == 3)
        #expect(session.layers.first { $0.layerId == "eyebrow" }?.isHidden == true)

        await session.undo()
        #expect(session.layers.first { $0.layerId == "eyebrow" }?.isHidden == false)
        #expect(session.canRedo)
        await session.redo()
        #expect(session.layers.first { $0.layerId == "eyebrow" }?.isHidden == true)

        // Nudges add up and go out as one transform.
        session.nudge("title", dx: 1, dy: 0)
        session.nudge("title", dx: 10, dy: -2)
        try await Task.sleep(for: .milliseconds(60))
        await session.waitUntilIdle()
        #expect(session.transform(of: "title").translate == CGPoint(x: 11, y: -2))

        // An older version is read only until restored.
        await session.selectVersion(1)
        #expect(!session.isViewingCurrentVersion)
        #expect(session.editBlocker != nil)
        #expect(!session.canApprove)
        let before = session.content.currentVersion!.version
        await session.restoreDisplayedVersion()
        #expect(session.content.currentVersion!.version == before + 1)
        #expect(session.layers.first { $0.layerId == "title" }?.text == "DOĞRU SAKLAMA REHBERİ")
        #expect(session.isViewingCurrentVersion)
    }

    @Test func slotFillApproveScheduleAndCaption() async throws {
        let (session, _) = try await makeSession("post-01")
        #expect(session.card.needsImage)
        let slot = try #require(session.targetSlot)
        #expect(slot.layerId == "photo" && slot.isEmpty)

        var uploaded: [EntityID] = []
        session.onAssetUploaded = { asset, _ in uploaded.append(asset.id) }
        let png = try #require(SampleImages.png(seed: "slot", width: 40, height: 40))
        session.fillSlot(with: UploadFile(filename: "tarla.png", mimeType: "image/png", data: png, width: 40, height: 40))
        await session.waitUntilIdle()
        #expect(uploaded.count == 1)
        #expect(!session.card.needsImage)
        #expect(session.content.currentVersion?.version == 2)

        // Caption with counters.
        session.captionDraft = "Yeni açıklama"
        session.hashtagsDraft = "venta, #bor"
        #expect(session.composedCaption == "Yeni açıklama\n\n#venta #bor")
        #expect(session.captionUsage.map(\.platform) == [.instagram, .facebook])
        #expect(session.captionUsage.first?.hashtags == 2)
        #expect(await session.saveCaption())
        #expect(session.content.caption == "Yeni açıklama\n\n#venta #bor")
        #expect(!session.hasCaptionChanges)

        #expect(session.canApprove)
        #expect(await session.approve())
        #expect(session.content.status == .approved)

        var created: [Schedule] = []
        session.onSchedulesCreated = { created += $0 }
        let when = Date().addingTimeInterval(3 * 86_400)
        let schedules = await session.schedule(at: when, accountIds: ["sa-ig"])
        #expect(schedules.count == 1 && created.count == 1)
        #expect(session.content.status == .scheduled)
        #expect(session.card.schedule?.scheduledAt == when)
        #expect(session.defaultScheduleDate == when)
    }

    @Test func aiRevisionAndExports() async throws {
        let (session, _) = try await makeSession("post-03a")
        session.instruction = "Başlığı kısalt"
        await session.sendInstruction()
        #expect(session.error == nil)
        #expect(session.content.currentVersion?.version == 2)
        #expect(session.versionSummaries.first?.origin == .aiEdit)
        #expect(session.instruction.isEmpty)

        let jpegs = await session.export(.jpeg)
        #expect(jpegs.map(\.filename) == ["bor-ve-cinko-v2.jpg"])
        let pdf = await session.export(.pdf)
        #expect(pdf.first?.filename == "bor-ve-cinko-v2.pdf")
    }

    @Test func publishedPostsAreLocked() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        var content = try await backend.content("post-07")
        content.status = .published
        let version = try await backend.version(contentId: "post-07", version: 1)
        let session = PostEditSession(service: backend, card: PostCard(content: content, version: version))
        #expect(session.editBlocker == "Yayındaki post düzenlenemez.")
        session.setText("title", "x")
        #expect(session.error == "Yayındaki post düzenlenemez.")
        #expect(session.activity == .idle)
    }

    @Test func calendarEntriesGridAndReschedule() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let schedules = try await backend.schedules(brandId: SampleData.mtm)
        let contents = try await backend.contents(brandId: SampleData.mtm)
        let accounts = try await backend.socialAccounts(brandId: SampleData.mtm)
        let plans = try await backend.plans(brandId: SampleData.mtm)
        var versions: [EntityID: ContentVersion] = [:]
        for content in contents { versions[content.id] = try await backend.version(contentId: content.id, version: 1) }
        let board = PostBoard(contents: contents, versions: versions, plans: plans, schedules: schedules)

        let entries = CalendarAgenda.entries(schedules: schedules, contents: contents, accounts: accounts, cards: board.cards, timeZone: TimeZone(identifier: "Europe/Istanbul")!)
        let scheduled = try #require(entries.first { $0.schedule?.id == "sch-1" })
        #expect(scheduled.title == "Sezon kapanışı")
        #expect(scheduled.accountHandle == "@mtmagro")
        #expect(scheduled.timeText == "09:00" && scheduled.kind == .scheduled)
        #expect(scheduled.canReschedule && scheduled.canCancel)
        // The scheduled post is not listed twice on its day.
        #expect(entries.filter { $0.contentId == "post-12a" }.count == 1)
        #expect(entries.contains { $0.kind == .approved })
        #expect(CalendarAgenda.months(entries) == [MonthKey(year: 2026, month: 11)])

        // 1 Kasım 2026 is a Sunday: six blanks, 30 days, padded to whole weeks.
        let grid = CalendarAgenda.monthGrid(MonthKey(year: 2026, month: 11))
        #expect(grid.count == 42)
        #expect(grid.prefix(6).allSatisfy { $0 == nil })
        #expect(grid[6] == CalendarDay(year: 2026, month: 11, day: 1))
        #expect(CalendarAgenda.monthGrid(MonthKey(year: 2026, month: 6)).first == CalendarDay(year: 2026, month: 6, day: 1)) // a Monday

        let target = Date().addingTimeInterval(5 * 86_400)
        let moved = try await backend.moveSchedule(scheduled.schedule!, to: target)
        #expect(moved.scheduledAt == target && moved.status == .pending)
        // Moved in place (like the API's PATCH), not cancelled and created again.
        #expect(moved.id == "sch-1")
        let after = try await backend.schedules(brandId: SampleData.mtm)
        #expect(after.filter { $0.contentId == "post-12a" }.map(\.id) == ["sch-1"])
        #expect(try await backend.content("post-12a").status == .scheduled)
        await #expect(throws: (any Error).self) { try await backend.moveSchedule(moved, to: Date().addingTimeInterval(-60)) }
    }

    @Test func noticesAnnounceFinishedWorkOnce() {
        let now = Date()
        func job(_ id: String, _ type: JobType, _ status: JobStatus, title: String = "Venta Borinc", error: String? = nil) -> Job {
            var job = Job(id: id, type: type, status: status, payload: ["title": .string(title), "conversationId": .string("c-1")], brandId: "b", contentId: "p", createdAt: now, updatedAt: now)
            job.error = error
            return job
        }
        var tracker = ActivityNoticeTracker()
        #expect(tracker.notices(for: job("x", .contentGenerate, .succeeded)).isEmpty) // before the baseline
        tracker.baseline([job("old", .contentGenerate, .succeeded), job("run", .contentGenerate, .running), job("pub", .schedulePublish, .queued)])
        #expect(tracker.notices(for: job("old", .contentGenerate, .succeeded)).isEmpty)

        let ready = tracker.notices(for: job("run", .contentGenerate, .succeeded))
        #expect(ready.map(\.kind) == [.postReady])
        #expect(ready.first?.title == "Post hazır" && ready.first?.body == "Venta Borinc onayını bekliyor.")
        #expect(tracker.notices(for: job("run", .contentGenerate, .succeeded)).isEmpty) // once

        #expect(tracker.notices(for: job("pub", .schedulePublish, .running)).isEmpty)
        let failed = tracker.notices(for: job("pub", .schedulePublish, .failed, error: "token expired"))
        #expect(failed.first?.kind == .publishFailed && failed.first?.body == "Venta Borinc: token expired")

        #expect(tracker.notices(for: job("render", .contentRender, .succeeded)).isEmpty) // renders stay quiet
        let reply = tracker.notices(for: job("turn", .chatTurn, .succeeded))
        #expect(reply.first?.kind == .replyReady && reply.first?.conversationId == "c-1")
        var late = job("late", .schedulePublish, .succeeded)
        late.finishedAt = now.addingTimeInterval(10)
        var early = job("early", .contentGenerate, .succeeded)
        early.finishedAt = now.addingTimeInterval(-10)
        #expect(ActivityNoticeTracker.notices(for: [late, early, job("q", .contentGenerate, .queued)], finishedAfter: now).map(\.kind) == [.published])
        #expect(ActivityNotice.Kind.waitingOnYou.category == .waiting)
        #expect(ActivityNotice.Kind.published.category == .publishing)
    }

    @Test func waitingNoticesComeFromPendingConsents() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let state = try #require(await backend.state(of: "c-bayi"))
        var tracker = ActivityNoticeTracker()
        let waiting = tracker.waitingNotices(in: state)
        #expect(waiting.count == 1)
        #expect(waiting.first?.kind == .waitingOnYou && waiting.first?.conversationId == "c-bayi")
        #expect(tracker.waitingNotices(in: state).isEmpty)
    }

    @Test func agentSelectionIsRememberedPerConversation() {
        let defaults = UserDefaults(suiteName: "phone.parity.\(UUID().uuidString)")!
        let store = AgentSelectionStore(defaults: defaults, prefix: "studio.ios.agent")
        #expect(store.last == .fallback)
        store.save(AgentSelection(model: .sonnet, effort: .high), for: "c-1")
        store.save(AgentSelection(model: .geminiPro, effort: .low), for: nil)
        #expect(store.selection(for: "c-1") == AgentSelection(model: .sonnet, effort: .high))
        #expect(store.selection(for: "c-2") == AgentSelection(model: .geminiPro, effort: .low))
        #expect(store.last.model == .geminiPro)
        defaults.set("bogus", forKey: "studio.ios.agent.model")
        #expect(store.last.model == AgentSelection.fallback.model)
    }

    @Test func mentionSuggestionsAndInsertion() {
        let candidates = [
            MentionCandidate(alias: "image", assetId: "a1", isDraft: false),
            MentionCandidate(alias: "kapak", assetId: "a2", isDraft: false),
            MentionCandidate(alias: "image-1", assetId: nil, isDraft: true),
            MentionCandidate(alias: "eski-image", assetId: "a3", isDraft: false),
        ]
        #expect(MentionText.suggestions(candidates, query: "").count == 4)
        #expect(MentionText.suggestions(candidates, query: "im").map(\.alias) == ["image", "image-1", "eski-image"])
        #expect(MentionText.suggestions(candidates, query: "KAP").map(\.alias) == ["kapak"])

        let text = "Bunu @ka kullan"
        let query = try! #require(MentionText.activeQuery(in: text, cursor: 8))
        #expect(query.start == 5 && query.query == "ka")
        let inserted = MentionText.insert(alias: "kapak", into: text, queryStart: query.start, cursor: 8)
        #expect(inserted.text == "Bunu @kapak kullan")
        #expect(inserted.cursor == 12)
        #expect(MentionText.insert(alias: "image", into: "@", queryStart: 0, cursor: 1).text == "@image ")
    }

    @Test func assistantStatusTexts() {
        let now = Date()
        let presence = WorkerPresence(
            online: true, lastSeenAt: now,
            usage: WorkerUsage(windows: [UsageWindow(kind: .fiveHour, usedPercent: 92.4), UsageWindow(kind: .weekly, usedPercent: 10, limited: true)], source: "t", observedAt: now),
            claude: ClaudeAccount(status: .signedIn, email: "a@b.c", plan: "Team", checkedAt: now),
            gemini: GeminiAccount(status: .ready, mode: .both, apiKeyConfigured: true, checkedAt: now))
        #expect(AssistantStatus.macLine(presence) == "Mac hazır")
        #expect(AssistantStatus.macLine(.offline) == "Mac çevrimdışı")
        #expect(AssistantStatus.claudeLine(presence) == "Giriş yapıldı · a@b.c · Team")
        #expect(AssistantStatus.geminiLine(presence) == "Hazır · API + CLI")
        #expect(AssistantStatus.percentText(92.4) == "%92")
        #expect(AssistantStatus.isWarning(92.4))
        #expect(AssistantStatus.usedText(UsageWindow(kind: .weekly, usedPercent: 10, limited: true)) == "Sınıra ulaşıldı")
        #expect(AssistantStatus.windowTitle(.fiveHour) == "5 saatlik")
        #expect(presence.usage?.mostUsed?.kind == .weekly)
        #expect(AssistantStatus.isAvailable(.sonnet, presence: presence))
        #expect(!AssistantStatus.isAvailable(.sonnet, presence: .offline))
    }
}
