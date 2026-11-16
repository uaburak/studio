import AppKit
import AVFoundation
import AVKit
import StudioKit

/// Card geometry for a container size: the post is 4:5 on the left, details on the right.
struct DetailLayout {
    var card: CGRect
    var post: CGRect

    init(container: CGSize) {
        let height = min(max(container.height * 0.72, 460), 680, container.height - 56)
        let postWidth = height * 0.8
        let infoWidth: CGFloat = min(390, max(320, container.width * 0.26))
        let width = min(postWidth + infoWidth, container.width - 56)
        let origin = CGPoint(x: (container.width - width) / 2, y: (container.height - height) / 2)
        card = CGRect(origin: origin, size: CGSize(width: width, height: height))
        post = CGRect(origin: origin, size: CGSize(width: postWidth, height: height))
    }
}

/// Pure AppKit opened post overlay (06):
/// - Dimmed Liquid Glass backdrop (`NSGlassEffectView`), click outside or Esc closes
/// - 4:5 large post preview + multi-slide pager + Reels `AVPlayerView` + real slot-fill + AI slot-fill
/// - `DetailInfoPanelView` on right with `"Detaylar"` | `"Katmanlar"` tabs, version picker,
///   JPEG / LinkedIn PDF Carousel export, inline `[data-layer]` editing, `"Zamanla"` & `"Onayla"` (`⌘↩`).
final class PostDetailOverlayView: NSView {
    let model: PostDetailModel

    private let backdropGlass = GlassContainerView(cornerRadius: 0, tint: NSColor.black.withAlphaComponent(0.22))
    private let cardShell = ThemedView()
    private let postHost = NSView()
    private let slotOverlay = NSView()
    private let pagerOverlay = ThemedView()
    private let pagerLabel = NSTextField(labelWithString: "")
    private var videoToggleBtn: PillButton!
    private var playerView: AVPlayerView?
    private let infoPanel: DetailInfoPanelView

    private var observation: ObservationToken?
    private var lastPreviewKey: PreviewKey?
    private var lastSlotState: PostDetailModel.SlotUpload?

    private struct PreviewKey: Equatable {
        var card: PostCard
        var versionId: EntityID?
        var slideIndex: Int
        var showVideo: Bool
        var videoURL: URL?
    }

    init(model: PostDetailModel) {
        self.model = model
        var closeBlock: () -> Void = {}
        self.infoPanel = DetailInfoPanelView(model: model, onClose: { closeBlock() })
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        closeBlock = { [weak self] in self?.closeOverlay() }

        addSubview(backdropGlass)
        NSLayoutConstraint.activate([
            backdropGlass.leadingAnchor.constraint(equalTo: leadingAnchor),
            backdropGlass.trailingAnchor.constraint(equalTo: trailingAnchor),
            backdropGlass.topAnchor.constraint(equalTo: topAnchor),
            backdropGlass.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        cardShell.backgroundColor = Theme.canvas
        cardShell.cornerRadius = Theme.panelRadius
        cardShell.layer?.masksToBounds = true
        addSubview(cardShell)

        cardShell.addSubview(postHost)
        postHost.addSubview(slotOverlay)

        // Multi-slide pager bar
        pagerOverlay.backgroundColor = NSColor.black.withAlphaComponent(0.66)
        pagerOverlay.cornerRadius = 14
        pagerOverlay.translatesAutoresizingMaskIntoConstraints = false
        let prevSlide = GlyphButton(symbol: "chevron.left", size: 10, weight: .bold, diameter: 22) { [weak model] in
            guard let model else { return }
            model.selectSlide(model.selectedSlideIndex - 1)
        }
        let nextSlide = GlyphButton(symbol: "chevron.right", size: 10, weight: .bold, diameter: 22) { [weak model] in
            guard let model else { return }
            model.selectSlide(model.selectedSlideIndex + 1)
        }
        pagerLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        pagerLabel.textColor = .white
        let pagerStack = NSStackView(views: [prevSlide, pagerLabel, nextSlide])
        pagerStack.orientation = .horizontal
        pagerStack.alignment = .centerY
        pagerStack.spacing = 6
        pagerStack.translatesAutoresizingMaskIntoConstraints = false
        pagerOverlay.addSubview(pagerStack)
        postHost.addSubview(pagerOverlay)

        // Reels cover/video toggle pill
        videoToggleBtn = PillButton(title: "Kapak Görseli", kind: .secondary, height: 26) { [weak model] in
            guard let model else { return }
            model.showReelVideo.toggle()
        }
        videoToggleBtn.isHidden = true
        postHost.addSubview(videoToggleBtn)

        NSLayoutConstraint.activate([
            pagerOverlay.heightAnchor.constraint(equalToConstant: 28),
            pagerStack.leadingAnchor.constraint(equalTo: pagerOverlay.leadingAnchor, constant: 6),
            pagerStack.trailingAnchor.constraint(equalTo: pagerOverlay.trailingAnchor, constant: -6),
            pagerStack.centerYAnchor.constraint(equalTo: pagerOverlay.centerYAnchor),
            pagerOverlay.centerXAnchor.constraint(equalTo: postHost.centerXAnchor),
            pagerOverlay.bottomAnchor.constraint(equalTo: postHost.bottomAnchor, constant: -14),

            videoToggleBtn.topAnchor.constraint(equalTo: postHost.topAnchor, constant: 14),
            videoToggleBtn.trailingAnchor.constraint(equalTo: postHost.trailingAnchor, constant: -14),
        ])

        cardShell.addSubview(infoPanel)

        observation = observe { [weak self] in
            self?.syncOverlay()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        playerView?.player?.pause()
    }

    override var acceptsFirstResponder: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        closeOverlay()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.keyCode == 53 { // Escape
            closeOverlay()
            return true
        }
        if event.modifierFlags.contains(.command) && (event.charactersIgnoringModifiers == "\r" || event.keyCode == 36) {
            if model.canApprove {
                Task { await model.approve() }
                return true
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    override func mouseDown(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        if !cardShell.frame.contains(pt) {
            closeOverlay()
        }
    }

    override func layout() {
        super.layout()
        guard bounds.width > 100, bounds.height > 100 else { return }
        let layout = DetailLayout(container: bounds.size)
        cardShell.frame = layout.card
        postHost.frame = CGRect(x: 0, y: 0, width: layout.post.width, height: layout.post.height)
        for sub in postHost.subviews where sub !== slotOverlay && sub !== pagerOverlay && sub !== videoToggleBtn {
            sub.frame = postHost.bounds
        }
        slotOverlay.frame = postHost.bounds
        infoPanel.frame = CGRect(
            x: layout.post.width,
            y: 0,
            width: layout.card.width - layout.post.width,
            height: layout.card.height
        )
    }

    private func syncOverlay() {
        let key = PreviewKey(
            card: model.card,
            versionId: model.activeVersion?.id,
            slideIndex: model.selectedSlideIndex,
            showVideo: model.showReelVideo && model.hasVideoCapability,
            videoURL: model.videoPreviewURL
        )
        if key != lastPreviewKey {
            lastPreviewKey = key
            rebuildPostPreview(key: key)
        }

        let slideCount = model.slides.count
        pagerOverlay.isHidden = slideCount <= 1 || key.showVideo
        pagerLabel.stringValue = "\(model.selectedSlideIndex + 1) / \(max(1, slideCount))"

        videoToggleBtn.isHidden = !model.hasVideoCapability
        videoToggleBtn.title = model.showReelVideo ? "Kapak Görseli" : "Videoyu Oynat"

        let slotState = model.slotUpload
        if slotState != lastSlotState {
            lastSlotState = slotState
            rebuildSlotOverlay(slotState)
        }
    }

    private func rebuildPostPreview(key: PreviewKey) {
        playerView?.player?.pause()
        playerView = nil
        for sub in postHost.subviews where sub !== slotOverlay && sub !== pagerOverlay && sub !== videoToggleBtn {
            sub.removeFromSuperview()
        }

        if key.showVideo {
            if let url = key.videoURL {
                let pv = AVPlayerView()
                pv.controlsStyle = .floating
                pv.videoGravity = .resizeAspectFill
                pv.player = AVPlayer(url: url)
                postHost.addSubview(pv, positioned: .below, relativeTo: slotOverlay)
                pv.frame = postHost.bounds
                self.playerView = pv
            } else {
                let emptyReel = ThemedView()
                emptyReel.backgroundColor = Theme.postDark
                let icon = NSImageView()
                icon.image = NSImage(systemSymbolName: "video.fill", accessibilityDescription: nil)?
                    .withSymbolConfiguration(.init(pointSize: 36, weight: .regular))
                icon.contentTintColor = Theme.accent
                let lbl = NSTextField.styledLabel("Reels video önizlemesi", font: NSFont.systemFont(ofSize: 14, weight: .semibold), color: .white)
                let hint = NSTextField.styledLabel("Medya kütüphanesine video yüklendiğinde burada oynatılır.", font: Theme.smallFont, color: NSColor.white.withAlphaComponent(0.65), wraps: true)
                hint.alignment = .center
                hint.translatesAutoresizingMaskIntoConstraints = false
                hint.widthAnchor.constraint(equalToConstant: 240).isActive = true
                let st = NSStackView(views: [icon, lbl, hint])
                st.orientation = .vertical
                st.alignment = .centerX
                st.spacing = 8
                st.translatesAutoresizingMaskIntoConstraints = false
                emptyReel.addSubview(st)
                NSLayoutConstraint.activate([
                    st.centerXAnchor.constraint(equalTo: emptyReel.centerXAnchor),
                    st.centerYAnchor.constraint(equalTo: emptyReel.centerYAnchor),
                ])
                postHost.addSubview(emptyReel, positioned: .below, relativeTo: slotOverlay)
                emptyReel.frame = postHost.bounds
            }
            return
        }

        let approxScale = max(1.6, (bounds.height > 100 ? DetailLayout(container: bounds.size).post.width : 360) / 190)
        let placeholder = PostPlaceholderView(
            imageStore: model.app.images,
            card: model.card,
            scale: approxScale,
            showsSlotArea: true,
            slideIndex: key.slideIndex,
            overrideVersion: model.activeVersion,
            onDropImage: { [weak model] url in model?.importSlotImage(urls: [url]) },
            onPickImage: { [weak model] in model?.importSlotImage(urls: ImageImport.pick(multiple: false)) },
            onGenerateAISlot: { [weak model] in model?.openAISlotGenerator() }
        )
        postHost.addSubview(placeholder, positioned: .below, relativeTo: slotOverlay)
        placeholder.frame = postHost.bounds
    }

    private func rebuildSlotOverlay(_ state: PostDetailModel.SlotUpload) {
        slotOverlay.subviews.forEach { $0.removeFromSuperview() }
        switch state {
        case .none:
            slotOverlay.isHidden = true
        case .uploading(let progress):
            slotOverlay.isHidden = false
            let badge = makeDarkOverlayCard()
            let bar = NSProgressIndicator()
            bar.isIndeterminate = false
            bar.minValue = 0
            bar.maxValue = 1
            bar.doubleValue = progress
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.widthAnchor.constraint(equalToConstant: 140).isActive = true
            let lbl = NSTextField.styledLabel("Görsel yükleniyor %\(Int(progress * 100))", font: Theme.captionFont, color: NSColor.white.withAlphaComponent(0.9))
            let stack = NSStackView(views: [bar, lbl])
            stack.orientation = .vertical
            stack.alignment = .centerX
            stack.spacing = 8
            embedInOverlay(badge: badge, content: stack)
        case .rendering:
            slotOverlay.isHidden = false
            let badge = makeDarkOverlayCard()
            var views: [NSView] = []
            if let img = model.slotImage {
                let iv = AssetImageView(store: nil, contentMode: .fit, cornerRadius: 12)
                iv.localImage = img
                iv.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    iv.widthAnchor.constraint(equalToConstant: 132),
                    iv.heightAnchor.constraint(equalToConstant: 132),
                ])
                views.append(iv)
            }
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.appearance = NSAppearance(named: .darkAqua)
            spinner.startAnimation(nil)
            views.append(spinner)
            views.append(NSTextField.styledLabel(
                "Yuvaya yerleştiriliyor ve yeniden render ediliyor…",
                font: NSFont.systemFont(ofSize: 12, weight: .medium),
                color: NSColor.white.withAlphaComponent(0.92)
            ))
            let stack = NSStackView(views: views)
            stack.orientation = .vertical
            stack.alignment = .centerX
            stack.spacing = 8
            embedInOverlay(badge: badge, content: stack)
        case .failed(let message):
            slotOverlay.isHidden = false
            let badge = makeDarkOverlayCard()
            let lbl = NSTextField.styledLabel(message, font: Theme.captionFont, color: NSColor.white.withAlphaComponent(0.9), wraps: true)
            lbl.alignment = .center
            lbl.translatesAutoresizingMaskIntoConstraints = false
            lbl.widthAnchor.constraint(equalToConstant: 210).isActive = true
            let retry = PillButton(title: "Yeniden dene", kind: .secondary) { [weak model] in
                model?.retrySlotUpload()
            }
            let stack = NSStackView(views: [lbl, retry])
            stack.orientation = .vertical
            stack.alignment = .centerX
            stack.spacing = 8
            embedInOverlay(badge: badge, content: stack)
        }
    }

    private func makeDarkOverlayCard() -> ThemedView {
        let card = ThemedView()
        card.backgroundColor = NSColor.black.withAlphaComponent(0.65)
        card.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        return card
    }

    private func embedInOverlay(badge: ThemedView, content: NSView) {
        content.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(content)
        slotOverlay.addSubview(badge)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: badge.leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: badge.trailingAnchor, constant: -16),
            content.topAnchor.constraint(equalTo: badge.topAnchor, constant: 16),
            content.bottomAnchor.constraint(equalTo: badge.bottomAnchor, constant: -16),
            badge.centerXAnchor.constraint(equalTo: slotOverlay.centerXAnchor),
            badge.centerYAnchor.constraint(equalTo: slotOverlay.centerYAnchor),
        ])
    }

    private func closeOverlay() {
        playerView?.player?.pause()
        model.schedulePresented = false
        model.app.detail = nil
    }
}

// MARK: - DetailInfoPanelView ("Detaylar" | "Katmanlar")

private final class DetailInfoPanelView: ThemedView, NSTextViewDelegate, NSTextFieldDelegate {
    private let model: PostDetailModel
    private let onClose: () -> Void

    private let handleLabel = NSTextField(labelWithString: "")
    private var tabControl: NSSegmentedControl!

    // Details tab views
    private let detailsContainer = NSStackView()
    private let stateLabel: PostStateLabelView
    private let versionPopup = NSPopUpButton()
    private var exportMenuBtn: PillButton!
    private let captionReadStack = ClickableCaptionReadView()
    private let captionBodyLabel = NSTextField(wrappingLabelWithString: "")
    private let hashtagsReadLabel = NSTextField(wrappingLabelWithString: "")

    private let captionEditStack = NSStackView()
    private let captionTextView = NSTextView()
    private let hashtagsField = NSTextField()
    private let approvalWarnLabel = NSTextField.styledLabel(
        "Kaydedince onay kalkar; yeniden onaylaman gerekir.",
        font: Theme.smallFont,
        color: Theme.textSecondary,
        wraps: true
    )
    private var saveCaptionButton: PillButton!

    private let dateValueLabel = NSTextField(labelWithString: "")
    private let platformValueLabel = NSTextField(labelWithString: "")
    private let typeValueLabel = NSTextField(labelWithString: "")
    private let exportStatusLabel = NSTextField(wrappingLabelWithString: "")
    private let instructionJobRow = NSStackView()
    private let instructionJobLabel = NSTextField(labelWithString: "")

    // Layers tab views
    private let layersContainer = NSStackView()
    private let layersListStack = NSStackView()
    private var applyLayersBtn: PillButton!
    private var renderedLayersSnapshot: [SlideLayer] = []

    private let errorBanner = InlineErrorBannerView()
    private let instructionField = NSTextField()
    private let sendInstructionBtn = GlyphButton(symbol: "return", size: 11)
    private let instrWrapper = ThemedView()
    private var scheduleBtn: PillButton!
    private var approveBtn: PillButton!

    private var observation: ObservationToken?
    private var wasEditingCaption = false
    private var activeSchedulePopover: NSPopover?

    init(model: PostDetailModel, onClose: @escaping () -> Void) {
        self.model = model
        self.onClose = onClose
        self.stateLabel = PostStateLabelView(state: model.card.state)
        super.init(frame: .zero)
        backgroundColor = Theme.canvas

        buildUI()
        observation = observe { [weak self] in
            self?.syncPanel()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildUI() {
        // Header
        let avatar = StatusDotView(color: Theme.ink, size: 24)
        handleLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        handleLabel.textColor = Theme.textPrimary
        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let closeBtn = GlyphButton(symbol: "xmark", size: 10, weight: .semibold, action: onClose)
        closeBtn.toolTip = "Kapat (esc)"
        closeBtn.setAccessibilityLabel("Kapat")

        let headerRow = NSStackView(views: [avatar, handleLabel, headerSpacer, closeBtn])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 10
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        tabControl = NSSegmentedControl(labels: ["Detaylar", "Katmanlar"], trackingMode: .selectOne, target: self, action: #selector(tabChanged))
        tabControl.selectedSegment = 0

        let topHairline = HairlineView()

        // Scrollable body
        let scroll = NSScrollView()
        let clip = FlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let doc = FlippedDocumentView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = doc
        scroll.applyMinimalScroller()

        buildDetailsTab()
        buildLayersTab()

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak model] in model?.error = nil }

        let scrollStack = NSStackView(views: [
            detailsContainer,
            layersContainer,
            errorBanner,
        ])
        scrollStack.orientation = .vertical
        scrollStack.alignment = .leading
        scrollStack.spacing = 12
        scrollStack.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(scrollStack)

        detailsContainer.widthAnchor.constraint(equalTo: scrollStack.widthAnchor).isActive = true
        layersContainer.widthAnchor.constraint(equalTo: scrollStack.widthAnchor).isActive = true
        errorBanner.widthAnchor.constraint(equalTo: scrollStack.widthAnchor).isActive = true

        NSLayoutConstraint.activate([
            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),

            scrollStack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            scrollStack.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
            scrollStack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 12),
            scrollStack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -8),
        ])

        // Instruction field
        instrWrapper.borderColor = Theme.border
        instrWrapper.borderWidth = 1
        instrWrapper.cornerRadius = 17
        instrWrapper.translatesAutoresizingMaskIntoConstraints = false

        instructionField.isBordered = false
        instructionField.drawsBackground = false
        instructionField.focusRingType = .none
        instructionField.font = NSFont.systemFont(ofSize: 12)
        instructionField.textColor = Theme.textPrimary
        instructionField.placeholderString = "Neyi değiştireyim?"
        instructionField.delegate = self

        sendInstructionBtn.toolTip = "Yeni sürüm iste: Mac'teki üretici bu talimatla düzeltir"
        sendInstructionBtn.onAction = { [weak model] in
            guard let model else { return }
            Task { await model.sendInstruction() }
        }

        let instrRow = NSStackView(views: [instructionField, sendInstructionBtn])
        instrRow.orientation = .horizontal
        instrRow.alignment = .centerY
        instrRow.spacing = 8
        instrRow.translatesAutoresizingMaskIntoConstraints = false
        instrWrapper.addSubview(instrRow)
        NSLayoutConstraint.activate([
            instrWrapper.heightAnchor.constraint(equalToConstant: 34),
            instrRow.leadingAnchor.constraint(equalTo: instrWrapper.leadingAnchor, constant: 14),
            instrRow.trailingAnchor.constraint(equalTo: instrWrapper.trailingAnchor, constant: -4),
            instrRow.centerYAnchor.constraint(equalTo: instrWrapper.centerYAnchor),
        ])

        // Bottom buttons
        let bottomSpacer = NSView()
        bottomSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        scheduleBtn = PillButton(title: "Zamanla", kind: .secondary, height: 28) { [weak self] in
            self?.toggleSchedulePopover()
        }

        approveBtn = PillButton(title: "Onayla", kind: .primary, height: 28) { [weak model] in
            guard let model else { return }
            Task { await model.approve() }
        }

        let actionsRow = NSStackView(views: [bottomSpacer, scheduleBtn, approveBtn])
        actionsRow.orientation = .horizontal
        actionsRow.alignment = .centerY
        actionsRow.spacing = 8

        let mainStack = NSStackView(views: [headerRow, tabControl, topHairline, scroll, instrWrapper, actionsRow])
        mainStack.orientation = .vertical
        mainStack.alignment = .leading
        mainStack.spacing = 10
        mainStack.setCustomSpacing(0, after: topHairline)
        mainStack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(mainStack)

        for full: NSView in [headerRow, tabControl, topHairline, scroll, instrWrapper, actionsRow] {
            full.widthAnchor.constraint(equalTo: mainStack.widthAnchor).isActive = true
        }

        NSLayoutConstraint.activate([
            mainStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            mainStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            mainStack.topAnchor.constraint(equalTo: topAnchor, constant: 18),
            mainStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -18),
        ])
    }

    private func buildDetailsTab() {
        // State + Version popup + Export button
        versionPopup.controlSize = .small
        versionPopup.font = Theme.smallFont
        versionPopup.target = self
        versionPopup.action = #selector(versionChanged)

        exportMenuBtn = PillButton(title: "Dışa Aktar ▾", kind: .outline, height: 24) { [weak self] in
            self?.showExportMenu()
        }

        let topMetaSpacer = NSView()
        topMetaSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let statusAndVersionRow = NSStackView(views: [stateLabel, topMetaSpacer, versionPopup, exportMenuBtn])
        statusAndVersionRow.orientation = .horizontal
        statusAndVersionRow.alignment = .centerY
        statusAndVersionRow.spacing = 6

        // Read-only caption
        captionBodyLabel.font = NSFont.systemFont(ofSize: 13)
        captionReadStack.onClick = { [weak self] in
            guard let self, !self.model.content.status.isLocked else { return }
            self.model.isEditingCaption = true
        }
        hashtagsReadLabel.font = NSFont.systemFont(ofSize: 12)
        hashtagsReadLabel.textColor = Theme.textSecondary
        captionReadStack.setup(body: captionBodyLabel, hashtags: hashtagsReadLabel)

        // Editable caption
        let editorBox = ThemedView()
        editorBox.borderColor = Theme.border
        editorBox.borderWidth = 1
        editorBox.cornerRadius = 12
        editorBox.translatesAutoresizingMaskIntoConstraints = false

        let editorScroll = NSScrollView()
        editorScroll.drawsBackground = false
        editorScroll.borderType = .noBorder
        editorScroll.hasVerticalScroller = true
        editorScroll.translatesAutoresizingMaskIntoConstraints = false
        captionTextView.isRichText = false
        captionTextView.drawsBackground = false
        captionTextView.font = NSFont.systemFont(ofSize: 13)
        captionTextView.textColor = Theme.textPrimary
        captionTextView.delegate = self
        captionTextView.isVerticallyResizable = true
        captionTextView.isHorizontallyResizable = false
        captionTextView.autoresizingMask = [.width]
        captionTextView.textContainer?.widthTracksTextView = true
        editorScroll.documentView = captionTextView
        editorBox.addSubview(editorScroll)
        NSLayoutConstraint.activate([
            editorBox.heightAnchor.constraint(equalToConstant: 96),
            editorScroll.leadingAnchor.constraint(equalTo: editorBox.leadingAnchor, constant: 6),
            editorScroll.trailingAnchor.constraint(equalTo: editorBox.trailingAnchor, constant: -6),
            editorScroll.topAnchor.constraint(equalTo: editorBox.topAnchor, constant: 6),
            editorScroll.bottomAnchor.constraint(equalTo: editorBox.bottomAnchor, constant: -6),
        ])

        let tagsWrapper = ThemedView()
        tagsWrapper.borderColor = Theme.border
        tagsWrapper.borderWidth = 1
        tagsWrapper.cornerRadius = 14
        tagsWrapper.translatesAutoresizingMaskIntoConstraints = false
        hashtagsField.isBordered = false
        hashtagsField.drawsBackground = false
        hashtagsField.focusRingType = .none
        hashtagsField.font = NSFont.systemFont(ofSize: 12)
        hashtagsField.textColor = Theme.textSecondary
        hashtagsField.placeholderString = "#etiketler"
        hashtagsField.delegate = self
        hashtagsField.translatesAutoresizingMaskIntoConstraints = false
        tagsWrapper.addSubview(hashtagsField)
        NSLayoutConstraint.activate([
            tagsWrapper.heightAnchor.constraint(equalToConstant: 28),
            hashtagsField.leadingAnchor.constraint(equalTo: tagsWrapper.leadingAnchor, constant: 10),
            hashtagsField.trailingAnchor.constraint(equalTo: tagsWrapper.trailingAnchor, constant: -10),
            hashtagsField.centerYAnchor.constraint(equalTo: tagsWrapper.centerYAnchor),
        ])

        let cancelEditBtn = PillButton(title: "Vazgeç", kind: .secondary) { [weak model] in
            guard let model else { return }
            let parts = CaptionParts(caption: model.content.caption)
            model.captionDraft = parts.body
            model.hashtagsDraft = parts.hashtags.joined(separator: " ")
            model.isEditingCaption = false
        }
        saveCaptionButton = PillButton(title: "Kaydet", kind: .secondary) { [weak model] in
            guard let model else { return }
            Task { await model.saveCaption() }
        }
        let editBtns = NSStackView(views: [cancelEditBtn, saveCaptionButton])
        editBtns.orientation = .horizontal
        editBtns.spacing = 8

        captionEditStack.orientation = .vertical
        captionEditStack.alignment = .leading
        captionEditStack.spacing = 8
        captionEditStack.addArrangedSubview(editorBox)
        captionEditStack.addArrangedSubview(tagsWrapper)
        captionEditStack.addArrangedSubview(approvalWarnLabel)
        captionEditStack.addArrangedSubview(editBtns)
        captionEditStack.isHidden = true
        editorBox.widthAnchor.constraint(equalTo: captionEditStack.widthAnchor).isActive = true
        tagsWrapper.widthAnchor.constraint(equalTo: captionEditStack.widthAnchor).isActive = true
        approvalWarnLabel.widthAnchor.constraint(equalTo: captionEditStack.widthAnchor).isActive = true

        // Facts
        let factsStack = NSStackView(views: [
            makeFactRow("Tarih", valueField: dateValueLabel),
            makeFactRow("Platform", valueField: platformValueLabel),
            makeFactRow("Tür", valueField: typeValueLabel),
        ])
        factsStack.orientation = .vertical
        factsStack.alignment = .leading
        factsStack.spacing = 12
        for sub in factsStack.arrangedSubviews {
            sub.widthAnchor.constraint(equalTo: factsStack.widthAnchor).isActive = true
        }

        exportStatusLabel.font = Theme.smallFont
        exportStatusLabel.textColor = Theme.textSecondary
        exportStatusLabel.isHidden = true

        instructionJobLabel.font = Theme.smallFont
        instructionJobLabel.textColor = Theme.textSecondary
        instructionJobRow.orientation = .horizontal
        instructionJobRow.alignment = .centerY
        instructionJobRow.spacing = 6
        instructionJobRow.addArrangedSubview(StatusDotView(color: Theme.accent))
        instructionJobRow.addArrangedSubview(instructionJobLabel)
        instructionJobRow.isHidden = true

        let midHairline = HairlineView()

        detailsContainer.orientation = .vertical
        detailsContainer.alignment = .leading
        detailsContainer.spacing = 14
        detailsContainer.addArrangedSubview(statusAndVersionRow)
        detailsContainer.addArrangedSubview(captionReadStack)
        detailsContainer.addArrangedSubview(captionEditStack)
        detailsContainer.addArrangedSubview(midHairline)
        detailsContainer.addArrangedSubview(factsStack)
        detailsContainer.addArrangedSubview(exportStatusLabel)
        detailsContainer.addArrangedSubview(instructionJobRow)

        for full in [statusAndVersionRow, captionReadStack, captionEditStack, midHairline, factsStack, exportStatusLabel] {
            full.widthAnchor.constraint(equalTo: detailsContainer.widthAnchor).isActive = true
        }
    }

    private func buildLayersTab() {
        layersContainer.orientation = .vertical
        layersContainer.alignment = .leading
        layersContainer.spacing = 12
        layersContainer.isHidden = true

        let intro = NSTextField.styledLabel(
            "Slayttaki [data-layer] öğelerini doğrudan düzenle ya da gizle; uygulayınca yeni sürüm render edilir.",
            font: Theme.smallFont,
            color: Theme.textSecondary,
            wraps: true
        )
        layersContainer.addArrangedSubview(intro)
        intro.widthAnchor.constraint(equalTo: layersContainer.widthAnchor).isActive = true

        layersListStack.orientation = .vertical
        layersListStack.alignment = .leading
        layersListStack.spacing = 10
        layersContainer.addArrangedSubview(layersListStack)
        layersListStack.widthAnchor.constraint(equalTo: layersContainer.widthAnchor).isActive = true

        applyLayersBtn = PillButton(title: "Katmanları Uygula ve Render Et", kind: .primary, height: 28) { [weak model] in
            guard let model else { return }
            Task { await model.applyLayerEdits() }
        }
        layersContainer.addArrangedSubview(applyLayersBtn)
    }

    private func makeFactRow(_ label: String, valueField: NSTextField) -> NSView {
        let lbl = NSTextField.styledLabel(label, font: Theme.smallFont, color: Theme.textSecondary)
        let sp = NSView()
        sp.setContentHuggingPriority(.defaultLow, for: .horizontal)
        valueField.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        valueField.textColor = Theme.textPrimary
        let row = NSStackView(views: [lbl, sp, valueField])
        row.orientation = .horizontal
        row.alignment = .centerY
        return row
    }

    @objc private func tabChanged() {
        model.activeTab = PostDetailModel.PanelTab(rawValue: tabControl.selectedSegment) ?? .details
    }

    @objc private func versionChanged() {
        guard let versionNumber = versionPopup.selectedItem?.representedObject as? Int else { return }
        Task { await model.selectVersion(versionNumber) }
    }

    private func showExportMenu() {
        let menu = NSMenu()
        let jpegItem = NSMenuItem(title: "JPEG Olarak Kaydet…", action: #selector(exportJPEGClicked), keyEquivalent: "")
        jpegItem.target = self
        menu.addItem(jpegItem)

        let pdfItem = NSMenuItem(title: "LinkedIn PDF Carousel Üret / İndir", action: #selector(exportPDFClicked), keyEquivalent: "")
        pdfItem.target = self
        menu.addItem(pdfItem)

        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: exportMenuBtn)
    }

    @objc private func exportJPEGClicked() { model.exportJPEG() }
    @objc private func exportPDFClicked() { model.exportPDFCarousel() }

    private func syncPanel() {
        handleLabel.stringValue = model.handle
        tabControl.selectedSegment = model.activeTab.rawValue
        detailsContainer.isHidden = model.activeTab != .details
        layersContainer.isHidden = model.activeTab != .layers

        stateLabel.state = model.card.state

        // Version popup
        versionPopup.removeAllItems()
        let summaries = model.versionSummaries
        if summaries.isEmpty {
            if let v = model.activeVersion?.version ?? model.content.currentVersion?.version {
                versionPopup.addItem(withTitle: "Sürüm v\(v)")
                versionPopup.isEnabled = false
            } else {
                versionPopup.addItem(withTitle: "Sürüm yok")
                versionPopup.isEnabled = false
            }
        } else {
            versionPopup.isEnabled = summaries.count > 1
            let activeVer = model.activeVersion?.version ?? model.content.currentVersion?.version
            for s in summaries {
                let isCurr = s.version == model.content.currentVersion?.version
                versionPopup.addItem(withTitle: isCurr ? "Sürüm v\(s.version)" : "Sürüm v\(s.version) (Eski)")
                versionPopup.lastItem?.representedObject = s.version
                if s.version == activeVer {
                    versionPopup.select(versionPopup.lastItem)
                }
            }
        }

        exportMenuBtn.showsSpinner = model.isExporting
        exportMenuBtn.isEnabled = !model.isExporting && model.activeVersion != nil

        let editing = model.isEditingCaption
        captionReadStack.isHidden = editing
        captionEditStack.isHidden = !editing
        captionReadStack.toolTip = model.content.status.isLocked ? "Yayındaki postun açıklaması değişmez." : "Düzenlemek için tıkla"

        if editing {
            if !wasEditingCaption {
                captionTextView.string = model.captionDraft
                hashtagsField.stringValue = model.hashtagsDraft
                window?.makeFirstResponder(captionTextView)
            }
            approvalWarnLabel.isHidden = !model.content.status.hasApproval
            saveCaptionButton.showsSpinner = model.isSavingCaption
            saveCaptionButton.isEnabled = !model.isSavingCaption
        } else {
            captionBodyLabel.stringValue = model.captionDraft.isEmpty ? "Açıklama yok" : model.captionDraft
            captionBodyLabel.textColor = model.captionDraft.isEmpty ? Theme.textTertiary : Theme.textPrimary
            hashtagsReadLabel.stringValue = model.hashtagsDraft
            hashtagsReadLabel.isHidden = model.hashtagsDraft.isEmpty
        }
        wasEditingCaption = editing

        dateValueLabel.stringValue = model.dateText
        platformValueLabel.stringValue = TurkishFormat.platforms(model.content.targetPlatforms)
        typeValueLabel.stringValue = model.typeText

        if let expMsg = model.exportStatusMessage {
            exportStatusLabel.stringValue = expMsg
            exportStatusLabel.isHidden = false
        } else {
            exportStatusLabel.isHidden = true
        }

        if let job = model.instructionSent {
            instructionJobRow.isHidden = false
            instructionJobLabel.stringValue = model.app.isOnline
                ? "İstek sırada (\(job.status == .queued ? "bekliyor" : job.status.rawValue))"
                : "İstek Mac'i bekliyor"
        } else {
            instructionJobRow.isHidden = true
        }

        // Layers tab sync
        if model.originalLayers != renderedLayersSnapshot {
            renderedLayersSnapshot = model.originalLayers
            rebuildLayerRows()
        }
        applyLayersBtn.showsSpinner = model.isApplyingLayers
        applyLayersBtn.isEnabled = model.hasPendingLayerEdits && !model.isApplyingLayers

        if let err = model.error {
            errorBanner.message = err
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }

        if instructionField.stringValue != model.instruction {
            instructionField.stringValue = model.instruction
        }
        sendInstructionBtn.showsSpinner = model.isSendingInstruction
        sendInstructionBtn.isEnabled = !model.instruction.trimmingCharacters(in: .whitespaces).isEmpty && !model.isSendingInstruction

        scheduleBtn.isEnabled = !model.schedulableAccounts.isEmpty && model.content.status != .published && model.content.status != .publishing
        scheduleBtn.toolTip = model.schedulableAccounts.isEmpty ? "Bu postun platformlarında bağlı hesap yok." : "Yayın zamanı seç"

        approveBtn.title = model.content.status.hasApproval ? "Onaylandı" : "Onayla"
        approveBtn.showsSpinner = model.isApproving
        approveBtn.isEnabled = model.canApprove
        approveBtn.toolTip = model.approveHelp

        if !model.schedulePresented, let pop = activeSchedulePopover, pop.isShown {
            pop.close()
        }
    }

    private func rebuildLayerRows() {
        layersListStack.arrangedSubviews.forEach {
            layersListStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        if model.editableLayers.isEmpty {
            layersListStack.addArrangedSubview(NSTextField.styledLabel(
                "Bu slaytta düzenlenebilir [data-layer] öğesi bulunamadı.",
                font: Theme.captionFont,
                color: Theme.textTertiary,
                wraps: true
            ))
            return
        }

        for index in model.editableLayers.indices {
            let layer = model.editableLayers[index]
            let row = SlideLayerEditorRowView(
                layer: layer,
                onToggleVisible: { [weak model] visible in
                    guard let model, model.editableLayers.indices.contains(index) else { return }
                    model.editableLayers[index].isHidden = !visible
                },
                onChangeText: { [weak model] newText in
                    guard let model, model.editableLayers.indices.contains(index) else { return }
                    model.editableLayers[index].text = newText
                },
                onPickSlotPhoto: { [weak model] in
                    guard let model else { return }
                    model.importSlotImage(urls: ImageImport.pick(multiple: false), slotId: layer.layerId)
                },
                onGenerateAISlot: { [weak model] in
                    model?.openAISlotGenerator(slotId: layer.layerId)
                }
            )
            layersListStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: layersListStack.widthAnchor).isActive = true
        }
    }

    func textDidChange(_ notification: Notification) {
        model.captionDraft = captionTextView.string
    }

    func controlTextDidChange(_ obj: Notification) {
        guard let tf = obj.object as? NSTextField else { return }
        if tf === hashtagsField {
            model.hashtagsDraft = hashtagsField.stringValue
        } else if tf === instructionField {
            model.instruction = instructionField.stringValue
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if control === instructionField && commandSelector == #selector(NSResponder.insertNewline(_:)) {
            Task { await model.sendInstruction() }
            return true
        }
        return false
    }

    private func toggleSchedulePopover() {
        if let pop = activeSchedulePopover, pop.isShown {
            pop.close()
            model.schedulePresented = false
            return
        }
        model.schedulePresented = true
        let pop = NSPopover()
        pop.behavior = .transient
        pop.contentViewController = SchedulePopoverViewController(model: model) { [weak pop, weak self] in
            pop?.close()
            self?.model.schedulePresented = false
        }
        pop.show(relativeTo: scheduleBtn.bounds, of: scheduleBtn, preferredEdge: .minY)
        activeSchedulePopover = pop
    }
}

// MARK: - SlideLayerEditorRowView

private final class SlideLayerEditorRowView: ThemedView, NSTextFieldDelegate {
    private let onToggleVisible: (Bool) -> Void
    private let onChangeText: (String) -> Void
    private let visibleCheck: NSButton
    private let textField = NSTextField()

    init(
        layer: SlideLayer,
        onToggleVisible: @escaping (Bool) -> Void,
        onChangeText: @escaping (String) -> Void,
        onPickSlotPhoto: @escaping () -> Void,
        onGenerateAISlot: @escaping () -> Void
    ) {
        self.onToggleVisible = onToggleVisible
        self.onChangeText = onChangeText
        self.visibleCheck = NSButton(checkboxWithTitle: "", target: nil, action: nil)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.fill
        borderColor = Theme.hairline
        borderWidth = 1
        cornerRadius = 12

        visibleCheck.state = layer.isHidden ? .off : .on
        visibleCheck.toolTip = "Katman görünürlüğü"
        visibleCheck.target = self
        visibleCheck.action = #selector(visibilityToggled)

        let idLabel = NSTextField.styledLabel(layer.layerId, font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold), color: Theme.textPrimary)
        let kindLabel = NSTextField.styledLabel(layer.kind.label, font: Theme.smallFont, color: Theme.textSecondary)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let header = NSStackView(views: [visibleCheck, idLabel, spacer, kindLabel])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 6

        let vStack = NSStackView(views: [header])
        vStack.orientation = .vertical
        vStack.alignment = .leading
        vStack.spacing = 8
        vStack.translatesAutoresizingMaskIntoConstraints = false
        header.widthAnchor.constraint(equalTo: vStack.widthAnchor).isActive = true

        if layer.kind == .text {
            textField.stringValue = layer.text
            textField.bezelStyle = .roundedBezel
            textField.font = NSFont.systemFont(ofSize: 12)
            textField.delegate = self
            vStack.addArrangedSubview(textField)
            textField.widthAnchor.constraint(equalTo: vStack.widthAnchor).isActive = true
        } else if layer.kind == .slot {
            let stateStr = layer.slotState == .filled ? "Dolu" : "Boş"
            let sub = NSTextField.styledLabel("\(layer.slotLabel ?? "Görsel yuvası") · \(stateStr)", font: Theme.smallFont, color: Theme.textSecondary)
            vStack.addArrangedSubview(sub)
            let pickBtn = PillButton(title: "Dosya Seç…", kind: .secondary, height: 22, action: onPickSlotPhoto)
            let aiBtn = PillButton(title: "AI ile Doldur…", kind: .outline, height: 22, action: onGenerateAISlot)
            let row = NSStackView(views: [pickBtn, aiBtn])
            row.orientation = .horizontal
            row.spacing = 6
            vStack.addArrangedSubview(row)
        } else if let src = layer.src {
            vStack.addArrangedSubview(NSTextField.styledLabel(src, font: Theme.smallFont, color: Theme.textTertiary))
        }

        addSubview(vStack)
        NSLayoutConstraint.activate([
            vStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            vStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            vStack.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            vStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func visibilityToggled() {
        onToggleVisible(visibleCheck.state == .on)
    }

    func controlTextDidChange(_ obj: Notification) {
        onChangeText(textField.stringValue)
    }
}

private final class ClickableCaptionReadView: NSControl {
    var onClick: (() -> Void)?

    func setup(body: NSTextField, hashtags: NSTextField) {
        translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView(views: [body, hashtags])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        body.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        hashtags.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
}

// MARK: - SchedulePopoverViewController

private final class SchedulePopoverViewController: NSViewController {
    private let model: PostDetailModel
    private let onDismiss: () -> Void
    private let datePicker = NSDatePicker()
    private var confirmBtn: PillButton!
    private var observation: ObservationToken?

    init(model: PostDetailModel, onDismiss: @escaping () -> Void) {
        self.model = model
        self.onDismiss = onDismiss
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField.styledLabel("Zamanla", font: NSFont.systemFont(ofSize: 13, weight: .semibold), color: Theme.textPrimary)

        datePicker.datePickerStyle = .textFieldAndStepper
        datePicker.datePickerElements = [.yearMonthDay, .hourMinute]
        datePicker.locale = TurkishFormat.locale
        datePicker.minDate = Date()
        datePicker.dateValue = model.scheduleDate
        datePicker.target = self
        datePicker.action = #selector(dateChanged)

        let dateRow = NSStackView(views: [
            NSTextField.styledLabel("Yayın zamanı", font: Theme.captionFont, color: Theme.textSecondary),
            NSView(),
            datePicker,
        ])
        dateRow.orientation = .horizontal
        dateRow.alignment = .centerY

        let accountsStack = NSStackView()
        accountsStack.orientation = .vertical
        accountsStack.alignment = .leading
        accountsStack.spacing = 6
        for account in model.schedulableAccounts {
            let check = NSButton(checkboxWithTitle: "\(account.platform.displayName) · \(account.handle)", target: self, action: #selector(toggleAccount(_:)))
            check.identifier = NSUserInterfaceItemIdentifier(account.id)
            check.state = model.scheduleAccounts.contains(account.id) ? .on : .off
            accountsStack.addArrangedSubview(check)
        }

        let stack = NSStackView(views: [title, dateRow, accountsStack])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        dateRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        if !model.content.status.isSchedulable {
            let approveNote = NSTextField.styledLabel("Önce bu sürüm onaylanacak, sonra zamanlanacak.", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
            stack.addArrangedSubview(approveNote)
            approveNote.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        let publishNote = NSTextField.styledLabel(
            "Seçili hesaplarda yayın zamanı geldiğinde otomatik paylaşılır ve Takvim ekranından takip edilir.",
            font: Theme.smallFont,
            color: Theme.textSecondary,
            wraps: true
        )
        stack.addArrangedSubview(publishNote)
        publishNote.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let cancelBtn = PillButton(title: "Vazgeç", kind: .secondary, action: onDismiss)
        confirmBtn = PillButton(
            title: model.content.status.isSchedulable ? "Zamanla" : "Onayla ve zamanla",
            kind: .primary
        ) { [weak model] in
            guard let model else { return }
            Task { await model.schedule() }
        }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let actions = NSStackView(views: [spacer, cancelBtn, confirmBtn])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8
        stack.addArrangedSubview(actions)
        actions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        root.addSubview(stack)
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 320),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])
        self.view = root

        observation = observe { [weak self] in
            guard let self else { return }
            self.confirmBtn.showsSpinner = self.model.isScheduling
            self.confirmBtn.isEnabled = !self.model.scheduleAccounts.isEmpty
                && !self.model.isScheduling
                && (self.model.content.status.isSchedulable || self.model.card.approvableHash != nil)
        }
    }

    @objc private func dateChanged() {
        model.scheduleDate = datePicker.dateValue
    }

    @objc private func toggleAccount(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if sender.state == .on {
            model.scheduleAccounts.insert(id)
        } else {
            model.scheduleAccounts.remove(id)
        }
    }
}
