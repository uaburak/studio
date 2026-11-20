import Foundation
import Observation
import StudioKit
import UIKit

/// The message composer: text with `@alias` mentions and image attachments that upload
/// right away (with progress), keep an alias, and can be renamed, retried or removed.
@MainActor
@Observable
final class IOSComposerModel {
    struct Draft: Identifiable, Equatable {
        enum State: Equatable {
            /// A video being checked / exported to fit the Mac's limit (N21).
            case preparing(Double)
            case uploading(Double)
            case uploaded(Asset)
            case failed(String)
        }

        let id = UUID()
        var alias: String
        var thumbnail: UIImage
        var file: UploadFile
        var state: State
        /// The picked video's copy (prepared before the upload; deleted after).
        var videoSource: URL?
        /// `file` is the prepared video (as it is, or exported to fit).
        var videoPrepared = false

        var asset: Asset? {
            if case .uploaded(let asset) = state { return asset }
            return nil
        }

        var isUploading: Bool {
            switch state {
            case .uploading, .preparing: true
            case .uploaded, .failed: false
            }
        }

        var isVideo: Bool { videoSource != nil || file.isVideo }

        static func == (a: Draft, b: Draft) -> Bool {
            a.id == b.id && a.alias == b.alias && a.state == b.state && a.thumbnail === b.thumbnail
        }
    }

    var text: String = "" {
        didSet { if text != oldValue { updateSuggestions() } }
    }
    /// Caret (UTF-16) reported by the text view.
    var caret: Int = 0 {
        didSet { if caret != oldValue { updateSuggestions() } }
    }
    var drafts: [Draft] = []
    var placeholder = "Mesaj yaz…"
    /// Why attaching is impossible right now (no brand).
    var attachDisabledReason: String?
    var error: String?
    private(set) var conversationAliases: [ConversationAlias] = []
    /// The brand's products and posts (`@venta-boro`); file aliases win over the same name.
    var entityCandidates: [EntityMentionCandidate] = [] {
        didSet { if entityCandidates != oldValue { updateSuggestions() } }
    }
    private(set) var suggestions: [MentionCandidate] = []
    private(set) var queryStart: Int?

    @ObservationIgnored var uploader: ((UploadFile, @escaping @Sendable (Double) -> Void) async throws -> Asset)?
    @ObservationIgnored var onUploaded: ((Asset, UIImage) -> Void)?
    @ObservationIgnored private var allocator = AliasAllocator()
    @ObservationIgnored private var uploads: [UUID: Task<Void, Never>] = [:]

    // MARK: Aliases

    func updateConversationAliases(_ aliases: [ConversationAlias]) {
        guard aliases != conversationAliases else { return }
        conversationAliases = aliases
        var next = AliasAllocator(aliases: aliases)
        let now = Date()
        for draft in drafts {
            next.register([ConversationAlias(id: "draft", conversationId: "", alias: draft.alias, assetId: "", mimeType: "", createdAt: now, updatedAt: now)])
        }
        while next.nextIndex < allocator.nextIndex { _ = next.next() }
        allocator = next
        updateSuggestions()
    }

    // MARK: Attachments

    var canAttach: Bool { uploader != nil && attachDisabledReason == nil }

    func add(_ images: [UIImage]) {
        guard let uploader, attachDisabledReason == nil else {
            error = attachDisabledReason ?? "Görsel eklemek için önce bir marka seç."
            return
        }
        error = nil
        for (index, image) in images.prefix(10 - drafts.count).enumerated() {
            do {
                let imported = try IOSImageImport.from(image: image, filename: "gorsel-\(index + 1).jpg")
                let draft = Draft(alias: allocator.next(), thumbnail: imported.thumbnail, file: imported.file, state: .uploading(0))
                drafts.append(draft)
                startUpload(draft.id, uploader: uploader)
            } catch {
                self.error = IOSAppModel.describe(error)
            }
        }
        if images.count + drafts.count > 10 { error = "Bir mesajda en fazla 10 görsel olabilir." }
        updateSuggestions()
    }

    /// Videos from Photos, the camera or Files (N21): checked and, when they do not fit the Mac's
    /// 50 MB limit, exported again on the phone, then uploaded like pictures.
    func add(videos: [URL]) {
        guard let uploader, attachDisabledReason == nil else {
            error = attachDisabledReason ?? "Video eklemek için önce bir marka seç."
            videos.forEach(MediaPicking.discard)
            return
        }
        error = nil
        let room = max(0, 10 - drafts.count)
        for url in videos.dropFirst(room) { MediaPicking.discard(url) }
        for url in videos.prefix(room) {
            var draft = Draft(
                alias: allocator.next(), thumbnail: UIImage(systemName: "video") ?? UIImage(),
                file: UploadFile(filename: url.lastPathComponent, mimeType: "video/quicktime", fileURL: url), state: .preparing(0))
            draft.videoSource = url
            drafts.append(draft)
            let id = draft.id
            Task { [weak self] in
                guard let image = await VideoThumbnail.make(url), let self, let index = self.drafts.firstIndex(where: { $0.id == id }) else { return }
                self.drafts[index].thumbnail = image
            }
            prepareVideo(id, uploader: uploader)
        }
        if videos.count > room { error = "Bir mesajda en fazla 10 ek olabilir." }
        updateSuggestions()
    }

    private func prepareVideo(_ id: UUID, uploader: @escaping (UploadFile, @escaping @Sendable (Double) -> Void) async throws -> Asset) {
        guard let source = drafts.first(where: { $0.id == id })?.videoSource else { return }
        uploads[id]?.cancel()
        uploads[id] = Task { [weak self] in
            do {
                let prepared = try await VideoPreparation.prepare(source, workDirectory: source.deletingLastPathComponent()) { progress in
                    Task { @MainActor in self?.setState(id, .preparing(progress)) }
                }
                guard let self, let index = self.drafts.firstIndex(where: { $0.id == id }) else { return }
                self.drafts[index].file = prepared.file
                self.drafts[index].videoPrepared = true
                self.drafts[index].state = .uploading(0)
                self.startUpload(id, uploader: uploader)
            } catch is CancellationError {
                return
            } catch {
                self?.setState(id, .failed(IOSAppModel.describe(error)))
            }
        }
    }

    private func startUpload(_ id: UUID, uploader: @escaping (UploadFile, @escaping @Sendable (Double) -> Void) async throws -> Asset) {
        guard let draft = drafts.first(where: { $0.id == id }) else { return }
        let file = draft.file
        let source = draft.videoSource
        uploads[id]?.cancel()
        uploads[id] = Task { [weak self] in
            do {
                let asset = try await uploader(file) { [weak self] progress in
                    Task { @MainActor in self?.setState(id, .uploading(progress)) }
                }
                let thumbnail = self?.drafts.first { $0.id == id }?.thumbnail
                if let thumbnail { self?.onUploaded?(asset, thumbnail) }
                self?.setState(id, .uploaded(asset))
                if let source { MediaPicking.discard(source) }
            } catch is CancellationError {
                return
            } catch {
                self?.setState(id, .failed(IOSAppModel.describe(error)))
            }
        }
    }

    private func setState(_ id: UUID, _ state: Draft.State) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        switch (state, drafts[index].state) {
        case (.uploading, .uploaded), (.preparing, .uploaded), (.preparing, .uploading), (.preparing, .failed), (.uploading, .failed):
            return
        default:
            drafts[index].state = state
        }
    }

    func retry(_ id: UUID) {
        guard let uploader, let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        // A video that never got ready is prepared again.
        if drafts[index].videoSource != nil, !drafts[index].videoPrepared {
            drafts[index].state = .preparing(0)
            prepareVideo(id, uploader: uploader)
            return
        }
        drafts[index].state = .uploading(0)
        startUpload(id, uploader: uploader)
    }

    func remove(_ id: UUID) {
        uploads[id]?.cancel()
        uploads[id] = nil
        if let draft = drafts.first(where: { $0.id == id }) {
            allocator.release(draft.alias)
            if let source = draft.videoSource { MediaPicking.discard(source) }
        }
        drafts.removeAll { $0.id == id }
        updateSuggestions()
    }

    /// Rename a draft's alias. Returns a Turkish error, or nil on success.
    @discardableResult
    func rename(_ id: UUID, to input: String) -> String? {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return nil }
        let name = ImageAlias.normalize(input)
        let old = drafts[index].alias
        if name == old { return nil }
        do {
            try allocator.rename(old, to: name)
        } catch .invalid {
            return "Küçük harf, rakam ve tire kullan; harfle başlasın."
        } catch {
            return "“\(name)” bu sohbette kullanılmış."
        }
        drafts[index].alias = name
        text = text.replacingOccurrences(of: "@\(old)", with: "@\(name)")
        updateSuggestions()
        return nil
    }

    var isUploading: Bool { drafts.contains(where: \.isUploading) }
    var hasFailedUploads: Bool { drafts.contains { if case .failed = $0.state { true } else { false } } }
    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && drafts.isEmpty }
    var canSend: Bool { !isEmpty && !isUploading && !hasFailedUploads }

    var sendBlockedReason: String? {
        if isUploading { return "Görseller yükleniyor…" }
        if hasFailedUploads { return "Yüklenemeyen görseli yeniden dene ya da kaldır." }
        return nil
    }

    func makeMessage() -> OutgoingMessage {
        OutgoingMessage(text: text, attachments: drafts.compactMap { draft in
            draft.asset.map { OutgoingAttachment(assetId: $0.id, alias: draft.alias) }
        })
    }

    func reset() {
        uploads.values.forEach { $0.cancel() }
        uploads = [:]
        drafts = []
        error = nil
        text = ""
        caret = 0
    }

    // MARK: Mentions

    var candidates: [MentionCandidate] {
        let files = conversationAliases.map { MentionCandidate(alias: $0.alias, assetId: $0.assetId, isDraft: false) }
            + drafts.map { MentionCandidate(alias: $0.alias, assetId: $0.asset?.id, isDraft: true) }
        return MentionText.merge(aliases: files, entities: entityCandidates)
    }

    func draft(alias: String) -> Draft? { drafts.first { $0.alias == alias } }

    private func updateSuggestions() {
        guard let (start, query) = MentionText.activeQuery(in: text, cursor: min(caret, (text as NSString).length)) else {
            suggestions = []
            queryStart = nil
            return
        }
        let filtered = MentionText.suggestions(candidates, query: query)
        suggestions = filtered
        queryStart = filtered.isEmpty ? nil : start
    }

    var isSuggesting: Bool { !suggestions.isEmpty && queryStart != nil }

    /// Put `@alias ` in place of the query being typed; returns the new caret.
    @discardableResult
    func choose(_ candidate: MentionCandidate) -> Int {
        guard let start = queryStart else { return caret }
        let result = MentionText.insert(alias: candidate.alias, into: text, queryStart: start, cursor: caret)
        text = result.text
        caret = result.cursor
        suggestions = []
        queryStart = nil
        return result.cursor
    }

    /// Append `@alias ` at the end (draft chip "Metne ekle").
    func appendMention(_ alias: String) {
        let prefix = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " "
        text += "\(prefix)@\(alias) "
        caret = (text as NSString).length
    }
}

/// One conversation (or a new chat that becomes one with its first message): live state
/// from the stream, the composer, and the actions on cards.
@MainActor
@Observable
final class IOSConversationModel {
    private(set) var id: EntityID?
    unowned let app: IOSAppModel
    private(set) var state: ConversationState?
    private(set) var live: LiveState = .connecting(attempt: 1)
    let composer = IOSComposerModel()
    var isSending = false
    var error: String?
    var busyPlans: Set<EntityID> = []
    var expandedPlans: Set<EntityID> = []
    /// What the last generation round left alone ("2 post atlandı: …"), per plan.
    var planNotes: [EntityID: String] = [:]
    /// Tool-step groups the user opened ("message id:group index").
    var expandedSteps: Set<String> = []
    var busyQuestions: Set<String> = []
    var busyConsents: Set<String> = []
    /// Options picked on a multiple-choice question before sending (message id + question id).
    var questionSelections: [String: Set<String>] = [:]
    var selection: AgentSelection {
        didSet { if selection != oldValue { app.saveSelection(selection, for: id) } }
    }
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    /// A post's own chat (opened from the post): every message starts with the post's line, as
    /// the Mac's post chat writes it (`postReference`), so the agent knows which post it means.
    @ObservationIgnored var messagePrefix: (() -> String)?
    /// For a post's chat not made yet: its title, its brand, its placeholder, and who learns its id.
    @ObservationIgnored var newConversationTitle: String?
    @ObservationIgnored var newConversationBrandId: EntityID?
    @ObservationIgnored var placeholderOverride: String?
    @ObservationIgnored var onCreated: ((EntityID) -> Void)?

    init(id: EntityID?, app: IOSAppModel) {
        self.id = id
        self.app = app
        self.selection = app.selection(for: id)
        composer.uploader = { [weak self] file, progress in
            guard let self else { throw CancellationError() }
            guard let brandId = self.brandId else { throw StudioAPIError.invalidConfiguration("Görsel eklemek için önce bir marka seç.") }
            return try await self.app.conversationService.uploadImage(file, brandId: brandId, progress: progress)
        }
        composer.onUploaded = { [weak app] asset, thumbnail in app?.images.seed(thumbnail, for: asset.id) }
        refreshComposerState()
    }

    var isNew: Bool { id == nil }

    var brandId: EntityID? {
        if let id { return state?.conversation.brandId ?? app.conversations.first { $0.id == id }?.brandId }
        return app.currentBrandId
    }

    var title: String {
        if let state { return state.conversation.displayTitle }
        if let id, let conv = app.conversations.first(where: { $0.id == id }) { return conv.displayTitle }
        return "Yeni sohbet"
    }

    var messages: [Message] { state?.messages ?? [] }
    var activeRun: AgentRun? { state?.activeRun }
    var presence: WorkerPresence? { state?.presence ?? app.presence }

    /// The run waits for the Mac: queued and no connected worker can answer.
    var runWaitingForMac: Bool {
        guard let run = activeRun, run.status == .queued else { return false }
        return !(presence?.canRun(.chatTurn) ?? false)
    }

    var canSend: Bool { composer.canSend && !isSending && activeRun == nil }

    /// A pending consent card, or a question the agent is still waiting on (same rule as
    /// the "waiting on you" notices).
    var isWaitingOnUser: Bool {
        messages.contains { message in
            message.role == .assistant && message.parts.contains { part in
                switch part {
                case .consent(let consent): consent.state == .pending
                case .question(let question): question.answer == nil && message.status == .streaming
                default: false
                }
            }
        }
    }

    /// Attachments need a brand; a new chat's placeholder names the current brand.
    /// Writes only what changed, so screens can call it while rendering.
    func refreshComposerState() {
        let reason: String? = brandId == nil ? "Markasız sohbete görsel eklenemez; önce bir marka seç." : nil
        if composer.attachDisabledReason != reason { composer.attachDisabledReason = reason }
        // `@` offers the brand's products and posts (loaded for the current brand).
        let entities = brandId != nil && brandId == app.currentBrandId ? app.mentionCandidates : []
        if composer.entityCandidates != entities { composer.entityCandidates = entities }
        if let placeholderOverride {
            if composer.placeholder != placeholderOverride { composer.placeholder = placeholderOverride }
        } else if isNew {
            let name = app.currentBrand?.name.split(separator: " ").first.map(String.init)
            let placeholder = name.map { "\($0) için ne üretelim?" } ?? "Ne üretelim?"
            if composer.placeholder != placeholder { composer.placeholder = placeholder }
        }
    }

    func start() {
        guard streamTask == nil, let id else { return }
        let stream = app.conversationService.observe(id)
        streamTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                switch event {
                case .state(let liveState):
                    self.live = liveState
                case .conversation(let next):
                    let changed = self.state?.conversation != next.conversation
                    self.state = next
                    self.composer.updateConversationAliases(next.aliases)
                    self.refreshComposerState()
                    if changed { self.app.conversationUpdated(next.conversation) }
                    self.app.conversationStateChanged(next)
                }
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    // MARK: Actions

    func send() async {
        guard composer.canSend, !isSending else { return }
        if activeRun != nil {
            error = "Önceki yanıt bitmeden yeni mesaj gönderilemez; önce durdur."
            return
        }
        isSending = true
        defer { isSending = false }
        var message = composer.makeMessage()
        if let prefix = messagePrefix?() { message.text = "\(prefix)\n\(message.text)" }
        message.model = selection.model
        message.effort = selection.effort
        do {
            if id == nil {
                let firstLine = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let title = newConversationTitle ?? (firstLine.isEmpty ? nil : String(firstLine.prefix(60)))
                let conversation = try await app.conversationService.createConversation(brandId: newConversationBrandId ?? app.currentBrandId, title: title)
                id = conversation.id
                onCreated?(conversation.id)
                app.conversationUpdated(conversation)
                app.register(self, as: conversation.id)
                app.saveSelection(selection, for: conversation.id)
                start()
            }
            guard let id else { return }
            _ = try await app.conversationService.send(message, to: id)
            app.saveSelection(selection, for: id)
            composer.reset()
            error = nil
            Haptics.tap()
        } catch {
            self.error = IOSAppModel.describe(error)
            Haptics.error()
        }
    }

    /// `/usage` asks the agent for the subscription usage summary.
    func sendUsage() async {
        let saved = composer.text
        composer.text = "/usage"
        await send()
        if !composer.text.isEmpty { composer.text = saved }
    }

    func decideConsent(message: Message, consent: ConsentPart, allow: Bool) async {
        guard let id else { return }
        let key = message.id + consent.consentId
        busyConsents.insert(key)
        defer { busyConsents.remove(key) }
        do {
            _ = try await app.conversationService.decideConsent(
                conversationId: id, messageId: message.id, ConsentDecisionCreate(consentId: consent.consentId, allow: allow))
            error = nil
            allow ? Haptics.success() : Haptics.tap()
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func toggleOption(message: Message, question: QuestionPart, optionId: String) {
        let key = message.id + question.questionId
        var picked = questionSelections[key] ?? []
        if picked.contains(optionId) { picked.remove(optionId) } else { picked.insert(optionId) }
        questionSelections[key] = picked
    }

    func answer(message: Message, question: QuestionPart, optionIds: [String], text: String?) async {
        guard let id else { return }
        let key = message.id + question.questionId
        let cleanText = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalText = cleanText?.isEmpty == false ? cleanText : nil
        if let problem = question.check(optionIds: optionIds, text: finalText) {
            error = problem
            return
        }
        busyQuestions.insert(key)
        defer { busyQuestions.remove(key) }
        do {
            _ = try await app.conversationService.answer(
                conversationId: id, messageId: message.id,
                QuestionAnswerCreate(questionId: question.questionId, optionIds: optionIds, text: finalText))
            questionSelections[key] = nil
            error = nil
            Haptics.tap()
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func acceptAndGenerate(_ plan: Plan) async {
        busyPlans.insert(plan.id)
        defer { busyPlans.remove(plan.id) }
        do {
            let result = try await app.conversationService.acceptAndGenerateResult(plan, model: selection.model, effort: selection.effort)
            planNotes[plan.id] = result.skippedSummary
            Haptics.success()
            await app.posts.load()
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    /// An accepted plan whose posts were never queued (or failed): start them.
    func generate(_ plan: Plan) async {
        busyPlans.insert(plan.id)
        defer { busyPlans.remove(plan.id) }
        do {
            let result = try await app.conversationService.generatePlanResult(plan.id, model: selection.model, effort: selection.effort)
            planNotes[plan.id] = result.skippedSummary
            if result.jobs.isEmpty, result.skippedSummary == nil { planNotes[plan.id] = "Üretilecek post kalmadı." }
            Haptics.success()
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func rejectPlan(_ plan: Plan) async {
        busyPlans.insert(plan.id)
        defer { busyPlans.remove(plan.id) }
        do {
            _ = try await app.conversationService.rejectPlan(plan.id, reason: nil)
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func cancelRun() async {
        guard let run = activeRun else { return }
        do {
            _ = try await app.conversationService.cancelRun(run.id)
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func renameAlias(_ alias: ConversationAlias, to input: String) async -> String? {
        guard let id else { return nil }
        let name = ImageAlias.normalize(input)
        guard ImageAlias.isValid(name) else { return "Küçük harf, rakam ve tire kullan; harfle başlasın." }
        do {
            _ = try await app.conversationService.renameAlias(conversationId: id, aliasId: alias.id, to: name)
            return nil
        } catch {
            if (error as? StudioAPIError)?.code == .conflict { return "“\(name)” bu sohbette kullanılmış." }
            return IOSAppModel.describe(error)
        }
    }

    func rename(to title: String) async {
        guard let id else { return }
        do { try await app.renameConversation(id, to: title) } catch { self.error = IOSAppModel.describe(error) }
    }

    func archive() async -> Bool {
        guard let id else { return false }
        do {
            try await app.archiveConversation(id)
            return true
        } catch {
            self.error = IOSAppModel.describe(error)
            return false
        }
    }

    /// Plan generation summary ("3 post üretiliyor").
    func generationSummary(_ plan: Plan) -> String? {
        let generations = plan.items.compactMap(\.generation)
        guard !generations.isEmpty else { return "Üretim henüz başlatılmadı." }
        let active = generations.filter { $0.status.isActive }.count
        let done = generations.filter { $0.status == .succeeded }.count
        let failed = generations.filter { $0.status == .failed }.count
        if active > 0 { return app.isOnline ? "\(active) post üretiliyor" : "\(active) post Mac'i bekliyor" }
        if failed > 0 { return "\(done) post üretildi · \(failed) hata" }
        return "\(done) post üretildi"
    }

    /// Accepted, but nothing generating and something left to generate.
    func canStartGeneration(_ plan: Plan) -> Bool {
        guard plan.status == .accepted else { return false }
        let accepted = plan.items.filter { $0.status == .accepted }
        guard !accepted.isEmpty, !accepted.contains(where: { $0.generation?.status.isActive == true }) else { return false }
        return accepted.contains { $0.generation == nil || $0.generation?.status == .failed }
    }
}
