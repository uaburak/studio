import Foundation
import Testing
@testable import StudioKit

@Suite("Live streams: reconnect, backoff, polling fallback, resume")
struct StreamTests {
    @Test func backoffDoublesUpToTheCapWithJitter() {
        let backoff = Backoff()
        #expect(backoff.delay(afterFailures: 1, random: 0.5) == .seconds(1))
        #expect(backoff.delay(afterFailures: 2, random: 0.5) == .seconds(2))
        #expect(backoff.delay(afterFailures: 3, random: 0.5) == .seconds(4))
        #expect(backoff.delay(afterFailures: 10, random: 0.5) == .seconds(30))
        #expect(backoff.delay(afterFailures: 1, random: 0) == .milliseconds(800))
        #expect(backoff.delay(afterFailures: 1, random: 1) == .milliseconds(1200))
        #expect(backoff.delay(afterFailures: 20, random: 1) == .seconds(30))
    }

    private func deps(_ connector: FakeConnector, _ sleeper: SleepRecorder) -> StreamDependencies {
        StreamDependencies(connector: connector, pingInterval: nil, sleep: sleeper.sleep, random: { 0.5 })
    }

    @Test func reconnectsWithBackoffAndResetsAfterSuccess() async throws {
        let snapshot = try Fixture.text("stream-jobs-snapshot")
        let connector = FakeConnector([.refuse, .refuse, .frames([snapshot]), .refuse, .framesThenHang([snapshot])])
        let sleeper = SleepRecorder()
        let stream = JobStream(deps: deps(connector, sleeper), pollAfterFailures: 99, target: { (URL(string: "ws://x.test/api/jobs/stream")!, [:]) }, poll: nil)

        var snapshotsSeen = 0
        let events = await collect(stream.events()) { event, _ in
            if case .message(.snapshot) = event { snapshotsSeen += 1 }
            return snapshotsSeen == 2
        }
        let states = events.compactMap { if case .state(let s) = $0 { s } else { nil } }
        #expect(states == [
            .connecting(attempt: 1), .waiting(failures: 1, retryIn: .seconds(1)),
            .connecting(attempt: 2), .waiting(failures: 2, retryIn: .seconds(2)),
            .connecting(attempt: 3), .live,
            // The success reset the counter: the next drop starts over at 1 s.
            .waiting(failures: 1, retryIn: .seconds(1)),
            .connecting(attempt: 2), .waiting(failures: 2, retryIn: .seconds(2)),
            .connecting(attempt: 3), .live,
        ])
        #expect(sleeper.recorded == [.seconds(1), .seconds(2), .seconds(1), .seconds(2)])
        let snapshots = events.filter { if case .message(.snapshot) = $0 { true } else { false } }
        #expect(snapshots.count == 2)
        #expect(connector.connectCount == 5)
    }

    @Test func pollsOverHTTPWhileTheSocketKeepsFailing() async throws {
        let connector = FakeConnector([.refuse, .refuse, .refuse])
        let sleeper = SleepRecorder()
        let polls = ProgressBox()
        let presence = WorkerPresence(online: true)
        let stream = JobStream(
            deps: deps(connector, sleeper), pollAfterFailures: 2, pollInterval: .seconds(10),
            target: { (URL(string: "ws://x.test/api/jobs/stream")!, [:]) },
            poll: {
                polls.add(1)
                return ([], presence)
            })
        let events = await collect(stream.events()) { event, _ in
            if case .message(.snapshot) = event { return true }
            return false
        }
        // No polling after the first failure; polling after the second.
        let states = events.compactMap { if case .state(let s) = $0 { s } else { nil } }
        #expect(states.prefix(4) == [.connecting(attempt: 1), .waiting(failures: 1, retryIn: .seconds(1)), .connecting(attempt: 2), .waiting(failures: 2, retryIn: .seconds(2))])
        #expect(states.last == .polling)
        #expect(events.last == .message(.snapshot(jobs: [], presence: presence)))
        #expect(polls.values.count == 1)
    }

    @Test func boardAppliesSnapshotsAndUpdates() throws {
        var board = JobBoard()
        guard case .snapshot(let jobs, let presence) = try JobStreamMessage.decode(Fixture.text("stream-jobs-snapshot")) else {
            Issue.record("snapshot expected")
            return
        }
        board.apply(.message(.snapshot(jobs: jobs, presence: presence)))
        #expect(board.jobs.count == jobs.count)
        var updated = jobs[0]
        updated.status = .running
        board.apply(.message(.jobUpdated(updated)))
        #expect(board.jobs.first { $0.id == updated.id }?.status == .running)
        #expect(board.jobs.count == jobs.count)
        board.apply(.message(.presence(WorkerPresence(online: true))))
        #expect(board.presence?.online == true)
    }

    // MARK: Conversation stream

    private func snapshotFrame(seq: Int) throws -> String {
        var object = try JSONSerialization.jsonObject(with: Fixture.data("stream-conversation-snapshot")) as! [String: Any]
        object["seq"] = seq
        return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    private func conversationFrame(seq: Int, title: String) throws -> String {
        let snapshot = try JSONSerialization.jsonObject(with: Fixture.data("stream-conversation-snapshot")) as! [String: Any]
        var conversation = snapshot["conversation"] as! [String: Any]
        conversation["title"] = title
        let frame: [String: Any] = ["type": "conversation.updated", "seq": seq, "conversation": conversation]
        return String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self)
    }

    @Test func resumesFromTheLastAppliedSeq() async throws {
        let connector = FakeConnector([
            .frames([try snapshotFrame(seq: 30), try conversationFrame(seq: 31, title: "A")]),
            .framesThenHang([try conversationFrame(seq: 31, title: "A"), try conversationFrame(seq: 32, title: "B")]),
        ])
        let sleeper = SleepRecorder()
        let stream = ConversationStream(deps: deps(connector, sleeper)) { after in
            var components = URLComponents(string: "ws://x.test/api/conversations/c1/stream")!
            if let after { components.queryItems = [URLQueryItem(name: "after", value: String(after))] }
            return (components.url!, [:])
        }
        let events = await collect(stream.events()) { event, _ in
            if case .conversation(let state) = event { return state.conversation.title == "B" }
            return false
        }
        let urls = connector.recordedURLs.map(\.absoluteString)
        #expect(urls == ["ws://x.test/api/conversations/c1/stream", "ws://x.test/api/conversations/c1/stream?after=31"])
        let titles = events.compactMap { if case .conversation(let s) = $0 { s.conversation.title } else { nil } }
        // The duplicate seq 31 after the reconnect was ignored (no extra emission).
        #expect(titles == ["Kasım planı", "A", "B"])
    }

    @Test func aSeqGapReconnectsFromTheLastGoodSeq() async throws {
        let connector = FakeConnector([
            .frames([try snapshotFrame(seq: 30), try conversationFrame(seq: 33, title: "gap")]),
            .framesThenHang([try conversationFrame(seq: 31, title: "fixed")]),
        ])
        let sleeper = SleepRecorder()
        let stream = ConversationStream(deps: deps(connector, sleeper)) { after in
            (URL(string: "ws://x.test/s?after=\(after.map(String.init) ?? "-")")!, [:])
        }
        let events = await collect(stream.events()) { event, _ in
            if case .conversation(let state) = event { return state.conversation.title == "fixed" }
            return false
        }
        #expect(connector.recordedURLs.map(\.absoluteString) == ["ws://x.test/s?after=-", "ws://x.test/s?after=30"])
        #expect(!events.contains { if case .conversation(let s) = $0 { s.conversation.title == "gap" } else { false } })
        // A gap reconnects immediately, without a backoff sleep.
        #expect(sleeper.recorded.isEmpty)
    }

    @Test func reducerHandlesDeltasDuplicatesGapsAndAliases() throws {
        guard case .snapshot(let snapshot) = try ConversationStreamMessage.decode(Fixture.text("stream-conversation-snapshot")) else {
            Issue.record("snapshot expected")
            return
        }
        #expect(ConversationState.apply(nil, .presence(.offline)) == nil)
        var state = try #require(ConversationState.apply(nil, .snapshot(snapshot)))
        let messageId = try #require(state.messages.last?.id)
        let count = state.messages.last!.parts.count
        state = try #require(ConversationState.apply(state, .event(seq: snapshot.seq + 1, .textDelta(messageId: messageId, index: count, text: "Mer"))))
        state = try #require(ConversationState.apply(state, .event(seq: snapshot.seq + 2, .textDelta(messageId: messageId, index: count, text: "haba"))))
        #expect(state.messages.last?.parts.last == .text("Merhaba"))
        // Duplicate: ignored.
        let same = try #require(ConversationState.apply(state, .event(seq: snapshot.seq + 2, .textDelta(messageId: messageId, index: count, text: "!"))))
        #expect(same == state)
        // Gap: stale.
        let stale = try #require(ConversationState.apply(state, .event(seq: snapshot.seq + 5, .textDelta(messageId: messageId, index: count, text: "!"))))
        #expect(stale.stale)
        #expect(stale.seq == state.seq)
        // Alias upsert through conversation.updated.
        let alias = ConversationAlias(id: "al1", conversationId: state.conversation.id, alias: "image", assetId: "a1", mimeType: "image/png", createdAt: .now, updatedAt: .now)
        state = try #require(ConversationState.apply(state, .event(seq: state.seq + 1, .conversationUpdated(state.conversation, aliases: [alias]))))
        var renamed = alias
        renamed.alias = "tarla"
        renamed.previousAliases = ["image"]
        state = try #require(ConversationState.apply(state, .event(seq: state.seq + 1, .conversationUpdated(state.conversation, aliases: [renamed]))))
        #expect(state.aliases.filter { $0.id == "al1" }.map(\.alias) == ["tarla"])
        #expect(state.aliasName(for: AttachmentPart(assetId: "a1", mimeType: "image/png", alias: "image", aliasId: "al1")) == "tarla")
    }
}
