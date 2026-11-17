import AppKit
import StudioKit

/// The menus of the top bar: the title's chevron and the "…" icon.
@MainActor
enum TopBarMenus {
    static let lockedBrandHelp = "Eklenmiş görseller markaya bağlı; markayı değiştirmek için önce onları kaldır."

    /// The title chevron: a conversation's own actions (Claude Code), else the screen's brand
    /// (and the month on Postlar).
    static func titleMenu(app: AppModel, window: @escaping @MainActor () -> NSWindow?) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        switch app.route {
        case .newChat:
            appendBrandItems(to: menu, app: app, locked: !app.newChat.composer.drafts.isEmpty)
        case .posts:
            appendBrandItems(to: menu, app: app, locked: false)
            let months = app.posts.months
            if months.count > 1 {
                menu.addItem(.separator())
                menu.addItem(.sectionHeader(title: "Ay"))
                let currentYear = MonthKey(Date()).year
                for month in months {
                    let item = ClosureMenuItem(title: TurkishFormat.monthTitle(month, currentYear: currentYear)) { [weak app] in
                        app?.posts.month = month
                    }
                    item.state = app.posts.month == month ? .on : .off
                    menu.addItem(item)
                }
            }
        case .calendar, .media:
            appendBrandItems(to: menu, app: app, locked: false)
        case .conversation(let id):
            for item in ConversationActions.items(app: app, conversationId: id, window: window) {
                menu.addItem(item)
            }
            menu.addItem(.separator())
            let brand = app.brand(app.conversations.first { $0.id == id }?.brandId)
            let info = NSMenuItem(title: brand.map { "Marka: \($0.name)" } ?? "Markasız sohbet", action: nil, keyEquivalent: "")
            info.isEnabled = false
            menu.addItem(info)
            let posts = ClosureMenuItem(title: "Bu markanın postları") { [weak app] in
                guard let app else { return }
                if let brandId = brand?.id { app.currentBrandId = brandId }
                app.navigate(to: .posts)
            }
            posts.isEnabled = brand != nil
            menu.addItem(posts)
        }
        return menu
    }

    private static func appendBrandItems(to menu: NSMenu, app: AppModel, locked: Bool) {
        menu.addItem(.sectionHeader(title: "Marka"))
        for brand in app.brands {
            let item = ClosureMenuItem(title: brand.name) { [weak app] in app?.selectBrand(brand.id) }
            item.state = app.currentBrandId == brand.id ? .on : .off
            if locked && app.currentBrandId != brand.id {
                item.isEnabled = false
                item.toolTip = lockedBrandHelp
            }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "Yeni marka…") { [weak app] in app?.newBrandPresented = true })
        if let brandId = app.currentBrandId {
            menu.addItem(ClosureMenuItem(title: "Marka ayarları…") { [weak app] in app?.openBrandSettings(brandId) })
        }
    }

    /// The "…" icon: refresh what the screen shows, search, settings.
    static func moreMenu(app: AppModel) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        switch app.route {
        case .posts:
            menu.addItem(ClosureMenuItem(title: "Postları yenile") { [weak app] in
                guard let app else { return }
                Task { await app.posts.load() }
            })
        case .calendar:
            menu.addItem(ClosureMenuItem(title: "Takvimi yenile") { [weak app] in
                guard let app else { return }
                Task { await app.calendar.load() }
            })
        case .media:
            menu.addItem(ClosureMenuItem(title: "Medyayı yenile") { [weak app] in
                guard let app else { return }
                Task { await app.media.load() }
            })
        case .newChat, .conversation:
            break
        }
        let reload = ClosureMenuItem(title: "Verileri yenile") { [weak app] in
            guard let app else { return }
            Task { await app.load() }
        }
        reload.isEnabled = !app.isLoading
        menu.addItem(reload)
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "Ara… (⌘K)") { [weak app] in app?.searchPresented = true })
        menu.addItem(ClosureMenuItem(title: app.sidebarPresented ? "Kenar çubuğunu gizle" : "Kenar çubuğunu göster") { [weak app] in
            app?.toggleSidebar()
        })
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "Ayarlar…") { [weak app] in app?.openSettings() })
        return menu
    }
}
