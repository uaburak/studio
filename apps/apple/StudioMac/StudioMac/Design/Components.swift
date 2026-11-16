import AppKit
import StudioKit

// MARK: - Layer-backed base view with live appearance updates

class ThemedView: NSView {
    var backgroundColor: NSColor? {
        didSet { needsDisplay = true }
    }
    var borderColor: NSColor? {
        didSet { needsDisplay = true }
    }
    var borderWidth: CGFloat = 0 {
        didSet { needsDisplay = true }
    }
    var cornerRadius: CGFloat = 0 {
        didSet {
            layer?.cornerRadius = cornerRadius
            layer?.cornerCurve = .continuous
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerCurve = .continuous
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        guard let layer else { return }
        layer.cornerRadius = cornerRadius
        layer.cornerCurve = .continuous
        layer.backgroundColor = backgroundColor.map { resolvedCGColor($0) }
        layer.borderColor = borderColor.map { resolvedCGColor($0) }
        layer.borderWidth = borderWidth
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

// MARK: - Liquid Glass wrappers

/// Wraps `NSGlassEffectView` (macOS 26+) with Studio's floating tint and live appearance updates.
final class GlassContainerView: NSView {
    let glassView = NSGlassEffectView()
    let contentContainer = NSView()
    /// Border drawn over the glass when "Increase contrast" is on (never hit-tested).
    private let contrastBorder = PassthroughBorderView()

    var cornerRadius: CGFloat {
        get { glassView.cornerRadius }
        set {
            glassView.cornerRadius = newValue
            contrastBorder.cornerRadius = newValue
        }
    }

    var tint: NSColor? = Theme.floatingGlassTint {
        didSet { applyTint() }
    }

    init(cornerRadius: CGFloat = 23, interactive: Bool = false, tint: NSColor? = Theme.floatingGlassTint) {
        self.tint = tint
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        glassView.translatesAutoresizingMaskIntoConstraints = false
        glassView.style = .regular
        glassView.cornerRadius = cornerRadius
        if #available(macOS 27.0, *) {
            glassView.effectIsInteractive = interactive
        }
        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        glassView.contentView = contentContainer

        addSubview(glassView)
        contrastBorder.translatesAutoresizingMaskIntoConstraints = false
        contrastBorder.cornerRadius = cornerRadius
        contrastBorder.borderColor = Theme.border
        contrastBorder.borderWidth = 1
        addSubview(contrastBorder)
        NSLayoutConstraint.activate([
            glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
            glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
            glassView.topAnchor.constraint(equalTo: topAnchor),
            glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
            contrastBorder.leadingAnchor.constraint(equalTo: leadingAnchor),
            contrastBorder.trailingAnchor.constraint(equalTo: trailingAnchor),
            contrastBorder.topAnchor.constraint(equalTo: topAnchor),
            contrastBorder.bottomAnchor.constraint(equalTo: bottomAnchor),
            contentContainer.leadingAnchor.constraint(equalTo: glassView.leadingAnchor),
            contentContainer.trailingAnchor.constraint(equalTo: glassView.trailingAnchor),
            contentContainer.topAnchor.constraint(equalTo: glassView.topAnchor),
            contentContainer.bottomAnchor.constraint(equalTo: glassView.bottomAnchor),
        ])
        applyTint()
        // Selector-based: removed automatically when the view goes away.
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(displayOptionsChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil
        )
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func displayOptionsChanged() { applyTint() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyTint()
    }

    /// The tint, made opaque when the system asks to reduce transparency.
    static func effectiveTint(_ tint: NSColor?, reduceTransparency: Bool, fallback: NSColor = Theme.canvas) -> NSColor? {
        guard reduceTransparency else { return tint }
        return (tint ?? fallback).withAlphaComponent(1)
    }

    private func applyTint() {
        contrastBorder.isHidden = !Theme.increaseContrast
        guard let effective = Self.effectiveTint(tint, reduceTransparency: Theme.reduceTransparency) else {
            glassView.tintColor = nil
            return
        }
        var resolved = effective
        effectiveAppearance.performAsCurrentDrawingAppearance {
            resolved = effective.usingColorSpace(.sRGB) ?? effective
        }
        glassView.tintColor = resolved
    }
}

/// A border-only overlay that never takes mouse events.
private final class PassthroughBorderView: ThemedView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Wraps `NSGlassEffectContainerView` so nearby `NSGlassEffectView` descendants merge smoothly.
final class GlassMergeContainerView: NSView {
    let containerView = NSGlassEffectContainerView()
    let contentContainer = NSView()

    init(spacing: CGFloat = 10) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        containerView.translatesAutoresizingMaskIntoConstraints = false
        containerView.spacing = spacing
        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        containerView.contentView = contentContainer
        addSubview(containerView)
        NSLayoutConstraint.activate([
            containerView.leadingAnchor.constraint(equalTo: leadingAnchor),
            containerView.trailingAnchor.constraint(equalTo: trailingAnchor),
            containerView.topAnchor.constraint(equalTo: topAnchor),
            containerView.bottomAnchor.constraint(equalTo: bottomAnchor),
            contentContainer.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
            contentContainer.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
            contentContainer.topAnchor.constraint(equalTo: containerView.topAnchor),
            contentContainer.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - PillButton

/// Studio's capsule button: orange primary (`#FF6A00`), neutral secondary (`Theme.fill`), or outlined suggestion pill.
final class PillButton: NSControl {
    enum Kind {
        case primary
        case secondary
        case outline
        case ink
    }

    var kind: Kind {
        didSet { refreshStyle() }
    }

    var title: String {
        didSet {
            label.stringValue = title
            setAccessibilityLabel(title)
            invalidateIntrinsicContentSize()
        }
    }

    var buttonHeight: CGFloat {
        didSet {
            heightConstraint.constant = buttonHeight
            layer?.cornerRadius = buttonHeight / 2
            invalidateIntrinsicContentSize()
        }
    }

    var showsSpinner: Bool = false {
        didSet {
            spinner.isHidden = !showsSpinner
            if showsSpinner { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
            invalidateIntrinsicContentSize()
        }
    }

    var onAction: (() -> Void)?

    override var isEnabled: Bool {
        didSet {
            alphaValue = isEnabled ? 1.0 : 0.45
            refreshStyle()
        }
    }

    private let label = NSTextField(labelWithString: "")
    private let spinner = NSProgressIndicator()
    private let stack = NSStackView()
    private var heightConstraint: NSLayoutConstraint!
    private var hovering = false { didSet { refreshStyle() } }
    private var pressed = false { didSet { refreshStyle() } }
    private var trackingArea: NSTrackingArea?

    init(title: String, kind: Kind = .secondary, height: CGFloat = 26, action: (() -> Void)? = nil) {
        self.title = title
        self.kind = kind
        self.buttonHeight = height
        self.onAction = action
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = height / 2
        layer?.cornerCurve = .continuous

        spinner.style = .spinning
        spinner.controlSize = .mini
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 12),
            spinner.heightAnchor.constraint(equalToConstant: 12),
        ])

        label.stringValue = title
        label.font = Theme.buttonFont
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .horizontal)

        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(spinner)
        stack.addArrangedSubview(label)
        addSubview(stack)

        heightConstraint = heightAnchor.constraint(equalToConstant: height)
        NSLayoutConstraint.activate([
            heightConstraint,
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 13),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -13),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
        refreshStyle()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false; pressed = false }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        pressed = true
        window?.trackEvents(matching: [.leftMouseDragged, .leftMouseUp], timeout: NSEvent.foreverDuration, mode: .eventTracking) { [weak self] next, stop in
            guard let self, let next else { stop.pointee = true; return }
            let inside = self.bounds.contains(self.convert(next.locationInWindow, from: nil))
            self.pressed = inside
            if next.type == .leftMouseUp {
                self.pressed = false
                stop.pointee = true
                if inside { self.fire() }
            }
        }
    }

    private func fire() {
        if let action { NSApp.sendAction(action, to: target, from: self) }
        onAction?()
    }

    // Keyboard navigation (Full Keyboard Access) and VoiceOver press.
    override var acceptsFirstResponder: Bool { KeyboardFocus.accepts(isEnabled: isEnabled) }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
    }
    override func keyDown(with event: NSEvent) {
        if isEnabled, KeyboardFocus.isActivation(event) { fire() } else { super.keyDown(with: event) }
    }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        fire()
        return true
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard isEnabled, !isHiddenOrHasHiddenAncestor else { return false }
        return super.performKeyEquivalent(with: event)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshStyle()
    }

    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }

    private func refreshStyle() {
        guard let layer else { return }
        let fill: NSColor
        let text: NSColor
        var stroke: NSColor? = nil
        switch kind {
        case .primary:
            fill = Theme.accent
            text = Theme.onAccent
            spinner.appearance = NSAppearance(named: .darkAqua)
        case .secondary:
            fill = (hovering && isEnabled) ? Theme.fillStrong : Theme.fill
            text = Theme.textPrimary
            spinner.appearance = nil
        case .outline:
            fill = (hovering && isEnabled) ? Theme.fill : Theme.canvas
            text = Theme.textPrimary
            stroke = Theme.border
            spinner.appearance = nil
        case .ink:
            fill = Theme.ink
            text = Theme.canvas
            spinner.appearance = nil
        }
        label.textColor = text
        layer.backgroundColor = resolvedCGColor(fill)
        layer.borderColor = stroke.map { resolvedCGColor($0) }
        layer.borderWidth = stroke == nil ? 0 : 1
        alphaValue = isEnabled ? (pressed ? 0.75 : 1.0) : 0.45
    }
}

// MARK: - GlyphButton

/// 26x26 circular hoverable icon button with an SF Symbol `NSImage`.
final class GlyphButton: NSControl {
    var symbolName: String {
        didSet {
            updateImage()
            if labelIsAutomatic && (toolTip ?? "").isEmpty { setAutomaticLabel(Self.defaultLabel(for: symbolName)) }
        }
    }
    /// VoiceOver label: set explicitly, else from the tooltip, else from the symbol.
    private var labelIsAutomatic = true
    override var toolTip: String? {
        didSet {
            guard labelIsAutomatic else { return }
            if let tip = toolTip, !tip.isEmpty {
                setAutomaticLabel(Self.spokenLabel(fromToolTip: tip))
            } else {
                setAutomaticLabel(Self.defaultLabel(for: symbolName))
            }
        }
    }
    var pointSize: CGFloat {
        didSet { updateImage() }
    }
    var symbolWeight: NSFont.Weight {
        didSet { updateImage() }
    }
    var showsSpinner: Bool = false {
        didSet {
            spinner.isHidden = !showsSpinner
            imageView.isHidden = showsSpinner
            if showsSpinner { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        }
    }
    var onAction: (() -> Void)?

    override var isEnabled: Bool {
        didSet {
            alphaValue = isEnabled ? 1.0 : 0.4
            refreshStyle()
        }
    }

    private let imageView = NSImageView()
    private let spinner = NSProgressIndicator()
    private var hovering = false { didSet { refreshStyle() } }
    private var pressed = false { didSet { refreshStyle() } }
    private var trackingArea: NSTrackingArea?

    init(symbol: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, diameter: CGFloat = 26, action: (() -> Void)? = nil) {
        self.symbolName = symbol
        self.pointSize = size
        self.symbolWeight = weight
        self.onAction = action
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = diameter / 2

        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentTintColor = Theme.textSecondary
        addSubview(imageView)

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(spinner)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: diameter),
            heightAnchor.constraint(equalToConstant: diameter),
            imageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: centerYAnchor),
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
            spinner.widthAnchor.constraint(equalToConstant: 14),
            spinner.heightAnchor.constraint(equalToConstant: 14),
        ])

        setAccessibilityRole(.button)
        setAutomaticLabel(Self.defaultLabel(for: symbol))
        updateImage()
        refreshStyle()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func setAccessibilityLabel(_ accessibilityLabel: String?) {
        labelIsAutomatic = false
        super.setAccessibilityLabel(accessibilityLabel)
    }

    private func setAutomaticLabel(_ label: String?) {
        super.setAccessibilityLabel(label)
    }

    /// "Ayarlar (⌘,)" -> "Ayarlar": the shortcut in parentheses is not spoken.
    static func spokenLabel(fromToolTip tip: String) -> String {
        var text = tip
        if let open = text.lastIndex(of: "("), text.hasSuffix(")") {
            let inner = text[text.index(after: open)..<text.index(before: text.endIndex)]
            if inner.contains(where: { "⌘⇧⌥⌃↩⎋⌫".contains($0) }) {
                text = String(text[..<open])
            }
        }
        return text.trimmingCharacters(in: .whitespaces)
    }

    /// A Turkish fallback name for the SF Symbols used by icon-only buttons.
    static func defaultLabel(for symbol: String) -> String? {
        switch symbol {
        case "xmark", "xmark.circle", "xmark.circle.fill": "Kapat"
        case "plus", "plus.circle": "Ekle"
        case "minus", "minus.circle": "Kaldır"
        case "chevron.left": "Önceki"
        case "chevron.right": "Sonraki"
        case "gearshape": "Ayarlar"
        case "ellipsis", "ellipsis.circle": "Diğer seçenekler"
        case "mic", "mic.fill": "Dikte"
        case "return", "arrow.up", "arrow.up.circle.fill": "Gönder"
        case "stop.fill", "stop.circle.fill": "Durdur"
        case "arrow.clockwise": "Yeniden dene"
        case "square.and.arrow.up": "Dışa aktar"
        case "eye": "Gizle"
        case "eye.slash": "Göster"
        case "play.fill": "Oynat"
        case "pause.fill": "Duraklat"
        case "magnifyingglass": "Ara"
        case "trash": "Sil"
        default: nil
        }
    }

    private func fire() {
        if let action { NSApp.sendAction(action, to: target, from: self) }
        onAction?()
    }

    // Keyboard navigation (Full Keyboard Access) and VoiceOver press.
    override var acceptsFirstResponder: Bool { KeyboardFocus.accepts(isEnabled: isEnabled) }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(ovalIn: bounds).fill() }
    override func keyDown(with event: NSEvent) {
        if isEnabled, KeyboardFocus.isActivation(event) { fire() } else { super.keyDown(with: event) }
    }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        fire()
        return true
    }

    private func updateImage() {
        let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: symbolWeight)
        imageView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?.withSymbolConfiguration(config)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false; pressed = false }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        pressed = true
        window?.trackEvents(matching: [.leftMouseDragged, .leftMouseUp], timeout: NSEvent.foreverDuration, mode: .eventTracking) { [weak self] next, stop in
            guard let self, let next else { stop.pointee = true; return }
            let inside = self.bounds.contains(self.convert(next.locationInWindow, from: nil))
            self.pressed = inside
            if next.type == .leftMouseUp {
                self.pressed = false
                stop.pointee = true
                if inside { self.fire() }
            }
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshStyle()
    }

    private func refreshStyle() {
        imageView.contentTintColor = Theme.textSecondary
        let active = isEnabled && (hovering || pressed)
        layer?.backgroundColor = active ? resolvedCGColor(Theme.fill) : nil
    }
}

// MARK: - StatusDotView & PostStateLabelView & HairlineView & CardContainerView

final class StatusDotView: ThemedView {
    private var widthConstraint: NSLayoutConstraint!
    private var heightConstraint: NSLayoutConstraint!

    var color: NSColor {
        get { backgroundColor ?? Theme.accent }
        set { backgroundColor = newValue }
    }

    var dotSize: CGFloat {
        didSet {
            widthConstraint.constant = dotSize
            heightConstraint.constant = dotSize
            cornerRadius = dotSize / 2
        }
    }

    init(color: NSColor = Theme.accent, size: CGFloat = 6) {
        self.dotSize = size
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = color
        cornerRadius = size / 2
        widthConstraint = widthAnchor.constraint(equalToConstant: size)
        heightConstraint = heightAnchor.constraint(equalToConstant: size)
        NSLayoutConstraint.activate([widthConstraint, heightConstraint])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

final class PostStateLabelView: NSView {
    private let dot = StatusDotView()
    private let label = NSTextField(labelWithString: "")

    var state: PostState {
        didSet { apply() }
    }

    init(state: PostState) {
        self.state = state
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        label.font = Theme.smallFont
        label.textColor = Theme.textSecondary
        label.setContentCompressionResistancePriority(.required, for: .horizontal)

        let stack = NSStackView(views: [dot, label])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        apply()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func apply() {
        dot.color = state.tone.nsColor
        label.stringValue = state.label
    }
}

final class HairlineView: ThemedView {
    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.hairline
        heightAnchor.constraint(equalToConstant: 1).isActive = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Rounded 20pt card with `Theme.canvas` fill and 1pt `Theme.border` stroke.
final class CardContainerView: ThemedView {
    let contentStack = NSStackView()

    init(padding: CGFloat = 18, spacing: CGFloat = 10) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.canvas
        borderColor = Theme.border
        borderWidth = 1
        cornerRadius = Theme.cardRadius

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = spacing
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: padding),
            contentStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -padding),
            contentStack.topAnchor.constraint(equalTo: topAnchor, constant: padding),
            contentStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -padding),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - Keyboard focus for custom controls

enum KeyboardFocus {
    /// Custom buttons join the key-view loop like `NSButton`: only with Full Keyboard Access,
    /// and never by a mouse click (a click must not steal the composer's focus).
    @MainActor static func accepts(isEnabled: Bool) -> Bool {
        guard isEnabled, NSApp?.isFullKeyboardAccessEnabled == true else { return false }
        let type = NSApp?.currentEvent?.type
        return type != .leftMouseDown && type != .rightMouseDown
    }

    /// Space or Return presses a focused control.
    static func isActivation(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.subtracting([.numericPad, .function]).isEmpty else { return false }
        return event.keyCode == 49 || event.keyCode == 36 || event.keyCode == 76
    }
}

// MARK: - TapControl

/// Base for text-like clickable controls (links, "Tümünü göster", clickable rows):
/// a VoiceOver button that presses like a click, joins the key-view loop with Full
/// Keyboard Access and activates with space / return. Subclasses override `performTap()`.
class TapControl: NSControl {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func performTap() {}

    override var acceptsFirstResponder: Bool { KeyboardFocus.accepts(isEnabled: isEnabled) }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }
    override func keyDown(with event: NSEvent) {
        if isEnabled, KeyboardFocus.isActivation(event) { performTap() } else { super.keyDown(with: event) }
    }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        performTap()
        return true
    }
}

// MARK: - InlineErrorBannerView

/// One action on a banner ("Yeniden dene", "Ayarlar…").
struct BannerAction {
    var title: String
    var primary: Bool = false
    var handler: () -> Void
}

/// Rounded neutral banner for inline errors: message, optional actions (retry) and dismiss.
/// The one error presentation used across the app; VoiceOver announces new messages.
final class InlineErrorBannerView: ThemedView {
    private let textField = NSTextField(wrappingLabelWithString: "")
    private let dismissButton = GlyphButton(symbol: "xmark", size: 9, weight: .semibold, diameter: 22)
    private let actionsStack = NSStackView()
    private let icon = NSImageView()
    private let spinner = NSProgressIndicator()
    var onDismiss: (() -> Void)? {
        didSet {
            dismissButton.isHidden = onDismiss == nil
            dismissButton.onAction = onDismiss
        }
    }

    /// Shows a "Yeniden dene" pill (nil hides it). Replaces `actions`.
    var onRetry: (() -> Void)? {
        didSet { actions = onRetry.map { [BannerAction(title: "Yeniden dene", handler: $0)] } ?? [] }
    }

    var actions: [BannerAction] = [] {
        didSet { rebuildActions() }
    }

    /// A spinner instead of the warning icon (e.g. "Mac sunucusu başlatılıyor…").
    var isBusy = false {
        didSet {
            icon.isHidden = isBusy
            spinner.isHidden = !isBusy
            if isBusy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        }
    }

    var message: String = "" {
        didSet {
            textField.stringValue = message
            setAccessibilityLabel(message)
            if message != oldValue, !message.isEmpty {
                NSAccessibility.post(
                    element: NSApp as Any, notification: .announcementRequested,
                    userInfo: [.announcement: message, .priority: NSAccessibilityPriorityLevel.high.rawValue]
                )
            }
        }
    }

    init(message: String = "", onDismiss: (() -> Void)? = nil) {
        self.message = message
        self.onDismiss = onDismiss
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.fill
        cornerRadius = Theme.bannerRadius
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(message)

        let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
        icon.image = NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: nil)?.withSymbolConfiguration(config)
        icon.contentTintColor = Theme.textSecondary
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.setContentHuggingPriority(.required, for: .horizontal)

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([spinner.widthAnchor.constraint(equalToConstant: 14), spinner.heightAnchor.constraint(equalToConstant: 14)])

        textField.stringValue = message
        textField.font = Theme.captionFont
        textField.textColor = Theme.textPrimary
        textField.isSelectable = true
        textField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        dismissButton.isHidden = onDismiss == nil
        dismissButton.onAction = onDismiss
        dismissButton.setAccessibilityLabel("Kapat")
        dismissButton.toolTip = "Kapat"

        actionsStack.orientation = .horizontal
        actionsStack.alignment = .centerY
        actionsStack.spacing = Theme.Spacing.xs
        actionsStack.setContentHuggingPriority(.required, for: .horizontal)
        actionsStack.isHidden = true

        let row = NSStackView(views: [icon, spinner, textField, actionsStack, dismissButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Titles of the action pills shown now (tests).
    var actionTitles: [String] { actions.map(\.title) }

    private func rebuildActions() {
        actionsStack.arrangedSubviews.forEach {
            actionsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for action in actions {
            let handler = action.handler
            let button = PillButton(title: action.title, kind: action.primary ? .primary : .secondary, height: 22) { handler() }
            actionsStack.addArrangedSubview(button)
        }
        actionsStack.isHidden = actions.isEmpty
    }
}

// MARK: - MacStatusControlView

/// Shows `● Mac hazır` / `Mac çevrimdışı` plus AI provider readiness hint for the selected model.
final class MacStatusControlView: NSView {
    private let dot = StatusDotView()
    private let label = NSTextField(labelWithString: "")
    private weak var app: AppModel?
    private var selectedModelProvider: (@MainActor () -> AgentModel)?
    private var observation: ObservationToken?

    init(app: AppModel, selectedModel: (@escaping @MainActor () -> AgentModel) = { .fallbackModel }) {
        self.app = app
        self.selectedModelProvider = selectedModel
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        label.font = Theme.smallFont
        label.textColor = Theme.textSecondary
        label.lineBreakMode = .byTruncatingTail

        let row = NSStackView(views: [dot, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        observation = observe { [weak self] in
            self?.refresh()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func refresh(presenceOverride: WorkerPresence? = nil) {
        guard let app else { return }
        let presence = presenceOverride ?? app.presence
        let online = presence?.online == true
        dot.color = online ? Theme.accent : Theme.textTertiary

        var parts = [online ? "Mac hazır" : "Mac çevrimdışı"]
        let chosen = selectedModelProvider?() ?? app.lastAgentChoice.model
        if online {
            if chosen.isGemini {
                if let gemini = presence?.gemini {
                    switch gemini.status {
                    case .ready: parts.append("Gemini hazır")
                    case .notConfigured: parts.append("Gemini yapılandırılmadı")
                    case .error, .unknown: parts.append("Gemini hatası")
                    }
                }
            } else {
                if let claude = presence?.claude {
                    switch claude.status {
                    case .signedIn: break
                    case .signingIn: parts.append("Claude giriş bekleniyor")
                    case .signedOut: parts.append("Claude giriş bekliyor")
                    case .notInstalled: parts.append("Claude kurulu değil")
                    case .error, .unknown: break
                    }
                }
            }
        }
        label.stringValue = parts.joined(separator: " · ")
        toolTip = online
            ? "Mac worker bağlı; işler hemen çalışır."
            : "Mac worker bağlı değil; işler sırada bekler."
    }
}

private extension AgentModel {
    static var fallbackModel: AgentModel { AgentChoice.fallback.model }
}

// MARK: - FlowLayoutView

/// Wrapping row layout for option pills in pure AppKit.
final class FlowLayoutView: NSView {
    var spacing: CGFloat = 8 {
        didSet { needsLayout = true; invalidateIntrinsicContentSize() }
    }

    override var isFlipped: Bool { true }

    private var lastWidth: CGFloat = 0

    func setItems(_ views: [NSView]) {
        subviews.forEach { $0.removeFromSuperview() }
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = true
            addSubview(view)
        }
        needsLayout = true
        invalidateIntrinsicContentSize()
    }

    override func layout() {
        super.layout()
        _ = arrange(in: bounds.width, place: true)
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        let targetWidth = bounds.width > 10 ? bounds.width : 540
        let size = arrange(in: targetWidth, place: false)
        return NSSize(width: NSView.noIntrinsicMetric, height: size.height)
    }

    private func arrange(in availableWidth: CGFloat, place: Bool) -> NSSize {
        let maxWidth = availableWidth > 1 ? availableWidth : 540
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for view in subviews where !view.isHidden {
            let size = view.fittingSize
            if x > 0 && x + size.width > maxWidth {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            if place {
                view.frame = NSRect(origin: NSPoint(x: x, y: y), size: size)
            }
            x += size.width + spacing
            usedWidth = max(usedWidth, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return NSSize(width: usedWidth, height: y + lineHeight)
    }
}

// MARK: - SectionTitleLabel & Text Factory

extension NSTextField {
    static func sectionTitle(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = Theme.smallFont
        field.textColor = Theme.textSecondary
        return field
    }

    static func styledLabel(_ text: String, font: NSFont = Theme.rowFont, color: NSColor = Theme.textPrimary, wraps: Bool = false) -> NSTextField {
        let field = wraps ? NSTextField(wrappingLabelWithString: text) : NSTextField(labelWithString: text)
        field.font = font
        field.textColor = color
        if !wraps {
            field.lineBreakMode = .byTruncatingTail
        }
        return field
    }
}
