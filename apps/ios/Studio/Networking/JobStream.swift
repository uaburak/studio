import Foundation
import Synchronization

/// Exponential reconnect delay: 1 s, 2 s, 4 s … capped at 30 s, with ±jitter
/// so many clients do not reconnect in lockstep. Matches the web client's
/// `jobs.watch` (packages/contract/src/client.ts).
struct Backoff: Sendable, Equatable {
    var initial: Duration = .seconds(1)
    var maximum: Duration = .seconds(30)
    var multiplier: Double = 2
    /// 0.2 = up to ±20 %.
    var jitter: Double = 0.2

    /// Delay before reconnect attempt number `failures` (1-based). `random` is in 0...1.
    func delay(afterFailures failures: Int, random: Double) -> Duration {
        let exponent = Double(max(0, failures - 1))
        let base = min(initial.seconds * pow(multiplier, exponent), maximum.seconds)
        let factor = 1 - jitter + 2 * jitter * min(max(random, 0), 1)
        return .milliseconds(Int64((min(base * factor, maximum.seconds) * 1000).rounded()))
    }
}

extension Duration {
    var seconds: Double {
        let (s, attoseconds) = components
        return Double(s) + Double(attoseconds) / 1e18
    }
}

enum JobStreamState: Sendable, Equatable {
    case idle
    /// Opening the socket; `attempt` counts consecutive tries since the last success.
    case connecting(attempt: Int)
    /// First frame (the snapshot) arrived.
    case open
    /// Waiting `delay` before the next try after `failures` consecutive failures.
    case waiting(failures: Int, delay: Duration)

    var isOpen: Bool { self == .open }
}

enum JobStreamEvent: Sendable, Equatable {
    case state(JobStreamState)
    case message(JobStreamMessage)
}

/// Live job updates over `GET /api/jobs/stream` with automatic reconnect.
///
/// `events(...)` runs until the consumer stops iterating (cancel the task that
/// iterates). Every (re)connect starts with a `jobs.snapshot` that replaces
/// local state, so nothing is lost across drops. While open, the client sends
/// `ping` every `pingInterval` and drops a connection that stayed silent for
/// two intervals (a half-open socket after sleep or a network change).
enum JobStream {
    struct Dependencies: Sendable {
        var connector: any WebSocketConnecting
        var backoff = Backoff()
        /// nil disables pings (tests).
        var pingInterval: Duration? = .seconds(25)
        var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
        var random: @Sendable () -> Double = { Double.random(in: 0...1) }
        var now: @Sendable () -> Date = { .now }
    }

    static func events(
        url: URL, headers: [String: String], dependencies: Dependencies
    ) -> AsyncStream<JobStreamEvent> {
        AsyncStream(bufferingPolicy: .bufferingNewest(256)) { continuation in
            let task = Task {
                await run(url: url, headers: headers, deps: dependencies, emit: { continuation.yield($0) })
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func run(
        url: URL, headers: [String: String], deps: Dependencies, emit: @Sendable (JobStreamEvent) -> Void
    ) async {
        var failures = 0
        while !Task.isCancelled {
            emit(.state(.connecting(attempt: failures + 1)))
            do {
                let connection = try await deps.connector.connect(url: url, headers: headers)
                try await withTaskCancellationHandler {
                    try await pump(connection, deps: deps) {
                        failures = 0
                        emit(.state(.open))
                    } onMessage: { emit(.message($0)) }
                } onCancel: {
                    connection.close()
                }
            } catch {
                // Fall through to the backoff below; the reason is not actionable for the UI.
            }
            if Task.isCancelled { return }
            failures += 1
            let delay = deps.backoff.delay(afterFailures: failures, random: deps.random())
            emit(.state(.waiting(failures: failures, delay: delay)))
            do { try await deps.sleep(delay) } catch { return }
        }
    }

    /// Reads frames until the socket fails. Calls `onOpen` once, on the first frame.
    private static func pump(
        _ connection: any WebSocketConnection, deps: Dependencies,
        onOpen: () -> Void, onMessage: @Sendable (JobStreamMessage) -> Void
    ) async throws {
        defer { connection.close() }
        let lastFrame = Locked(deps.now())
        let pinger: Task<Void, Never>? = deps.pingInterval.map { interval in
            Task {
                while !Task.isCancelled {
                    do { try await Task.sleep(for: interval) } catch { return }
                    let silence = deps.now().timeIntervalSince(lastFrame.value)
                    if silence > interval.seconds * 2 {
                        connection.close()
                        return
                    }
                    try? await connection.send(JobStreamMessage.ping(at: deps.now()))
                }
            }
        }
        defer { pinger?.cancel() }

        var opened = false
        while true {
            let text = try await connection.receive()
            let now = deps.now()
            lastFrame.value = now
            if !opened {
                opened = true
                onOpen()
            }
            if let message = try? JobStreamMessage.decode(text) {
                onMessage(message)
            }
        }
    }
}

/// A value guarded by a lock, shareable across tasks.
final class Locked<Value: Sendable>: Sendable {
    private let mutex: Mutex<Value>

    init(_ value: Value) { mutex = Mutex(value) }

    var value: Value {
        get { mutex.withLock { $0 } }
        set { mutex.withLock { $0 = newValue } }
    }

    func withLock<R: Sendable>(_ body: (inout Value) -> R) -> R {
        mutex.withLock { body(&$0) }
    }
}
