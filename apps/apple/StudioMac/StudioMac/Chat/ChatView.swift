import AppKit
import QuartzCore
import StudioKit
import UniformTypeIdentifiers

/// Pure AppKit conversation screen (01 / 02 / 03):
/// - Centred 634pt column of messages inside a flipped `NSScrollView`
/// - Renders `.text`, `.toolStep`, `.consent`, `.planProposal`, `.question`, `.progress`, `.contentRef`, `.attachment`, `.error`
/// - Floating Liquid Glass composer + model/effort/usage footer over a soft bottom fade
/// - Alias preview & rename sheet (`AliasPreviewSheetController`).
final class ChatViewController: NSViewController {
    let model: ConversationModel

    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let messageColumn = NSStackView()
    private let bottomGradient = BottomFadeView()
    private let errorBanner = InlineErrorBannerView()
    private var composerView: ComposerControlView!
    private var footerView: ComposerFooterControlView!

    private var messageObservation: ObservationToken?
    private var composerObservation: ObservationToken?
    private var previewObservation: ObservationToken?
    private var renderedSnapshotKey: MessageRenderKey?
    private var lastMessageCount = 0
    private var lastPlainLength = 0
    private weak var activePreviewSheet: AliasPreviewSheetController?

    private struct MessageRenderKey: Equatable {
        var hasState: Bool
        var messages: [Message]
        var plans: [Plan]
        var aliases: [ConversationAlias]
        var activeRun: AgentRun?
        var runWaitingForMac: Bool
        var isOnline: Bool
        var expandedPlans: Set<EntityID>
        var busyPlans: Set<EntityID>
        var busyQuestions: Set<String>
        var busyConsents: Set<String>
        /// Still loading and the stream keeps failing: say so instead of spinning silently.
        var connectionTrouble: Bool = false
    }

    init(model: ConversationModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ChatDropContainerView()
        root.backgroundColor = Theme.canvas
        root.onDropFiles = { [weak self] urls in
            self?.model.composer.addFiles(urls)
        }

        // Scroll view with flipped clip + flipped document
        let clip = FlippedClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.automaticallyAdjustsContentInsets = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView
        scrollView.applyMinimalScroller()

        messageColumn.orientation = .vertical
        messageColumn.alignment = .leading
        messageColumn.spacing = 28
        messageColumn.translatesAutoresizingMaskIntoConstraints = false
        documentView.addSubview(messageColumn)

        // Bottom gradient + floating composer stack
        bottomGradient.translatesAutoresizingMaskIntoConstraints = false
        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.model.error = nil }

        composerView = ComposerControlView(
            model: model.composer,
            imageStore: model.app.images,
            onStop: nil,
            onSend: { [weak self] in
                guard let self else { return }
                Task { await self.model.send() }
            }
        )
        footerView = ComposerFooterControlView(model: model)

        let footerWrapper = NSView()
        footerWrapper.translatesAutoresizingMaskIntoConstraints = false
        footerWrapper.addSubview(footerView)
        NSLayoutConstraint.activate([
            footerView.leadingAnchor.constraint(equalTo: footerWrapper.leadingAnchor, constant: 14),
            footerView.trailingAnchor.constraint(equalTo: footerWrapper.trailingAnchor, constant: -14),
            footerView.topAnchor.constraint(equalTo: footerWrapper.topAnchor),
            footerView.bottomAnchor.constraint(equalTo: footerWrapper.bottomAnchor),
        ])

        let composerStack = NSStackView(views: [errorBanner, composerView, footerWrapper])
        composerStack.orientation = .vertical
        composerStack.alignment = .trailing
        composerStack.spacing = 8
        composerStack.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(scrollView)
        root.addSubview(bottomGradient)
        root.addSubview(composerStack)

        let msgWidth = messageColumn.widthAnchor.constraint(equalToConstant: Theme.columnMaxWidth)
        msgWidth.priority = .defaultHigh
        let compWidth = composerStack.widthAnchor.constraint(equalToConstant: Theme.columnMaxWidth)
        compWidth.priority = .defaultHigh

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            documentView.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            documentView.topAnchor.constraint(equalTo: clip.topAnchor),

            messageColumn.centerXAnchor.constraint(equalTo: documentView.centerXAnchor),
            messageColumn.leadingAnchor.constraint(greaterThanOrEqualTo: documentView.leadingAnchor, constant: Theme.columnMinMargin),
            messageColumn.trailingAnchor.constraint(lessThanOrEqualTo: documentView.trailingAnchor, constant: -Theme.columnMinMargin),
            msgWidth,
            messageColumn.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 24),
            messageColumn.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -162),

            bottomGradient.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bottomGradient.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bottomGradient.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            bottomGradient.heightAnchor.constraint(equalToConstant: 190),

            composerStack.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            composerStack.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: Theme.columnMinMargin),
            composerStack.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -Theme.columnMinMargin),
            compWidth,
            composerStack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),

            composerView.widthAnchor.constraint(equalTo: composerStack.widthAnchor),
            footerWrapper.widthAnchor.constraint(equalTo: composerStack.widthAnchor),
            errorBanner.widthAnchor.constraint(lessThanOrEqualTo: composerStack.widthAnchor),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        messageObservation = observe { [weak self] in
            self?.syncMessages()
        }
        composerObservation = observe { [weak self] in
            guard let self else { return }
            self.composerView.isBusy = self.model.isSending
            if self.model.activeRun != nil {
                let m = self.model
                self.composerView.onStop = { Task { await m.cancelRun() } }
            } else {
                self.composerView.onStop = nil
            }
            if let err = self.model.error {
                self.errorBanner.message = err
                self.errorBanner.isHidden = false
            } else {
                self.errorBanner.isHidden = true
            }
        }
        previewObservation = observe { [weak self] in
            self?.syncAliasPreview()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        if !model.app.navigatedByKeyboard {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                self?.model.composer.bridge?.focus()
            }
        }
        DispatchQueue.main.async { [weak self] in
            self?.scrollToBottom()
        }
    }

    /// Two failed attempts in a row (or HTTP fallback) count as trouble.
    static func isTroubled(_ live: LiveState) -> Bool {
        switch live {
        case .live: false
        case .connecting(let attempt): attempt > 2
        case .waiting(let failures, _): failures >= 2
        case .polling: true
        }
    }

    private func syncMessages() {
        let key = MessageRenderKey(
            hasState: model.state != nil,
            messages: model.messages,
            plans: model.state?.plans ?? [],
            aliases: model.state?.aliases ?? [],
            activeRun: model.activeRun,
            runWaitingForMac: model.runWaitingForMac,
            isOnline: model.app.isOnline,
            expandedPlans: model.expandedPlans,
            busyPlans: model.busyPlans,
            busyQuestions: model.busyQuestions,
            busyConsents: model.busyConsents,
            connectionTrouble: model.state == nil && Self.isTroubled(model.live)
        )
        guard key != renderedSnapshotKey else { return }
        renderedSnapshotKey = key

        // Decide where to land before the column is rebuilt: the rebuild briefly collapses
        // the document, so reading the position afterwards (or a frame later) makes it jump.
        let followBottom = isAtBottom()
        let previousY = scrollView.contentView.bounds.origin.y
        let userSent = key.messages.count > lastMessageCount && key.messages.last?.role == .user

        messageColumn.arrangedSubviews.forEach {
            messageColumn.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        if !key.hasState {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .regular
            spinner.startAnimation(nil)
            var views: [NSView] = [spinner]
            if key.connectionTrouble {
                let note = NSTextField.styledLabel(
                    "Sohbete bağlanılamıyor; yeniden deneniyor. Mac sunucusu kapalı olabilir.",
                    font: Theme.captionFont, color: Theme.textSecondary
                )
                views.append(note)
            }
            let holder = NSStackView(views: views)
            holder.orientation = .vertical
            holder.spacing = Theme.Spacing.m
            holder.alignment = .centerX
            holder.edgeInsets = NSEdgeInsets(top: 80, left: 0, bottom: 0, right: 0)
            messageColumn.addArrangedSubview(holder)
            holder.widthAnchor.constraint(equalTo: messageColumn.widthAnchor).isActive = true
        } else if key.messages.isEmpty {
            let empty = NSTextField.styledLabel("Bu sohbette henüz mesaj yok. Aşağıdan yaz.", font: Theme.chatFont, color: Theme.textSecondary)
            let holder = NSView()
            holder.translatesAutoresizingMaskIntoConstraints = false
            empty.translatesAutoresizingMaskIntoConstraints = false
            holder.addSubview(empty)
            NSLayoutConstraint.activate([
                empty.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
                empty.topAnchor.constraint(equalTo: holder.topAnchor, constant: 40),
                empty.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            ])
            messageColumn.addArrangedSubview(holder)
        } else {
            for message in key.messages {
                let item = makeMessageView(message)
                messageColumn.addArrangedSubview(item)
                item.widthAnchor.constraint(equalTo: messageColumn.widthAnchor).isActive = true
            }
        }

        if let run = key.activeRun {
            let runRow = makeRunStatusRow(run: run, waitingForMac: key.runWaitingForMac, isOnline: key.isOnline)
            messageColumn.addArrangedSubview(runRow)
        }

        lastMessageCount = key.messages.count
        lastPlainLength = key.messages.reduce(0) { $0 + $1.plainText.count }

        // Land in the same pass, before anything is drawn: follow the reply while the
        // reader is at the bottom (or just sent), otherwise stay where they were reading.
        if followBottom || userSent {
            scrollToBottom()
        } else {
            documentView.layoutSubtreeIfNeeded()
            let maxY = max(0, documentView.bounds.height - scrollView.contentView.bounds.height)
            scrollView.contentView.setBoundsOrigin(NSPoint(x: 0, y: min(previousY, maxY)))
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }
    }

    /// True while the reader sits at (or within a few lines of) the end of the conversation.
    private func isAtBottom(threshold: CGFloat = 80) -> Bool {
        let clip = scrollView.contentView
        let maxY = documentView.bounds.height - clip.bounds.height
        return maxY <= 0 || clip.bounds.origin.y >= maxY - threshold
    }

    private func makeMessageView(_ message: Message) -> NSView {
        switch message.role {
        case .user:
            return makeUserMessageView(message)
        default:
            return makeAssistantMessageView(message)
        }
    }

    private func makeUserMessageView(_ message: Message) -> NSView {
        let attachments = message.parts.compactMap { if case .attachment(let a) = $0 { a } else { nil } }
        let text = message.plainText

        let wrapper = NSView()
        wrapper.translatesAutoresizingMaskIntoConstraints = false

        let vStack = NSStackView()
        vStack.orientation = .vertical
        vStack.alignment = .trailing
        vStack.spacing = 8
        vStack.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(vStack)

        if !attachments.isEmpty {
            let row = NSStackView(views: attachments.map { makeAttachmentThumbnail($0) })
            row.orientation = .horizontal
            row.alignment = .bottom
            row.spacing = 8
            vStack.addArrangedSubview(row)
        }

        if !text.isEmpty {
            let bubble = ThemedView()
            bubble.backgroundColor = Theme.fill
            bubble.cornerRadius = 18
            bubble.translatesAutoresizingMaskIntoConstraints = false

            let mentions = model.state?.mentions(in: message, text: text) ?? []
            let textView = MentionedTextView(
                text: text,
                mentions: mentions,
                currentName: { [weak model] m in model?.state?.alias(id: m.aliasId)?.alias ?? m.alias },
                font: Theme.chatFont,
                maxPreferredWidth: Theme.columnMaxWidth - 92,
                onSelectMention: { [weak model] aliasId in model?.previewAliasId = aliasId }
            )
            bubble.addSubview(textView)
            NSLayoutConstraint.activate([
                textView.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 16),
                textView.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -16),
                textView.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 9),
                textView.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -9),
            ])
            vStack.addArrangedSubview(bubble)
        }

        NSLayoutConstraint.activate([
            vStack.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor),
            vStack.leadingAnchor.constraint(greaterThanOrEqualTo: wrapper.leadingAnchor, constant: 60),
            vStack.topAnchor.constraint(equalTo: wrapper.topAnchor),
            vStack.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
        ])
        return wrapper
    }

    private func makeAssistantMessageView(_ message: Message) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Group consecutive tool_step parts with tighter spacing so they read cleanly like Wecra's tool trace!
        var index = 0
        while index < message.parts.count {
            if case .toolStep = message.parts[index] {
                let group = NSStackView()
                group.orientation = .vertical
                group.alignment = .leading
                group.spacing = 5
                while index < message.parts.count, case .toolStep(let step) = message.parts[index] {
                    group.addArrangedSubview(ToolStepRowView(step: step))
                    index += 1
                }
                stack.addArrangedSubview(group)
                group.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
                continue
            }

            let part = message.parts[index]
            index += 1
            if part.isHiddenInChat { continue }
            let partView = makeAssistantPartView(message: message, part: part)
            stack.addArrangedSubview(partView)
            if !(partView is AttachmentThumbnailControlView) && !(partView is ContentRefRowControlView) {
                partView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }
        }

        if message.status == .streaming {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .mini
            spinner.startAnimation(nil)
            let row = NSStackView(views: [spinner, NSTextField.styledLabel("Yazıyor…", font: Theme.captionFont, color: Theme.textSecondary)])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 6
            stack.addArrangedSubview(row)
        } else if message.status == .failed || message.status == .cancelled {
            let statusText = message.status == .failed ? "Yanıt yarıda kaldı." : "Yanıt durduruldu."
            stack.addArrangedSubview(NSTextField.styledLabel(statusText, font: Theme.captionFont, color: Theme.textSecondary))
        }

        return stack
    }

    private func makeAssistantPartView(message: Message, part: MessagePart) -> NSView {
        switch part {
        case .text(let text):
            let targets = (model.state?.aliases ?? []).map(MentionText.Target.init)
            return MentionedTextView(
                text: text,
                mentions: MentionText.resolve(text, aliases: targets),
                currentName: { [weak model] m in model?.state?.alias(id: m.aliasId)?.alias ?? m.alias },
                font: Theme.chatFont,
                onSelectMention: { [weak model] aliasId in model?.previewAliasId = aliasId }
            )
        case .toolStep(let step):
            return ToolStepRowView(step: step)
        case .consent(let consent):
            return ConsentCardView(model: model, message: message, consent: consent)
        case .planProposal(let planId):
            if let plan = model.state?.plan(id: planId) {
                return PlanBlockView(model: model, plan: plan)
            }
            return NSTextField.styledLabel("Plan yükleniyor…", font: Theme.captionFont, color: Theme.textSecondary)
        case .question(let question):
            return QuestionCardView(model: model, message: message, question: question)
        case .progress(let progress):
            return makeProgressRow(progress)
        case .error(let err):
            return InlineErrorBannerView(message: err.message)
        case .contentRef(let ref):
            return ContentRefRowControlView(app: model.app, ref: ref)
        case .attachment(let attachment):
            return makeAttachmentThumbnail(attachment)
        case .unknown(let type):
            return NSTextField.styledLabel("Bu sürümün gösteremediği bir içerik (\(type)).", font: Theme.captionFont, color: Theme.textTertiary)
        }
    }

    private func makeAttachmentThumbnail(_ attachment: AttachmentPart) -> NSView {
        let name = model.state?.aliasName(for: attachment)
        return AttachmentThumbnailControlView(
            imageStore: model.app.images,
            attachment: attachment,
            aliasName: name
        ) { [weak model] in
            guard let model else { return }
            if let id = attachment.aliasId ?? model.state?.aliases.first(where: { $0.assetId == attachment.assetId })?.id {
                model.previewAliasId = id
            }
        }
    }

    private func makeProgressRow(_ progress: ProgressPart) -> NSView {
        var views: [NSView] = []
        switch progress.state {
        case .running:
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .mini
            spinner.startAnimation(nil)
            views.append(spinner)
        case .done:
            let img = NSImageView()
            img.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
            img.contentTintColor = Theme.textSecondary
            views.append(img)
        case .failed:
            let img = NSImageView()
            img.image = NSImage(systemSymbolName: "exclamationmark", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
            img.contentTintColor = Theme.accent
            views.append(img)
        default:
            let img = NSImageView()
            img.image = NSImage(systemSymbolName: "diamond", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 9, weight: .regular))
            img.contentTintColor = Theme.textTertiary
            views.append(img)
        }
        views.append(NSTextField.styledLabel(progress.label, font: Theme.captionFont, color: Theme.textPrimary))
        if let current = progress.current, let total = progress.total {
            views.append(NSTextField.styledLabel("\(current)/\(total)", font: Theme.captionFont, color: Theme.textSecondary))
        }
        if let detail = progress.detail, !detail.isEmpty {
            views.append(NSTextField.styledLabel(detail, font: Theme.captionFont, color: Theme.textSecondary))
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    private func makeRunStatusRow(run: AgentRun, waitingForMac: Bool, isOnline: Bool) -> NSView {
        var views: [NSView] = []
        if run.status == .running {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .mini
            spinner.startAnimation(nil)
            views.append(spinner)
            views.append(NSTextField.styledLabel("Yanıt hazırlanıyor…", font: Theme.captionFont, color: Theme.textSecondary))
        } else if waitingForMac {
            views.append(StatusDotView(color: Theme.accent))
            let msg = isOnline ? "Mac sırada bekliyor: sohbet ajanı henüz kurulu değil." : "Mac sırada bekliyor: Mac çevrimdışı."
            views.append(NSTextField.styledLabel(msg, font: Theme.captionFont, color: Theme.textSecondary))
        } else {
            views.append(StatusDotView(color: Theme.accent))
            views.append(NSTextField.styledLabel("Sırada", font: Theme.captionFont, color: Theme.textSecondary))
        }

        let cancelBtn = UnderlinedLinkButton(title: "İptal") { [weak model] in
            guard let model else { return }
            Task { await model.cancelRun() }
        }
        views.append(cancelBtn)

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    private func scrollToBottom() {
        documentView.layoutSubtreeIfNeeded()
        let maxY = max(0, documentView.bounds.height - scrollView.contentView.bounds.height)
        scrollView.contentView.setBoundsOrigin(NSPoint(x: 0, y: maxY))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func syncAliasPreview() {
        guard let aliasId = model.previewAliasId, let alias = model.state?.alias(id: aliasId) else {
            if let sheet = activePreviewSheet {
                dismiss(sheet)
                activePreviewSheet = nil
            }
            return
        }
        guard activePreviewSheet == nil, view.window != nil else { return }
        let sheet = AliasPreviewSheetController(model: model, alias: alias) { [weak self] in
            self?.model.previewAliasId = nil
        }
        activePreviewSheet = sheet
        presentAsSheet(sheet)
    }
}

// MARK: - Supporting Views

private final class ChatDropContainerView: ThemedView {
    var onDropFiles: (([URL]) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        ImageImport.pasteboardHasImages(sender.draggingPasteboard) ? .copy : []
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: ImageImport.fileTypes.map(\.identifier),
        ]
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL], !urls.isEmpty else {
            return false
        }
        onDropFiles?(urls)
        return true
    }
}

private final class BottomFadeView: NSView {
    private let gradient = CAGradientLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.addSublayer(gradient)
        updateGradient()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        gradient.frame = bounds
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateGradient()
    }

    private func updateGradient() {
        let base = resolvedCGColor(Theme.canvas)
        gradient.colors = [
            base.copy(alpha: 0.0) ?? NSColor.clear.cgColor,
            base.copy(alpha: 0.75) ?? NSColor.clear.cgColor,
            base,
        ]
        gradient.locations = [0.0, 0.58, 1.0]
        // Non-flipped CALayer: y=1 is top, y=0 is bottom.
        gradient.startPoint = CGPoint(x: 0.5, y: 1.0)
        gradient.endPoint = CGPoint(x: 0.5, y: 0.0)
    }
}

private final class AttachmentThumbnailControlView: NSControl {
    private let onTap: () -> Void

    init(imageStore: ImageStore?, attachment: AttachmentPart, aliasName: String?, onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = attachment.filename ?? "Görsel"

        let frameBox = ThemedView()
        frameBox.borderColor = Theme.hairline
        frameBox.borderWidth = 1
        frameBox.cornerRadius = 14
        frameBox.layer?.masksToBounds = true
        frameBox.translatesAutoresizingMaskIntoConstraints = false

        let img = AssetImageView(store: imageStore, assetId: attachment.assetId, contentMode: .fill, cornerRadius: 14)
        img.translatesAutoresizingMaskIntoConstraints = false
        frameBox.addSubview(img)

        NSLayoutConstraint.activate([
            frameBox.widthAnchor.constraint(equalToConstant: 88),
            frameBox.heightAnchor.constraint(equalToConstant: 110),
            img.leadingAnchor.constraint(equalTo: frameBox.leadingAnchor),
            img.trailingAnchor.constraint(equalTo: frameBox.trailingAnchor),
            img.topAnchor.constraint(equalTo: frameBox.topAnchor),
            img.bottomAnchor.constraint(equalTo: frameBox.bottomAnchor),
        ])

        var views: [NSView] = [frameBox]
        if let aliasName {
            views.append(NSTextField.styledLabel("@" + aliasName, font: NSFont.systemFont(ofSize: 11, weight: .medium), color: Theme.textSecondary))
        }
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .trailing
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onTap()
    }
}

private final class ContentRefRowControlView: NSControl {
    private let onTap: () -> Void

    init(app: AppModel, ref: ContentRefPart) {
        self.onTap = { [weak app] in app?.navigate(to: .posts) }
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)
        icon.contentTintColor = Theme.textSecondary

        let title = app.posts.card(ref.contentId)?.title ?? "Post"
        var views: [NSView] = [
            icon,
            NSTextField.styledLabel(title, font: Theme.rowFont, color: Theme.textPrimary),
        ]
        if let note = ref.note, !note.isEmpty {
            views.append(NSTextField.styledLabel(note, font: Theme.captionFont, color: Theme.textSecondary))
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onTap()
    }
}

private final class UnderlinedLinkButton: TapControl {
    private let onTap: () -> Void

    init(title: String, onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(title)
        let attr = NSAttributedString(string: title, attributes: [
            .font: Theme.captionFont,
            .foregroundColor: Theme.textSecondary,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ])
        let label = NSTextField(labelWithAttributedString: attr)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(equalTo: trailingAnchor),
            label.topAnchor.constraint(equalTo: topAnchor),
            label.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onTap()
    }

    override func performTap() { onTap() }
}

// MARK: - AliasPreviewSheetController

private final class AliasPreviewSheetController: NSViewController, NSTextFieldDelegate {
    private let model: ConversationModel
    private let alias: ConversationAlias
    private let onClose: () -> Void

    private let nameField = NSTextField()
    private var renameBtn: PillButton!
    private let statusLabel = NSTextField(labelWithString: "")
    private var saving = false

    init(model: ConversationModel, alias: ConversationAlias, onClose: @escaping () -> Void) {
        self.model = model
        self.alias = alias
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let preview = AssetImageView(store: model.app.images, assetId: alias.assetId, contentMode: .fit, cornerRadius: 16)
        preview.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            preview.widthAnchor.constraint(equalToConstant: 420),
            preview.heightAnchor.constraint(equalToConstant: 360),
        ])

        nameField.stringValue = alias.alias
        nameField.bezelStyle = .roundedBezel
        nameField.delegate = self
        nameField.translatesAutoresizingMaskIntoConstraints = false
        nameField.widthAnchor.constraint(equalToConstant: 180).isActive = true

        renameBtn = PillButton(title: "Yeniden adlandır", kind: .secondary) { [weak self] in
            self?.saveRename()
        }
        renameBtn.isEnabled = false

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let closeBtn = PillButton(title: "Kapat", kind: .secondary) { [weak self] in
            guard let self else { return }
            self.onClose()
            self.dismiss(nil)
        }

        let bar = NSStackView(views: [
            NSTextField.styledLabel("@", font: Theme.rowFont, color: Theme.textSecondary),
            nameField,
            renameBtn,
            spacer,
            closeBtn,
        ])
        bar.orientation = .horizontal
        bar.alignment = .centerY
        bar.spacing = 8

        statusLabel.font = Theme.captionFont
        statusLabel.textColor = Theme.textSecondary
        if !alias.previousAliases.isEmpty {
            statusLabel.stringValue = "Eski adları: " + alias.previousAliases.map { "@" + $0 }.joined(separator: ", ")
        } else {
            statusLabel.isHidden = true
        }

        let stack = NSStackView(views: [preview, bar, statusLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
        ])
        self.view = root
    }

    override func cancelOperation(_ sender: Any?) {
        onClose()
        dismiss(nil)
    }

    func controlTextDidChange(_ obj: Notification) {
        renameBtn.isEnabled = !saving && nameField.stringValue != alias.alias
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            saveRename()
            return true
        }
        return false
    }

    private func saveRename() {
        guard !saving else { return }
        saving = true
        renameBtn.showsSpinner = true
        renameBtn.isEnabled = false
        let requested = nameField.stringValue
        Task { @MainActor in
            let problem = await model.renameAlias(alias, to: requested)
            saving = false
            renameBtn.showsSpinner = false
            if let problem {
                statusLabel.stringValue = problem
                statusLabel.isHidden = false
                renameBtn.isEnabled = true
            } else {
                onClose()
                dismiss(nil)
            }
        }
    }
}
