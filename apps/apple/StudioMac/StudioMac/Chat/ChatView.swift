import AppKit
import QuartzCore
import StudioKit
import UniformTypeIdentifiers

/// Pure AppKit conversation screen (Claude Code's transcript):
/// - Centred column of rows inside a flipped `NSScrollView`. Rows come from
///   `TranscriptBuilder.items` and are reconciled by key: a streamed change updates only the
///   rows (and, inside a reply, the blocks) whose value changed; views, scroll position and
///   typed text in question cards survive.
/// - Follows new content only while the reader is at the bottom; otherwise a floating
///   "jump to latest" glass button appears above the composer.
/// - Floating Liquid Glass composer + model/effort/usage footer over a soft bottom fade
/// - Alias preview & rename sheet (`AliasPreviewSheetController`).
final class ChatViewController: NSViewController {
    let model: ConversationModel

    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let messageColumn = NSStackView()
    private let bottomGradient = BottomFadeView()
    private let errorBanner = InlineErrorBannerView()
    private let jumpButton = JumpToLatestButton()
    private var composerView: ComposerControlView!
    private var footerView: ComposerFooterControlView!
    private lazy var environment: TranscriptEnvironment = {
        let env = TranscriptEnvironment(model: model)
        env.conversationTiles = { [weak self] in self?.conversationImageTiles() ?? [] }
        return env
    }()

    private var messageObservation: ObservationToken?
    private var composerObservation: ObservationToken?
    private var previewObservation: ObservationToken?
    private weak var activePreviewSheet: AliasPreviewSheetController?

    /// Row views by item key (and the kind they render).
    private var rows: [String: (kind: String, view: NSView & TranscriptRowView)] = [:]
    private var renderedItems: [String: TranscriptItem] = [:]
    /// Item keys in screen order (tests).
    private(set) var renderedKeys: [String] = []
    /// When each running step was first seen (the working line counts from it).
    private var stepStarts: [String: Date] = [:]
    /// The reader is at the end: new content scrolls into view.
    private(set) var isPinnedToBottom = true
    private var isProgrammaticScroll = false
    private var hasUnseenContent = false
    private var lastDocumentHeight: CGFloat = 0
    private var lastClipSize: NSSize = .zero

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
        messageColumn.spacing = ChatStyle.rowSpacing
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

        jumpButton.isHidden = true
        jumpButton.alphaValue = 0
        jumpButton.onTap = { [weak self] in self?.jumpToLatest() }

        root.addSubview(scrollView)
        root.addSubview(bottomGradient)
        root.addSubview(composerStack)
        root.addSubview(jumpButton)

        let msgWidth = messageColumn.widthAnchor.constraint(equalToConstant: Theme.columnMaxWidth)
        msgWidth.priority = .defaultHigh
        let compWidth = composerStack.widthAnchor.constraint(equalToConstant: Theme.columnMaxWidth + 2 * Theme.composerOverhang)
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
            messageColumn.leadingAnchor.constraint(greaterThanOrEqualTo: documentView.leadingAnchor, constant: Theme.columnMinMargin + Theme.composerOverhang),
            messageColumn.trailingAnchor.constraint(lessThanOrEqualTo: documentView.trailingAnchor, constant: -(Theme.columnMinMargin + Theme.composerOverhang)),
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

            jumpButton.centerXAnchor.constraint(equalTo: composerStack.centerXAnchor),
            jumpButton.bottomAnchor.constraint(equalTo: composerView.topAnchor, constant: -12),
        ])

        // Scroll anchoring: the reader's position decides whether new content is followed.
        clip.postsBoundsChangedNotifications = true
        documentView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(clipBoundsChanged(_:)), name: NSView.boundsDidChangeNotification, object: clip)
        NotificationCenter.default.addObserver(self, selector: #selector(documentFrameChanged(_:)), name: NSView.frameDidChangeNotification, object: documentView)

        self.view = root
        environment.hostView = root
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
            guard let self else { return }
            self.isPinnedToBottom = true
            self.scrollToBottom()
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

    // MARK: Transcript

    /// Builds the rows from the model (observed) and reconciles them.
    private func syncMessages() {
        let state = model.state
        let app = model.app
        var input = TranscriptInput(hasState: state != nil)
        input.connectionTrouble = state == nil && Self.isTroubled(model.live)
        input.messages = model.messages
        input.plans = state?.plans ?? []
        input.aliases = state?.aliases ?? []
        input.activeRun = model.activeRun
        input.runWaitingForMac = model.runWaitingForMac
        input.isOnline = app.isOnline
        input.expandedPlans = model.expandedPlans
        input.expandedSteps = model.expandedStepGroups
        input.busyPlans = model.busyPlans
        input.busyQuestions = model.busyQuestions
        input.busyConsents = model.busyConsents
        input.queue = model.queue
        let posts = app.posts
        input.post = { id in posts.card(id) }
        input.postByTitle = { title in posts.board.cards.first { $0.title == title } }
        rememberStepStarts(input)
        input.stepStarts = stepStarts
        apply(TranscriptBuilder.items(input))
    }

    private func rememberStepStarts(_ input: TranscriptInput) {
        guard let run = input.activeRun else {
            stepStarts.removeAll()
            return
        }
        let now = Date()
        if run.status == .running, stepStarts["run-" + run.id] == nil { stepStarts["run-" + run.id] = now }
        for id in TranscriptBuilder.runningStepIds(input) where stepStarts[id] == nil { stepStarts[id] = now }
        if let live = TranscriptBuilder.liveMessageId(input), let message = input.messages.first(where: { $0.id == live }) {
            for part in message.parts {
                if case .progress(let progress) = part, progress.state == .running, progress.stepId != "thinking" {
                    let key = "progress-" + progress.stepId
                    if stepStarts[key] == nil { stepStarts[key] = now }
                }
            }
        }
    }

    /// Reuses row views by key, applies only changed items, inserts / removes / moves the rest.
    private func apply(_ items: [TranscriptItem]) {
        let previousKeys = Set(renderedKeys)
        let userSent = items.contains { item in
            guard !previousKeys.contains(item.key) else { return false }
            if case .user = item { return true }
            if case .queued = item { return true }
            return false
        } && !previousKeys.isEmpty

        var desired: [NSView & TranscriptRowView] = []
        var nextRows: [String: (kind: String, view: NSView & TranscriptRowView)] = [:]
        for item in items {
            let key = item.key
            let row: NSView & TranscriptRowView
            if let existing = rows[key], existing.kind == item.kind {
                row = existing.view
                if renderedItems[key] != item { row.apply(item) }
            } else {
                row = makeRow(for: item)
                row.apply(item)
            }
            nextRows[key] = (item.kind, row)
            desired.append(row)
        }
        for old in rows.values where !desired.contains(where: { $0 === old.view }) {
            messageColumn.removeArrangedSubview(old.view)
            old.view.removeFromSuperview()
        }
        for (index, row) in desired.enumerated() {
            if index < messageColumn.arrangedSubviews.count, messageColumn.arrangedSubviews[index] === row { continue }
            let isNew = row.superview !== messageColumn
            if !isNew { messageColumn.removeArrangedSubview(row) }
            messageColumn.insertArrangedSubview(row, at: index)
            if isNew { row.widthAnchor.constraint(equalTo: messageColumn.widthAnchor).isActive = true }
        }
        // A reply's hover row already leaves room under it.
        for row in desired where row is AssistantMessageRowView { messageColumn.setCustomSpacing(10, after: row) }

        rows = nextRows
        renderedItems = Dictionary(items.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
        renderedKeys = items.map(\.key)

        if userSent {
            isPinnedToBottom = true
            hasUnseenContent = false
        }
        if isPinnedToBottom {
            scrollToBottom()
        } else {
            documentView.layoutSubtreeIfNeeded()
        }
        updateJumpButton()
    }

    private func makeRow(for item: TranscriptItem) -> NSView & TranscriptRowView {
        switch item {
        case .loading: LoadingRowView()
        case .empty: EmptyRowView()
        case .user: UserMessageRowView(env: environment)
        case .assistant: AssistantMessageRowView(env: environment)
        case .event: EventLineView()
        case .queued: QueuedMessageRowView(env: environment)
        case .working: WorkingLineView(env: environment)
        }
    }

    /// Images of the conversation in order (the lightbox pages through them).
    private func conversationImageTiles() -> [ChatImageTileView] {
        messageColumn.arrangedSubviews.flatMap { row -> [ChatImageTileView] in
            if let user = row as? UserMessageRowView { return user.imageTiles }
            if let reply = row as? AssistantMessageRowView { return reply.imageTiles }
            return []
        }
    }

    /// Re-reads the model now instead of on the next run loop turn (tests).
    func syncNow() { syncMessages() }

    /// Row views in screen order (tests).
    var transcriptRows: [NSView] { messageColumn.arrangedSubviews }

    func row(forKey key: String) -> NSView? { rows[key]?.view }

    // MARK: Scrolling

    /// True while the reader sits at (or within a few lines of) the end of the conversation.
    private func isAtBottom(threshold: CGFloat = 40) -> Bool {
        let clip = scrollView.contentView
        let maxY = documentView.frame.height - clip.bounds.height
        return maxY <= 0 || clip.bounds.origin.y >= maxY - threshold
    }

    @objc private func clipBoundsChanged(_ note: Notification) {
        let size = scrollView.contentView.bounds.size
        let resized = lastClipSize != .zero && size != lastClipSize
        lastClipSize = size
        guard !isProgrammaticScroll else { return }
        if resized, isPinnedToBottom {
            // A resize (window, composer) is not the reader scrolling away.
            scrollToBottom(layout: false)
            return
        }
        isPinnedToBottom = isAtBottom()
        if isPinnedToBottom { hasUnseenContent = false }
        updateJumpButton()
    }

    @objc private func documentFrameChanged(_ note: Notification) {
        let height = documentView.frame.height
        guard abs(height - lastDocumentHeight) > 0.5 else { return }
        let grew = height > lastDocumentHeight
        lastDocumentHeight = height
        if isPinnedToBottom {
            scrollToBottom(layout: false)
        } else if grew {
            hasUnseenContent = true
        }
        updateJumpButton()
    }

    private func scrollToBottom(layout: Bool = true) {
        if layout { documentView.layoutSubtreeIfNeeded() }
        let clip = scrollView.contentView
        lastClipSize = clip.bounds.size
        let maxY = max(0, documentView.frame.height - clip.bounds.height)
        guard abs(clip.bounds.origin.y - maxY) > 0.5 else { return }
        isProgrammaticScroll = true
        clip.setBoundsOrigin(NSPoint(x: 0, y: maxY))
        scrollView.reflectScrolledClipView(clip)
        isProgrammaticScroll = false
    }

    private func jumpToLatest() {
        isPinnedToBottom = true
        hasUnseenContent = false
        updateJumpButton()
        documentView.layoutSubtreeIfNeeded()
        let clip = scrollView.contentView
        let maxY = max(0, documentView.frame.height - clip.bounds.height)
        isProgrammaticScroll = true
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.28
            context.allowsImplicitAnimation = true
            clip.animator().setBoundsOrigin(NSPoint(x: 0, y: maxY))
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.scrollView.reflectScrolledClipView(self.scrollView.contentView)
                self.isProgrammaticScroll = false
                self.scrollToBottom()
            }
        })
    }

    /// Shown while the reader is scrolled up and the agent works or something new arrived.
    var showsJumpButton: Bool {
        !isPinnedToBottom && (model.activeRun != nil || hasUnseenContent)
    }

    private func updateJumpButton() {
        let show = showsJumpButton
        jumpButton.showsActivity = model.activeRun?.status == .running
        guard show == jumpButton.isHidden || (show && jumpButton.alphaValue < 1) || (!show && jumpButton.alphaValue > 0) else { return }
        if show { jumpButton.isHidden = false }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.18
            jumpButton.animator().alphaValue = show ? 1 : 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.showsJumpButton else { return }
                self.jumpButton.isHidden = true
            }
        })
    }

    // MARK: Alias preview

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
