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
    func decideConsent(conversationId: EntityID, messageId: EntityID, _ decision: ConsentDecisionCreate) async throws -> ConsentDecisionResult
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
    // Brands & profiles
    func brands() async throws -> [Brand]
    func createBrand(_ input: BrandCreate) async throws -> Brand
    func updateBrand(_ id: EntityID, _ input: BrandUpdate) async throws -> Brand
    func brandProfiles(brandId: EntityID) async throws -> [BrandProfile]
    func currentBrandProfile(brandId: EntityID) async throws -> BrandProfile?
    func createBrandProfile(brandId: EntityID, _ input: BrandProfileCreate) async throws -> BrandProfile
    func updateBrandProfile(brandId: EntityID, version: Int, _ input: BrandProfileUpdate) async throws -> BrandProfile
    func approveBrandProfile(brandId: EntityID, version: Int) async throws -> BrandProfile
    func analyzeBrand(brandId: EntityID, notes: String?) async throws -> Job
    /// `brand.analyze` with an explicit model (nil = worker default).
    func analyzeBrand(brandId: EntityID, notes: String?, model: AgentModel?) async throws -> Job
    /// Archived brands (the sidebar lists only active ones).
    func archivedBrands() async throws -> [Brand]
    /// The brand kit; an empty kit until it was saved once.
    func brandKit(brandId: EntityID) async throws -> BrandKit
    /// Replace the brand kit.
    func saveBrandKit(brandId: EntityID, _ input: BrandKitPut) async throws -> BrandKit

    // Social accounts & OAuth / Token vault
    func socialAccounts(brandId: EntityID?) async throws -> [SocialAccount]
    func createSocialAccount(_ input: SocialAccountCreate) async throws -> SocialAccount
    func updateSocialAccount(_ id: EntityID, _ input: SocialAccountUpdate) async throws -> SocialAccount
    func putSocialAccountToken(id: EntityID, _ input: SocialAccountTokenPut) async throws -> SocialAccount
    func checkSocialAccountToken(id: EntityID) async throws -> SocialAccount
    func discoverMetaAccounts(_ input: MetaDiscoverInput) async throws -> MetaDiscoverResult
    func connectLinkedInAccount(_ input: LinkedInConnectInput) async throws -> SocialAccount

    // Contents, versions, rendering & export
    func contents(brandId: EntityID) async throws -> [Content]
    func content(_ id: EntityID) async throws -> Content
    func version(contentId: EntityID, version: Int) async throws -> ContentVersion
    func versions(contentId: EntityID) async throws -> [ContentVersionSummary]
    func plans(brandId: EntityID) async throws -> [Plan]
    func schedules(brandId: EntityID) async throws -> [Schedule]
    func cancelSchedule(_ id: EntityID) async throws -> Schedule
    func scheduleLogs(scheduleId: EntityID) async throws -> [PublishLog]
    /// Replace the caption (revokes an approval on the server).
    func updateCaption(contentId: EntityID, caption: String) async throws -> Content
    /// Approve by the hash of the version the user looked at.
    func approve(contentId: EntityID, hash: String) async throws -> Content
    func createSchedule(_ input: ScheduleCreate) async throws -> Schedule
    /// Ask the generator for a new version with `instructions` (a `content.generate` job).
    func requestEdit(of content: Content, instructions: String) async throws -> Job
    func fillSlotAndRender(contentId: EntityID, slotId: String, assetId: EntityID) async throws -> Job
    func patchLayersAndRender(contentId: EntityID, patches: [SlideLayerPatch]) async throws -> Job
    func exportContent(contentId: EntityID, format: String) async throws -> Job

    // Post editor
    /// `DELETE /api/contents/{id}` (refused while scheduled, publishing or published).
    func deleteContent(_ id: EntityID) async throws
    /// A new draft copy with the current version.
    func duplicateContent(_ id: EntityID) async throws -> Content
    /// A new version that copies `version` exactly ("Bu sürümü geri yükle").
    func restoreVersion(contentId: EntityID, version: Int) async throws -> ContentVersion
    /// Queue `content.render` (edits as design-kit patches, PNG/PDF exports, layer measuring).
    func render(contentId: EntityID, _ request: ContentRenderRequest) async throws -> Job
    /// "Neyi değiştireyim?": revise `baseVersion` with the user's words (`content.generate`).
    func requestRevision(of content: Content, baseVersion: Int, instructions: String) async throws -> Job

    // Assets & AI image generation
    func assets(brandId: EntityID?, kind: AssetKind?) async throws -> [Asset]
    func uploadAsset(_ file: UploadFile, brandId: EntityID, kind: AssetKind?, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset
    func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset
    func generateAIImage(
        brandId: EntityID, prompt: String, aspectRatio: String, imageSize: String,
        referenceAssetIds: [EntityID], preserveProductLabel: Bool,
        targetContentId: EntityID?, targetSlotId: String?
    ) async throws -> Job
    func imageData(assetId: EntityID) async throws -> Data

    // Presence, AI providers & jobs
    func presence() async throws -> WorkerPresence
    func claudeControl() async throws -> ClaudeControl
    func claudeLogin() async throws -> ClaudeControl
    func claudeRefresh() async throws -> ClaudeControl
    func geminiControl() async throws -> GeminiControl
    func geminiRefresh() async throws -> GeminiControl
    func jobs(brandId: EntityID?) async throws -> [Job]
    /// One job by id (progress and output of a job the screen started).
    func job(_ id: EntityID) async throws -> Job
    /// Live jobs + presence (all brands).
    func jobFeed() -> AsyncStream<JobFeedEvent>
    func cancelJob(_ id: EntityID) async throws -> Job
}

/// Brand kit, archived brands and single-job reads (P2). Default implementations keep
/// other conformers compiling; the real API and the sample backend implement them.
extension StudioDataService {
    public func archivedBrands() async throws -> [Brand] { [] }
    public func brandKit(brandId: EntityID) async throws -> BrandKit { .empty(brandId) }
    public func saveBrandKit(brandId: EntityID, _ input: BrandKitPut) async throws -> BrandKit {
        throw StudioAPIError.invalidConfiguration("Marka kiti bu bağlantıda kaydedilemiyor.")
    }
    public func job(_ id: EntityID) async throws -> Job {
        guard let found = try await jobs(brandId: nil).first(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "job \(id) not found", issues: [])
        }
        return found
    }
    public func analyzeBrand(brandId: EntityID, notes: String?, model: AgentModel?) async throws -> Job {
        try await analyzeBrand(brandId: brandId, notes: notes)
    }
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

    public func decideConsent(conversationId: EntityID, messageId: EntityID, _ decision: ConsentDecisionCreate) async throws -> ConsentDecisionResult {
        try await client.decideConsent(conversationId: conversationId, messageId: messageId, decision)
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
    public func createBrand(_ input: BrandCreate) async throws -> Brand { try await client.createBrand(input) }
    public func updateBrand(_ id: EntityID, _ input: BrandUpdate) async throws -> Brand { try await client.updateBrand(id, input) }
    public func brandProfiles(brandId: EntityID) async throws -> [BrandProfile] { try await client.brandProfiles(brandId: brandId) }
    public func currentBrandProfile(brandId: EntityID) async throws -> BrandProfile? { try await client.currentBrandProfile(brandId: brandId) }
    public func createBrandProfile(brandId: EntityID, _ input: BrandProfileCreate) async throws -> BrandProfile { try await client.createBrandProfile(brandId: brandId, input) }
    public func updateBrandProfile(brandId: EntityID, version: Int, _ input: BrandProfileUpdate) async throws -> BrandProfile { try await client.updateBrandProfile(brandId: brandId, version: version, input) }
    public func approveBrandProfile(brandId: EntityID, version: Int) async throws -> BrandProfile { try await client.approveBrandProfile(brandId: brandId, version: version) }
    public func analyzeBrand(brandId: EntityID, notes: String?) async throws -> Job { try await client.analyzeBrand(brandId: brandId, notes: notes) }
    public func analyzeBrand(brandId: EntityID, notes: String?, model: AgentModel?) async throws -> Job {
        try await client.analyzeBrand(brandId: brandId, notes: notes, model: model)
    }
    public func archivedBrands() async throws -> [Brand] { try await client.brands(status: .archived) }
    public func brandKit(brandId: EntityID) async throws -> BrandKit { try await client.brandKit(brandId: brandId) }
    public func saveBrandKit(brandId: EntityID, _ input: BrandKitPut) async throws -> BrandKit {
        try await client.saveBrandKit(brandId: brandId, input)
    }

    public func socialAccounts(brandId: EntityID?) async throws -> [SocialAccount] { try await client.socialAccounts(brandId: brandId) }
    public func createSocialAccount(_ input: SocialAccountCreate) async throws -> SocialAccount { try await client.createSocialAccount(input) }
    public func updateSocialAccount(_ id: EntityID, _ input: SocialAccountUpdate) async throws -> SocialAccount { try await client.updateSocialAccount(id, input) }
    public func putSocialAccountToken(id: EntityID, _ input: SocialAccountTokenPut) async throws -> SocialAccount { try await client.putSocialAccountToken(id: id, input) }
    public func checkSocialAccountToken(id: EntityID) async throws -> SocialAccount { try await client.checkSocialAccountToken(id: id) }
    public func discoverMetaAccounts(_ input: MetaDiscoverInput) async throws -> MetaDiscoverResult { try await client.discoverMetaAccounts(input) }
    public func connectLinkedInAccount(_ input: LinkedInConnectInput) async throws -> SocialAccount { try await client.connectLinkedInAccount(input) }

    public func contents(brandId: EntityID) async throws -> [Content] { try await client.contents(brandId: brandId) }
    public func content(_ id: EntityID) async throws -> Content { try await client.content(id) }

    public func version(contentId: EntityID, version: Int) async throws -> ContentVersion {
        try await client.contentVersion(contentId: contentId, version: version)
    }

    public func versions(contentId: EntityID) async throws -> [ContentVersionSummary] {
        try await client.versions(contentId: contentId)
    }

    public func plans(brandId: EntityID) async throws -> [Plan] { try await client.plans(brandId: brandId) }
    public func schedules(brandId: EntityID) async throws -> [Schedule] { try await client.schedules(brandId: brandId) }
    public func cancelSchedule(_ id: EntityID) async throws -> Schedule { try await client.cancelSchedule(id) }
    public func scheduleLogs(scheduleId: EntityID) async throws -> [PublishLog] { try await client.scheduleLogs(scheduleId: scheduleId) }

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

    public func fillSlotAndRender(contentId: EntityID, slotId: String, assetId: EntityID) async throws -> Job {
        try await client.fillSlotAndRender(contentId: contentId, slotId: slotId, assetId: assetId)
    }

    public func patchLayersAndRender(contentId: EntityID, patches: [SlideLayerPatch]) async throws -> Job {
        try await client.patchLayersAndRender(contentId: contentId, patches: patches)
    }

    public func exportContent(contentId: EntityID, format: String) async throws -> Job {
        try await client.exportContent(contentId: contentId, format: format)
    }

    public func deleteContent(_ id: EntityID) async throws { try await client.deleteContent(id) }
    public func duplicateContent(_ id: EntityID) async throws -> Content { try await client.duplicateContent(id) }

    public func restoreVersion(contentId: EntityID, version: Int) async throws -> ContentVersion {
        try await client.restoreContentVersion(contentId: contentId, version: version)
    }

    public func render(contentId: EntityID, _ request: ContentRenderRequest) async throws -> Job {
        try await client.renderContent(contentId: contentId, request)
    }

    public func requestRevision(of content: Content, baseVersion: Int, instructions: String) async throws -> Job {
        try await client.requestRevision(of: content, baseVersion: baseVersion, instructions: instructions)
    }

    public func assets(brandId: EntityID?, kind: AssetKind?) async throws -> [Asset] {
        try await client.assets(brandId: brandId, kind: kind)
    }

    public func uploadAsset(_ file: UploadFile, brandId: EntityID, kind: AssetKind?, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await client.uploadAsset(file, brandId: brandId, kind: kind, progress: progress)
    }

    public func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await client.uploadAsset(file, brandId: brandId, kind: .image, progress: progress)
    }

    public func generateAIImage(
        brandId: EntityID, prompt: String, aspectRatio: String, imageSize: String,
        referenceAssetIds: [EntityID], preserveProductLabel: Bool,
        targetContentId: EntityID?, targetSlotId: String?
    ) async throws -> Job {
        try await client.generateAIImage(
            brandId: brandId, prompt: prompt, aspectRatio: aspectRatio, imageSize: imageSize,
            referenceAssetIds: referenceAssetIds, preserveProductLabel: preserveProductLabel,
            targetContentId: targetContentId, targetSlotId: targetSlotId
        )
    }

    public func imageData(assetId: EntityID) async throws -> Data { try await client.assetData(assetId) }
    public func presence() async throws -> WorkerPresence { try await client.presence() }
    public func claudeControl() async throws -> ClaudeControl { try await client.claudeControl() }
    public func claudeLogin() async throws -> ClaudeControl { try await client.claudeLogin() }
    public func claudeRefresh() async throws -> ClaudeControl { try await client.claudeRefresh() }
    public func geminiControl() async throws -> GeminiControl { try await client.geminiControl() }
    public func geminiRefresh() async throws -> GeminiControl { try await client.geminiRefresh() }
    public func jobs(brandId: EntityID?) async throws -> [Job] { try await client.jobs(brandId: brandId) }
    public func job(_ id: EntityID) async throws -> Job { try await client.job(id) }

    public func jobFeed() -> AsyncStream<JobFeedEvent> {
        JobStream(client: client, deps: streamDependencies).events()
    }

    public func cancelJob(_ id: EntityID) async throws -> Job { try await client.cancelJob(id) }
}
