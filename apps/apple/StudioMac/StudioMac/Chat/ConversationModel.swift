import AppKit
import StudioKit
import SwiftUI

/// One open conversation: live state from the stream, the composer, actions.
@MainActor
@Observable
final class ConversationModel {
    let id: EntityID
    unowned let app: AppModel
    private(set) var state: ConversationState?
    private(set) var live: LiveState = .connecting(attempt: 1)
    let composer = ComposerModel()
    var isSending = false
    var error: String?
    /// Plan ids being accepted / rejected right now.
    var busyPlans: Set<EntityID> = []
    /// Plans whose full item list is expanded in the chat.
    var expandedPlans: Set<EntityID> = []
    /// Questions being answered right now (message id + question id).
    var busyQuestions: Set<String> = []
    /// Alias id whose image is being previewed (mention click).
    var previewAliasId: EntityID?
    private var task: Task<Void, Never>?

    init(id: EntityID, app: AppModel) {
        self.id = id
        self.app = app
        configureComposer()
    }

    /// Seed with a known state (screenshots, tests).
    init(id: EntityID, app: AppModel, state: ConversationState) {
        self.id = id
        self.app = app
        self.state = state
        live = .live
        configureComposer()
        composer.updateConversationAliases(state.aliases)
    }

    private func configureComposer() {
        composer.uploader = { [weak self] file, progress in
            guard let self, let brandId = self.brandId else { throw StudioAPIError.invalidConfiguration("Bu sohbetin markası yok.") }
            return try await self.app.conversationService.uploadImage(file, brandId: brandId, progress: progress)
        }
    }

    var brandId: EntityID? { state?.conversation.brandId ?? app.conversations.first { $0.id == id }?.brandId }

    func start() {
        guard task == nil else { return }
        let stream = app.conversationService.observe(id)
        task = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                switch event {
                case .state(let live):
                    self.live = live
                case .conversation(let state):
                    let titleChanged = self.state?.conversation != state.conversation
                    self.state = state
                    self.composer.updateConversationAliases(state.aliases)
                    // The API refuses attachments in a conversation without a brand (400).
                    self.composer.attachDisabledReason = state.conversation.brandId == nil ? "Markasız sohbete görsel eklenemez." : nil
                    if titleChanged { self.app.conversationChanged(state.conversation) }
                }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    // MARK: Derived

    var messages: [Message] { state?.messages ?? [] }
    var activeRun: AgentRun? { state?.activeRun }

    /// The run is waiting for the Mac: queued, and no connected worker can run chat turns.
    var runWaitingForMac: Bool {
        guard let run = activeRun, run.status == .queued else { return false }
        let presence = state?.presence ?? app.presence
        return !(presence?.canRun(.chatTurn) ?? false)
    }

    // MARK: Actions

    func send() async {
        guard composer.canSend, !isSending else { return }
        if activeRun != nil {
            error = "Önceki yanıt bitmeden yeni mesaj gönderilemez."
            return
        }
        isSending = true
        defer { isSending = false }
        let message = composer.makeMessage()
        do {
            _ = try await app.conversationService.send(message, to: id)
            composer.reset()
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func answer(message: Message, question: QuestionPart, optionIds: [String], text: String?) async {
        let key = message.id + question.questionId
        busyQuestions.insert(key)
        defer { busyQuestions.remove(key) }
        if let problem = question.check(optionIds: optionIds, text: text) {
            error = problem
            return
        }
        do {
            _ = try await app.conversationService.answer(conversationId: id, messageId: message.id, QuestionAnswerCreate(questionId: question.questionId, optionIds: optionIds, text: text))
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func acceptAndGenerate(_ plan: Plan) async {
        busyPlans.insert(plan.id)
        defer { busyPlans.remove(plan.id) }
        do {
            _ = try await app.conversationService.acceptAndGenerate(plan)
            await app.posts.load()
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// "Düzenle": ask the agent to change its proposal, through the composer.
    func editPlan(_ plan: Plan) {
        composer.placeholder = "Planda neyi değiştireyim?"
        composer.bridge?.focus()
    }

    func rejectPlan(_ plan: Plan) async {
        busyPlans.insert(plan.id)
        defer { busyPlans.remove(plan.id) }
        do {
            _ = try await app.conversationService.rejectPlan(plan.id, reason: nil)
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func cancelRun() async {
        guard let run = activeRun else { return }
        do {
            _ = try await app.conversationService.cancelRun(run.id)
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func renameAlias(_ alias: ConversationAlias, to name: String) async -> String? {
        let name = name.trimmingCharacters(in: .whitespaces).lowercased()
        guard ImageAlias.isValid(name) else { return "Küçük harf, rakam ve tire kullan; harfle başlasın." }
        do {
            _ = try await app.conversationService.renameAlias(conversationId: id, aliasId: alias.id, to: name)
            return nil
        } catch {
            if (error as? StudioAPIError)?.code == .conflict { return "“\(name)” bu sohbette kullanılmış." }
            return AppModel.describe(error)
        }
    }

    func rename(to title: String) async {
        do {
            let conversation = try await app.conversationService.renameConversation(id, title: title)
            app.conversationChanged(conversation)
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func archive() async {
        do {
            _ = try await app.conversationService.archiveConversation(id)
            app.conversations.removeAll { $0.id == id }
            app.startNewChat()
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// Posts created from this conversation's plans (newest plan first).
    var contentIds: [EntityID] { state?.contentIds ?? [] }
}

/// The start screen ("Ne üretelim?"): a composer before a conversation exists.
@MainActor
@Observable
final class NewChatModel {
    weak var app: AppModel?
    let composer = ComposerModel(placeholder: "MTM için bu ayın postlarını üret…")
    var isCreating = false
    var error: String?
    var focusRequest = 0

    init() {
        composer.uploader = { [weak self] file, progress in
            guard let self, let app = self.app, let brandId = app.currentBrandId else {
                throw StudioAPIError.invalidConfiguration("Önce bir marka seç.")
            }
            return try await app.conversationService.uploadImage(file, brandId: brandId, progress: progress)
        }
    }

    static let suggestions = ["Bu ayın postlarını üret", "Yeni ürün duyurusu", "Bu haftayı planla"]

    func updatePlaceholder() {
        guard let app else { return }
        let name = app.brand(app.currentBrandId)?.name
        composer.placeholder = name.map { "\($0.split(separator: " ").first.map(String.init) ?? $0) için bu ayın postlarını üret…" } ?? "Ne üretelim?"
        composer.attachDisabledReason = app.currentBrandId == nil ? "Görsel eklemek için önce başlıktaki menüden bir marka seç." : nil
    }

    /// Create the conversation with the first message, then open it.
    func send() async {
        guard let app, composer.canSend, !isCreating else { return }
        isCreating = true
        defer { isCreating = false }
        let message = composer.makeMessage()
        let title = String(message.text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        do {
            let conversation = try await app.conversationService.createConversation(brandId: app.currentBrandId, title: title.isEmpty ? nil : title)
            app.conversationChanged(conversation)
            _ = try await app.conversationService.send(message, to: conversation.id)
            composer.reset()
            error = nil
            app.navigate(to: .conversation(conversation.id))
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}
