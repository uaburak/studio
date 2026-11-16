import AppKit
import StudioKit

/// Small AppKit building blocks shared by the brand settings sheet, the new-brand
/// sheet and the first-run flow.
@MainActor
enum BrandUI {
    static func title(_ text: String, size: CGFloat = 15) -> NSTextField {
        NSTextField.styledLabel(text, font: NSFont.systemFont(ofSize: size, weight: .semibold), color: Theme.textPrimary)
    }

    static func caption(_ text: String) -> NSTextField {
        NSTextField.styledLabel(text, font: Theme.captionFont, color: Theme.textSecondary)
    }

    static func note(_ text: String = "") -> NSTextField {
        let label = NSTextField.styledLabel(text, font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    static func field(_ placeholder: String, text: String = "") -> NSTextField {
        let field = NSTextField(string: text)
        field.placeholderString = placeholder
        field.bezelStyle = .roundedBezel
        field.font = Theme.rowFont
        field.lineBreakMode = .byTruncatingTail
        field.usesSingleLineMode = true
        field.translatesAutoresizingMaskIntoConstraints = false
        return field
    }

    static func hstack(_ views: [NSView], spacing: CGFloat = 8, align: NSLayoutConstraint.Attribute = .centerY) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = align
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    static func vstack(_ views: [NSView] = [], spacing: CGFloat = 8) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    static func spacer() -> NSView {
        let view = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    /// Section heading with an optional right-aligned detail (counts, limits).
    static func sectionHeader(_ title: String, detail: String? = nil, accessory: NSView? = nil) -> NSStackView {
        var views: [NSView] = [NSTextField.styledLabel(title, font: NSFont.systemFont(ofSize: 13, weight: .semibold), color: Theme.textPrimary)]
        if let detail { views.append(NSTextField.styledLabel(detail, font: Theme.smallFont, color: Theme.textTertiary)) }
        views.append(spacer())
        if let accessory { views.append(accessory) }
        return hstack(views)
    }

    /// Vertical scroll view with a flipped document holding a stack (top-aligned content).
    static func scrollingStack(inset: CGFloat = 24, spacing: CGFloat = 22) -> (NSScrollView, NSStackView) {
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
        let stack = vstack(spacing: spacing)
        doc.addSubview(stack)
        NSLayoutConstraint.activate([
            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: inset),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -inset),
            stack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -24),
        ])
        return (scroll, stack)
    }

    /// Add a view to a vertical stack at full width.
    static func addFull(_ view: NSView, to stack: NSStackView) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    /// Bordered, rounded multi-line editor (plain text).
    static func textEditor(height: CGFloat, monospaced: Bool = false) -> (NSView, NSTextView) {
        let box = ThemedView()
        box.borderColor = Theme.border
        box.borderWidth = 1
        box.cornerRadius = 12
        box.translatesAutoresizingMaskIntoConstraints = false
        box.heightAnchor.constraint(equalToConstant: height).isActive = true
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.applyMinimalScroller()
        let textView = NSTextView()
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = monospaced ? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) : NSFont.systemFont(ofSize: 13)
        textView.textColor = Theme.textPrimary
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainerInset = NSSize(width: 2, height: 4)
        textView.textContainer?.widthTracksTextView = true
        scroll.documentView = textView
        box.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 8),
            scroll.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -6),
            scroll.topAnchor.constraint(equalTo: box.topAnchor, constant: 6),
            scroll.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -6),
        ])
        return (box, textView)
    }

    /// Rounded card with a neutral fill.
    static func card(spacing: CGFloat = 10, padding: CGFloat = 14) -> (ThemedView, NSStackView) {
        let card = ThemedView()
        card.backgroundColor = Theme.fill
        card.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        let stack = vstack(spacing: spacing)
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: padding),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -padding),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: padding),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -padding),
        ])
        return (card, stack)
    }

    /// Status line: a dot and a label.
    static func status(_ text: String, color: NSColor) -> NSStackView {
        let dot = StatusDotView(color: color, size: 7)
        let label = NSTextField.styledLabel(text, font: Theme.smallFont, color: Theme.textSecondary)
        return hstack([dot, label], spacing: 6)
    }

    static func color(hex: String) -> NSColor? {
        guard let normalized = BrandKitRules.normalizedHex(hex), let value = UInt32(normalized.dropFirst(), radix: 16) else { return nil }
        return NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }

    static func hex(of color: NSColor) -> String {
        let rgb = color.usingColorSpace(.sRGB) ?? color
        let r = Int((rgb.redComponent * 255).rounded()), g = Int((rgb.greenComponent * 255).rounded()), b = Int((rgb.blueComponent * 255).rounded())
        return String(format: "#%02X%02X%02X", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    }

    /// Ask before something consequential; returns true for the first button.
    @MainActor
    static func confirm(in window: NSWindow?, title: String, message: String, confirm: String, cancel: String = "Vazgeç", completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: confirm)
        alert.addButton(withTitle: cancel)
        alert.buttons.last?.keyEquivalent = "\u{1b}"
        if let window {
            alert.beginSheetModal(for: window) { completion($0 == .alertFirstButtonReturn) }
        } else {
            completion(alert.runModal() == .alertFirstButtonReturn)
        }
    }
}

/// Closure-based delegate for text fields built in code (rows rebuilt from data).
final class FieldHandler: NSObject, NSTextFieldDelegate {
    var onChange: ((String) -> Void)?
    var onCommit: ((String) -> Void)?
    var onReturn: (() -> Void)?

    init(onChange: ((String) -> Void)? = nil, onCommit: ((String) -> Void)? = nil, onReturn: (() -> Void)? = nil) {
        self.onChange = onChange
        self.onCommit = onCommit
        self.onReturn = onReturn
    }

    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? NSTextField else { return }
        onChange?(field.stringValue)
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard let field = obj.object as? NSTextField else { return }
        onCommit?(field.stringValue)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)), let onReturn {
            onReturn()
            return true
        }
        return false
    }
}

/// Closure-based delegate for `NSTextView`.
final class TextViewHandler: NSObject, NSTextViewDelegate {
    var onChange: (String) -> Void

    init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
    }

    func textDidChange(_ notification: Notification) {
        guard let view = notification.object as? NSTextView else { return }
        onChange(view.string)
    }
}

/// `NSPopUpButton` that calls a closure with the chosen item's represented object.
final class ClosurePopUp: NSPopUpButton {
    var onPick: ((Any?) -> Void)?

    init(items: [(title: String, value: Any)], selected: (Any) -> Bool, onPick: @escaping (Any?) -> Void) {
        self.onPick = onPick
        super.init(frame: .zero, pullsDown: false)
        translatesAutoresizingMaskIntoConstraints = false
        controlSize = .regular
        for item in items {
            addItem(withTitle: item.title)
            lastItem?.representedObject = item.value
            if selected(item.value) { select(lastItem) }
        }
        target = self
        action = #selector(picked)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func picked() {
        onPick?(selectedItem?.representedObject)
    }
}

/// `NSColorWell` that reports picked colours through a closure.
final class ClosureColorWell: NSColorWell {
    var onPick: ((NSColor) -> Void)?

    convenience init(color: NSColor, onPick: @escaping (NSColor) -> Void) {
        self.init(style: .minimal)
        self.color = color
        self.onPick = onPick
        translatesAutoresizingMaskIntoConstraints = false
        target = self
        action = #selector(picked)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 38),
            heightAnchor.constraint(equalToConstant: 24),
        ])
    }

    @objc private func picked() {
        onPick?(color)
    }
}
