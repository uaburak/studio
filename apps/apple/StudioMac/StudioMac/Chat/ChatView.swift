import StudioKit
import SwiftUI
import UniformTypeIdentifiers

/// A conversation (01 / 02 / 03): centred column of messages, the floating composer.
struct ChatView: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: ConversationModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                if model.state == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
                } else if model.messages.isEmpty {
                    Text("Bu sohbette henüz mesaj yok. Aşağıdan yaz.")
                        .font(Theme.chatFont)
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.top, 40)
                }
                ForEach(model.messages) { message in
                    MessageView(model: model, message: message)
                        .id(message.id)
                }
                RunStatusView(model: model)
            }
            .chatColumn()
            .padding(.top, 24)
            .padding(.bottom, 20)
        }
        .defaultScrollAnchor(.top, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        // Soft (feathered) edges under the toolbar and behind the composer; macOS defaults to hard.
        .scrollEdgeEffectStyle(.soft, for: .all)
        .safeAreaBar(edge: .bottom) {
            VStack(alignment: .trailing, spacing: 8) {
                if let error = model.error {
                    InlineError(message: error) { model.error = nil }
                }
                ComposerView(
                    model: model.composer,
                    isBusy: model.isSending,
                    onStop: model.activeRun.map { _ in { Task { await model.cancelRun() } } },
                    onSend: { Task { await model.send() } })
                MacStatusView().padding(.trailing, 14)
            }
            .chatColumn()
            .padding(.bottom, 12)
        }
        .task(id: model.id) {
            guard !app.navigatedByKeyboard else { return }
            try? await Task.sleep(for: .milliseconds(150))
            model.composer.bridge?.focus()
        }
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "studio-mention", let aliasId = url.host() else { return .systemAction }
            model.previewAliasId = aliasId
            return .handled
        })
        .sheet(item: Binding(get: { model.previewAliasId.flatMap { model.state?.alias(id: $0) } }, set: { _ in model.previewAliasId = nil })) { alias in
            AliasPreview(model: model, alias: alias)
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in model.composer.addFiles([url]) }
                }
            }
            return true
        }
    }
}

/// One message: user bubble on the right, assistant parts on the left.
struct MessageView: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel
    let message: Message

    var body: some View {
        switch message.role {
        case .user:
            UserMessageView(model: model, message: message)
        default:
            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                    AssistantPartView(model: model, message: message, part: part)
                }
                if message.status == .streaming {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Yazıyor…").font(Theme.captionFont).foregroundStyle(Theme.textSecondary)
                    }
                } else if message.status == .failed || message.status == .cancelled {
                    Text(message.status == .failed ? "Yanıt yarıda kaldı." : "Yanıt durduruldu.")
                        .font(Theme.captionFont)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct UserMessageView: View {
    let model: ConversationModel
    let message: Message

    var body: some View {
        let attachments = message.parts.compactMap { if case .attachment(let a) = $0 { a } else { nil } }
        let text = message.plainText
        VStack(alignment: .trailing, spacing: 8) {
            if !attachments.isEmpty {
                HStack(spacing: 8) {
                    ForEach(attachments, id: \.assetId) { attachment in
                        AttachmentThumbnail(model: model, attachment: attachment)
                    }
                }
            }
            if !text.isEmpty {
                MentionedText(
                    text: text,
                    mentions: model.state?.mentions(in: message, text: text) ?? [],
                    currentName: { model.state?.alias(id: $0.aliasId)?.alias ?? $0.alias })
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.fill))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 60)
    }
}

/// A sent attachment: thumbnail with its (current) alias.
struct AttachmentThumbnail: View {
    let model: ConversationModel
    let attachment: AttachmentPart

    var body: some View {
        let name = model.state?.aliasName(for: attachment)
        Button {
            if let id = attachment.aliasId ?? model.state?.aliases.first(where: { $0.assetId == attachment.assetId })?.id {
                model.previewAliasId = id
            }
        } label: {
            VStack(alignment: .trailing, spacing: 4) {
                AssetImage(assetId: attachment.assetId)
                    .frame(width: 88, height: 110)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.hairline))
                if let name {
                    Text("@" + name)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .buttonStyle(.plain)
        .help(attachment.filename ?? "Görsel")
    }
}

/// One assistant part.
private struct AssistantPartView: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel
    let message: Message
    let part: MessagePart

    var body: some View {
        switch part {
        case .text(let text):
            MentionedText(
                text: text,
                mentions: MentionText.resolve(text, aliases: (model.state?.aliases ?? []).map(MentionText.Target.init)),
                currentName: { model.state?.alias(id: $0.aliasId)?.alias ?? $0.alias })
        case .planProposal(let planId):
            if let plan = model.state?.plan(id: planId) {
                PlanBlock(model: model, plan: plan)
            } else {
                Text("Plan yükleniyor…").font(Theme.captionFont).foregroundStyle(Theme.textSecondary)
            }
        case .question(let question):
            QuestionCard(model: model, message: message, question: question)
        case .progress(let progress):
            ProgressRow(progress: progress)
        case .error(let error):
            InlineError(message: error.message)
        case .contentRef(let ref):
            ContentRefRow(ref: ref)
        case .attachment(let attachment):
            AttachmentThumbnail(model: model, attachment: attachment)
        case .unknown(let type):
            Text("Bu sürümün gösteremediği bir içerik (\(type)).")
                .font(Theme.captionFont).foregroundStyle(Theme.textTertiary)
        }
    }
}

private struct ProgressRow: View {
    let progress: ProgressPart

    var body: some View {
        HStack(spacing: 8) {
            switch progress.state {
            case .running: ProgressView().controlSize(.mini)
            case .done: Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.textSecondary)
            case .failed: Image(systemName: "exclamationmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.accent)
            default: Image(systemName: "diamond").font(.system(size: 9)).foregroundStyle(Theme.textTertiary)
            }
            Text(progress.label).font(Theme.captionFont).foregroundStyle(Theme.textPrimary)
            if let current = progress.current, let total = progress.total {
                Text("\(current)/\(total)").font(Theme.captionFont).foregroundStyle(Theme.textSecondary)
            }
            if let detail = progress.detail {
                Text(detail).font(Theme.captionFont).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
        }
    }
}

private struct ContentRefRow: View {
    @Environment(AppModel.self) private var app
    let ref: ContentRefPart

    var body: some View {
        Button {
            app.navigate(to: .posts)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "square.grid.2x2").foregroundStyle(Theme.textSecondary)
                Text(app.posts.card(ref.contentId)?.title ?? "Post")
                    .font(Theme.rowFont).foregroundStyle(Theme.textPrimary)
                if let note = ref.note {
                    Text(note).font(Theme.captionFont).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

/// After the last message: the active run's state, said honestly.
private struct RunStatusView: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel

    var body: some View {
        if let run = model.activeRun {
            HStack(spacing: 8) {
                if run.status == .running {
                    ProgressView().controlSize(.mini)
                    Text("Yanıt hazırlanıyor…")
                } else if model.runWaitingForMac {
                    StatusDot(color: Theme.accent)
                    Text(app.isOnline ? "Mac sırada bekliyor: sohbet ajanı henüz kurulu değil." : "Mac sırada bekliyor: Mac çevrimdışı.")
                } else {
                    StatusDot(color: Theme.accent)
                    Text("Sırada")
                }
                Button("İptal") { Task { await model.cancelRun() } }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.textSecondary)
                    .underline()
            }
            .font(Theme.captionFont)
            .foregroundStyle(Theme.textSecondary)
        }
    }
}

/// Mention / attachment preview with rename.
private struct AliasPreview: View {
    @Environment(\.dismiss) private var dismiss
    let model: ConversationModel
    let alias: ConversationAlias
    @State private var name = ""
    @State private var problem: String?
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AssetImage(assetId: alias.assetId, contentMode: .fit)
                .frame(maxWidth: 420, maxHeight: 420)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            HStack(spacing: 8) {
                Text("@").foregroundStyle(Theme.textSecondary)
                TextField("ad", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 180)
                    .onSubmit(save)
                Button("Yeniden adlandır", action: save)
                    .buttonStyle(.pillSecondary)
                    .disabled(saving || name == alias.alias)
                Spacer()
                Button("Kapat") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .buttonStyle(.pillSecondary)
            }
            if let problem {
                Text(problem).font(Theme.captionFont).foregroundStyle(Theme.textSecondary)
            } else if !alias.previousAliases.isEmpty {
                Text("Eski adları: " + alias.previousAliases.map { "@" + $0 }.joined(separator: ", "))
                    .font(Theme.captionFont).foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(20)
        .onAppear { name = alias.alias }
    }

    private func save() {
        saving = true
        Task {
            problem = await model.renameAlias(alias, to: name)
            saving = false
        }
    }
}
