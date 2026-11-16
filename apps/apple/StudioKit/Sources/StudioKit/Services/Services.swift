import Foundation

/// The AI chat, as the apps see it.
///
/// Two implementations:
/// - `RemoteConversationService`: the real conversations API
///   (`/api/conversations`, `/api/plans`, the conversation stream). Default.
/// - `SampleBackend`: in memory, Turkish sample data matching the approved
///   drafts. Only for previews, tests and screenshot renders.
public protocol ConversationService: Sendable {
    /// Active conversations, most recently active first.
    func conversations() async throws -> [Conversation]
    func createConversation(brandId: EntityID?, title: String?) async throws -> Conversation
    func renameConversation(_ id: EntityID, title: String) async throws -> Conversation
    func archiveConversation(_ id: EntityID) async throws -> Conversation
    /// Live state of one conversation: connection state and reduced conversation state.
    func observe(_ id: EntityID) -> AsyncStream<ConversationFeedEvent>
    /// Send a user message; the server starts an agent run (a `chat.turn` job).
    func send(_ message: OutgoingMessage, to conversationId: EntityID) async throws -> UserMessageResult
    func answer(conversationId: EntityID, messageId: EntityID, _ answer: QuestionAnswerCreate) async throws -> QuestionAnswerResult
    func cancelRun(_ runId: EntityID) async throws -> AgentRun
    /// Every attachment alias of the conversation, oldest first.
    func aliases(conversationId: EntityID) async throws -> [ConversationAlias]
    /// Rename a sent attachment's alias. 409 when the name is (or was) used in the conversation.
    func renameAlias(conversationId: EntityID, aliasId: EntityID, to name: String) async throws -> ConversationAlias
    /// Accept the plan at the revision the user saw, then queue generation for its items
    /// with the given model / effort (nil = worker default).
    func acceptAndGenerate(_ plan: Plan, model: AgentModel?, effort: AgentEffort?) async throws -> Plan
    func rejectPlan(_ planId: EntityID, reason: String?) async throws -> Plan
    /// Upload an image the user attaches to a message.
    func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset
}

/// Everything else the screens read and change: brands, accounts, posts,
/// schedules, jobs, presence, asset bytes.
public protocol StudioDataService: Sendable {
    func brands() async throws -> [Brand]
    func socialAccounts(brandId: EntityID?) async throws -> [SocialAccount]
    func contents(brandId: EntityID) async throws -> [Content]
    func content(_ id: EntityID) async throws -> Content
    func version(contentId: EntityID, version: Int) async throws -> ContentVersion
    func plans(brandId: EntityID) async throws -> [Plan]
    func schedules(brandId: EntityID) async throws -> [Schedule]
    /// Replace the caption (revokes an approval on the server).
    func updateCaption(contentId: EntityID, caption: String) async throws -> Content
    /// Approve by the hash of the version the user looked at.
    func approve(contentId: EntityID, hash: String) async throws -> Content
    func createSchedule(_ input: ScheduleCreate) async throws -> Schedule
    /// Ask the generator for a new version with `instructions` (a `content.generate` job).
    func requestEdit(of content: Content, instructions: String) async throws -> Job
    func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset
    func imageData(assetId: EntityID) async throws -> Data
    func presence() async throws -> WorkerPresence
    func jobs(brandId: EntityID?) async throws -> [Job]
    /// Live jobs + presence (all brands).
    func jobFeed() -> AsyncStream<JobFeedEvent>
    func cancelJob(_ id: EntityID) async throws -> Job
}

extension ConversationService {
    /// Accept and generate with the worker's default model and effort.
    public func acceptAndGenerate(_ plan: Plan) async throws -> Plan {
        try await acceptAndGenerate(plan, model: nil, effort: nil)
    }
}

extension OpenEnum {
    /// nil for `unknown`, so a value the server would refuse is never sent.
    var sendable: Self? { self == Self.unknown ? nil : self }
}

// MARK: - Wire format of user messages

/// The one place that knows how a user message goes on the wire
/// (`UserMessageCreate` in packages/contract/src/chat.ts).
public enum MessageWire {
    struct Attachment: Encodable, Equatable {
        var assetId: EntityID
        var alias: String?
    }

    /// `attachments` (with requested aliases) replaces `attachmentAssetIds`;
    /// the contract accepts one of the two, so only `attachments` is sent.
    struct Body: Encodable, Equatable {
        var text: String?
        var attachments: [Attachment]?
        var clientMessageId: String
        var model: AgentModel?
        var effort: AgentEffort?
    }

    static func body(for message: OutgoingMessage) -> Body {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return Body(
            text: text.isEmpty ? nil : text,
            attachments: message.attachments.isEmpty ? nil : message.attachments.map { Attachment(assetId: $0.assetId, alias: $0.alias) },
            clientMessageId: message.clientMessageId,
            model: message.model?.sendable,
            effort: message.effort?.sendable)
    }

    /// The JSON body, for tests.
    public static func encode(_ message: OutgoingMessage) throws -> Data {
        try StudioJSON.encoder().encode(body(for: message))
    }
}

// MARK: - Remote implementations

/// The real conversations API.
public struct RemoteConversationService: ConversationService {
    public let client: APIClient
    public var streamDependencies: StreamDependencies

    public init(client: APIClient, streamDependencies: StreamDependencies = StreamDependencies()) {
        self.client = client
        self.streamDependencies = streamDependencies
    }

    public func conversations() async throws -> [Conversation] {
        try await client.conversations()
    }

    public func createConversation(brandId: EntityID?, title: String?) async throws -> Conversation {
        try await client.createConversation(ConversationCreate(brandId: brandId, title: title))
    }

    public func renameConversation(_ id: EntityID, title: String) async throws -> Conversation {
        try await client.updateConversation(id, ConversationUpdate(title: title))
    }

    public func archiveConversation(_ id: EntityID) async throws -> Conversation {
        try await client.updateConversation(id, ConversationUpdate(status: .archived))
    }

    public func observe(_ id: EntityID) -> AsyncStream<ConversationFeedEvent> {
        ConversationStream(client: client, conversationId: id, deps: streamDependencies).events()
    }

    public func send(_ message: OutgoingMessage, to conversationId: EntityID) async throws -> UserMessageResult {
        try await client.sendMessage(conversationId: conversationId, MessageWire.body(for: message))
    }

    public func answer(conversationId: EntityID, messageId: EntityID, _ answer: QuestionAnswerCreate) async throws -> QuestionAnswerResult {
        try await client.answerQuestion(conversationId: conversationId, messageId: messageId, answer)
    }

    public func cancelRun(_ runId: EntityID) async throws -> AgentRun {
        try await client.cancelRun(runId)
    }

    public func aliases(conversationId: EntityID) async throws -> [ConversationAlias] {
        try await client.aliases(conversationId: conversationId)
    }

    public func renameAlias(conversationId: EntityID, aliasId: EntityID, to name: String) async throws -> ConversationAlias {
        try await client.renameAlias(conversationId: conversationId, aliasId: aliasId, to: name)
    }

    public func acceptAndGenerate(_ plan: Plan, model: AgentModel?, effort: AgentEffort?) async throws -> Plan {
        let accepted = try await client.acceptPlan(plan.id, PlanAccept(revision: plan.revision))
        return try await client.generatePlan(accepted.id, PlanGenerate(model: model, effort: effort)).plan
    }

    public func rejectPlan(_ planId: EntityID, reason: String?) async throws -> Plan {
        try await client.rejectPlan(planId, PlanReject(reason: reason))
    }

    public func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await client.uploadAsset(file, brandId: brandId, kind: .image, progress: progress)
    }
}

extension MessageWire.Body: Sendable {}
extension MessageWire.Attachment: Sendable {}

/// The real API for everything that is not chat.
public struct RemoteStudioDataService: StudioDataService {
    public let client: APIClient
    public var streamDependencies: StreamDependencies

    public init(client: APIClient, streamDependencies: StreamDependencies = StreamDependencies()) {
        self.client = client
        self.streamDependencies = streamDependencies
    }

    public func brands() async throws -> [Brand] { try await client.brands() }
    public func socialAccounts(brandId: EntityID?) async throws -> [SocialAccount] { try await client.socialAccounts(brandId: brandId) }
    public func contents(brandId: EntityID) async throws -> [Content] { try await client.contents(brandId: brandId) }
    public func content(_ id: EntityID) async throws -> Content { try await client.content(id) }

    public func version(contentId: EntityID, version: Int) async throws -> ContentVersion {
        try await client.contentVersion(contentId: contentId, version: version)
    }

    public func plans(brandId: EntityID) async throws -> [Plan] { try await client.plans(brandId: brandId) }
    public func schedules(brandId: EntityID) async throws -> [Schedule] { try await client.schedules(brandId: brandId) }

    public func updateCaption(contentId: EntityID, caption: String) async throws -> Content {
        try await client.updateContent(contentId, ContentUpdate(caption: caption))
    }

    public func approve(contentId: EntityID, hash: String) async throws -> Content {
        try await client.approveContent(contentId, hash: hash)
    }

    public func createSchedule(_ input: ScheduleCreate) async throws -> Schedule {
        try await client.createSchedule(input)
    }

    public func requestEdit(of content: Content, instructions: String) async throws -> Job {
        var payload: JSONObject = [
            "brief": .string(content.brief.isEmpty ? content.title : content.brief),
            "title": .string(content.title),
            "type": .string(content.type.rawValue),
            "instructions": .string(instructions),
        ]
        if let version = content.currentVersion?.version { payload["baseVersion"] = .number(Double(version)) }
        return try await client.createJob(JobCreate(type: .contentGenerate, payload: payload, brandId: content.brandId, contentId: content.id))
    }

    public func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await client.uploadAsset(file, brandId: brandId, kind: .image, progress: progress)
    }

    public func imageData(assetId: EntityID) async throws -> Data { try await client.assetData(assetId) }
    public func presence() async throws -> WorkerPresence { try await client.presence() }
    public func jobs(brandId: EntityID?) async throws -> [Job] { try await client.jobs(brandId: brandId) }

    public func jobFeed() -> AsyncStream<JobFeedEvent> {
        JobStream(client: client, deps: streamDependencies).events()
    }

    public func cancelJob(_ id: EntityID) async throws -> Job { try await client.cancelJob(id) }
}
