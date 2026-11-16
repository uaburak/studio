import StudioKit
import SwiftUI

/// An opened post (06). It zooms out of its grid card: the post panel grows from
/// the card's frame to its place on the left, the details fade in on the right.
/// Closing reverses it. The backdrop is a system material with a dim.
struct PostDetailOverlay: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: PostDetailModel
    @State private var progress: CGFloat = 0
    @State private var closing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            let layout = DetailLayout(container: proxy.size)
            let source = model.sourceFrame.offsetBy(dx: -origin.x, dy: -origin.y)
            ZStack(alignment: .topLeading) {
                // Liquid Glass over the whole window: samples the app beneath (not the desktop),
                // dimmed toward grey like the draft.
                Color.clear
                    .glassEffect(.regular.tint(Color.black.opacity(0.22)), in: Rectangle())
                    .opacity(progress)
                    .ignoresSafeArea()
                    .onTapGesture(perform: close)
                    .accessibilityHidden(true)

                card(layout: layout)
                    .frame(width: layout.card.width, height: layout.card.height)
                    .modifier(ZoomFromSource(progress: progress, source: source, target: layout.post, cardOrigin: layout.card.origin))
            }
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .smooth(duration: 0.42, extraBounce: 0.04)) { progress = 1 }
        }
        .onExitCommand(perform: close)
        .accessibilityAddTraits(.isModal)
    }

    private func card(layout: DetailLayout) -> some View {
        HStack(spacing: 0) {
            PostPlaceholder(
                card: model.card, scale: layout.post.width / 190, showsSlotArea: true,
                onDropImage: { model.importSlotImage(urls: [$0]) },
                onPickImage: { model.importSlotImage(urls: ImageImport.pick(multiple: false)) })
                .overlay { slotOverlay(layout: layout) }
                .frame(width: layout.post.width, height: layout.post.height)
            DetailInfoPanel(model: model, close: close)
                .frame(width: layout.card.width - layout.post.width)
                .background(Theme.canvas)
                .opacity(Double(max(0, (progress - 0.35) / 0.65)))
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.panelRadius, style: .continuous))
        .shadow(color: .black.opacity(0.18 * progress), radius: 30, y: 12)
    }

    /// Upload state over the slot (progress, uploaded, failed with retry).
    @ViewBuilder
    private func slotOverlay(layout: DetailLayout) -> some View {
        switch model.slotUpload {
        case .none:
            EmptyView()
        case .uploading(let value):
            VStack(spacing: 8) {
                ProgressView(value: value).progressViewStyle(.linear).frame(width: 140).tint(.white)
                Text("Yükleniyor %\(Int(value * 100))").font(Theme.captionFont).foregroundStyle(.white.opacity(0.8))
            }
        case .uploaded:
            VStack(spacing: 6) {
                if let image = model.slotImage {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).frame(maxWidth: 160, maxHeight: 160)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .opacity(0.9)
                }
                Text("Görsel yüklendi").font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.85))
                Text("Yuvaya yerleştirme adımı henüz yok; yeni sürüm gelince burada görünecek.")
                    .font(.system(size: 10)).foregroundStyle(.white.opacity(0.5))
                    .multilineTextAlignment(.center).frame(maxWidth: 220)
            }
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.black.opacity(0.55)))
        case .failed(let message):
            VStack(spacing: 8) {
                Text(message).font(Theme.captionFont).foregroundStyle(.white.opacity(0.85)).multilineTextAlignment(.center)
                Button("Yeniden dene") { model.retrySlotUpload() }.buttonStyle(.pillSecondary)
            }
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.black.opacity(0.6)))
        }
    }

    private func close() {
        guard !closing else { return }
        closing = true
        withAnimation(reduceMotion ? .easeIn(duration: 0.12) : .smooth(duration: 0.34)) {
            progress = 0
        } completion: {
            app.detail = nil
        }
    }
}

/// Card geometry for a container size: the post is 4:5 on the left, details on the right.
struct DetailLayout {
    var card: CGRect
    var post: CGRect

    init(container: CGSize) {
        let height = min(max(container.height * 0.69, 420), 640, container.height - 60)
        let postWidth = height * 0.8
        let infoWidth: CGFloat = min(360, max(300, container.width * 0.24))
        let width = min(postWidth + infoWidth, container.width - 60)
        let origin = CGPoint(x: (container.width - width) / 2, y: (container.height - height) / 2)
        card = CGRect(origin: origin, size: CGSize(width: width, height: height))
        post = CGRect(origin: origin, size: CGSize(width: postWidth, height: height))
    }
}

/// Maps the post panel's final frame onto the source card at progress 0.
private struct ZoomFromSource: ViewModifier, @MainActor Animatable {
    var progress: CGFloat
    var source: CGRect
    var target: CGRect
    var cardOrigin: CGPoint

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Self.Content) -> some View {
        let validSource = source.width > 1 ? source : target.insetBy(dx: target.width * 0.1, dy: target.height * 0.1)
        let scaleStart = validSource.width / target.width
        let scale = scaleStart + (1 - scaleStart) * progress
        // Position so the post panel's top-left moves from the source's to the target's.
        let x = validSource.minX + (target.minX - validSource.minX) * progress
        let y = validSource.minY + (target.minY - validSource.minY) * progress
        return content
            .scaleEffect(scale, anchor: .topLeading)
            .offset(x: x, y: y)
            .opacity(Double(min(1, progress * 4)))
    }
}

/// Right side of the opened post: account, status, caption + hashtags, facts,
/// "Neyi değiştireyim?", Zamanla / Onayla.
private struct DetailInfoPanel: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: PostDetailModel
    let close: () -> Void
    @FocusState private var captionFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Circle().fill(Theme.ink).frame(width: 26, height: 26)
                Text(model.handle).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                Spacer()
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                    .buttonStyle(GlyphButtonStyle())
                    .keyboardShortcut(.cancelAction)
                    .help("Kapat (esc)")
                    .accessibilityLabel("Kapat")
            }
            .padding(.bottom, 12)
            Hairline()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    PostStateLabel(state: model.card.state)
                        .padding(.top, 14)
                    caption
                    Hairline()
                    facts
                    if let job = model.instructionSent {
                        HStack(spacing: 6) {
                            StatusDot(color: Theme.accent)
                            Text(app.isOnline ? "Düzeltme isteği sırada (\(job.status == .queued ? "bekliyor" : job.status.rawValue))" : "Düzeltme isteği Mac'i bekliyor")
                                .font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    if let error = model.error {
                        InlineError(message: error) { model.error = nil }
                    }
                }
            }
            .scrollIndicators(.never)

            instructionField
                .padding(.top, 10)
            HStack(spacing: 8) {
                Spacer()
                Button("Zamanla") { model.schedulePresented = true }
                    .buttonStyle(PillButtonStyle(kind: .secondary, height: 28))
                    .disabled(model.schedulableAccounts.isEmpty || model.content.status == .published || model.content.status == .publishing)
                    .help(model.schedulableAccounts.isEmpty ? "Bu postun platformlarında bağlı hesap yok." : "Yayın zamanı seç")
                    .popover(isPresented: $model.schedulePresented, arrowEdge: .bottom) { SchedulePopover(model: model) }
                Button {
                    Task { await model.approve() }
                } label: {
                    HStack(spacing: 6) {
                        if model.isApproving { ProgressView().controlSize(.mini).tint(.white) }
                        Text(model.content.status.hasApproval ? "Onaylandı" : "Onayla")
                    }
                }
                .buttonStyle(PillButtonStyle(kind: .primary, height: 28))
                .disabled(!model.canApprove)
                .keyboardShortcut(.return, modifiers: .command)
                .help(model.approveHelp)
            }
            .padding(.top, 12)
        }
        .padding(20)
    }

    @ViewBuilder
    private var caption: some View {
        if model.isEditingCaption {
            VStack(alignment: .leading, spacing: 8) {
                TextEditor(text: $model.captionDraft)
                    .font(.system(size: 13))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 90)
                    .focused($captionFocused)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
                TextField("#etiketler", text: $model.hashtagsDraft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    .background(Capsule().strokeBorder(Theme.border))
                if model.content.status.hasApproval {
                    Text("Kaydedince onay kalkar; yeniden onaylaman gerekir.")
                        .font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
                }
                HStack(spacing: 8) {
                    Button("Vazgeç") {
                        let parts = CaptionParts(caption: model.content.caption)
                        model.captionDraft = parts.body
                        model.hashtagsDraft = parts.hashtags.joined(separator: " ")
                        model.isEditingCaption = false
                    }
                    .buttonStyle(.pillSecondary)
                    Button("Kaydet") { Task { await model.saveCaption() } }
                        .buttonStyle(.pillSecondary)
                        .disabled(model.isSavingCaption)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text(model.captionDraft.isEmpty ? "Açıklama yok" : model.captionDraft)
                    .font(.system(size: 13))
                    .lineSpacing(4)
                    .foregroundStyle(model.captionDraft.isEmpty ? Theme.textTertiary : Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if !model.hashtagsDraft.isEmpty {
                    Text(model.hashtagsDraft)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture {
                guard !model.content.status.isLocked else { return }
                model.isEditingCaption = true
                captionFocused = true
            }
            .help(model.content.status.isLocked ? "Yayındaki postun açıklaması değişmez." : "Düzenlemek için tıkla")
        }
    }

    private var facts: some View {
        VStack(spacing: 14) {
            fact("Tarih", model.dateText)
            fact("Platform", TurkishFormat.platforms(model.content.targetPlatforms))
            fact("Tür", model.typeText)
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
            Spacer()
            Text(value).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.textPrimary)
        }
    }

    private var instructionField: some View {
        HStack(spacing: 8) {
            TextField("Neyi değiştireyim?", text: $model.instruction)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .onSubmit { Task { await model.sendInstruction() } }
            Button { Task { await model.sendInstruction() } } label: {
                if model.isSendingInstruction { ProgressView().controlSize(.mini) } else { Image(systemName: "return").font(.system(size: 11)) }
            }
            .buttonStyle(GlyphButtonStyle())
            .disabled(model.instruction.trimmingCharacters(in: .whitespaces).isEmpty || model.isSendingInstruction)
            .help("Yeni sürüm iste: Mac'teki üretici bu talimatla düzeltir")
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(height: 34)
        .background(Capsule().strokeBorder(Theme.border))
    }
}

/// Date + accounts; approves first when needed.
private struct SchedulePopover: View {
    @Bindable var model: PostDetailModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Zamanla").font(.system(size: 13, weight: .semibold))
            DatePicker("Yayın zamanı", selection: $model.scheduleDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.compact)
                .environment(\.locale, TurkishFormat.locale)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(model.schedulableAccounts) { account in
                    Toggle(isOn: Binding(
                        get: { model.scheduleAccounts.contains(account.id) },
                        set: { if $0 { model.scheduleAccounts.insert(account.id) } else { model.scheduleAccounts.remove(account.id) } })) {
                        Text("\(account.platform.displayName) · \(account.handle)")
                    }
                    .toggleStyle(.checkbox)
                }
            }
            if !model.content.status.isSchedulable {
                Text("Önce bu sürüm onaylanacak, sonra zamanlanacak.")
                    .font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
            }
            Text("Yayınlama motoru henüz yok (Faz 3): zamanlama kaydedilir, paylaşım otomatik yapılmaz.")
                .font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Vazgeç") { model.schedulePresented = false }.buttonStyle(.pillSecondary)
                Button {
                    Task { await model.schedule() }
                } label: {
                    HStack(spacing: 6) {
                        if model.isScheduling { ProgressView().controlSize(.mini).tint(.white) }
                        Text(model.content.status.isSchedulable ? "Zamanla" : "Onayla ve zamanla")
                    }
                }
                .buttonStyle(.pillPrimary)
                .disabled(model.scheduleAccounts.isEmpty || model.isScheduling || (!model.content.status.isSchedulable && model.card.approvableHash == nil))
            }
        }
        .padding(18)
        .frame(width: 320)
    }
}
