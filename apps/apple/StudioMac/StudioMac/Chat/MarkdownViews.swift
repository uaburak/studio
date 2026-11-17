import AppKit
import StudioKit

// Renders parsed Markdown (`Markdown.parse`) in the transcript: flowing blocks (paragraphs,
// headings, lists, quotes) share one selectable text view; code blocks and tables get their
// own views. `MarkdownView.update` is incremental: unchanged text is a no-op, and segment
// views are reused by position while a reply streams in.

extension NSAttributedString.Key {
    /// Draws an inline `code` pill behind the range.
    static let studioInlineCode = NSAttributedString.Key("studio.inlineCode")
    /// Draws a block quote bar left of the range's lines (value: indent of the bar, CGFloat).
    static let studioQuoteBar = NSAttributedString.Key("studio.quoteBar")
    /// An `@alias` mention pill (value: alias id).
    static let studioMention = NSAttributedString.Key("studio.mentionAliasId")
}

/// What the renderer needs from the conversation: alias names for `@mention` pills.
struct MarkdownContext: Equatable {
    var mentionTargets: [MentionText.Target] = []
    /// Current alias names by alias id (a renamed alias shows its new name).
    var aliasNames: [EntityID: String] = [:]
}

/// One piece of a rendered reply.
enum MarkdownSegment: Equatable {
    case text([MarkdownBlock])
    case code(language: String?, code: String)
    case table(MarkdownTable)
    case rule

    var kind: String {
        switch self {
        case .text: "text"
        case .code: "code"
        case .table: "table"
        case .rule: "rule"
        }
    }

    /// Consecutive flowing blocks merge into one text segment (selection spans them).
    static func segments(_ blocks: [MarkdownBlock]) -> [MarkdownSegment] {
        var result: [MarkdownSegment] = []
        var flow: [MarkdownBlock] = []
        func flush() {
            if !flow.isEmpty { result.append(.text(flow)); flow = [] }
        }
        for block in blocks {
            switch block {
            case .code(let language, let code):
                flush()
                result.append(.code(language: language, code: code))
            case .table(let table):
                flush()
                result.append(.table(table))
            case .rule:
                flush()
                result.append(.rule)
            default:
                flow.append(block)
            }
        }
        flush()
        return result
    }
}

// MARK: - Attributed string builder

struct MarkdownAttributedBuilder {
    var context: MarkdownContext

    /// Space above each kind of block (none above the first one).
    enum Spacing {
        static let paragraph: CGFloat = 10
        static let heading: CGFloat = 18
        static let boldHeading: CGFloat = 14
        static let afterHeading: CGFloat = 6
        static let listItem: CGFloat = 5
        static let list: CGFloat = 8
    }

    func build(_ blocks: [MarkdownBlock]) -> NSAttributedString {
        let output = NSMutableAttributedString()
        append(blocks, to: output, indent: 0, quoted: false)
        return output
    }

    private enum Previous { case none, heading, other }

    private func append(_ blocks: [MarkdownBlock], to output: NSMutableAttributedString, indent: CGFloat, quoted: Bool) {
        var previous: Previous = output.length == 0 ? .none : .other
        for block in blocks {
            func spacing(_ normal: CGFloat) -> CGFloat {
                switch previous {
                case .none: 0
                case .heading: min(normal, Spacing.afterHeading)
                case .other: normal
                }
            }
            switch block {
            case .paragraph(let inlines):
                newParagraph(output)
                let style = paragraphStyle(indent: indent, before: spacing(Spacing.paragraph))
                appendInlines(inlines, to: output, base: baseAttributes(style: style, quoted: quoted))
                previous = .other
            case .heading(let level, let inlines):
                newParagraph(output)
                let style = paragraphStyle(indent: indent, before: previous == .none ? 0 : Spacing.heading)
                var attrs = baseAttributes(style: style, quoted: quoted)
                attrs[.font] = ChatStyle.headingFont(level: level)
                appendInlines(inlines, to: output, base: attrs, bold: true, size: ChatStyle.headingFont(level: level).pointSize)
                previous = .heading
            case .boldHeading(let inlines):
                newParagraph(output)
                let style = paragraphStyle(indent: indent, before: previous == .none ? 0 : Spacing.boldHeading)
                appendInlines(inlines, to: output, base: baseAttributes(style: style, quoted: quoted))
                previous = .heading
            case .list(let items):
                for (index, item) in items.enumerated() {
                    newParagraph(output)
                    let before = index == 0 ? spacing(Spacing.list) : Spacing.listItem
                    appendListItem(item, to: output, indent: indent, before: before, quoted: quoted)
                }
                previous = .other
            case .quote(let inner):
                newParagraph(output)
                let start = output.length
                // The quote's first block sits where a paragraph would.
                let quoteText = NSMutableAttributedString()
                MarkdownAttributedBuilder(context: context).append(inner, to: quoteText, indent: indent + 14, quoted: true)
                var first = NSRange(location: 0, length: 0)
                if quoteText.length > 0, let style = quoteText.attribute(.paragraphStyle, at: 0, effectiveRange: &first) as? NSParagraphStyle,
                   let adjusted = style.mutableCopy() as? NSMutableParagraphStyle {
                    adjusted.paragraphSpacingBefore = spacing(Spacing.paragraph)
                    quoteText.addAttribute(.paragraphStyle, value: adjusted, range: first)
                }
                output.append(quoteText)
                if output.length > start {
                    output.addAttribute(.studioQuoteBar, value: indent, range: NSRange(location: start, length: output.length - start))
                }
                previous = .other
            case .code(_, let code):
                // Only inside quotes (top-level code blocks are their own segment).
                newParagraph(output)
                let style = paragraphStyle(indent: indent, before: spacing(Spacing.paragraph))
                var attrs = baseAttributes(style: style, quoted: quoted)
                attrs[.font] = ChatStyle.codeFont
                output.append(NSAttributedString(string: code.replacingOccurrences(of: "\n", with: "\u{2028}"), attributes: attrs))
                previous = .other
            case .table(let table):
                newParagraph(output)
                let style = paragraphStyle(indent: indent, before: spacing(Spacing.paragraph))
                let rows = [table.header] + table.rows
                let text = rows.map { $0.map(Markdown.plainText).joined(separator: " | ") }.joined(separator: "\u{2028}")
                output.append(NSAttributedString(string: text, attributes: baseAttributes(style: style, quoted: quoted)))
                previous = .other
            case .rule:
                newParagraph(output)
                let style = paragraphStyle(indent: indent, before: spacing(Spacing.paragraph))
                var attrs = baseAttributes(style: style, quoted: quoted)
                attrs[.foregroundColor] = Theme.textTertiary
                output.append(NSAttributedString(string: "———", attributes: attrs))
                previous = .other
            }
        }
    }

    private func newParagraph(_ output: NSMutableAttributedString) {
        if output.length > 0 { output.append(NSAttributedString(string: "\n")) }
    }

    private func paragraphStyle(indent: CGFloat, before: CGFloat) -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = ChatStyle.lineSpacing
        style.paragraphSpacingBefore = before
        style.firstLineHeadIndent = indent
        style.headIndent = indent
        return style
    }

    private func baseAttributes(style: NSParagraphStyle, quoted: Bool) -> [NSAttributedString.Key: Any] {
        [
            .font: ChatStyle.bodyFont,
            .foregroundColor: quoted ? Theme.textSecondary : Theme.textPrimary,
            .paragraphStyle: style,
        ]
    }

    /// Bullet `•` / hollow `◦` / square `▪` by level, or a right-aligned number; the text hangs
    /// at the level's indent, wrapped lines included.
    private func appendListItem(_ item: MarkdownListItem, to output: NSMutableAttributedString, indent: CGFloat, before: CGFloat, quoted: Bool) {
        let level = CGFloat(item.depth)
        let textX = indent + ChatStyle.listTextInset + level * ChatStyle.listLevelIndent
        let style = paragraphStyle(indent: 0, before: before)
        style.headIndent = textX
        style.defaultTabInterval = 400
        let markerText: String
        let markerFont: NSFont
        if let ordinal = item.ordinal {
            style.tabStops = [
                NSTextTab(textAlignment: .right, location: textX - 7),
                NSTextTab(textAlignment: .left, location: textX),
            ]
            markerText = "\(ordinal)."
            markerFont = NSFont.monospacedDigitSystemFont(ofSize: ChatStyle.bodySize, weight: .regular)
        } else {
            let bulletX = indent + ChatStyle.listBulletInset + level * ChatStyle.listLevelIndent
            style.tabStops = [
                NSTextTab(textAlignment: .left, location: bulletX),
                NSTextTab(textAlignment: .left, location: textX),
            ]
            switch item.depth % 3 {
            case 0: markerText = "•"; markerFont = ChatStyle.font(size: 15)
            case 1: markerText = "◦"; markerFont = ChatStyle.font(size: 17)
            default: markerText = "▪"; markerFont = ChatStyle.font(size: 11)
            }
        }
        var base = baseAttributes(style: style, quoted: quoted)
        output.append(NSAttributedString(string: "\t", attributes: base))
        base[.font] = markerFont
        output.append(NSAttributedString(string: markerText, attributes: base))
        base[.font] = ChatStyle.bodyFont
        output.append(NSAttributedString(string: "\t", attributes: base))
        appendInlines(item.content, to: output, base: base)
    }

    // MARK: Inlines

    private struct Traits {
        var bold = false
        var italic = false
        var strike = false
        var link: URL?
        var size: CGFloat = ChatStyle.bodySize
    }

    private func appendInlines(_ inlines: [MarkdownInline], to output: NSMutableAttributedString, base: [NSAttributedString.Key: Any], bold: Bool = false, size: CGFloat = ChatStyle.bodySize) {
        appendInlines(inlines, to: output, base: base, traits: Traits(bold: bold, size: size))
    }

    private func appendInlines(_ inlines: [MarkdownInline], to output: NSMutableAttributedString, base: [NSAttributedString.Key: Any], traits: Traits) {
        for inline in inlines {
            switch inline {
            case .text(let text):
                appendText(text, to: output, base: base, traits: traits)
            case .strong(let children):
                var t = traits
                t.bold = true
                appendInlines(children, to: output, base: base, traits: t)
            case .emphasis(let children):
                var t = traits
                t.italic = true
                appendInlines(children, to: output, base: base, traits: t)
            case .strikethrough(let children):
                var t = traits
                t.strike = true
                appendInlines(children, to: output, base: base, traits: t)
            case .link(let children, let url):
                var t = traits
                t.link = Self.linkURL(url)
                appendInlines(children, to: output, base: base, traits: t)
            case .code(let code):
                appendCode(code, to: output, base: base)
            case .lineBreak:
                var attrs = base
                attrs[.font] = ChatStyle.font(size: traits.size, bold: traits.bold, italic: traits.italic)
                output.append(NSAttributedString(string: "\u{2028}", attributes: attrs))
            }
        }
    }

    /// `https://…` and `mailto:` links open in the browser; anything else stays text.
    static func linkURL(_ string: String) -> URL? {
        guard let url = URL(string: string), let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return nil }
        return url
    }

    private func attributes(base: [NSAttributedString.Key: Any], traits: Traits) -> [NSAttributedString.Key: Any] {
        var attrs = base
        attrs[.font] = ChatStyle.font(size: traits.size, bold: traits.bold, italic: traits.italic)
        if traits.strike { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if let link = traits.link {
            attrs[.link] = link
            attrs[.foregroundColor] = Theme.accent
        }
        return attrs
    }

    private func appendText(_ text: String, to output: NSMutableAttributedString, base: [NSAttributedString.Key: Any], traits: Traits) {
        let attrs = attributes(base: base, traits: traits)
        let mentions = traits.link == nil && !context.mentionTargets.isEmpty && text.contains("@")
            ? MentionText.resolve(text, aliases: context.mentionTargets) : []
        guard !mentions.isEmpty else {
            output.append(NSAttributedString(string: text, attributes: attrs))
            return
        }
        for segment in MentionText.segments(text, mentions: mentions) {
            switch segment {
            case .text(let chunk):
                output.append(NSAttributedString(string: chunk, attributes: attrs))
            case .mention(let mention):
                var pill = attrs
                pill[.font] = NSFont.systemFont(ofSize: 13.5, weight: .medium)
                pill[.studioMention] = mention.aliasId
                if let url = URL(string: "studio-mention://\(mention.aliasId)") { pill[.link] = url }
                let name = context.aliasNames[mention.aliasId] ?? mention.alias
                output.append(NSAttributedString(string: "\u{2009}@\(name)\u{2009}", attributes: pill))
            }
        }
    }

    /// Inline code: monospaced text in a rounded pill. The character before the code and the
    /// code's last character get extra advance so the pill never touches its neighbours.
    private func appendCode(_ code: String, to output: NSMutableAttributedString, base: [NSAttributedString.Key: Any]) {
        guard !code.isEmpty else { return }
        if output.length > 0 {
            let last = NSRange(location: output.length - 1, length: 1)
            let lastChar = (output.string as NSString).character(at: last.location)
            if lastChar != 0x0A, lastChar != 0x2028, lastChar != 0x09 {
                output.addAttribute(.kern, value: 4, range: last)
            }
        }
        var attrs = base
        attrs[.font] = ChatStyle.inlineCodeFont
        attrs[.studioInlineCode] = true
        attrs[.foregroundColor] = Theme.textPrimary
        let text = NSMutableAttributedString(string: code, attributes: attrs)
        text.addAttribute(.kern, value: 4, range: NSRange(location: text.length - 1, length: 1))
        output.append(text)
    }
}

// MARK: - Text view

/// A selectable, non-editable text view sized to its content, drawing mention pills, inline
/// code pills and quote bars; links are accent-coloured, underlined on hover, open in the
/// browser (mention links call `onSelectMention`).
final class MarkdownTextView: NSView, NSTextViewDelegate {
    var onSelectMention: ((EntityID) -> Void)?

    let textView: ChatReadOnlyTextView
    private let layoutManager = ChatTextLayoutManager()
    private let textStorage = NSTextStorage()
    private let textContainer = NSTextContainer(size: NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude))
    private var lastWidth: CGFloat = 0
    private var cachedHeight: (width: CGFloat, height: CGFloat)?

    override init(frame frameRect: NSRect) {
        textStorage.addLayoutManager(layoutManager)
        textContainer.lineFragmentPadding = 0
        textContainer.widthTracksTextView = true
        layoutManager.addTextContainer(textContainer)
        textView = ChatReadOnlyTextView(frame: .zero, textContainer: textContainer)
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.defaultHigh, for: .vertical)

        textView.delegate = self
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = .zero
        textView.isVerticallyResizable = false
        textView.isHorizontallyResizable = false
        textView.isAutomaticLinkDetectionEnabled = false
        // Colours come from the string; only the cursor changes over links.
        textView.linkTextAttributes = [.cursor: NSCursor.pointingHand]
        textView.selectedTextAttributes = [.backgroundColor: NSColor.selectedTextBackgroundColor]
        addSubview(textView)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var attributedText: NSAttributedString { textStorage }

    /// Replaces the text; a no-op when it did not change.
    func setAttributedText(_ text: NSAttributedString) {
        guard !textStorage.isEqual(to: text) else { return }
        textView.clearHoveredLink()
        textStorage.setAttributedString(text)
        cachedHeight = nil
        invalidateIntrinsicContentSize()
        needsLayout = true
        textView.needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        textView.needsDisplay = true
    }

    override func layout() {
        super.layout()
        textView.frame = bounds
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        let width = bounds.width > 10 ? bounds.width : Theme.columnMaxWidth
        if let cachedHeight, abs(cachedHeight.width - width) < 0.5 {
            return NSSize(width: NSView.noIntrinsicMetric, height: cachedHeight.height)
        }
        textContainer.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        let height = max(ceil(ChatStyle.bodyFont.ascender - ChatStyle.bodyFont.descender), ceil(used.height))
        cachedHeight = (width, height)
        return NSSize(width: NSView.noIntrinsicMetric, height: height)
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
        if let url, url.scheme == "studio-mention", let host = url.host {
            onSelectMention?(host)
            return true
        }
        if let url, MarkdownAttributedBuilder.linkURL(url.absoluteString) != nil {
            NSWorkspace.shared.open(url)
            return true
        }
        return true
    }
}

/// Read-only text view of the transcript: scroll wheel goes to the transcript, links get an
/// underline while hovered.
final class ChatReadOnlyTextView: NSTextView {
    private var hoveredLink: NSRange?
    private var hoverArea: NSTrackingArea?

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }

    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        hoverArea = area
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        let point = convert(event.locationInWindow, from: nil)
        var range = NSRange(location: NSNotFound, length: 0)
        if let layoutManager, let container = textContainer, let storage = textStorage, storage.length > 0 {
            let index = layoutManager.characterIndex(for: point, in: container, fractionOfDistanceBetweenInsertionPoints: nil)
            let glyphRect = layoutManager.boundingRect(forGlyphRange: layoutManager.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil), in: container)
            if index < storage.length, glyphRect.insetBy(dx: -2, dy: -2).contains(point),
               storage.attribute(.link, at: index, effectiveRange: nil) != nil,
               storage.attribute(.studioMention, at: index, effectiveRange: nil) == nil {
                _ = storage.attribute(.link, at: index, effectiveRange: &range)
            }
        }
        setHoveredLink(range.location == NSNotFound ? nil : range)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        setHoveredLink(nil)
    }

    func clearHoveredLink() { setHoveredLink(nil) }

    private func setHoveredLink(_ range: NSRange?) {
        guard range != hoveredLink, let layoutManager else { return }
        if let old = hoveredLink, let length = textStorage?.length, NSMaxRange(old) <= length {
            layoutManager.removeTemporaryAttribute(.underlineStyle, forCharacterRange: old)
        }
        hoveredLink = range
        if let range {
            layoutManager.addTemporaryAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, forCharacterRange: range)
        }
    }
}

/// Draws the rounded backgrounds of mentions and inline code, and quote bars.
final class ChatTextLayoutManager: NSLayoutManager {
    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let container = textContainers.first, storage.length > 0 else { return }
        let charRange = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        let none = NSRange(location: NSNotFound, length: 0)

        storage.enumerateAttribute(.studioQuoteBar, in: charRange) { value, subRange, _ in
            guard let indent = value as? CGFloat else { return }
            let glyphs = self.glyphRange(forCharacterRange: subRange, actualCharacterRange: nil)
            var top = CGFloat.greatestFiniteMagnitude
            var bottom: CGFloat = 0
            self.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in
                top = min(top, used.minY)
                bottom = max(bottom, used.maxY)
            }
            guard bottom > top else { return }
            let bar = NSRect(x: origin.x + indent, y: origin.y + top, width: 3, height: bottom - top)
            ChatStyle.quoteBar.setFill()
            NSBezierPath(roundedRect: bar, xRadius: 1.5, yRadius: 1.5).fill()
        }

        storage.enumerateAttribute(.studioInlineCode, in: charRange) { value, subRange, _ in
            guard value != nil else { return }
            let glyphs = self.glyphRange(forCharacterRange: subRange, actualCharacterRange: nil)
            self.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: none, in: container) { rect, _ in
                // The last glyph's extra advance (kern 4) is inside `rect`: keep 1 pt of it as gap.
                var pill = rect.offsetBy(dx: origin.x, dy: origin.y)
                pill.origin.x -= 3
                pill.size.width += 2
                pill = pill.insetBy(dx: 0, dy: 1)
                ChatStyle.inlineCodeFill.setFill()
                NSBezierPath(roundedRect: pill, xRadius: 5, yRadius: 5).fill()
            }
        }

        storage.enumerateAttribute(.studioMention, in: charRange) { value, subRange, _ in
            guard value != nil else { return }
            let glyphs = self.glyphRange(forCharacterRange: subRange, actualCharacterRange: nil)
            self.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: none, in: container) { rect, _ in
                let pill = rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -1, dy: 1)
                Theme.fillStrong.setFill()
                NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2).fill()
            }
        }
    }
}

// MARK: - Code block

/// Rounded code block: language label + copy button (✓ for 1.5 s), monospaced 13 pt text that
/// scrolls horizontally instead of wrapping.
final class MarkdownCodeBlockView: ThemedView {
    private(set) var code = ""
    private(set) var language: String?
    private let languageLabel = NSTextField(labelWithString: "")
    let copyButton = GlyphButton(symbol: "doc.on.doc", size: 11, diameter: 22)
    private let scroll = HorizontalOnlyScrollView()
    private let textView = ChatReadOnlyTextView(frame: .zero)
    private var heightConstraint: NSLayoutConstraint!
    private var resetCopy: DispatchWorkItem?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = ChatStyle.codeFill
        borderColor = Theme.hairline
        borderWidth = 1
        cornerRadius = ChatStyle.codeRadius
        layer?.masksToBounds = true

        languageLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        languageLabel.textColor = Theme.textSecondary
        languageLabel.translatesAutoresizingMaskIntoConstraints = false

        copyButton.toolTip = "Kopyala"
        copyButton.setAccessibilityLabel("Kodu kopyala")
        copyButton.onAction = { [weak self] in self?.copyCode() }

        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 0, height: 0)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.font = ChatStyle.codeFont
        textView.textColor = Theme.textPrimary

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.documentView = textView
        scroll.applyMinimalScroller()
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)

        addSubview(languageLabel)
        addSubview(copyButton)
        addSubview(scroll)

        heightConstraint = scroll.heightAnchor.constraint(equalToConstant: 20)
        NSLayoutConstraint.activate([
            languageLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            languageLabel.centerYAnchor.constraint(equalTo: copyButton.centerYAnchor),
            copyButton.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            copyButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: copyButton.bottomAnchor, constant: 4),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            heightConstraint,
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(language: String?, code: String) {
        if language != self.language || languageLabel.stringValue.isEmpty {
            self.language = language
            languageLabel.stringValue = (language?.isEmpty == false ? language! : "kod")
            setAccessibilityLabel("Kod bloğu: \(languageLabel.stringValue)")
        }
        guard code != self.code || textView.string.isEmpty else { return }
        self.code = code
        textView.string = code
        textView.font = ChatStyle.codeFont
        textView.textColor = Theme.textPrimary
        if let layoutManager = textView.layoutManager, let container = textView.textContainer {
            layoutManager.ensureLayout(for: container)
            let used = layoutManager.usedRect(for: container)
            let lineHeight = ceil(ChatStyle.codeFont.ascender - ChatStyle.codeFont.descender + ChatStyle.codeFont.leading)
            let height = max(lineHeight, ceil(used.height))
            textView.frame = NSRect(x: 0, y: 0, width: max(ceil(used.width) + 2, 10), height: height)
            // Room for the overlay scroller when the code is wider than the block.
            heightConstraint.constant = height + 4
        }
    }

    /// Copies the code; the button shows ✓ for 1.5 s.
    func copyCode() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        copyButton.symbolName = "checkmark"
        resetCopy?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.copyButton.symbolName = "doc.on.doc" }
        resetCopy = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }
}

/// A horizontal scroller that hands vertical wheel scrolling to the transcript.
final class HorizontalOnlyScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) {
            super.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }
}

// MARK: - Table

/// Hairline grid, semibold header on a subtle fill, padded cells; scrolls horizontally when wider
/// than the column.
final class MarkdownTableView: NSView {
    private(set) var table: MarkdownTable?
    private let scroll = HorizontalOnlyScrollView()
    private let grid = TableGridView()
    private var heightConstraint: NSLayoutConstraint!

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.documentView = grid
        scroll.applyMinimalScroller()
        scroll.automaticallyAdjustsContentInsets = false
        addSubview(scroll)
        heightConstraint = heightAnchor.constraint(equalToConstant: 40)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightConstraint,
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.table)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ table: MarkdownTable, context: MarkdownContext) {
        guard table != self.table else { return }
        self.table = table
        grid.build(table, context: context)
        heightConstraint.constant = grid.frame.height + 2
    }

    /// Cell texts, header first (tests).
    var cellTexts: [[String]] {
        guard let table else { return [] }
        return ([table.header] + table.rows).map { $0.map(Markdown.plainText) }
    }
}

private final class TableGridView: NSView {
    private var columnEdges: [CGFloat] = []
    private var rowEdges: [CGFloat] = []
    override var isFlipped: Bool { true }

    static let padding = NSSize(width: 12, height: 8)
    static let maxColumnWidth: CGFloat = 300

    func build(_ table: MarkdownTable, context: MarkdownContext) {
        subviews.forEach { $0.removeFromSuperview() }
        let builder = MarkdownAttributedBuilder(context: context)
        let rows = [table.header] + table.rows
        let columns = table.header.count
        var cells: [[NSTextField]] = []
        var widths = Array(repeating: CGFloat(40), count: columns)
        for (r, row) in rows.enumerated() {
            var fields: [NSTextField] = []
            for (c, inlines) in row.enumerated() where c < columns {
                let text = NSMutableAttributedString(attributedString: builder.build([.paragraph(inlines)]))
                let full = NSRange(location: 0, length: text.length)
                text.addAttribute(.font, value: r == 0 ? ChatStyle.tableHeaderFont : ChatStyle.tableFont, range: full)
                let style = NSMutableParagraphStyle()
                switch table.alignments[c] {
                case .leading: style.alignment = .left
                case .center: style.alignment = .center
                case .trailing: style.alignment = .right
                }
                style.lineSpacing = 2
                text.addAttribute(.paragraphStyle, value: style, range: full)
                let field = NSTextField(labelWithAttributedString: text)
                field.isSelectable = true
                field.allowsEditingTextAttributes = true
                field.maximumNumberOfLines = 0
                field.lineBreakMode = .byWordWrapping
                field.cell?.wraps = true
                let natural = ceil(text.boundingRect(with: NSSize(width: 10_000, height: 10_000), options: [.usesLineFragmentOrigin]).width)
                widths[c] = max(widths[c], min(Self.maxColumnWidth, natural))
                fields.append(field)
            }
            cells.append(fields)
        }
        let pad = Self.padding
        columnEdges = [0]
        for w in widths { columnEdges.append(columnEdges.last! + w + pad.width * 2) }
        rowEdges = [0]
        for fields in cells {
            var height: CGFloat = 0
            for (c, field) in fields.enumerated() {
                field.preferredMaxLayoutWidth = widths[c]
                let size = field.attributedStringValue.boundingRect(with: NSSize(width: widths[c], height: 10_000), options: [.usesLineFragmentOrigin, .usesFontLeading])
                height = max(height, ceil(size.height))
            }
            let y = rowEdges.last!
            for (c, field) in fields.enumerated() {
                field.frame = NSRect(x: columnEdges[c] + pad.width, y: y + pad.height, width: widths[c] + 2, height: height + 2)
                addSubview(field)
            }
            rowEdges.append(y + height + pad.height * 2)
        }
        frame = NSRect(x: 0, y: 0, width: columnEdges.last! + 1, height: rowEdges.last! + 1)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard columnEdges.count > 1, rowEdges.count > 1 else { return }
        let width = columnEdges.last!
        let height = rowEdges.last!
        let outline = NSRect(x: 0.5, y: 0.5, width: width, height: height)
        let path = NSBezierPath(roundedRect: outline, xRadius: 8, yRadius: 8)
        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        ChatStyle.codeFill.setFill()
        NSRect(x: 0, y: 0, width: width + 1, height: rowEdges[1]).fill()
        Theme.hairline.setFill()
        for y in rowEdges.dropFirst().dropLast() { NSRect(x: 0, y: y, width: width + 1, height: 1).fill() }
        for x in columnEdges.dropFirst().dropLast() { NSRect(x: x, y: 0, width: 1, height: height + 1).fill() }
        NSGraphicsContext.restoreGraphicsState()
        Theme.hairline.setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

// MARK: - Markdown view

/// An assistant text part: parsed and rendered incrementally (see the file header).
final class MarkdownView: NSView {
    var onSelectMention: ((EntityID) -> Void)?
    private let stack = NSStackView()
    private(set) var markdown: String?
    private var context = MarkdownContext()
    private(set) var segments: [MarkdownSegment] = []
    /// One view per segment, reused by position while the kind matches.
    private(set) var segmentViews: [NSView] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(markdown: String, context: MarkdownContext) {
        guard markdown != self.markdown || context != self.context else { return }
        let contextChanged = context != self.context
        self.markdown = markdown
        self.context = context
        let next = MarkdownSegment.segments(Markdown.parse(markdown))
        let old = segments
        segments = next

        var views: [NSView] = []
        for (index, segment) in next.enumerated() {
            let reusable = index < segmentViews.count && index < old.count && old[index].kind == segment.kind
            let view = reusable ? segmentViews[index] : makeView(for: segment)
            if !reusable || old[index] != segment || contextChanged {
                configure(view, with: segment)
            }
            views.append(view)
        }
        guard views.count != segmentViews.count || zip(views, segmentViews).contains(where: { $0 !== $1 }) else { return }
        for view in segmentViews where !views.contains(where: { $0 === view }) {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for (index, view) in views.enumerated() {
            if index < stack.arrangedSubviews.count, stack.arrangedSubviews[index] === view { continue }
            let isNew = view.superview !== stack
            if !isNew { stack.removeArrangedSubview(view) }
            stack.insertArrangedSubview(view, at: index)
            if isNew { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        }
        segmentViews = views
    }

    private func makeView(for segment: MarkdownSegment) -> NSView {
        switch segment {
        case .text:
            let view = MarkdownTextView()
            view.onSelectMention = { [weak self] id in self?.onSelectMention?(id) }
            return view
        case .code: return MarkdownCodeBlockView()
        case .table: return MarkdownTableView()
        case .rule: return HairlineView()
        }
    }

    private func configure(_ view: NSView, with segment: MarkdownSegment) {
        switch segment {
        case .text(let blocks):
            (view as? MarkdownTextView)?.setAttributedText(MarkdownAttributedBuilder(context: context).build(blocks))
        case .code(let language, let code):
            (view as? MarkdownCodeBlockView)?.update(language: language, code: code)
        case .table(let table):
            (view as? MarkdownTableView)?.update(table, context: context)
        case .rule:
            break
        }
    }

    /// Plain text of the rendered flow segments (tests, accessibility).
    var renderedText: String {
        segmentViews.compactMap { ($0 as? MarkdownTextView)?.attributedText.string }.joined(separator: "\n")
    }
}
