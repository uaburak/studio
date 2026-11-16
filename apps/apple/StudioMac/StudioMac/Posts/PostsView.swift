import AppKit
import QuartzCore
import StudioKit
import UniformTypeIdentifiers

/// Pure AppKit Posts screen (05):
/// - Month title, brand & count subtitle, segmented `FilterPillsControlView`
/// - Responsive multi-column grid of 4:5 `PostCardItemView`s (rendered image or typographic placeholder + drag-and-drop slot)
/// - Floating Liquid Glass `ApproveBarView` at the bottom when `approvable` is non-empty.
final class PostsViewController: NSViewController {
    private unowned let app: AppModel

    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let contentStack = NSStackView()

    private let monthLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private var filterControl: FilterPillsControlView!
    private let errorBanner = InlineErrorBannerView()
    private let emptyView = NSStackView()
    private let emptyPrimaryLabel = NSTextField(labelWithString: "")
    private let emptySecondaryLabel = NSTextField(labelWithString: "Postlar sohbette onaylanan planlardan gelir.")
    private var gridView: PostGridContainerView!
    private var approveBar: ApproveBarView!

    private var observation: ObservationToken?
    private var lastLoadedBrandId: EntityID?
    private var renderedKey: GridRenderKey?

    private struct GridRenderKey: Equatable {
        var cards: [PostCard]
        var slotUploads: [EntityID: Double]
        var openedCardId: EntityID?
    }

    init(app: AppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas

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

        // Header
        monthLabel.font = NSFont.systemFont(ofSize: 28, weight: .bold)
        monthLabel.textColor = Theme.textPrimary
        subtitleLabel.font = Theme.captionFont
        subtitleLabel.textColor = Theme.textSecondary

        let titleStack = NSStackView(views: [monthLabel, subtitleLabel])
        titleStack.orientation = .vertical
        titleStack.alignment = .leading
        titleStack.spacing = 4

        filterControl = FilterPillsControlView { [weak self] selected in
            self?.app.posts.filter = selected
        }

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let headerRow = NSStackView(views: [titleStack, spacer, filterControl])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 20
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.app.posts.error = nil }

        // Empty state
        emptyPrimaryLabel.font = Theme.chatFont
        emptyPrimaryLabel.textColor = Theme.textSecondary
        emptySecondaryLabel.font = Theme.captionFont
        emptySecondaryLabel.textColor = Theme.textTertiary
        emptyView.orientation = .vertical
        emptyView.alignment = .centerX
        emptyView.spacing = 8
        emptyView.edgeInsets = NSEdgeInsets(top: 80, left: 0, bottom: 0, right: 0)
        emptyView.addArrangedSubview(emptyPrimaryLabel)
        emptyView.addArrangedSubview(emptySecondaryLabel)
        emptyView.isHidden = true

        gridView = PostGridContainerView(app: app)

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 28
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.addArrangedSubview(headerRow)
        contentStack.addArrangedSubview(errorBanner)
        contentStack.addArrangedSubview(emptyView)
        contentStack.addArrangedSubview(gridView)

        documentView.addSubview(contentStack)

        approveBar = ApproveBarView { [weak self] in
            guard let self else { return }
            Task { await self.app.posts.approveReady() }
        }
        approveBar.isHidden = true

        root.addSubview(scrollView)
        root.addSubview(approveBar)

        let maxW = contentStack.widthAnchor.constraint(equalToConstant: 960)
        maxW.priority = .defaultHigh

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            documentView.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            documentView.topAnchor.constraint(equalTo: clip.topAnchor),

            contentStack.centerXAnchor.constraint(equalTo: documentView.centerXAnchor),
            contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: documentView.leadingAnchor, constant: 76),
            contentStack.trailingAnchor.constraint(lessThanOrEqualTo: documentView.trailingAnchor, constant: -76),
            maxW,
            contentStack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 30),
            contentStack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -96),

            headerRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            errorBanner.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            emptyView.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            gridView.widthAnchor.constraint(equalTo: contentStack.widthAnchor),

            approveBar.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            approveBar.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.syncState()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        Task { await app.posts.load() }
    }

    private func syncState() {
        let posts = app.posts
        if app.currentBrandId != lastLoadedBrandId {
            lastLoadedBrandId = app.currentBrandId
            Task { await posts.load() }
        }

        let counts = posts.counts
        monthLabel.stringValue = TurkishFormat.monthTitle(posts.month, currentYear: MonthKey(Date()).year)
        subtitleLabel.stringValue = "\(app.brand(app.currentBrandId)?.name ?? "Marka seçilmedi") · \(counts[.all] ?? 0) post"
        filterControl.update(selection: posts.filter, counts: counts)

        if let err = posts.error {
            errorBanner.message = err
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }

        let cards = posts.visibleCards
        let showEmpty = cards.isEmpty && !posts.isLoading
        emptyView.isHidden = !showEmpty
        gridView.isHidden = showEmpty
        if showEmpty {
            emptyPrimaryLabel.stringValue = posts.filter == .all ? "Bu ayda post yok." : "Bu filtrede post yok."
            emptySecondaryLabel.isHidden = posts.filter != .all
        }

        let key = GridRenderKey(cards: cards, slotUploads: posts.slotUploads, openedCardId: app.detail?.card.id)
        if key != renderedKey {
            renderedKey = key
            gridView.setCards(cards, slotUploads: posts.slotUploads, openedCardId: app.detail?.card.id)
        }

        let approvableCount = posts.approvable.count
        approveBar.isHidden = approvableCount == 0
        if approvableCount > 0 {
            approveBar.update(count: approvableCount, isApproving: posts.isApproving)
        }
    }
}

// MARK: - Responsive Multi-Column Grid

private final class PostGridContainerView: NSView {
    private unowned let app: AppModel
    private var itemViews: [PostCardItemView] = []
    private var lastWidth: CGFloat = 0

    override var isFlipped: Bool { true }

    init(app: AppModel) {
        self.app = app
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setCards(_ cards: [PostCard], slotUploads: [EntityID: Double], openedCardId: EntityID?) {
        itemViews.forEach { $0.removeFromSuperview() }
        itemViews = cards.map { card in
            let item = PostCardItemView(
                app: app,
                card: card,
                uploadProgress: slotUploads[card.id],
                dimmed: openedCardId == card.id
            )
            addSubview(item)
            return item
        }
        needsLayout = true
        invalidateIntrinsicContentSize()
    }

    override func layout() {
        super.layout()
        _ = layoutGrid(in: bounds.width, place: true)
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        let width = bounds.width > 40 ? bounds.width : 880
        let height = layoutGrid(in: width, place: false)
        return NSSize(width: NSView.noIntrinsicMetric, height: height)
    }

    private func layoutGrid(in availableWidth: CGFloat, place: Bool) -> CGFloat {
        guard !itemViews.isEmpty else { return 0 }
        let width = max(200, availableWidth)
        let hSpacing: CGFloat = 20
        let vSpacing: CGFloat = 26
        let minColWidth: CGFloat = 180
        let maxColWidth: CGFloat = 260

        let cols = max(1, Int(floor((width + hSpacing) / (minColWidth + hSpacing))))
        let rawColWidth = floor((width - CGFloat(cols - 1) * hSpacing) / CGFloat(cols))
        let colWidth = min(maxColWidth, max(minColWidth, rawColWidth))
        let cardVisualHeight = round(colWidth * 5.0 / 4.0)
        let footerHeight: CGFloat = 26
        let cellHeight = cardVisualHeight + footerHeight

        for (index, item) in itemViews.enumerated() {
            let col = index % cols
            let row = index / cols
            let x = CGFloat(col) * (colWidth + hSpacing)
            let y = CGFloat(row) * (cellHeight + vSpacing)
            if place {
                item.frame = NSRect(x: x, y: y, width: colWidth, height: cellHeight)
                item.layoutItem(visualHeight: cardVisualHeight)
            }
        }

        let totalRows = (itemViews.count + cols - 1) / cols
        return CGFloat(totalRows) * cellHeight + CGFloat(max(0, totalRows - 1)) * vSpacing
    }
}

private final class PostCardItemView: NSView {
    private unowned let app: AppModel
    private let card: PostCard
    private let placeholder: PostPlaceholderView
    private let footerRow = NSView()
    private var trackingArea: NSTrackingArea?

    override var isFlipped: Bool { true }

    init(app: AppModel, card: PostCard, uploadProgress: Double?, dimmed: Bool) {
        self.app = app
        self.card = card
        self.placeholder = PostPlaceholderView(
            imageStore: app.images,
            card: card,
            scale: 1,
            showsSlotArea: false,
            uploadProgress: uploadProgress,
            onDropImage: { [weak app] url in app?.posts.uploadSlotImage(card: card, url: url) },
            onPickImage: { [weak app] in
                guard let url = ImageImport.pick(multiple: false).first else { return }
                app?.posts.uploadSlotImage(card: card, url: url)
            }
        )
        super.init(frame: .zero)
        alphaValue = dimmed ? 0 : 1

        placeholder.onTapCard = { [weak self] in self?.openCard() }
        addSubview(placeholder)

        let dateLabel = NSTextField.styledLabel(
            card.day.map(TurkishFormat.shortDay) ?? "Tarih yok",
            font: NSFont.systemFont(ofSize: 12, weight: .medium),
            color: Theme.textPrimary
        )
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let stateLabel = PostStateLabelView(state: card.state)

        let stack = NSStackView(views: [dateLabel, spacer, stateLabel])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        footerRow.addSubview(stack)
        addSubview(footerRow)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: footerRow.leadingAnchor, constant: 3),
            stack.trailingAnchor.constraint(equalTo: footerRow.trailingAnchor, constant: -3),
            stack.centerYAnchor.constraint(equalTo: footerRow.centerYAnchor),
        ])

        setAccessibilityRole(.button)
        setAccessibilityLabel("\(card.title), \(card.state.label)")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func layoutItem(visualHeight: CGFloat) {
        placeholder.frame = NSRect(x: 0, y: 0, width: bounds.width, height: visualHeight)
        footerRow.frame = NSRect(x: 0, y: visualHeight + 6, width: bounds.width, height: 20)
    }

    private func openCard() {
        let winFrame = placeholder.convert(placeholder.bounds, to: nil)
        app.detail = PostDetailModel(app: app, card: card, sourceFrame: winFrame)
    }
}

// MARK: - PostPlaceholderView (shared by Posts grid & PostDetailOverlay)

final class PostPlaceholderView: ThemedView {
    var onTapCard: (() -> Void)?

    private let card: PostCard
    private let scale: CGFloat
    private let showsSlotArea: Bool
    private let onDropImage: ((URL) -> Void)?
    private let onPickImage: (() -> Void)?
    private let onGenerateAISlot: (() -> Void)?
    private var slotControl: NSView?

    init(
        imageStore: ImageStore?,
        card: PostCard,
        scale: CGFloat,
        showsSlotArea: Bool = false,
        slideIndex: Int = 0,
        overrideVersion: ContentVersion? = nil,
        uploadProgress: Double? = nil,
        onDropImage: ((URL) -> Void)? = nil,
        onPickImage: (() -> Void)? = nil,
        onGenerateAISlot: (() -> Void)? = nil
    ) {
        self.card = card
        self.scale = scale
        self.showsSlotArea = showsSlotArea
        self.onDropImage = onDropImage
        self.onPickImage = onPickImage
        self.onGenerateAISlot = onGenerateAISlot
        super.init(frame: .zero)

        let effectiveVersion = overrideVersion ?? card.version
        let slides = effectiveVersion?.slides ?? []
        let activeSlide = slides.indices.contains(slideIndex) ? slides[slideIndex] : slides.first
        let slideNeedsImage: Bool = {
            if let activeSlide {
                let s = SlotScanner.slots(inHTML: activeSlide.html)
                if !s.isEmpty { return s.contains(where: \.isEmpty) }
            }
            return card.needsImage
        }()

        let tone = slideNeedsImage || card.state == .imageUploaded ? .muted : PlaceholderTone.stable(for: card.content.id)
        let radius = scale > 1 ? 0 : Theme.cardRadius
        cornerRadius = radius
        layer?.masksToBounds = true

        switch tone {
        case .light:
            backgroundColor = Theme.postLight
            borderColor = Theme.border
            borderWidth = 1
        case .dark:
            backgroundColor = Theme.postDark
            borderColor = Theme.border.withAlphaComponent(0.6)
            borderWidth = 1
        case .muted:
            backgroundColor = scale > 1 ? Theme.postDark : Theme.postMuted
            borderWidth = 0
        }

        let renderedId = activeSlide?.renderedAssetId ?? card.renderedAssetIds.first
        if let rendered = renderedId, !slideNeedsImage {
            let img = AssetImageView(store: imageStore, assetId: rendered, contentMode: .fill, cornerRadius: radius)
            img.translatesAutoresizingMaskIntoConstraints = false
            addSubview(img)
            NSLayoutConstraint.activate([
                img.leadingAnchor.constraint(equalTo: leadingAnchor),
                img.trailingAnchor.constraint(equalTo: trailingAnchor),
                img.topAnchor.constraint(equalTo: topAnchor),
                img.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        } else {
            let fgColor: NSColor = switch tone {
            case .light: Theme.postLightText
            case .dark: Theme.postDarkText
            case .muted: scale > 1 ? Theme.postDarkText : Theme.postMutedText
            }

            let hPad = 14 * min(scale, 1.7)
            let vPad = 16 * min(scale, 1.7)

            let vStack = NSStackView()
            vStack.orientation = .vertical
            vStack.alignment = .leading
            vStack.spacing = 6 * scale
            vStack.translatesAutoresizingMaskIntoConstraints = false
            addSubview(vStack)

            let scannedLayers = activeSlide.map { SlideLayerScanner.layers(inHTML: $0.html) } ?? []
            let editedManual = effectiveVersion?.origin == .manualEdit
            let eyebrowLayer = scannedLayers.first { $0.layerId == "eyebrow" }
            let titleLayer = scannedLayers.first { $0.layerId == "title" || $0.layerId == "headline" }

            let eyebrowText: String? = if let eyebrowLayer {
                eyebrowLayer.isHidden ? nil : eyebrowLayer.text
            } else {
                card.eyebrow
            }

            if let eyebrow = eyebrowText, !eyebrow.isEmpty {
                let eyebrowLabel = NSTextField(labelWithString: eyebrow)
                eyebrowLabel.font = NSFont.systemFont(ofSize: 8.5 * min(scale, 1.55), weight: .bold)
                eyebrowLabel.textColor = Theme.accent
                vStack.addArrangedSubview(eyebrowLabel)
            }

            let displayTitle: String = if editedManual, let titleLayer {
                titleLayer.isHidden ? "" : titleLayer.text
            } else {
                TurkishFormat.upper(card.title)
            }

            if !displayTitle.isEmpty {
                let titleLabel = NSTextField(wrappingLabelWithString: displayTitle)
                titleLabel.font = NSFont.systemFont(ofSize: 16 * scale, weight: .heavy)
                titleLabel.textColor = fgColor
                titleLabel.maximumNumberOfLines = 3
                vStack.addArrangedSubview(titleLabel)
                titleLabel.widthAnchor.constraint(equalTo: vStack.widthAnchor).isActive = true
            }

            if showsSlotArea, slideNeedsImage || card.state == .imageUploaded {
                let largeSlot = LargeSlotDropView(
                    onDropImage: onDropImage,
                    onPickImage: onPickImage,
                    onGenerateAISlot: onGenerateAISlot
                )
                largeSlot.setContentHuggingPriority(.defaultLow, for: .vertical)
                vStack.addArrangedSubview(largeSlot)
                largeSlot.widthAnchor.constraint(equalTo: vStack.widthAnchor).isActive = true
                self.slotControl = largeSlot
            } else {
                let spacer = NSView()
                spacer.setContentHuggingPriority(.defaultLow, for: .vertical)
                vStack.addArrangedSubview(spacer)
                if slideNeedsImage || card.state == .imageUploaded {
                    let smallSlot = SmallSlotDropView(
                        card: card,
                        uploadProgress: uploadProgress,
                        onDropImage: onDropImage,
                        onPickImage: onPickImage
                    )
                    vStack.addArrangedSubview(smallSlot)
                    self.slotControl = smallSlot
                }
            }

            NSLayoutConstraint.activate([
                vStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: hPad),
                vStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -hPad),
                vStack.topAnchor.constraint(equalTo: topAnchor, constant: vPad),
                vStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -vPad),
            ])
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        if let slotControl {
            let pt = slotControl.convert(event.locationInWindow, from: nil)
            if slotControl.bounds.contains(pt) {
                slotControl.mouseDown(with: event)
                return
            }
        }
        onTapCard?()
    }
}

// MARK: - Small & Large Image Slots

private final class SmallSlotDropView: NSView {
    private let onDropImage: ((URL) -> Void)?
    private let onPickImage: (() -> Void)?
    private let circleLayer = CAShapeLayer()
    private var targeted = false { didSet { updateRing() } }
    private var showsDashedPlus = false

    init(card: PostCard, uploadProgress: Double?, onDropImage: ((URL) -> Void)?, onPickImage: (() -> Void)?) {
        self.onDropImage = onDropImage
        self.onPickImage = onPickImage
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        registerForDraggedTypes([.fileURL])

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        if uploadProgress != nil {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            spinner.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                spinner.widthAnchor.constraint(equalToConstant: 36),
                spinner.heightAnchor.constraint(equalToConstant: 36),
            ])
            stack.addArrangedSubview(spinner)
            stack.addArrangedSubview(NSTextField.styledLabel("Yükleniyor", font: NSFont.systemFont(ofSize: 10), color: Theme.textSecondary))
        } else if card.state == .imageUploaded {
            let badge = ThemedView()
            badge.backgroundColor = Theme.canvas
            badge.cornerRadius = 18
            badge.translatesAutoresizingMaskIntoConstraints = false
            let check = NSImageView()
            check.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 13, weight: .semibold))
            check.contentTintColor = Theme.textSecondary
            check.translatesAutoresizingMaskIntoConstraints = false
            badge.addSubview(check)
            NSLayoutConstraint.activate([
                badge.widthAnchor.constraint(equalToConstant: 36),
                badge.heightAnchor.constraint(equalToConstant: 36),
                check.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
                check.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            ])
            stack.addArrangedSubview(badge)
            stack.addArrangedSubview(NSTextField.styledLabel("Görsel yüklendi", font: NSFont.systemFont(ofSize: 10), color: Theme.textSecondary))
        } else {
            showsDashedPlus = true
            let ringHolder = NSView(frame: NSRect(x: 0, y: 0, width: 36, height: 36))
            ringHolder.wantsLayer = true
            ringHolder.translatesAutoresizingMaskIntoConstraints = false
            ringHolder.layer?.addSublayer(circleLayer)
            let plus = NSImageView()
            plus.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
            plus.contentTintColor = Theme.accent
            plus.translatesAutoresizingMaskIntoConstraints = false
            ringHolder.addSubview(plus)
            NSLayoutConstraint.activate([
                ringHolder.widthAnchor.constraint(equalToConstant: 36),
                ringHolder.heightAnchor.constraint(equalToConstant: 36),
                plus.centerXAnchor.constraint(equalTo: ringHolder.centerXAnchor),
                plus.centerYAnchor.constraint(equalTo: ringHolder.centerYAnchor),
            ])
            toolTip = "Görsel ekle: tıkla ya da görseli buraya sürükle"
            stack.addArrangedSubview(ringHolder)
            stack.addArrangedSubview(NSTextField.styledLabel("Görsel ekle", font: NSFont.systemFont(ofSize: 10), color: Theme.textSecondary))
            updateRing()
        }

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func updateRing() {
        guard showsDashedPlus else { return }
        let rect = CGRect(x: 0.5, y: 0.5, width: 35, height: 35)
        circleLayer.path = CGPath(ellipseIn: rect, transform: nil)
        circleLayer.strokeColor = resolvedCGColor(Theme.accent)
        circleLayer.fillColor = targeted ? resolvedCGColor(Theme.accent.withAlphaComponent(0.12)) : nil
        circleLayer.lineWidth = 1
        circleLayer.lineDashPattern = [3, 3]
    }

    override func mouseDown(with event: NSEvent) {
        onPickImage?()
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard ImageImport.pasteboardHasImages(sender.draggingPasteboard) else { return [] }
        targeted = true
        return .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) { targeted = false }
    override func draggingEnded(_ sender: any NSDraggingInfo) { targeted = false }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        targeted = false
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: ImageImport.fileTypes.map(\.identifier),
        ]
        guard let url = (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL])?.first else {
            return false
        }
        onDropImage?(url)
        return true
    }
}

private final class LargeSlotDropView: ThemedView {
    private let onDropImage: ((URL) -> Void)?
    private let onPickImage: (() -> Void)?
    private let onGenerateAISlot: (() -> Void)?
    private var aiButton: PillButton?
    private let dashLayer = CAShapeLayer()
    private var targeted = false { didSet { updateAppearance() } }

    init(onDropImage: ((URL) -> Void)?, onPickImage: (() -> Void)?, onGenerateAISlot: (() -> Void)? = nil) {
        self.onDropImage = onDropImage
        self.onPickImage = onPickImage
        self.onGenerateAISlot = onGenerateAISlot
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        cornerRadius = 18
        backgroundColor = Theme.slotFill
        layer?.addSublayer(dashLayer)
        registerForDraggedTypes([.fileURL])

        let title = NSTextField.styledLabel("Görsel ekle", font: NSFont.systemFont(ofSize: 13, weight: .medium), color: NSColor.white.withAlphaComponent(0.85))
        let sub = NSTextField.styledLabel("sürükle ya da dosyadan seç", font: NSFont.systemFont(ofSize: 10), color: NSColor.white.withAlphaComponent(0.5))
        var views: [NSView] = [title, sub]

        if let onGenerateAISlot {
            let btn = PillButton(title: "AI ile Yuvayı Doldur…", kind: .primary, height: 26, action: onGenerateAISlot)
            self.aiButton = btn
            views.append(btn)
        }

        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(greaterThanOrEqualToConstant: 140),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        updateAppearance()
    }

    private func updateAppearance() {
        backgroundColor = targeted ? Theme.slotFill.withAlphaComponent(0.7) : Theme.slotFill
        let inset = bounds.insetBy(dx: 0.75, dy: 0.75)
        guard inset.width > 0, inset.height > 0 else { return }
        dashLayer.frame = bounds
        dashLayer.path = CGPath(roundedRect: inset, cornerWidth: 18, cornerHeight: 18, transform: nil)
        dashLayer.fillColor = nil
        dashLayer.strokeColor = resolvedCGColor(Theme.accent)
        dashLayer.lineWidth = 1.2
        dashLayer.lineDashPattern = [5, 4]
    }

    override func mouseDown(with event: NSEvent) {
        if let aiButton {
            let pt = aiButton.convert(event.locationInWindow, from: nil)
            if aiButton.bounds.contains(pt) {
                aiButton.mouseDown(with: event)
                return
            }
        }
        onPickImage?()
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard ImageImport.pasteboardHasImages(sender.draggingPasteboard) else { return [] }
        targeted = true
        return .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) { targeted = false }
    override func draggingEnded(_ sender: any NSDraggingInfo) { targeted = false }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        targeted = false
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: ImageImport.fileTypes.map(\.identifier),
        ]
        guard let url = (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL])?.first else {
            return false
        }
        onDropImage?(url)
        return true
    }
}

// MARK: - ApproveBarView & FilterPillsControlView

private final class ApproveBarView: NSView {
    private let glass = GlassContainerView(cornerRadius: 18)
    private let label = NSTextField.styledLabel("", font: NSFont.systemFont(ofSize: 13, weight: .medium), color: Theme.textPrimary)
    private let approveButton: PillButton

    init(onApprove: @escaping () -> Void) {
        self.approveButton = PillButton(title: "Onayla", kind: .primary, height: 28, action: onApprove)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        approveButton.toolTip = "Hazır postların hepsini gösterilen sürümleriyle onayla"

        let dot = StatusDotView(color: Theme.ink)
        let row = NSStackView(views: [dot, label, approveButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false

        glass.contentContainer.addSubview(row)
        addSubview(glass)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 36),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),

            row.leadingAnchor.constraint(equalTo: glass.contentContainer.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: glass.contentContainer.trailingAnchor, constant: -4),
            row.centerYAnchor.constraint(equalTo: glass.contentContainer.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(count: Int, isApproving: Bool) {
        label.stringValue = "\(count) post onaya hazır"
        approveButton.showsSpinner = isApproving
        approveButton.isEnabled = !isApproving
    }
}

private final class FilterPillsControlView: ThemedView {
    private let onSelect: (PostFilter) -> Void
    private var segments: [PostFilter: SegmentPillView] = [:]

    init(onSelect: @escaping (PostFilter) -> Void) {
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.fill
        cornerRadius = 15
        setAccessibilityLabel("Durum filtresi")

        var views: [NSView] = []
        for filter in PostFilter.allCases {
            let pill = SegmentPillView(title: filter.label) { [weak self] in
                self?.onSelect(filter)
            }
            segments[filter] = pill
            views.append(pill)
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 2
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 30),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(selection: PostFilter, counts: [PostFilter: Int]) {
        for filter in PostFilter.allCases {
            segments[filter]?.update(selected: filter == selection, count: counts[filter] ?? 0)
        }
    }

    private final class SegmentPillView: ThemedView {
        private let titleLabel: NSTextField
        private let countLabel = NSTextField(labelWithString: "0")
        private let onClick: () -> Void

        init(title: String, onClick: @escaping () -> Void) {
            self.titleLabel = NSTextField(labelWithString: title)
            self.onClick = onClick
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            cornerRadius = 13

            countLabel.font = NSFont.systemFont(ofSize: 12)
            countLabel.textColor = Theme.textSecondary

            let row = NSStackView(views: [titleLabel, countLabel])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 6
            row.translatesAutoresizingMaskIntoConstraints = false
            addSubview(row)

            NSLayoutConstraint.activate([
                heightAnchor.constraint(equalToConstant: 26),
                row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
                row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                row.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        func update(selected: Bool, count: Int) {
            backgroundColor = selected ? Theme.canvas : nil
            titleLabel.font = NSFont.systemFont(ofSize: 12, weight: selected ? .semibold : .regular)
            titleLabel.textColor = selected ? Theme.textPrimary : Theme.textSecondary
            countLabel.font = NSFont.systemFont(ofSize: 12, weight: selected ? .semibold : .regular)
            countLabel.stringValue = "\(count)"
            if selected {
                layer?.shadowColor = NSColor.black.cgColor
                layer?.shadowOpacity = 0.08
                layer?.shadowRadius = 2
                layer?.shadowOffset = CGSize(width: 0, height: -1)
            } else {
                layer?.shadowOpacity = 0
            }
        }

        override func mouseDown(with event: NSEvent) {
            onClick()
        }
    }
}
