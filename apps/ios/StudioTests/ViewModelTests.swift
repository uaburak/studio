import Foundation
import Testing
@testable import Studio

@MainActor
@Suite("Compose state machine")
struct ComposeModelTests {
    @Test func validation() {
        let model = ComposeModel()
        #expect(model.validationMessage == "Brif yazın.")
        model.brief = "   \n "
        #expect(!model.canSubmit)
        model.brief = "Hasat kampanyası"
        #expect(model.canSubmit)
        model.platforms = []
        #expect(model.validationMessage == "En az bir platform seçin.")
    }

    @Test func titleFallsBackToTheBriefsFirstLine() {
        let model = ComposeModel()
        model.brief = "Kısa başlık\nikinci satır"
        #expect(model.resolvedTitle == "Kısa başlık")
        model.brief = String(repeating: "kelime ", count: 20)
        #expect(model.resolvedTitle.hasSuffix("…"))
        #expect(model.resolvedTitle.count <= 61)
        model.title = "  Elle yazılan  "
        #expect(model.resolvedTitle == "Elle yazılan")
    }

    @Test func submitCreatesContentThenJob() async throws {
        let (client, host) = StubProtocol.client(handler: route([
            "POST /api/contents": .fixture(201, "content-created"),
            "POST /api/jobs": .fixture(201, "job-created"),
        ]))
        let model = ComposeModel()
        model.brief = "İki slaytlık carousel"
        model.type = .carousel
        model.platforms = [.instagram, .facebook]
        await model.submit(api: client, brandId: "b1")
        guard case .submitted(let content, let job) = model.phase else {
            Issue.record("expected submitted, got \(model.phase)")
            return
        }
        #expect(job.type == .contentGenerate)
        #expect(content.status == .draft)

        let requests = StubProtocol.requests(for: host)
        #expect(requests.map(\.method) == ["POST", "POST"])
        let createBody = try #require(requests[0].body)
        let create = try #require(try JSONSerialization.jsonObject(with: createBody) as? [String: Any])
        #expect(create["brandId"] as? String == "b1")
        #expect(create["type"] as? String == "carousel")
        #expect(create["title"] as? String == "İki slaytlık carousel")
        #expect(create["targetPlatforms"] as? [String] == ["instagram", "facebook"])
        let jobData = try #require(requests[1].body)
        let jobBody = try #require(try JSONSerialization.jsonObject(with: jobData) as? [String: Any])
        #expect(jobBody["type"] as? String == "content.generate")
        #expect(jobBody["contentId"] as? String == content.id)
    }

    @Test func jobFailureKeepsTheContentAndRetriesOnlyTheJob() async throws {
        let jobAttempts = Locked(0)
        let (client, host) = StubProtocol.client { request in
            switch request.url?.path() {
            case "/api/contents": return .respond(.fixture(201, "content-created"))
            case "/api/jobs":
                let attempt = jobAttempts.withLock { $0 += 1; return $0 }
                return attempt == 1 ? .fail(.networkConnectionLost) : .respond(.fixture(201, "job-created"))
            default: return .respond(.json(404, "{}"))
            }
        }
        let model = ComposeModel()
        model.brief = "Brif"
        await model.submit(api: client, brandId: "b1")
        guard case .jobFailed(_, let error) = model.phase else { Issue.record("got \(model.phase)"); return }
        #expect(error == .offline)

        await model.retryJob(api: client)
        guard case .submitted = model.phase else { Issue.record("got \(model.phase)"); return }
        let paths = StubProtocol.requests(for: host).map { $0.url.path() }
        #expect(paths == ["/api/contents", "/api/jobs", "/api/jobs"])
    }

    @Test func contentFailureReturnsToEditingWithTheTextKept() async {
        let (client, _) = StubProtocol.client(handler: route([
            "POST /api/contents": .fixture(400, "error-validation"),
        ]))
        let model = ComposeModel()
        model.brief = "Brif"
        await model.submit(api: client, brandId: "b1")
        guard case .failed(let error) = model.phase else { Issue.record("got \(model.phase)"); return }
        #expect(error.code == .validationError)
        model.dismissError()
        #expect(model.phase == .editing)
        #expect(model.brief == "Brif")
    }

    @Test func attachmentsUploadAndAddAssetIdsToThePayload() async throws {
        let (client, host) = StubProtocol.client(handler: route([
            "POST /api/assets": .fixture(201, "asset"),
            "POST /api/contents": .fixture(201, "content-created"),
            "POST /api/jobs": .fixture(201, "job-created"),
        ]))
        let model = ComposeModel()
        model.brief = "Brif"
        let id = model.addPlaceholder(isVideo: false)
        #expect(!model.canSubmit, "cannot submit while preparing")
        let file = UploadFile(filename: "a.png", mimeType: "image/png", data: Data([0]), width: 1, height: 1)
        model.prepared(id, MediaImport.Imported(file: file, thumbnail: nil, isVideo: false), api: client, brandId: "b1")
        for _ in 0..<100 where model.uploadedAssetIds.isEmpty {
            try await Task.sleep(for: .milliseconds(20))
        }
        let asset = try Fixture.decode(Asset.self, "asset")
        #expect(model.uploadedAssetIds == [asset.id])
        await model.submit(api: client, brandId: "b1")
        let jobRequest = try #require(StubProtocol.requests(for: host).last)
        let jobData = try #require(jobRequest.body)
        let body = try #require(try JSONSerialization.jsonObject(with: jobData) as? [String: Any])
        let payload = try #require(body["payload"] as? [String: Any])
        #expect(payload["assetIds"] as? [String] == [asset.id])
    }

    @Test func failedUploadBlocksSubmitUntilRemoved() {
        let model = ComposeModel()
        model.brief = "Brif"
        let id = model.addPlaceholder(isVideo: true)
        model.preparationFailed(id, message: "çok büyük")
        #expect(!model.canSubmit)
        model.remove(id)
        #expect(model.canSubmit)
    }
}

@MainActor
@Suite("Jobs store reducer")
struct JobsStoreTests {
    private func store() -> JobsStore {
        let (client, _) = StubProtocol.client { _ in .fail(.cannotConnectToHost) }
        return JobsStore(api: client, connector: ScriptedConnector([]))
    }

    private func job(_ id: String, _ status: JobStatus, created: TimeInterval, updated: TimeInterval? = nil) throws -> Job {
        var job = try Fixture.decode(Job.self, "job-created")
        job.id = id
        job.status = status
        job.brandId = nil
        job.createdAt = Date(timeIntervalSince1970: created)
        job.updatedAt = Date(timeIntervalSince1970: updated ?? created)
        return job
    }

    @Test func snapshotReplacesAndSortsNewestFirst() throws {
        let store = store()
        let presence = try Fixture.decode(WorkerPresence.self, "presence")
        store.apply(.snapshot(jobs: [try job("a", .queued, created: 1), try job("b", .running, created: 2)], presence: presence))
        #expect(store.jobs.map(\.id) == ["b", "a"])
        #expect(store.macOnline == false)
        store.apply(.snapshot(jobs: [try job("c", .queued, created: 3)], presence: presence))
        #expect(store.jobs.map(\.id) == ["c"])
    }

    @Test func updatesUpsertIgnoreStaleFramesAndReportFinishedJobs() throws {
        let store = store()
        store.apply(.jobUpdated(try job("a", .running, created: 1, updated: 5)))
        store.apply(.jobUpdated(try job("a", .queued, created: 1, updated: 4)))
        #expect(store.jobs.first?.status == .running, "older frame must not win")
        #expect(store.lastFinished == nil)
        store.apply(.jobUpdated(try job("a", .succeeded, created: 1, updated: 6)))
        #expect(store.lastFinished?.id == "a")
        store.apply(.jobUpdated(try job("b", .queued, created: 2)))
        #expect(store.jobs.map(\.id) == ["b", "a"])
        #expect(store.activeJobs.map(\.id) == ["b"])
        #expect(store.finishedJobs.map(\.id) == ["a"])
    }

    @Test func presenceFrameUpdatesTheMacStatus() throws {
        let store = store()
        var presence = try Fixture.decode(WorkerPresence.self, "presence")
        presence.online = true
        store.apply(.presence(presence))
        #expect(store.macOnline == true)
    }

    @Test func pollsOnlyAfterTwoFailedConnects() {
        #expect(!JobsStore.shouldPoll(.connecting(attempt: 1)))
        #expect(!JobsStore.shouldPoll(.waiting(failures: 1, delay: .seconds(1))))
        #expect(JobsStore.shouldPoll(.waiting(failures: 2, delay: .seconds(2))))
        #expect(!JobsStore.shouldPoll(.open))
    }

    @Test func streamOpenStopsPolling() {
        let store = store()
        store.pollInterval = .seconds(3600)
        store.handle(.state(.waiting(failures: 2, delay: .seconds(2))))
        #expect(store.isPolling)
        store.handle(.state(.open))
        #expect(!store.isPolling)
        store.stop()
    }

    @Test func pollingFallbackLoadsJobsAndPresence() async throws {
        let (client, _) = StubProtocol.client(handler: route([
            "GET /api/jobs": .fixture(200, "job-list"),
            "GET /api/workers/presence": .fixture(200, "presence"),
        ]))
        let store = JobsStore(api: client, connector: ScriptedConnector([]))
        await store.pollOnce()
        #expect(store.jobs.count == 1)
        #expect(store.presence != nil)
        #expect(store.pollError == nil)
    }

    @Test func liveStreamFeedsTheStore() async throws {
        let (client, _) = StubProtocol.client { _ in .fail(.cannotConnectToHost) }
        let connector = ScriptedConnector([.frames([try Fixture.text("stream-snapshot")])])
        let store = JobsStore(api: client, connector: connector)
        store.streamDependencies = { connector in
            var deps = JobStream.Dependencies(connector: connector)
            deps.pingInterval = nil
            deps.sleep = { _ in try await Task.sleep(for: .seconds(60)) }
            return deps
        }
        store.start(brandId: nil)
        for _ in 0..<100 where store.presence == nil { try await Task.sleep(for: .milliseconds(20)) }
        #expect(store.presence?.online == false)
        #expect(!store.jobs.isEmpty)
        store.stop()
        #expect(store.streamState == .idle)
    }

    @Test func cancelUpdatesTheJob() async throws {
        let (client, _) = StubProtocol.client(handler: route([
            "POST /api/jobs/\(try Fixture.decode(Job.self, "job-cancelled").id)/cancel": .fixture(200, "job-cancelled"),
        ]))
        let store = JobsStore(api: client, connector: ScriptedConnector([]))
        var queued = try Fixture.decode(Job.self, "job-cancelled")
        queued.status = .queued
        queued.updatedAt = .distantPast
        store.upsert(queued)
        try await store.cancel(queued)
        #expect(store.jobs.first?.status == .cancelled)
    }
}

@MainActor
@Suite("Content detail: approval by hash")
struct ContentDetailModelTests {
    private func routes(content: String = "content-with-version", approve: StubProtocol.Response = .fixture(200, "content-approved")) throws -> (APIClient, String, String) {
        let version = try Fixture.decode(ContentVersion.self, "version")
        let id = version.contentId
        let (client, host) = StubProtocol.client(handler: route([
            "GET /api/contents/\(id)": .fixture(200, content),
            "GET /api/contents/\(id)/versions": .fixture(200, "version-list"),
            "GET /api/contents/\(id)/versions/1": .fixture(200, "version"),
            "GET /api/schedules": .fixture(200, "schedule-list"),
            "GET /api/social-accounts": .fixture(200, "social-account-list"),
            "POST /api/contents/\(id)/approve": approve,
            "PATCH /api/contents/\(id)": .fixture(200, "content-with-version"),
        ]))
        return (client, host, id)
    }

    @Test func loadsContentVersionsAndTheCurrentVersion() async throws {
        let (client, _, id) = try routes()
        let model = ContentDetailModel(contentId: id)
        await model.load(api: client)
        #expect(model.content.value?.id == id)
        #expect(model.versions.value?.count == 1)
        #expect(model.shown.value?.version == 1)
        #expect(model.isShowingCurrentVersion)
        #expect(model.canApprove)
        #expect(model.schedulableAccounts.count == 1)
    }

    @Test func approvesWithTheLocallyVerifiedHash() async throws {
        let (client, host, id) = try routes()
        let model = ContentDetailModel(contentId: id)
        await model.load(api: client)
        await model.beginApproval(api: client)
        let expected = try Fixture.decode(ContentVersion.self, "version").contentHash
        #expect(model.approval == .confirming(version: 1, hash: expected))
        await model.confirmApproval(api: client)
        #expect(model.approval == .idle)
        #expect(model.content.value?.status == .approved)
        let approve = try #require(StubProtocol.requests(for: host).last { $0.url.path().hasSuffix("/approve") })
        #expect(approve.body.map { String(decoding: $0, as: UTF8.self) } == "{\"hash\":\"\(expected)\"}")
    }

    @Test func refusesWhenTheShownSlidesDoNotMatchTheirHash() async throws {
        let (client, host, id) = try routes()
        let model = ContentDetailModel(contentId: id)
        await model.load(api: client)
        model.shown.value?.slides[0].html = "<p>tampered</p>"
        await model.beginApproval(api: client)
        guard case .outdated = model.approval else { Issue.record("got \(model.approval)"); return }
        #expect(!StubProtocol.requests(for: host).contains { $0.url.path().hasSuffix("/approve") })
    }

    @Test func serverHashMismatchReloads() async throws {
        let (client, _, id) = try routes(approve: .fixture(409, "error-hash-mismatch"))
        let model = ContentDetailModel(contentId: id)
        await model.load(api: client)
        await model.beginApproval(api: client)
        await model.confirmApproval(api: client)
        guard case .outdated = model.approval else { Issue.record("got \(model.approval)"); return }
    }

    @Test func alreadyApprovedContentIsNotApprovable() async throws {
        let (client, _, id) = try routes(content: "content-approved")
        let model = ContentDetailModel(contentId: id)
        await model.load(api: client)
        #expect(!model.canApprove)
        await model.beginApproval(api: client)
        guard case .outdated = model.approval else { Issue.record("got \(model.approval)"); return }
    }

    @Test func captionSaveSendsOnlyTheCaption() async throws {
        let (client, host, id) = try routes()
        let model = ContentDetailModel(contentId: id)
        await model.load(api: client)
        let saved = await model.saveCaption("Yeni açıklama", api: client)
        #expect(saved)
        let patch = try #require(StubProtocol.requests(for: host).first { $0.method == "PATCH" })
        #expect(patch.body.map { String(decoding: $0, as: UTF8.self) } == #"{"caption":"Yeni açıklama"}"#)
    }
}

@Suite("Credential storage")
struct CredentialStoreTests {
    @Test func keychainRoundTrip() throws {
        let store = KeychainCredentialStore(service: "net.burakkoc.studio.tests", account: UUID().uuidString)
        defer { try? store.delete() }
        #expect(try store.load() == nil)
        try store.save(AccessCredentials(clientId: "id", clientSecret: "one"))
        try store.save(AccessCredentials(clientId: "id", clientSecret: "two"))
        #expect(try store.load() == AccessCredentials(clientId: "id", clientSecret: "two"))
        try store.delete()
        #expect(try store.load() == nil)
        try store.delete() // deleting nothing is fine
    }

    @Test func authorizerOnlySendsCompleteCredentials() async {
        #expect(await AccessServiceTokenAuthorizer(credentials: nil).authorizationHeaders().isEmpty)
        #expect(await AccessServiceTokenAuthorizer(credentials: .init(clientId: "x", clientSecret: " ")).authorizationHeaders().isEmpty)
        #expect(await AccessServiceTokenAuthorizer(credentials: .init(clientId: "x", clientSecret: "y")).authorizationHeaders().count == 2)
    }
}

@Suite("Loadable")
struct LoadableTests {
    @Test func keepsTheLastValueWhileReloadingAndAfterAnError() {
        var loadable = Loadable<Int>()
        guard case .loading = loadable.phase else { Issue.record("idle should look like loading"); return }
        loadable.begin()
        loadable.succeed(1)
        loadable.begin()
        guard case .loaded(1) = loadable.phase else { Issue.record("value lost while reloading"); return }
        loadable.fail(.offline)
        guard case .loaded(1) = loadable.phase else { Issue.record("value lost after error"); return }
        #expect(loadable.error == .offline)
    }

    @Test func errorWithoutValueIsFailed() {
        var loadable = Loadable<Int>()
        loadable.begin()
        loadable.fail(.offline)
        guard case .failed(.offline) = loadable.phase else { Issue.record("expected failed"); return }
    }

    @Test func cancellationIsNotAnError() {
        var loadable = Loadable<Int>()
        loadable.begin()
        loadable.fail(.cancelled)
        #expect(loadable.error == nil)
    }
}
