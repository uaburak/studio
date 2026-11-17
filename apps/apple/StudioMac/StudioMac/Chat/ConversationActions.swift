import AppKit
import StudioKit

/// Rename / archive a conversation: one menu shared by the sidebar row ("…" and right-click)
/// and the title chevron in the top bar.
@MainActor
enum ConversationActions {
    static let renameTitle = "Yeniden adlandır"
    static let archiveTitle = "Arşivle"

    /// The menu items, in order (tests read the titles).
    static func makeMenu(app: AppModel, conversationId: EntityID, window: @escaping @MainActor () -> NSWindow?) -> NSMenu {
        let menu = NSMenu()
        for item in items(app: app, conversationId: conversationId, window: window) { menu.addItem(item) }
        return menu
    }

    static func items(app: AppModel, conversationId: EntityID, window: @escaping @MainActor () -> NSWindow?) -> [NSMenuItem] {
        let rename = ClosureMenuItem(title: renameTitle) { [weak app] in
            guard let app else { return }
            // In the top bar the title turns into a text field; elsewhere a small prompt.
            if let topBar = window()?.contentView?.firstDescendant(of: TopBarTitleControl.self), topBar.canRenameInline {
                topBar.beginRename()
            } else {
                promptRename(app: app, conversationId: conversationId, window: window())
            }
        }
        rename.keyEquivalent = "r"
        rename.keyEquivalentModifierMask = []
        let archive = ClosureMenuItem(title: archiveTitle) { [weak app] in
            guard let app else { return }
            // Through the app: no stream is opened just to archive, errors reach the banner.
            Task { await app.archiveConversation(conversationId) }
        }
        archive.keyEquivalent = "a"
        archive.keyEquivalentModifierMask = []
        return [rename, archive]
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
