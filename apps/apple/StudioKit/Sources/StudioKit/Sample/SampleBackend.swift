import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// In-memory implementation of both services over `SampleData`.
///
/// Behaves like the real API without a Mac worker: sending a message stores
/// it and starts a run that stays `queued`; accepting a plan creates draft
/// posts and queued generation jobs; uploads are kept in memory. Only for
/// previews, tests and screenshot renders.
public actor SampleBackend: ConversationService, StudioDataService {
    private var data: SampleData
    private var uploads: [EntityID: Data] = [:]
    private var observers: [EntityID: [UUID: AsyncStream<ConversationFeedEvent>.Continuation]] = [:]
    private var jobObservers: [UUID: AsyncStream<JobFeedEvent>.Continuation] = [:]
    private var seqs: [EntityID: Int] = [:]
    private var counter = 0
    /// Simulated upload duration per image (0 in tests).
    private let uploadDelay: Duration

    public init(data: SampleData = SampleData(), uploadDelay: Duration = .milliseconds(600)) {
        self.data = data
        self.uploadDelay = uploadDelay
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
        // Aliases: same rules as the server (requested name if free, else the next free automatic one).
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
        let run = AgentRun(
            id: nextId("run"), conversationId: conversationId, triggerMessageId: stored.id, jobId: nextId("job"), status: .queued,
            model: message.model?.sendable?.rawValue, effort: message.effort?.sendable, createdAt: now, updatedAt: now)
        data.messages[conversationId, default: []].append(stored)
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

    public func uploadImage(_ file: UploadFile, brandId: EntityID, progress: @escaping @Sendable (Double) -> Void) async throws -> Asset {
        let steps = 5
        for step in 1...steps {
            if uploadDelay > .zero { try await Task.sleep(for: uploadDelay / steps) }
            progress(Double(step) / Double(steps) * 0.97)
        }
        let asset = Asset(
            id: nextId("asset"), brandId: brandId, kind: .image, source: .upload, objectKey: "sample", mimeType: file.mimeType,
            bytes: file.data.count, sha256: String(repeating: "0", count: 64), width: file.width, height: file.height,
            originalFilename: file.filename, createdAt: now)
        data.assets[asset.id] = asset
        uploads[asset.id] = file.data
        progress(1)
        return asset
    }

    // MARK: - StudioDataService

    public func brands() async throws -> [Brand] { data.brands }

    public func socialAccounts(brandId: EntityID?) async throws -> [SocialAccount] {
        data.accounts.filter { brandId == nil || $0.brandId == brandId }
    }

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
        guard let found = data.versions[contentId], found.version == version else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "version not found", issues: [])
        }
        return found
    }

    public func plans(brandId: EntityID) async throws -> [Plan] { data.plans.filter { $0.brandId == brandId } }
    public func schedules(brandId: EntityID) async throws -> [Schedule] { data.schedules.filter { $0.brandId == brandId } }

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

    public func approve(contentId: EntityID, hash: String) async throws -> Content {
        let content = try await self.content(contentId)
        guard content.status.isApprovable else {
            throw StudioAPIError.server(status: 409, code: .invalidTransition, message: "content is \(content.status.rawValue)", issues: [])
        }
        guard let ref = content.currentVersion, ref.contentHash == hash else {
            throw StudioAPIError.server(status: 409, code: .hashMismatch, message: "hash does not match the current version", issues: [])
        }
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

    public func requestEdit(of content: Content, instructions: String) async throws -> Job {
        let job = Job(
            id: nextId("job"), type: .contentGenerate, status: .queued,
            payload: ["title": .string(content.title), "instructions": .string(instructions)],
            brandId: content.brandId, contentId: content.id, createdAt: now, updatedAt: now)
        data.jobs.insert(job, at: 0)
        broadcastJobs()
        return job
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
        guard data.assets[assetId] != nil, let png = SampleImages.png(seed: assetId) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "asset not found", issues: [])
        }
        return png
    }

    public func presence() async throws -> WorkerPresence { data.presence }

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
