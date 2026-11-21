import Foundation

/// What the post screen needs of the chat (S1): a request about a version saved from the Mac's
/// canvas goes to the post's conversation, as on the Mac. Every `ConversationService` is one.
public protocol PostChatSender: Sendable {
    func createConversation(brandId: EntityID?, title: String?) async throws -> Conversation
    func send(_ message: OutgoingMessage, to conversationId: EntityID) async throws -> UserMessageResult
    func cancelRun(_ runId: EntityID) async throws -> AgentRun
}

/// The AI chat, as the apps see it.
///
/// Two implementations:
/// - `RemoteConversationService`: the real conversations API
///   (`/api/conversations`, `/api/plans`, the conversation stream). Default.
/// - `SampleBackend`: in memory, Turkish sample data matching the approved
///   drafts. Only for previews, tests and screenshot renders.
public protocol ConversationService: PostChatSender {
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
    /// "Yalnızca onayla (üretme)": accept at the revision the user saw; draft posts are made,
    /// nothing is generated.
    func acceptPlan(_ plan: Plan) async throws -> Plan
    func rejectPlan(_ planId: EntityID, reason: String?) async throws -> Plan
    /// Queue generation for an already accepted plan (items without a running job).
    func generatePlan(_ planId: EntityID, model: AgentModel?, effort: AgentEffort?) async throws -> Plan
    /// `acceptAndGenerate` with the server's answer: the jobs and the items it left alone (`skipped`).
    func acceptAndGenerateResult(_ plan: Plan, model: AgentModel?, effort: AgentEffort?) async throws -> PlanGenerateResult
    /// `generatePlan` with the jobs and the skipped items.
    func generatePlanResult(_ planId: EntityID, model: AgentModel?, effort: AgentEffort?) async throws -> PlanGenerateResult
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
    /// Approve by the hash of the version the user looked at. `acknowledgeChecks`: the user
    /// confirmed approving although the checks hold it back (E7; never without that answer).
    func approve(contentId: EntityID, hash: String, acknowledgeChecks: Bool) async throws -> Content
    /// Take an approval back (approved → draft; `POST /api/contents/{id}/transition`). A
    /// scheduled post is not revoked this way: its schedule is cancelled first.
    func revokeApproval(contentId: EntityID) async throws -> Content
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
    func requestRevision(of content: Content, baseVersion: Int?, instructions: String) async throws -> Job

    // Production checks
    /// The latest check run of `version` (nil: never checked).
    func latestCheckRun(contentId: EntityID, version: Int) async throws -> ContentCheckRun?
    /// Queue a `content.check` job over `version`.
    func runChecks(contentId: EntityID, brandId: EntityID, version: Int) async throws -> Job

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
    /// A resized copy `width` px wide (the original bytes when it cannot be resized).
    func thumbnailData(assetId: EntityID, width: Int) async throws -> Data
    /// Take a post back out of the trash.
    func restoreContent(_ id: EntityID) async throws -> Content

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
    /// Queue a failed or cancelled job again ("Yeniden dene"); returns the new job.
    func retryJob(_ id: EntityID) async throws -> Job

    // Paid AI (S7)
    func aiSpend() async throws -> AISpendSummary
    func aiPreferences() async throws -> AIPreferences
    /// Answer the Claude limit ("Gemini ile devam et" / "Sınırı bekle").
    func decideClaudeLimit(_ choice: ClaudeLimitChoice) async throws -> AIPreferences

    // Publishing, accounts and calendar (P3). Defaults below keep other conformers compiling.
    func publishingStatus() async throws -> PublishingStatus
    func setCloudPublisher(url: String, token: String) async throws -> PublishingStatus
    func clearCloudPublisher() async throws -> PublishingStatus
    /// Ask the worker to push and pull cloud orders now (app focus).
    func requestPublishingSync() async throws -> PublishingStatus
    /// Platform rules for `contentId` on the accounts (nil = all usable accounts of its brand),
    /// for a publish at `scheduledAt` (nil = now; per-day limits count around it).
    func preflight(contentId: EntityID, accountIds: [EntityID]?, scheduledAt: Date?) async throws -> SchedulePreflight
    func publishNow(contentId: EntityID, accountIds: [EntityID]) async throws -> PublishNowResult
    /// Move a pending schedule (calendar drag).
    func reschedule(_ scheduleId: EntityID, to date: Date) async throws -> Schedule
    /// Publish attempts; with `finishedAfter` only finished ones after it, oldest first.
    func publishLogs(brandId: EntityID?, finishedAfter: Date?) async throws -> [PublishLogFeedItem]
    func exchangeMeta(_ input: MetaExchangeInput) async throws -> MetaExchangeResult
    func linkedInOAuth(_ input: LinkedInOAuthInput) async throws -> SocialAccount
    func checkSocialAccount(id: EntityID, _ input: SocialAccountCheckInput) async throws -> SocialAccount
    func disconnectSocialAccount(id: EntityID) async throws -> SocialAccount

    // Products, one asset, Reels from footage (N21, N23). Defaults below.
    func products(brandId: EntityID) async throws -> [BrandProduct]
    func createProduct(brandId: EntityID, _ input: BrandProductCreate) async throws -> BrandProduct
    func updateProduct(brandId: EntityID, id: EntityID, _ input: BrandProductUpdate) async throws -> BrandProduct
    func deleteProduct(brandId: EntityID, id: EntityID) async throws
    /// One asset (with what the Mac read on it, once analysed).
    func asset(_ id: EntityID) async throws -> Asset
    /// "Bu çekimden Reels yap": a new Reels content and its `content.generate` job.
    func createReel(_ request: ReelFromFootage) async throws -> (Content, Job)

    // The rest of the brand page (skills, templates, checks, special days). Defaults below.
    func brandSkills(brandId: EntityID) async throws -> [BrandSkill]
    func createBrandSkill(brandId: EntityID, _ input: BrandSkillCreate) async throws -> BrandSkill
    func updateBrandSkill(brandId: EntityID, id: EntityID, _ input: BrandSkillUpdate) async throws -> BrandSkill
    func deleteBrandSkill(brandId: EntityID, id: EntityID) async throws
    func brandSkillVersions(brandId: EntityID, skillId: EntityID) async throws -> [BrandSkillVersion]
    func restoreBrandSkillVersion(brandId: EntityID, skillId: EntityID, version: Int) async throws -> BrandSkill
    /// "AI ile çıkar": a `brand.skill_draft` job.
    func draftBrandSkill(brandId: EntityID, focus: String) async throws -> Job
    func templates(brandId: EntityID) async throws -> [ContentTemplate]
    func updateTemplate(_ id: EntityID, _ input: ContentTemplateUpdate) async throws -> ContentTemplate
    func deleteTemplate(_ id: EntityID) async throws
    func useTemplate(_ id: EntityID, _ input: TemplateUse) async throws -> TemplateUseResult
    func checkSettings(brandId: EntityID) async throws -> BrandCheckSettings
    func saveCheckSettings(brandId: EntityID, _ input: BrandCheckSettingsPut) async throws -> BrandCheckSettings
    func planningSettings(brandId: EntityID) async throws -> BrandPlanningSettings
    func savePlanningSettings(brandId: EntityID, _ input: BrandPlanningSettingsPut) async throws -> BrandPlanningSettings
    /// Special days between two `YYYY-MM-DD` dates (no brand filter).
    func specialDays(from: String, to: String) async throws -> [SpecialDay]
    func specialDayOverrides() async throws -> SpecialDayOverrides
    func saveSpecialDayOverrides(_ overrides: [ReligiousDayOverride]) async throws -> SpecialDayOverrides

    // Approval requests and `@` names (docs/URETIM-RESIM.md, Faz 0). Defaults in ApprovalServices.swift.
    /// Newest first; `brandId` / `contentId` / `conversationId` nil = any.
    func approvals(brandId: EntityID?, contentId: EntityID?, conversationId: EntityID?, status: ApprovalStatusFilter) async throws -> [ApprovalRequest]
    func approval(_ id: EntityID) async throws -> ApprovalRequest
    func approveApproval(_ id: EntityID, assetId: EntityID?) async throws -> ApprovalActionResult
    func rejectApproval(_ id: EntityID, note: String?) async throws -> ApprovalActionResult
    /// The owner's consent to generate again (paid).
    func regenerateApproval(_ id: EntityID, _ input: ApprovalRegenerate) async throws -> ApprovalActionResult
    /// Products, then the newest posts, each with its `@` name.
    func mentionCandidates(brandId: EntityID) async throws -> [EntityMentionCandidate]

    // Ayarlar parity with the Mac app. Defaults in SettingsServices.swift.
    /// The Mac app's own settings (local network, remote access, keys, …) as it last sent them.
    func hostSettings() async throws -> HostSettingsView
    /// Queue a change for the Mac app; it applies it within seconds.
    func changeHostSettings(_ input: HostSettingsChangeCreate) async throws -> HostSettingsChange
    func aiKeys() async throws -> AIKeyList
    func setAIKey(_ provider: AIKeyProvider, key: String) async throws -> AIKeyState
    func checkAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState
    func deleteAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState
    func setAIPreferences(_ input: AIPreferencesPut) async throws -> AIPreferences
    func setPublishingSettings(_ input: PublishingSettingsPatch) async throws -> PublishingStatus
    /// Paired devices with the asking phone's own id.
    func pairedDevices() async throws -> DeviceList
    func revokeDevice(_ id: EntityID) async throws -> PairedDevice
    /// `GET /api/health` (the server's parts).
    func serverHealth() async throws -> HealthResponse
    /// Ayarlar → Araçlar: the programs Studio uses on the Mac.
    func tools() async throws -> ToolsControl
    func refreshTools() async throws -> ToolsControl
    /// Queue `tool.install` (`update`: replace Studio's own copy).
    func installTool(_ id: String, update: Bool) async throws -> Job
    func uninstallTool(_ id: String) async throws -> Job
}

/// Brand page defaults (skills, templates, checks, special days): other conformers keep
/// compiling; reads come back empty and writes say they cannot be done here.
extension StudioDataService {
    public func brandSkills(brandId: EntityID) async throws -> [BrandSkill] { [] }
    public func createBrandSkill(brandId: EntityID, _ input: BrandSkillCreate) async throws -> BrandSkill {
        throw StudioAPIError.invalidConfiguration("Skill'ler bu bağlantıda kaydedilemiyor.")
    }
    public func updateBrandSkill(brandId: EntityID, id: EntityID, _ input: BrandSkillUpdate) async throws -> BrandSkill {
        throw StudioAPIError.invalidConfiguration("Skill'ler bu bağlantıda kaydedilemiyor.")
    }
    public func deleteBrandSkill(brandId: EntityID, id: EntityID) async throws {
        throw StudioAPIError.invalidConfiguration("Skill'ler bu bağlantıda silinemiyor.")
    }
    public func brandSkillVersions(brandId: EntityID, skillId: EntityID) async throws -> [BrandSkillVersion] { [] }
    public func restoreBrandSkillVersion(brandId: EntityID, skillId: EntityID, version: Int) async throws -> BrandSkill {
        throw StudioAPIError.invalidConfiguration("Skill sürümü bu bağlantıda geri yüklenemiyor.")
    }
    public func draftBrandSkill(brandId: EntityID, focus: String) async throws -> Job {
        throw StudioAPIError.invalidConfiguration("Skill bu bağlantıda çıkarılamıyor.")
    }
    public func templates(brandId: EntityID) async throws -> [ContentTemplate] { [] }
    public func updateTemplate(_ id: EntityID, _ input: ContentTemplateUpdate) async throws -> ContentTemplate {
        throw StudioAPIError.invalidConfiguration("Şablonlar bu bağlantıda kaydedilemiyor.")
    }
    public func deleteTemplate(_ id: EntityID) async throws {
        throw StudioAPIError.invalidConfiguration("Şablonlar bu bağlantıda silinemiyor.")
    }
    public func useTemplate(_ id: EntityID, _ input: TemplateUse) async throws -> TemplateUseResult {
        throw StudioAPIError.invalidConfiguration("Şablondan post bu bağlantıda hazırlanamıyor.")
    }
    public func checkSettings(brandId: EntityID) async throws -> BrandCheckSettings { BrandCheckSettings(brandId: brandId) }
    public func saveCheckSettings(brandId: EntityID, _ input: BrandCheckSettingsPut) async throws -> BrandCheckSettings {
        throw StudioAPIError.invalidConfiguration("Kontrol ayarları bu bağlantıda kaydedilemiyor.")
    }
    public func planningSettings(brandId: EntityID) async throws -> BrandPlanningSettings { BrandPlanningSettings(brandId: brandId) }
    public func savePlanningSettings(brandId: EntityID, _ input: BrandPlanningSettingsPut) async throws -> BrandPlanningSettings {
        throw StudioAPIError.invalidConfiguration("Özel gün ayarları bu bağlantıda kaydedilemiyor.")
    }
    public func specialDays(from: String, to: String) async throws -> [SpecialDay] { [] }
    public func specialDayOverrides() async throws -> SpecialDayOverrides { SpecialDayOverrides() }
    public func saveSpecialDayOverrides(_ overrides: [ReligiousDayOverride]) async throws -> SpecialDayOverrides {
        throw StudioAPIError.invalidConfiguration("Bayram tarihleri bu bağlantıda kaydedilemiyor.")
    }
}

/// N21 / N23 defaults: other conformers keep compiling.
extension StudioDataService {
    public func products(brandId: EntityID) async throws -> [BrandProduct] { [] }
    public func createProduct(brandId: EntityID, _ input: BrandProductCreate) async throws -> BrandProduct {
        throw StudioAPIError.invalidConfiguration("Ürünler bu bağlantıda kaydedilemiyor.")
    }
    public func updateProduct(brandId: EntityID, id: EntityID, _ input: BrandProductUpdate) async throws -> BrandProduct {
        throw StudioAPIError.invalidConfiguration("Ürünler bu bağlantıda kaydedilemiyor.")
    }
    public func deleteProduct(brandId: EntityID, id: EntityID) async throws {
        throw StudioAPIError.invalidConfiguration("Ürünler bu bağlantıda silinemiyor.")
    }
    public func asset(_ id: EntityID) async throws -> Asset {
        guard let found = try await assets(brandId: nil, kind: nil).first(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "asset \(id) not found", issues: [])
        }
        return found
    }
    public func createReel(_ request: ReelFromFootage) async throws -> (Content, Job) {
        throw StudioAPIError.invalidConfiguration("Reels bu bağlantıda başlatılamıyor.")
    }
}

/// Approval without the checks' acknowledgement (E7): what every caller sends unless the user
/// confirmed "Yine de onaylansın mı?".
extension StudioDataService {
    public func approve(contentId: EntityID, hash: String) async throws -> Content {
        try await approve(contentId: contentId, hash: hash, acknowledgeChecks: false)
    }
}

/// P3 defaults: the sample and test backends publish nothing.
extension StudioDataService {
    public func publishingStatus() async throws -> PublishingStatus { .unknownLocal }
    public func setCloudPublisher(url: String, token: String) async throws -> PublishingStatus {
        throw StudioAPIError.invalidConfiguration("Bulut yayıncı bu bağlantıda ayarlanamıyor.")
    }
    public func clearCloudPublisher() async throws -> PublishingStatus { .unknownLocal }
    public func requestPublishingSync() async throws -> PublishingStatus { .unknownLocal }
    public func preflight(contentId: EntityID, accountIds: [EntityID]?, scheduledAt: Date?) async throws -> SchedulePreflight {
        SchedulePreflight(mode: .local, ok: true, targets: [])
    }
    /// Publishing now.
    public func preflight(contentId: EntityID, accountIds: [EntityID]?) async throws -> SchedulePreflight {
        try await preflight(contentId: contentId, accountIds: accountIds, scheduledAt: nil)
    }
    public func publishNow(contentId: EntityID, accountIds: [EntityID]) async throws -> PublishNowResult {
        throw StudioAPIError.invalidConfiguration("Bu bağlantıda yayın yapılamıyor.")
    }
    public func reschedule(_ scheduleId: EntityID, to date: Date) async throws -> Schedule {
        throw StudioAPIError.invalidConfiguration("Bu bağlantıda zamanlama taşınamıyor.")
    }
    public func publishLogs(brandId: EntityID?, finishedAfter: Date?) async throws -> [PublishLogFeedItem] { [] }
    public func exchangeMeta(_ input: MetaExchangeInput) async throws -> MetaExchangeResult {
        throw StudioAPIError.invalidConfiguration("Hesap bağlama yalnızca Mac'te çalışan Studio ile yapılır.")
    }
    public func linkedInOAuth(_ input: LinkedInOAuthInput) async throws -> SocialAccount {
        throw StudioAPIError.invalidConfiguration("Hesap bağlama yalnızca Mac'te çalışan Studio ile yapılır.")
    }
    public func checkSocialAccount(id: EntityID, _ input: SocialAccountCheckInput) async throws -> SocialAccount {
        try await checkSocialAccountToken(id: id)
    }
    public func disconnectSocialAccount(id: EntityID) async throws -> SocialAccount {
        try await updateSocialAccount(id, SocialAccountUpdate(status: .disabled))
    }
}

/// Faz 6 defaults (thumbnails, trash, retry, paid AI): sample and test backends.
extension StudioDataService {
    public func thumbnailData(assetId: EntityID, width: Int) async throws -> Data { try await imageData(assetId: assetId) }
    public func restoreContent(_ id: EntityID) async throws -> Content {
        throw StudioAPIError.invalidConfiguration("Bu bağlantıda silinen post geri alınamıyor.")
    }
    public func retryJob(_ id: EntityID) async throws -> Job {
        throw StudioAPIError.invalidConfiguration("Bu bağlantıda iş yeniden denenemiyor.")
    }
    public func aiSpend() async throws -> AISpendSummary {
        throw StudioAPIError.invalidConfiguration("Harcama bu bağlantıda okunamıyor.")
    }
    public func aiPreferences() async throws -> AIPreferences { AIPreferences() }
    public func decideClaudeLimit(_ choice: ClaudeLimitChoice) async throws -> AIPreferences {
        throw StudioAPIError.invalidConfiguration("Bu karar bu bağlantıda verilemiyor.")
    }
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
    public func latestCheckRun(contentId: EntityID, version: Int) async throws -> ContentCheckRun? { nil }
    public func runChecks(contentId: EntityID, brandId: EntityID, version: Int) async throws -> Job {
        throw StudioAPIError.invalidConfiguration("Kontroller bu bağlantıda çalıştırılamıyor.")
    }
}

extension ConversationService {
    /// Accept and generate with the worker's default model and effort.
    public func acceptAndGenerate(_ plan: Plan) async throws -> Plan {
        try await acceptAndGenerate(plan, model: nil, effort: nil)
    }

    public func acceptAndGenerateResult(_ plan: Plan, model: AgentModel?, effort: AgentEffort?) async throws -> PlanGenerateResult {
        PlanGenerateResult(plan: try await acceptAndGenerate(plan, model: model, effort: effort))
    }

    public func generatePlanResult(_ planId: EntityID, model: AgentModel?, effort: AgentEffort?) async throws -> PlanGenerateResult {
        PlanGenerateResult(plan: try await generatePlan(planId, model: model, effort: effort))
    }

    /// Default for conformers without plan generation (the sample backend generates on accept).
    public func generatePlan(_ planId: EntityID, model: AgentModel?, effort: AgentEffort?) async throws -> Plan {
        throw StudioAPIError.invalidConfiguration("Bu bağlantıda plan üretimi başlatılamıyor.")
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
        try await acceptAndGenerateResult(plan, model: model, effort: effort).plan
    }

    public func acceptAndGenerateResult(_ plan: Plan, model: AgentModel?, effort: AgentEffort?) async throws -> PlanGenerateResult {
        let accepted = try await client.acceptPlan(plan.id, PlanAccept(revision: plan.revision))
        return try await client.generatePlan(accepted.id, PlanGenerate(model: model, effort: effort))
    }

    public func acceptPlan(_ plan: Plan) async throws -> Plan {
        try await client.acceptPlan(plan.id, PlanAccept(revision: plan.revision))
    }

    public func generatePlanResult(_ planId: EntityID, model: AgentModel?, effort: AgentEffort?) async throws -> PlanGenerateResult {
        try await client.generatePlan(planId, PlanGenerate(model: model?.sendable, effort: effort?.sendable))
    }

    public func rejectPlan(_ planId: EntityID, reason: String?) async throws -> Plan {
        try await client.rejectPlan(planId, PlanReject(reason: reason))
    }

    public func generatePlan(_ planId: EntityID, model: AgentModel?, effort: AgentEffort?) async throws -> Plan {
        try await client.generatePlan(planId, PlanGenerate(model: model?.sendable, effort: effort?.sendable)).plan
    }

    /// A picture or (N21) a video attached to a message.
    public func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await client.uploadAsset(file, brandId: brandId, kind: file.assetKind, progress: progress)
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

    public func approve(contentId: EntityID, hash: String, acknowledgeChecks: Bool) async throws -> Content {
        try await client.approveContent(contentId, hash: hash, acknowledgeChecks: acknowledgeChecks)
    }

    public func revokeApproval(contentId: EntityID) async throws -> Content {
        try await client.transitionContent(contentId, to: .draft)
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

    public func requestRevision(of content: Content, baseVersion: Int?, instructions: String) async throws -> Job {
        try await client.requestRevision(of: content, baseVersion: baseVersion, instructions: instructions)
    }

    public func latestCheckRun(contentId: EntityID, version: Int) async throws -> ContentCheckRun? {
        try await client.latestCheckRun(contentId: contentId, version: version)
    }

    public func runChecks(contentId: EntityID, brandId: EntityID, version: Int) async throws -> Job {
        try await client.runChecks(contentId: contentId, brandId: brandId, version: version)
    }

    public func assets(brandId: EntityID?, kind: AssetKind?) async throws -> [Asset] {
        try await client.assets(brandId: brandId, kind: kind)
    }

    public func uploadAsset(_ file: UploadFile, brandId: EntityID, kind: AssetKind?, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await client.uploadAsset(file, brandId: brandId, kind: kind, progress: progress)
    }

    public func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await client.uploadAsset(file, brandId: brandId, kind: file.assetKind, progress: progress)
    }

    public func products(brandId: EntityID) async throws -> [BrandProduct] { try await client.products(brandId: brandId) }
    public func createProduct(brandId: EntityID, _ input: BrandProductCreate) async throws -> BrandProduct {
        try await client.createProduct(brandId: brandId, input)
    }
    public func updateProduct(brandId: EntityID, id: EntityID, _ input: BrandProductUpdate) async throws -> BrandProduct {
        try await client.updateProduct(brandId: brandId, id: id, input)
    }
    public func deleteProduct(brandId: EntityID, id: EntityID) async throws { try await client.deleteProduct(brandId: brandId, id: id) }
    public func asset(_ id: EntityID) async throws -> Asset { try await client.asset(id) }
    public func createReel(_ request: ReelFromFootage) async throws -> (Content, Job) { try await client.createReel(request) }

    // Brand page: skills, templates, checks, special days
    public func brandSkills(brandId: EntityID) async throws -> [BrandSkill] { try await client.brandSkills(brandId: brandId) }
    public func createBrandSkill(brandId: EntityID, _ input: BrandSkillCreate) async throws -> BrandSkill {
        try await client.createBrandSkill(brandId: brandId, input)
    }
    public func updateBrandSkill(brandId: EntityID, id: EntityID, _ input: BrandSkillUpdate) async throws -> BrandSkill {
        try await client.updateBrandSkill(brandId: brandId, id: id, input)
    }
    public func deleteBrandSkill(brandId: EntityID, id: EntityID) async throws { try await client.deleteBrandSkill(brandId: brandId, id: id) }
    public func brandSkillVersions(brandId: EntityID, skillId: EntityID) async throws -> [BrandSkillVersion] {
        try await client.brandSkillVersions(brandId: brandId, skillId: skillId)
    }
    public func restoreBrandSkillVersion(brandId: EntityID, skillId: EntityID, version: Int) async throws -> BrandSkill {
        try await client.restoreBrandSkillVersion(brandId: brandId, skillId: skillId, version: version)
    }
    public func draftBrandSkill(brandId: EntityID, focus: String) async throws -> Job { try await client.draftBrandSkill(brandId: brandId, focus: focus) }
    public func templates(brandId: EntityID) async throws -> [ContentTemplate] { try await client.templates(brandId: brandId) }
    public func updateTemplate(_ id: EntityID, _ input: ContentTemplateUpdate) async throws -> ContentTemplate { try await client.updateTemplate(id, input) }
    public func deleteTemplate(_ id: EntityID) async throws { try await client.deleteTemplate(id) }
    public func useTemplate(_ id: EntityID, _ input: TemplateUse) async throws -> TemplateUseResult { try await client.useTemplate(id, input) }
    public func checkSettings(brandId: EntityID) async throws -> BrandCheckSettings { try await client.checkSettings(brandId: brandId) }
    public func saveCheckSettings(brandId: EntityID, _ input: BrandCheckSettingsPut) async throws -> BrandCheckSettings {
        try await client.putCheckSettings(brandId: brandId, input)
    }
    public func planningSettings(brandId: EntityID) async throws -> BrandPlanningSettings { try await client.planningSettings(brandId: brandId) }
    public func savePlanningSettings(brandId: EntityID, _ input: BrandPlanningSettingsPut) async throws -> BrandPlanningSettings {
        try await client.putPlanningSettings(brandId: brandId, input)
    }
    public func specialDays(from: String, to: String) async throws -> [SpecialDay] { try await client.specialDays(from: from, to: to) }
    public func specialDayOverrides() async throws -> SpecialDayOverrides { try await client.specialDayOverrides() }
    public func saveSpecialDayOverrides(_ overrides: [ReligiousDayOverride]) async throws -> SpecialDayOverrides {
        try await client.putSpecialDayOverrides(overrides)
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
    public func thumbnailData(assetId: EntityID, width: Int) async throws -> Data {
        try await client.assetThumbnailData(assetId, width: width)
    }
    public func restoreContent(_ id: EntityID) async throws -> Content { try await client.restoreContent(id) }
    public func retryJob(_ id: EntityID) async throws -> Job { try await client.retryJob(id) }
    public func aiSpend() async throws -> AISpendSummary { try await client.aiSpend() }
    public func aiPreferences() async throws -> AIPreferences { try await client.aiPreferences() }
    public func decideClaudeLimit(_ choice: ClaudeLimitChoice) async throws -> AIPreferences {
        try await client.decideClaudeLimit(ClaudeLimitDecisionCreate(choice: choice))
    }
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

    // P3
    public func publishingStatus() async throws -> PublishingStatus { try await client.publishingStatus() }
    public func setCloudPublisher(url: String, token: String) async throws -> PublishingStatus {
        try await client.setCloudPublisher(PublishingCloudPut(url: url, token: token))
    }
    public func clearCloudPublisher() async throws -> PublishingStatus { try await client.clearCloudPublisher() }
    public func requestPublishingSync() async throws -> PublishingStatus { try await client.requestPublishingSync() }
    public func preflight(contentId: EntityID, accountIds: [EntityID]?, scheduledAt: Date?) async throws -> SchedulePreflight {
        try await client.preflight(SchedulePreflightInput(contentId: contentId, socialAccountIds: accountIds, scheduledAt: scheduledAt))
    }
    public func publishNow(contentId: EntityID, accountIds: [EntityID]) async throws -> PublishNowResult {
        try await client.publishNow(PublishNowInput(contentId: contentId, socialAccountIds: accountIds))
    }
    public func reschedule(_ scheduleId: EntityID, to date: Date) async throws -> Schedule {
        try await client.reschedule(scheduleId, to: date)
    }
    public func publishLogs(brandId: EntityID?, finishedAfter: Date?) async throws -> [PublishLogFeedItem] {
        try await client.publishLogs(brandId: brandId, finishedAfter: finishedAfter)
    }
    public func exchangeMeta(_ input: MetaExchangeInput) async throws -> MetaExchangeResult { try await client.exchangeMeta(input) }
    public func linkedInOAuth(_ input: LinkedInOAuthInput) async throws -> SocialAccount { try await client.linkedInOAuth(input) }
    public func checkSocialAccount(id: EntityID, _ input: SocialAccountCheckInput) async throws -> SocialAccount {
        try await client.checkSocialAccount(id: id, input)
    }
    public func disconnectSocialAccount(id: EntityID) async throws -> SocialAccount { try await client.disconnectSocialAccount(id: id) }
}
