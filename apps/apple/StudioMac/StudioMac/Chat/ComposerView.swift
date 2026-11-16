import StudioKit
import SwiftUI
import UniformTypeIdentifiers

/// The pill composer: attachment chips, the text view, attach / dictate / send.
/// Floats over the conversation on Liquid Glass; the `@` suggestions morph out of it.
struct ComposerView: View {
    @Bindable var model: ComposerModel
    var focusRequest: Int = 0
    var isBusy: Bool = false
    /// When set, the send button becomes a stop button that cancels the active run.
    var onStop: (() -> Void)?
    var onSend: () -> Void

    @Namespace private var glass
    @State private var isTargeted = false

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            VStack(spacing: 8) {
                if model.isSuggesting {
                    MentionSuggestionList(model: model)
                        .glassEffect(Theme.floatingGlass, in: .rect(cornerRadius: 18))
                        .glassEffectID("suggestions", in: glass)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                field
                    .glassEffect(Theme.floatingGlass.interactive(), in: .rect(cornerRadius: Theme.composerHeight / 2))
                    .glassEffectID("composer", in: glass)
            }
        }
        // Glass normally dims when the window loses key status (e.g. Settings open);
        // keep the composer rendered as if the window were active so it never changes colour.
        .environment(\.controlActiveState, .key)
        .animation(.snappy(duration: 0.22), value: model.isSuggesting)
        .onDrop(of: [.fileURL, .image], isTargeted: $isTargeted) { providers in
            loadDropped(providers)
            return true
        }
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.drafts.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.drafts) { draft in
                            AttachmentChip(model: model, draft: draft)
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .scrollClipDisabled()
            }
            ForEach(model.errors, id: \.self) { message in
                Text(message).font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
            }
            HStack(alignment: .bottom, spacing: 10) {
                Button(action: pick) {
                    Image(systemName: "plus").font(.system(size: 14, weight: .regular))
                }
                .buttonStyle(GlyphButtonStyle())
                .disabled(!model.canAttach)
                .help(model.attachDisabledReason ?? "Görsel ekle (yapıştır ya da sürükle de olur)")
                .accessibilityLabel("Görsel ekle")

                ComposerTextView(model: model, focusRequest: focusRequest, onSubmit: submit) { images, errors in
                    model.errors = errors
                    model.add(images)
                }
                .padding(.bottom, 1)

                Button(action: dictate) {
                    Image(systemName: "mic").font(.system(size: 13))
                }
                .buttonStyle(GlyphButtonStyle())
                .help("Dikte et (sistem dikte özelliği)")
                .accessibilityLabel("Dikte et")

                if let onStop {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill").font(.system(size: 10))
                    }
                    .buttonStyle(GlyphButtonStyle())
                    .help("Yanıtı durdur")
                    .accessibilityLabel("Yanıtı durdur")
                } else {
                    Button(action: submit) {
                        if isBusy {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "return").font(.system(size: 13))
                        }
                    }
                    .buttonStyle(GlyphButtonStyle())
                    .disabled(!model.canSend || isBusy)
                    .help(model.sendBlockedReason ?? "Gönder (↩), yeni satır (⇧↩)")
                    .accessibilityLabel("Gönder")
                }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .padding(.vertical, 10)
        .frame(minHeight: Theme.composerHeight)
        .overlay {
            RoundedRectangle(cornerRadius: Theme.composerHeight / 2, style: .continuous)
                .strokeBorder(isTargeted ? Theme.textSecondary : Theme.hairline, style: StrokeStyle(lineWidth: 1, dash: isTargeted ? [4, 3] : []))
        }
    }

    private func submit() {
        guard model.canSend, !isBusy else { return }
        onSend()
    }

    private func pick() {
        let urls = ImageImport.pick()
        if !urls.isEmpty { model.addFiles(urls) }
    }

    private func dictate() {
        model.bridge?.focus()
        NSApp.sendAction(Selector(("startDictation:")), to: nil, from: nil)
    }

    private func loadDropped(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in model.addFiles([url]) }
                }
            } else if provider.canLoadObject(ofClass: NSImage.self) {
                _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    Task { @MainActor in
                        if let image = try? ImageImport.from(data: data, filename: "surüklenen.png") { model.add([image]) }
                    }
                }
            }
        }
    }
}

/// A removable thumbnail with its alias (renamable inline) and upload state.
private struct AttachmentChip: View {
    let model: ComposerModel
    let draft: ComposerModel.Draft
    @State private var editing = false
    @State private var name = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Image(nsImage: draft.thumbnail)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                switch draft.state {
                case .uploading(let progress):
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.black.opacity(0.35))
                    ProgressView(value: progress)
                        .progressViewStyle(.circular)
                        .controlSize(.mini)
                        .tint(.white)
                case .failed:
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.black.opacity(0.45))
                    Image(systemName: "exclamationmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                case .uploaded:
                    EmptyView()
                }
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 1) {
                if editing {
                    TextField("ad", text: $name)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 96)
                        .focused($focused)
                        .onSubmit(commit)
                        .onExitCommand { editing = false; problem = nil }
                } else {
                    Text("@" + draft.alias)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .onTapGesture(count: 2, perform: beginEditing)
                        .help("Adını değiştirmek için çift tıkla")
                }
                Group {
                    switch draft.state {
                    case .uploading(let progress): Text("Yükleniyor %\(Int(progress * 100))")
                    case .uploaded: Text(problem ?? "Hazır")
                    case .failed(let message): Text(message).lineLimit(1).help(message)
                    }
                }
                .font(.system(size: 10))
                .foregroundStyle(Theme.textSecondary)
                if let problem, editing {
                    Text(problem).font(.system(size: 10)).foregroundStyle(Theme.textSecondary)
                }
            }

            if case .failed = draft.state {
                Button { model.retry(draft.id) } label: { Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .semibold)) }
                    .buttonStyle(GlyphButtonStyle())
                    .help("Yeniden dene")
                    .accessibilityLabel("Yüklemeyi yeniden dene")
            }
            Button { model.remove(draft.id) } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)) }
                .buttonStyle(GlyphButtonStyle())
                .help("Kaldır")
                .accessibilityLabel("@\(draft.alias) görselini kaldır")
        }
        .padding(.leading, 4)
        .padding(.trailing, 2)
        .padding(.vertical, 4)
        .background(Capsule().fill(Theme.fill))
        .contextMenu {
            Button("Yeniden adlandır") { beginEditing() }
            Button("Kaldır") { model.remove(draft.id) }
        }
    }

    private func beginEditing() {
        name = draft.alias
        problem = nil
        editing = true
        focused = true
    }

    private func commit() {
        if let message = model.rename(draft.id, to: name) {
            problem = message
        } else {
            problem = nil
            editing = false
        }
    }
}

/// The `@` autocomplete list: this conversation's aliases with thumbnails.
private struct MentionSuggestionList: View {
    let model: ComposerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(model.suggestions.enumerated()), id: \.element.id) { index, suggestion in
                Button { model.choose(suggestion) } label: {
                    HStack(spacing: 10) {
                        Group {
                            switch suggestion.thumbnail {
                            case .local(let image): Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                            case .asset(let id): AssetImage(assetId: id)
                            }
                        }
                        .frame(width: 26, height: 26)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        Text("@" + suggestion.alias).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textPrimary)
                        Spacer()
                        if suggestion.isDraft {
                            Text("bu mesajda").font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(index == model.suggestionIndex ? Theme.fillStrong : .clear))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(6)
        .frame(width: 300, alignment: .leading)
    }
}
