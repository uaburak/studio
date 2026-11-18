import Foundation

/// Turkish texts for the Mac / AI status shown under composers and in settings
/// (the Mac's usage popover follows the same wording).
public enum AssistantStatus {
    /// From here on the usage ring turns orange ("near the limit").
    public static let warnPercent: Double = 90

    public static func percentText(_ percent: Double) -> String { "%\(Int(percent.rounded()))" }

    public static func isWarning(_ percent: Double) -> Bool { percent >= warnPercent }

    public static func windowTitle(_ kind: UsageWindow.Kind) -> String {
        switch kind {
        case .fiveHour: "5 saatlik"
        case .weekly: "Haftalık"
        case .other, .unknown: "Diğer"
        }
    }

    public static func usedText(_ window: UsageWindow) -> String {
        if window.limited { return "Sınıra ulaşıldı" }
        guard window.usedPercent != nil else { return "—" }
        return "\(percentText(window.effectivePercent)) kullanıldı"
    }

    public static func relative(_ date: Date, now: Date = Date()) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// "Mac hazır" / "Mac çevrimdışı" / "Mac bağlanıyor".
    public static func macLine(_ presence: WorkerPresence?) -> String {
        guard let presence else { return "Mac'e bağlanılıyor" }
        if presence.online {
            let busy = presence.currentJobs.count
            if busy > 0 { return "Mac çalışıyor · \(busy) iş" }
            if presence.queueLength > 0 { return "Mac hazır · \(presence.queueLength) iş sırada" }
            return "Mac hazır"
        }
        if let last = presence.lastSeenAt { return "Mac çevrimdışı · \(relative(last))" }
        return "Mac çevrimdışı"
    }

    public static func claudeLine(_ presence: WorkerPresence?) -> String {
        guard let claude = presence?.claude else {
            return presence?.online == true ? "Henüz bildirilmedi" : "Mac çevrimdışı"
        }
        switch claude.status {
        case .signedIn:
            let who = [claude.email, claude.plan].compactMap { $0 }.joined(separator: " · ")
            return who.isEmpty ? "Giriş yapıldı" : "Giriş yapıldı · \(who)"
        case .signedOut: return "Giriş yapılmadı (Mac'te giriş yap)"
        case .signingIn: return "Mac'te tarayıcı girişi bekleniyor"
        case .notInstalled: return "Claude CLI Mac'te kurulu değil"
        case .error, .unknown: return claude.detail ?? "Durum okunamadı"
        }
    }

    public static func geminiLine(_ presence: WorkerPresence?) -> String {
        guard let gemini = presence?.gemini else {
            return presence?.online == true ? "Durum bekleniyor" : "Mac çevrimdışı"
        }
        switch gemini.status {
        case .ready:
            let mode = switch gemini.mode {
            case .api: "API anahtarı"
            case .cli: "Gemini CLI"
            case .both: "API + CLI"
            case .none, .unknown: "Hazır"
            }
            return "Hazır · \(mode)"
        case .notConfigured: return "Yapılandırılmadı (Mac'te GEMINI_API_KEY ya da CLI gerekli)"
        case .error, .unknown: return gemini.detail ?? "Durum okunamadı"
        }
    }

    /// Whether `model` can answer right now, as far as the Mac reported.
    public static func isAvailable(_ model: AgentModel, presence: WorkerPresence?) -> Bool {
        guard let presence, presence.online else { return false }
        if model.isGemini { return presence.gemini?.status == .ready || presence.gemini == nil }
        if let provider = model.otherProvider {
            guard let rows = presence.providers else { return true }
            return rows.first(where: { $0.provider == provider })?.state == .ready
        }
        return presence.claude?.status == .signedIn || presence.claude == nil
    }
}

/// Model and effort the user picked, remembered per conversation and as the last
/// choice (default for new chats). Shared by the apps; plain UserDefaults keys.
public struct AgentSelection: Equatable, Sendable, Hashable {
    public var model: AgentModel
    public var effort: AgentEffort

    public init(model: AgentModel, effort: AgentEffort) {
        self.model = model
        self.effort = effort
    }

    public static let fallback = AgentSelection(model: .geminiFlashLite, effort: .medium)
}

public struct AgentSelectionStore: @unchecked Sendable {
    public let defaults: UserDefaults
    public let prefix: String

    public init(defaults: UserDefaults = .standard, prefix: String = "studio.agent") {
        self.defaults = defaults
        self.prefix = prefix
    }

    private var lastModelKey: String { "\(prefix).model" }
    private var lastEffortKey: String { "\(prefix).effort" }
    private var tableKey: String { "\(prefix).conversations" }

    public var last: AgentSelection {
        AgentSelection(
            model: Self.known(AgentModel(rawValue: defaults.string(forKey: lastModelKey) ?? "")) ?? AgentSelection.fallback.model,
            effort: Self.known(AgentEffort(rawValue: defaults.string(forKey: lastEffortKey) ?? "")) ?? AgentSelection.fallback.effort)
    }

    public func selection(for conversationId: EntityID?) -> AgentSelection {
        let fallback = last
        guard let conversationId, let stored = table[conversationId] else { return fallback }
        return AgentSelection(
            model: Self.known(stored["model"].flatMap(AgentModel.init(rawValue:))) ?? fallback.model,
            effort: Self.known(stored["effort"].flatMap(AgentEffort.init(rawValue:))) ?? fallback.effort)
    }

    public func save(_ selection: AgentSelection, for conversationId: EntityID?) {
        defaults.set(selection.model.rawValue, forKey: lastModelKey)
        defaults.set(selection.effort.rawValue, forKey: lastEffortKey)
        guard let conversationId else { return }
        var table = table
        table[conversationId] = ["model": selection.model.rawValue, "effort": selection.effort.rawValue]
        defaults.set(table, forKey: tableKey)
    }

    private var table: [String: [String: String]] {
        defaults.dictionary(forKey: tableKey) as? [String: [String: String]] ?? [:]
    }

    private static func known<E: OpenEnum>(_ value: E?) -> E? {
        guard let value, value != E.unknown else { return nil }
        return value
    }
}

// MARK: - Mention autocomplete

/// A name the `@` suggestions offer: a sent alias of the conversation or a draft attachment.
public struct MentionCandidate: Hashable, Sendable, Identifiable {
    public var alias: String
    /// The asset behind it (nil while a draft uploads).
    public var assetId: EntityID?
    public var isDraft: Bool
    public var id: String { alias }

    public init(alias: String, assetId: EntityID?, isDraft: Bool) {
        self.alias = alias
        self.assetId = assetId
        self.isDraft = isDraft
    }
}

extension MentionText {
    /// Candidates for the `@query` being typed: prefix matches first, then other matches.
    public static func suggestions(_ candidates: [MentionCandidate], query: String) -> [MentionCandidate] {
        let q = query.lowercased()
        guard !q.isEmpty else { return candidates }
        return candidates.filter { $0.alias.hasPrefix(q) } + candidates.filter { !$0.alias.hasPrefix(q) && $0.alias.contains(q) }
    }

    /// Replace the `@query` that starts at `start` (UTF-16) and ends at `cursor` with
    /// `@alias ` and return the new text and caret.
    public static func insert(alias: String, into text: String, queryStart start: Int, cursor: Int) -> (text: String, cursor: Int) {
        let units = Array(text.utf16)
        let lower = max(0, min(start, units.count))
        let upper = max(lower, min(cursor, units.count))
        var tail = String(decoding: units[upper...], as: UTF16.self)
        if tail.hasPrefix(" ") { tail.removeFirst() }
        let head = String(decoding: units[..<lower], as: UTF16.self)
        let token = "@\(alias) "
        return (head + token + tail, (head as NSString).length + (token as NSString).length)
    }
}
