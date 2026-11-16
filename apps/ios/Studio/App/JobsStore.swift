import Foundation
import Observation

/// Live list of jobs and the Mac's presence for the selected brand.
///
/// Primary source: the job stream WebSocket (snapshot, then updates). When the
/// stream keeps failing (two failed connects in a row) the store polls
/// `GET /api/jobs` and `GET /api/workers/presence` until the stream is back.
/// The app stops everything in the background and restarts it in the
/// foreground (a new snapshot replaces whatever changed meanwhile).
@MainActor
@Observable
final class JobsStore {
    private(set) var jobs: [Job] = []
    private(set) var presence: WorkerPresence?
    private(set) var streamState: JobStreamState = .idle
    private(set) var isPolling = false
    private(set) var lastUpdated: Date?
    /// Last polling failure (shown when neither stream nor polling works).
    private(set) var pollError: APIError?
    /// The most recent job that moved from queued/running to a final status.
    private(set) var lastFinished: Job?

    @ObservationIgnored private var api: APIClient
    @ObservationIgnored private var connector: any WebSocketConnecting
    @ObservationIgnored private(set) var brandId: String?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored var pollInterval: Duration = .seconds(15)
    @ObservationIgnored var streamDependencies: (any WebSocketConnecting) -> JobStream.Dependencies = {
        JobStream.Dependencies(connector: $0)
    }

    init(api: APIClient, connector: any WebSocketConnecting) {
        self.api = api
        self.connector = connector
    }

    var isRunning: Bool { streamTask != nil }

    var activeJobs: [Job] { jobs.filter { $0.status.isActive } }
    var finishedJobs: [Job] { jobs.filter { !$0.status.isActive } }

    /// The Mac is online according to the latest presence (nil = unknown yet).
    var macOnline: Bool? { presence?.online }

    // MARK: Lifecycle

    func configure(api: APIClient, connector: any WebSocketConnecting) {
        self.api = api
        self.connector = connector
    }

    /// (Re)start following `brandId` (nil = all brands).
    func start(brandId: String?) {
        stop()
        if self.brandId != brandId {
            jobs = []
            lastFinished = nil
        }
        self.brandId = brandId
        let api = api
        let deps = streamDependencies(connector)
        let url = api.jobStreamURL(brandId: brandId)
        streamTask = Task { [weak self] in
            let headers = await api.authorizer.authorizationHeaders()
            for await event in JobStream.events(url: url, headers: headers, dependencies: deps) {
                guard let self else { return }
                self.handle(event)
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        stopPolling()
        streamState = .idle
    }

    // MARK: Events

    func handle(_ event: JobStreamEvent) {
        switch event {
        case .state(let state):
            streamState = state
            if state.isOpen {
                pollError = nil
                stopPolling()
            } else if Self.shouldPoll(state) {
                startPolling()
            }
        case .message(let message):
            apply(message)
        }
    }

    /// Two consecutive failed connects mean the stream is not coming back soon.
    nonisolated static func shouldPoll(_ state: JobStreamState) -> Bool {
        if case .waiting(let failures, _) = state { return failures >= 2 }
        return false
    }

    /// Reducer for stream frames.
    func apply(_ message: JobStreamMessage) {
        switch message {
        case .snapshot(let snapshot, let presence):
            replace(with: snapshot)
            self.presence = presence
        case .jobUpdated(let job):
            upsert(job)
        case .presence(let presence):
            self.presence = presence
        case .pong:
            break
        }
        lastUpdated = .now
    }

    /// Insert or replace one job (stream update, cancel response, new job).
    func upsert(_ job: Job) {
        if let brandId, let jobBrand = job.brandId, jobBrand != brandId { return }
        if let index = jobs.firstIndex(where: { $0.id == job.id }) {
            let previous = jobs[index]
            // Ignore stale frames (an older update arriving after a newer one).
            guard job.updatedAt >= previous.updatedAt else { return }
            jobs[index] = job
            if previous.status.isActive && job.status.isTerminal { lastFinished = job }
        } else {
            jobs.append(job)
            jobs.sort { $0.createdAt > $1.createdAt }
        }
    }

    private func replace(with snapshot: [Job]) {
        let previous = Dictionary(uniqueKeysWithValues: jobs.map { ($0.id, $0) })
        jobs = snapshot.sorted { $0.createdAt > $1.createdAt }
        if let finished = jobs.first(where: { job in
            job.status.isTerminal && (previous[job.id]?.status.isActive ?? false)
        }) {
            lastFinished = finished
        }
    }

    // MARK: Polling fallback

    private func startPolling() {
        guard pollTask == nil else { return }
        isPolling = true
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pollOnce()
                do { try await Task.sleep(for: self.pollInterval) } catch { return }
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
    }

    /// One REST refresh of jobs and presence (also pull-to-refresh).
    func pollOnce() async {
        do {
            async let page = api.jobs(brandId: brandId)
            async let presence = api.presence()
            let (jobs, current) = try await (page, presence)
            replace(with: jobs.items)
            self.presence = current
            lastUpdated = .now
            pollError = nil
        } catch {
            pollError = APIError.from(error)
        }
    }

    // MARK: Actions

    func cancel(_ job: Job) async throws(APIError) {
        let updated = try await api.cancelJob(id: job.id)
        upsert(updated)
    }
}
