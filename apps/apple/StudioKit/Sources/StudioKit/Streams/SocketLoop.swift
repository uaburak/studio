import Foundation
import Synchronization

/// Exponential reconnect delay: 1 s, 2 s, 4 s ... capped at 30 s, with
/// jitter so clients do not reconnect in lockstep. Same schedule as the web
/// client's `jobs.watch` (packages/contract/src/client.ts).
public struct Backoff: Sendable, Equatable {
    public var initial: Duration
    public var maximum: Duration
    public var multiplier: Double
    /// 0.2 = up to ±20 %.
    public var jitter: Double

    public init(initial: Duration = .seconds(1), maximum: Duration = .seconds(30), multiplier: Double = 2, jitter: Double = 0.2) {
        self.initial = initial
        self.maximum = maximum
        self.multiplier = multiplier
        self.jitter = jitter
    }

    /// Delay before reconnect attempt number `failures` (1-based). `random` is in 0...1.
    public func delay(afterFailures failures: Int, random: Double) -> Duration {
        let exponent = Double(max(0, failures - 1))
        let base = min(initial.seconds * pow(multiplier, exponent), maximum.seconds)
        let factor = 1 - jitter + 2 * jitter * min(max(random, 0), 1)
        return .milliseconds(Int64((min(base * factor, maximum.seconds) * 1000).rounded()))
    }
}

extension Duration {
    public var seconds: Double {
        let (s, attoseconds) = components
        return Double(s) + Double(attoseconds) / 1e18
    }
}

/// Connection state of a live stream, for the UI.
public enum LiveState: Sendable, Equatable {
    /// Opening the socket; `attempt` counts consecutive tries since the last success.
    case connecting(attempt: Int)
    /// The socket delivered its first frame.
    case live
    /// Waiting `retryIn` before the next try after `failures` consecutive failures.
    case waiting(failures: Int, retryIn: Duration)
    /// The socket keeps failing; data is being refreshed over HTTP meanwhile.
    case polling

    public var isLive: Bool { self == .live }
}

/// Injectable timing and transport, shared by the job and conversation streams.
public struct StreamDependencies: Sendable {
    public var connector: any WebSocketConnecting
    public var backoff: Backoff
    /// nil disables pings (tests). While open, a silent socket is dropped after two intervals.
    public var pingInterval: Duration?
    public var sleep: @Sendable (Duration) async throws -> Void
    public var random: @Sendable () -> Double
    public var now: @Sendable () -> Date

    public init(
        connector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        backoff: Backoff = Backoff(),
        pingInterval: Duration? = .seconds(25),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        random: @escaping @Sendable () -> Double = { Double.random(in: 0...1) },
        now: @escaping @Sendable () -> Date = { .now }
    ) {
        self.connector = connector
        self.backoff = backoff
        self.pingInterval = pingInterval
        self.sleep = sleep
        self.random = random
        self.now = now
    }
}

/// What to do after a frame.
enum FrameDecision: Sendable {
    case keepReading
    /// Drop the socket and reconnect right away (e.g. a seq gap).
    case reconnect
}

/// Reconnecting WebSocket loop. Runs until the surrounding task is cancelled.
enum SocketLoop {
    static func run(
        deps: StreamDependencies,
        target: @Sendable () async throws -> (URL, [String: String]),
        onState: @Sendable (LiveState) -> Void,
        onFrame: @Sendable (String) -> FrameDecision,
        whileWaiting: (@Sendable (_ failures: Int, _ delay: Duration) async -> Void)? = nil
    ) async {
        var failures = 0
        while !Task.isCancelled {
            onState(.connecting(attempt: failures + 1))
            var opened = false
            var immediate = false
            do {
                let (url, headers) = try await target()
                let connection = try await deps.connector.connect(url: url, headers: headers)
                let decision = try await withTaskCancellationHandler {
                    try await pump(connection, deps: deps, onOpen: {
                        opened = true
                        failures = 0
                        onState(.live)
                    }, onFrame: onFrame)
                } onCancel: {
                    connection.close()
                }
                immediate = decision == .reconnect
            } catch {
                // Fall through to the backoff below; the reason is not actionable for the UI.
            }
            if Task.isCancelled { return }
            if immediate && opened { continue }
            failures += 1
            let delay = deps.backoff.delay(afterFailures: failures, random: deps.random())
            onState(.waiting(failures: failures, retryIn: delay))
            if let whileWaiting {
                await whileWaiting(failures, delay)
            } else {
                do { try await deps.sleep(delay) } catch { return }
            }
        }
    }

    /// Reads frames until the socket fails or `onFrame` asks to reconnect.
    private static func pump(
        _ connection: any WebSocketConnection, deps: StreamDependencies,
        onOpen: () -> Void, onFrame: @Sendable (String) -> FrameDecision
    ) async throws -> FrameDecision {
        defer { connection.close() }
        let lastFrame = Mutex(deps.now())
        let pinger: Task<Void, Never>? = deps.pingInterval.map { interval in
            Task {
                while !Task.isCancelled {
                    do { try await deps.sleep(interval) } catch { return }
                    let silence = deps.now().timeIntervalSince(lastFrame.withLock { $0 })
                    if silence > interval.seconds * 2 {
                        connection.close()
                        return
                    }
                    try? await connection.send(pingFrame(at: deps.now()))
                }
            }
        }
        defer { pinger?.cancel() }

        var opened = false
        while true {
            let text = try await connection.receive()
            let now = deps.now()
            lastFrame.withLock { $0 = now }
            if !opened {
                opened = true
                onOpen()
            }
            if onFrame(text) == .reconnect { return .reconnect }
        }
    }
}
