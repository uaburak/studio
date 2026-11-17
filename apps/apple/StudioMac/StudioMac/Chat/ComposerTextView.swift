import AppKit
import StudioKit

/// Pure AppKit text editor for the message composer (TextKit 1 `NSTextView` inside an auto-sizing `NSScrollView`):
/// - sends on Return, inserts a newline on Shift+Return,
/// - turns `@alias` into a neutral pill token (`MentionAttachment`) that moves/deletes as one character,
/// - drives `@` autocomplete (arrows, Return/Tab to pick, Escape to close),
/// - routes pasted images to the attachment strip instead of the text.
@MainActor
final class ComposerEditor: NSObject, NSTextViewDelegate, ComposerTextBridge {
    let model: ComposerModel
    let scrollView: ComposerScrollView
    let textView: ComposerNSTextView
    var onSubmit: () -> Void
    var onImages: ([ImportedImage], [String]) -> Void

    private var isConverting = false
    private var observation: ObservationToken?

    init(
        model: ComposerModel,
        onSubmit: @escaping () -> Void = {},
        onImages: @escaping ([ImportedImage], [String]) -> Void = { _, _ in }
    ) {
        self.model = model
        self.onSubmit = onSubmit
        self.onImages = onImages
        self.textView = ComposerNSTextView(usingTextLayoutManager: false)
        self.scrollView = ComposerScrollView(textView: textView)
        super.init()

        textView.editor = self
        textView.delegate = self
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.drawsBackground = false
        textView.font = ComposerNSTextView.font
        textView.textColor = .labelColor
        textView.typingAttributes = ComposerNSTextView.baseAttributes
        textView.textContainerInset = NSSize(width: 0, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.setAccessibilityLabel("Mesaj")
        // Images go to the attachment row (handled by the AppKit drop target), never into the text.
        textView.unregisterDraggedTypes()

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.documentView = textView
        scrollView.applyMinimalScroller()

        model.bridge = self
        textView.placeholder = model.placeholder
        if !model.text.isEmpty {
            setText(model.text)
        }

        observation = observe { [weak self] in
            guard let self else { return }
            let placeholder = self.model.placeholder
            if self.textView.placeholder != placeholder {
                self.textView.placeholder = placeholder
                self.textView.needsDisplay = true
            }
        }
    }

    // MARK: Bridge

    /// `start` is an offset in the exported text (where an earlier token reads as `@image-1`),
    /// converted back to the text storage, where each token is one character.
    func insertMention(_ alias: String, replacingQueryStartingAt start: Int) {
        guard let storage = textView.textStorage else { return }
        let caret = min(textView.selectedRange().location, storage.length)
        let location = min(storageOffset(forExported: start), caret)
        let range = NSRange(location: location, length: caret - location)
        let token = MentionAttachment.string(alias: alias)
        let insertion = NSMutableAttributedString(attributedString: token)
        insertion.append(NSAttributedString(string: " ", attributes: ComposerNSTextView.baseAttributes))
        if textView.shouldChangeText(in: range, replacementString: insertion.string) {
            storage.replaceCharacters(in: range, with: insertion)
            textView.didChangeText()
        }
        textView.setSelectedRange(NSRange(location: range.location + insertion.length, length: 0))
        push()
    }

    func clear() {
        textView.string = ""
        textView.typingAttributes = ComposerNSTextView.baseAttributes
        forgetUndo()
        push()
    }

    /// Programmatic edits (sent, replaced, tokens converted) invalidate the typing undo steps:
    /// undoing a range that no longer exists would raise.
    private func forgetUndo() {
        textView.undoManager?.removeAllActions(withTarget: textView)
        if let storage = textView.textStorage { textView.undoManager?.removeAllActions(withTarget: storage) }
    }

    func focus() {
        textView.window?.makeFirstResponder(textView)
    }

    func setText(_ text: String) {
        guard let storage = textView.textStorage else { return }
        storage.setAttributedString(NSAttributedString(string: text, attributes: ComposerNSTextView.baseAttributes))
        textView.setSelectedRange(NSRange(location: storage.length, length: 0))
        convertTypedMentions(force: true)
        forgetUndo()
        push()
    }

    // MARK: Delegate

    func textDidChange(_ notification: Notification) {
        convertTypedMentions(force: false)
        push()
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        model.caret = exportedOffset(for: textView.selectedRange().location)
    }

    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if model.isSuggesting {
            switch selector {
            case #selector(NSResponder.moveUp(_:)): model.moveSuggestion(-1); return true
            case #selector(NSResponder.moveDown(_:)): model.moveSuggestion(1); return true
            case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertTab(_:)): model.choose(); return true
            case #selector(NSResponder.cancelOperation(_:)): model.dismissSuggestions(); return true
            default: break
            }
        }
        if selector == #selector(NSResponder.insertNewline(_:)) {
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                textView.insertNewlineIgnoringFieldEditor(nil)
            } else {
                onSubmit()
            }
            return true
        }
        return false
    }

    // MARK: Paste

    func handlePaste(_ pasteboard: NSPasteboard) -> Bool {
        guard ImageImport.pasteboardHasImages(pasteboard) else { return false }
        let (images, errors) = ImageImport.images(from: pasteboard)
        onImages(images, errors)
        return true
    }

    // MARK: Text <-> model

    /// Plain text with tokens exported as `@alias`.
    func exportedText() -> String {
        guard let storage = textView.textStorage else { return "" }
        var out = ""
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if let mention = value as? MentionAttachment {
                out += "@" + mention.alias
            } else {
                out += (storage.string as NSString).substring(with: range)
            }
        }
        return out
    }

    /// The text storage offset of an offset in the exported text (inverse of `exportedOffset`;
    /// an offset inside a token's `@alias` maps to the token's start).
    func storageOffset(forExported exported: Int) -> Int {
        guard let storage = textView.textStorage else { return exported }
        var remaining = max(0, exported)
        var location = 0
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
            if let mention = value as? MentionAttachment {
                let length = mention.alias.utf16.count + 1
                if remaining < length {
                    location = range.location
                    remaining = 0
                    stop.pointee = true
                    return
                }
                remaining -= length
            } else if remaining <= range.length {
                location = range.location + remaining
                remaining = 0
                stop.pointee = true
                return
            } else {
                remaining -= range.length
            }
            location = range.location + range.length
        }
        return min(location, storage.length)
    }

    /// Caret offset in the exported text (tokens are longer there than the 1-char attachment).
    func exportedOffset(for location: Int) -> Int {
        guard let storage = textView.textStorage else { return location }
        var extra = 0
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: min(location, storage.length))) { value, range, _ in
            if let mention = value as? MentionAttachment { extra += mention.alias.utf16.count + 1 - range.length }
        }
        return location + extra
    }

    private func push() {
        let text = exportedText()
        if model.text != text { model.text = text }
        model.caret = exportedOffset(for: textView.selectedRange().location)
        textView.needsDisplay = true
        scrollView.invalidateIntrinsicContentSize()
    }

    /// `@image-1` typed by hand becomes a token once it is complete (followed by a non-name character),
    /// or everywhere when `force` (after a programmatic `setText`).
    private func convertTypedMentions(force: Bool) {
        guard !isConverting, let storage = textView.textStorage else { return }
        isConverting = true
        defer { isConverting = false }
        let known = model.knownNames
        guard !known.isEmpty else { return }
        let string = storage.string
        let units = (string as NSString).length
        let caret = textView.selectedRange().location
        let tokens = MentionText.scanTokens(string).filter { known.contains($0.alias) }
        let utf16 = Array(string.utf16)
        var shift = 0
        var newCaret = caret
        for token in tokens {
            var rawEnd = token.end
            while rawEnd < units && MentionText.isNameChar(utf16[rawEnd]) { rawEnd += 1 }
            let caretInside = caret > token.start && caret <= rawEnd
            let closed = rawEnd < units
            guard force || (!caretInside && (rawEnd < caret || closed)) else { continue }
            let range = NSRange(location: token.start - shift, length: token.end - token.start)
            let replacement = MentionAttachment.string(alias: token.alias)
            storage.replaceCharacters(in: range, with: replacement)
            if token.end <= caret { newCaret -= range.length - replacement.length }
            shift += range.length - replacement.length
        }
        if shift > 0 {
            textView.setSelectedRange(NSRange(location: max(0, newCaret), length: 0))
            // The typed characters collapsed into a token: their undo ranges are gone.
            forgetUndo()
        }
    }
}

/// Auto-sizing scroll view that grows from 1 to 6 lines as the user types.
final class ComposerScrollView: NSScrollView {
    private unowned let editorTextView: ComposerNSTextView
    private var lastWidth: CGFloat = 0

    init(textView: ComposerNSTextView) {
        self.editorTextView = textView
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            editorTextView.frame.size.width = max(40, bounds.width)
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        let singleLine = ComposerNSTextView.lineHeight + editorTextView.textContainerInset.height * 2
        guard let layout = editorTextView.layoutManager, let container = editorTextView.textContainer else {
            return NSSize(width: NSView.noIntrinsicMetric, height: singleLine)
        }
        let width = bounds.width > 20 ? bounds.width : 420
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = ceil(layout.usedRect(for: container).height + editorTextView.textContainerInset.height * 2)
        let clamped = min(max(used, singleLine), singleLine * 6)
        return NSSize(width: NSView.noIntrinsicMetric, height: clamped)
    }
}

/// NSTextView with a placeholder, image paste routing and token-aware copy.
final class ComposerNSTextView: NSTextView {
    weak var editor: ComposerEditor?
    var placeholder = ""

    static var font: NSFont { ComposerMetrics.font }
    static var lineHeight: CGFloat { ComposerMetrics.lineHeight }
    static var baseAttributes: [NSAttributedString.Key: Any] { ComposerMetrics.baseAttributes }

    override func paste(_ sender: Any?) {
        if let editor, editor.handlePaste(NSPasteboard.general) { return }
        super.pasteAsPlainText(sender)
    }

    override func pasteAsPlainText(_ sender: Any?) {
        if let editor, editor.handlePaste(NSPasteboard.general) { return }
        super.pasteAsPlainText(sender)
    }

    /// A plain-text view disables Paste for an image-only pasteboard; here images become
    /// attachments, so Düzen → Yapıştır (⌘V) stays enabled for them.
    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if Self.pasteAcceptsImages(action: item.action, pasteboard: .general, canAttach: editor != nil && isEditable) { return true }
        return super.validateUserInterfaceItem(item)
    }

    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if Self.pasteAcceptsImages(action: menuItem.action, pasteboard: .general, canAttach: editor != nil && isEditable) { return true }
        return super.validateMenuItem(menuItem)
    }

    static func pasteAcceptsImages(action: Selector?, pasteboard: NSPasteboard, canAttach: Bool) -> Bool {
        guard canAttach, action == #selector(paste(_:)) || action == #selector(pasteAsPlainText(_:)) else { return false }
        return ImageImport.pasteboardHasImages(pasteboard)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attributes: [NSAttributedString.Key: Any] = [.font: Self.font, .foregroundColor: NSColor.placeholderTextColor]
        NSAttributedString(string: placeholder, attributes: attributes)
            .draw(at: NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0), y: textContainerInset.height))
    }

    override func becomeFirstResponder() -> Bool {
        needsDisplay = true
        return super.becomeFirstResponder()
    }

    /// Copy tokens as `@alias` text.
    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        guard let storage = textStorage else { return super.writeSelection(to: pboard, types: types) }
        let range = selectedRange()
        var out = ""
        storage.enumerateAttribute(.attachment, in: range) { value, sub, _ in
            if let mention = value as? MentionAttachment { out += "@" + mention.alias } else { out += (storage.string as NSString).substring(with: sub) }
        }
        pboard.clearContents()
        return pboard.setString(out, forType: .string)
    }
}

/// Text metrics shared by the text view and the token cells (usable from any isolation).
enum ComposerMetrics {
    nonisolated(unsafe) static let font = NSFont.systemFont(ofSize: 14)
    nonisolated(unsafe) static let tokenFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    static var lineHeight: CGFloat { ceil(font.ascender - font.descender + font.leading) + 2 }
    static var baseAttributes: [NSAttributedString.Key: Any] { [.font: font, .foregroundColor: NSColor.labelColor] }
}

/// A mention token: neutral pill (`@image-1`), deleted and moved as one character.
final class MentionAttachment: NSTextAttachment {
    let alias: String

    @MainActor
    init(alias: String) {
        self.alias = alias
        super.init(data: nil, ofType: nil)
        attachmentCell = MentionCell(alias: alias)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @MainActor
    static func string(alias: String) -> NSAttributedString {
        let string = NSMutableAttributedString(attachment: MentionAttachment(alias: alias))
        string.addAttributes(ComposerMetrics.baseAttributes, range: NSRange(location: 0, length: string.length))
        return string
    }
}

final class MentionCell: NSTextAttachmentCell {
    nonisolated(unsafe) private let label: NSAttributedString

    init(alias: String) {
        label = NSAttributedString(string: "@" + alias, attributes: [.font: ComposerMetrics.tokenFont, .foregroundColor: NSColor.labelColor])
        super.init(textCell: "")
    }

    required init(coder: NSCoder) { fatalError("not used") }

    override func cellSize() -> NSSize {
        let size = label.size()
        return NSSize(width: ceil(size.width) + 14, height: ComposerMetrics.lineHeight - 1)
    }

    override func cellBaselineOffset() -> NSPoint {
        NSPoint(x: 0, y: ComposerMetrics.font.descender - 1)
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let rect = cellFrame.insetBy(dx: 1, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(hex: 0x323235) : NSColor(hex: 0xEBEBED)
        }.setFill()
        path.fill()
        let size = label.size()
        label.draw(at: NSPoint(x: rect.minX + (rect.width - size.width) / 2, y: rect.minY + (rect.height - size.height) / 2))
    }

    override func wantsToTrackMouse() -> Bool { false }
}
