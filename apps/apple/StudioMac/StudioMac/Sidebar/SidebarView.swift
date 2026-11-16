import StudioKit
import SwiftUI

/// Left sidebar: Yeni sohbet, Ara, Postlar, Takvim; brands with their
/// conversations as collapsible groups; the user row at the bottom.
struct SidebarView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        List(selection: $app.sidebarSelection) {
            Section {
                Button { app.startNewChat() } label: {
                    Label("Yeni sohbet", systemImage: "plus")
                }
                .buttonStyle(.plain)
                .help("Yeni sohbet (⌘N)")

                Button { app.searchPresented = true } label: {
                    Label("Ara", systemImage: "magnifyingglass")
                }
                .buttonStyle(.plain)
                .help("Sohbetlerde ve postlarda ara (⌘K)")

                Label("Postlar", systemImage: "square.grid.2x2")
                    .tag(SidebarItem.posts)

                Label {
                    HStack {
                        Text("Takvim")
                        Spacer()
                        Text("yakında").font(Theme.smallFont).foregroundStyle(Theme.textTertiary)
                    }
                } icon: {
                    Image(systemName: "calendar")
                }
                .foregroundStyle(Theme.textTertiary)
                .selectionDisabled()
                .help("Takvim ekranı henüz tasarlanmadı. Zamanlanan postlar Postlar ekranında görünür.")
            }

            ForEach(app.sidebarBrands) { brand in
                BrandGroup(brand: brand, conversations: app.conversations(of: brand.id))
            }
            if !app.unbrandedConversations.isEmpty {
                Section {
                    ForEach(app.unbrandedConversations) { conversation in
                        ConversationRow(conversation: conversation)
                    }
                } header: {
                    Text("Markasız")
                }
            }
            if let error = app.loadError {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(error).font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
                        Button("Yeniden dene") { Task { await app.load() } }
                            .buttonStyle(.pillSecondary)
                    }
                    .selectionDisabled()
                }
            }
        }
        .listStyle(.sidebar)
        .font(Theme.rowFont)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            UserRow()
        }
    }
}

/// `MTM Agro ⌄` and its conversations.
private struct BrandGroup: View {
    @Environment(AppModel.self) private var app
    var brand: Brand
    var conversations: [Conversation]

    var body: some View {
        let expanded = app.expandedBrands.contains(brand.id)
        Section {
            if expanded {
                ForEach(conversations) { conversation in
                    ConversationRow(conversation: conversation)
                }
                if conversations.isEmpty {
                    Text("Henüz sohbet yok")
                        .font(Theme.captionFont)
                        .foregroundStyle(Theme.textTertiary)
                        .selectionDisabled()
                }
            }
        } header: {
            Button {
                withAnimation(.snappy(duration: 0.2)) { app.toggleBrand(brand.id) }
            } label: {
                HStack(spacing: 4) {
                    Text(brand.name)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                }
                .font(Theme.captionFont)
                .foregroundStyle(Theme.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(brand.name), \(expanded ? "daralt" : "genişlet")")
        }
    }
}

private struct ConversationRow: View {
    @Environment(AppModel.self) private var app
    var conversation: Conversation

    var body: some View {
        HStack(spacing: 6) {
            Text(conversation.displayTitle)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            if conversation.activeRunId != nil {
                StatusDot(color: Theme.accent)
                    .help("Yanıt bekleniyor")
            }
        }
        .tag(SidebarItem.conversation(conversation.id))
        .contextMenu {
            Button("Sohbeti arşivle") { Task { await app.conversationModel(conversation.id).archive() } }
        }
    }
}

/// `● Burak  ⚙` with the appearance switch one click away.
private struct UserRow: View {
    @Environment(AppModel.self) private var app
    @Environment(AppSettings.self) private var settings

    var body: some View {
        HStack(spacing: 10) {
            Menu {
                Section("Görünüm") {
                    ForEach(AppearancePreference.allCases) { option in
                        Toggle(isOn: Binding(get: { settings.appearance == option }, set: { if $0 { settings.appearance = option } })) {
                            Label(option.label, systemImage: option.symbol)
                        }
                    }
                }
                Divider()
                Button("Ayarlar…") { app.settingsPresented = true }
            } label: {
                HStack(spacing: 10) {
                    Circle().fill(Theme.accent).frame(width: 20, height: 20)
                    Text("Burak").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textPrimary)
                }
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Görünüm ve ayarlar")
            Spacer()
            Button { app.settingsPresented = true } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 13))
            }
            .buttonStyle(GlyphButtonStyle())
            .help("Ayarlar (⌘,)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
