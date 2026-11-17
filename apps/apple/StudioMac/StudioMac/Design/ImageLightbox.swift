import AppKit
import QuartzCore
import StudioKit

/// Window-wide image viewer (Claude Code's lightbox).
///
/// The window dims (~85 % black), the image springs from its thumbnail's frame to fit the
/// centre (rounded 12, soft shadow) and back on close. ✕ at the window's top-right; a bottom
/// bar with the caption on the left, `‹ 9 / 12 ›` in the centre and copy / share / save on the
/// right. ←/→ move between images, Esc / Space / ✕ / a click outside the image close it,
/// double-click or pinch zooms, drag (or two-finger scroll) pans while zoomed.
///
/// Usage (chat thumbnails, post previews; the Media panel can call it the same way):
///
///     ImageLightbox.present(
///         items: assets.map { ImageLightbox.Item(assetId: $0.id, caption: "@\($0.alias)") },
///         startIndex: 2,
///         from: clickedThumbnailView,          // zooms from / back to this view (optional)
///         in: view.window,
///         imageStore: app.images,              // loads `assetId` items (decoded off the main thread)
///         sourceView: { index in tiles[safe: index] } // thumbnail of another index, for closing after ←/→
///     )
///
/// Items can also carry a ready `NSImage` or a file / https `URL`. Only one lightbox is open at
/// a time (`ImageLightbox.current`); presenting another closes the first.
@MainActor
final class ImageLightbox {
    struct Item: Equatable {
        var image: NSImage?
        var assetId: EntityID?
        var url: URL?
        var caption: String?

        init(image: NSImage? = nil, assetId: EntityID? = nil, url: URL? = nil, caption: String? = nil) {
            self.image = image
            self.assetId = assetId
            self.url = url
            self.caption = caption
        }
    }

    /// The open lightbox, if any.
    private(set) static var current: ImageLightbox?

    let items: [Item]
    private(set) var navigator: LightboxNavigator
    let overlay: LightboxOverlayView
    private weak var window: NSWindow?
    private weak var imageStore: ImageStore?
    private let sourceViewProvider: ((Int) -> NSView?)?
    private weak var initialSource: NSView?
    private weak var hiddenSource: NSView?
    private weak var previousResponder: NSResponder?
    private var observation: ObservationToken?
    private var urlTask: Task<Void, Never>?
    private var loadedImages: [Int: NSImage] = [:]
    private(set) var isClosing = false
    /// Inside `showCurrent`: a cached image found while binding is shown by it, not twice.
    private var isShowing = false

    var index: Int { navigator.index }
    /// The image shown now, once loaded.
    var currentImage: NSImage? { loadedImages[navigator.index] ?? items[navigator.index].image }

    /// Presents the lightbox over `window` (see the type's comment). Returns nil when there is
    /// nothing to show or no window.
    @discardableResult
    static func present(
        items: [Item],
        startIndex: Int,
        from source: NSView?,
        in window: NSWindow?,
        imageStore: ImageStore? = nil,
        sourceView: ((Int) -> NSView?)? = nil,
        animated: Bool = true
    ) -> ImageLightbox? {
        guard !items.isEmpty, let window = window ?? source?.window, let content = window.contentView else { return nil }
        current?.close(animated: false)
        let lightbox = ImageLightbox(items: items, startIndex: startIndex, window: window, imageStore: imageStore, source: source, sourceView: sourceView)
        current = lightbox
        lightbox.install(in: content, animated: animated)
        return lightbox
    }

    private init(items: [Item], startIndex: Int, window: NSWindow, imageStore: ImageStore?, source: NSView?, sourceView: ((Int) -> NSView?)?) {
        self.items = items
        self.navigator = LightboxNavigator(count: items.count, start: startIndex)
        self.window = window
        self.imageStore = imageStore
        self.initialSource = source
        self.sourceViewProvider = sourceView
        self.overlay = LightboxOverlayView()
        overlay.lightbox = self
    }

    private func install(in content: NSView, animated: Bool) {
        overlay.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(overlay, positioned: .above, relativeTo: nil)
        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: content.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        content.layoutSubtreeIfNeeded()
        previousResponder = window?.firstResponder
        window?.makeFirstResponder(overlay)
        showCurrent(transition: animated ? .open(sourceFrame: sourceFrame(for: navigator.index)) : .none)
        overlay.animateDim(in: true, animated: animated)
        NSAccessibility.post(element: overlay, notification: .layoutChanged)
    }

    // MARK: Navigation

    func next() { move { $0.next() } }
    func previous() { move { $0.previous() } }

    func show(index: Int) {
        move { navigator in navigator.go(to: index) }
    }

    private func move(_ change: (inout LightboxNavigator) -> Bool) {
        guard !isClosing else { return }
        var nav = navigator
        guard change(&nav) else { return }
        navigator = nav
        showCurrent(transition: .crossfade)
    }

    private enum Transition {
        case none
        case open(sourceFrame: NSRect?)
        case crossfade
    }

    private func showCurrent(transition: Transition) {
        let index = navigator.index
        let item = items[index]
        overlay.resetZoom()
        overlay.update(caption: item.caption, navigator: navigator)
        updateHiddenSource()
        isShowing = true
        load(index)
        isShowing = false
        overlay.setImage(currentImage, transition: {
            switch transition {
            case .none: return .none
            case .crossfade: return .crossfade
            case .open(let frame): return .zoom(from: frame)
            }
        }())
    }

    private func load(_ index: Int) {
        observation?.cancel()
        observation = nil
        urlTask?.cancel()
        urlTask = nil
        let item = items[index]
        guard item.image == nil, loadedImages[index] == nil else { return }
        if let assetId = item.assetId, let store = imageStore {
            store.load(assetId)
            observation = observe { [weak self, weak store] in
                guard let self, let store, let image = store.image(assetId) else { return }
                self.didLoad(image, at: index)
            }
        } else if let url = item.url {
            urlTask = Task { [weak self] in
                let image = await ImageDecoding.image(contentsOf: url)
                guard let self, !Task.isCancelled, let image else { return }
                self.didLoad(image, at: index)
            }
        }
    }

    private func didLoad(_ image: NSImage, at index: Int) {
        guard loadedImages[index] == nil else { return }
        loadedImages[index] = image
        if index == navigator.index, !isClosing, !isShowing {
            overlay.setImage(image, transition: .crossfade)
        }
    }

    // MARK: Closing

    /// Closes back into the current image's thumbnail when it is on screen, else fades.
    func close(animated: Bool = true) {
        guard !isClosing else { return }
        isClosing = true
        observation?.cancel()
        urlTask?.cancel()
        let target = animated ? sourceFrame(for: navigator.index) : nil
        let finish: @MainActor () -> Void = { [weak self] in
            guard let self else { return }
            self.hiddenSource?.alphaValue = 1
            self.hiddenSource = nil
            self.overlay.removeFromSuperview()
            if let window = self.window, let responder = self.previousResponder,
               (responder as? NSView)?.window === window || responder === window {
                window.makeFirstResponder(responder)
            }
            if ImageLightbox.current === self { ImageLightbox.current = nil }
        }
        guard animated else {
            finish()
            return
        }
        overlay.animateDim(in: false, animated: true)
        overlay.animateClose(to: target, completion: finish)
    }

    // MARK: Sources

    private func sourceView(for index: Int) -> NSView? {
        let view = sourceViewProvider?(index) ?? (index == navigator.startIndex ? initialSource : nil)
        guard let view, view.window === window, !view.isHiddenOrHasHiddenAncestor else { return nil }
        return view
    }

    /// The thumbnail's frame in the overlay, when it is visible in the window.
    private func sourceFrame(for index: Int) -> NSRect? {
        guard let view = sourceView(for: index) else { return nil }
        let inWindow = view.convert(view.bounds, to: nil)
        let frame = overlay.convert(inWindow, from: nil)
        guard frame.width > 2, frame.height > 2, overlay.bounds.intersects(frame) else { return nil }
        // Partly scrolled away: still animate from where it is, the overlay clips.
        return frame
    }

    private func updateHiddenSource() {
        let next = sourceView(for: navigator.index)
        if hiddenSource !== next {
            hiddenSource?.alphaValue = 1
            next?.alphaValue = 0
            hiddenSource = next
        }
    }

    // MARK: Toolbar

    func copyCurrent() {
        guard let image = currentImage else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([image])
    }

    func shareCurrent(from view: NSView) {
        guard let image = currentImage else { return }
        let picker = NSSharingServicePicker(items: [image])
        picker.show(relativeTo: view.bounds, of: view, preferredEdge: .maxY)
    }

    func saveCurrent() {
        guard let image = currentImage, let window else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        let caption = items[navigator.index].caption?.trimmingCharacters(in: CharacterSet(charactersIn: "@ ")) ?? ""
        panel.nameFieldStringValue = (caption.isEmpty ? "gorsel" : caption) + ".png"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url, let data = ImageDecoding.pngData(image) else { return }
            try? data.write(to: url)
        }
    }
}

// MARK: - Navigation logic

/// Index and counter of the lightbox (tested without views).
struct LightboxNavigator: Equatable {
    let count: Int
    let startIndex: Int
    private(set) var index: Int

    init(count: Int, start: Int) {
        self.count = max(0, count)
        let clamped = min(max(0, start), max(0, count - 1))
        self.startIndex = clamped
        self.index = clamped
    }

    var canGoBack: Bool { index > 0 }
    var canGoForward: Bool { index < count - 1 }
    var showsCounter: Bool { count > 1 }
    /// `9 / 12`.
    var counterText: String { "\(index + 1) / \(count)" }

    /// No wrap-around: the arrows stop at the ends (Claude Code). Returns whether it moved.
    @discardableResult mutating func next() -> Bool {
        guard canGoForward else { return false }
        index += 1
        return true
    }

    @discardableResult mutating func previous() -> Bool {
        guard canGoBack else { return false }
        index -= 1
        return true
    }

    @discardableResult mutating func go(to target: Int) -> Bool {
        guard (0..<count).contains(target), target != index else { return false }
        index = target
        return true
    }
}

/// Fit, zoom and pan maths of the lightbox (tested without views).
enum LightboxGeometry {
    /// Room kept free for the ✕ above and the bottom bar below.
    static let insets = NSEdgeInsets(top: 56, left: 48, bottom: 76, right: 48)
    static let zoomRange: ClosedRange<CGFloat> = 1...5
    static let doubleClickZoom: CGFloat = 2.5

    /// Aspect-fit rect of `imageSize` inside `bounds` minus `insets`, centred (never zero-sized).
    static func fitRect(imageSize: NSSize, in bounds: NSRect, insets: NSEdgeInsets = insets) -> NSRect {
        let area = NSRect(
            x: bounds.minX + insets.left, y: bounds.minY + insets.bottom,
            width: max(40, bounds.width - insets.left - insets.right),
            height: max(40, bounds.height - insets.top - insets.bottom)
        )
        guard imageSize.width > 0, imageSize.height > 0 else {
            let side = min(area.width, area.height) * 0.6
            return NSRect(x: area.midX - side / 2, y: area.midY - side / 2, width: side, height: side)
        }
        let scale = min(area.width / imageSize.width, area.height / imageSize.height)
        let size = NSSize(width: (imageSize.width * scale).rounded(), height: (imageSize.height * scale).rounded())
        return NSRect(x: (area.midX - size.width / 2).rounded(), y: (area.midY - size.height / 2).rounded(), width: size.width, height: size.height)
    }

    static func clampZoom(_ zoom: CGFloat) -> CGFloat {
        min(max(zoom, zoomRange.lowerBound), zoomRange.upperBound)
    }

    /// Pan offset (from the fit rect's centre) kept so the zoomed image still covers the
    /// viewport where it can; no pan at all at 1×.
    static func clampPan(_ pan: CGPoint, fit: NSRect, zoom: CGFloat, viewport: NSRect) -> CGPoint {
        guard zoom > 1.001 else { return .zero }
        let width = fit.width * zoom
        let height = fit.height * zoom
        let maxX = max(0, (width - viewport.width) / 2) + abs(viewport.midX - fit.midX)
        let maxY = max(0, (height - viewport.height) / 2) + abs(viewport.midY - fit.midY)
        let limitX = width > viewport.width ? maxX : (width - fit.width) / 2
        let limitY = height > viewport.height ? maxY : (height - fit.height) / 2
        return CGPoint(x: min(max(pan.x, -limitX), limitX), y: min(max(pan.y, -limitY), limitY))
    }

    /// The image frame for a zoom and pan.
    static func imageFrame(fit: NSRect, zoom: CGFloat, pan: CGPoint) -> NSRect {
        let width = fit.width * zoom
        let height = fit.height * zoom
        return NSRect(x: fit.midX + pan.x - width / 2, y: fit.midY + pan.y - height / 2, width: width, height: height)
    }

    /// Pan that keeps `point` (overlay coordinates) under the cursor while zooming `from` -> `to`.
    static func panKeeping(_ point: CGPoint, fit: NSRect, from oldZoom: CGFloat, to newZoom: CGFloat, pan: CGPoint) -> CGPoint {
        guard oldZoom > 0 else { return pan }
        let centre = CGPoint(x: fit.midX + pan.x, y: fit.midY + pan.y)
        let ratio = newZoom / oldZoom
        let newCentre = CGPoint(x: point.x - (point.x - centre.x) * ratio, y: point.y - (point.y - centre.y) * ratio)
        return CGPoint(x: newCentre.x - fit.midX, y: newCentre.y - fit.midY)
    }
}

// MARK: - Overlay view

/// The lightbox's full-window view: dim, image, ✕, bottom bar. Takes every click and key.
final class LightboxOverlayView: NSView {
    enum ImageTransition {
        case none
        case crossfade
        case zoom(from: NSRect?)
    }

    weak var lightbox: ImageLightbox?
    private let dimView = NSView()
    /// ✕, caption, counter, tools: faded with the dim.
    private var chrome: [NSView] = []
    /// Shadow holder; `imageView` inside it clips to the radius.
    private let imageShadow = NSView()
    let imageView = LightboxImageView()
    private let spinner = NSProgressIndicator()
    let closeButton = GlyphButton(symbol: "xmark", size: 14, weight: .medium, diameter: 32)
    private let captionLabel = NSTextField(labelWithString: "")
    let counterLabel = NSTextField(labelWithString: "")
    let previousButton = GlyphButton(symbol: "chevron.left", size: 14, weight: .medium, diameter: 30)
    let nextButton = GlyphButton(symbol: "chevron.right", size: 14, weight: .medium, diameter: 30)
    private let copyButton = GlyphButton(symbol: "doc.on.doc", size: 13, diameter: 30)
    private let shareButton = GlyphButton(symbol: "square.and.arrow.up", size: 13, diameter: 30)
    private let saveButton = GlyphButton(symbol: "arrow.down.to.line", size: 13, diameter: 30)

    private var imageSize: NSSize = .zero
    private(set) var zoom: CGFloat = 1
    private(set) var pan: CGPoint = .zero
    private var dragStart: (point: NSPoint, pan: CGPoint)?
    private var mouseDownOutside = false
    private var didDrag = false
    private var animating = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true
        dimView.wantsLayer = true
        dimView.layer?.backgroundColor = NSColor(white: 0, alpha: 0.85).cgColor
        dimView.alphaValue = 0
        addSubview(dimView)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Görsel önizleme")

        imageShadow.wantsLayer = true
        imageShadow.shadow = {
            let shadow = NSShadow()
            shadow.shadowColor = NSColor(white: 0, alpha: 0.45)
            shadow.shadowBlurRadius = 30
            shadow.shadowOffset = NSSize(width: 0, height: -8)
            return shadow
        }()
        imageView.setAccessibilityElement(true)
        imageView.setAccessibilityRole(.image)
        imageShadow.addSubview(imageView)
        addSubview(imageShadow)

        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.appearance = NSAppearance(named: .darkAqua)
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(spinner)

        let white = NSColor(white: 1, alpha: 0.88)
        for button in [closeButton, previousButton, nextButton, copyButton, shareButton, saveButton] {
            button.symbolTint = white
            button.appearance = NSAppearance(named: .darkAqua)
        }
        closeButton.toolTip = "Kapat (Esc)"
        closeButton.setAccessibilityLabel("Kapat")
        closeButton.onAction = { [weak self] in self?.lightbox?.close() }
        previousButton.toolTip = "Önceki (←)"
        previousButton.onAction = { [weak self] in self?.lightbox?.previous() }
        nextButton.toolTip = "Sonraki (→)"
        nextButton.onAction = { [weak self] in self?.lightbox?.next() }
        copyButton.toolTip = "Kopyala"
        copyButton.setAccessibilityLabel("Görseli kopyala")
        copyButton.onAction = { [weak self] in self?.lightbox?.copyCurrent() }
        shareButton.toolTip = "Paylaş"
        shareButton.setAccessibilityLabel("Paylaş")
        shareButton.onAction = { [weak self] in
            guard let self else { return }
            self.lightbox?.shareCurrent(from: self.shareButton)
        }
        saveButton.toolTip = "Kaydet…"
        saveButton.setAccessibilityLabel("Görseli kaydet")
        saveButton.onAction = { [weak self] in self?.lightbox?.saveCurrent() }

        captionLabel.font = NSFont.systemFont(ofSize: 14)
        captionLabel.textColor = white
        captionLabel.lineBreakMode = .byTruncatingTail
        captionLabel.translatesAutoresizingMaskIntoConstraints = false
        counterLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .regular)
        counterLabel.textColor = white
        counterLabel.alignment = .center

        let counterRow = NSStackView(views: [previousButton, counterLabel, nextButton])
        counterRow.orientation = .horizontal
        counterRow.alignment = .centerY
        counterRow.spacing = 14
        counterRow.translatesAutoresizingMaskIntoConstraints = false
        let tools = NSStackView(views: [copyButton, shareButton, saveButton])
        tools.orientation = .horizontal
        tools.spacing = 4
        tools.translatesAutoresizingMaskIntoConstraints = false

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(closeButton)
        addSubview(captionLabel)
        addSubview(counterRow)
        addSubview(tools)
        chrome = [closeButton, captionLabel, counterRow, tools]
        NSLayoutConstraint.activate([
            closeButton.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            counterRow.centerXAnchor.constraint(equalTo: centerXAnchor),
            counterRow.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -22),
            captionLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            captionLabel.centerYAnchor.constraint(equalTo: counterRow.centerYAnchor),
            captionLabel.trailingAnchor.constraint(lessThanOrEqualTo: counterRow.leadingAnchor, constant: -16),
            tools.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            tools.centerYAnchor.constraint(equalTo: counterRow.centerYAnchor),
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: Content

    func update(caption: String?, navigator: LightboxNavigator) {
        captionLabel.stringValue = caption ?? ""
        counterLabel.stringValue = navigator.counterText
        counterLabel.isHidden = !navigator.showsCounter
        previousButton.isHidden = !navigator.showsCounter
        nextButton.isHidden = !navigator.showsCounter
        previousButton.isEnabled = navigator.canGoBack
        nextButton.isEnabled = navigator.canGoForward
        imageView.setAccessibilityLabel(caption ?? "Görsel")
    }

    var captionText: String { captionLabel.stringValue }

    func setImage(_ image: NSImage?, transition: ImageTransition) {
        let cg = image.flatMap { ImageDecoding.cgImage(of: $0) }
        imageSize = cg.map { NSSize(width: $0.width, height: $0.height) } ?? image?.size ?? .zero
        if image == nil { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }

        let target = currentFrame()
        switch transition {
        case .none:
            imageView.setBitmap(cg, fade: false)
            place(target)
        case .crossfade:
            imageView.setBitmap(cg, fade: true)
            animate(to: target, spring: false, duration: 0.2)
        case .zoom(let from):
            imageView.setBitmap(cg, fade: false)
            if let from {
                place(from)
                layoutSubtreeIfNeeded()
                animate(to: target, spring: true, duration: 0.45)
            } else {
                place(target)
                imageShadow.layer?.opacity = 0
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 0
                fade.toValue = 1
                fade.duration = 0.2
                imageShadow.layer?.add(fade, forKey: "fadeIn")
                imageShadow.layer?.opacity = 1
            }
        }
    }

    func resetZoom() {
        zoom = 1
        pan = .zero
    }

    private var fitRect: NSRect { LightboxGeometry.fitRect(imageSize: imageSize, in: bounds) }

    private func currentFrame() -> NSRect {
        LightboxGeometry.imageFrame(fit: fitRect, zoom: zoom, pan: pan)
    }

    private func place(_ frame: NSRect) {
        imageShadow.frame = frame
        imageView.frame = imageShadow.bounds
    }

    /// Animates the image to `target`; a spring for open / close, ease-out otherwise.
    private func animate(to target: NSRect, spring: Bool, duration: CFTimeInterval, completion: (() -> Void)? = nil) {
        let from = imageShadow.frame
        place(target)
        guard let shadowLayer = imageShadow.layer, let imageLayer = imageView.layer, from != target, !Self.reduceMotion else {
            completion?()
            return
        }
        animating = true
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            self?.animating = false
            completion?()
        }
        func makeAnimation(_ keyPath: String, _ fromValue: Any, _ toValue: Any) -> CABasicAnimation {
            let animation: CABasicAnimation
            if spring {
                let s = CASpringAnimation(keyPath: keyPath)
                s.mass = 1
                s.stiffness = 280
                s.damping = 28
                s.initialVelocity = 0
                s.duration = min(s.settlingDuration, duration * 1.6)
                animation = s
            } else {
                animation = CABasicAnimation(keyPath: keyPath)
                animation.duration = duration
                animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
            }
            animation.fromValue = fromValue
            animation.toValue = toValue
            return animation
        }
        let anchor = shadowLayer.anchorPoint
        let fromPosition = CGPoint(x: from.minX + anchor.x * from.width, y: from.minY + anchor.y * from.height)
        let toPosition = CGPoint(x: target.minX + anchor.x * target.width, y: target.minY + anchor.y * target.height)
        shadowLayer.add(makeAnimation("position", NSValue(point: fromPosition), NSValue(point: toPosition)), forKey: "position")
        shadowLayer.add(makeAnimation("bounds.size", NSValue(size: from.size), NSValue(size: target.size)), forKey: "size")
        let innerAnchor = imageLayer.anchorPoint
        imageLayer.add(makeAnimation("bounds.size", NSValue(size: from.size), NSValue(size: target.size)), forKey: "size")
        imageLayer.add(makeAnimation(
            "position",
            NSValue(point: CGPoint(x: innerAnchor.x * from.width, y: innerAnchor.y * from.height)),
            NSValue(point: CGPoint(x: innerAnchor.x * target.width, y: innerAnchor.y * target.height))
        ), forKey: "position")
        CATransaction.commit()
    }

    func animateDim(in fadeIn: Bool, animated: Bool) {
        let target: CGFloat = fadeIn ? 1 : 0
        guard animated, !Self.reduceMotion else {
            dimView.alphaValue = target
            for view in chrome { view.alphaValue = target }
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = fadeIn ? 0.22 : 0.2
            dimView.animator().alphaValue = target
            for view in chrome { view.animator().alphaValue = target }
        }
    }

    /// The dim's opacity now (tests).
    var dimAlpha: CGFloat { dimView.alphaValue }

    func animateClose(to target: NSRect?, completion: @escaping @MainActor () -> Void) {
        resetZoom()
        if let target {
            animate(to: target, spring: true, duration: 0.32, completion: completion)
        } else {
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = Self.reduceMotion ? 0 : 0.18
                imageShadow.animator().alphaValue = 0
            }, completionHandler: {
                MainActor.assumeIsolated { completion() }
            })
        }
    }

    private static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    override func layout() {
        super.layout()
        dimView.frame = bounds
        if !animating, lightbox?.isClosing != true {
            pan = LightboxGeometry.clampPan(pan, fit: fitRect, zoom: zoom, viewport: bounds)
            place(currentFrame())
        }
    }

    // MARK: Zoom & pan

    func setZoom(_ newZoom: CGFloat, around point: NSPoint?, animated: Bool) {
        let clamped = LightboxGeometry.clampZoom(newZoom)
        let fit = fitRect
        let anchor = point ?? NSPoint(x: fit.midX + pan.x, y: fit.midY + pan.y)
        var nextPan = LightboxGeometry.panKeeping(anchor, fit: fit, from: zoom, to: clamped, pan: pan)
        nextPan = LightboxGeometry.clampPan(nextPan, fit: fit, zoom: clamped, viewport: bounds)
        zoom = clamped
        pan = nextPan
        if animated {
            animate(to: currentFrame(), spring: false, duration: 0.22)
        } else {
            place(currentFrame())
        }
    }

    // MARK: Events

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // Everything inside the overlay belongs to it (nothing reaches the chat below).
        super.hitTest(point) ?? (frame.contains(point) ? self : nil)
    }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53, 49: lightbox?.close() // Esc, Space
        case 123: lightbox?.previous()
        case 124: lightbox?.next()
        default: super.keyDown(with: event)
        }
    }

    override func cancelOperation(_ sender: Any?) { lightbox?.close() }

    private func imageContains(_ event: NSEvent) -> Bool {
        imageShadow.frame.contains(convert(event.locationInWindow, from: nil))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        didDrag = false
        mouseDownOutside = !imageContains(event)
        if event.clickCount == 2, !mouseDownOutside {
            setZoom(zoom > 1.01 ? 1 : LightboxGeometry.doubleClickZoom, around: zoom > 1.01 ? nil : point, animated: true)
            return
        }
        dragStart = zoom > 1.01 ? (point, pan) : nil
    }

    override func mouseDragged(with event: NSEvent) {
        didDrag = true
        guard let dragStart else { return }
        let point = convert(event.locationInWindow, from: nil)
        let moved = CGPoint(x: dragStart.pan.x + point.x - dragStart.point.x, y: dragStart.pan.y + point.y - dragStart.point.y)
        pan = LightboxGeometry.clampPan(moved, fit: fitRect, zoom: zoom, viewport: bounds)
        place(currentFrame())
    }

    override func mouseUp(with event: NSEvent) {
        defer { dragStart = nil }
        if mouseDownOutside, !didDrag, !imageContains(event), event.clickCount <= 1 {
            lightbox?.close()
        }
    }

    override func magnify(with event: NSEvent) {
        setZoom(zoom * (1 + event.magnification), around: convert(event.locationInWindow, from: nil), animated: false)
    }

    override func scrollWheel(with event: NSEvent) {
        guard zoom > 1.01 else { return }
        let moved = CGPoint(x: pan.x + event.scrollingDeltaX, y: pan.y - event.scrollingDeltaY)
        pan = LightboxGeometry.clampPan(moved, fit: fitRect, zoom: zoom, viewport: bounds)
        place(currentFrame())
    }

    override func rightMouseDown(with event: NSEvent) {}
}

/// The lightbox image: a rounded layer showing the decoded bitmap (aspect fill, so the
/// zoom from a square thumbnail uncrops smoothly).
final class LightboxImageView: NSView {
    private(set) var bitmap: CGImage?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layerContentsPlacement = .scaleProportionallyToFill
        layer?.cornerRadius = ChatStyle.imageRadius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        layer?.minificationFilter = .trilinear
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var wantsUpdateLayer: Bool { true }

    func setBitmap(_ image: CGImage?, fade: Bool) {
        bitmap = image
        if fade, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let transition = CATransition()
            transition.type = .fade
            transition.duration = 0.16
            layer?.add(transition, forKey: "contents")
        }
        updateLayer()
    }

    override func updateLayer() {
        layer?.contentsGravity = .resizeAspectFill
        layer?.contents = bitmap
        layer?.backgroundColor = bitmap == nil ? NSColor(white: 1, alpha: 0.06).cgColor : nil
    }
}

// MARK: - Decoding

/// Image decoding off the main thread (chat thumbnails, the lightbox).
enum ImageDecoding {
    /// Decodes `data` fully (no lazy decode at first draw); nil for unreadable data.
    nonisolated static func decodedCGImage(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true, kCGImageSourceShouldCache: true]
        return CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
    }

    /// `NSImage` decoded on a background thread; its size is the pixel size. Formats ImageIO
    /// cannot rasterise (SVG, PDF logos) fall back to `NSImage(data:)`.
    @MainActor static func decode(_ data: Data) async -> NSImage? {
        let box = await Task.detached(priority: .userInitiated) { CGImageBox(decodedCGImage(data)) }.value
        guard let cg = box.image else { return NSImage(data: data) }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    /// A file or https image, read and decoded off the main thread.
    @MainActor static func image(contentsOf url: URL) async -> NSImage? {
        let data: Data?
        if url.isFileURL {
            data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: url) }.value
        } else {
            data = try? await URLSession.shared.data(from: url).0
        }
        guard let data else { return nil }
        return await decode(data)
    }

    /// The bitmap behind an image (no re-rasterising for images made by `decode`).
    static func cgImage(of image: NSImage) -> CGImage? {
        var rect = NSRect(origin: .zero, size: image.size)
        return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
    }

    static func pngData(_ image: NSImage) -> Data? {
        guard let cg = cgImage(of: image) else { return nil }
        return NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
    }
}

/// Moves a decoded `CGImage` across the detached decode task.
struct CGImageBox: @unchecked Sendable {
    let image: CGImage?
    init(_ image: CGImage?) { self.image = image }
}
