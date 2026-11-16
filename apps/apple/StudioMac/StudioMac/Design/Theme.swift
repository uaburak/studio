import AppKit
import StudioKit

/// Design tokens of the approved drafts (apps/mac/Design) in pure AppKit.
///
/// Black, white and greys only; one accent (#FF6A00) for the primary action
/// and for "something is waiting on you". Every colour is semantic with a
/// light and a dark value, dynamically resolved per `NSAppearance`.
enum Theme {
    // MARK: Colours

    /// Main content background (chat, posts).
    static let canvas = NSColor(light: 0xFFFFFF, dark: 0x161617)
    /// Raised neutral fill: user bubble, secondary pills, image-needed post placeholder.
    static let fill = NSColor(light: 0xF4F4F5, dark: 0x262628)
    /// Selected pill row, hovered pills.
    static let fillStrong = NSColor(light: 0xEBEBED, dark: 0x323235)
    /// Hairlines: row dividers, card borders.
    static let hairline = NSColor(light: 0xECECEE, dark: 0x2E2E31)
    /// Card borders that must stay visible on white cards / black cards in dark.
    static let border = NSColor(light: 0xE4E4E7, dark: 0x3A3A3D)

    static let textPrimary = NSColor(light: 0x101010, dark: 0xF2F2F3)
    /// Secondary labels: dates, section titles, placeholders. Contrast ≥ 4.5:1 on canvas in both.
    static let textSecondary = NSColor(light: 0x7C7C82, dark: 0x9C9CA2)
    static let textTertiary = NSColor(light: 0xA6A6AB, dark: 0x6E6E74)

    /// The single accent (#FF6A00).
    static let accent = NSColor(srgbRed: 1, green: CGFloat(0x6A) / 255.0, blue: 0, alpha: 1)
    static let onAccent = NSColor.white

    /// "Primary" status dot (Hazır): black in light, white in dark.
    static let ink = NSColor(light: 0x0A0A0A, dark: 0xF5F5F5)

    /// Glass tint for floating controls (composer, approve bar, search).
    static let floatingGlassTint = NSColor(light: 0xFFFFFF, dark: 0x161617, alpha: 0.72)

    // MARK: Post placeholders (content, not chrome)

    static let postDark = NSColor(light: 0x0A0A0A, dark: 0x0A0A0A)
    static let postDarkText = NSColor.white
    static let postLight = NSColor(light: 0xFFFFFF, dark: 0xECECEE)
    static let postLightText = NSColor(light: 0x0A0A0A, dark: 0x0A0A0A)
    static let postMuted = NSColor(light: 0xF4F4F5, dark: 0x262628)
    static let postMutedText = NSColor(light: 0x0A0A0A, dark: 0xF2F2F3)
    /// Image slot inside a large dark post (06).
    static let slotFill = NSColor(srgbRed: CGFloat(0x23) / 255.0, green: CGFloat(0x23) / 255.0, blue: CGFloat(0x23) / 255.0, alpha: 1)

    // MARK: Metrics

    static let sidebarWidth: CGFloat = 228
    static let inspectorWidth: CGFloat = 268
    /// Chat column: at most this wide, at least `columnMinMargin` from each side.
    static let columnMaxWidth: CGFloat = 634
    static let columnMinMargin: CGFloat = 84
    static let cardRadius: CGFloat = 20
    static let panelRadius: CGFloat = 24
    /// Inline banners (errors, connection status) and grouped settings cards.
    static let bannerRadius: CGFloat = 14
    /// Selectable rows inside lists and palettes.
    static let rowRadius: CGFloat = 16
    static let composerHeight: CGFloat = 46

    /// Spacing scale used by new and polished screens (4-pt grid).
    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 6
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
    }

    /// Settings sheet (Claude-desktop layout): sidebar of sections, rows of
    /// title + grey description on the left and the control on the right.
    enum Settings {
        static let sidebarWidth: CGFloat = 216
        static let headerHeight: CGFloat = 52
        /// Content column inset from the sidebar hairline and the panel edge.
        static let contentInset: CGFloat = 28
        /// Above and below every row's text.
        static let rowVerticalPadding: CGFloat = 14
        static let sidebarRowHeight: CGFloat = 30
        static let sidebarRowRadius: CGFloat = 8
        /// Text fields and pop-ups on the right of a row.
        static let controlWidth: CGFloat = 240
        /// Selected sidebar row (subtle grey, never the accent).
        static let selectionFill = Theme.fillStrong
        static let hoverFill = Theme.fill
        /// Dims the window behind the settings panel.
        static let backdrop = NSColor(light: 0x000000, dark: 0x000000, alpha: 0.18)
        static var titleFont: NSFont { NSFont.systemFont(ofSize: 15, weight: .semibold) }
        static var rowTitleFont: NSFont { NSFont.systemFont(ofSize: 13) }
        static var rowDetailFont: NSFont { NSFont.systemFont(ofSize: 12) }
        static var subheaderFont: NSFont { NSFont.systemFont(ofSize: 12, weight: .semibold) }
    }

    // MARK: Accessibility

    /// System "Reduce transparency": glass becomes an opaque surface.
    @MainActor static var reduceTransparency: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency }
    /// System "Increase contrast": floating surfaces get a visible border.
    @MainActor static var increaseContrast: Bool { NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast }

    // MARK: Type (SF, system sizes from the drafts)

    static var chatFont: NSFont { NSFont.systemFont(ofSize: 14) }
    static var rowFont: NSFont { NSFont.systemFont(ofSize: 13) }
    static var smallFont: NSFont { NSFont.systemFont(ofSize: 11) }
    static var captionFont: NSFont { NSFont.systemFont(ofSize: 12) }
    static var buttonFont: NSFont { NSFont.systemFont(ofSize: 12, weight: .semibold) }
    static var titleFont: NSFont { NSFont.systemFont(ofSize: 13, weight: .semibold) }
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }

    /// A dynamic `NSColor` from two sRGB hex values.
    convenience init(light: UInt32, dark: UInt32, alpha: CGFloat = 1) {
        self.init(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua, .vibrantDark, .vibrantLight])
                .map { $0 == .darkAqua || $0 == .vibrantDark } ?? false
            return NSColor(hex: isDark ? dark : light, alpha: alpha)
        }
    }
}

extension StatusTone {
    var nsColor: NSColor {
        switch self {
        case .attention: Theme.accent
        case .primary: Theme.ink
        case .muted: Theme.textTertiary
        }
    }
}

/// User preference: follow the system, or force light / dark.
enum AppearancePreference: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "Sistem"
        case .light: "Açık"
        case .dark: "Koyu"
        }
    }

    var symbol: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max"
        case .dark: "moon"
        }
    }

    /// AppKit appearance for windows (nil = follow the system).
    var nsAppearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }

    /// Sistem -> Açık -> Koyu -> Sistem.
    var next: AppearancePreference {
        switch self {
        case .system: .light
        case .light: .dark
        case .dark: .system
        }
    }
}

extension NSView {
    /// Resolves a dynamic `NSColor` against this view's `effectiveAppearance` for `CALayer` properties.
    func resolvedCGColor(_ color: NSColor) -> CGColor {
        var resolved: CGColor = color.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            resolved = color.cgColor
        }
        return resolved
    }
}
