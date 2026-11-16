import AppKit
import StudioKit

/// The opened post's slide: the rendered image at full quality with the layer boxes the
/// renderer measured on top. Click selects a layer, drag moves it, the corner handle
/// resizes it, double-click edits text inline, pictures dropped on a slot or image fill it.
final class SlideCanvasView: NSView, NSTextViewDelegate {
    private let model: PostDetailModel
    private let imageView: AssetImageView
    /// Boxes, handles and slot outlines, drawn above the image.
    private let overlay = CanvasOverlayView()
    private var fallback: PostPlaceholderView?
    private var fallbackKey: String?
    private var observation: ObservationToken?
    private var trackingArea: NSTrackingArea?

    /// Hovered layer (artboard id).
    private var hoverId: String?
    private var dropTargetId: String?
    /// Live drag: the box being dragged and its offset / scale.
    private var drag: DragState?
    private var inlineEditor: InlineTextEditor?

    private struct DragState {
        enum Kind { case move, resize }
        var kind: Kind
        var layerId: String
        var start: CGPoint
        var box: CGRect
        var current: CGPoint
        var moved: Bool
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(model: PostDetailModel) {
        self.model = model
        self.imageView = AssetImageView(store: model.app.images, contentMode: .fit)
        super.init(frame: .zero)
        wantsLayer = true
        imageView.frame = bounds
        imageView.autoresizingMask = [.width, .height]
        addSubview(imageView)
        overlay.frame = bounds
        overlay.autoresizingMask = [.width, .height]
        overlay.drawer = { [weak self] rect in self?.drawOverlay(rect) }
        addSubview(overlay)
        registerForDraggedTypes([.fileURL])
        setAccessibilityRole(.group)
        setAccessibilityLabel("Post tuvali")
        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: State

    private var geometry: SlideCanvasGeometry {
        SlideCanvasGeometry.fitting(artboard: model.artboardSize, in: bounds)
    }

    private var editable: Bool { model.canEdit }

    private func sync() {
        let slide = model.currentSlide
        imageView.assetId = slide?.renderedAssetId
        // Without a render (old or failed versions) the typographic placeholder stands in.
        let key = slide?.renderedAssetId == nil ? "\(model.activeVersion?.id ?? "-")-\(model.selectedSlideIndex)" : nil
        if key != fallbackKey {
            fallbackKey = key
            fallback?.removeFromSuperview()
            fallback = nil
            if key != nil {
                let view = PostPlaceholderView(
                    imageStore: model.app.images, card: model.card, scale: max(1.6, bounds.width / 190),
                    slideIndex: model.selectedSlideIndex, overrideVersion: model.activeVersion)
                view.frame = bounds
                view.autoresizingMask = [.width, .height]
                addSubview(view, positioned: .above, relativeTo: imageView)
                fallback = view
                addSubview(overlay, positioned: .above, relativeTo: view)
            }
        }
        _ = model.layerBoxes
        _ = model.selectedLayerId
        _ = model.previewBoxes
        _ = model.layers
        if let editor = inlineEditor, model.selectedLayerId != editor.layerId { endInlineEdit(commit: false) }
        refreshOverlay()
        setAccessibilityLabel(model.slides.count > 1 ? "Slayt \(model.selectedSlideIndex + 1) / \(model.slides.count)" : "Post")
    }

    /// Redraw boxes and handles.
    private func refreshOverlay() { overlay.needsDisplay = true }

    /// Every click lands on the canvas (the image and placeholder never take events),
    /// except inside the inline text editor.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview.map { convert(point, from: $0) } ?? point
        guard bounds.contains(local) else { return nil }
        if let editor = inlineEditor, editor.frame.contains(local) { return editor.hitTest(local) ?? self }
        return self
    }

    override func layout() {
        super.layout()
        imageView.frame = bounds
        overlay.frame = bounds
        fallback?.frame = bounds
        if let editor = inlineEditor, let box = model.box(for: editor.layerId) {
            editor.frame = editorFrame(for: geometry.viewRect(box))
        }
    }

    // MARK: Drawing

    private func drawOverlay(_ dirtyRect: NSRect) {
        guard let boxes = model.layerBoxes, model.currentSlide?.renderedAssetId != nil else { return }
        let geo = geometry
        let layers = model.layers
        let selected = model.selectedLayerId

        // Empty slots wait on the user: dashed accent outline with "Görsel ekle".
        for layer in layers where layer.kind == .slot && layer.slotState != .filled {
            guard let rect = model.box(for: layer.layerId).map(geo.viewRect) else { continue }
            drawEmptySlot(rect, highlighted: dropTargetId == layer.layerId)
        }
        if let dropTargetId, layers.first(where: { $0.layerId == dropTargetId })?.kind == .image, let box = model.box(for: dropTargetId) {
            stroke(geo.viewRect(box).insetBy(dx: -1, dy: -1), color: Theme.accent, width: 2, dashed: true)
        }

        guard model.isViewingCurrentVersion else { return }
        if let hoverId, hoverId != selected, boxes.contains(where: { $0.id == hoverId }), let box = model.box(for: hoverId) {
            stroke(geo.viewRect(box), color: NSColor.white.withAlphaComponent(0.9), width: 1, dashed: false, shadow: true)
        }
        if let selected, var rect = model.box(for: selected).map(geo.viewRect) {
            if let drag, drag.layerId == selected, drag.moved {
                rect = draggedRect(drag, geometry: geo)
            }
            stroke(rect, color: .white, width: 1.5, dashed: false, shadow: true)
            if editable { drawHandle(at: CGPoint(x: rect.maxX, y: rect.maxY)) }
        }
    }

    private func drawEmptySlot(_ rect: CGRect, highlighted: Bool) {
        let path = NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 14, yRadius: 14)
        (highlighted ? Theme.accent.withAlphaComponent(0.14) : NSColor.black.withAlphaComponent(0.04)).setFill()
        path.fill()
        Theme.accent.setStroke()
        path.lineWidth = 1.5
        path.setLineDash([6, 5], count: 2, phase: 0)
        path.stroke()
        guard rect.width > 90, rect.height > 50, editable else { return }
        let title = NSAttributedString(string: "Görsel ekle", attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: Theme.accent,
        ])
        let sub = NSAttributedString(string: "sürükle ya da tıkla", attributes: [
            .font: NSFont.systemFont(ofSize: 10), .foregroundColor: Theme.accent.withAlphaComponent(0.75),
        ])
        let t = title.size(), s = sub.size()
        title.draw(at: CGPoint(x: rect.midX - t.width / 2, y: rect.midY - t.height))
        sub.draw(at: CGPoint(x: rect.midX - s.width / 2, y: rect.midY + 2))
    }

    private func stroke(_ rect: CGRect, color: NSColor, width: CGFloat, dashed: Bool, shadow: Bool = false) {
        NSGraphicsContext.saveGraphicsState()
        if shadow {
            let s = NSShadow()
            s.shadowColor = NSColor.black.withAlphaComponent(0.55)
            s.shadowBlurRadius = 2
            s.shadowOffset = .zero
            s.set()
        }
        let path = NSBezierPath(rect: rect)
        path.lineWidth = width
        if dashed { path.setLineDash([5, 4], count: 2, phase: 0) }
        color.setStroke()
        path.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }

    private static let handleSize: CGFloat = 10

    private func handleRect(at corner: CGPoint) -> CGRect {
        CGRect(x: corner.x - Self.handleSize / 2, y: corner.y - Self.handleSize / 2, width: Self.handleSize, height: Self.handleSize)
    }

    private func drawHandle(at corner: CGPoint) {
        let rect = handleRect(at: corner)
        NSGraphicsContext.saveGraphicsState()
        let s = NSShadow()
        s.shadowColor = NSColor.black.withAlphaComponent(0.5)
        s.shadowBlurRadius = 2
        s.set()
        NSColor.white.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 2.5, yRadius: 2.5).fill()
        NSGraphicsContext.restoreGraphicsState()
        Theme.ink.withAlphaComponent(0.6).setStroke()
        let border = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 2.5, yRadius: 2.5)
        border.lineWidth = 1
        border.stroke()
    }

    private func draggedRect(_ drag: DragState, geometry geo: SlideCanvasGeometry) -> CGRect {
        let start = geo.viewRect(drag.box)
        let dx = drag.current.x - drag.start.x
        let dy = drag.current.y - drag.start.y
        switch drag.kind {
        case .move:
            return start.offsetBy(dx: dx, dy: dy)
        case .resize:
            let factor = resizeFactor(drag, start: start)
            return CGRect(x: start.minX, y: start.minY, width: start.width * factor, height: start.height * factor)
        }
    }

    /// Uniform scale from the corner drag (the larger of the two axes, like Keynote).
    private func resizeFactor(_ drag: DragState, start: CGRect) -> CGFloat {
        let fx = (start.width + drag.current.x - drag.start.x) / max(start.width, 1)
        let fy = (start.height + drag.current.y - drag.start.y) / max(start.height, 1)
        return max(0.1, min(20, max(fx, fy)))
    }

    // MARK: Hit testing

    private func layerId(at viewPoint: CGPoint) -> String? {
        guard let boxes = model.layerBoxes, model.currentSlide?.renderedAssetId != nil else { return nil }
        let point = geometry.artboardPoint(viewPoint)
        let adjusted = boxes.map { box -> SlideLayerBox in
            guard let preview = model.previewBoxes[box.id] else { return box }
            var copy = box
            copy.x = preview.minX; copy.y = preview.minY; copy.w = preview.width; copy.h = preview.height
            return copy
        }
        // Never pick the full-bleed background when something else is there.
        return SlideCanvasGeometry.hitTest(point, in: adjusted)?.id
    }

    private func isOnHandle(_ viewPoint: CGPoint) -> Bool {
        guard editable, let selected = model.selectedLayerId, let box = model.box(for: selected) else { return false }
        let rect = geometry.viewRect(box)
        return handleRect(at: CGPoint(x: rect.maxX, y: rect.maxY)).insetBy(dx: -4, dy: -4).contains(viewPoint)
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect, .cursorUpdate], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let id = layerId(at: point)
        if id != hoverId {
            hoverId = id
            refreshOverlay()
        }
        updateCursor(at: point)
    }

    override func mouseExited(with event: NSEvent) {
        hoverId = nil
        refreshOverlay()
        NSCursor.arrow.set()
    }

    override func cursorUpdate(with event: NSEvent) {
        updateCursor(at: convert(event.locationInWindow, from: nil))
    }

    private func updateCursor(at point: CGPoint) {
        if isOnHandle(point) {
            NSCursor.frameResize(position: .bottomRight, directions: .all).set()
        } else if editable, let selected = model.selectedLayerId, layerId(at: point) == selected {
            NSCursor.openHand.set()
        } else {
            NSCursor.arrow.set()
        }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        if inlineEditor != nil { endInlineEdit(commit: true) }
        guard model.isViewingCurrentVersion else { return }

        if isOnHandle(point), let selected = model.selectedLayerId, let box = model.box(for: selected) {
            drag = DragState(kind: .resize, layerId: selected, start: point, box: box, current: point, moved: false)
            return
        }
        let hit = layerId(at: point)
        let layer = hit.flatMap { id in model.layers.first { $0.layerId == id } }

        if event.clickCount >= 2, let layer {
            model.select(layer: layer.layerId)
            if layer.kind == .text, editable {
                beginInlineEdit(layer.layerId)
            } else if layer.kind == .slot || layer.kind == .image {
                pickImage(for: layer.layerId)
            }
            return
        }

        model.select(layer: hit)
        if let layer, layer.kind == .slot, layer.slotState != .filled, editable, event.clickCount == 1 {
            // A click on an empty slot asks for the picture right away.
            pickImage(for: layer.layerId)
            return
        }
        if let hit, editable, let box = model.box(for: hit) {
            drag = DragState(kind: .move, layerId: hit, start: point, box: box, current: point, moved: false)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard var current = drag else { return }
        current.current = convert(event.locationInWindow, from: nil)
        if !current.moved, hypot(current.current.x - current.start.x, current.current.y - current.start.y) > 3 {
            current.moved = true
            if current.kind == .move { NSCursor.closedHand.set() }
        }
        drag = current
        refreshOverlay()
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            drag = nil
            refreshOverlay()
            updateCursor(at: convert(event.locationInWindow, from: nil))
        }
        guard let drag, drag.moved else { return }
        let geo = geometry
        switch drag.kind {
        case .move:
            let delta = geo.artboardDelta(CGSize(width: drag.current.x - drag.start.x, height: drag.current.y - drag.start.y))
            model.move(drag.layerId, by: delta)
        case .resize:
            let factor = resizeFactor(drag, start: geo.viewRect(drag.box))
            model.resize(drag.layerId, factor: Double(factor))
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        guard model.isViewingCurrentVersion, let id = layerId(at: point), let layer = model.layers.first(where: { $0.layerId == id }) else { return nil }
        model.select(layer: id)
        return LayerMenu.make(for: layer, model: model, onEditText: { [weak self] in self?.beginInlineEdit(id) }, onPickImage: { [weak self] in self?.pickImage(for: id) })
    }

    func pickImage(for layerId: String) {
        guard editable else {
            model.error = model.editBlocker
            return
        }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = ImageImport.fileTypes
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = "Yerleştir"
        panel.message = "Yerleştirilecek görseli seç"
        let handle: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.model.placeImage(from: url, into: layerId)
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: handle) } else { handle(panel.runModal()) }
    }

    // MARK: Keyboard

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let step: CGFloat = flags.contains(.shift) ? 10 : 1
        let selected = model.selectedLayerId
        switch event.keyCode {
        case 123: // ←
            if let selected, editable { model.nudge(selected, dx: -step, dy: 0) } else { model.selectSlide(model.selectedSlideIndex - 1) }
        case 124: // →
            if let selected, editable { model.nudge(selected, dx: step, dy: 0) } else { model.selectSlide(model.selectedSlideIndex + 1) }
        case 126: // ↑
            if let selected, editable { model.nudge(selected, dx: 0, dy: -step) } else { super.keyDown(with: event) }
        case 125: // ↓
            if let selected, editable { model.nudge(selected, dx: 0, dy: step) } else { super.keyDown(with: event) }
        case 36, 76: // ↩: edit the selected text inline
            if let selected, model.layers.first(where: { $0.layerId == selected })?.kind == .text, editable {
                beginInlineEdit(selected)
            } else {
                super.keyDown(with: event)
            }
        case 48: // tab: next / previous layer
            selectNextLayer(backwards: flags.contains(.shift))
        default:
            super.keyDown(with: event)
        }
    }

    private func selectNextLayer(backwards: Bool) {
        let ids = model.layers.filter { !$0.isHidden && $0.role != "background" }.map(\.layerId)
        guard !ids.isEmpty else { return }
        let index = model.selectedLayerId.flatMap { ids.firstIndex(of: $0) }
        let next = index.map { (backwards ? $0 - 1 + ids.count : $0 + 1) % ids.count } ?? (backwards ? ids.count - 1 : 0)
        model.select(layer: ids[next])
    }

    // MARK: Inline text editing

    private func editorFrame(for rect: CGRect) -> CGRect {
        let minSize = CGSize(width: 140, height: 34)
        var frame = rect.insetBy(dx: -6, dy: -6)
        frame.size.width = max(frame.width, minSize.width)
        frame.size.height = max(frame.height, minSize.height)
        return frame.intersection(bounds.insetBy(dx: 4, dy: 4)).isNull ? frame : frame.intersection(bounds.insetBy(dx: 4, dy: 4))
    }

    func beginInlineEdit(_ layerId: String) {
        guard editable, let layer = model.layers.first(where: { $0.layerId == layerId }), layer.kind == .text,
              let box = model.box(for: layerId) else { return }
        endInlineEdit(commit: false)
        let editor = InlineTextEditor(layerId: layerId, text: layer.text)
        editor.frame = editorFrame(for: geometry.viewRect(box))
        editor.textView.delegate = self
        addSubview(editor)
        inlineEditor = editor
        window?.makeFirstResponder(editor.textView)
        editor.textView.selectAll(nil)
    }

    func endInlineEdit(commit: Bool) {
        guard let editor = inlineEditor else { return }
        inlineEditor = nil
        let text = editor.textView.string
        editor.removeFromSuperview()
        if commit { model.setText(editor.layerId, text) }
        window?.makeFirstResponder(self)
    }

    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let flags = NSApp.currentEvent?.modifierFlags ?? []
            if flags.contains(.shift) || flags.contains(.option) {
                textView.insertNewlineIgnoringFieldEditor(nil)
            } else {
                endInlineEdit(commit: true)
            }
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            endInlineEdit(commit: false)
            return true
        }
        return false
    }

    func textDidEndEditing(_ notification: Notification) {
        if inlineEditor != nil { endInlineEdit(commit: true) }
    }

    // MARK: Drag and drop of pictures

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        draggingUpdated(sender)
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard editable, ImageImport.pasteboardHasImages(sender.draggingPasteboard) else { return [] }
        let point = geometry.artboardPoint(convert(sender.draggingLocation, from: nil))
        let target = model.dropTarget(at: point)
        if target != dropTargetId {
            dropTargetId = target
            refreshOverlay()
        }
        return target == nil ? [] : .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) {
        dropTargetId = nil
        refreshOverlay()
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        defer {
            dropTargetId = nil
            refreshOverlay()
        }
        guard let url = ImageImport.imageURLs(from: sender.draggingPasteboard).first else { return false }
        let point = geometry.artboardPoint(convert(sender.draggingLocation, from: nil))
        model.dropImage(url, at: point)
        return true
    }
}

/// A small editor laid over a text layer.
private final class InlineTextEditor: NSView {
    let layerId: String
    let textView = NSTextView()

    init(layerId: String, text: String) {
        self.layerId = layerId
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.96).cgColor
        layer?.borderColor = Theme.ink.withAlphaComponent(0.35).cgColor
        layer?.borderWidth = 1
        layer?.shadowOpacity = 0.25
        layer?.shadowRadius = 8

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.autoresizingMask = [.width, .height]
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        textView.textColor = NSColor(white: 0.08, alpha: 1)
        textView.insertionPointColor = NSColor(white: 0.08, alpha: 1)
        textView.string = text
        textView.textContainerInset = NSSize(width: 4, height: 6)
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityLabel("Katman metni")
        scroll.documentView = textView
        addSubview(scroll)
        scroll.frame = bounds
        toolTip = "↩ kaydet · ⇧↩ yeni satır · esc vazgeç"
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Right-click menu of a layer (canvas and layer list).
@MainActor
enum LayerMenu {
    static func make(for layer: SlideLayer, model: PostDetailModel, onEditText: @escaping () -> Void, onPickImage: @escaping () -> Void) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let blocker = model.editBlocker
        func add(_ title: String, enabled: Bool = true, _ action: @escaping () -> Void) {
            let item = ClosureMenuItem(title: title, action: action)
            item.isEnabled = enabled && blocker == nil
            if let blocker { item.toolTip = blocker }
            menu.addItem(item)
        }
        switch layer.kind {
        case .text:
            add("Metni düzenle", onEditText)
        case .slot:
            add(layer.slotState == .filled ? "Görseli değiştir…" : "Görsel ekle…", onPickImage)
            add("AI ile doldur…") { model.openAISlotGenerator(slotId: layer.layerId) }
            if layer.slotState == .filled { add("Yuvayı boşalt") { model.clearSlot(layer.layerId) } }
        case .image:
            add("Görseli değiştir…", onPickImage)
        default:
            break
        }
        if menu.items.count > 0 { menu.addItem(.separator()) }
        add(layer.isHidden ? "Göster" : "Gizle") { model.setHidden(layer.layerId, !layer.isHidden) }
        add("Konumu sıfırla", enabled: model.transform(of: layer.layerId) != .identity) { model.resetTransform(layer.layerId) }
        return menu
    }
}

/// Transparent top layer of the canvas that draws the editor chrome.
private final class CanvasOverlayView: NSView {
    var drawer: ((NSRect) -> Void)?
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) { drawer?(dirtyRect) }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
