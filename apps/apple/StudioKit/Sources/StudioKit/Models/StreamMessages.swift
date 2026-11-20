import Foundation

// protocol.ts (client job stream) and chat-stream.ts (conversation stream).

/// Frames of `GET /api/jobs/stream`.
public enum JobStreamMessage: Sendable, Equatable {
    /// Matching jobs (newest first, at most 50) plus presence; replaces local state.
    case snapshot(jobs: [Job], presence: WorkerPresence)
    case jobUpdated(Job)
    case presence(WorkerPresence)
    case pong(ts: Double)
    /// An approval request was created or decided (`approval.updated`).
    case approvalUpdated(ApprovalRequest)
    /// A frame type this build does not know.
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey { case type, jobs, presence, job, ts, approval }

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
            case "approval.updated": message = .approvalUpdated(try c.decode(ApprovalRequest.self, forKey: .approval))
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
    /// A frame of a known type this build could not decode (a newer server, a bug). It still
    /// carries its seq, so the reducer steps past it instead of resuming before it forever.
    case unreadable(UnreadableFrame)

    public var seq: Int? {
        switch self {
        case .snapshot(let snapshot): snapshot.seq
        case .resumed(let seq, _, _): seq
        case .event(let seq, _): seq
        case .unknown(_, let seq): seq
        case .unreadable(let frame): frame.seq
        case .presence, .pong: nil
        }
    }

    /// Throws only for text that is not a JSON frame at all.
    public static func decode(_ text: String) throws -> ConversationStreamMessage {
        let data = Data(text.utf8)
        let decoder = StudioJSON.decoder()
        do {
            return try decoder.decode(Wire.self, from: data).message
        } catch {
            guard let probe = try? decoder.decode(UnreadableFrame.self, from: data), probe.type != nil || probe.seq != nil else { throw error }
            return .unreadable(probe)
        }
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
                let conversation = try c.decode(Conversation.self, forKey: .conversation)
                message = .snapshot(ConversationSnapshot(
                    seq: try seq(),
                    conversation: conversation,
                    messages: Lossy<Message>.messages(try c.decode([Lossy<Message>].self, forKey: .messages), conversationId: conversation.id),
                    hasMoreMessages: try c.decodeIfPresent(Bool.self, forKey: .hasMoreMessages) ?? false,
                    activeRun: try? c.decodeIfPresent(AgentRun.self, forKey: .activeRun),
                    plans: ((try? c.decodeIfPresent([Lossy<Plan>].self, forKey: .plans)) ?? []).compactMap(\.value),
                    aliases: ((try? c.decodeIfPresent([Lossy<ConversationAlias>].self, forKey: .aliases)) ?? []).compactMap(\.value),
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

/// What can still be read of a frame that did not decode.
public struct UnreadableFrame: Sendable, Equatable, Decodable {
    public var type: String?
    public var seq: Int?
    /// `messageId` of part / delta frames, or `message.id`.
    public var messageId: EntityID?
    /// Part index of part / delta frames.
    public var index: Int?
    public var role: MessageRole?
    public var createdAt: Date?

    public init(type: String?, seq: Int?, messageId: EntityID? = nil, index: Int? = nil, role: MessageRole? = nil, createdAt: Date? = nil) {
        self.type = type
        self.seq = seq
        self.messageId = messageId
        self.index = index
        self.role = role
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case type, seq, messageId, index, message }
    private enum MessageKeys: String, CodingKey { case id, role, createdAt }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        seq = try? c.decodeIfPresent(Int.self, forKey: .seq)
        index = try? c.decodeIfPresent(Int.self, forKey: .index)
        let message = try? c.nestedContainer(keyedBy: MessageKeys.self, forKey: .message)
        messageId = (try? c.decodeIfPresent(String.self, forKey: .messageId)) ?? (try? message?.decodeIfPresent(String.self, forKey: .id)) ?? nil
        role = (try? message?.decodeIfPresent(MessageRole.self, forKey: .role)) ?? nil
        createdAt = (try? message?.decodeIfPresent(Date.self, forKey: .createdAt)) ?? nil
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

/// One element of a list that is read even when some elements do not decode.
struct Lossy<Value: Decodable>: Decodable {
    var value: Value?
    var probe: UnreadableFrame.MessageProbe?

    init(from decoder: any Decoder) throws {
        do {
            value = try Value(from: decoder)
        } catch {
            value = nil
            probe = try? UnreadableFrame.MessageProbe(from: decoder)
        }
    }

    /// A message that did not decode, kept in place as an unreadable one (dated like the one before it
    /// when its own date does not read).
    func unreadableMessage(conversationId: EntityID, after previous: Date?) -> Message {
        let date = probe?.createdAt ?? previous ?? Date(timeIntervalSince1970: 0)
        return Message(
            id: probe?.id ?? "unreadable-\(UUID().uuidString)", conversationId: probe?.conversationId ?? conversationId,
            role: probe?.role ?? .assistant, parts: [.unreadable], createdAt: date, updatedAt: date)
    }
}

extension Lossy where Value == Message {
    static func messages(_ list: [Lossy<Message>], conversationId: EntityID) -> [Message] {
        var out: [Message] = []
        for item in list {
            out.append(item.value ?? item.unreadableMessage(conversationId: conversationId, after: out.last?.createdAt))
        }
        return out
    }
}

extension UnreadableFrame {
    /// The fields of a message that are read even when the message as a whole is not.
    struct MessageProbe: Decodable {
        var id: EntityID?
        var conversationId: EntityID?
        var role: MessageRole?
        var createdAt: Date?

        private enum Keys: String, CodingKey { case id, conversationId, role, createdAt }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            id = try? c.decodeIfPresent(String.self, forKey: .id)
            conversationId = try? c.decodeIfPresent(String.self, forKey: .conversationId)
            role = try? c.decodeIfPresent(MessageRole.self, forKey: .role)
            createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        }
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
