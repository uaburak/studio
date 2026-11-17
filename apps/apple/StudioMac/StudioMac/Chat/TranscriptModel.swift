import AppKit
import StudioKit

// The conversation as a list of rows (pure values, tested without views). The chat view
// reconciles these against its row views by `key`, updating only rows whose value changed.

/// An image shown in the chat (attachment, generated image, post slide).
struct ChatImage: Equatable {
    var assetId: EntityID
    var width: Int?
    var height: Int?
    /// `@alias` or the post title: the thumbnail's tooltip and the lightbox caption.
    var caption: String?
    /// The conversation alias behind it (right-click → rename).
    var aliasId: EntityID?
}

/// Consecutive tool steps of one reply, shown as one summary line.
struct StepGroup: Equatable {
    var key: String
    var steps: [ToolStepPart]
    var isExpanded: Bool
    /// Images the steps produced or looked at (right end of the line).
    var thumbnails: [ChatImage]
    /// The live group of a running reply: its running steps are on the working line.
    var isLive: Bool

    /// Steps shown in the summary (the working line shows running ones of a live group).
    var summarizedSteps: [ToolStepPart] {
        isLive ? steps.filter { $0.state != .running } : steps
    }

    var summary: String { StepSummary.text(for: summarizedSteps) }
    var hasErrors: Bool { steps.contains { $0.state == .error } }
}

/// A post the agent referred to (`content_ref`): title + rendered slides.
struct PostPreview: Equatable {
    var contentId: EntityID
    var title: String
    var note: String?
    var slides: [EntityID]
    var stateLabel: String?
}

/// One block of an assistant reply.
enum AssistantBlock: Equatable {
    case text(key: String, markdown: String)
    case steps(StepGroup)
    case images(key: String, [ChatImage])
    case consent(key: String, ConsentPart, busy: Bool)
    case question(key: String, QuestionPart, busy: Bool)
    case plan(key: String, Plan?, expanded: Bool, busy: Bool, isOnline: Bool)
    case progress(key: String, ProgressPart)
    case error(key: String, ErrorPart)
    case post(key: String, PostPreview)
    /// "Yanıt durduruldu." and other one-line notes.
    case notice(key: String, String)
    case unknown(key: String, String)

    var key: String {
        switch self {
        case .text(let key, _), .images(let key, _), .consent(let key, _, _), .question(let key, _, _),
             .plan(let key, _, _, _, _), .progress(let key, _), .error(let key, _), .post(let key, _),
             .notice(let key, _), .unknown(let key, _):
            key
        case .steps(let group): group.key
        }
    }

    /// The view type that renders it (a key keeps its view only while this matches).
    var kind: String {
        switch self {
        case .text: "text"
        case .steps: "steps"
        case .images: "images"
        case .consent: "consent"
        case .question: "question"
        case .plan: "plan"
        case .progress: "progress"
        case .error: "error"
        case .post: "post"
        case .notice: "notice"
        case .unknown: "unknown"
        }
    }
}

struct AssistantItem: Equatable {
    var message: Message
    var blocks: [AssistantBlock]
    var markdownContext: MarkdownContext
    /// The reply's text for "copy" (Markdown as written).
    var copyText: String
    var isStreaming: Bool
}

struct UserItem: Equatable {
    var id: EntityID
    var text: String
    var mentions: [MessageMention]
    var images: [ChatImage]
    var aliasNames: [EntityID: String]
}

struct QueuedItem: Equatable {
    var id: String
    var text: String
    var images: [ChatImage]
    var state: ConversationModel.QueuedMessage.State
    var canEdit: Bool
    var sendNow: Bool
}

/// The line at the bottom while the agent works (orange dots + label + elapsed time).
struct WorkingItem: Equatable {
    enum Phase: Equatable {
        /// The run waits (for the Mac or in line): grey, static dots.
        case queued(String)
        case thinking
        case step(String)
        case writing
    }

    var phase: Phase
    /// Elapsed time counts from here (nil: no time shown).
    var since: Date?
    var cancellable: Bool
    /// The step group the "›" opens.
    var groupKey: String?

    var label: String {
        switch phase {
        case .queued(let text): text
        case .thinking: "Düşünüyor…"
        // "Görsel üretiliyor… 12s" reads badly: the time follows the label (Claude Code).
        case .step(let label): label.hasSuffix("…") ? String(label.dropLast()) : label.hasSuffix("...") ? String(label.dropLast(3)) : label
        case .writing: "Yazıyor…"
        }
    }

    /// Primary weight for a step (Claude Code), secondary otherwise.
    var isPrimary: Bool {
        if case .step = phase { return true }
        return false
    }

    var isAnimated: Bool {
        if case .queued = phase { return false }
        return true
    }
}

enum TranscriptItem: Equatable {
    case loading(trouble: Bool)
    case empty
    case user(UserItem)
    case assistant(AssistantItem)
    case event(id: EntityID, text: String)
    case queued(QueuedItem)
    case working(WorkingItem)

    var key: String {
        switch self {
        case .loading: "loading"
        case .empty: "empty"
        case .user(let item): "m-" + item.id
        case .assistant(let item): "m-" + item.message.id
        case .event(let id, _): "m-" + id
        case .queued(let item): "q-" + item.id
        case .working: "working"
        }
    }

    var kind: String {
        switch self {
        case .loading: "loading"
        case .empty: "empty"
        case .user: "user"
        case .assistant: "assistant"
        case .event: "event"
        case .queued: "queued"
        case .working: "working"
        }
    }
}

// MARK: - Builder

struct TranscriptInput {
    var hasState: Bool
    var connectionTrouble = false
    var messages: [Message] = []
    var plans: [Plan] = []
    var aliases: [ConversationAlias] = []
    var activeRun: AgentRun?
    var runWaitingForMac = false
    var isOnline = true
    var expandedPlans: Set<EntityID> = []
    var expandedSteps: Set<String> = []
    var busyPlans: Set<EntityID> = []
    var busyQuestions: Set<String> = []
    var busyConsents: Set<String> = []
    var queue: [ConversationModel.QueuedMessage] = []
    /// When each running step was first seen (the working line's elapsed time).
    var stepStarts: [String: Date] = [:]
    /// Post cards by id (content refs) and by title (step thumbnails).
    var post: (EntityID) -> PostCard? = { _ in nil }
    var postByTitle: (String) -> PostCard? = { _ in nil }
}

enum TranscriptBuilder {
    static func items(_ input: TranscriptInput) -> [TranscriptItem] {
        guard input.hasState else { return [.loading(trouble: input.connectionTrouble)] }
        var items: [TranscriptItem] = []
        let targets = input.aliases.map(MentionText.Target.init)
        let aliasNames = Dictionary(input.aliases.map { ($0.id, $0.alias) }, uniquingKeysWith: { a, _ in a })
        let context = MarkdownContext(mentionTargets: targets, aliasNames: aliasNames)
        let live = liveMessageId(input)

        for message in input.messages {
            switch message.role {
            case .user:
                let text = message.plainText
                let mentions = message.mentions ?? MentionText.resolve(text, aliases: targets)
                items.append(.user(UserItem(
                    id: message.id, text: text, mentions: mentions,
                    images: images(of: message, aliases: input.aliases), aliasNames: aliasNames
                )))
            case .system:
                let text = message.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { items.append(.event(id: message.id, text: text)) }
            case .assistant, .unknown:
                items.append(.assistant(assistantItem(message, input: input, context: context, isLive: message.id == live)))
            }
        }

        if input.messages.isEmpty && input.queue.isEmpty && input.activeRun == nil {
            items.append(.empty)
        }
        if let working = workingItem(input, liveMessageId: live) {
            items.append(.working(working))
        }
        for queued in input.queue {
            let attachments = queued.message.attachments.map { attachment in
                ChatImage(assetId: attachment.assetId, caption: attachment.alias.map { "@" + $0 })
            }
            items.append(.queued(QueuedItem(
                id: queued.id, text: queued.message.text, images: attachments, state: queued.state,
                canEdit: queued.message.attachments.isEmpty && queued.state != .sending, sendNow: queued.sendNow
            )))
        }
        return items
    }

    /// The reply being written by the active run.
    static func liveMessageId(_ input: TranscriptInput) -> EntityID? {
        guard let run = input.activeRun, run.status == .running else { return nil }
        return input.messages.last { $0.role != .user && $0.status == .streaming && ($0.runId == nil || $0.runId == run.id) }?.id
    }

    /// Ids of running tool steps in the live reply (their start times are remembered).
    static func runningStepIds(_ input: TranscriptInput) -> [String] {
        guard let live = liveMessageId(input), let message = input.messages.first(where: { $0.id == live }) else { return [] }
        return message.parts.compactMap { part in
            if case .toolStep(let step) = part, step.state == .running { return step.id }
            return nil
        }
    }

    static func images(of message: Message, aliases: [ConversationAlias]) -> [ChatImage] {
        message.parts.compactMap { part in
            guard case .attachment(let a) = part else { return nil }
            return chatImage(a, aliases: aliases)
        }
    }

    static func chatImage(_ a: AttachmentPart, aliases: [ConversationAlias]) -> ChatImage {
        let alias = aliases.first { $0.id == a.aliasId } ?? aliases.first { $0.assetId == a.assetId }
        let name = alias?.alias ?? a.alias
        return ChatImage(assetId: a.assetId, width: a.width, height: a.height, caption: name.map { "@" + $0 } ?? a.filename, aliasId: alias?.id ?? a.aliasId)
    }

    private static func assistantItem(_ message: Message, input: TranscriptInput, context: MarkdownContext, isLive: Bool) -> AssistantItem {
        var blocks: [AssistantBlock] = []
        var index = 0
        let parts = message.parts
        while index < parts.count {
            let part = parts[index]
            switch part {
            case .toolStep:
                var steps: [ToolStepPart] = []
                while index < parts.count, case .toolStep(let step) = parts[index] {
                    steps.append(step)
                    index += 1
                }
                let key = "steps-" + (steps.first?.id ?? "\(index)")
                let group = StepGroup(
                    key: key, steps: steps, isExpanded: input.expandedSteps.contains(key),
                    thumbnails: StepSummary.thumbnails(steps, aliases: input.aliases, postByTitle: input.postByTitle),
                    isLive: isLive
                )
                // A live group with only running steps lives on the working line.
                if group.summarizedSteps.isEmpty && !group.isExpanded { continue }
                blocks.append(.steps(group))
                continue
            case .attachment:
                let start = index
                var images: [ChatImage] = []
                while index < parts.count, case .attachment(let a) = parts[index] {
                    images.append(chatImage(a, aliases: input.aliases))
                    index += 1
                }
                blocks.append(.images(key: "images-\(start)", images))
                continue
            default:
                break
            }
            index += 1
            if part.isHiddenInChat { continue }
            let at = index - 1
            switch part {
            case .text(let text):
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    blocks.append(.text(key: "text-\(at)", markdown: text))
                }
            case .consent(let consent):
                blocks.append(.consent(key: "consent-" + consent.consentId, consent, busy: input.busyConsents.contains(message.id + consent.consentId)))
            case .question(let question):
                blocks.append(.question(key: "question-" + question.questionId, question, busy: input.busyQuestions.contains(message.id + question.questionId)))
            case .planProposal(let planId):
                blocks.append(.plan(
                    key: "plan-" + planId, input.plans.first { $0.id == planId },
                    expanded: input.expandedPlans.contains(planId), busy: input.busyPlans.contains(planId), isOnline: input.isOnline
                ))
            case .progress(let progress):
                // "Düşünüyor…" and the running step of a live reply are on the working line.
                if progress.stepId == "thinking" { continue }
                if isLive && progress.state == .running { continue }
                blocks.append(.progress(key: "progress-" + progress.stepId, progress))
            case .error(let error):
                blocks.append(.error(key: "error-\(at)", error))
            case .contentRef(let ref):
                let card = input.post(ref.contentId)
                blocks.append(.post(key: "post-\(at)-" + ref.contentId, PostPreview(
                    contentId: ref.contentId, title: card?.title ?? "Post", note: ref.note,
                    slides: card?.renderedAssetIds ?? [], stateLabel: card?.state.label
                )))
            case .unknown(let type):
                blocks.append(.unknown(key: "unknown-\(at)", "Bu sürümün gösteremediği bir içerik (\(type))."))
            case .toolStep, .attachment:
                break
            }
        }
        switch message.status {
        case .failed: blocks.append(.notice(key: "status", "Yanıt yarıda kaldı."))
        case .cancelled: blocks.append(.notice(key: "status", "Yanıt durduruldu."))
        default: break
        }
        return AssistantItem(
            message: message, blocks: blocks, markdownContext: context,
            copyText: message.plainText.trimmingCharacters(in: .whitespacesAndNewlines),
            isStreaming: message.status == .streaming
        )
    }

    /// What the agent does now: queued, thinking, a running step, or writing.
    static func workingItem(_ input: TranscriptInput, liveMessageId live: EntityID?) -> WorkingItem? {
        guard let run = input.activeRun else { return nil }
        guard run.status == .running else {
            let text: String
            if input.runWaitingForMac {
                text = input.isOnline ? "Mac sırada bekliyor: sohbet ajanı henüz kurulu değil." : "Mac sırada bekliyor: Mac çevrimdışı."
            } else {
                text = "Sırada"
            }
            return WorkingItem(phase: .queued(text), since: nil, cancellable: true, groupKey: nil)
        }
        let runStart = run.startedAt ?? input.stepStarts["run-" + run.id]
        guard let live, let message = input.messages.first(where: { $0.id == live }) else {
            return WorkingItem(phase: .thinking, since: runStart, cancellable: false, groupKey: nil)
        }
        // The latest running thing wins: a tool step, else a progress step.
        var groupKey: String?
        var currentGroupKey: String?
        var phase: WorkingItem.Phase?
        var since = runStart
        var sawText = false
        var previousWasStep = false
        for part in message.parts {
            switch part {
            case .toolStep(let step):
                if !previousWasStep { currentGroupKey = "steps-" + step.id }
                previousWasStep = true
                if step.state == .running {
                    phase = .step(step.label)
                    since = input.stepStarts[step.id] ?? runStart
                    groupKey = currentGroupKey
                }
                continue
            case .progress(let progress) where progress.state == .running:
                if progress.stepId == "thinking" {
                    if phase == nil { phase = .thinking }
                } else {
                    var label = progress.label
                    if let current = progress.current, let total = progress.total { label += " \(current)/\(total)" }
                    phase = .step(label)
                    since = input.stepStarts["progress-" + progress.stepId] ?? runStart
                    groupKey = nil
                }
            case .text(let text):
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sawText = true }
            default:
                break
            }
            previousWasStep = false
        }
        if let phase { return WorkingItem(phase: phase, since: since, cancellable: false, groupKey: groupKey) }
        return WorkingItem(phase: sawText ? .writing : .thinking, since: runStart, cancellable: false, groupKey: nil)
    }
}

// MARK: - Step summaries

/// "2 görsel üretti, 1 post oluşturdu" from tool steps (Claude Code's "Ran 3 commands, read 2 files").
enum StepSummary {
    private enum Phrase {
        case counted(String)
        case plain(String)
    }

    private static func phrase(for tool: String) -> Phrase {
        switch tool {
        case "list_brands": .plain("markaları okudu")
        case "get_brand_profile": .plain("marka profilini okudu")
        case "set_conversation_brand": .plain("markayı seçti")
        case "propose_plan": .plain("plan önerdi")
        case "ask_user": .counted("soru sordu")
        case "list_aliases": .plain("görselleri listeledi")
        case "view_alias": .counted("görsele baktı")
        case "list_contents": .plain("postları listeledi")
        case "get_content", "view_post": .counted("posta baktı")
        case "generate_post": .counted("post oluşturdu")
        case "wait_jobs": .plain("üretimi bekledi")
        case "generate_reel": .counted("Reels oluşturdu")
        case "revise_post": .counted("post düzeltti")
        case "list_skills", "get_skill": .plain("becerileri okudu")
        case "list_social_accounts": .plain("hesapları okudu")
        case "accept_and_generate_plan": .plain("planı üretime aldı")
        case "approve_content": .counted("post onayladı")
        case "schedule_content": .counted("post zamanladı")
        case "create_brand": .plain("marka oluşturdu")
        case "analyze_brand": .plain("markayı analiz etti")
        case "generate_ai_image": .counted("görsel üretti")
        case "fill_post_slot": .counted("görsel yerleştirdi")
        case "export_content_pdf": .plain("PDF hazırladı")
        case "publish_now": .counted("post yayınladı")
        default: .counted("adım tamamladı")
        }
    }

    /// One step: its own label ("Marka profili okundu"). Several: grouped phrases in order of
    /// first appearance, then the failed count.
    static func text(for steps: [ToolStepPart]) -> String {
        guard !steps.isEmpty else { return "" }
        if steps.count == 1, let step = steps.first {
            let label = step.label.trimmingCharacters(in: CharacterSet(charactersIn: "… ."))
            return step.state == .error ? "\(label) · başarısız" : step.label
        }
        var order: [String] = []
        var counts: [String: Int] = [:]
        var counted: [String: Bool] = [:]
        for step in steps {
            let key: String
            let isCounted: Bool
            switch phrase(for: step.name) {
            case .counted(let text): key = text; isCounted = true
            case .plain(let text): key = text; isCounted = false
            }
            if counts[key] == nil { order.append(key) }
            counts[key, default: 0] += 1
            counted[key] = isCounted
        }
        var pieces = order.map { key in
            counted[key] == true ? "\(counts[key] ?? 1) \(key)" : key
        }
        let failed = steps.filter { $0.state == .error }.count
        if failed > 0 { pieces.append("\(failed) başarısız") }
        return capitalized(pieces.joined(separator: ", "))
    }

    static func capitalized(_ text: String) -> String {
        guard let first = text.first else { return text }
        return String(first).uppercased(with: TurkishFormat.locale) + text.dropFirst()
    }

    static let postTools: Set<String> = ["generate_post", "revise_post", "view_post", "get_content", "generate_reel", "fill_post_slot", "approve_content", "schedule_content", "export_content_pdf", "publish_now"]

    /// Images behind finished steps: `@alias` in a summary, or the post a post tool names first
    /// ("Hasat · 1 iş" → that post's first rendered slide). Unique, in step order.
    static func thumbnails(_ steps: [ToolStepPart], aliases: [ConversationAlias], postByTitle: (String) -> PostCard?) -> [ChatImage] {
        var seen: Set<EntityID> = []
        var result: [ChatImage] = []
        for step in steps where step.state == .done {
            guard let summary = step.summary, !summary.isEmpty else { continue }
            for token in MentionText.scanTokens(summary) {
                guard let alias = aliases.first(where: { $0.alias == token.alias || $0.previousAliases.contains(token.alias) }) else { continue }
                if seen.insert(alias.assetId).inserted {
                    result.append(ChatImage(assetId: alias.assetId, width: alias.width, height: alias.height, caption: "@" + alias.alias, aliasId: alias.id))
                }
            }
            if postTools.contains(step.name) {
                let title = summary.components(separatedBy: " · ").first?.trimmingCharacters(in: .whitespaces) ?? ""
                if !title.isEmpty, let card = postByTitle(title), let slide = card.renderedAssetIds.first, seen.insert(slide).inserted {
                    result.append(ChatImage(assetId: slide, caption: card.title))
                }
            }
        }
        return result
    }
}
