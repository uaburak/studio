import AppKit
import StudioKit

/// Transcript typography and colours (Claude Code's conversation): 15 pt body at ~1.5 line
/// height, grey step lines, a neutral user bubble, subtle code and table fills.
/// Chat-only tokens; app-wide ones stay in `Theme`.
enum ChatStyle {
    // MARK: Type

    static let bodySize: CGFloat = 15
    static var bodyFont: NSFont { NSFont.systemFont(ofSize: bodySize) }
    /// Extra space between the lines of one paragraph (15 pt type -> ~22 pt line pitch).
    static let lineSpacing: CGFloat = 4
    /// Grey one-line rows: step groups, the working line, event lines.
    static var stepFont: NSFont { NSFont.systemFont(ofSize: 14) }
    static var eventFont: NSFont { NSFont.systemFont(ofSize: 13) }
    static var codeFont: NSFont { NSFont.monospacedSystemFont(ofSize: 13, weight: .regular) }
    static var inlineCodeFont: NSFont { NSFont.monospacedSystemFont(ofSize: 13.5, weight: .regular) }
    static var tableFont: NSFont { NSFont.systemFont(ofSize: 14) }
    static var tableHeaderFont: NSFont { NSFont.systemFont(ofSize: 14, weight: .semibold) }

    /// `#` 17 pt, `##` and deeper 15 pt; all semibold.
    static func headingFont(level: Int) -> NSFont {
        NSFont.systemFont(ofSize: level <= 1 ? 17 : 15, weight: .semibold)
    }

    /// Body-sized font with Markdown traits.
    static func font(size: CGFloat = bodySize, bold: Bool = false, italic: Bool = false) -> NSFont {
        let base = NSFont.systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        guard italic else { return base }
        let descriptor = base.fontDescriptor.withSymbolicTraits(.italic)
        return NSFont(descriptor: descriptor, size: size) ?? base
    }

    // MARK: Colours

    /// User bubble: #F0F0F0 light, #2A2A2B dark.
    static let userBubble = NSColor(light: 0xF0F0F0, dark: 0x2C2C2E)
    /// Code blocks and the table header.
    static let codeFill = NSColor(light: 0xF6F6F7, dark: 0x262628)
    /// Inline `code` pill.
    static let inlineCodeFill = NSColor(light: 0xEDEDEF, dark: 0x343436)
    /// Block quote bar.
    static let quoteBar = NSColor(light: 0xD4D4D8, dark: 0x4A4A4D)
    /// Dim over a hovered image.
    static let imageHoverDim = NSColor(white: 0, alpha: 0.22)

    // MARK: Metrics

    /// Space between transcript rows (messages, the working line).
    static let rowSpacing: CGFloat = 24
    /// Space between the blocks of one assistant message.
    static let blockSpacing: CGFloat = 14
    static let bubbleRadius: CGFloat = 14
    static let bubblePadding = NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
    /// The user bubble is at most this share of the column.
    static let bubbleMaxShare: CGFloat = 0.7
    static let imageRadius: CGFloat = 12
    static let imageGap: CGFloat = 6
    /// A single assistant image is at most this wide (keeps its aspect).
    static let singleImageMaxWidth: CGFloat = 480
    /// Attachments above a user bubble.
    static let userImageMaxWidth: CGFloat = 260
    static let codeRadius: CGFloat = 10
    static let cardRadius: CGFloat = 12
    /// Hanging indent per list level: bullet at `bulletInset + level * listLevelIndent`,
    /// text at `textInset + level * listLevelIndent`.
    static let listBulletInset: CGFloat = 12
    static let listTextInset: CGFloat = 32
    static let listLevelIndent: CGFloat = 36
    /// Step-group result thumbnails (right end of the line).
    static let stepThumbSize = NSSize(width: 34, height: 22)
}

/// Text formats of the live chat states (tested without views).
enum ChatFormat {
    /// `12s`, `1m 9s`, `39m 24s`, `1h 5m` (Claude Code's elapsed time).
    static func elapsed(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval.rounded(.down)))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m \(seconds)s" }
        return "\(seconds)s"
    }

    /// `14:05` under a message (hover row).
    static func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}
