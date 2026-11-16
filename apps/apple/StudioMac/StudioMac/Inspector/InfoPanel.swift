import StudioKit
import SwiftUI

/// Right panel (01): brand and connected accounts, this conversation's posts,
/// background jobs from the job stream.
struct InfoPanel: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                BrandSection(brandId: app.routeBrandId)
                if case .conversation(let id) = app.route {
                    Hairline().padding(.vertical, 12)
                    ConversationPostsSection(model: app.conversationModel(id))
                }
                Hairline().padding(.vertical, 12)
                JobsSection(brandId: app.routeBrandId)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
        .scrollIndicators(.never)
        .background(Theme.canvas)
    }
}

private struct BrandSection: View {
    @Environment(AppModel.self) private var app
    let brandId: EntityID?
    @State private var explainAccount: SocialAccount?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle("Marka").padding(.bottom, 8)
            if let brand = app.brand(brandId) {
                InfoRow(symbol: "circle.fill", symbolColor: Theme.textSecondary, title: brand.name)
                let accounts = app.accounts(of: brand.id)
                ForEach(Platform.knownCases, id: \.self) { platform in
                    let account = accounts.first { $0.platform == platform }
                    InfoRow(symbol: "circle.dotted.circle", symbolColor: Theme.textTertiary, title: platform.displayName) {
                        accountStatus(account, platform: platform)
                    }
                }
            } else {
                Text("Bu sohbetin markası yok.").font(Theme.captionFont).foregroundStyle(Theme.textSecondary)
            }
        }
    }

    @ViewBuilder
    private func accountStatus(_ account: SocialAccount?, platform: Platform) -> some View {
        if let account, account.status == .connected {
            Text("Bağlı").font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
                .help(account.handle)
        } else {
            Button(account?.status == .needsReauth ? "Yeniden bağla" : "Bağla") { explainAccount = account ?? SocialAccount(id: platform.rawValue, brandId: brandId ?? "", platform: platform, handle: "", status: .pending, createdAt: .now, updatedAt: .now) }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .popover(item: Binding(get: { explainAccount?.platform == platform ? explainAccount : nil }, set: { explainAccount = $0 })) { _ in
                    Text("\(platform.displayName) bağlantısı yayın aşamasında (Faz 3) gelecek. Hesap şimdilik \"bekliyor\" durumunda; zamanlama kaydedilir ama paylaşım yapılmaz.")
                        .font(Theme.captionFont)
                        .frame(width: 260)
                        .padding(14)
                }
        }
    }
}

private struct ConversationPostsSection: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel

    var body: some View {
        let cards = model.contentIds.compactMap { app.posts.card($0) }
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle("Bu sohbetin postları").padding(.bottom, 8)
            if cards.isEmpty {
                Text(model.contentIds.isEmpty ? "Plan onaylanınca postlar burada görünür." : "Postlar yükleniyor…")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.vertical, 6)
            } else {
                ForEach(cards.prefix(3)) { card in
                    Button {
                        app.detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
                    } label: {
                        HStack(spacing: 12) {
                            PostThumbnail(card: card)
                                .frame(width: 30, height: 38)
                            Text(card.title).font(Theme.rowFont).foregroundStyle(Theme.textPrimary).lineLimit(1)
                            Spacer()
                        }
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Button("Tümünü göster") { app.navigate(to: .posts) }
                    .buttonStyle(.plain)
                    .font(Theme.smallFont)
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.top, 6)
            }
        }
        .task { if app.posts.board.cards.isEmpty { await app.posts.load() } }
    }
}

private struct JobsSection: View {
    @Environment(AppModel.self) private var app
    let brandId: EntityID?
    @State private var showFinished = false

    var body: some View {
        let jobs = app.jobBoard.jobs.filter { brandId == nil || $0.brandId == brandId || $0.brandId == nil }
        let active = jobs.filter { $0.status.isActive }
        let finished = jobs.filter { $0.status.isTerminal && ($0.finishedAt ?? $0.updatedAt) > Date().addingTimeInterval(-86_400) }
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                SectionTitle("Arka plan işleri")
                if !app.jobBoard.state.isLive {
                    Text(app.jobBoard.state == .polling ? "yenileniyor" : "bağlanıyor")
                        .font(Theme.smallFont).foregroundStyle(Theme.textTertiary)
                        .help("Canlı akış kopuk; iş listesi aralıklarla yenileniyor.")
                }
            }
            .padding(.bottom, 8)
            if active.isEmpty && finished.isEmpty {
                Text("Şu an iş yok.").font(Theme.captionFont).foregroundStyle(Theme.textSecondary).padding(.vertical, 6)
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(active) { job in
                        InfoRow(symbol: "diamond", symbolColor: Theme.textSecondary, title: job.displayTitle) {
                            HStack(spacing: 8) {
                                Text(job.status == .running ? TurkishFormat.elapsed(from: job.startedAt ?? job.updatedAt, to: context.date) : "sırada")
                                    .font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
                                StatusDot(color: Theme.accent)
                            }
                        }
                        .help(job.progressMessage ?? (job.status == .queued ? (app.isOnline ? "Sırada" : "Mac çevrimdışı; Mac açılınca çalışır.") : "Çalışıyor"))
                        .contextMenu {
                            Button("İşi iptal et") { Task { _ = try? await app.dataService.cancelJob(job.id) } }
                        }
                    }
                }
            }
            if !finished.isEmpty {
                Button { withAnimation(.snappy) { showFinished.toggle() } } label: {
                    InfoRow(symbol: "diamond", symbolColor: Theme.textSecondary, title: "\(finished.count) iş bitti") {
                        Image(systemName: showFinished ? "chevron.down" : "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.textTertiary)
                    }
                }
                .buttonStyle(.plain)
                if showFinished {
                    ForEach(finished) { job in
                        HStack {
                            Text(job.displayTitle).font(Theme.captionFont).foregroundStyle(Theme.textSecondary).lineLimit(1)
                            Spacer()
                            Text(label(job.status)).font(Theme.smallFont).foregroundStyle(Theme.textTertiary)
                        }
                        .padding(.leading, 26)
                        .padding(.vertical, 4)
                    }
                }
            }
        }
    }

    private func label(_ status: JobStatus) -> String {
        switch status {
        case .succeeded: "bitti"
        case .failed: "hata"
        case .cancelled: "iptal"
        default: ""
        }
    }
}

/// Icon, title, trailing accessory; 31 pt like the drafts.
struct InfoRow<Trailing: View>: View {
    var symbol: String
    var symbolColor: Color
    var title: String
    @ViewBuilder var trailing: Trailing

    init(symbol: String, symbolColor: Color, title: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.symbol = symbol
        self.symbolColor = symbolColor
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: symbol == "circle.fill" ? 9 : 11))
                .foregroundStyle(symbolColor)
                .frame(width: 16)
            Text(title).font(Theme.rowFont).foregroundStyle(Theme.textPrimary).lineLimit(1)
            Spacer(minLength: 8)
            trailing
        }
        .frame(height: 31)
    }
}

/// A tiny post swatch: the rendered image, or the placeholder tone.
struct PostThumbnail: View {
    let card: PostCard

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
        Group {
            if let rendered = card.renderedAssetIds.first, !card.needsImage {
                AssetImage(assetId: rendered)
            } else {
                switch card.placeholderTone {
                case .dark: shape.fill(Theme.postDark)
                case .light: shape.fill(Theme.postLight)
                case .muted: shape.fill(Theme.postMuted).overlay(Image(systemName: "plus").font(.system(size: 9)).foregroundStyle(Theme.accent))
                }
            }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(Theme.border))
    }
}
