import AppKit
import QuartzCore
import StudioKit

// Row views of the conversation. Each row is created once per `TranscriptItem.key` and then
// only `apply`'d with new values, so views (and typed text in question cards) survive
// streaming updates.

@MainActor
protocol TranscriptRowView: NSView {
    func apply(_ item: TranscriptItem)
}

/// What rows need from the chat: the model and a few actions.
@MainActor
final class TranscriptEnvironment {
    unowned let model: ConversationModel
    /// Every image tile of the conversation in order (the lightbox pages through them).
    var conversationTiles: () -> [ChatImageTileView] = { [] }
    weak var hostView: NSView?

    init(model: ConversationModel) {
        self.model = model
    }

    var imageStore: ImageStore? { model.app.images }

    /// Opens the lightbox on `images`, zooming from `tile`; `tiles` let it close back into
    /// another thumbnail after ←/→.
    func openImages(_ images: [ChatImage], index: Int, from tile: NSView?, tiles: [NSView] = []) {
        let sources: ((Int) -> NSView?)? = tiles.isEmpty ? nil : { index in tiles.indices.contains(index) ? tiles[index] : nil }
        ImageLightbox.present(
            items: images.map { ImageLightbox.Item(assetId: $0.assetId, caption: $0.caption) },
            startIndex: index,
            from: tile,
            in: tile?.window ?? hostView?.window,
            imageStore: imageStore,
            sourceView: sources
        )
    }

    /// A chat image (attachment / generated): pages through every image of the conversation.
    func openConversationImage(_ tile: ChatImageTileView) {
        let tiles = conversationTiles()
        guard let index = tiles.firstIndex(where: { $0 === tile }) else {
            openImages([tile.image], index: 0, from: tile)
            return
        }
        openImages(tiles.map(\.image), index: index, from: tile, tiles: tiles)
    }

    func toggleStepGroup(_ key: String) {
        if model.expandedStepGroups.contains(key) {
            model.expandedStepGroups.remove(key)
        } else {
            model.expandedStepGroups.insert(key)
        }
    }

    func previewAlias(_ aliasId: EntityID) {
        model.previewAliasId = aliasId
    }

    func openPost(_ contentId: EntityID) {
        let app = model.app
        guard let brandId = model.brandId ?? app.currentBrandId else {
            app.navigate(to: .posts)
            return
        }
        Task { await app.openPost(contentId: contentId, brandId: brandId) }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// MARK: - Small shared pieces

/// Claude Code's working glyph: four orange dots pulsing in turn (2×2), or three in a row
/// (the "jump to latest" button). Static and grey while waiting; static under Reduce Motion.
final class WorkingDotsView: NSView {
    enum Style { case grid, row }

    let style: Style
    private let side: CGFloat
    private var dots: [CALayer] = []
    var isAnimating = true { didSet { refresh() } }
    var color: NSColor = Theme.accent { didSet { needsDisplay = true } }

    init(style: Style = .grid, size: CGFloat = 14) {
        self.style = style
        self.side = size
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        let count = style == .grid ? 4 : 3
        for _ in 0..<count {
            let dot = CALayer()
            layer?.addSublayer(dot)
            dots.append(dot)
        }
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size),
            heightAnchor.constraint(equalToConstant: size),
        ])
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        let cg = resolvedCGColor(color)
        let dotSize = (side * 0.27).rounded()
        let positions: [CGPoint]
        switch style {
        case .grid:
            // Top-left, top-right, bottom-right, bottom-left: the pulse goes round.
            let inset = side * 0.16
            let far = side - inset - dotSize
            positions = [CGPoint(x: inset, y: far), CGPoint(x: far, y: far), CGPoint(x: far, y: inset), CGPoint(x: inset, y: inset)]
        case .row:
            let gap = dotSize * 0.75
            let total = dotSize * 3 + gap * 2
            let x0 = (side - total) / 2
            positions = (0..<3).map { CGPoint(x: x0 + CGFloat($0) * (dotSize + gap), y: (side - dotSize) / 2) }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (dot, origin) in zip(dots, positions) {
            dot.frame = CGRect(origin: origin, size: CGSize(width: dotSize, height: dotSize))
            dot.cornerRadius = dotSize / 2
            dot.backgroundColor = cg
        }
        CATransaction.commit()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refresh()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    private func refresh() {
        needsDisplay = true
        for dot in dots { dot.removeAllAnimations() }
        guard isAnimating, window != nil, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            for dot in dots { dot.opacity = 1 }
            return
        }
        let period: CFTimeInterval = style == .grid ? 1.2 : 0.9
        for (index, dot) in dots.enumerated() {
            dot.opacity = 0.35
            let pulse = CAKeyframeAnimation(keyPath: "opacity")
            pulse.values = [0.35, 1, 0.35, 0.35]
            pulse.keyTimes = [0, 0.2, 0.5, 1]
            pulse.duration = period
            pulse.repeatCount = .infinity
            pulse.timeOffset = period - Double(index) * period / Double(dots.count)
            pulse.isRemovedOnCompletion = false
            dot.add(pulse, forKey: "pulse")
        }
    }

    /// Whether the pulse runs now (tests).
    var hasRunningAnimation: Bool { dots.contains { $0.animation(forKey: "pulse") != nil } }
}

/// A one-line grey row ("Zamanlanmış post yayınlandı · Instagram", "Yanıt durduruldu.").
final class EventLineView: NSView, TranscriptRowView {
    private let label = NSTextField.styledLabel("", font: ChatStyle.eventFont, color: Theme.textSecondary, wraps: true)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        label.isSelectable = true
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            label.topAnchor.constraint(equalTo: topAnchor),
            label.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var text: String {
        get { label.stringValue }
        set { label.stringValue = newValue }
    }

    func apply(_ item: TranscriptItem) {
        if case .event(_, let text) = item { self.text = text }
    }
}

/// A hoverable text-like control (step-group header, working line).
class HoverRowControl: TapControl {
    var onTap: (() -> Void)?
    private(set) var isHovering = false { didSet { hoverChanged() } }
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { isHovering = onTap != nil }
    override func mouseExited(with event: NSEvent) { isHovering = false }
    override func mouseDown(with event: NSEvent) { onTap?() }
    override func performTap() { onTap?() }

    func hoverChanged() {}
}

// MARK: - Loading / empty

final class LoadingRowView: NSView, TranscriptRowView {
    private let note = NSTextField.styledLabel(
        "Sohbete bağlanılamıyor; yeniden deneniyor. Studio'nun arka planı kapalı olabilir.",
        font: Theme.captionFont, color: Theme.textSecondary
    )

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.startAnimation(nil)
        let holder = NSStackView(views: [spinner, note])
        holder.orientation = .vertical
        holder.spacing = Theme.Spacing.m
        holder.alignment = .centerX
        holder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(holder)
        NSLayoutConstraint.activate([
            holder.centerXAnchor.constraint(equalTo: centerXAnchor),
            holder.topAnchor.constraint(equalTo: topAnchor, constant: 80),
            holder.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func apply(_ item: TranscriptItem) {
        if case .loading(let trouble) = item { note.isHidden = !trouble }
    }
}

final class EmptyRowView: NSView, TranscriptRowView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        let empty = NSTextField.styledLabel("Bu sohbette henüz mesaj yok. Aşağıdan yaz.", font: ChatStyle.bodyFont, color: Theme.textSecondary)
        empty.translatesAutoresizingMaskIntoConstraints = false
        addSubview(empty)
        NSLayoutConstraint.activate([
            empty.leadingAnchor.constraint(equalTo: leadingAnchor),
            empty.topAnchor.constraint(equalTo: topAnchor, constant: 40),
            empty.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func apply(_ item: TranscriptItem) {}
}

// MARK: - User message

/// Right-aligned bubble (max 70 % of the column) with its pictures above it.
class UserBubbleRowView: NSView {
    let env: TranscriptEnvironment
    let stack = NSStackView()
    let grid: ChatImageGridView
    let bubble = ThemedView()
    let textView: MentionedTextView
    private var renderedText: (String, [MessageMention], [EntityID: String])?

    init(env: TranscriptEnvironment) {
        self.env = env
        grid = ChatImageGridView(maxWidth: ChatStyle.userImageMaxWidth, store: env.imageStore)
        textView = MentionedTextView(
            font: ChatStyle.bodyFont,
            maxPreferredWidth: (Theme.columnMaxWidth * ChatStyle.bubbleMaxShare).rounded() - ChatStyle.bubblePadding.left - ChatStyle.bubblePadding.right
        )
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        stack.orientation = .vertical
        stack.alignment = .trailing
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        grid.onOpen = { [weak env] _, tile in env?.openConversationImage(tile) }
        grid.onRename = { [weak env] id in env?.previewAlias(id) }
        grid.isHidden = true
        stack.addArrangedSubview(grid)

        bubble.backgroundColor = ChatStyle.userBubble
        bubble.cornerRadius = ChatStyle.bubbleRadius
        bubble.translatesAutoresizingMaskIntoConstraints = false
        textView.onSelectMention = { [weak env] id in env?.previewAlias(id) }
        bubble.addSubview(textView)
        let pad = ChatStyle.bubblePadding
        NSLayoutConstraint.activate([
            textView.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: pad.left),
            textView.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -pad.right),
            textView.topAnchor.constraint(equalTo: bubble.topAnchor, constant: pad.top),
            textView.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -pad.bottom),
        ])
        stack.addArrangedSubview(bubble)

        NSLayoutConstraint.activate([
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            bubble.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: ChatStyle.bubbleMaxShare),
            grid.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(text: String, mentions: [MessageMention], aliasNames: [EntityID: String], images: [ChatImage]) {
        grid.update(images)
        grid.isHidden = images.isEmpty
        bubble.isHidden = text.isEmpty
        if renderedText.map({ $0.0 != text || $0.1 != mentions || $0.2 != aliasNames }) ?? true {
            renderedText = (text, mentions, aliasNames)
            textView.update(text: text, mentions: mentions, currentName: { aliasNames[$0.aliasId] ?? $0.alias }, font: ChatStyle.bodyFont)
        }
    }

    var imageTiles: [ChatImageTileView] { grid.isHidden ? [] : grid.tiles }
}

final class UserMessageRowView: UserBubbleRowView, TranscriptRowView {
    override init(env: TranscriptEnvironment) {
        super.init(env: env)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func apply(_ item: TranscriptItem) {
        guard case .user(let user) = item else { return }
        show(text: user.text, mentions: user.mentions, aliasNames: user.aliasNames, images: user.images)
    }
}

// MARK: - Queued message

/// A message waiting for the running reply: a dimmed bubble with an action row under it
/// (edit, retry, copy, ✕, "Şimdi gönder").
final class QueuedMessageRowView: UserBubbleRowView, TranscriptRowView {
    private let statusLabel = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textSecondary)
    let editButton = GlyphButton(symbol: "pencil", size: 11, diameter: 24)
    let retryButton = GlyphButton(symbol: "arrow.clockwise", size: 11, diameter: 24)
    let copyButton = GlyphButton(symbol: "doc.on.doc", size: 11, diameter: 24)
    let removeButton = GlyphButton(symbol: "xmark", size: 10, weight: .semibold, diameter: 24)
    let sendNowButton = PillButton(title: "Şimdi gönder", kind: .secondary, height: 22)
    private var queuedId = ""
    private var text = ""

    override init(env: TranscriptEnvironment) {
        super.init(env: env)
        editButton.toolTip = "Düzenle"
        editButton.setAccessibilityLabel("Düzenle")
        editButton.onAction = { [weak self] in
            guard let self else { return }
            self.env.model.editQueued(self.queuedId)
        }
        retryButton.toolTip = "Yeniden dene"
        retryButton.onAction = { [weak self] in
            guard let self else { return }
            self.env.model.retryQueued(self.queuedId)
        }
        copyButton.toolTip = "Kopyala"
        copyButton.setAccessibilityLabel("Kopyala")
        copyButton.onAction = { [weak self] in
            guard let self else { return }
            TranscriptEnvironment.copy(self.text)
        }
        removeButton.toolTip = "Sıradan çıkar"
        removeButton.setAccessibilityLabel("Sıradan çıkar")
        removeButton.onAction = { [weak self] in
            guard let self else { return }
            self.env.model.removeQueued(self.queuedId)
        }
        sendNowButton.toolTip = "Çalışan yanıtı durdurup bunu hemen gönder"
        sendNowButton.onAction = { [weak self] in
            guard let self else { return }
            let model = self.env.model
            let id = self.queuedId
            Task { await model.sendQueuedNow(id) }
        }
        let actions = NSStackView(views: [statusLabel, editButton, retryButton, copyButton, removeButton, sendNowButton])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 2
        actions.setCustomSpacing(8, after: statusLabel)
        actions.setCustomSpacing(8, after: removeButton)
        stack.addArrangedSubview(actions)
        stack.setCustomSpacing(6, after: bubble)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func apply(_ item: TranscriptItem) {
        guard case .queued(let queued) = item else { return }
        queuedId = queued.id
        text = queued.text
        show(text: queued.text, mentions: [], aliasNames: [:], images: queued.images)
        switch queued.state {
        case .waiting:
            statusLabel.stringValue = queued.sendNow ? "Yanıt durunca gönderilecek" : "Sırada"
            statusLabel.textColor = Theme.textSecondary
            bubble.alphaValue = 0.6
        case .sending:
            statusLabel.stringValue = "Gönderiliyor…"
            statusLabel.textColor = Theme.textSecondary
            bubble.alphaValue = 0.6
        case .failed(let reason):
            statusLabel.stringValue = "Gönderilemedi"
            statusLabel.textColor = Theme.accent
            statusLabel.toolTip = reason
            bubble.alphaValue = 1
        }
        let sending = queued.state == .sending
        let failed = { if case .failed = queued.state { return true } else { return false } }()
        editButton.isHidden = !queued.canEdit
        retryButton.isHidden = !failed
        removeButton.isHidden = sending
        sendNowButton.isHidden = sending || queued.sendNow
    }

    var statusText: String { statusLabel.stringValue }
}

// MARK: - Working line

/// The bottom line while the agent works: orange dots, the step's present-tense label, live
/// elapsed time and ›. The time ticks in this view only (no transcript update).
final class WorkingLineView: HoverRowControl, TranscriptRowView {
    private let env: TranscriptEnvironment
    let dots = WorkingDotsView(style: .grid, size: 14)
    let label = NSTextField.styledLabel("", font: ChatStyle.stepFont, color: Theme.textSecondary)
    let timeLabel = NSTextField.styledLabel("", font: NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .regular), color: Theme.textSecondary)
    private let chevron = NSImageView()
    private let cancelButton = PillButton(title: "İptal", kind: .secondary, height: 22)
    private(set) var item: WorkingItem?
    private var timer: Timer?
    var now: () -> Date = Date.init

    init(env: TranscriptEnvironment) {
        self.env = env
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        chevron.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        chevron.contentTintColor = Theme.textTertiary
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        cancelButton.onAction = { [weak env] in
            guard let model = env?.model else { return }
            Task { await model.cancelRun() }
        }
        let row = NSStackView(views: [dots, label, timeLabel, chevron, cancelButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.setCustomSpacing(10, after: dots)
        row.setCustomSpacing(6, after: label)
        row.setCustomSpacing(5, after: timeLabel)
        row.setCustomSpacing(12, after: chevron)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 24),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityRole(.button)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func apply(_ item: TranscriptItem) {
        guard case .working(let working) = item else { return }
        self.item = working
        label.stringValue = working.label
        label.textColor = working.isPrimary ? Theme.textPrimary : Theme.textSecondary
        dots.color = working.isAnimated ? Theme.accent : Theme.textTertiary
        dots.isAnimating = working.isAnimated
        chevron.isHidden = working.groupKey == nil
        cancelButton.isHidden = !working.cancellable
        if let key = working.groupKey {
            onTap = { [weak env] in env?.toggleStepGroup(key) }
        } else {
            onTap = nil
        }
        setAccessibilityLabel(working.label)
        tick()
        updateTimer()
    }

    override func hoverChanged() {
        guard let item else { return }
        label.textColor = (isHovering || item.isPrimary) ? Theme.textPrimary : Theme.textSecondary
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateTimer()
    }

    private func updateTimer() {
        let wants = window != nil && item?.since != nil
        if wants, timer == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        } else if !wants {
            timer?.invalidate()
            timer = nil
        }
    }

    /// Refreshes the elapsed time (every second while on screen).
    func tick() {
        guard let since = item?.since else {
            timeLabel.isHidden = true
            return
        }
        timeLabel.isHidden = false
        timeLabel.stringValue = ChatFormat.elapsed(now().timeIntervalSince(since))
    }

    var isTicking: Bool { timer != nil }
}

/// A small round glass button above the composer: scrolls to the latest message. Shows the
/// orange dots while the agent writes, an arrow otherwise.
final class JumpToLatestButton: NSView {
    private let glass = GlassContainerView(cornerRadius: 17, interactive: true, tint: Theme.composerGlassTint)
    private let dots = WorkingDotsView(style: .row, size: 22)
    private let arrow = NSImageView()
    var onTap: (() -> Void)?

    var showsActivity = false {
        didSet {
            dots.isHidden = !showsActivity
            dots.isAnimating = showsActivity
            arrow.isHidden = showsActivity
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        arrow.image = NSImage(systemSymbolName: "arrow.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        arrow.contentTintColor = Theme.textSecondary
        arrow.translatesAutoresizingMaskIntoConstraints = false
        glass.contentContainer.addSubview(dots)
        glass.contentContainer.addSubview(arrow)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 34),
            heightAnchor.constraint(equalToConstant: 34),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            dots.centerXAnchor.constraint(equalTo: glass.contentContainer.centerXAnchor),
            dots.centerYAnchor.constraint(equalTo: glass.contentContainer.centerYAnchor),
            arrow.centerXAnchor.constraint(equalTo: glass.contentContainer.centerXAnchor),
            arrow.centerYAnchor.constraint(equalTo: glass.contentContainer.centerYAnchor),
        ])
        showsActivity = false
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("En yeni mesaja git")
        toolTip = "En yeni mesaja git"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? {
        isHidden || alphaValue < 0.01 ? nil : (frame.contains(point) ? self : nil)
    }

    override func mouseDown(with event: NSEvent) { onTap?() }
    override func accessibilityPerformPress() -> Bool {
        onTap?()
        return true
    }
}

// MARK: - Assistant message

/// A reply: its blocks (Markdown, step groups, images, cards…) reconciled by key, and a hover
/// action row (copy, time) like Claude Code.
final class AssistantMessageRowView: NSView, TranscriptRowView {
    private let env: TranscriptEnvironment
    private let stack = NSStackView()
    private var blockViews: [String: (kind: String, view: NSView)] = [:]
    private var renderedBlocks: [String: AssistantBlock] = [:]
    private var renderedContext: MarkdownContext?
    private(set) var item: AssistantItem?
    private let actionRow = NSStackView()
    let copyButton = GlyphButton(symbol: "doc.on.doc", size: 11, diameter: 24)
    private let timeLabel = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textTertiary)
    private var tracking: NSTrackingArea?
    private var resetCopy: DispatchWorkItem?

    init(env: TranscriptEnvironment) {
        self.env = env
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = ChatStyle.blockSpacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        copyButton.toolTip = "Kopyala"
        copyButton.setAccessibilityLabel("Yanıtı kopyala")
        copyButton.onAction = { [weak self] in self?.copyReply() }
        actionRow.orientation = .horizontal
        actionRow.alignment = .centerY
        actionRow.spacing = 6
        actionRow.addArrangedSubview(copyButton)
        actionRow.addArrangedSubview(timeLabel)
        actionRow.alphaValue = 0
        actionRow.translatesAutoresizingMaskIntoConstraints = false
        addSubview(actionRow)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            actionRow.topAnchor.constraint(equalTo: stack.bottomAnchor, constant: 4),
            actionRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: -5),
            actionRow.bottomAnchor.constraint(equalTo: bottomAnchor),
            actionRow.heightAnchor.constraint(equalToConstant: 24),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func apply(_ item: TranscriptItem) {
        guard case .assistant(let next) = item else { return }
        let contextChanged = renderedContext != next.markdownContext
        self.item = next
        renderedContext = next.markdownContext

        var views: [NSView] = []
        var nextViews: [String: (kind: String, view: NSView)] = [:]
        for block in next.blocks {
            let existing = blockViews[block.key]
            let view: NSView
            if let existing, existing.kind == block.kind {
                view = existing.view
                if renderedBlocks[block.key] != block || (contextChanged && block.kind == "text") {
                    configure(view, with: block, context: next.markdownContext)
                }
            } else {
                view = makeView(for: block)
                configure(view, with: block, context: next.markdownContext)
            }
            renderedBlocks[block.key] = block
            nextViews[block.key] = (block.kind, view)
            views.append(view)
        }
        for old in blockViews.values where !views.contains(where: { $0 === old.view }) {
            stack.removeArrangedSubview(old.view)
            old.view.removeFromSuperview()
        }
        renderedBlocks = renderedBlocks.filter { nextViews[$0.key] != nil }
        blockViews = nextViews
        for (index, view) in views.enumerated() {
            if index < stack.arrangedSubviews.count, stack.arrangedSubviews[index] === view { continue }
            let isNew = view.superview !== stack
            if !isNew { stack.removeArrangedSubview(view) }
            stack.insertArrangedSubview(view, at: index)
            if isNew { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        }

        let canCopy = !next.isStreaming && !next.copyText.isEmpty
        copyButton.isHidden = !canCopy
        if actionRow.alphaValue < 0.01 { copyButton.isEnabled = false }
        timeLabel.stringValue = next.isStreaming ? "" : ChatFormat.clock(next.message.createdAt)
        if next.isStreaming { actionRow.alphaValue = 0 }
    }

    /// Block views in order (tests).
    var orderedBlockViews: [NSView] { stack.arrangedSubviews }

    func blockView(forKey key: String) -> NSView? { blockViews[key]?.view }

    /// Image tiles of the reply (attachments / generated images; not step thumbnails).
    var imageTiles: [ChatImageTileView] {
        stack.arrangedSubviews.compactMap { ($0 as? ImageBlockView)?.grid.tiles }.flatMap { $0 }
    }

    private func makeView(for block: AssistantBlock) -> NSView {
        switch block {
        case .text:
            let view = MarkdownView()
            view.onSelectMention = { [weak env] id in env?.previewAlias(id) }
            return view
        case .steps: return StepGroupView(env: env)
        case .images: return ImageBlockView(env: env)
        case .question: return QuestionHostView()
        case .post: return PostPreviewView(env: env)
        case .error: return InlineErrorBannerView()
        case .consent, .plan, .progress, .notice, .unknown: return RebuildHostView()
        }
    }

    private func configure(_ view: NSView, with block: AssistantBlock, context: MarkdownContext) {
        let model = env.model
        switch block {
        case .text(_, let markdown):
            (view as? MarkdownView)?.update(markdown: markdown, context: context)
        case .steps(let group):
            (view as? StepGroupView)?.update(group)
        case .images(_, let images):
            (view as? ImageBlockView)?.update(images)
        case .question(_, let question, let busy):
            guard let message = item?.message else { return }
            (view as? QuestionHostView)?.update(question: question, busy: busy) {
                QuestionCardView(model: model, message: message, question: question)
            }
        case .post(_, let preview):
            (view as? PostPreviewView)?.update(preview)
        case .error(_, let error):
            (view as? InlineErrorBannerView)?.message = error.message
        case .consent(_, let consent, _):
            guard let message = item?.message else { return }
            (view as? RebuildHostView)?.show { ConsentCardView(model: model, message: message, consent: consent) }
        case .plan(_, let plan, _, _, _):
            (view as? RebuildHostView)?.show {
                if let plan { return PlanBlockView(model: model, plan: plan) }
                return NSTextField.styledLabel("Plan yükleniyor…", font: Theme.captionFont, color: Theme.textSecondary)
            }
        case .progress(_, let progress):
            (view as? RebuildHostView)?.show { ProgressLineView(progress: progress) }
        case .notice(_, let text):
            (view as? RebuildHostView)?.show {
                let line = EventLineView()
                line.text = text
                return line
            }
        case .unknown(_, let text):
            (view as? RebuildHostView)?.show { NSTextField.styledLabel(text, font: Theme.captionFont, color: Theme.textTertiary) }
        }
    }

    private func copyReply() {
        guard let text = item?.copyText, !text.isEmpty else { return }
        TranscriptEnvironment.copy(text)
        copyButton.symbolName = "checkmark"
        resetCopy?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.copyButton.symbolName = "doc.on.doc" }
        resetCopy = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }

    // MARK: Hover

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { setActionsVisible(true) }
    override func mouseExited(with event: NSEvent) { setActionsVisible(false) }

    func setActionsVisible(_ visible: Bool) {
        let show = visible && item?.isStreaming == false
        // Invisible buttons take no clicks.
        copyButton.isEnabled = show
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            actionRow.animator().alphaValue = show ? 1 : 0
        }
    }

    var actionsAlpha: CGFloat { actionRow.alphaValue }
}

/// Hosts a card rebuilt whenever its value changes (cards without typed input).
final class RebuildHostView: NSView {
    private(set) var child: NSView?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ build: () -> NSView) {
        child?.removeFromSuperview()
        let view = build()
        view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(view)
        let fills = !(view is NSTextField)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: leadingAnchor),
            fills ? view.trailingAnchor.constraint(equalTo: trailingAnchor) : view.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            view.topAnchor.constraint(equalTo: topAnchor),
            view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        child = view
    }
}

/// Keeps one `QuestionCardView` while the question is unanswered (busy only toggles it); an
/// answer (or another question) rebuilds it.
final class QuestionHostView: NSView {
    private(set) var card: QuestionCardView?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(question: QuestionPart, busy: Bool, build: () -> QuestionCardView) {
        if let card, card.question == question {
            card.setBusy(busy)
            return
        }
        card?.removeFromSuperview()
        let view = build()
        addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: leadingAnchor),
            view.trailingAnchor.constraint(equalTo: trailingAnchor),
            view.topAnchor.constraint(equalTo: topAnchor),
            view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        card = view
    }
}

/// Images of a reply, left-aligned.
final class ImageBlockView: NSView {
    let grid: ChatImageGridView

    init(env: TranscriptEnvironment) {
        grid = ChatImageGridView(maxWidth: ChatStyle.singleImageMaxWidth, store: env.imageStore)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        grid.onOpen = { [weak env] _, tile in env?.openConversationImage(tile) }
        grid.onRename = { [weak env] id in env?.previewAlias(id) }
        addSubview(grid)
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: leadingAnchor),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            grid.topAnchor.constraint(equalTo: topAnchor),
            grid.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ images: [ChatImage]) { grid.update(images) }
}

/// A finished progress step ("Postlar hazırlandı 4/4"): one grey line.
final class ProgressLineView: NSView {
    init(progress: ProgressPart) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let icon: NSView
        switch progress.state {
        case .running:
            icon = WorkingDotsView(style: .grid, size: 12)
        default:
            let img = NSImageView()
            let symbol: String = switch progress.state {
            case .done: "checkmark"
            case .failed: "exclamationmark.triangle"
            case .skipped: "minus"
            default: "circle.dashed"
            }
            img.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
            img.contentTintColor = progress.state == .failed ? Theme.accent : Theme.textTertiary
            icon = img
        }
        var views: [NSView] = [icon, NSTextField.styledLabel(progress.label, font: ChatStyle.stepFont, color: Theme.textSecondary)]
        if let current = progress.current, let total = progress.total {
            views.append(NSTextField.styledLabel("\(current)/\(total)", font: ChatStyle.stepFont, color: Theme.textTertiary))
        }
        if let detail = progress.detail, !detail.isEmpty {
            views.append(NSTextField.styledLabel("· " + detail, font: ChatStyle.stepFont, color: Theme.textTertiary))
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - Step group

/// Finished tool steps as one grey line ("2 görsel üretti, 1 post oluşturdu ›") with small
/// result thumbnails at the right end; a click opens the step list.
final class StepGroupView: NSView {
    private let env: TranscriptEnvironment
    private(set) var group: StepGroup?
    let header = StepGroupHeaderControl()
    private let list = NSStackView()
    private let thumbs = NSStackView()
    private var thumbTiles: [ChatImageTileView] = []
    private var renderedSteps: [ToolStepPart] = []

    init(env: TranscriptEnvironment) {
        self.env = env
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        thumbs.orientation = .horizontal
        thumbs.spacing = 4
        thumbs.translatesAutoresizingMaskIntoConstraints = false

        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 2
        list.translatesAutoresizingMaskIntoConstraints = false
        list.edgeInsets = NSEdgeInsets(top: 4, left: 2, bottom: 2, right: 0)
        list.isHidden = true

        addSubview(header)
        addSubview(thumbs)
        addSubview(list)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.topAnchor.constraint(equalTo: topAnchor),
            header.trailingAnchor.constraint(lessThanOrEqualTo: thumbs.leadingAnchor, constant: -12),
            thumbs.trailingAnchor.constraint(equalTo: trailingAnchor),
            thumbs.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            list.leadingAnchor.constraint(equalTo: leadingAnchor),
            list.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            list.topAnchor.constraint(equalTo: header.bottomAnchor),
        ])
        bottomToHeader = header.bottomAnchor.constraint(equalTo: bottomAnchor)
        bottomToList = list.bottomAnchor.constraint(equalTo: bottomAnchor)
        bottomToHeader.isActive = true
    }

    private var bottomToHeader: NSLayoutConstraint!
    private var bottomToList: NSLayoutConstraint!

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ next: StepGroup) {
        group = next
        let key = next.key
        header.onTap = { [weak env] in env?.toggleStepGroup(key) }
        header.set(text: next.summary.isEmpty ? "Çalışıyor…" : next.summary, expanded: next.isExpanded, hasErrors: next.hasErrors)

        if next.thumbnails.map(\.assetId) != thumbTiles.map(\.image.assetId) {
            thumbTiles.forEach { $0.removeFromSuperview() }
            thumbs.arrangedSubviews.forEach { $0.removeFromSuperview() }
            thumbTiles = next.thumbnails.prefix(3).map { image in
                let tile = ChatImageTileView(image: image, store: env.imageStore, radius: 4, showsBadge: false)
                tile.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    tile.widthAnchor.constraint(equalToConstant: ChatStyle.stepThumbSize.width),
                    tile.heightAnchor.constraint(equalToConstant: ChatStyle.stepThumbSize.height),
                ])
                tile.onClick = { [weak self] tile in self?.openThumbnail(tile) }
                return tile
            }
            thumbTiles.forEach { thumbs.addArrangedSubview($0) }
            if next.thumbnails.count > 3 {
                thumbs.addArrangedSubview(NSTextField.styledLabel("+\(next.thumbnails.count - 3)", font: Theme.smallFont, color: Theme.textSecondary))
            }
        }

        if next.isExpanded {
            if renderedSteps != next.steps {
                renderedSteps = next.steps
                list.arrangedSubviews.forEach { $0.removeFromSuperview() }
                for step in next.steps { list.addArrangedSubview(ToolStepRowView(step: step)) }
            }
            list.isHidden = false
            bottomToHeader.isActive = false
            bottomToList.isActive = true
        } else {
            list.isHidden = true
            bottomToList.isActive = false
            bottomToHeader.isActive = true
        }
    }

    var stepRowCount: Int { list.isHidden ? 0 : list.arrangedSubviews.count }
    var thumbnailCount: Int { thumbTiles.count }

    private func openThumbnail(_ tile: ChatImageTileView) {
        guard let group, let index = thumbTiles.firstIndex(where: { $0 === tile }) else { return }
        env.openImages(group.thumbnails, index: index, from: tile, tiles: thumbTiles)
    }
}

/// The step group's clickable summary line ("… ›" / "… ⌄").
final class StepGroupHeaderControl: HoverRowControl {
    let label = NSTextField.styledLabel("", font: ChatStyle.stepFont, color: Theme.textSecondary)
    private let chevron = NSImageView()
    private var expanded = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        chevron.contentTintColor = Theme.textTertiary
        let row = NSStackView(views: [label, chevron])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 24),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func set(text: String, expanded: Bool, hasErrors: Bool) {
        label.stringValue = text
        self.expanded = expanded
        chevron.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        setAccessibilityLabel(text)
        setAccessibilityExpanded(expanded)
        hoverChanged()
    }

    override func hoverChanged() {
        label.textColor = isHovering ? Theme.textPrimary : Theme.textSecondary
        chevron.contentTintColor = isHovering ? Theme.textSecondary : Theme.textTertiary
    }
}

// MARK: - Post preview

/// A post the agent made or used: title (opens the post) + its rendered slides as thumbnails
/// (open the lightbox over the post's slides).
final class PostPreviewView: NSView {
    private let env: TranscriptEnvironment
    private(set) var preview: PostPreview?
    private let titleControl = HoverRowControl()
    private let titleLabel = NSTextField.styledLabel("", font: Theme.rowFont, color: Theme.textPrimary)
    private let detailLabel = NSTextField.styledLabel("", font: Theme.captionFont, color: Theme.textSecondary)
    private let strip = NSStackView()
    private var tiles: [ChatImageTileView] = []
    static let maxSlides = 6
    static let slideSize = NSSize(width: 96, height: 120)

    init(env: TranscriptEnvironment) {
        self.env = env
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        icon.contentTintColor = Theme.textSecondary
        let chevron = NSImageView()
        chevron.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        chevron.contentTintColor = Theme.textTertiary
        titleLabel.lineBreakMode = .byTruncatingTail
        detailLabel.lineBreakMode = .byTruncatingTail
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let titleRow = NSStackView(views: [icon, titleLabel, chevron, detailLabel])
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 8
        titleRow.setCustomSpacing(4, after: titleLabel)
        titleRow.setCustomSpacing(10, after: chevron)
        titleRow.translatesAutoresizingMaskIntoConstraints = false
        titleControl.translatesAutoresizingMaskIntoConstraints = false
        titleControl.addSubview(titleRow)
        NSLayoutConstraint.activate([
            titleRow.leadingAnchor.constraint(equalTo: titleControl.leadingAnchor),
            titleRow.trailingAnchor.constraint(equalTo: titleControl.trailingAnchor),
            titleRow.topAnchor.constraint(equalTo: titleControl.topAnchor),
            titleRow.bottomAnchor.constraint(equalTo: titleControl.bottomAnchor),
        ])
        titleControl.onTap = { [weak self] in
            guard let self, let preview = self.preview else { return }
            self.env.openPost(preview.contentId)
        }

        strip.orientation = .horizontal
        strip.spacing = ChatStyle.imageGap
        strip.alignment = .top

        let stack = NSStackView(views: [titleControl, strip])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            titleControl.trailingAnchor.constraint(lessThanOrEqualTo: stack.trailingAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ next: PostPreview) {
        guard next != preview else { return }
        preview = next
        titleLabel.stringValue = next.title
        let detail = [next.stateLabel, next.note].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
        detailLabel.stringValue = detail
        detailLabel.isHidden = detail.isEmpty
        titleControl.setAccessibilityLabel("Postu aç: \(next.title)")

        let slides = Array(next.slides.prefix(Self.maxSlides))
        if slides != tiles.map(\.image.assetId) {
            strip.arrangedSubviews.forEach { $0.removeFromSuperview() }
            tiles = slides.enumerated().map { index, assetId in
                let tile = ChatImageTileView(image: ChatImage(assetId: assetId, caption: next.title + (next.slides.count > 1 ? " · \(index + 1)/\(next.slides.count)" : "")), store: env.imageStore, radius: 8)
                tile.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    tile.widthAnchor.constraint(equalToConstant: Self.slideSize.width),
                    tile.heightAnchor.constraint(equalToConstant: Self.slideSize.height),
                ])
                tile.onClick = { [weak self] tile in self?.openSlide(tile) }
                return tile
            }
            tiles.forEach { strip.addArrangedSubview($0) }
            if next.slides.count > Self.maxSlides {
                strip.addArrangedSubview(NSTextField.styledLabel("+\(next.slides.count - Self.maxSlides)", font: Theme.captionFont, color: Theme.textSecondary))
            }
        }
        strip.isHidden = slides.isEmpty
    }

    var slideTiles: [ChatImageTileView] { tiles }

    private func openSlide(_ tile: ChatImageTileView) {
        guard let preview, let index = tiles.firstIndex(where: { $0 === tile }) else { return }
        let images = preview.slides.enumerated().map { i, id in
            ChatImage(assetId: id, caption: preview.title + (preview.slides.count > 1 ? " · \(i + 1)/\(preview.slides.count)" : ""))
        }
        env.openImages(images, index: index, from: tile, tiles: tiles)
    }
}
