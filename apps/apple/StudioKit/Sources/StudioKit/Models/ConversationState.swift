import Foundation

/// Client-side view of one conversation, built from stream frames.
///
/// A direct port of `applyConversationStreamMessage` in
/// packages/contract/src/chat-stream.ts: before the first snapshot only a
/// snapshot creates state; events at or below `seq` are duplicates and are
/// ignored; a gap marks the state `stale` (reconnect with `after = seq`).
public struct ConversationState: Sendable, Equatable {
    /// Last applied seq; reconnect with `?after=` this value.
    public var seq: Int
    public var conversation: Conversation
    /// Oldest first.
    public var messages: [Message]
    public var hasMoreMessages: Bool
    public var activeRun: AgentRun?
    /// Newest first.
    public var plans: [Plan]
    /// Attachment aliases, oldest first.
    public var aliases: [ConversationAlias]
    public var presence: WorkerPresence?
    /// Set when a seq gap was seen.
    public var stale: Bool
    /// Sequenced frames this build could not read and stepped past (unreadable or unknown).
    public var skippedFrames: Int

    public init(snapshot: ConversationSnapshot) {
        seq = snapshot.seq
        conversation = snapshot.conversation
        messages = snapshot.messages
        hasMoreMessages = snapshot.hasMoreMessages
        activeRun = snapshot.activeRun
        plans = snapshot.plans
        aliases = snapshot.aliases
        presence = snapshot.presence
        stale = false
        skippedFrames = 0
    }

    /// Apply one frame. Returns the new state (nil only while no snapshot arrived).
    public static func apply(_ state: ConversationState?, _ frame: ConversationStreamMessage) -> ConversationState? {
        if case .snapshot(let snapshot) = frame { return ConversationState(snapshot: snapshot) }
        guard var next = state else { return nil }
        switch frame {
        case .snapshot:
            return next // handled above
        case .presence(let presence):
            next.presence = presence
            return next
        case .pong:
            return next
        case .unknown(_, let seq):
            // A sequenced event type this build does not know: step past it (never resume before it).
            guard let seq else { return next }
            return advance(next, to: seq) { $0.skippedFrames += 1 }
        case .unreadable(let frame):
            guard let seq = frame.seq, frame.type != "conversation.snapshot", frame.type != "conversation.resumed" else { return next }
            return advance(next, to: seq) { $0.recordUnreadable(frame, seq: seq) }
        case .resumed(let seq, _, let presence):
            next.presence = presence
            next.stale = next.stale || seq != next.seq
            return next
        case .event(let seq, let event):
            if seq <= next.seq { return next }
            if seq != next.seq + 1 {
                next.stale = true
                return next
            }
            next.seq = seq
            next.apply(event)
            return next
        }
    }

    /// Apply a frame that has `seq`: duplicates are ignored, a gap marks the state stale.
    private static func advance(_ state: ConversationState, to seq: Int, _ change: (inout ConversationState) -> Void) -> ConversationState {
        var next = state
        if seq <= next.seq { return next }
        if seq != next.seq + 1 {
            next.stale = true
            return next
        }
        next.seq = seq
        change(&next)
        return next
    }

    /// Keep what can be kept of a frame that did not decode: a message (or part) shows as
    /// "Bu mesaj bu sürümde gösterilemiyor"; other changes are skipped.
    private mutating func recordUnreadable(_ frame: UnreadableFrame, seq: Int) {
        skippedFrames += 1
        switch frame.type {
        case "message.created", "message.updated":
            let id = frame.messageId ?? "unreadable-\(seq)"
            if let index = messages.firstIndex(where: { $0.id == id }) {
                messages[index].parts = [.unreadable]
            } else {
                let date = frame.createdAt ?? messages.last?.createdAt ?? Date()
                messages.append(Message(
                    id: id, conversationId: conversation.id, role: frame.role ?? .assistant,
                    parts: [.unreadable], createdAt: date, updatedAt: date))
            }
        case "part.added", "part.updated":
            guard let messageId = frame.messageId, let index = frame.index else { return }
            mapMessage(messageId) { $0.setPart(.unreadable, at: index) }
        default:
            break
        }
    }

    private mutating func apply(_ event: ConversationEvent) {
        switch event {
        case .messageCreated(let message), .messageUpdated(let message):
            upsert(&messages, message, prepend: false)
        case .partAdded(let messageId, let index, let part), .partUpdated(let messageId, let index, let part):
            mapMessage(messageId) { $0.setPart(part, at: index) }
        case .textDelta(let messageId, let index, let text):
            mapMessage(messageId) { message in
                var current = ""
                if index < message.parts.count, case .text(let existing) = message.parts[index] { current = existing }
                message.setPart(.text(current + text), at: index)
            }
        case .runUpdated(let run):
            if run.status.isActive {
                activeRun = run
            } else if activeRun?.id == run.id {
                activeRun = nil
            }
        case .planUpdated(let plan):
            upsert(&plans, plan, prepend: true)
        case .conversationUpdated(let conversation, let aliases):
            self.conversation = conversation
            for alias in aliases ?? [] { upsert(&self.aliases, alias, prepend: false) }
        }
    }

    private mutating func mapMessage(_ id: EntityID, _ transform: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        transform(&messages[index])
    }

    private func upsert<T: Identifiable>(_ list: inout [T], _ item: T, prepend: Bool) {
        if let index = list.firstIndex(where: { $0.id == item.id }) {
            list[index] = item
        } else if prepend {
            list.insert(item, at: 0)
        } else {
            list.append(item)
        }
    }

    // MARK: - Derived

    public func plan(id: EntityID) -> Plan? { plans.first { $0.id == id } }

    /// The newest open (draft / proposed) plan.
    public var openPlan: Plan? { plans.first { $0.status.isOpen } }

    public func alias(id: EntityID?) -> ConversationAlias? {
        guard let id else { return nil }
        return aliases.first { $0.id == id }
    }

    /// Current name of an attachment part's alias (falls back to the stored name).
    public func aliasName(for part: AttachmentPart) -> String? {
        alias(id: part.aliasId)?.alias ?? part.alias ?? aliases.first { $0.assetId == part.assetId }?.alias
    }

    /// Mentions of a message: the server's list, else resolved locally (older messages).
    public func mentions(in message: Message, text: String) -> [MessageMention] {
        if let mentions = message.mentions { return mentions }
        return MentionText.resolve(text, aliases: aliases.map(MentionText.Target.init))
    }

    /// Content ids created from this conversation's plans.
    public var contentIds: [EntityID] {
        plans.flatMap(\.items).compactMap(\.contentId)
    }
}

extension Message {
    /// Put `part` at `index`: replace, or append when `index` is the next free slot.
    /// (JS arrays fill holes with `undefined`; a hole here would be a server bug, so it is ignored.)
    mutating func setPart(_ part: MessagePart, at index: Int) {
        if index < parts.count {
            parts[index] = part
        } else if index == parts.count {
            parts.append(part)
        }
    }
}
