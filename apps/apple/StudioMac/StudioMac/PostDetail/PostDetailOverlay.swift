import AppKit
import AVFoundation
import AVKit
import Quartz
import StudioKit
import UniformTypeIdentifiers

/// Card geometry for a container size: the post is 4:5 on the left, details on the right.
struct DetailLayout {
    var card: CGRect
    var post: CGRect

    init(container: CGSize) {
        let height = min(max(container.height * 0.78, 460), 760, container.height - 48)
        let postWidth = height * 0.8
        let infoWidth: CGFloat = min(400, max(330, container.width * 0.27))
        let width = min(postWidth + infoWidth, container.width - 48)
        let origin = CGPoint(x: (container.width - width) / 2, y: (container.height - height) / 2)
        card = CGRect(origin: origin, size: CGSize(width: width, height: height))
        post = CGRect(origin: origin, size: CGSize(width: min(postWidth, width - 300), height: height))
    }
}

/// Pure AppKit opened post (06): dimmed glass backdrop, the rendered slide with the layer
/// editor on the left, details / editor inspector / versions on the right.
///
/// Opens with a zoom from the grid card and closes back into it. Keys: esc deselects or
/// closes, ←/→ change slides (or nudge the selected layer), ⌫ hides the selected layer or
/// deletes the post (with confirmation), ⌘Z / ⇧⌘Z undo and redo edits, ⌘E exports,
/// ⌘D duplicates, ⌘↩ approves, space shows Quick Look.
final class PostDetailOverlayView: NSView, NSUserInterfaceValidations {
    let model: PostDetailModel

    private let backdrop = GlassContainerView(cornerRadius: 0, tint: NSColor.black.withAlphaComponent(0.22))
    private let cardShell = ThemedView()
    private let stage = ThemedView()
    private let canvas: SlideCanvasView
    private var panel: DetailPanelView!
    private let pager = ThemedView()
    private let pagerLabel = NSTextField(labelWithString: "")
    private var previousSlide: GlyphButton!
    private var nextSlide: GlyphButton!
    private let activityPill = ActivityPillView()
    private let oldVersionBar = ThemedView()
    private let oldVersionLabel = NSTextField(labelWithString: "")
    private var restoreButton: PillButton!
    private var videoToggle: PillButton!
    private var playerView: AVPlayerView?
    private var videoKey: String?
    private var loopObserver: NSObjectProtocol?
    /// Reels: play button over the cover, and "0:12 · Hareketli grafik".
    private let playBadge = ThemedView()
    private var playButton: GlyphButton!
    private let reelChip = ThemedView()
    private let reelChipLabel = NSTextField(labelWithString: "")
    private var observation: ObservationToken?
    private var didAnimateIn = false
    private var isClosing = false

    init(model: PostDetailModel) {
        self.model = model
        self.canvas = SlideCanvasView(model: model)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        build()
        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        addSubview(backdrop)
        NSLayoutConstraint.activate([
            backdrop.leadingAnchor.constraint(equalTo: leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: trailingAnchor),
            backdrop.topAnchor.constraint(equalTo: topAnchor),
            backdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        cardShell.backgroundColor = Theme.canvas
        cardShell.cornerRadius = Theme.panelRadius
        cardShell.layer?.masksToBounds = true
        cardShell.shadow = nil
        addSubview(cardShell)

        stage.backgroundColor = Theme.postDark
        cardShell.addSubview(stage)
        canvas.frame = stage.bounds
        canvas.autoresizingMask = [.width, .height]
        stage.addSubview(canvas)

        // Pager ‹ 1 / 3 ›
        pager.backgroundColor = NSColor.black.withAlphaComponent(0.6)
        pager.cornerRadius = 14
        pager.translatesAutoresizingMaskIntoConstraints = false
        previousSlide = GlyphButton(symbol: "chevron.left", size: 10, weight: .bold, diameter: 22) { [weak self] in
            guard let self else { return }
            self.model.selectSlide(self.model.selectedSlideIndex - 1)
        }
        previousSlide.toolTip = "Önceki slayt (←)"
        previousSlide.appearance = NSAppearance(named: .darkAqua)
        nextSlide = GlyphButton(symbol: "chevron.right", size: 10, weight: .bold, diameter: 22) { [weak self] in
            guard let self else { return }
            self.model.selectSlide(self.model.selectedSlideIndex + 1)
        }
        nextSlide.toolTip = "Sonraki slayt (→)"
        nextSlide.appearance = NSAppearance(named: .darkAqua)
        pagerLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        pagerLabel.textColor = .white
        let pagerRow = NSStackView(views: [previousSlide, pagerLabel, nextSlide])
        pagerRow.orientation = .horizontal
        pagerRow.alignment = .centerY
        pagerRow.spacing = 6
        pagerRow.translatesAutoresizingMaskIntoConstraints = false
        pager.addSubview(pagerRow)
        stage.addSubview(pager)

        activityPill.translatesAutoresizingMaskIntoConstraints = false
        activityPill.onCancel = { [weak self] in
            guard let self else { return }
            Task { await self.model.cancelRevision() }
        }
        stage.addSubview(activityPill)

        // Viewing an older version: "v2 görüntüleniyor · Güncele dön · Geri yükle"
        oldVersionBar.backgroundColor = NSColor.black.withAlphaComponent(0.66)
        oldVersionBar.cornerRadius = 16
        oldVersionBar.translatesAutoresizingMaskIntoConstraints = false
        oldVersionLabel.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        oldVersionLabel.textColor = .white
        let backToCurrent = PillButton(title: "Güncele dön", kind: .secondary, height: 24) { [weak self] in
            guard let self, let current = self.model.content.currentVersion?.version else { return }
            Task { await self.model.selectVersion(current) }
        }
        backToCurrent.appearance = NSAppearance(named: .darkAqua)
        restoreButton = PillButton(title: "Geri yükle", kind: .ink, height: 24) { [weak self] in
            guard let self else { return }
            Task { await self.model.restoreDisplayedVersion() }
        }
        restoreButton.appearance = NSAppearance(named: .darkAqua)
        let oldRow = NSStackView(views: [oldVersionLabel, backToCurrent, restoreButton])
        oldRow.orientation = .horizontal
        oldRow.alignment = .centerY
        oldRow.spacing = 8
        oldRow.translatesAutoresizingMaskIntoConstraints = false
        oldVersionBar.addSubview(oldRow)
        stage.addSubview(oldVersionBar)

        videoToggle = PillButton(title: "Kapak", kind: .secondary, height: 26) { [weak self] in
            self?.model.showReelVideo.toggle()
        }
        videoToggle.appearance = NSAppearance(named: .darkAqua)
        videoToggle.isHidden = true
        videoToggle.translatesAutoresizingMaskIntoConstraints = false
        stage.addSubview(videoToggle)

        playBadge.backgroundColor = NSColor.black.withAlphaComponent(0.55)
        playBadge.cornerRadius = 32
        playBadge.translatesAutoresizingMaskIntoConstraints = false
        playButton = GlyphButton(symbol: "play.fill", size: 22, weight: .bold, diameter: 64) { [weak self] in
            self?.model.showReelVideo = true
        }
        playButton.appearance = NSAppearance(named: .darkAqua)
        playButton.toolTip = "Videoyu oynat"
        playButton.setAccessibilityLabel("Videoyu oynat")
        playBadge.addSubview(playButton)
        playBadge.isHidden = true
        stage.addSubview(playBadge)

        reelChip.backgroundColor = NSColor.black.withAlphaComponent(0.6)
        reelChip.cornerRadius = 11
        reelChip.translatesAutoresizingMaskIntoConstraints = false
        reelChipLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        reelChipLabel.textColor = .white
        reelChipLabel.translatesAutoresizingMaskIntoConstraints = false
        reelChip.addSubview(reelChipLabel)
        reelChip.isHidden = true
        stage.addSubview(reelChip)

        NSLayoutConstraint.activate([
            pager.heightAnchor.constraint(equalToConstant: 28),
            pagerRow.leadingAnchor.constraint(equalTo: pager.leadingAnchor, constant: 6),
            pagerRow.trailingAnchor.constraint(equalTo: pager.trailingAnchor, constant: -6),
            pagerRow.centerYAnchor.constraint(equalTo: pager.centerYAnchor),
            pager.centerXAnchor.constraint(equalTo: stage.centerXAnchor),
            pager.bottomAnchor.constraint(equalTo: stage.bottomAnchor, constant: -14),

            activityPill.centerXAnchor.constraint(equalTo: stage.centerXAnchor),
            activityPill.topAnchor.constraint(equalTo: stage.topAnchor, constant: 14),

            oldVersionBar.heightAnchor.constraint(equalToConstant: 32),
            oldRow.leadingAnchor.constraint(equalTo: oldVersionBar.leadingAnchor, constant: 12),
            oldRow.trailingAnchor.constraint(equalTo: oldVersionBar.trailingAnchor, constant: -4),
            oldRow.centerYAnchor.constraint(equalTo: oldVersionBar.centerYAnchor),
            oldVersionBar.centerXAnchor.constraint(equalTo: stage.centerXAnchor),
            oldVersionBar.bottomAnchor.constraint(equalTo: stage.bottomAnchor, constant: -50),

            videoToggle.topAnchor.constraint(equalTo: stage.topAnchor, constant: 14),
            videoToggle.trailingAnchor.constraint(equalTo: stage.trailingAnchor, constant: -14),

            playBadge.widthAnchor.constraint(equalToConstant: 64),
            playBadge.heightAnchor.constraint(equalToConstant: 64),
            playBadge.centerXAnchor.constraint(equalTo: stage.centerXAnchor),
            playBadge.centerYAnchor.constraint(equalTo: stage.centerYAnchor),
            playButton.centerXAnchor.constraint(equalTo: playBadge.centerXAnchor),
            playButton.centerYAnchor.constraint(equalTo: playBadge.centerYAnchor),

            reelChip.heightAnchor.constraint(equalToConstant: 22),
            reelChip.leadingAnchor.constraint(equalTo: stage.leadingAnchor, constant: 14),
            reelChip.bottomAnchor.constraint(equalTo: stage.bottomAnchor, constant: -14),
            reelChipLabel.leadingAnchor.constraint(equalTo: reelChip.leadingAnchor, constant: 9),
            reelChipLabel.trailingAnchor.constraint(equalTo: reelChip.trailingAnchor, constant: -9),
            reelChipLabel.centerYAnchor.constraint(equalTo: reelChip.centerYAnchor),
        ])

        panel = DetailPanelView(model: model, actions: .init(
            close: { [weak self] in self?.closeOverlay() },
            export: { [weak self] anchor in self?.presentExportMenu(from: anchor) },
            share: { [weak self] anchor in self?.share(from: anchor) },
            delete: { [weak self] in self?.confirmDelete() },
            duplicate: { [weak self] in
                guard let self else { return }
                Task { await self.model.duplicate() }
            },
            pickImage: { [weak self] id in self?.canvas.pickImage(for: id) },
            editTextInline: { [weak self] id in self?.canvas.beginInlineEdit(id) }
        ))
        cardShell.addSubview(panel)
        // Provisional sizes so nothing is solved at zero size before the first real layout.
        cardShell.frame = CGRect(x: 0, y: 0, width: 872, height: 640)
        stage.frame = CGRect(x: 0, y: 0, width: 512, height: 640)
        panel.frame = CGRect(x: 512, y: 0, width: 360, height: 640)
    }

    // MARK: Layout & zoom

    override func layout() {
        super.layout()
        guard bounds.width > 100, bounds.height > 100 else { return }
        if !isClosing { applyLayout() }
        if !didAnimateIn, window != nil {
            didAnimateIn = true
            animateIn()
        }
    }

    private func applyLayout() {
        let layout = DetailLayout(container: bounds.size)
        cardShell.frame = layout.card
        stage.frame = CGRect(x: 0, y: 0, width: layout.post.width, height: layout.post.height)
        playerView?.frame = stage.bounds
        panel.frame = CGRect(x: layout.post.width, y: 0, width: layout.card.width - layout.post.width, height: layout.card.height)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil else { return }
            self.window?.makeFirstResponder(self.canvas)
        }
    }

    /// The grid card's image flies into the post area while the backdrop and panel fade in.
    private func animateIn() {
        let target = DetailLayout(container: bounds.size)
        let source = model.sourceFrame.width > 10 ? convert(model.sourceFrame, from: nil) : .zero
        guard source != .zero, let snapshot = snapshotImage() else {
            alphaValue = 0
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                animator().alphaValue = 1
            }
            return
        }
        let postRect = CGRect(x: target.card.minX, y: target.card.minY, width: target.post.width, height: target.post.height)
        let zoom = ZoomImageView(image: snapshot, cornerRadius: Theme.cardRadius)
        zoom.frame = source
        addSubview(zoom)
        cardShell.alphaValue = 0
        backdrop.alphaValue = 0
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.32
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
            ctx.allowsImplicitAnimation = true
            zoom.animator().frame = postRect
            backdrop.animator().alphaValue = 1
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = 0.14
                    self.cardShell.animator().alphaValue = 1
                }, completionHandler: {
                    Task { @MainActor in zoom.removeFromSuperview() }
                })
            }
        })
    }

    private func closeOverlay() {
        guard !isClosing else { return }
        isClosing = true
        playerView?.player?.pause()
        if let loopObserver { NotificationCenter.default.removeObserver(loopObserver) }
        loopObserver = nil
        model.schedulePresented = false
        PostQuickLook.shared.closeIfShowing()
        let target = DetailLayout(container: bounds.size)
        let postRect = CGRect(x: target.card.minX, y: target.card.minY, width: target.post.width, height: target.post.height)
        let destination = model.app.posts.card(model.content.id) != nil && model.sourceFrame.width > 10 ? convert(model.sourceFrame, from: nil) : .zero
        let finish: @MainActor () -> Void = { [weak self] in
            guard let self, self.model.app.detail === self.model else { return }
            self.model.app.detail = nil
        }
        guard destination != .zero, let snapshot = snapshotImage() else {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.16
                animator().alphaValue = 0
            }, completionHandler: { Task { @MainActor in finish() } })
            return
        }
        let zoom = ZoomImageView(image: snapshot, cornerRadius: Theme.cardRadius)
        zoom.frame = postRect
        addSubview(zoom)
        cardShell.alphaValue = 0
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.28
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.0, 0.2, 1)
            ctx.allowsImplicitAnimation = true
            zoom.animator().frame = destination
            backdrop.animator().alphaValue = 0
        }, completionHandler: { Task { @MainActor in finish() } })
    }

    /// The current slide's rendered image (else a snapshot of the stage).
    private func snapshotImage() -> NSImage? {
        if let id = model.currentSlide?.renderedAssetId ?? model.card.renderedAssetIds.first, let image = model.app.images.image(id) {
            return image
        }
        applyLayout()
        stage.layoutSubtreeIfNeeded()
        guard stage.bounds.width > 0, let rep = stage.bitmapImageRepForCachingDisplay(in: stage.bounds) else { return nil }
        stage.cacheDisplay(in: stage.bounds, to: rep)
        let image = NSImage(size: stage.bounds.size)
        image.addRepresentation(rep)
        return image
    }

    // MARK: State

    private func sync() {
        let count = model.slides.count
        pager.isHidden = count <= 1 || showsVideo
        pagerLabel.stringValue = "\(model.selectedSlideIndex + 1) / \(max(1, count))"
        previousSlide.isEnabled = model.selectedSlideIndex > 0
        nextSlide.isEnabled = model.selectedSlideIndex < count - 1

        let busy = model.activity
        activityPill.isHidden = !busy.isBusy || showsVideo
        if busy.isBusy {
            let cancellable: Bool = switch busy {
            case .revising: model.revisionJobId != nil
            case .rendering: model.reelRenderJobId != nil
            default: false
            }
            activityPill.show(busy.message, cancellable: cancellable)
        }

        oldVersionBar.isHidden = model.isViewingCurrentVersion || showsVideo
        if let shown = model.activeVersion?.version { oldVersionLabel.stringValue = "v\(shown) görüntüleniyor" }
        restoreButton.isEnabled = !busy.changesVersion && !model.content.status.isLocked
        restoreButton.showsSpinner = busy == .restoring

        model.ensureReelState()
        let reel = model.isReel ? model.reelInfo : nil
        videoToggle.isHidden = !showsVideo
        videoToggle.title = "Kapak"
        videoToggle.toolTip = "Videoyu durdur, kapağı göster"
        let canPlay = reel?.hasVideo == true && !busy.changesVersion
        playBadge.isHidden = !model.isReel || showsVideo || !canPlay
        playButton.isEnabled = model.videoPreviewURL != nil
        playButton.showsSpinner = model.isLoadingVideo
        playButton.toolTip = model.videoError ?? (model.videoPreviewURL == nil ? "Video indiriliyor…" : "Videoyu oynat")
        if let reel, let ms = reel.durationMs, !showsVideo {
            reelChip.isHidden = false
            reelChipLabel.stringValue = [TurkishFormat.clock(ms: ms), reel.recipe?.label].compactMap { $0 }.joined(separator: " · ")
        } else {
            reelChip.isHidden = true
        }
        if model.showReelVideo, !canPlay { model.showReelVideo = false }
        syncVideo()
    }

    private var showsVideo: Bool { model.showReelVideo && model.hasVideoCapability && model.videoPreviewURL != nil }

    private func syncVideo() {
        let key = showsVideo ? model.videoPreviewURL?.absoluteString : nil
        guard key != videoKey else { return }
        videoKey = key
        playerView?.player?.pause()
        playerView?.removeFromSuperview()
        playerView = nil
        if let loopObserver { NotificationCenter.default.removeObserver(loopObserver) }
        loopObserver = nil
        canvas.isHidden = key != nil
        guard key != nil, let url = model.videoPreviewURL else { return }
        let pv = AVPlayerView()
        pv.controlsStyle = .floating
        pv.videoGravity = .resizeAspect
        pv.showsFullScreenToggleButton = true
        let player = AVPlayer(url: url)
        // Reels loop.
        player.actionAtItemEnd = .none
        loopObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem, queue: .main
        ) { [weak player] _ in
            player?.seek(to: .zero)
            player?.play()
        }
        pv.player = player
        pv.frame = stage.bounds
        pv.autoresizingMask = [.width, .height]
        stage.addSubview(pv, positioned: .below, relativeTo: videoToggle)
        playerView = pv
        player.play()
    }

    // MARK: Actions

    private func presentExportMenu(from anchor: NSView) {
        if model.isReel {
            presentReelExportMenu(from: anchor)
            return
        }
        let reason: String? = model.activeVersion == nil ? "Dışa aktarılacak bir sürüm yok." : (model.isExporting ? "Dışa aktarma sürüyor." : nil)
        let menu = PostFileExport.menu(
            target: self, action: #selector(exportChosen(_:)), slideCount: model.slides.count,
            currentSlide: model.slides.count > 1 ? model.selectedSlideIndex : nil, disabledReason: reason)
        menu.addItem(.separator())
        let share = ClosureMenuItem(title: "Paylaş…") { [weak self] in self?.share(from: anchor) }
        share.isEnabled = reason == nil
        menu.addItem(share)
        menu.addItem(ClosureMenuItem(title: "Açıklamayı kopyala") { [weak self] in self?.model.copyCaption() })
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: anchor.bounds.height + 4), in: anchor)
    }

    /// Reels: the MP4, the cover, share, copy caption.
    private func presentReelExportMenu(from anchor: NSView) {
        let info = model.reelInfo
        let reason: String? = info?.hasVideo != true ? "Bu sürümde video yok." : (model.isExporting ? "Dışa aktarma sürüyor." : nil)
        let menu = NSMenu()
        menu.autoenablesItems = false
        let video = ClosureMenuItem(title: "MP4 video") { [weak self] in self?.saveReel(cover: false) }
        video.isEnabled = reason == nil
        video.toolTip = reason
        menu.addItem(video)
        let cover = ClosureMenuItem(title: "Kapak görseli (JPEG)") { [weak self] in self?.saveReel(cover: true) }
        cover.isEnabled = info?.coverAssetId != nil && !model.isExporting
        menu.addItem(cover)
        menu.addItem(.separator())
        let share = ClosureMenuItem(title: "Paylaş…") { [weak self] in self?.share(from: anchor) }
        share.isEnabled = reason == nil
        menu.addItem(share)
        menu.addItem(ClosureMenuItem(title: "Açıklamayı kopyala") { [weak self] in self?.model.copyCaption() })
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: anchor.bounds.height + 4), in: anchor)
    }

    private func saveReel(cover: Bool) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = model.suggestedReelFilename(cover: cover)
        panel.allowedContentTypes = cover ? [.jpeg] : [.mpeg4Movie]
        panel.canCreateDirectories = true
        let run: (URL) -> Void = { [weak self] url in
            guard let self else { return }
            Task { await self.model.exportReel(cover: cover, to: url) }
        }
        if let window {
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { return }
                MainActor.assumeIsolated { run(url) }
            }
        } else if panel.runModal() == .OK, let url = panel.url {
            run(url)
        }
    }

    @objc private func exportChosen(_ sender: NSMenuItem) {
        guard let choice = sender.representedObject as? ExportChoice else { return }
        let count = PostFileExport.fileCount(choice, slideCount: model.slides.count)
        let name = model.suggestedFilename(choice.format, slide: choice.format == .pdf ? nil : choice.slides?.first)
        Task {
            guard let destination = await PostFileExport.chooseDestination(fileCount: count, suggestedName: name, format: choice.format, window: window) else { return }
            if count == 1 {
                await model.export(choice.format, slides: choice.slides, toFile: destination)
            } else {
                await model.export(choice.format, slides: choice.slides, to: destination)
            }
        }
    }

    private func share(from anchor: NSView) {
        Task {
            let urls = await model.shareableFiles()
            guard !urls.isEmpty else { return }
            var items: [Any] = urls
            if !model.content.caption.isEmpty { items.append(model.content.caption) }
            let picker = NSSharingServicePicker(items: items)
            picker.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        }
    }

    private func confirmDelete() {
        if let blocker = model.deletionBlocker {
            model.error = blocker
            NSSound.beep()
            return
        }
        Task {
            if await PostDeletion.confirm(title: model.content.title, window: window) {
                await model.delete()
            }
        }
    }

    // MARK: Keys, undo / redo (responder chain)

    override var acceptsFirstResponder: Bool { true }

    private var isTyping: Bool { window?.firstResponder is NSText }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), !flags.contains(.option), !flags.contains(.control) else {
            return super.performKeyEquivalent(with: event)
        }
        let chars = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if event.keyCode == 36 || event.keyCode == 76 {
            // ⌘↩ inside a text view belongs to it (the inspector applies text with it).
            guard !isTyping else { return super.performKeyEquivalent(with: event) }
            if model.canApprove { Task { await model.approve() } } else { NSSound.beep() }
            return true
        }
        guard flags == .command else { return super.performKeyEquivalent(with: event) }
        switch chars {
        case "e":
            presentExportMenu(from: panelExportAnchor)
            return true
        case "d":
            Task { await model.duplicate() }
            return true
        case "w":
            closeOverlay()
            return true
        default:
            return super.performKeyEquivalent(with: event)
        }
    }

    private var panelExportAnchor: NSView { panel }

    override func keyDown(with event: NSEvent) {
        if handleKey(event) { return }
        super.keyDown(with: event)
    }

    /// Keys for the opened post (the canvas forwards what it does not use).
    func handleKey(_ event: NSEvent) -> Bool {
        guard !isTyping else { return false }
        switch event.keyCode {
        case 53: // esc
            if model.selectedLayerId != nil { model.select(layer: nil) } else { closeOverlay() }
            return true
        case 51, 117: // ⌫ ⌦
            if let id = model.selectedLayerId, model.canEdit {
                model.setHidden(id, true)
            } else {
                confirmDelete()
            }
            return true
        case 49: // space
            PostQuickLook.shared.toggle(assetIds: model.slides.compactMap(\.renderedAssetId), service: model.app.dataService)
            return true
        case 123:
            model.selectSlide(model.selectedSlideIndex - 1)
            return true
        case 124:
            model.selectSlide(model.selectedSlideIndex + 1)
            return true
        default:
            return false
        }
    }

    override func cancelOperation(_ sender: Any?) {
        if model.selectedLayerId != nil { model.select(layer: nil) } else { closeOverlay() }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if !cardShell.frame.contains(point) { closeOverlay() }
    }

    /// Text views keep their own typing undo (the window's manager); everything else
    /// undoes and redoes post versions.
    private var textUndoManager: UndoManager? {
        guard isTyping else { return nil }
        return window?.firstResponder?.undoManager ?? window?.undoManager
    }

    @objc func undo(_ sender: Any?) {
        if let text = textUndoManager {
            if text.canUndo { text.undo() } else { NSSound.beep() }
            return
        }
        model.undo()
    }

    @objc func redo(_ sender: Any?) {
        if let text = textUndoManager {
            if text.canRedo { text.redo() } else { NSSound.beep() }
            return
        }
        model.redo()
    }

    func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        let manager = textUndoManager ?? model.undoManager
        let typing = textUndoManager != nil
        switch item.action {
        case #selector(undo(_:)):
            (item as? NSMenuItem)?.title = manager.canUndo ? manager.undoMenuItemTitle : "Geri Al"
            return typing ? manager.canUndo : model.canUndo
        case #selector(redo(_:)):
            (item as? NSMenuItem)?.title = manager.canRedo ? manager.redoMenuItemTitle : "Yinele"
            return typing ? manager.canRedo : model.canRedo
        default:
            return true
        }
    }

    // Quick Look (space) while the post is open.
    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        MainActor.assumeIsolated {
            panel.dataSource = PostQuickLook.shared
            panel.delegate = PostQuickLook.shared
        }
    }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {}
}

// MARK: - Pieces

/// "Render ediliyor…" capsule on the stage.
private final class ActivityPillView: ThemedView {
    var onCancel: (() -> Void)?
    private let spinner = NSProgressIndicator()
    private let label = NSTextField(labelWithString: "")
    private var cancelButton: PillButton!

    init() {
        super.init(frame: .zero)
        backgroundColor = NSColor.black.withAlphaComponent(0.66)
        cornerRadius = 15
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.appearance = NSAppearance(named: .darkAqua)
        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.textColor = .white
        label.lineBreakMode = .byTruncatingTail
        cancelButton = PillButton(title: "İptal", kind: .secondary, height: 22) { [weak self] in self?.onCancel?() }
        cancelButton.appearance = NSAppearance(named: .darkAqua)
        let row = NSStackView(views: [spinner, label, cancelButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.detachesHiddenViews = true
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 30),
            widthAnchor.constraint(lessThanOrEqualToConstant: 360),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityRole(.progressIndicator)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ message: String, cancellable: Bool) {
        label.stringValue = message
        setAccessibilityLabel(message)
        cancelButton.isHidden = !cancellable
        spinner.startAnimation(nil)
    }
}

/// A layer-backed image that scales with its frame (the zoom transition).
private final class ZoomImageView: NSView {
    init(image: NSImage, cornerRadius: CGFloat) {
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
        layer?.contents = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        layer?.contentsGravity = .resizeAspectFill
        layer?.cornerRadius = cornerRadius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {}
}

extension PostQuickLook {
    func closeIfShowing() {
        if let panel = QLPreviewPanel.sharedPreviewPanelExists() ? QLPreviewPanel.shared() : nil, panel.isVisible {
            panel.orderOut(nil)
        }
    }
}
