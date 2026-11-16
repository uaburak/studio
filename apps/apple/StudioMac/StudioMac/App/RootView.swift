import StudioKit
import SwiftUI

/// The window: collapsible sidebar, the centred detail, an optional right panel.
struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationSplitView(columnVisibility: $app.columnVisibility) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 200, ideal: Theme.sidebarWidth, max: 320)
        } detail: {
            DetailView()
                .inspector(isPresented: $app.inspectorPresented) {
                    InfoPanel()
                        .inspectorColumnWidth(min: 240, ideal: Theme.inspectorWidth, max: 360)
                }
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 860, minHeight: 560)
        .overlay {
            if let detail = app.detail {
                PostDetailOverlay(model: detail)
                    .transition(.identity)
            }
        }
        .overlay {
            if app.searchPresented {
                SearchPalette()
            }
        }
        .overlay(alignment: .top) {
            if let banner = app.banner {
                InlineError(message: banner) { app.banner = nil }
                    .frame(maxWidth: 420)
                    .padding(.top, 8)
            }
        }
    }
}

/// The detail column for the current route, with the window toolbar.
struct DetailView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.route {
            case .newChat:
                StartView()
            case .conversation(let id):
                ChatView(model: app.conversationModel(id))
                    .id(id)
            case .posts:
                PostsView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas)
        .navigationTitle(app.title)
        .toolbar(removing: .title)
        .toolbar { WindowToolbar() }
    }
}

/// Back / forward, the right-panel toggle and the "more" menu.
struct WindowToolbar: ToolbarContent {
    @Environment(AppModel.self) private var app

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { app.goBack() } label: { Label("Geri", systemImage: "chevron.left") }
                .disabled(!app.canGoBack)
                .help("Geri (⌘[)")
            Button { app.goForward() } label: { Label("İleri", systemImage: "chevron.right") }
                .disabled(!app.canGoForward)
                .help("İleri (⌘])")
        }
        ToolbarItem(placement: .navigation) {
            Menu {
                TitleMenu()
            } label: {
                HStack(spacing: 5) {
                    Text(app.title)
                        .font(Theme.titleFont)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                }
                .padding(.horizontal, 6)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Marka ve görünüm seçenekleri")
        }
        .sharedBackgroundVisibility(.hidden)
        ToolbarSpacer(.flexible)
        ToolbarItem(placement: .primaryAction) {
            Button { app.toggleInspector() } label: { Label("Sağ panel", systemImage: "sidebar.right") }
                .help(app.inspectorPresented ? "Sağ paneli gizle (⌥⌘I)" : "Sağ paneli göster (⌥⌘I)")
        }
        ToolbarItem(placement: .primaryAction) {
            MoreMenu()
        }
    }
}

/// The `···` menu: actions for the current screen.
struct MoreMenu: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Menu {
            switch app.route {
            case .conversation(let id):
                let model = app.conversationModel(id)
                Button("Yeniden adlandır…") { renamePrompt(model) }
                Button("Sohbeti arşivle") { Task { await model.archive() } }
            case .posts:
                Button("Yenile") { Task { await app.posts.load() } }
            case .newChat:
                EmptyView()
            }
            Divider()
            Button("Verileri yenile") { Task { await app.load() } }
            SettingsLink { Text("Ayarlar…") }
        } label: {
            Label("Diğer", systemImage: "ellipsis")
        }
        .menuIndicator(.hidden)
        .help("Diğer")
    }

    private func renamePrompt(_ model: ConversationModel) {
        let alert = NSAlert()
        alert.messageText = "Sohbeti yeniden adlandır"
        alert.addButton(withTitle: "Kaydet")
        alert.addButton(withTitle: "Vazgeç")
        let field = NSTextField(string: model.state?.conversation.title ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        if alert.runModal() == .alertFirstButtonReturn {
            let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !title.isEmpty { Task { await model.rename(to: title) } }
        }
    }
}

/// The title's `⌄` menu: brand for new chats and posts, months on the posts screen.
struct TitleMenu: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        switch app.route {
        case .newChat:
            brandPicker(disabled: !app.newChat.composer.drafts.isEmpty, help: "Eklenmiş görseller markaya bağlı; markayı değiştirmek için önce onları kaldır.")
        case .posts:
            brandPicker(disabled: false, help: nil)
            Divider()
            let months = app.posts.months
            if months.count > 1 {
                Section("Ay") {
                    ForEach(months, id: \.self) { month in
                        Toggle(TurkishFormat.monthTitle(month, currentYear: MonthKey(Date()).year), isOn: Binding(
                            get: { app.posts.month == month },
                            set: { if $0 { app.posts.month = month } }))
                    }
                }
            }
        case .conversation(let id):
            let brand = app.brand(app.conversations.first { $0.id == id }?.brandId)
            Text(brand.map { "Marka: \($0.name)" } ?? "Markasız sohbet")
            Button("Bu markanın postları") {
                if let brand { app.currentBrandId = brand.id }
                app.navigate(to: .posts)
            }
            .disabled(brand == nil)
        }
    }

    @ViewBuilder
    private func brandPicker(disabled: Bool, help: String?) -> some View {
        Section("Marka") {
            ForEach(app.brands) { brand in
                Toggle(brand.name, isOn: Binding(
                    get: { app.currentBrandId == brand.id },
                    set: { selected in
                        guard selected else { return }
                        app.currentBrandId = brand.id
                        app.newChat.updatePlaceholder()
                        if app.route == .posts { Task { await app.posts.load() } }
                    }))
                .disabled(disabled && app.currentBrandId != brand.id)
            }
        }
        .help(disabled ? (help ?? "") : "")
    }
}
