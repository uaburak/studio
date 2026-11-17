import AppKit
import StudioKit

/// Rename / archive a conversation: one menu shared by the sidebar row ("…" and right-click)
/// and the title chevron in the top bar.
@MainActor
enum ConversationActions {
    static let renameTitle = "Yeniden adlandır…"
    static let archiveTitle = "Sohbeti arşivle"

    /// The menu items, in order (tests read the titles).
    static func makeMenu(app: AppModel, conversationId: EntityID, window: @escaping @MainActor () -> NSWindow?) -> NSMenu {
        let menu = NSMenu()
        for item in items(app: app, conversationId: conversationId, window: window) { menu.addItem(item) }
        return menu
    }

    static func items(app: AppModel, conversationId: EntityID, window: @escaping @MainActor () -> NSWindow?) -> [NSMenuItem] {
        [
            ClosureMenuItem(title: renameTitle) { [weak app] in
                guard let app else { return }
                promptRename(app: app, conversationId: conversationId, window: window())
            },
            ClosureMenuItem(title: archiveTitle) { [weak app] in
                guard let app else { return }
                // Through the app: no stream is opened just to archive, errors reach the banner.
                Task { await app.archiveConversation(conversationId) }
            },
        ]
    }

    static func promptRename(app: AppModel, conversationId: EntityID, window: NSWindow?) {
        let current = app.conversationModels[conversationId]?.state?.conversation.title
            ?? app.conversations.first { $0.id == conversationId }?.title ?? ""
        let alert = NSAlert()
        alert.messageText = "Sohbeti yeniden adlandır"
        alert.addButton(withTitle: "Kaydet")
        alert.addButton(withTitle: "Vazgeç")
        let field = NSTextField(string: current)
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .alertFirstButtonReturn else { return }
            let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, title != current else { return }
            Task { await app.renameConversation(conversationId, to: title) }
        }
        if let window {
            alert.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(alert.runModal())
        }
    }
}
