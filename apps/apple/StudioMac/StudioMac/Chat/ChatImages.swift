import AppKit
import StudioKit

/// One chat image: rounded, aspect-filled from the decoded bitmap (layer contents, no
/// main-thread redraws); hovering dims it and shows ⤢; a click opens the lightbox.
final class ChatImageTileView: NSView {
    private(set) var image: ChatImage
    var onClick: ((ChatImageTileView) -> Void)?
    /// The image's pixel size arrived (a single image takes its aspect from it).
    var onNaturalSizeChange: (() -> Void)?
    /// Right-click "Yeniden adlandır…" for an alias.
    var onRename: ((EntityID) -> Void)?
    private weak var store: ImageStore?
    private var observation: ObservationToken?
    private var bitmap: CGImage?
    private(set) var naturalSize: NSSize?
    private let dimView = NSView()
    private let badge = NSView()
    private var tracking: NSTrackingArea?
    private var pressed = false
    private let showsBadge: Bool

    init(image: ChatImage, store: ImageStore?, radius: CGFloat = ChatStyle.imageRadius, showsBadge: Bool = true) {
        self.image = image
        self.store = store
        self.showsBadge = showsBadge
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsPlacement = .scaleProportionallyToFill
        layer?.cornerRadius = radius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        layer?.contentsGravity = .resizeAspectFill
        layer?.minificationFilter = .trilinear

        dimView.wantsLayer = true
        dimView.layer?.backgroundColor = ChatStyle.imageHoverDim.cgColor
        dimView.alphaValue = 0
        addSubview(dimView)

        badge.wantsLayer = true
        badge.layer?.backgroundColor = NSColor(white: 0, alpha: 0.45).cgColor
        badge.layer?.cornerRadius = 11
        badge.alphaValue = 0
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "arrow.up.left.and.arrow.down.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
        icon.contentTintColor = .white
        icon.frame = NSRect(x: 0, y: 0, width: 22, height: 22)
        icon.imageAlignment = .alignCenter
        badge.addSubview(icon)
        addSubview(badge)

        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        bind()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ next: ChatImage) {
        let rebinding = next.assetId != image.assetId
        image = next
        updateAccessibility()
        if rebinding {
            bitmap = nil
            naturalSize = nil
            bind()
        }
    }

    /// The bitmap is set (tests).
    var hasImage: Bool { bitmap != nil }

    private func bind() {
        updateAccessibility()
        observation?.cancel()
        observation = nil
        needsDisplay = true
        guard let store else { return }
        let assetId = image.assetId
        store.load(assetId)
        observation = observe { [weak self, weak store] in
            guard let self, let store else { return }
            guard let loaded = store.image(assetId) else { return }
            self.setBitmap(ImageDecoding.cgImage(of: loaded))
        }
    }

    private func setBitmap(_ cg: CGImage?) {
        guard cg !== bitmap else { return }
        bitmap = cg
        let size = cg.map { NSSize(width: $0.width, height: $0.height) }
        needsDisplay = true
        if size != naturalSize {
            naturalSize = size
            onNaturalSizeChange?()
        }
    }

    private func updateAccessibility() {
        setAccessibilityLabel(image.caption.map { "Görsel \($0)" } ?? "Görsel")
        toolTip = image.caption
    }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.contentsGravity = .resizeAspectFill
        layer?.contents = bitmap
        layer?.backgroundColor = bitmap == nil ? resolvedCGColor(Theme.fill) : nil
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        dimView.frame = bounds
        badge.frame = NSRect(x: bounds.maxX - 30, y: isFlipped ? 8 : bounds.maxY - 30, width: 22, height: 22)
        badge.isHidden = !showsBadge || bounds.width < 64
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { setHover(true) }
    override func mouseExited(with event: NSEvent) { setHover(false) }

    private func setHover(_ on: Bool) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            dimView.animator().alphaValue = on ? 1 : 0
            badge.animator().alphaValue = on ? 1 : 0
        }
    }

    override func mouseDown(with event: NSEvent) {
        pressed = true
    }

    override func mouseUp(with event: NSEvent) {
        defer { pressed = false }
        guard pressed, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onClick?(self)
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?(self)
        return true
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(ClosureMenuItem(title: "Büyüt") { [weak self] in
            guard let self else { return }
            self.onClick?(self)
        })
        if let bitmap {
            menu.addItem(ClosureMenuItem(title: "Görseli kopyala") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.writeObjects([NSImage(cgImage: bitmap, size: .zero)])
            })
        }
        if let aliasId = image.aliasId, let onRename {
            menu.addItem(ClosureMenuItem(title: "Yeniden adlandır…") { onRename(aliasId) })
        }
        return menu
    }
}

/// Chat images: one image up to `maxWidth` keeping its aspect, several in a tidy grid of square
/// tiles (2 columns for 2 or 4 images, else 3) with 6 pt gaps.
final class ChatImageGridView: NSView {
    let maxWidth: CGFloat
    private weak var store: ImageStore?
    private(set) var images: [ChatImage] = []
    private(set) var tiles: [ChatImageTileView] = []
    /// A tile was clicked (its index in this grid).
    var onOpen: ((Int, ChatImageTileView) -> Void)?
    var onRename: ((EntityID) -> Void)?
    private var lastWidth: CGFloat = 0

    override var isFlipped: Bool { true }

    init(maxWidth: CGFloat, store: ImageStore?) {
        self.maxWidth = maxWidth
        self.store = store
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ next: [ChatImage]) {
        guard next != images else { return }
        images = next
        // Reuse tiles by position; only new asset ids load again.
        while tiles.count > next.count { tiles.removeLast().removeFromSuperview() }
        for (index, image) in next.enumerated() {
            if index < tiles.count {
                tiles[index].configure(image)
            } else {
                let tile = ChatImageTileView(image: image, store: store)
                tile.onClick = { [weak self] tile in
                    guard let self, let i = self.tiles.firstIndex(where: { $0 === tile }) else { return }
                    self.onOpen?(i, tile)
                }
                tile.onRename = { [weak self] id in self?.onRename?(id) }
                tile.onNaturalSizeChange = { [weak self] in
                    guard let self, self.tiles.count == 1 else { return }
                    self.invalidateIntrinsicContentSize()
                    self.needsLayout = true
                }
                tiles.append(tile)
                addSubview(tile)
            }
        }
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    /// Height / width of a single image: its known size, else the loaded bitmap, else 4:5.
    private var singleAspect: CGFloat {
        if let image = images.first, let w = image.width, let h = image.height, w > 0, h > 0 { return CGFloat(h) / CGFloat(w) }
        if let size = tiles.first?.naturalSize, size.width > 0 { return size.height / size.width }
        return 1.25
    }

    private var naturalSingleWidth: CGFloat? {
        if let image = images.first, let w = image.width, w > 0 { return CGFloat(w) }
        return tiles.first?.naturalSize?.width
    }

    override var intrinsicContentSize: NSSize {
        let width = bounds.width > 1 ? bounds.width : preferredWidth
        let layout = Self.layout(count: images.count, width: width, aspect: singleAspect, maxWidth: maxWidth, naturalWidth: naturalSingleWidth)
        return NSSize(width: preferredWidth, height: layout.size.height)
    }

    /// The width it would like (narrower columns shrink it).
    private var preferredWidth: CGFloat {
        Self.layout(count: images.count, width: maxWidth, aspect: singleAspect, maxWidth: maxWidth, naturalWidth: naturalSingleWidth).size.width
    }

    override func layout() {
        super.layout()
        let layout = Self.layout(count: images.count, width: bounds.width, aspect: singleAspect, maxWidth: maxWidth, naturalWidth: naturalSingleWidth)
        for (tile, frame) in zip(tiles, layout.frames) { tile.frame = frame }
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    /// Tile frames (flipped) and the total size for `count` images in `width` (tested).
    static func layout(count: Int, width available: CGFloat, aspect: CGFloat, maxWidth: CGFloat, naturalWidth: CGFloat? = nil, gap: CGFloat = ChatStyle.imageGap) -> (frames: [NSRect], size: NSSize) {
        guard count > 0 else { return ([], .zero) }
        let width = max(40, min(available, maxWidth))
        if count == 1 {
            var w = min(width, naturalWidth.map { max(120, $0) } ?? width)
            let maxHeight = max(maxWidth * 1.1, 260)
            if w * aspect > maxHeight { w = maxHeight / aspect }
            let h = (w * aspect).rounded()
            w = w.rounded()
            return ([NSRect(x: 0, y: 0, width: w, height: h)], NSSize(width: w, height: h))
        }
        let columns = columnCount(for: count)
        let cell = ((width - gap * CGFloat(columns - 1)) / CGFloat(columns)).rounded(.down)
        var frames: [NSRect] = []
        for index in 0..<count {
            let row = index / columns
            let column = index % columns
            frames.append(NSRect(x: CGFloat(column) * (cell + gap), y: CGFloat(row) * (cell + gap), width: cell, height: cell))
        }
        let rows = (count + columns - 1) / columns
        let usedColumns = min(count, columns)
        return (frames, NSSize(width: CGFloat(usedColumns) * cell + CGFloat(usedColumns - 1) * gap, height: CGFloat(rows) * cell + CGFloat(rows - 1) * gap))
    }

    static func columnCount(for count: Int) -> Int {
        switch count {
        case ...1: 1
        case 2, 4: 2
        default: 3
        }
    }
}
