import AppKit
import StudioKit

private let mentionAliasAttributeKey = NSAttributedString.Key("studio.mentionAliasId")

/// Pure AppKit selectable text view that renders `@alias` mentions inside neutral rounded pills
/// (`Theme.fillStrong`) and intercepts clicks on them to open the alias image preview sheet.
final class MentionedTextView: NSView, NSTextViewDelegate {
    var onSelectMention: ((EntityID) -> Void)?

    private let textView: MentionReadOnlyTextView
    private let layoutManager = MentionPillLayoutManager()
    private let textStorage = NSTextStorage()
    private let textContainer = NSTextContainer(size: NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude))
    private var lastWidth: CGFloat = 0
    private var maxPreferredWidth: CGFloat?

    init(
        text: String = "",
        mentions: [MessageMention] = [],
        currentName: (MessageMention) -> String = { $0.alias },
        font: NSFont = Theme.chatFont,
        maxPreferredWidth: CGFloat? = nil,
        onSelectMention: ((EntityID) -> Void)? = nil
    ) {
        self.maxPreferredWidth = maxPreferredWidth
        self.onSelectMention = onSelectMention
        textStorage.addLayoutManager(layoutManager)
        textContainer.lineFragmentPadding = 0
        textContainer.widthTracksTextView = true
        layoutManager.addTextContainer(textContainer)
        textView = MentionReadOnlyTextView(frame: .zero, textContainer: textContainer)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        textView.delegate = self
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = .zero
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.linkTextAttributes = [
            .foregroundColor: Theme.textPrimary,
            .cursor: NSCursor.pointingHand,
        ]
        addSubview(textView)

        update(text: text, mentions: mentions, currentName: currentName, font: font)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(
        text: String,
        mentions: [MessageMention],
        currentName: (MessageMention) -> String,
        font: NSFont = Theme.chatFont
    ) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        let baseAttrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: Theme.textPrimary,
            .paragraphStyle: paragraph,
        ]

        let segments = MentionText.segments(text, mentions: mentions)
        let built = NSMutableAttributedString()
        for segment in segments {
            switch segment {
            case .text(let chunk):
                built.append(NSAttributedString(string: chunk, attributes: baseAttrs))
            case .mention(let mention):
                var attrs = baseAttrs
                attrs[.font] = NSFont.systemFont(ofSize: 13, weight: .medium)
                attrs[mentionAliasAttributeKey] = mention.aliasId
                if let url = URL(string: "studio-mention://\(mention.aliasId)") {
                    attrs[.link] = url
                }
                built.append(NSAttributedString(string: "\u{2009}@\(currentName(mention))\u{2009}", attributes: attrs))
            }
        }
        textStorage.setAttributedString(built)
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
        let fallbackWidth = maxPreferredWidth ?? 540
        let targetWidth = bounds.width > 10 ? bounds.width : fallbackWidth
        textContainer.containerSize = NSSize(width: targetWidth, height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        let width: CGFloat = maxPreferredWidth != nil ? min(ceil(used.width) + 2, fallbackWidth) : NSView.noIntrinsicMetric
        return NSSize(width: width, height: max(18, ceil(used.height)))
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        if let url = link as? URL, url.scheme == "studio-mention", let host = url.host {
            onSelectMention?(host)
            return true
        }
        if let str = link as? String, let url = URL(string: str), url.scheme == "studio-mention", let host = url.host {
            onSelectMention?(host)
            return true
        }
        return false
    }
}

private final class MentionReadOnlyTextView: NSTextView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }

    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }
}

private final class MentionPillLayoutManager: NSLayoutManager {
    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let container = textContainers.first else { return }
        let charRange = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        storage.enumerateAttribute(mentionAliasAttributeKey, in: charRange) { value, subRange, _ in
            guard value != nil else { return }
            let glyphRange = self.glyphRange(forCharacterRange: subRange, actualCharacterRange: nil)
            self.enumerateEnclosingRects(forGlyphRange: glyphRange, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { rect, _ in
                let pillRect = rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -1, dy: -0.5)
                let path = NSBezierPath(roundedRect: pillRect, xRadius: pillRect.height / 2, yRadius: pillRect.height / 2)
                Theme.fillStrong.setFill()
                path.fill()
            }
        }
    }
}
