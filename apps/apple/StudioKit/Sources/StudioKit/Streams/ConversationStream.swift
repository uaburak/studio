import Foundation
import Synchronization

/// What a conversation feed emits.
public enum ConversationFeedEvent: Sendable, Equatable {
    case state(LiveState)
    /// The reduced state after a frame changed it.
    case conversation(ConversationState)
}

/// Live view of one conversation over `GET /api/conversations/{id}/stream`.
///
/// Applies frames with the `ConversationState` reducer. Reconnects with
/// backoff and resumes from the last applied seq (`?after=`), so no event is
/// lost or applied twice. A seq gap (should not happen) drops the socket and
/// resumes from the last good seq.
public struct ConversationStream: Sendable {
    public var deps: StreamDependencies
    private let target: @Sendable (_ after: Int?) async throws -> (URL, [String: String])

    public init(deps: StreamDependencies = StreamDependencies(), target: @escaping @Sendable (_ after: Int?) async throws -> (URL, [String: String])) {
        self.deps = deps
        self.target = target
    }

    public init(client: APIClient, conversationId: EntityID, deps: StreamDependencies = StreamDependencies()) {
        self.init(deps: deps) { after in
            let url = try client.conversationStreamURL(conversationId, after: after)
            return (url, try await client.authHeaders())
        }
    }

    public func events(startingFrom initial: ConversationState? = nil) -> AsyncStream<ConversationFeedEvent> {
        AsyncStream(bufferingPolicy: .bufferingNewest(512)) { continuation in
            let task = Task {
                await run(initial: initial) { continuation.yield($0) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func run(initial: ConversationState?, emit: @escaping @Sendable (ConversationFeedEvent) -> Void) async {
        let state = Mutex<ConversationState?>(initial)
        let target = self.target
        await SocketLoop.run(
            deps: deps,
            target: {
                let after = state.withLock { $0.map(\.seq) }
                return try await target(after)
            },
            onState: { emit(.state($0)) },
            onFrame: { text in
                guard let frame = try? ConversationStreamMessage.decode(text) else { return .keepReading }
                let (changed, next) = state.withLock { current -> (Bool, ConversationState?) in
                    let next = ConversationState.apply(current, frame)
                    let changed = next != current
                    current = next.map { var s = $0; s.stale = false; return s } ?? current
                    return (changed, next)
                }
                if let next, changed { emit(.conversation(next)) }
                return next?.stale == true ? .reconnect : .keepReading
            })
    }
}
