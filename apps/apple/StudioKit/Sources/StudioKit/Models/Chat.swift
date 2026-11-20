import Foundation

// chat.ts: conversations, messages with typed parts, agent runs.

public enum ConversationStatus: String, OpenEnum {
    case active, archived
    case unknown
}

public struct Conversation: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    /// A chat can start without a brand; it is set once later.
    public var brandId: EntityID?
    /// "" until set; the first user message fills it when empty.
    public var title: String
    public var status: ConversationStatus
    /// The queued or running agent run, if any.
    public var activeRunId: EntityID?
    /// Sequence number of the last stream event (0 = none yet).
    public var lastSeq: Int
    /// Claude Code session of the last completed agent turn.
    public var agentSession: AgentSession?
    public var lastActivityAt: Date
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, brandId: EntityID?, title: String, status: ConversationStatus = .active,
        activeRunId: EntityID? = nil, lastSeq: Int = 0, agentSession: AgentSession? = nil,
        lastActivityAt: Date, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.brandId = brandId
        self.title = title
        self.status = status
        self.activeRunId = activeRunId
        self.lastSeq = lastSeq
        self.agentSession = agentSession
        self.lastActivityAt = lastActivityAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Title for lists; untitled conversations get a neutral label.
    public var displayTitle: String { title.isEmpty ? "Yeni sohbet" : title }
}

public struct ConversationCreate: Encodable, Sendable, Equatable {
    public var brandId: EntityID?
    public var title: String?

    public init(brandId: EntityID? = nil, title: String? = nil) {
        self.brandId = brandId
        self.title = title
    }
}

public struct ConversationUpdate: Encodable, Sendable, Equatable {
    public var title: String?
    public var status: ConversationStatus?
    public var brandId: EntityID?

    public init(title: String? = nil, status: ConversationStatus? = nil, brandId: EntityID? = nil) {
        self.title = title
        self.status = status
        self.brandId = brandId
    }
}

public enum MessageRole: String, OpenEnum {
    case user, assistant, system
    case unknown
}

/// `streaming` while the agent is still writing; then `complete` / `failed` / `cancelled`.
public enum MessageStatus: String, OpenEnum {
    case streaming, complete, failed, cancelled
    case unknown
}

public enum QuestionMode: String, OpenEnum {
    case single, multiple, text
    case unknown
}

public struct QuestionOption: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?

    public init(id: String, label: String, description: String? = nil) {
        self.id = id
        self.label = label
        self.description = description
    }
}

public struct QuestionAnswer: Codable, Sendable, Hashable {
    public var optionIds: [String]
    public var text: String?
    public var answeredAt: Date

    public init(optionIds: [String], text: String? = nil, answeredAt: Date) {
        self.optionIds = optionIds
        self.text = text
        self.answeredAt = answeredAt
    }
}

public enum ProgressState: String, OpenEnum {
    case pending, running, done, failed, skipped
    case unknown
}

public struct AttachmentPart: Codable, Sendable, Hashable {
    public var assetId: EntityID
    public var kind: AssetKind
    public var mimeType: String
    public var width: Int?
    public var height: Int?
    public var filename: String?
    /// Conversation-wide name (`image`, `image-1`, ...) the text can mention as `@alias`.
    /// Optional on the wire: older servers do not send it.
    public var alias: String?
    /// Stable alias id: look it up in the conversation's aliases for the current name.
    public var aliasId: EntityID?

    public init(assetId: EntityID, kind: AssetKind = .image, mimeType: String, width: Int? = nil, height: Int? = nil, filename: String? = nil, alias: String? = nil, aliasId: EntityID? = nil) {
        self.assetId = assetId
        self.kind = kind
        self.mimeType = mimeType
        self.width = width
        self.height = height
        self.filename = filename
        self.alias = alias
        self.aliasId = aliasId
    }
}

public struct ContentRefPart: Codable, Sendable, Hashable {
    public var contentId: EntityID
    public var version: Int?
    public var note: String?

    public init(contentId: EntityID, version: Int? = nil, note: String? = nil) {
        self.contentId = contentId
        self.version = version
        self.note = note
    }
}

public struct QuestionPart: Codable, Sendable, Hashable {
    /// Unique inside the message; the answer endpoint addresses the question by it.
    public var questionId: String
    public var prompt: String
    public var mode: QuestionMode
    public var options: [QuestionOption]
    /// Choice questions may also accept a free-text answer.
    public var allowText: Bool
    /// Nil until the user answers; an answer is final.
    public var answer: QuestionAnswer?

    public init(questionId: String, prompt: String, mode: QuestionMode, options: [QuestionOption], allowText: Bool = false, answer: QuestionAnswer? = nil) {
        self.questionId = questionId
        self.prompt = prompt
        self.mode = mode
        self.options = options
        self.allowText = allowText
        self.answer = answer
    }

    /// `checkQuestionAnswer` in chat.ts: nil when the answer is acceptable, else the reason.
    public func check(optionIds: [String], text: String?) -> String? {
        let text = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if Set(optionIds).count != optionIds.count { return "option ids must be unique" }
        let known = Set(options.map(\.id))
        if let unknown = optionIds.first(where: { !known.contains($0) }) { return "unknown option \(unknown)" }
        if mode == .text {
            if !optionIds.isEmpty { return "this question takes a text answer, not options" }
            return text.isEmpty ? "a text answer is required" : nil
        }
        if !text.isEmpty && !allowText { return "this question does not accept free text" }
        if mode == .single && optionIds.count > 1 { return "pick exactly one option" }
        if optionIds.isEmpty && text.isEmpty { return "pick an option" }
        return nil
    }
}

public struct ProgressPart: Codable, Sendable, Hashable {
    public var stepId: String
    public var label: String
    public var state: ProgressState
    public var detail: String?
    public var current: Int?
    public var total: Int?

    public init(stepId: String, label: String, state: ProgressState, detail: String? = nil, current: Int? = nil, total: Int? = nil) {
        self.stepId = stepId
        self.label = label
        self.state = state
        self.detail = detail
        self.current = current
        self.total = total
    }
}

public struct ErrorPart: Codable, Sendable, Hashable {
    public var message: String
    public var code: String?
    public var retryable: Bool

    public init(message: String, code: String? = nil, retryable: Bool = false) {
        self.message = message
        self.code = code
        self.retryable = retryable
    }
}

/// One typed part of a message (`MessagePart` discriminated union).
public enum MessagePart: Sendable, Hashable, Codable {
    case text(String)
    case attachment(AttachmentPart)
    case planProposal(planId: EntityID)
    case contentRef(ContentRefPart)
    case question(QuestionPart)
    case progress(ProgressPart)
    case error(ErrorPart)
    case toolStep(ToolStepPart)
    case consent(ConsentPart)
    /// A generated picture waiting for the owner's word (`GET /api/approvals/{approvalId}`).
    case approvalRequest(approvalId: EntityID)
    /// A part type this build does not know yet; kept so indexes stay aligned.
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey { case type, text, planId, approvalId }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "text": self = .text(try container.decode(String.self, forKey: .text))
        case "attachment": self = .attachment(try AttachmentPart(from: decoder))
        case "plan_proposal": self = .planProposal(planId: try container.decode(String.self, forKey: .planId))
        case "content_ref": self = .contentRef(try ContentRefPart(from: decoder))
        case "question": self = .question(try QuestionPart(from: decoder))
        case "progress": self = .progress(try ProgressPart(from: decoder))
        case "error": self = .error(try ErrorPart(from: decoder))
        case "tool_step": self = .toolStep(try ToolStepPart(from: decoder))
        case "consent": self = .consent(try ConsentPart(from: decoder))
        case "approval_request": self = .approvalRequest(approvalId: try container.decode(String.self, forKey: .approvalId))
        default: self = .unknown(type: type)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(typeName, forKey: .type)
        switch self {
        case .text(let text): try container.encode(text, forKey: .text)
        case .attachment(let part): try part.encode(to: encoder)
        case .planProposal(let planId): try container.encode(planId, forKey: .planId)
        case .contentRef(let part): try part.encode(to: encoder)
        case .question(let part): try part.encode(to: encoder)
        case .progress(let part): try part.encode(to: encoder)
        case .error(let part): try part.encode(to: encoder)
        case .toolStep(let part): try part.encode(to: encoder)
        case .consent(let part): try part.encode(to: encoder)
        case .approvalRequest(let approvalId): try container.encode(approvalId, forKey: .approvalId)
        case .unknown: break
        }
    }

    public var typeName: String {
        switch self {
        case .text: "text"
        case .attachment: "attachment"
        case .planProposal: "plan_proposal"
        case .contentRef: "content_ref"
        case .question: "question"
        case .progress: "progress"
        case .error: "error"
        case .toolStep: "tool_step"
        case .consent: "consent"
        case .approvalRequest: "approval_request"
        case .unknown(let type): type
        }
    }
}

public struct Message: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var conversationId: EntityID
    public var role: MessageRole
    public var status: MessageStatus
    /// Agent run that produced the message (assistant messages).
    public var runId: EntityID?
    public var parts: [MessagePart]
    /// `@alias` references the server resolved in a user message's text part (text order).
    public var mentions: [MessageMention]?
    /// `@product` / `@post` references the server resolved in a user message (text order).
    public var entityMentions: [MessageEntityMention]?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, conversationId: EntityID, role: MessageRole, status: MessageStatus = .complete,
        runId: EntityID? = nil, parts: [MessagePart], mentions: [MessageMention]? = nil,
        entityMentions: [MessageEntityMention]? = nil, createdAt: Date, updatedAt: Date
    ) {
        self.entityMentions = entityMentions
        self.id = id
        self.conversationId = conversationId
        self.role = role
        self.status = status
        self.runId = runId
        self.parts = parts
        self.mentions = mentions
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// The approval requests this message shows, in order.
    public var approvalIds: [EntityID] {
        parts.compactMap { if case .approvalRequest(let id) = $0 { id } else { nil } }
    }

    /// All text parts joined (for search and previews).
    public var plainText: String {
        parts.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n")
    }

    private enum CodingKeys: String, CodingKey { case id, conversationId, role, status, runId, parts, mentions, entityMentions, createdAt, updatedAt }

    /// A part that does not decode (a newer server, a bug) becomes `MessagePart.unreadable`
    /// in place, so the message, its part indexes and the rest of the conversation still read.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(EntityID.self, forKey: .id)
        conversationId = try c.decode(EntityID.self, forKey: .conversationId)
        role = try c.decode(MessageRole.self, forKey: .role)
        status = try c.decodeIfPresent(MessageStatus.self, forKey: .status) ?? .complete
        runId = try c.decodeIfPresent(EntityID.self, forKey: .runId)
        parts = try c.decode([LossyPart].self, forKey: .parts).map(\.part)
        mentions = try? c.decodeIfPresent([MessageMention].self, forKey: .mentions)
        entityMentions = try? c.decodeIfPresent([MessageEntityMention].self, forKey: .entityMentions)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
    }

    private struct LossyPart: Decodable {
        var part: MessagePart
        init(from decoder: any Decoder) throws {
            part = (try? MessagePart(from: decoder)) ?? .unreadable
        }
    }
}

extension MessagePart {
    /// `unknown` type of a part (or a whole message) this build could not read.
    public static let unreadableType = "studio.unreadable"
    /// Shown as "Bu mesaj bu sürümde gösterilemiyor".
    public static var unreadable: MessagePart { .unknown(type: unreadableType) }
    public var isUnreadable: Bool { self == .unreadable }
    /// What the apps show for an unreadable part or message.
    public static let unreadableText = "Bu mesaj bu sürümde gösterilemiyor."
}

public enum AgentRunStatus: String, OpenEnum {
    case queued, running, completed, failed, cancelled
    case unknown

    public var isActive: Bool { self == .queued || self == .running }
}

public struct AgentRun: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var conversationId: EntityID
    public var triggerMessageId: EntityID
    /// The `chat.turn` job that executes the run.
    public var jobId: EntityID?
    public var status: AgentRunStatus
    public var attempt: Int
    /// The requested model (`opus` / `sonnet` / `haiku`) until the worker
    /// finishes; then possibly the model id it actually used.
    public var model: String?
    /// The requested reasoning effort; nil = worker default.
    public var effort: AgentEffort?
    public var usage: JSONObject?
    public var error: String?
    public var createdAt: Date
    public var updatedAt: Date
    public var startedAt: Date?
    public var finishedAt: Date?

    /// `model` as a picker value, when it is one (nil for a worker-reported model id).
    public var requestedModel: AgentModel? {
        model.flatMap { AgentModel(rawValue: $0) }.flatMap { $0 == .unknown ? nil : $0 }
    }

    public init(
        id: EntityID, conversationId: EntityID, triggerMessageId: EntityID, jobId: EntityID? = nil,
        status: AgentRunStatus, attempt: Int = 0, model: String? = nil, effort: AgentEffort? = nil, error: String? = nil,
        createdAt: Date, updatedAt: Date, startedAt: Date? = nil, finishedAt: Date? = nil
    ) {
        self.effort = effort
        self.id = id
        self.conversationId = conversationId
        self.triggerMessageId = triggerMessageId
        self.jobId = jobId
        self.status = status
        self.attempt = attempt
        self.model = model
        self.error = error
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }
}

/// `POST /api/conversations/{id}/messages`.
public struct UserMessageCreate: Encodable, Sendable, Equatable {
    public var text: String?
    public var attachmentAssetIds: [EntityID]
    /// Idempotency key: resending the same key returns the original message and run.
    public var clientMessageId: String?

    public init(text: String?, attachmentAssetIds: [EntityID] = [], clientMessageId: String? = UUID().uuidString) {
        self.text = text
        self.attachmentAssetIds = attachmentAssetIds
        self.clientMessageId = clientMessageId
    }
}

public struct UserMessageResult: Decodable, Sendable, Equatable {
    public var message: Message
    public var run: AgentRun
    public var replayed: Bool
}

/// `POST /api/conversations/{id}/messages/{messageId}/answer`.
public struct QuestionAnswerCreate: Encodable, Sendable, Equatable {
    public var questionId: String
    public var optionIds: [String]
    public var text: String?

    public init(questionId: String, optionIds: [String], text: String? = nil) {
        self.questionId = questionId
        self.optionIds = optionIds
        self.text = text
    }
}

public struct QuestionAnswerResult: Decodable, Sendable, Equatable {
    public var message: Message
    public var run: AgentRun?
}
