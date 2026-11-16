import Foundation

/// What a job feed emits: connection state changes and stream frames.
public enum JobFeedEvent: Sendable, Equatable {
    case state(LiveState)
    case message(JobStreamMessage)
}

/// Live job updates over `GET /api/jobs/stream` with automatic reconnect and
/// an HTTP polling fallback.
///
/// Every (re)connect starts with a `jobs.snapshot` that replaces local state,
/// so nothing is lost across drops. After `pollAfterFailures` consecutive
/// failed connects, the waiting time between attempts is used to poll
/// `GET /api/jobs` + `GET /api/workers/presence`; the result is emitted as a
/// synthetic snapshot and the state becomes `.polling`.
public struct JobStream: Sendable {
    public typealias Poll = @Sendable () async throws -> (jobs: [Job], presence: WorkerPresence)

    public var deps: StreamDependencies
    public var pollAfterFailures: Int
    public var pollInterval: Duration
    private let target: @Sendable () async throws -> (URL, [String: String])
    private let poll: Poll?

    public init(
        deps: StreamDependencies = StreamDependencies(),
        pollAfterFailures: Int = 2,
        pollInterval: Duration = .seconds(10),
        target: @escaping @Sendable () async throws -> (URL, [String: String]),
        poll: Poll?
    ) {
        self.deps = deps
        self.pollAfterFailures = pollAfterFailures
        self.pollInterval = pollInterval
        self.target = target
        self.poll = poll
    }

    /// Stream for `client`: every job (or one brand's jobs).
    public init(client: APIClient, brandId: EntityID? = nil, deps: StreamDependencies = StreamDependencies()) {
        self.init(
            deps: deps,
            target: {
                let url = try client.jobStreamURL(brandId: brandId)
                return (url, try await client.authHeaders())
            },
            poll: {
                async let jobs = client.jobs(brandId: brandId, limit: 50)
                async let presence = client.presence()
                return (try await jobs, try await presence)
            })
    }

    /// Runs until the consumer stops iterating.
    public func events() -> AsyncStream<JobFeedEvent> {
        AsyncStream(bufferingPolicy: .bufferingNewest(256)) { continuation in
            let task = Task {
                await run { continuation.yield($0) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func run(emit: @escaping @Sendable (JobFeedEvent) -> Void) async {
        let deps = self.deps
        let poll = self.poll
        let threshold = pollAfterFailures
        let interval = pollInterval
        await SocketLoop.run(
            deps: deps,
            target: target,
            onState: { emit(.state($0)) },
            onFrame: { text in
                if let message = try? JobStreamMessage.decode(text) { emit(.message(message)) }
                return .keepReading
            },
            whileWaiting: { failures, delay in
                guard let poll, failures >= threshold else {
                    try? await deps.sleep(delay)
                    return
                }
                var remaining = delay
                repeat {
                    if Task.isCancelled { return }
                    if let result = try? await poll() {
                        emit(.state(.polling))
                        emit(.message(.snapshot(jobs: result.jobs, presence: result.presence)))
                    }
                    let step = remaining < interval ? remaining : interval
                    do { try await deps.sleep(step) } catch { return }
                    remaining -= step
                } while remaining > .zero
            })
    }
}

/// Local job list state built from feed frames (snapshot replaces, updates upsert).
public struct JobBoard: Sendable, Equatable {
    /// Newest first.
    public private(set) var jobs: [Job] = []
    public private(set) var presence: WorkerPresence?
    public private(set) var state: LiveState = .connecting(attempt: 1)

    public init(jobs: [Job] = [], presence: WorkerPresence? = nil) {
        self.jobs = jobs
        self.presence = presence
    }

    public mutating func apply(_ event: JobFeedEvent) {
        switch event {
        case .state(let state):
            self.state = state
        case .message(.snapshot(let jobs, let presence)):
            self.jobs = jobs.sorted { $0.createdAt > $1.createdAt }
            self.presence = presence
        case .message(.jobUpdated(let job)):
            if let index = jobs.firstIndex(where: { $0.id == job.id }) {
                jobs[index] = job
            } else {
                jobs.insert(job, at: 0)
            }
        case .message(.presence(let presence)):
            self.presence = presence
        case .message(.pong), .message(.unknown):
            break
        }
    }

    public var active: [Job] { jobs.filter { $0.status.isActive } }
    public func finished(since: Date) -> [Job] {
        jobs.filter { $0.status.isTerminal && ($0.finishedAt ?? $0.updatedAt) >= since }
    }
}
