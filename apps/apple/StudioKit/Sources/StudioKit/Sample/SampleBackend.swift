import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// In-memory implementation of both services over `SampleData`.
///
/// Behaves like the real API without a Mac worker: sending a message stores
/// it and starts a run that stays `queued`; accepting a plan creates draft
/// posts and queued generation jobs; uploads, slot fills, layer edits, brand
/// profiles, OAuth token checks, and AI image generation are simulated in memory.
public actor SampleBackend: ConversationService, StudioDataService {
    private var data: SampleData
    private var uploads: [EntityID: Data] = [:]
    private var versionHistory: [EntityID: [ContentVersion]] = [:]
    private var observers: [EntityID: [UUID: AsyncStream<ConversationFeedEvent>.Continuation]] = [:]
    private var jobObservers: [UUID: AsyncStream<JobFeedEvent>.Continuation] = [:]
    private var seqs: [EntityID: Int] = [:]
    private var kits: [EntityID: BrandKit] = [:]
    /// Check runs per content id, newest first.
    private var checkRuns: [EntityID: [ContentCheckRun]] = [:]
    /// Posts approved although their checks held the approval back (the user confirmed: E7).
    public private(set) var approvalsDespiteChecks: [EntityID] = []
    private var counter = 0
    /// Simulated upload duration per image (0 in tests).
    private let uploadDelay: Duration

    public init(data: SampleData = SampleData(), uploadDelay: Duration = .milliseconds(600)) {
        self.data = data
        self.uploadDelay = uploadDelay
        var hist: [EntityID: [ContentVersion]] = [:]
        for (contentId, version) in data.versions {
            hist[contentId] = [version]
        }
        self.versionHistory = hist
    }

    private func nextId(_ prefix: String) -> String {
        counter += 1
        return "\(prefix)-\(counter)"
    }

    private var now: Date { Date() }

    // MARK: - ConversationService

    public func conversations() async throws -> [Conversation] {
        data.conversations.filter { $0.status == .active }.sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    public func createConversation(brandId: EntityID?, title: String?) async throws -> Conversation {
        let conversation = Conversation(id: nextId("c"), brandId: brandId, title: title ?? "", lastActivityAt: now, createdAt: now, updatedAt: now)
        data.conversations.append(conversation)
        data.messages[conversation.id] = []
        return conversation
    }

    public func renameConversation(_ id: EntityID, title: String) async throws -> Conversation {
        try updateConversation(id) { $0.title = title }
    }

    public func archiveConversation(_ id: EntityID) async throws -> Conversation {
        try updateConversation(id) { $0.status = .archived }
    }

    private func updateConversation(_ id: EntityID, _ change: (inout Conversation) -> Void) throws -> Conversation {
        guard let index = data.conversations.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "conversation \(id) not found", issues: [])
        }
        change(&data.conversations[index])
        data.conversations[index].updatedAt = now
        broadcast(id)
        return data.conversations[index]
    }

    public nonisolated func observe(_ id: EntityID) -> AsyncStream<ConversationFeedEvent> {
        AsyncStream { continuation in
            let token = UUID()
            Task { await self.addObserver(id, token, continuation) }
            continuation.onTermination = { _ in Task { await self.removeObserver(id, token) } }
        }
    }

    private func addObserver(_ id: EntityID, _ token: UUID, _ continuation: AsyncStream<ConversationFeedEvent>.Continuation) {
        observers[id, default: [:]][token] = continuation
        continuation.yield(.state(.live))
        if let state = state(of: id) { continuation.yield(.conversation(state)) }
    }

    private func removeObserver(_ id: EntityID, _ token: UUID) {
        observers[id]?[token] = nil
    }

    /// The conversation as a stream snapshot would describe it.
    public func state(of id: EntityID) -> ConversationState? {
        guard let conversation = data.conversations.first(where: { $0.id == id }) else { return nil }
        let messages = (data.messages[id] ?? []).sorted { $0.createdAt < $1.createdAt }
        let plans = data.plans.filter { $0.conversationId == id && $0.status != .superseded }.sorted { $0.createdAt > $1.createdAt }
        let activeRun = data.runs.first { $0.conversationId == id && $0.status.isActive }
        return ConversationState(snapshot: ConversationSnapshot(
            seq: seqs[id] ?? conversation.lastSeq, conversation: conversation, messages: messages,
            activeRun: activeRun, plans: plans, aliases: data.aliases[id] ?? [], presence: data.presence))
    }

    private func broadcast(_ id: EntityID) {
        seqs[id, default: data.conversations.first { $0.id == id }?.lastSeq ?? 0] += 1
        guard let state = state(of: id) else { return }
        for continuation in observers[id, default: [:]].values { continuation.yield(.conversation(state)) }
    }

    public func send(_ message: OutgoingMessage, to conversationId: EntityID) async throws -> UserMessageResult {
        guard data.conversations.contains(where: { $0.id == conversationId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "conversation not found", issues: [])
        }
        if data.runs.contains(where: { $0.conversationId == conversationId && $0.status.isActive }) {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "another run is active", issues: [])
        }
        var aliases = data.aliases[conversationId] ?? []
        var allocator = AliasAllocator(aliases: aliases)
        let messageId = nextId("m")
        var parts: [MessagePart] = []
        for attachment in message.attachments {
            let asset = data.assets[attachment.assetId]
            let alias: ConversationAlias
            if let existing = aliases.first(where: { $0.assetId == attachment.assetId }) {
                alias = existing
            } else {
                var name = allocator.next()
                if let requested = attachment.alias {
                    guard ImageAlias.isValid(requested) else {
                        throw StudioAPIError.server(status: 400, code: .validationError, message: "invalid alias \(requested)", issues: [])
                    }
                    if requested != name {
                        guard !allocator.used.contains(requested) else {
                            throw StudioAPIError.server(status: 409, code: .conflict, message: "alias \(requested) is taken", issues: [])
                        }
                        allocator.release(name)
                        try? allocator.rename(name, to: requested)
                        name = requested
                    }
                }
                alias = ConversationAlias(
                    id: nextId("alias"), conversationId: conversationId, alias: name, assetId: attachment.assetId,
                    mimeType: asset?.mimeType ?? "image/png", width: asset?.width, height: asset?.height,
                    filename: asset?.originalFilename, messageId: messageId, createdAt: now, updatedAt: now)
                aliases.append(alias)
            }
            parts.append(.attachment(AttachmentPart(
                assetId: attachment.assetId, kind: .image, mimeType: asset?.mimeType ?? "image/png",
                width: asset?.width, height: asset?.height, filename: asset?.originalFilename, alias: alias.alias, aliasId: alias.id)))
        }
        data.aliases[conversationId] = aliases
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { parts.append(.text(text)) }
        let mentions = MentionText.resolve(text, aliases: aliases.map(MentionText.Target.init))
        let stored = Message(id: messageId, conversationId: conversationId, role: .user, parts: parts, mentions: mentions, createdAt: now, updatedAt: now)
        data.messages[conversationId, default: []].append(stored)

        if text.lowercased() == "/usage" && message.attachments.isEmpty {
            let run = AgentRun(
                id: nextId("run"), conversationId: conversationId, triggerMessageId: stored.id, jobId: nil, status: .completed,
                model: message.model?.sendable?.rawValue, effort: message.effort?.sendable,
                createdAt: now, updatedAt: now, startedAt: now, finishedAt: now
            )
            data.runs.append(run)
            let summary = usageSummaryText()
            let reply = Message(
                id: nextId("m"), conversationId: conversationId, role: .assistant, status: .complete, runId: run.id,
                parts: [
                    .toolStep(ToolStepPart(id: "ts-usage", name: "usage_status", label: "Kullanım ve bağlantılar okundu", state: .done, summary: "Örnek oturum")),
                    .text(summary),
                ],
                createdAt: now, updatedAt: now
            )
            data.messages[conversationId, default: []].append(reply)
            if let index = data.conversations.firstIndex(where: { $0.id == conversationId }) {
                if data.conversations[index].title.isEmpty { data.conversations[index].title = "Kullanım durumu" }
                data.conversations[index].activeRunId = nil
                data.conversations[index].lastActivityAt = now
            }
            broadcast(conversationId)
            return UserMessageResult(message: stored, run: run, replayed: false)
        }

        let run = AgentRun(
            id: nextId("run"), conversationId: conversationId, triggerMessageId: stored.id, jobId: nextId("job"), status: .queued,
            model: message.model?.sendable?.rawValue, effort: message.effort?.sendable, createdAt: now, updatedAt: now)
        data.runs.append(run)
        data.jobs.insert(Job(id: run.jobId!, type: .chatTurn, status: .queued, payload: ["conversationId": .string(conversationId), "runId": .string(run.id)], createdAt: now, updatedAt: now), at: 0)
        if let index = data.conversations.firstIndex(where: { $0.id == conversationId }) {
            if data.conversations[index].title.isEmpty { data.conversations[index].title = String(text.prefix(60)) }
            data.conversations[index].activeRunId = run.id
            data.conversations[index].lastActivityAt = now
        }
        broadcast(conversationId)
        broadcastJobs()
        return UserMessageResult(message: stored, run: run, replayed: false)
    }

    private func usageSummaryText() -> String {
        var lines: [String] = []
        if let claude = data.presence.claude {
            let status: String = switch claude.status {
            case .signedIn: "Giriş yapıldı (\(claude.email ?? "hesap")\(claude.plan.map { " · \($0)" } ?? ""))"
            case .signedOut: "Giriş yapılmadı"
            case .signingIn: "Tarayıcıda giriş bekleniyor"
            case .notInstalled: "Kurulu değil"
            case .error, .unknown: claude.detail ?? "Durum okunamadı"
            }
            lines.append("Claude: \(status)")
        }
        if let usage = data.presence.usage {
            for window in usage.windows {
                let name = switch window.kind {
                case .fiveHour: "5 saatlik"
                case .weekly: "Haftalık"
                case .other, .unknown: "Diğer"
                }
                let val = window.limited ? "Sınıra ulaşıldı" : "%\(Int(window.effectivePercent.rounded())) kullanıldı"
                lines.append("• \(name): \(val)")
            }
        }
        if let gemini = data.presence.gemini {
            let gStatus: String = switch gemini.status {
            case .ready: "Hazır (\(gemini.detail ?? gemini.mode.rawValue))"
            case .notConfigured: "Yapılandırılmadı"
            case .error, .unknown: gemini.detail ?? "Hata"
            }
            lines.append("Gemini: \(gStatus)")
        }
        return lines.isEmpty ? "Henüz kullanım veya bağlantı bilgisi yok." : lines.joined(separator: "\n")
    }

    public func answer(conversationId: EntityID, messageId: EntityID, _ answer: QuestionAnswerCreate) async throws -> QuestionAnswerResult {
        guard var list = data.messages[conversationId], let index = list.firstIndex(where: { $0.id == messageId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "message not found", issues: [])
        }
        var message = list[index]
        guard let partIndex = message.parts.firstIndex(where: { if case .question(let q) = $0 { q.questionId == answer.questionId } else { false } }),
              case .question(var question) = message.parts[partIndex] else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "question not found", issues: [])
        }
        if let problem = question.check(optionIds: answer.optionIds, text: answer.text) {
            throw StudioAPIError.server(status: 400, code: .validationError, message: problem, issues: [])
        }
        question.answer = QuestionAnswer(optionIds: answer.optionIds, text: answer.text, answeredAt: now)
        message.parts[partIndex] = .question(question)
        list[index] = message
        data.messages[conversationId] = list
        let run = AgentRun(id: nextId("run"), conversationId: conversationId, triggerMessageId: messageId, status: .queued, createdAt: now, updatedAt: now)
        data.runs.append(run)
        broadcast(conversationId)
        return QuestionAnswerResult(message: message, run: run)
    }

    public func decideConsent(conversationId: EntityID, messageId: EntityID, _ decision: ConsentDecisionCreate) async throws -> ConsentDecisionResult {
        guard var list = data.messages[conversationId], let index = list.firstIndex(where: { $0.id == messageId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "message not found", issues: [])
        }
        var message = list[index]
        guard let partIndex = message.parts.firstIndex(where: { if case .consent(let c) = $0 { c.consentId == decision.consentId } else { false } }),
              case .consent(var consent) = message.parts[partIndex] else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "consent card not found", issues: [])
        }
        guard consent.state == .pending else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "consent already \(consent.state.rawValue)", issues: [])
        }
        consent.state = decision.allow ? .allowed : .denied
        consent.decidedAt = now
        message.parts[partIndex] = .consent(consent)
        message.updatedAt = now
        list[index] = message
        data.messages[conversationId] = list
        let seq = (seqs[conversationId] ?? data.conversations.first { $0.id == conversationId }?.lastSeq ?? 0) + 1
        seqs[conversationId] = seq
        if let state = state(of: conversationId) {
            let frame = ConversationStreamMessage.event(seq: seq, .partUpdated(messageId: messageId, index: partIndex, part: .consent(consent)))
            var previous = state
            previous.seq = seq - 1
            let applied = ConversationState.apply(previous, frame) ?? state
            for continuation in observers[conversationId, default: [:]].values {
                continuation.yield(.conversation(applied))
            }
        }
        return ConsentDecisionResult(message: message)
    }

    public func cancelRun(_ runId: EntityID) async throws -> AgentRun {
        guard let index = data.runs.firstIndex(where: { $0.id == runId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "run not found", issues: [])
        }
        guard data.runs[index].status.isActive else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "run already finished", issues: [])
        }
        data.runs[index].status = .cancelled
        data.runs[index].finishedAt = now
        let run = data.runs[index]
        if let jobId = run.jobId, let jobIndex = data.jobs.firstIndex(where: { $0.id == jobId }) {
            data.jobs[jobIndex].status = .cancelled
            data.jobs[jobIndex].finishedAt = now
        }
        if let c = data.conversations.firstIndex(where: { $0.id == run.conversationId }) { data.conversations[c].activeRunId = nil }
        broadcast(run.conversationId)
        broadcastJobs()
        return run
    }

    public func aliases(conversationId: EntityID) async throws -> [ConversationAlias] {
        data.aliases[conversationId] ?? []
    }

    public func renameAlias(conversationId: EntityID, aliasId: EntityID, to name: String) async throws -> ConversationAlias {
        var aliases = data.aliases[conversationId] ?? []
        guard let index = aliases.firstIndex(where: { $0.id == aliasId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "alias not found", issues: [])
        }
        let name = name.lowercased()
        guard ImageAlias.isValid(name) else {
            throw StudioAPIError.server(status: 400, code: .validationError, message: "invalid alias", issues: [])
        }
        if aliases[index].alias == name { return aliases[index] }
        let taken = aliases.contains { $0.id != aliasId && ($0.alias == name || $0.previousAliases.contains(name)) }
            || aliases[index].previousAliases.contains(name)
        guard !taken else {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "alias \(name) is or was used in this conversation", issues: [])
        }
        aliases[index].previousAliases.append(aliases[index].alias)
        aliases[index].alias = name
        aliases[index].updatedAt = now
        data.aliases[conversationId] = aliases
        broadcast(conversationId)
        return aliases[index]
    }

    public func acceptAndGenerate(_ plan: Plan, model: AgentModel?, effort: AgentEffort?) async throws -> Plan {
        guard let index = data.plans.firstIndex(where: { $0.id == plan.id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "plan not found", issues: [])
        }
        var stored = data.plans[index]
        guard stored.status.isOpen else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "plan is \(stored.status.rawValue)", issues: [])
        }
        guard stored.revision == plan.revision else {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "plan changed (revision \(stored.revision))", issues: [])
        }
        stored.status = .accepted
        stored.decidedAt = now
        for i in stored.items.indices {
            let item = stored.items[i]
            let content = Content(
                id: nextId("post"), brandId: stored.brandId, type: item.contentType, title: item.title, brief: item.brief,
                status: .draft, targetPlatforms: item.platforms, caption: "", currentVersion: nil, createdAt: now, updatedAt: now)
            data.contents.append(content)
            let job = Job(id: nextId("job"), type: .contentGenerate, status: .queued, payload: ["title": .string(item.title)], brandId: stored.brandId, contentId: content.id, createdAt: now, updatedAt: now)
            data.jobs.insert(job, at: 0)
            stored.items[i].status = .accepted
            stored.items[i].contentId = content.id
            stored.items[i].generation = PlanItemGeneration(jobId: job.id, status: .queued)
        }
        data.plans[index] = stored
        if let conversationId = stored.conversationId { broadcast(conversationId) }
        broadcastJobs()
        return stored
    }

    public func rejectPlan(_ planId: EntityID, reason: String?) async throws -> Plan {
        guard let index = data.plans.firstIndex(where: { $0.id == planId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "plan not found", issues: [])
        }
        data.plans[index].status = .rejected
        data.plans[index].rejectionReason = reason
        data.plans[index].decidedAt = now
        if let conversationId = data.plans[index].conversationId { broadcast(conversationId) }
        return data.plans[index]
    }

    // MARK: - Assets & AI Image Generation

    public func assets(brandId: EntityID?, kind: AssetKind?) async throws -> [Asset] {
        data.assets.values
            .filter { (brandId == nil || $0.brandId == brandId) && (kind == nil || $0.kind == kind) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    public func uploadAsset(_ file: UploadFile, brandId: EntityID, kind: AssetKind?, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        let steps = 5
        for step in 1...steps {
            if uploadDelay > .zero { try await Task.sleep(for: uploadDelay / steps) }
            progress(Double(step) / Double(steps) * 0.97)
        }
        let resolvedKind = kind ?? Self.inferAssetKind(mimeType: file.mimeType)
        let asset = Asset(
            id: nextId("asset"), brandId: brandId, kind: resolvedKind, source: .upload,
            objectKey: "brands/\(brandId)/assets/\(file.filename)", mimeType: file.mimeType,
            bytes: file.data.count, sha256: String(repeating: "0", count: 64), width: file.width, height: file.height,
            originalFilename: file.filename, createdAt: now)
        data.assets[asset.id] = asset
        uploads[asset.id] = file.data
        progress(1)
        return asset
    }

    public func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        try await uploadAsset(file, brandId: brandId, kind: .image, progress: progress)
    }

    private static func inferAssetKind(mimeType: String) -> AssetKind {
        let lower = mimeType.lowercased()
        if lower.hasPrefix("image/") { return .image }
        if lower.hasPrefix("video/") { return .video }
        if lower.hasPrefix("audio/") { return .audio }
        if lower == "application/pdf" { return .document }
        return .other
    }

    public func generateAIImage(
        brandId: EntityID, prompt: String, aspectRatio: String, imageSize: String,
        referenceAssetIds: [EntityID], preserveProductLabel: Bool,
        targetContentId: EntityID?, targetSlotId: String?
    ) async throws -> Job {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw StudioAPIError.server(status: 400, code: .validationError, message: "prompt boş olamaz", issues: [])
        }
        let dims: (Int, Int) = switch (aspectRatio, imageSize) {
        case ("9:16", "2K"): (1440, 2560)
        case ("9:16", _): (1080, 1920)
        case ("1:1", "2K"): (2048, 2048)
        case ("1:1", _): (1024, 1024)
        case (_, "1K"): (1080, 1350)
        default: (1856, 2304)
        }
        let png = SampleImages.png(seed: trimmed) ?? Data([0x89, 0x50, 0x4E, 0x47])
        let asset = Asset(
            id: nextId("ai-asset"), brandId: brandId, kind: .image, source: .generated,
            objectKey: "brands/\(brandId)/generated/\(UUID().uuidString).png", mimeType: "image/png",
            bytes: png.count, sha256: String(repeating: "a", count: 64), width: dims.0, height: dims.1,
            originalFilename: "ai-\(Brand.slugify(String(trimmed.prefix(24)))).png", createdAt: now
        )
        data.assets[asset.id] = asset
        uploads[asset.id] = png

        if let targetContentId {
            _ = try? fillSlotInternal(contentId: targetContentId, slotId: targetSlotId ?? "photo", assetId: asset.id)
        }

        var payload: JSONObject = [
            "prompt": .string(trimmed),
            "aspectRatio": .string(aspectRatio),
            "imageSize": .string(imageSize),
            "referenceAssetIds": .array(referenceAssetIds.map { .string($0) }),
            "preserveProductLabel": .bool(preserveProductLabel),
        ]
        if let targetContentId { payload["targetContentId"] = .string(targetContentId) }
        if let targetSlotId { payload["targetSlotId"] = .string(targetSlotId) }

        let job = Job(
            id: nextId("job"), type: .imageGenerate, status: .succeeded, payload: payload,
            brandId: brandId, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now, progress: 1,
            output: ["assetId": .string(asset.id)]
        )
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    // MARK: - Brands & Brand Profiles

    public func brands() async throws -> [Brand] {
        data.brands.filter { $0.status == .active }
    }

    public func createBrand(_ input: BrandCreate) async throws -> Brand {
        let name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            throw StudioAPIError.server(status: 400, code: .validationError, message: "Marka adı boş olamaz", issues: [])
        }
        let slug = (input.slug?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? Brand.slugify(name)
        if data.brands.contains(where: { $0.slug == slug }) {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "Bu kısa ad (\(slug)) zaten kullanılıyor.", issues: [])
        }
        let brand = Brand(id: nextId("b"), name: name, slug: slug, defaultLanguage: input.defaultLanguage, status: .active, createdAt: now, updatedAt: now)
        data.brands.append(brand)
        return brand
    }

    public func updateBrand(_ id: EntityID, _ input: BrandUpdate) async throws -> Brand {
        guard let index = data.brands.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "brand not found", issues: [])
        }
        if let name = input.name { data.brands[index].name = name }
        if let slug = input.slug { data.brands[index].slug = slug }
        if let lang = input.defaultLanguage { data.brands[index].defaultLanguage = lang }
        if let status = input.status { data.brands[index].status = status }
        data.brands[index].updatedAt = now
        return data.brands[index]
    }

    public func archivedBrands() async throws -> [Brand] {
        data.brands.filter { $0.status == .archived }
    }

    public func brandKit(brandId: EntityID) async throws -> BrandKit {
        guard data.brands.contains(where: { $0.id == brandId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "brand not found", issues: [])
        }
        return kits[brandId] ?? .empty(brandId)
    }

    public func saveBrandKit(brandId: EntityID, _ input: BrandKitPut) async throws -> BrandKit {
        guard data.brands.contains(where: { $0.id == brandId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "brand not found", issues: [])
        }
        let own = Set(data.assets.values.filter { $0.brandId == brandId }.map(\.id))
        let refs = input.logos.map(\.assetId) + input.fonts.compactMap(\.assetId) + input.samples.map(\.assetId)
        if let bad = refs.first(where: { !own.contains($0) }) {
            throw StudioAPIError.server(
                status: 400, code: .validationError, message: "the kit references unusable files",
                issues: [APIErrorBody.Issue(path: "assetId", message: "\(bad) is not an asset of this brand")]
            )
        }
        let kit = BrandKit(
            brandId: brandId, logos: input.logos, fonts: input.fonts,
            palette: input.palette.map { BrandKitColor(name: $0.name, hex: $0.hex.uppercased(), use: $0.use) },
            samples: input.samples, notes: input.notes, updatedAt: now
        )
        kits[brandId] = kit
        return kit
    }

    public func brandProfiles(brandId: EntityID) async throws -> [BrandProfile] {
        (data.brandProfiles[brandId] ?? []).sorted { $0.version > $1.version }
    }

    public func currentBrandProfile(brandId: EntityID) async throws -> BrandProfile? {
        data.brandProfiles[brandId]?.first { $0.isCurrent }
    }

    public func createBrandProfile(brandId: EntityID, _ input: BrandProfileCreate) async throws -> BrandProfile {
        var list = data.brandProfiles[brandId] ?? []
        let nextVer = (list.map(\.version).max() ?? 0) + 1
        let profile = BrandProfile(
            id: nextId("bp"), brandId: brandId, version: nextVer, status: .draft, isCurrent: false,
            tokens: input.tokens, designRules: input.designRules, voice: input.voice,
            approvedAt: nil, createdAt: now, updatedAt: now
        )
        list.append(profile)
        data.brandProfiles[brandId] = list
        return profile
    }

    public func updateBrandProfile(brandId: EntityID, version: Int, _ input: BrandProfileUpdate) async throws -> BrandProfile {
        guard var list = data.brandProfiles[brandId],
              let index = list.firstIndex(where: { $0.version == version }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "profile not found", issues: [])
        }
        guard list[index].status == .draft else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "Onaylı profil düzenlenemez; yeni taslak oluşturun.", issues: [])
        }
        if let tokens = input.tokens { list[index].tokens = tokens }
        if let rules = input.designRules { list[index].designRules = rules }
        if let voice = input.voice { list[index].voice = voice }
        list[index].updatedAt = now
        data.brandProfiles[brandId] = list
        return list[index]
    }

    public func approveBrandProfile(brandId: EntityID, version: Int) async throws -> BrandProfile {
        guard var list = data.brandProfiles[brandId],
              let index = list.firstIndex(where: { $0.version == version }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "profile not found", issues: [])
        }
        for i in list.indices {
            list[i].isCurrent = (i == index)
        }
        list[index].status = .approved
        if list[index].approvedAt == nil { list[index].approvedAt = now }
        list[index].updatedAt = now
        data.brandProfiles[brandId] = list
        return list[index]
    }

    public func analyzeBrand(brandId: EntityID, notes: String?) async throws -> Job {
        let brandName = data.brands.first { $0.id == brandId }?.name ?? "Marka"
        var list = data.brandProfiles[brandId] ?? []
        let nextVer = (list.map(\.version).max() ?? 0) + 1
        let noteLine = notes.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : "\n- Not: \($0)" } ?? ""
        let draft = BrandProfile(
            id: nextId("bp"),
            brandId: brandId,
            version: nextVer,
            status: .draft,
            isCurrent: false,
            tokens: Self.sampleTokens(kit: kits[brandId]),
            designRules: "# AI Analiz Tasarım Kuralları (\(brandName))\n\n- Güçlü tipografi hiyerarşisi ve net boşluk kullanımı.\(noteLine)",
            voice: "# AI Analiz Metin Tonu (\(brandName))\n\n- Doğrudan, anlaşılır ve hedef kitleye uygun Türkçe ton.\(noteLine)",
            createdAt: now,
            updatedAt: now
        )
        list.append(draft)
        data.brandProfiles[brandId] = list

        var payload: JSONObject = [:]
        if let notes, !notes.isEmpty { payload["notes"] = .string(notes) }
        let job = Job(
            id: nextId("job"), type: .brandAnalyze, status: .succeeded, payload: payload,
            brandId: brandId, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now, progress: 1,
            output: ["version": .number(Double(draft.version))]
        )
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    /// Design-kit shaped tokens like the worker writes (colours, fonts, spacing, facts).
    private static func sampleTokens(kit: BrandKit?) -> JSONObject {
        var colors: JSONObject = [
            "paper": .object(["value": .string("#FFFFFF"), "use": .string("zemin")]),
            "ink": .object(["value": .string("#0A0A0A"), "use": .string("başlık ve metin")]),
            "accent": .object(["value": .string("#FF6A00"), "use": .string("tek vurgu")]),
        ]
        for color in kit?.palette ?? [] {
            var entry: JSONObject = ["value": .string(color.hex)]
            if let use = color.use { entry["use"] = .string(use) }
            colors[color.name] = .object(entry)
        }
        let display = kit?.fonts.first { $0.role != .text }?.family ?? "Helvetica Neue"
        let text = kit?.fonts.first { $0.role != .display }?.family ?? "Helvetica Neue"
        return [
            "status": .string("approved"),
            "color": .object(colors),
            "font": .object([
                "display": .object(["family": .string(display), "files": .array([]), "fallback": .string("sans-serif")]),
                "text": .object(["family": .string(text), "files": .array([]), "fallback": .string("sans-serif")]),
            ]),
            "space": .object(["margin": .number(72), "gutter": .number(24), "unit": .number(8), "scale": .array([])]),
            "radius": .object(["sm": .number(8), "md": .number(16), "lg": .number(32)]),
            "facts": .object([
                "allowedNumbers": .array([]),
                "statements": .array([]),
                "forbidden": .array([]),
            ]),
        ]
    }

    // MARK: - Social Accounts & Token Vault

    public func socialAccounts(brandId: EntityID?) async throws -> [SocialAccount] {
        data.accounts.filter { brandId == nil || $0.brandId == brandId }
    }

    public func createSocialAccount(_ input: SocialAccountCreate) async throws -> SocialAccount {
        let account = SocialAccount(
            id: nextId("sa"), brandId: input.brandId, platform: input.platform,
            handle: input.handle, externalId: input.externalId,
            status: input.status ?? .pending, createdAt: now, updatedAt: now,
            hasToken: false, tokenHealth: .unchecked
        )
        data.accounts.append(account)
        return account
    }

    public func updateSocialAccount(_ id: EntityID, _ input: SocialAccountUpdate) async throws -> SocialAccount {
        guard let index = data.accounts.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "account not found", issues: [])
        }
        if let handle = input.handle { data.accounts[index].handle = handle }
        if let externalId = input.externalId { data.accounts[index].externalId = externalId }
        if let status = input.status { data.accounts[index].status = status }
        data.accounts[index].updatedAt = now
        return data.accounts[index]
    }

    public func putSocialAccountToken(id: EntityID, _ input: SocialAccountTokenPut) async throws -> SocialAccount {
        guard let index = data.accounts.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "account not found", issues: [])
        }
        if let handle = input.handle, !handle.isEmpty { data.accounts[index].handle = handle }
        if let externalId = input.externalId, !externalId.isEmpty { data.accounts[index].externalId = externalId }
        data.accounts[index].status = .connected
        data.accounts[index].hasToken = true
        data.accounts[index].tokenExpiresAt = input.expiresAt ?? now.addingTimeInterval(60 * 86_400)
        data.accounts[index].tokenScopes = input.scopes ?? ["publish"]
        data.accounts[index].tokenHealth = .valid
        data.accounts[index].tokenCheckedAt = now
        data.accounts[index].updatedAt = now
        return data.accounts[index]
    }

    public func checkSocialAccountToken(id: EntityID) async throws -> SocialAccount {
        guard let index = data.accounts.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "account not found", issues: [])
        }
        data.accounts[index].tokenCheckedAt = now
        if data.accounts[index].hasToken == true {
            data.accounts[index].tokenHealth = .valid
            if data.accounts[index].status == .needsReauth || data.accounts[index].status == .pending {
                data.accounts[index].status = .connected
            }
        } else {
            data.accounts[index].tokenHealth = .invalid
        }
        data.accounts[index].updatedAt = now
        return data.accounts[index]
    }

    public func discoverMetaAccounts(_ input: MetaDiscoverInput) async throws -> MetaDiscoverResult {
        let brandName = data.brands.first { $0.id == input.brandId }?.name ?? "Studio Sayfası"
        let slug = data.brands.first { $0.id == input.brandId }?.slug.replacingOccurrences(of: "-", with: "") ?? "studio"
        let page = MetaDiscoveredPage(
            pageId: "fb-\(slug)",
            pageName: brandName,
            canPublish: true,
            instagram: .init(igUserId: "ig-\(slug)", username: slug)
        )
        var connected: [SocialAccount] = []
        if input.autoConnect {
            for (platform, handle, extId) in [(Platform.facebook, brandName, page.pageId), (Platform.instagram, slug, "ig-\(slug)")] {
                if let idx = data.accounts.firstIndex(where: { $0.brandId == input.brandId && $0.platform == platform }) {
                    data.accounts[idx].handle = handle
                    data.accounts[idx].externalId = extId
                    data.accounts[idx].status = .connected
                    data.accounts[idx].hasToken = true
                    data.accounts[idx].tokenHealth = .valid
                    data.accounts[idx].tokenCheckedAt = now
                    data.accounts[idx].tokenExpiresAt = now.addingTimeInterval(60 * 86_400)
                    data.accounts[idx].updatedAt = now
                    connected.append(data.accounts[idx])
                } else {
                    let created = SocialAccount(
                        id: nextId("sa"), brandId: input.brandId, platform: platform, handle: handle, externalId: extId,
                        status: .connected, createdAt: now, updatedAt: now,
                        hasToken: true, tokenExpiresAt: now.addingTimeInterval(60 * 86_400),
                        tokenHealth: .valid, tokenCheckedAt: now
                    )
                    data.accounts.append(created)
                    connected.append(created)
                }
            }
        }
        return MetaDiscoverResult(pages: [page], connectedAccounts: connected)
    }

    public func connectLinkedInAccount(_ input: LinkedInConnectInput) async throws -> SocialAccount {
        let expires = now.addingTimeInterval(Double(input.expiresInSeconds ?? 60 * 86_400))
        if let idx = data.accounts.firstIndex(where: { $0.brandId == input.brandId && $0.platform == .linkedin }) {
            data.accounts[idx].handle = input.handle
            data.accounts[idx].externalId = input.personUrn
            data.accounts[idx].status = .connected
            data.accounts[idx].hasToken = true
            data.accounts[idx].tokenExpiresAt = expires
            data.accounts[idx].tokenScopes = ["openid", "profile", "w_member_social"]
            data.accounts[idx].tokenHealth = .valid
            data.accounts[idx].tokenCheckedAt = now
            data.accounts[idx].updatedAt = now
            return data.accounts[idx]
        }
        let created = SocialAccount(
            id: nextId("sa"), brandId: input.brandId, platform: .linkedin, handle: input.handle, externalId: input.personUrn,
            status: .connected, createdAt: now, updatedAt: now,
            hasToken: true, tokenExpiresAt: expires, tokenScopes: ["openid", "profile", "w_member_social"],
            tokenHealth: .valid, tokenCheckedAt: now
        )
        data.accounts.append(created)
        return created
    }

    // MARK: - Contents, Versions, Slot-Fill, Layer Patch & Export

    public func contents(brandId: EntityID) async throws -> [Content] {
        data.contents.filter { $0.brandId == brandId }
    }

    public func content(_ id: EntityID) async throws -> Content {
        guard let content = data.contents.first(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "content not found", issues: [])
        }
        return content
    }

    public func version(contentId: EntityID, version: Int) async throws -> ContentVersion {
        if let list = versionHistory[contentId], let match = list.first(where: { $0.version == version }) {
            return match
        }
        guard let found = data.versions[contentId], found.version == version else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "version not found", issues: [])
        }
        return found
    }

    public func versions(contentId: EntityID) async throws -> [ContentVersionSummary] {
        let list = versionHistory[contentId] ?? data.versions[contentId].map { [$0] } ?? []
        return list.sorted { $0.version > $1.version }.map {
            ContentVersionSummary(
                id: $0.id, contentId: $0.contentId, version: $0.version, origin: $0.origin,
                contentHash: $0.contentHash, slideCount: $0.slideCount, note: $0.note,
                jobId: $0.jobId, createdAt: $0.createdAt, updatedAt: $0.updatedAt
            )
        }
    }

    public func plans(brandId: EntityID) async throws -> [Plan] { data.plans.filter { $0.brandId == brandId } }
    public func schedules(brandId: EntityID) async throws -> [Schedule] { data.schedules.filter { $0.brandId == brandId } }

    public func cancelSchedule(_ id: EntityID) async throws -> Schedule {
        guard let index = data.schedules.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "schedule not found", issues: [])
        }
        guard data.schedules[index].status.isActive else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "schedule cannot be cancelled", issues: [])
        }
        data.schedules[index].status = .cancelled
        data.schedules[index].cancelledAt = now
        data.schedules[index].updatedAt = now
        let contentId = data.schedules[index].contentId
        let hasOtherActive = data.schedules.contains { $0.contentId == contentId && $0.status.isActive }
        if !hasOtherActive, let cIdx = data.contents.firstIndex(where: { $0.id == contentId }), data.contents[cIdx].status == .scheduled {
            data.contents[cIdx].status = .approved
            data.contents[cIdx].updatedAt = now
        }
        return data.schedules[index]
    }

    public func scheduleLogs(scheduleId: EntityID) async throws -> [PublishLog] {
        data.publishLogs[scheduleId] ?? []
    }

    public func updateCaption(contentId: EntityID, caption: String) async throws -> Content {
        let updated = try updateContent(contentId) { content in
            content.caption = caption
            if content.status.hasApproval || content.status == .inReview {
                content.status = .draft
                content.approval = nil
            }
        }
        if updated.status == .draft {
            for index in data.schedules.indices where data.schedules[index].contentId == contentId && data.schedules[index].status == .pending {
                data.schedules[index].status = .cancelled
            }
        }
        return updated
    }

    public func approve(contentId: EntityID, hash: String, acknowledgeChecks: Bool) async throws -> Content {
        let content = try await self.content(contentId)
        guard content.status.isApprovable else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "content is \(content.status.rawValue)", issues: [])
        }
        guard let ref = content.currentVersion, ref.contentHash == hash else {
            throw StudioAPIError.server(status: 409, code: .hashMismatch, message: "hash does not match the current version", issues: [])
        }
        // The API's gate (E7): a stored run of this version with blocking results refuses an
        // approval the user did not confirm. (The sample has no worker: an unchecked version passes.)
        if !acknowledgeChecks, let run = checkRuns[contentId]?.first(where: { $0.version == ref.version }), run.blocking > 0 {
            throw StudioAPIError.server(
                status: 409, code: .conflict,
                message: "v\(ref.version) için \(run.blocking) kontrol geçmedi. Sonuçlara bakıp yine de onaylamak istediğinizi belirtin.",
                issues: [])
        }
        if acknowledgeChecks { approvalsDespiteChecks.append(contentId) }
        return try updateContent(contentId) { content in
            content.status = .approved
            content.approval = ContentApproval(versionId: ref.id, contentHash: hash, approvedAt: now)
        }
    }

    public func createSchedule(_ input: ScheduleCreate) async throws -> Schedule {
        let content = try await self.content(input.contentId)
        guard content.status.isSchedulable, let approval = content.approval else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "only approved content can be scheduled", issues: [])
        }
        guard let account = data.accounts.first(where: { $0.id == input.socialAccountId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "account not found", issues: [])
        }
        let schedule = Schedule(
            id: nextId("sch"), contentId: content.id, brandId: content.brandId, platform: account.platform, socialAccountId: account.id,
            versionId: approval.versionId, contentHash: approval.contentHash, scheduledAt: input.scheduledAt, status: .pending,
            createdAt: now, updatedAt: now)
        data.schedules.append(schedule)
        _ = try updateContent(content.id) { $0.status = .scheduled }
        return schedule
    }

    /// Move a pending schedule (calendar drag, "Zamanlamayı değiştir"), like the API.
    public func reschedule(_ scheduleId: EntityID, to date: Date) async throws -> Schedule {
        guard let index = data.schedules.firstIndex(where: { $0.id == scheduleId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "schedule not found", issues: [])
        }
        guard data.schedules[index].status == .pending else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "only pending schedules can be moved", issues: [])
        }
        data.schedules[index].scheduledAt = date
        data.schedules[index].updatedAt = now
        return data.schedules[index]
    }

    public func requestEdit(of content: Content, instructions: String) async throws -> Job {
        let job = Job(
            id: nextId("job"), type: .contentGenerate, status: .queued,
            payload: ["title": .string(content.title), "instructions": .string(instructions)],
            brandId: content.brandId, contentId: content.id, createdAt: now, updatedAt: now)
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    public func fillSlotAndRender(contentId: EntityID, slotId: String, assetId: EntityID) async throws -> Job {
        let newVersion = try fillSlotInternal(contentId: contentId, slotId: slotId, assetId: assetId)
        let item = try await content(contentId)
        let job = Job(
            id: nextId("job"),
            type: .contentRender,
            status: .succeeded,
            payload: ["format": .string("jpeg"), "slotAssignments": .object([slotId: .string(assetId)])],
            brandId: item.brandId,
            contentId: contentId,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            finishedAt: now,
            progress: 1,
            output: ["version": .number(Double(newVersion.version)), "versionId": .string(newVersion.id)]
        )
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    private func fillSlotInternal(contentId: EntityID, slotId: String, assetId: EntityID) throws -> ContentVersion {
        guard let cIndex = data.contents.firstIndex(where: { $0.id == contentId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "content not found", issues: [])
        }
        let baseSlides = data.versions[contentId]?.slides ?? [
            Slide(html: SampleData.slideHTML(title: data.contents[cIndex].title, pillar: "İçerik", emptySlot: true), width: 1080, height: 1350),
        ]
        var slides = baseSlides
        for idx in slides.indices {
            let filledHTML = SlideLayerScanner.fillSlot(inHTML: slides[idx].html, slotId: slotId, assetId: assetId)
            if filledHTML != slides[idx].html || idx == 0 {
                slides[idx].html = filledHTML
                slides[idx].renderedAssetId = assetId
            }
        }
        return storeNewVersion(contentIndex: cIndex, slides: slides, origin: .generated, note: "Görsel yuvası dolduruldu.")
    }

    public func patchLayersAndRender(contentId: EntityID, patches: [SlideLayerPatch]) async throws -> Job {
        guard let cIndex = data.contents.firstIndex(where: { $0.id == contentId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "content not found", issues: [])
        }
        let baseSlides = data.versions[contentId]?.slides ?? [
            Slide(html: SampleData.slideHTML(title: data.contents[cIndex].title, pillar: "İçerik", emptySlot: false), width: 1080, height: 1350),
        ]
        let patchedSlides = SlideLayerScanner.apply(patches: patches, to: baseSlides)
        let newVersion = storeNewVersion(contentIndex: cIndex, slides: patchedSlides, origin: .manualEdit, note: "Katmanlar güncellendi.")
        let brandId = data.contents[cIndex].brandId
        let job = Job(
            id: nextId("job"),
            type: .contentRender,
            status: .succeeded,
            payload: ["format": .string("jpeg"), "patches": .array(patches.map { .object($0.toJSONObject()) })],
            brandId: brandId,
            contentId: contentId,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            finishedAt: now,
            progress: 1,
            output: ["version": .number(Double(newVersion.version)), "versionId": .string(newVersion.id)]
        )
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    public func exportContent(contentId: EntityID, format: String) async throws -> Job {
        let item = try await content(contentId)
        var output: JSONObject = ["format": .string(format)]
        if format == "pdf" || format == "both" {
            let pdfBytes = Self.samplePDF(title: item.title)
            let pdfAsset = Asset(
                id: nextId("pdf"), brandId: item.brandId, kind: .document, source: .generated,
                objectKey: "brands/\(item.brandId)/exports/\(item.id).pdf", mimeType: "application/pdf",
                bytes: pdfBytes.count, sha256: String(repeating: "b", count: 64), width: 1080, height: 1350,
                originalFilename: "\(Brand.slugify(item.title))-carousel.pdf", createdAt: now
            )
            data.assets[pdfAsset.id] = pdfAsset
            uploads[pdfAsset.id] = pdfBytes
            output["pdfAssetId"] = .string(pdfAsset.id)
        }
        if format == "jpeg" || format == "both" {
            let png = SampleImages.png(seed: item.id) ?? Data([0x89, 0x50, 0x4E, 0x47])
            let imgAsset = Asset(
                id: nextId("jpg"), brandId: item.brandId, kind: .image, source: .generated,
                objectKey: "brands/\(item.brandId)/exports/\(item.id).jpg", mimeType: "image/jpeg",
                bytes: png.count, sha256: String(repeating: "c", count: 64), width: 1080, height: 1350,
                originalFilename: "\(Brand.slugify(item.title)).jpg", createdAt: now
            )
            data.assets[imgAsset.id] = imgAsset
            uploads[imgAsset.id] = png
            output["jpegAssetIds"] = .array([.string(imgAsset.id)])
        }
        let job = Job(
            id: nextId("job"), type: .contentRender, status: .succeeded,
            payload: ["format": .string(format)], brandId: item.brandId, contentId: contentId,
            createdAt: now, updatedAt: now, startedAt: now, finishedAt: now, progress: 1, output: output
        )
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    // MARK: - Post editor (delete, duplicate, restore, render with design patches, AI revision)

    public func deleteContent(_ id: EntityID) async throws {
        let item = try await content(id)
        guard ![ContentStatus.scheduled, .publishing, .published].contains(item.status) else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "content is \(item.status.rawValue) and cannot be deleted", issues: [])
        }
        data.contents.removeAll { $0.id == id }
        data.versions[id] = nil
        versionHistory[id] = nil
    }

    public func duplicateContent(_ id: EntityID) async throws -> Content {
        let source = try await content(id)
        var copy = source
        copy.id = nextId("post")
        copy.title = String("\(source.title) (kopya)".prefix(200))
        copy.status = .draft
        copy.approval = nil
        copy.currentVersion = nil
        copy.createdAt = now
        copy.updatedAt = now
        data.contents.append(copy)
        if let ref = source.currentVersion, let base = try? await version(contentId: id, version: ref.version) {
            let index = data.contents.count - 1
            _ = storeNewVersion(contentIndex: index, slides: base.slides, origin: base.origin, note: "\"\(source.title)\" v\(base.version) kopyası.")
        }
        return data.contents.last ?? copy
    }

    public func restoreVersion(contentId: EntityID, version number: Int) async throws -> ContentVersion {
        let item = try await content(contentId)
        guard item.status != .publishing, item.status != .published,
              let index = data.contents.firstIndex(where: { $0.id == contentId }) else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "content is \(item.status.rawValue)", issues: [])
        }
        let source = try await version(contentId: contentId, version: number)
        return storeNewVersion(contentIndex: index, slides: source.slides, origin: .manualEdit, note: "v\(number) geri yüklendi.")
    }

    public func render(contentId: EntityID, _ request: ContentRenderRequest) async throws -> Job {
        let item = try await content(contentId)
        guard let index = data.contents.firstIndex(where: { $0.id == contentId }), let ref = item.currentVersion else {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "nothing to render", issues: [])
        }
        let base = try await version(contentId: contentId, version: request.version ?? ref.version)
        var target = base
        var output: JSONObject = ["contentId": .string(contentId)]
        if !request.patches.isEmpty || !request.slotAssignments.isEmpty {
            var slides = SlideLayerScanner.apply(designPatches: request.patches, to: base.slides)
            for (slotId, assetId) in request.slotAssignments {
                let src = DesignPatch.mediaSource(assetId: assetId, mimeType: data.assets[assetId]?.mimeType)
                for i in slides.indices {
                    slides[i].html = SlideLayerScanner.apply(designPatch: DesignPatch(slide: i, .fillSlot(layer: slotId, src: src)), toHTML: slides[i].html)
                }
            }
            let changed = slides.indices.filter { slides[$0].html != base.slides[$0].html }
            if changed.isEmpty {
                output["unchanged"] = .bool(true)
            } else {
                for i in changed {
                    slides[i].renderedAssetId = registerGeneratedImage(brandId: item.brandId, name: "\(Brand.slugify(item.title))-\(i + 1).jpg")
                    slides[i].layers = Self.sampleLayout(html: slides[i].html, width: slides[i].width, height: slides[i].height)
                }
                target = storeNewVersion(contentIndex: index, slides: slides, origin: .manualEdit, note: request.note ?? "\(request.patches.count) katman yaması uygulandı (v\(base.version) üzerine).")
                output["renderedSlides"] = .array(changed.map { .number(Double($0)) })
            }
        } else if request.format == .jpeg || request.format == .both {
            var slides = base.slides
            for i in slides.indices where request.force || slides[i].renderedAssetId == nil || slides[i].layers == nil {
                slides[i].renderedAssetId = slides[i].renderedAssetId ?? registerGeneratedImage(brandId: item.brandId, name: "\(Brand.slugify(item.title))-\(i + 1).jpg")
                slides[i].layers = Self.sampleLayout(html: slides[i].html, width: slides[i].width, height: slides[i].height)
            }
            target.slides = slides
            if var list = versionHistory[contentId], let at = list.firstIndex(where: { $0.version == base.version }) {
                list[at] = target
                versionHistory[contentId] = list
            }
            if data.versions[contentId]?.version == base.version { data.versions[contentId] = target }
        }
        if request.format == .png {
            let wanted = Set(request.slides ?? Array(target.slides.indices))
            output["pngAssetIds"] = .array(target.slides.indices.map { i in
                wanted.contains(i) ? .string(registerGeneratedImage(brandId: item.brandId, name: "\(Brand.slugify(item.title))-\(i + 1).png", mimeType: "image/png")) : .null
            })
        }
        if request.format == .pdf || request.format == .both {
            let pdfBytes = Self.samplePDF(title: item.title)
            let pdfId = nextId("pdf")
            data.assets[pdfId] = Asset(
                id: pdfId, brandId: item.brandId, kind: .document, source: .generated,
                objectKey: "brands/\(item.brandId)/exports/\(pdfId).pdf", mimeType: "application/pdf",
                bytes: pdfBytes.count, sha256: String(repeating: "b", count: 64), width: 1080, height: 1350,
                originalFilename: "\(Brand.slugify(item.title)).pdf", createdAt: now)
            uploads[pdfId] = pdfBytes
            output["pdfAssetId"] = .string(pdfId)
        }
        output["version"] = .number(Double(target.version))
        output["versionId"] = .string(target.id)
        output["renderedAssetIds"] = .array(target.slides.map { $0.renderedAssetId.map(JSONValue.string) ?? .null })
        let job = Job(
            id: nextId("job"), type: .contentRender, status: .succeeded, payload: request.payload,
            brandId: item.brandId, contentId: contentId, createdAt: now, updatedAt: now,
            startedAt: now, finishedAt: now, progress: 1, output: output)
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    public func requestRevision(of content: Content, baseVersion requestedBase: Int?, instructions: String) async throws -> Job {
        guard let index = data.contents.firstIndex(where: { $0.id == content.id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "content not found", issues: [])
        }
        guard let baseVersion = requestedBase ?? data.contents[index].currentVersion?.version else {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "content has no version", issues: [])
        }
        let base = try await version(contentId: content.id, version: baseVersion)
        var slides = base.slides
        for i in slides.indices {
            slides[i].html = slides[i].html.replacingOccurrences(of: "</body>", with: "<!-- AI: \(instructions.prefix(60)) --></body>")
            slides[i].renderedAssetId = registerGeneratedImage(brandId: content.brandId, name: "\(Brand.slugify(content.title))-ai-\(i + 1).jpg")
            slides[i].layers = Self.sampleLayout(html: slides[i].html, width: slides[i].width, height: slides[i].height)
        }
        let created = storeNewVersion(contentIndex: index, slides: slides, origin: .aiEdit, note: "AI düzenleme (v\(baseVersion) üzerine): \(instructions)")
        let job = Job(
            id: nextId("job"), type: .contentGenerate, status: .succeeded,
            payload: requestedBase.map { ["title": .string(content.title), "instructions": .string(instructions), "baseVersion": .number(Double($0))] }
                ?? ["title": .string(content.title), "instructions": .string(instructions)],
            brandId: content.brandId, contentId: content.id, createdAt: now, updatedAt: now,
            startedAt: now, finishedAt: now, progress: 1,
            output: ["version": .number(Double(created.version)), "versionId": .string(created.id), "revised": .bool(true)])
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    /// Ends a chat run as if the Mac's agent had answered (tests, previews): the run and its
    /// `chat.turn` job finish.
    public func finishRun(_ runId: EntityID) {
        guard let index = data.runs.firstIndex(where: { $0.id == runId }) else { return }
        data.runs[index].status = .completed
        data.runs[index].finishedAt = now
        if let jobId = data.runs[index].jobId, let jobIndex = data.jobs.firstIndex(where: { $0.id == jobId }) {
            data.jobs[jobIndex].status = .succeeded
            data.jobs[jobIndex].finishedAt = now
        }
        let conversationId = data.runs[index].conversationId
        if let c = data.conversations.firstIndex(where: { $0.id == conversationId }) { data.conversations[c].activeRunId = nil }
        broadcast(conversationId)
        broadcastJobs()
    }

    /// Adds a version as if the Mac had saved one (a canvas save in tests and previews).
    @discardableResult
    public func storeVersion(contentId: EntityID, slides: [Slide], origin: ContentVersionOrigin = .manualEdit, note: String? = nil) throws -> ContentVersion {
        guard let index = data.contents.firstIndex(where: { $0.id == contentId }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "content not found", issues: [])
        }
        return storeNewVersion(contentIndex: index, slides: slides, origin: origin, note: note)
    }

    // MARK: - Production checks

    public func latestCheckRun(contentId: EntityID, version: Int) async throws -> ContentCheckRun? {
        checkRuns[contentId]?.first { $0.version == version }
    }

    /// Stores a run as if the worker had checked the version (tests, previews).
    public func storeCheckRun(_ run: ContentCheckRun) {
        checkRuns[run.contentId, default: []].insert(run, at: 0)
    }

    /// The sample has no worker: the checks "run" at once and pass.
    public func runChecks(contentId: EntityID, brandId: EntityID, version: Int) async throws -> Job {
        let results = ["brief.completeness", "layout.overflow", "layout.contrast", "text.caption-length"].map { id in
            ContentCheckResult(checkId: id, category: CheckCategory(rawValue: String(id.prefix { $0 != "." })) ?? .unknown, status: .pass, message: "")
        }
        let job = Job(
            id: nextId("job"), type: .contentCheck, status: .succeeded, payload: ["version": .number(Double(version))],
            brandId: brandId, contentId: contentId, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now, progress: 1)
        storeCheckRun(ContentCheckRun(id: nextId("check"), contentId: contentId, brandId: brandId, version: version, jobId: job.id, results: results, createdAt: now))
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
    }

    private func registerGeneratedImage(brandId: EntityID, name: String, mimeType: String = "image/jpeg") -> EntityID {
        let id = nextId("render")
        data.assets[id] = Asset(
            id: id, brandId: brandId, kind: .image, source: .generated,
            objectKey: "brands/\(brandId)/assets/\(id)", mimeType: mimeType, bytes: 1,
            sha256: String(repeating: "d", count: 64), width: 1080, height: 1350,
            originalFilename: name, createdAt: now)
        return id
    }

    /// Plausible layer boxes for the sample: inline `left/top/width/height` when the layer
    /// declares them, else stacked text bands from the top margin.
    static func sampleLayout(html: String, width: Int, height: Int) -> [SlideLayerBox] {
        var nextTop = 72.0
        return SlideLayerScanner.layers(inHTML: html).map { layer in
            let style = (layer.style ?? "").lowercased().replacingOccurrences(of: " ", with: "")
            func value(_ key: String) -> Double? {
                guard let range = style.range(of: "\(key):") else { return nil }
                let rest = style[range.upperBound...]
                let number = rest.prefix { $0.isNumber || $0 == "." || $0 == "-" }
                return Double(number)
            }
            let t = layer.transform
            var box = CGRect(x: value("left") ?? 72, y: value("top") ?? nextTop, width: value("width") ?? Double(width) - 144, height: value("height") ?? 96)
            if value("top") == nil { nextTop += box.height + 24 }
            let k = t.scale
            box = CGRect(x: box.midX + t.translate.x - box.width * k / 2, y: box.midY + t.translate.y - box.height * k / 2, width: box.width * k, height: box.height * k)
            return SlideLayerBox(
                id: layer.layerId, type: layer.kind == .other ? "" : layer.kind.rawValue, role: layer.role, parent: nil,
                x: box.minX, y: box.minY, w: box.width, h: box.height, visible: !layer.isHidden)
        }
    }

    private func storeNewVersion(contentIndex: Int, slides: [Slide], origin: ContentVersionOrigin, note: String?) -> ContentVersion {
        let contentId = data.contents[contentIndex].id
        var list = versionHistory[contentId] ?? data.versions[contentId].map { [$0] } ?? []
        let nextVerNum = (list.map(\.version).max() ?? 0) + 1
        let hash = ContentHash.compute(slides)
        let created = ContentVersion(
            id: "\(contentId)-v\(nextVerNum)",
            contentId: contentId,
            version: nextVerNum,
            origin: origin,
            contentHash: hash,
            note: note,
            createdAt: now,
            updatedAt: now,
            slides: slides
        )
        list.append(created)
        versionHistory[contentId] = list
        data.versions[contentId] = created
        data.contents[contentIndex].currentVersion = ContentVersionRef(id: created.id, version: nextVerNum, contentHash: hash)
        data.contents[contentIndex].status = .draft
        data.contents[contentIndex].approval = nil
        data.contents[contentIndex].updatedAt = now
        for sIdx in data.schedules.indices where data.schedules[sIdx].contentId == contentId && data.schedules[sIdx].status == .pending {
            data.schedules[sIdx].status = .cancelled
            data.schedules[sIdx].cancelledAt = now
        }
        return created
    }

    private static func samplePDF(title: String) -> Data {
        let safeTitle = title.replacingOccurrences(of: "(", with: "").replacingOccurrences(of: ")", with: "")
        let pdf = """
        %PDF-1.4
        1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
        2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
        3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 1080 1350] /Contents 4 0 R >> endobj
        4 0 obj << /Length 44 >> stream
        BT /F1 24 Tf 72 1200 Td (\(safeTitle.prefix(24))) Tj ET
        endstream endobj
        xref
        0 5
        0000000000 65535 f 
        0000000009 00000 n 
        0000000058 00000 n 
        0000000115 00000 n 
        0000000206 00000 n 
        trailer << /Size 5 /Root 1 0 R >>
        startxref
        301
        %%EOF
        """
        return Data(pdf.utf8)
    }

    private func updateContent(_ id: EntityID, _ change: (inout Content) -> Void) throws -> Content {
        guard let index = data.contents.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "content not found", issues: [])
        }
        change(&data.contents[index])
        data.contents[index].updatedAt = now
        return data.contents[index]
    }

    public func imageData(assetId: EntityID) async throws -> Data {
        if let upload = uploads[assetId] { return upload }
        if let asset = data.assets[assetId], asset.kind == .document {
            return Self.samplePDF(title: asset.originalFilename ?? assetId)
        }
        guard data.assets[assetId] != nil, let png = SampleImages.png(seed: assetId) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "asset not found", issues: [])
        }
        return png
    }

    public func presence() async throws -> WorkerPresence { data.presence }

    public func claudeControl() async throws -> ClaudeControl {
        ClaudeControl(account: data.presence.claude, online: data.presence.online, sent: 0)
    }

    public func claudeLogin() async throws -> ClaudeControl {
        data.presence.claude = ClaudeAccount(
            status: .signedIn,
            email: data.presence.claude?.email ?? "burak@burakkoc.net",
            plan: data.presence.claude?.plan ?? "Claude Max",
            cliVersion: data.presence.claude?.cliVersion ?? "1.0.24",
            detail: "Giriş yapıldı · Claude Max",
            displayName: data.presence.claude?.displayName ?? "Burak",
            checkedAt: now
        )
        broadcastJobs()
        return ClaudeControl(account: data.presence.claude, online: data.presence.online, sent: data.presence.online ? 1 : 0)
    }

    public func claudeRefresh() async throws -> ClaudeControl {
        if var account = data.presence.claude {
            account.checkedAt = now
            data.presence.claude = account
        }
        broadcastJobs()
        return ClaudeControl(account: data.presence.claude, online: data.presence.online, sent: data.presence.online ? 1 : 0)
    }

    public func geminiControl() async throws -> GeminiControl {
        GeminiControl(account: data.presence.gemini, online: data.presence.online, sent: 0)
    }

    public func geminiRefresh() async throws -> GeminiControl {
        if var account = data.presence.gemini {
            account.checkedAt = now
            data.presence.gemini = account
        }
        broadcastJobs()
        return GeminiControl(account: data.presence.gemini, online: data.presence.online, sent: data.presence.online ? 1 : 0)
    }

    public func job(_ id: EntityID) async throws -> Job {
        guard let found = data.jobs.first(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "job \(id) not found", issues: [])
        }
        return found
    }

    public func jobs(brandId: EntityID?) async throws -> [Job] {
        data.jobs.filter { brandId == nil || $0.brandId == brandId }
    }

    public nonisolated func jobFeed() -> AsyncStream<JobFeedEvent> {
        AsyncStream { continuation in
            let token = UUID()
            Task { await self.addJobObserver(token, continuation) }
            continuation.onTermination = { _ in Task { await self.removeJobObserver(token) } }
        }
    }

    private func addJobObserver(_ token: UUID, _ continuation: AsyncStream<JobFeedEvent>.Continuation) {
        jobObservers[token] = continuation
        continuation.yield(.state(.live))
        continuation.yield(.message(.snapshot(jobs: data.jobs, presence: data.presence)))
    }

    private func removeJobObserver(_ token: UUID) { jobObservers[token] = nil }

    private func broadcastJobs() {
        for continuation in jobObservers.values {
            continuation.yield(.message(.snapshot(jobs: data.jobs, presence: data.presence)))
        }
    }

    public func cancelJob(_ id: EntityID) async throws -> Job {
        guard let index = data.jobs.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "job not found", issues: [])
        }
        data.jobs[index].status = .cancelled
        data.jobs[index].finishedAt = now
        broadcastJobs()
        return data.jobs[index]
    }
}

/// Grayscale placeholder photographs for sample attachments (no files shipped).
public enum SampleImages {
    public static func png(seed: String, width: Int = 540, height: Int = 675) -> Data? {
        var hash: UInt64 = 1469598103934665603
        for byte in seed.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        let horizon = 0.35 + Double(hash % 30) / 100
        guard let space = CGColorSpace(name: CGColorSpace.genericGrayGamma2_2),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return nil }
        // Sky
        context.setFillColor(gray: 0.86, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        // Field rows
        let fieldTop = Double(height) * (1 - horizon)
        context.setFillColor(gray: 0.42, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: Double(width), height: fieldTop))
        context.setStrokeColor(gray: 0.32, alpha: 1)
        context.setLineWidth(6)
        for i in 0..<14 {
            let x = Double(width) / 2 + Double(i - 7) * 90
            context.move(to: CGPoint(x: Double(width) / 2, y: fieldTop))
            context.addLine(to: CGPoint(x: x * 2.2 - Double(width) * 0.6, y: 0))
        }
        context.strokePath()
        // Sun
        context.setFillColor(gray: 0.97, alpha: 1)
        let sun = Double(width) * 0.2
        let sunX = Double(hash % UInt64(max(1, width - Int(sun * 1.5)))) + sun * 0.25
        context.fillEllipse(in: CGRect(x: sunX, y: fieldTop + Double(height) * 0.12, width: sun, height: sun))
        guard let image = context.makeImage() else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
