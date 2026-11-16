import AppKit

/// Configures an `NSScrollView` to use thin overlay scroll bars (the minimal style
/// that only appears while scrolling), regardless of the system setting.
@MainActor
extension NSScrollView {
    func applyMinimalScroller() {
        scrollerStyle = .overlay
        autohidesScrollers = true
        verticalScroller?.controlSize = .mini
        horizontalScroller?.controlSize = .mini
        scrollerKnobStyle = .default
    }
}

/// Flipped document container for AppKit `NSScrollView` so content lays out top-to-bottom.
final class FlippedDocumentView: NSView {
    override var isFlipped: Bool { true }
}

/// Flipped clip view so short scroll content pins to the top instead of the bottom.
final class FlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}
