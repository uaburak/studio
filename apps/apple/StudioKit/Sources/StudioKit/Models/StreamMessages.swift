import Foundation

// protocol.ts (client job stream) and chat-stream.ts (conversation stream).

/// Frames of `GET /api/jobs/stream`.
public enum JobStreamMessage: Sendable, Equatable {
    /// Matching jobs (newest first, at most 50) plus presence; replaces local state.
    case snapshot(jobs: [Job], presence: WorkerPresence)
    case jobUpdated(Job)
    case presence(WorkerPresence)
    case pong(ts: Double)
    /// A frame type this build does not know.
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey { case type, jobs, presence, job, ts }

    public static func decode(_ text: String) throws -> JobStreamMessage {
        try StudioJSON.decoder().decode(Wire.self, from: Data(text.utf8)).message
    }

    private struct Wire: Decodable {
        var message: JobStreamMessage

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let type = try c.decode(String.self, forKey: .type)
            switch type {
            case "jobs.snapshot":
                message = .snapshot(jobs: try c.decode([Job].self, forKey: .jobs), presence: try c.decode(WorkerPresence.self, forKey: .presence))
            case "job.updated": message = .jobUpdated(try c.decode(Job.self, forKey: .job))
            case "presence": message = .presence(try c.decode(WorkerPresence.self, forKey: .presence))
            case "pong": message = .pong(ts: try c.decode(Double.self, forKey: .ts))
            default: message = .unknown(type: type)
            }
        }
    }
}

/// `{"type":"ping","ts":<ms>}`: clients may send it on both streams.
public func pingFrame(at date: Date) -> String {
    "{\"type\":\"ping\",\"ts\":\(Int64(date.timeIntervalSince1970 * 1000))}"
}

/// Frames of `GET /api/conversations/{id}/stream`.
public enum ConversationStreamMessage: Sendable, Equatable {
    case snapshot(ConversationSnapshot)
    /// Sent after the replayed events of a resume (`?after=`).
    case resumed(seq: Int, replayed: Int, presence: WorkerPresence)
    case event(seq: Int, ConversationEvent)
    case presence(WorkerPresence)
    case pong(ts: Double)
    case unknown(type: String, seq: Int?)

    public var seq: Int? {
        switch self {
        case .snapshot(let snapshot): snapshot.seq
        case .resumed(let seq, _, _): seq
        case .event(let seq, _): seq
        case .unknown(_, let seq): seq
        case .presence, .pong: nil
        }
    }

    public static func decode(_ text: String) throws -> ConversationStreamMessage {
        try StudioJSON.decoder().decode(Wire.self, from: Data(text.utf8)).message
    }

    private enum CodingKeys: String, CodingKey {
        case type, seq, message, messageId, index, part, text, run, plan, conversation, presence, replayed, ts
        case messages, hasMoreMessages, activeRun, plans, aliases
    }

    private struct Wire: Decodable {
        var message: ConversationStreamMessage

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let type = try c.decode(String.self, forKey: .type)
            func seq() throws -> Int { try c.decode(Int.self, forKey: .seq) }
            switch type {
            case "conversation.snapshot":
                message = .snapshot(ConversationSnapshot(
                    seq: try seq(),
                    conversation: try c.decode(Conversation.self, forKey: .conversation),
                    messages: try c.decode([Message].self, forKey: .messages),
                    hasMoreMessages: try c.decode(Bool.self, forKey: .hasMoreMessages),
                    activeRun: try c.decodeIfPresent(AgentRun.self, forKey: .activeRun),
                    plans: try c.decode([Plan].self, forKey: .plans),
                    aliases: try c.decodeIfPresent([ConversationAlias].self, forKey: .aliases) ?? [],
                    presence: try c.decode(WorkerPresence.self, forKey: .presence)))
            case "conversation.resumed":
                message = .resumed(seq: try seq(), replayed: try c.decode(Int.self, forKey: .replayed), presence: try c.decode(WorkerPresence.self, forKey: .presence))
            case "message.created":
                message = .event(seq: try seq(), .messageCreated(try c.decode(Message.self, forKey: .message)))
            case "message.updated":
                message = .event(seq: try seq(), .messageUpdated(try c.decode(Message.self, forKey: .message)))
            case "part.added":
                message = .event(seq: try seq(), .partAdded(messageId: try c.decode(String.self, forKey: .messageId), index: try c.decode(Int.self, forKey: .index), part: try c.decode(MessagePart.self, forKey: .part)))
            case "part.updated":
                message = .event(seq: try seq(), .partUpdated(messageId: try c.decode(String.self, forKey: .messageId), index: try c.decode(Int.self, forKey: .index), part: try c.decode(MessagePart.self, forKey: .part)))
            case "text.delta":
                message = .event(seq: try seq(), .textDelta(messageId: try c.decode(String.self, forKey: .messageId), index: try c.decode(Int.self, forKey: .index), text: try c.decode(String.self, forKey: .text)))
            case "run.updated":
                message = .event(seq: try seq(), .runUpdated(try c.decode(AgentRun.self, forKey: .run)))
            case "plan.updated":
                message = .event(seq: try seq(), .planUpdated(try c.decode(Plan.self, forKey: .plan)))
            case "conversation.updated":
                message = .event(seq: try seq(), .conversationUpdated(try c.decode(Conversation.self, forKey: .conversation), aliases: try c.decodeIfPresent([ConversationAlias].self, forKey: .aliases)))
            case "presence":
                message = .presence(try c.decode(WorkerPresence.self, forKey: .presence))
            case "pong":
                message = .pong(ts: try c.decode(Double.self, forKey: .ts))
            default:
                message = .unknown(type: type, seq: try c.decodeIfPresent(Int.self, forKey: .seq))
            }
        }
    }
}

public struct ConversationSnapshot: Sendable, Equatable {
    public var seq: Int
    public var conversation: Conversation
    /// Oldest first.
    public var messages: [Message]
    public var hasMoreMessages: Bool
    public var activeRun: AgentRun?
    /// Plans of the conversation except superseded ones, newest first.
    public var plans: [Plan]
    /// Every alias of the conversation, oldest first.
    public var aliases: [ConversationAlias]
    public var presence: WorkerPresence

    public init(seq: Int, conversation: Conversation, messages: [Message], hasMoreMessages: Bool = false, activeRun: AgentRun? = nil, plans: [Plan] = [], aliases: [ConversationAlias] = [], presence: WorkerPresence) {
        self.seq = seq
        self.conversation = conversation
        self.messages = messages
        self.hasMoreMessages = hasMoreMessages
        self.activeRun = activeRun
        self.plans = plans
        self.aliases = aliases
        self.presence = presence
    }
}

/// Stored, sequenced events.
public enum ConversationEvent: Sendable, Equatable {
    case messageCreated(Message)
    /// Replaces the whole message.
    case messageUpdated(Message)
    case partAdded(messageId: EntityID, index: Int, part: MessagePart)
    case partUpdated(messageId: EntityID, index: Int, part: MessagePart)
    /// Append to the text part at `index` (a new text part when `index` is the next free slot).
    case textDelta(messageId: EntityID, index: Int, text: String)
    case runUpdated(AgentRun)
    case planUpdated(Plan)
    /// Also carries aliases added or renamed by the change (upsert by id).
    case conversationUpdated(Conversation, aliases: [ConversationAlias]?)
}
