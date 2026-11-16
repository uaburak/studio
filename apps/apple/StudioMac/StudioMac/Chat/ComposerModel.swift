import AppKit
import StudioKit
import SwiftUI

/// A mention candidate for the `@` popover.
struct MentionSuggestion: Identifiable, Equatable {
    enum Thumbnail: Equatable {
        case local(NSImage)
        case asset(EntityID)
    }

    var alias: String
    var thumbnail: Thumbnail
    /// Sent already (an alias of the conversation) or still a draft in the composer.
    var isDraft: Bool
    var id: String { alias }
}

/// Bridge from the model to the AppKit text view (insert tokens, clear, focus).
@MainActor
protocol ComposerTextBridge: AnyObject {
    func insertMention(_ alias: String, replacingQueryStartingAt start: Int)
    func clear()
    func focus()
    func setText(_ text: String)
}

/// State of a message composer: text, image attachments with aliases, uploads.
@MainActor
@Observable
final class ComposerModel {
    struct Draft: Identifiable, Equatable {
        enum State: Equatable {
            case uploading(Double)
            case uploaded(Asset)
            case failed(String)
        }

        let id = UUID()
        var alias: String
        var thumbnail: NSImage
        var file: UploadFile
        var state: State

        var asset: Asset? {
            if case .uploaded(let asset) = state { return asset }
            return nil
        }

        static func == (a: Draft, b: Draft) -> Bool { a.id == b.id && a.alias == b.alias && a.state == b.state }
    }

    /// Plain text with mentions exported as `@alias`.
    var text: String = "" {
        didSet { if text != oldValue { updateSuggestions() } }
    }

    var drafts: [Draft] = []
    var errors: [String] = []
    /// Aliases of the conversation (current names), for mentions.
    private(set) var conversationAliases: [ConversationAlias] = []
    private var allocator = AliasAllocator()
    private var uploads: [UUID: Task<Void, Never>] = [:]

    /// Caret position (UTF-16) reported by the text view.
    var caret: Int = 0 {
        didSet { if caret != oldValue { updateSuggestions() } }
    }

    private(set) var suggestions: [MentionSuggestion] = []
    var suggestionIndex = 0
    private(set) var queryStart: Int?

    weak var bridge: (any ComposerTextBridge)?
    var placeholder: String
    /// Upload function (service + brand), nil while attaching is impossible (no brand).
    var uploader: ((UploadFile, @escaping @Sendable (Double) -> Void) async throws -> Asset)?
    /// Why attaching is not possible right now (shown as help on the + button).
    var attachDisabledReason: String?

    init(placeholder: String = "Mesaj yaz…") {
        self.placeholder = placeholder
    }

    // MARK: Aliases

    /// Keep the allocator and suggestions in step with the conversation's aliases.
    func updateConversationAliases(_ aliases: [ConversationAlias]) {
        guard aliases != conversationAliases else { return }
        conversationAliases = aliases
        var next = AliasAllocator(aliases: aliases)
        for draft in drafts { next.register([ConversationAlias(id: "draft", conversationId: "", alias: draft.alias, assetId: "", mimeType: "", createdAt: .now, updatedAt: .now)]) }
        // Never move backwards: keep the higher counter.
        while next.nextIndex < allocator.nextIndex { _ = next.next() }
        allocator = next
        updateSuggestions()
    }

    /// Every name a mention can use: drafts and the conversation's aliases (also previous names).
    var knownTargets: [MentionText.Target] {
        conversationAliases.map(MentionText.Target.init)
            + drafts.map { MentionText.Target(id: "draft-\($0.id)", alias: $0.alias, assetId: $0.asset?.id ?? "draft-\($0.id)") }
    }

    var knownNames: Set<String> {
        Set(knownTargets.flatMap { [$0.alias] + $0.previousAliases })
    }

    // MARK: Attachments

    var canAttach: Bool { uploader != nil && attachDisabledReason == nil }

    func add(_ images: [ImportedImage]) {
        guard let uploader else {
            errors = [attachDisabledReason ?? "Görsel eklemek için önce bir marka seç."]
            return
        }
        for image in images {
            let draft = Draft(alias: allocator.next(), thumbnail: image.thumbnail, file: image.file, state: .uploading(0))
            drafts.append(draft)
            startUpload(draft.id, uploader: uploader)
        }
        updateSuggestions()
    }

    func addFiles(_ urls: [URL]) {
        var imported: [ImportedImage] = []
        var problems: [String] = []
        for url in urls {
            do { imported.append(try ImageImport.from(url: url)) } catch { problems.append(error.localizedDescription) }
        }
        errors = problems
        add(imported)
    }

    private func startUpload(_ id: UUID, uploader: @escaping (UploadFile, @escaping @Sendable (Double) -> Void) async throws -> Asset) {
        guard let file = drafts.first(where: { $0.id == id })?.file else { return }
        uploads[id]?.cancel()
        uploads[id] = Task { [weak self] in
            do {
                let asset = try await uploader(file) { [weak self] progress in
                    Task { @MainActor in self?.setState(id, .uploading(progress)) }
                }
                self?.setState(id, .uploaded(asset))
            } catch is CancellationError {
                return
            } catch {
                self?.setState(id, .failed(AppModel.describe(error)))
            }
        }
    }

    private func setState(_ id: UUID, _ state: Draft.State) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        // A late progress report must not overwrite the final state.
        if case .uploading = state, case .uploaded = drafts[index].state { return }
        drafts[index].state = state
    }

    func retry(_ id: UUID) {
        guard let uploader, let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        drafts[index].state = .uploading(0)
        startUpload(id, uploader: uploader)
    }

    func remove(_ id: UUID) {
        uploads[id]?.cancel()
        uploads[id] = nil
        if let draft = drafts.first(where: { $0.id == id }) { allocator.release(draft.alias) }
        drafts.removeAll { $0.id == id }
        updateSuggestions()
    }

    /// Rename a draft's alias. Returns a Turkish error message, or nil on success.
    @discardableResult
    func rename(_ id: UUID, to input: String) -> String? {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return nil }
        let name = input.trimmingCharacters(in: .whitespaces).lowercased()
        let old = drafts[index].alias
        if name == old { return nil }
        do {
            try allocator.rename(old, to: name)
        } catch .invalid {
            return "Küçük harf, rakam ve tire kullan; harfle başlasın, tireyle bitmesin."
        } catch {
            return "“\(name)” bu sohbette kullanılmış."
        }
        drafts[index].alias = name
        // Mentions of the old draft name in the text follow the rename.
        text = text.replacingOccurrences(of: "@\(old)", with: "@\(name)")
        bridge?.setText(text)
        updateSuggestions()
        return nil
    }

    var isUploading: Bool { drafts.contains { if case .uploading = $0.state { true } else { false } } }
    var hasFailedUploads: Bool { drafts.contains { if case .failed = $0.state { true } else { false } } }

    var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && drafts.isEmpty
    }

    /// Sending waits for every upload; a failed one must be retried or removed.
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

    /// After a successful send: the drafts became conversation aliases.
    func reset() {
        uploads.values.forEach { $0.cancel() }
        uploads = [:]
        drafts = []
        errors = []
        text = ""
        bridge?.clear()
    }

    /// Move text and drafts into another composer (new chat -> its conversation).
    func transfer(to other: ComposerModel) {
        other.text = text
        other.drafts = drafts
        other.allocator = allocator
        other.bridge?.setText(text)
        uploads = [:]
        drafts = []
        text = ""
        bridge?.clear()
    }

    // MARK: Mention autocomplete

    private func updateSuggestions() {
        guard let (start, query) = MentionText.activeQuery(in: text, cursor: min(caret, (text as NSString).length)) else {
            suggestions = []
            queryStart = nil
            return
        }
        let conversation = conversationAliases.map { alias in
            MentionSuggestion(alias: alias.alias, thumbnail: .asset(alias.assetId), isDraft: false)
        }
        let local = drafts.map { MentionSuggestion(alias: $0.alias, thumbnail: .local($0.thumbnail), isDraft: true) }
        let all = conversation + local
        let filtered = query.isEmpty ? all : all.filter { $0.alias.hasPrefix(query) } + all.filter { !$0.alias.hasPrefix(query) && $0.alias.contains(query) }
        suggestions = filtered
        queryStart = filtered.isEmpty ? nil : start
        suggestionIndex = min(suggestionIndex, max(0, filtered.count - 1))
    }

    var isSuggesting: Bool { !suggestions.isEmpty && queryStart != nil }

    func moveSuggestion(_ delta: Int) {
        guard !suggestions.isEmpty else { return }
        suggestionIndex = (suggestionIndex + delta + suggestions.count) % suggestions.count
    }

    func choose(_ suggestion: MentionSuggestion? = nil) {
        guard let start = queryStart else { return }
        let pick = suggestion ?? suggestions[safe: suggestionIndex]
        guard let pick else { return }
        bridge?.insertMention(pick.alias, replacingQueryStartingAt: start)
        suggestions = []
        queryStart = nil
        suggestionIndex = 0
    }

    func dismissSuggestions() {
        suggestions = []
        queryStart = nil
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
