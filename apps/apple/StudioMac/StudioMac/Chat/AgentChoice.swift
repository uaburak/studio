import Foundation
import StudioKit

/// The model and effort a turn (or a plan's generation) runs with.
struct AgentChoice: Equatable, Sendable {
    var model: AgentModel
    var effort: AgentEffort

    static let fallback = AgentChoice(model: .opus, effort: .medium)
}

/// Remembers the choice per conversation, and the last one used (the default
/// for new chats and conversations never touched). UserDefaults keys, so the
/// values are the same ones `@AppStorage` would read.
struct AgentChoiceStore: @unchecked Sendable {
    static let lastModelKey = "studio.agent.model"
    static let lastEffortKey = "studio.agent.effort"
    static let perConversationKey = "studio.agent.conversations"

    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The last choice the user made anywhere.
    var last: AgentChoice {
        AgentChoice(
            model: Self.known(AgentModel(rawValue: defaults.string(forKey: Self.lastModelKey) ?? "")) ?? AgentChoice.fallback.model,
            effort: Self.known(AgentEffort(rawValue: defaults.string(forKey: Self.lastEffortKey) ?? "")) ?? AgentChoice.fallback.effort)
    }

    /// The conversation's own choice, else the last one used.
    func choice(for conversationId: EntityID?) -> AgentChoice {
        let fallback = last
        guard let conversationId, let stored = table[conversationId] else { return fallback }
        return AgentChoice(
            model: Self.known(stored["model"].flatMap(AgentModel.init(rawValue:))) ?? fallback.model,
            effort: Self.known(stored["effort"].flatMap(AgentEffort.init(rawValue:))) ?? fallback.effort)
    }

    /// Save for the conversation (when given) and as the last used choice.
    func save(_ choice: AgentChoice, for conversationId: EntityID?) {
        defaults.set(choice.model.rawValue, forKey: Self.lastModelKey)
        defaults.set(choice.effort.rawValue, forKey: Self.lastEffortKey)
        guard let conversationId else { return }
        var table = table
        table[conversationId] = ["model": choice.model.rawValue, "effort": choice.effort.rawValue]
        defaults.set(table, forKey: Self.perConversationKey)
    }

    private var table: [String: [String: String]] {
        defaults.dictionary(forKey: Self.perConversationKey) as? [String: [String: String]] ?? [:]
    }

    private static func known<E: OpenEnum>(_ value: E?) -> E? {
        guard let value, value != E.unknown else { return nil }
        return value
    }
}
