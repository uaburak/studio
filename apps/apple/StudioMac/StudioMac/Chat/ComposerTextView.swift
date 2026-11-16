import AppKit
import StudioKit
import SwiftUI

/// The composer's text field: an NSTextView (TextKit 1) that
/// - sends on Return, inserts a newline on Shift+Return,
/// - turns `@alias` into a neutral pill token (an attachment that deletes as one),
/// - drives the `@` autocomplete (arrows, Return/Tab to pick, Escape to close),
/// - routes pasted / dropped images to the attachment row instead of the text.
struct ComposerTextView: NSViewRepresentable {
    let model: ComposerModel
    var focusRequest: Int = 0
    var onSubmit: () -> Void
    var onImages: ([ImportedImage], [String]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ComposerNSTextView(usingTextLayoutManager: false)
        textView.coordinator = context.coordinator
        textView.delegate = context.coordinator
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
        // Images go to the attachment row (handled by the SwiftUI drop target), never into the text.
        textView.unregisterDraggedTypes()

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.documentView = textView
        context.coordinator.textView = textView
        model.bridge = context.coordinator
        textView.placeholder = model.placeholder
        if !model.text.isEmpty { context.coordinator.setText(model.text) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = context.coordinator.textView else { return }
        if textView.placeholder != model.placeholder {
            textView.placeholder = model.placeholder
            textView.needsDisplay = true
        }
        if context.coordinator.lastFocusRequest != focusRequest {
            context.coordinator.lastFocusRequest = focusRequest
            DispatchQueue.main.async { context.coordinator.focus() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let textView = context.coordinator.textView, let layout = textView.layoutManager, let container = textView.textContainer else { return nil }
        let width = proposal.width ?? 400
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container).height + textView.textContainerInset.height * 2
        let line = ComposerNSTextView.lineHeight + textView.textContainerInset.height * 2
        return CGSize(width: width, height: min(max(used, line), line * 6))
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate, ComposerTextBridge {
        var parent: ComposerTextView
        weak var textView: ComposerNSTextView?
        var lastFocusRequest = 0
        private var isConverting = false

        init(_ parent: ComposerTextView) {
            self.parent = parent
        }

        var model: ComposerModel { parent.model }

        // MARK: Bridge

        func insertMention(_ alias: String, replacingQueryStartingAt start: Int) {
            guard let textView, let storage = textView.textStorage else { return }
            let caret = textView.selectedRange().location
            let range = NSRange(location: start, length: max(0, caret - start))
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
            textView?.string = ""
            textView?.typingAttributes = ComposerNSTextView.baseAttributes
            push()
        }

        func focus() {
            guard let textView else { return }
            textView.window?.makeFirstResponder(textView)
        }

        func setText(_ text: String) {
            guard let textView, let storage = textView.textStorage else { return }
            storage.setAttributedString(NSAttributedString(string: text, attributes: ComposerNSTextView.baseAttributes))
            convertTypedMentions(force: true)
            push()
        }

        // MARK: Delegate

        func textDidChange(_ notification: Notification) {
            convertTypedMentions(force: false)
            push()
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView else { return }
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
                    parent.onSubmit()
                }
                return true
            }
            return false
        }

        // MARK: Paste and drop

        func handlePaste(_ pasteboard: NSPasteboard) -> Bool {
            guard ImageImport.pasteboardHasImages(pasteboard) else { return false }
            let (images, errors) = ImageImport.images(from: pasteboard)
            parent.onImages(images, errors)
            return true
        }

        // MARK: Text <-> model

        /// Plain text with tokens exported as `@alias`.
        func exportedText() -> String {
            guard let storage = textView?.textStorage else { return "" }
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

        /// Caret offset in the exported text (tokens are longer there than the 1-char attachment).
        func exportedOffset(for location: Int) -> Int {
            guard let storage = textView?.textStorage else { return location }
            var extra = 0
            storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: min(location, storage.length))) { value, range, _ in
                if let mention = value as? MentionAttachment { extra += mention.alias.utf16.count + 1 - range.length }
            }
            return location + extra
        }

        private func push() {
            let text = exportedText()
            if model.text != text { model.text = text }
            if let textView { model.caret = exportedOffset(for: textView.selectedRange().location) }
            textView?.needsDisplay = true
            textView?.invalidateIntrinsicContentSize()
            textView?.enclosingScrollView?.invalidateIntrinsicContentSize()
        }

        /// `@image-1` typed by hand becomes a token once it is complete (followed by a non-name character),
        /// or everywhere when `force` (after a programmatic `setText`).
        private func convertTypedMentions(force: Bool) {
            guard !isConverting, let textView, let storage = textView.textStorage else { return }
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
                // The raw run includes trailing hyphens (`@image-` may still become `@image-1`).
                var rawEnd = token.end
                while rawEnd < units && MentionText.isNameChar(utf16[rawEnd]) { rawEnd += 1 }
                // Leave the token the caret is in (or right after): the user may still be typing it.
                let caretInside = caret > token.start && caret <= rawEnd
                let closed = rawEnd < units
                guard force || (!caretInside && (rawEnd < caret || closed)) else { continue }
                let range = NSRange(location: token.start - shift, length: token.end - token.start)
                let replacement = MentionAttachment.string(alias: token.alias)
                storage.replaceCharacters(in: range, with: replacement)
                if token.end <= caret { newCaret -= range.length - replacement.length }
                shift += range.length - replacement.length
            }
            if shift > 0 { textView.setSelectedRange(NSRange(location: max(0, newCaret), length: 0)) }
        }
    }
}

/// NSTextView with a placeholder, image paste routing and token-aware copy.
final class ComposerNSTextView: NSTextView {
    weak var coordinator: ComposerTextView.Coordinator?
    var placeholder = ""

    static var font: NSFont { ComposerMetrics.font }
    static var lineHeight: CGFloat { ComposerMetrics.lineHeight }
    static var baseAttributes: [NSAttributedString.Key: Any] { ComposerMetrics.baseAttributes }

    override func paste(_ sender: Any?) {
        if let coordinator, coordinator.handlePaste(NSPasteboard.general) { return }
        pasteAsPlainText(sender)
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
