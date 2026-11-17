import Foundation
import StudioKit

/// What the window showed when the app last ran: the screen (route), the working brand and
/// which side panels were open. Saved in UserDefaults on every change, restored after the
/// first load (window size and position are saved by AppKit's frame autosave).
struct SessionSnapshot: Codable, Equatable {
    enum Screen: String, Codable {
        case newChat, conversation, posts, calendar, media
    }

    var screen: Screen = .newChat
    var conversationId: EntityID?
    var brandId: EntityID?
    var sidebarPresented = true
    var inspectorPresented = true
    /// The right panel's pane (`RightPanelPane.rawValue`); missing in older snapshots.
    var inspectorPane: String?

    init(screen: Screen = .newChat, conversationId: EntityID? = nil, brandId: EntityID? = nil, sidebarPresented: Bool = true, inspectorPresented: Bool = true) {
        self.screen = screen
        self.conversationId = conversationId
        self.brandId = brandId
        self.sidebarPresented = sidebarPresented
        self.inspectorPresented = inspectorPresented
    }

    init(route: Route, brandId: EntityID?, sidebarPresented: Bool, inspectorPresented: Bool, inspectorPane: RightPanelPane? = nil) {
        switch route {
        case .newChat: screen = .newChat
        case .conversation(let id):
            screen = .conversation
            conversationId = id
        case .posts: screen = .posts
        case .calendar: screen = .calendar
        case .media: screen = .media
        }
        self.brandId = brandId
        self.sidebarPresented = sidebarPresented
        self.inspectorPresented = inspectorPresented
        self.inspectorPane = inspectorPane?.rawValue
    }

    /// The pane to reopen (an unknown or missing value: the details pane).
    var pane: RightPanelPane {
        inspectorPane.flatMap(RightPanelPane.init(rawValue:)) ?? .details
    }

    /// The route to reopen, given what exists now: an archived or deleted conversation falls
    /// back to a new chat instead of a dead screen.
    func route(existingConversations: Set<EntityID>) -> Route {
        switch screen {
        case .newChat: return .newChat
        case .posts: return .posts
        case .calendar: return .calendar
        case .media: return .media
        case .conversation:
            guard let conversationId, existingConversations.contains(conversationId) else { return .newChat }
            return .conversation(conversationId)
        }
    }

    /// The brand to select, if it still exists (not archived).
    func brand(existing: [EntityID]) -> EntityID? {
        guard let brandId, existing.contains(brandId) else { return nil }
        return brandId
    }
}

/// Reads and writes the snapshot (`studio.session`).
struct SessionStore {
    static let key = "studio.session"
    let defaults: UserDefaults
    var key: String = SessionStore.key

    func load() -> SessionSnapshot? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(SessionSnapshot.self, from: data)
    }

    func save(_ snapshot: SessionSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: key)
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}
