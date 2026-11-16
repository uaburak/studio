import StudioKit
import SwiftUI

/// "Ara" (⌘K): conversations and posts by title, on a glass panel.
struct SearchPalette: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""
    @State private var index = 0
    @FocusState private var focused: Bool

    private enum Result: Identifiable {
        case conversation(Conversation)
        case post(PostCard)

        var id: String {
            switch self {
            case .conversation(let c): "c-" + c.id
            case .post(let p): "p-" + p.id
            }
        }
    }

    private var results: [Result] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased(with: TurkishFormat.locale)
        let conversations = app.conversations
            .filter { q.isEmpty || $0.displayTitle.lowercased(with: TurkishFormat.locale).contains(q) }
            .prefix(q.isEmpty ? 6 : 12)
            .map(Result.conversation)
        let posts = app.posts.board.cards
            .filter { !q.isEmpty && $0.title.lowercased(with: TurkishFormat.locale).contains(q) }
            .prefix(8)
            .map(Result.post)
        return conversations + posts
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.08)
                .ignoresSafeArea()
                .onTapGesture { app.searchPresented = false }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.textSecondary)
                    TextField("Sohbetlerde ve postlarda ara", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15))
                        .focused($focused)
                        .onSubmit(openSelected)
                        .onKeyPress(.downArrow) { move(1); return .handled }
                        .onKeyPress(.upArrow) { move(-1); return .handled }
                }
                .padding(.horizontal, 16)
                .frame(height: 44)
                if !results.isEmpty {
                    Hairline()
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(results.enumerated()), id: \.element.id) { offset, result in
                            Button { open(result) } label: {
                                row(result)
                                    .padding(.horizontal, 12)
                                    .frame(height: 32)
                                    .background(Capsule().fill(offset == index ? Theme.fillStrong : .clear))
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(6)
                } else if !query.isEmpty {
                    Text("Sonuç yok").font(Theme.captionFont).foregroundStyle(Theme.textSecondary).padding(16)
                }
            }
            .frame(width: 520)
            .glassEffect(Theme.floatingGlass, in: .rect(cornerRadius: 22))
            .padding(.top, 90)
        }
        .onAppear { focused = true }
        .onExitCommand { app.searchPresented = false }
        .onChange(of: query) { index = 0 }
    }

    @ViewBuilder
    private func row(_ result: Result) -> some View {
        switch result {
        case .conversation(let conversation):
            HStack(spacing: 10) {
                Image(systemName: "bubble.left").font(.system(size: 11)).foregroundStyle(Theme.textSecondary).frame(width: 16)
                Text(conversation.displayTitle).font(Theme.rowFont).foregroundStyle(Theme.textPrimary)
                Spacer()
                Text(app.brand(conversation.brandId)?.name ?? "").font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
            }
        case .post(let card):
            HStack(spacing: 10) {
                Image(systemName: "square.grid.2x2").font(.system(size: 11)).foregroundStyle(Theme.textSecondary).frame(width: 16)
                Text(card.title).font(Theme.rowFont).foregroundStyle(Theme.textPrimary)
                Spacer()
                PostStateLabel(state: card.state)
            }
        }
    }

    private func move(_ delta: Int) {
        guard !results.isEmpty else { return }
        index = (index + delta + results.count) % results.count
    }

    private func openSelected() {
        if let result = results[safe: index] { open(result) }
    }

    private func open(_ result: Result) {
        app.searchPresented = false
        switch result {
        case .conversation(let conversation):
            app.navigate(to: .conversation(conversation.id))
        case .post(let card):
            app.navigate(to: .posts)
            app.detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        }
    }
}
