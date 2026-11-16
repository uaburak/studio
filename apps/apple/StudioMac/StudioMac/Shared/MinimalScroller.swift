import AppKit
import SwiftUI

/// Makes the enclosing scroll view use thin overlay scroll bars (the minimal style that only
/// appears while scrolling), regardless of the "Show scroll bars" system setting.
struct MinimalScroller: NSViewRepresentable {
    func makeNSView(context: Context) -> ScrollerStylingView { ScrollerStylingView() }
    func updateNSView(_ view: ScrollerStylingView, context: Context) { view.apply() }

    final class ScrollerStylingView: NSView {
        nonisolated(unsafe) private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
            if observer == nil {
                observer = NotificationCenter.default.addObserver(
                    forName: NSScroller.preferredScrollerStyleDidChangeNotification,
                    object: nil, queue: .main
                ) { [weak self] _ in
                    MainActor.assumeIsolated { self?.apply() }
                }
            }
        }

        func apply() {
            guard let scrollView = enclosingScrollView else { return }
            scrollView.scrollerStyle = .overlay
            scrollView.autohidesScrollers = true
            scrollView.verticalScroller?.controlSize = .mini
            scrollView.scrollerKnobStyle = .default
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}
