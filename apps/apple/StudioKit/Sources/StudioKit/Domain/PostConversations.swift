import Foundation

/// Which conversation a post's AI requests go to on this phone (the Mac keeps its own binding,
/// `workspace-store.ts`): created in the post's brand, named after the post, on the first request
/// about a canvas version, and reused after that.
@MainActor
public final class PostConversations {
    /// The app's: kept in the user defaults.
    public static let shared = PostConversations(defaults: .standard)

    private let defaults: UserDefaults?
    private let key = "studio.postConversations"
    private var ids: [String: String]

    /// `defaults` nil: in memory only (tests, previews).
    public init(defaults: UserDefaults? = nil) {
        self.defaults = defaults
        ids = (defaults?.dictionary(forKey: key) as? [String: String]) ?? [:]
    }

    public func conversationId(for contentId: EntityID) -> EntityID? {
        ids[contentId]
    }

    public func remember(_ conversationId: EntityID, for contentId: EntityID) {
        ids[contentId] = conversationId
        // A phone has a few hundred posts at most; the oldest bindings go beyond that.
        if ids.count > 500, let drop = ids.keys.sorted().first { ids[drop] = nil }
        defaults?.set(ids, forKey: key)
    }

    public func forget(_ contentId: EntityID) {
        ids[contentId] = nil
        defaults?.set(ids, forKey: key)
    }
}
