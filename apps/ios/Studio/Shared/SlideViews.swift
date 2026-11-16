import SwiftUI

/// One slide preview. Shows the image the Mac rendered; until the render
/// pipeline has produced one, an honest placeholder at the artboard's ratio.
/// Never renders the slide HTML on the phone (PLAN.md §9).
struct SlidePreview: View {
    let slide: Slide
    let index: Int
    let count: Int
    @Environment(AppModel.self) private var app
    @State private var image: UIImage?
    @State private var failed: APIError?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("Slayt \(index + 1) / \(count), Mac'te render edilmiş görsel")
            } else if slide.renderedAssetId == nil {
                placeholder(
                    symbol: "photo.badge.exclamationmark",
                    title: "Önizleme henüz yok",
                    message: "Mac bu slaytı render ettiğinde görsel burada görünecek.")
            } else if let failed {
                placeholder(symbol: "exclamationmark.triangle", title: "Görsel yüklenemedi", message: failed.title)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Slayt \(index + 1) yükleniyor")
            }
        }
        .aspectRatio(CGFloat(max(slide.width, 1)) / CGFloat(max(slide.height, 1)), contentMode: .fit)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: slide.renderedAssetId) { await load() }
    }

    private func load() async {
        guard let assetId = slide.renderedAssetId else { image = nil; return }
        do {
            image = try await app.images.image(assetId: assetId, api: app.api)
            failed = nil
        } catch {
            if error != .cancelled { failed = error }
        }
    }

    private func placeholder(symbol: String, title: String, message: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Text("\(slide.width) × \(slide.height)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Slayt \(index + 1) / \(count): \(title). \(message)")
    }
}

/// Swipeable carousel of slides with a page indicator.
struct SlideCarousel: View {
    let slides: [Slide]
    @Binding var index: Int
    var onOpen: (() -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            TabView(selection: $index) {
                ForEach(Array(slides.enumerated()), id: \.offset) { offset, slide in
                    SlidePreview(slide: slide, index: offset, count: slides.count)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                        .onTapGesture { onOpen?() }
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint("Büyütmek için dokunun")
                        .tag(offset)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .aspectRatio(aspect, contentMode: .fit)
            .accessibilityIdentifier("slideCarousel")

            if slides.count > 1 {
                Text("\(index + 1) / \(slides.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Slayt \(index + 1) / \(slides.count)")
            }
        }
    }

    private var aspect: CGFloat {
        guard let first = slides.first, first.height > 0 else { return 4 / 5 }
        return CGFloat(first.width) / CGFloat(first.height)
    }
}

/// Full-screen viewer: paging between slides, pinch and double-tap to zoom.
struct SlideViewer: View {
    let slides: [Slide]
    @State var index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TabView(selection: $index) {
                ForEach(Array(slides.enumerated()), id: \.offset) { offset, slide in
                    ZoomableView {
                        SlidePreview(slide: slide, index: offset, count: slides.count)
                    }
                    .tag(offset)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: slides.count > 1 ? .always : .never))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Slayt \(index + 1) / \(slides.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Kapat") { dismiss() }
                }
            }
        }
    }
}

/// Pinch to zoom (1×–5×), drag to pan while zoomed, double-tap to toggle 2×.
struct ZoomableView<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        content()
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnifyGesture()
                    .onChanged { value in scale = min(max(lastScale * value.magnification, 1), 5) }
                    .onEnded { _ in
                        lastScale = scale
                        if scale <= 1 { reset() }
                    }
            )
            .simultaneousGesture(
                DragGesture()
                    .onChanged { value in
                        guard scale > 1 else { return }
                        offset = CGSize(width: lastOffset.width + value.translation.width,
                                        height: lastOffset.height + value.translation.height)
                    }
                    .onEnded { _ in lastOffset = offset },
                isEnabled: scale > 1
            )
            .onTapGesture(count: 2) {
                withAnimation(.spring) {
                    if scale > 1 { reset() } else { scale = 2; lastScale = 2 }
                }
            }
            .accessibilityZoomAction { action in
                withAnimation {
                    switch action.direction {
                    case .zoomIn: scale = min(scale + 1, 5)
                    case .zoomOut: scale = max(scale - 1, 1)
                    }
                    lastScale = scale
                    if scale == 1 { reset() }
                }
            }
            .padding()
    }

    private func reset() {
        scale = 1
        lastScale = 1
        offset = .zero
        lastOffset = .zero
    }
}
