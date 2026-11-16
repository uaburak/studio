import Foundation
import Testing
@testable import Studio

/// Scripted WebSocket: each `connect` takes the next script entry.
final class ScriptedConnector: WebSocketConnecting {
    enum Script: Sendable {
        /// connect() throws
        case refuse
        /// connect() succeeds, receive() yields these frames, then the socket drops
        case frames([String])
    }

    private let scripts: Locked<[Script]>
    let connects = Locked(0)
    let headersSeen = Locked<[[String: String]]>([])

    init(_ scripts: [Script]) {
        self.scripts = Locked(scripts)
    }

    func connect(url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
        connects.withLock { $0 += 1 }
        headersSeen.withLock { $0.append(headers) }
        let next = scripts.withLock { $0.isEmpty ? Script.refuse : $0.removeFirst() }
        switch next {
        case .refuse: throw URLError(.cannotConnectToHost)
        case .frames(let frames): return ScriptedConnection(frames: frames)
        }
    }
}

final class ScriptedConnection: WebSocketConnection {
    private let frames: Locked<[String]>
    init(frames: [String]) { self.frames = Locked(frames) }

    func receive() async throws -> String {
        guard let frame = frames.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) else {
            throw URLError(.networkConnectionLost)
        }
        return frame
    }

    func send(_ text: String) async throws {}
    func close() {}
}

@Suite("Job stream reconnect")
struct JobStreamTests {
    @Test func backoffDoublesAndCaps() {
        let backoff = Backoff(jitter: 0)
        let delays = (1...7).map { backoff.delay(afterFailures: $0, random: 0.5).seconds }
        #expect(delays == [1, 2, 4, 8, 16, 30, 30])
    }

    @Test func jitterStaysWithinBounds() {
        let backoff = Backoff(jitter: 0.2)
        #expect(backoff.delay(afterFailures: 3, random: 0).seconds == 3.2)
        #expect(backoff.delay(afterFailures: 3, random: 1).seconds == 4.8)
        #expect(backoff.delay(afterFailures: 10, random: 1).seconds == 30)
    }

    /// refuse, refuse, open (snapshot + update) then drop, refuse:
    /// failures count 1, 2, reset on open, then 1 again.
    @Test func reconnectsWithBackoffAndResetsAfterSuccess() async throws {
        let snapshot = try Fixture.text("stream-snapshot")
        let updated = try Fixture.text("stream-job-updated")
        let connector = ScriptedConnector([.refuse, .refuse, .frames([snapshot, "{\"type\":\"future\"}", updated]), .refuse])
        let sleeps = Locked<[Double]>([])
        var deps = JobStream.Dependencies(connector: connector)
        deps.backoff = Backoff(jitter: 0)
        deps.pingInterval = nil
        // Return at once for the first three waits, then park (cancellable) so the
        // producer cannot run ahead of this test.
        deps.sleep = { duration in
            let count = sleeps.withLock { $0.append(duration.seconds); return $0.count }
            if count >= 3 { try await Task.sleep(for: .seconds(3600)) }
        }

        var events: [JobStreamEvent] = []
        var waits = 0
        for await event in JobStream.events(url: URL(string: "ws://x/api/jobs/stream")!, headers: ["A": "1"], dependencies: deps) {
            events.append(event)
            if case .state(.waiting) = event { waits += 1 }
            if waits == 3 { break }
        }

        let states = events.compactMap { if case .state(let s) = $0 { s } else { nil } }
        #expect(states == [
            .connecting(attempt: 1), .waiting(failures: 1, delay: .seconds(1)),
            .connecting(attempt: 2), .waiting(failures: 2, delay: .seconds(2)),
            .connecting(attempt: 3), .open, .waiting(failures: 1, delay: .seconds(1)),
        ])
        let messages = events.compactMap { if case .message(let m) = $0 { m } else { nil } }
        #expect(messages.count == 2, "unknown frame types are skipped")
        guard case .snapshot = messages.first else { Issue.record("first message must be the snapshot"); return }
        #expect(sleeps.value == [1, 2, 1])
        #expect(connector.headersSeen.value.allSatisfy { $0 == ["A": "1"] })
    }

    @Test func stopsWhenTheConsumerCancels() async throws {
        let connector = ScriptedConnector([])
        var deps = JobStream.Dependencies(connector: connector)
        deps.pingInterval = nil
        deps.sleep = { _ in try await Task.sleep(for: .seconds(60)) }
        let task = Task {
            var count = 0
            for await _ in JobStream.events(url: URL(string: "ws://x")!, headers: [:], dependencies: deps) { count += 1 }
            return count
        }
        try await Task.sleep(for: .milliseconds(100))
        task.cancel()
        let count = await task.value
        #expect(count == 2) // connecting(1), waiting(1)
        #expect(connector.connects.value == 1)
    }

    @Test func pingFrameMatchesTheContract() throws {
        let ping = JobStreamMessage.ping(at: Date(timeIntervalSince1970: 1.5))
        #expect(ping == #"{"type":"ping","ts":1500}"#)
    }
}
