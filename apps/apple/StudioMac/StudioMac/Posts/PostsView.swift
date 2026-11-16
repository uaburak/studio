import StudioKit
import SwiftUI
import UniformTypeIdentifiers

/// Posts (05): month title, status filter, 4:5 cards with date + status, floating approve bar.
struct PostsView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var posts = app.posts
        let cards = posts.visibleCards
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                if let error = posts.error {
                    InlineError(message: error) { posts.error = nil }
                }
                if cards.isEmpty && !posts.isLoading {
                    empty
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 180, maximum: 260), spacing: 20, alignment: .top)], alignment: .leading, spacing: 26) {
                        ForEach(cards) { card in
                            PostGridCell(card: card)
                        }
                    }
                }
            }
            .frame(maxWidth: 960)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 76)
            .padding(.top, 30)
            .padding(.bottom, 90)
        }
        .scrollEdgeEffectStyle(.soft, for: .all)
        .overlay(alignment: .bottom) {
            if !posts.approvable.isEmpty {
                ApproveBar(count: posts.approvable.count, isApproving: posts.isApproving) {
                    Task { await posts.approveReady() }
                }
                .padding(.bottom, 18)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.25), value: posts.approvable.count)
        .task(id: app.currentBrandId) { await posts.load() }
    }

    private var header: some View {
        @Bindable var posts = app.posts
        let counts = posts.counts
        return HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(TurkishFormat.monthTitle(posts.month, currentYear: MonthKey(Date()).year))
                    .font(.system(size: 28, weight: .bold))
                    .tracking(-0.4)
                    .foregroundStyle(Theme.textPrimary)
                Text("\(app.brand(app.currentBrandId)?.name ?? "Marka seçilmedi") · \(counts[.all] ?? 0) post")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer(minLength: 20)
            FilterPills(selection: $posts.filter, counts: counts)
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Text(app.posts.filter == .all ? "Bu ayda post yok." : "Bu filtrede post yok.")
                .font(Theme.chatFont)
                .foregroundStyle(Theme.textSecondary)
            if app.posts.filter == .all {
                Text("Postlar sohbette onaylanan planlardan gelir.")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }
}

/// A card and its date / status line. Clicking zooms it open.
private struct PostGridCell: View {
    @Environment(AppModel.self) private var app
    let card: PostCard
    @State private var frame: CGRect = .zero
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PostPlaceholder(card: card, scale: 1)
                .aspectRatio(4 / 5, contentMode: .fit)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
                .scaleEffect(hovering ? 1.012 : 1)
                .shadow(color: .black.opacity(hovering ? 0.08 : 0), radius: 10, y: 4)
                .opacity(app.detail?.card.id == card.id ? 0 : 1)
                .onHover { hovering = $0 }
                .animation(.snappy(duration: 0.18), value: hovering)
                .onTapGesture(perform: open)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel("\(card.title), \(card.state.label)")
                .accessibilityAction(named: "Aç", open)
            HStack {
                Text(card.day.map(TurkishFormat.shortDay) ?? "Tarih yok")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                PostStateLabel(state: card.state)
            }
            .padding(.horizontal, 3)
        }
    }

    private func open() {
        app.detail = PostDetailModel(app: app, card: card, sourceFrame: frame)
    }
}

/// The neutral post placeholder (no live HTML): eyebrow, title, image slot; or the rendered image.
struct PostPlaceholder: View {
    @Environment(AppModel.self) private var app
    let card: PostCard
    /// 1 = grid card, ~2.2 = opened post.
    var scale: CGFloat
    var showsSlotArea = false
    var onDropImage: ((URL) -> Void)?
    var onPickImage: (() -> Void)?

    var body: some View {
        let tone = card.placeholderTone
        let radius = Theme.cardRadius * (scale > 1 ? 0 : 1)
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(background(tone))
            if let rendered = card.renderedAssetIds.first, !card.needsImage {
                AssetImage(assetId: rendered)
                    .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            } else {
                VStack(alignment: .leading, spacing: 6 * scale) {
                    if let eyebrow = card.eyebrow {
                        Text(eyebrow)
                            .font(.system(size: 8.5 * min(scale, 1.55), weight: .bold))
                            .tracking(0.6 * min(scale, 1.55))
                            .foregroundStyle(Theme.accent)
                    }
                    Text(TurkishFormat.upper(card.title))
                        .font(.system(size: 16 * scale, weight: .heavy))
                        .foregroundStyle(foreground(tone))
                        .lineLimit(3)
                        .minimumScaleFactor(0.7)
                        .fixedSize(horizontal: false, vertical: true)
                    if showsSlotArea, card.needsImage || card.state == .imageUploaded {
                        LargeSlot(card: card, onDropImage: onDropImage, onPickImage: onPickImage)
                            .padding(.top, 6)
                    } else {
                        Spacer(minLength: 0)
                        if card.needsImage || card.state == .imageUploaded {
                            SmallSlot(card: card, onDropImage: onDropImage, onPickImage: onPickImage)
                        }
                    }
                }
                .padding(.horizontal, 14 * min(scale, 1.7))
                .padding(.top, 16 * min(scale, 1.7))
                .padding(.bottom, 16 * min(scale, 1.7))
            }
        }
        .overlay {
            if tone == .light || tone == .dark {
                RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.border.opacity(tone == .light ? 1 : 0.6), lineWidth: 1)
            }
        }
        .compositingGroup()
    }

    private func background(_ tone: PlaceholderTone) -> Color {
        switch tone {
        case .light: Theme.postLight
        case .dark: Theme.postDark
        case .muted: scale > 1 ? Theme.postDark : Theme.postMuted
        }
    }

    private func foreground(_ tone: PlaceholderTone) -> Color {
        switch tone {
        case .light: Theme.postLightText
        case .dark: Theme.postDarkText
        case .muted: scale > 1 ? Theme.postDarkText : Theme.postMutedText
        }
    }
}

/// Grid card slot: dashed orange `+` and "Görsel ekle"; drop an image here to upload it.
private struct SmallSlot: View {
    @Environment(AppModel.self) private var app
    let card: PostCard
    var onDropImage: ((URL) -> Void)?
    var onPickImage: (() -> Void)?
    @State private var targeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let progress = app.posts.slotUploads[card.id] {
                ProgressView(value: progress)
                    .progressViewStyle(.circular)
                    .controlSize(.small)
                    .frame(width: 36, height: 36)
                Text("Yükleniyor").font(.system(size: 10)).foregroundStyle(Theme.textSecondary)
            } else if card.state == .imageUploaded {
                ZStack {
                    Circle().fill(Theme.canvas)
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                }
                .frame(width: 36, height: 36)
                Text("Görsel yüklendi").font(.system(size: 10)).foregroundStyle(Theme.textSecondary)
            } else {
                Button { pick() } label: {
                    ZStack {
                        Circle().strokeBorder(Theme.accent, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .background(Circle().fill(targeted ? Theme.accent.opacity(0.12) : .clear))
                        Image(systemName: "plus").font(.system(size: 13, weight: .regular)).foregroundStyle(Theme.accent)
                    }
                    .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .help("Görsel ekle: tıkla ya da görseli buraya sürükle")
                Text("Görsel ekle").font(.system(size: 10)).foregroundStyle(Theme.textSecondary)
            }
        }
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            handleDrop(providers)
        }
    }

    private func pick() {
        if let onPickImage { onPickImage(); return }
        guard let url = ImageImport.pick(multiple: false).first else { return }
        upload(url)
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        _ = provider.loadObject(ofClass: URL.self) { url, _ in
            guard let url else { return }
            Task { @MainActor in upload(url) }
        }
        return true
    }

    private func upload(_ url: URL) {
        if let onDropImage { onDropImage(url); return }
        app.posts.uploadSlotImage(card: card, url: url)
    }
}

/// Opened post slot (06): the dashed rounded area, "Görsel ekle / sürükle ya da seç".
private struct LargeSlot: View {
    let card: PostCard
    var onDropImage: ((URL) -> Void)?
    var onPickImage: (() -> Void)?
    @State private var targeted = false

    var body: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(targeted ? Theme.slotFill.opacity(0.7) : Theme.slotFill)
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.accent, style: StrokeStyle(lineWidth: 1.2, dash: [5, 4])))
            .overlay {
                VStack(spacing: 4) {
                    Text("Görsel ekle").font(.system(size: 13, weight: .medium)).foregroundStyle(Color.white.opacity(0.75))
                    Text("sürükle ya da seç").font(.system(size: 10)).foregroundStyle(Color.white.opacity(0.45))
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { onPickImage?() }
            .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
                guard let provider = providers.first else { return false }
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in onDropImage?(url) }
                }
                return true
            }
            .accessibilityLabel("Görsel ekle")
            .accessibilityAddTraits(.isButton)
    }
}

/// `● 3 post onaya hazır  [Onayla]` floating on Liquid Glass.
struct ApproveBar: View {
    let count: Int
    let isApproving: Bool
    let approve: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            StatusDot(color: Theme.ink)
            Text("\(count) post onaya hazır")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
            Button(action: approve) {
                HStack(spacing: 6) {
                    if isApproving { ProgressView().controlSize(.mini).tint(.white) }
                    Text("Onayla")
                }
            }
            .buttonStyle(PillButtonStyle(kind: .primary, height: 28))
            .disabled(isApproving)
            .help("Hazır postların hepsini gösterilen sürümleriyle onayla")
        }
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .glassEffect(Theme.floatingGlass, in: .capsule)
    }
}

/// Status filter (05): grey pill track, the selected segment a raised white pill, counts in grey.
struct FilterPills: View {
    @Binding var selection: PostFilter
    var counts: [PostFilter: Int]
    @Namespace private var selectionSpace

    var body: some View {
        HStack(spacing: 2) {
            ForEach(PostFilter.allCases, id: \.self) { filter in
                let selected = filter == selection
                Button {
                    withAnimation(.snappy(duration: 0.22)) { selection = filter }
                } label: {
                    HStack(spacing: 6) {
                        Text(filter.label).foregroundStyle(selected ? Theme.textPrimary : Theme.textSecondary)
                        Text("\(counts[filter] ?? 0)").foregroundStyle(Theme.textSecondary)
                    }
                    .font(.system(size: 12, weight: selected ? .semibold : .regular))
                    .padding(.horizontal, 12)
                    .frame(height: 26)
                    .background {
                        if selected {
                            Capsule()
                                .fill(Theme.canvas)
                                .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
                                .matchedGeometryEffect(id: "selection", in: selectionSpace)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
        .padding(2)
        .background(Capsule().fill(Theme.fill))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Durum filtresi")
    }
}
