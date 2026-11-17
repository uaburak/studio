import AppKit
import StudioKit

/// Design tokens of the approved drafts (apps/mac/Design) in pure AppKit.
///
/// Black, white and greys only; one accent (#FF6A00) for the primary action
/// and for "something is waiting on you". Every colour is semantic with a
/// light and a dark value, dynamically resolved per `NSAppearance`.
enum Theme {
    // MARK: Colours

    /// Main content background (chat, posts) and the right panel (Claude Code: one calm grey).
    static let canvas = NSColor(light: 0xFFFFFF, dark: 0x1F1F20)
    /// Raised neutral fill: user bubble, secondary pills, image-needed post placeholder.
    static let fill = NSColor(light: 0xF4F4F5, dark: 0x2E2E30)
    /// Selected pill row, hovered pills.
    static let fillStrong = NSColor(light: 0xEBEBED, dark: 0x3A3A3C)
    /// Hairlines: row dividers, card borders, the top bar's bottom edge, split dividers.
    static let hairline = NSColor(light: 0xE6E6E8, dark: 0x3A3A3C)
    /// Card borders that must stay visible on white cards / black cards in dark.
    static let border = NSColor(light: 0xE0E0E3, dark: 0x48484A)

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
    static let floatingGlassTint = NSColor(light: 0xFFFFFF, dark: 0x1F1F20, alpha: 0.72)
    /// The composer's glass: a raised grey field over the canvas (Claude Code's input).
    static let composerGlassTint = NSColor(light: 0xFFFFFF, dark: 0x3A3A3C, alpha: 0.78)
    /// The composer's 1 pt edge.
    static let composerBorder = NSColor(light: 0xDCDCE0, dark: 0x4C4C4F)

    // MARK: Window chrome (Claude Code layout)

    /// Flush left sidebar: a step off the canvas (greyer in light, lighter in dark), full height.
    static let sidebarBackground = NSColor(light: 0xF4F4F5, dark: 0x2D2D2E)
    /// Selected sidebar row: a rounded neutral fill, never the accent.
    static let sidebarSelection = NSColor(light: 0xE4E4E7, dark: 0x4A4A4C)
    /// Hovered sidebar row.
    static let sidebarHover = NSColor(light: 0xECECEE, dark: 0x3A3A3C)
    /// Thin meters in the right panel (usage windows).
    static let meterTrack = NSColor(light: 0xEBEBED, dark: 0x38383A)
    /// The top bar's two-mode pill over the sidebar: the track and the selected segment.
    static let modePillTrack = NSColor(light: 0xE6E6E9, dark: 0x404042, alpha: 0.85)
    static let modePillSelection = NSColor(light: 0xFFFFFF, dark: 0x5C5C5E)
    /// Top bar icon buttons: hover and "this pane / screen is open".
    static let barButtonHover = NSColor(light: 0xEFEFF1, dark: 0x2E2E30)
    static let barButtonActive = NSColor(light: 0xE6E6E9, dark: 0x38383A)
    /// Rows in the right panel's job list (Claude Code's background task cards).
    static let panelCard = NSColor(light: 0xF5F5F6, dark: 0x29292B)

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

    static let sidebarWidth: CGFloat = 265
    static let inspectorWidth: CGFloat = 357
    /// The right panel's "expand" width (its header's ⤢ button).
    static let inspectorExpandedWidth: CGFloat = 560
    /// One title bar across the window: the native compact title bar's height, so the traffic
    /// lights sit centred in it (`MainWindowController` uses an empty `.unifiedCompact` toolbar).
    static let topBarHeight: CGFloat = 40
    /// Rounded selection / hover fill of sidebar rows and its inset from the sidebar edges.
    static let sidebarRowRadius: CGFloat = 8
    static let sidebarRowInset: CGFloat = 8
    /// Chat column: at most this wide, at least `columnMinMargin` from each side.
    static let columnMaxWidth: CGFloat = 710
    static let columnMinMargin: CGFloat = 32
    /// The composer is a little wider than the message column (Claude Code).
    static let composerOverhang: CGFloat = 14
    static let cardRadius: CGFloat = 20
    static let panelRadius: CGFloat = 24
    /// Inline banners (errors, connection status) and grouped settings cards.
    static let bannerRadius: CGFloat = 14
    /// Selectable rows inside lists and palettes.
    static let rowRadius: CGFloat = 16
    static let composerHeight: CGFloat = 44
    /// Rounded-rect composer (not a capsule), like Claude Code's input.
    static let composerRadius: CGFloat = 14
    /// User message bubbles.
    static let bubbleRadius: CGFloat = 14

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
        static let sidebarWidth: CGFloat = 212
        static let headerHeight: CGFloat = 46
        /// Content column inset from the sidebar hairline and the panel edge.
        static let contentInset: CGFloat = 20
        /// Above and below every row's text (rows come out ~68 pt like Claude's).
        static let rowVerticalPadding: CGFloat = 16
        static let sidebarRowHeight: CGFloat = 32
        static let sidebarRowRadius: CGFloat = 8
        /// Text fields and pop-ups on the right of a row.
        static let controlWidth: CGFloat = 220
        /// Selected sidebar row (subtle grey, never the accent).
        static let selectionFill = Theme.fillStrong
        static let hoverFill = Theme.fill
        /// Dims the window behind the settings panel.
        static let backdrop = NSColor(light: 0x000000, dark: 0x000000, alpha: 0.32)
        /// The panel itself: a raised surface over the dimmed window, rounded 14.
        static let panelBackground = NSColor(light: 0xFFFFFF, dark: 0x252527)
        static let panelBorder = NSColor(light: 0xDCDCE0, dark: 0x3C3C3F)
        static let panelRadius: CGFloat = 14
        /// "Bu Mac" style tag pills next to a row title.
        static let tagFill = NSColor(light: 0xEFEFF1, dark: 0x343437)
        static var titleFont: NSFont { NSFont.systemFont(ofSize: 15, weight: .semibold) }
        static var headerTitleFont: NSFont { NSFont.systemFont(ofSize: 15, weight: .medium) }
        static var rowTitleFont: NSFont { NSFont.systemFont(ofSize: 14) }
        static var rowDetailFont: NSFont { NSFont.systemFont(ofSize: 13) }
        static var subheaderFont: NSFont { NSFont.systemFont(ofSize: 12, weight: .semibold) }
        static var tagFont: NSFont { NSFont.systemFont(ofSize: 10, weight: .medium) }
        static var tableHeaderFont: NSFont { NSFont.systemFont(ofSize: 12) }
    }

    /// Right panel (Claude Code's Environment / Context / Connectors): tiny grey section
    /// headers, compact label-left / value-right rows, hairlines between sections.
    enum Panel {
        static let horizontalPadding: CGFloat = 14
        static let rowHeight: CGFloat = 24
        static let sectionSpacing: CGFloat = 14
        static var headerFont: NSFont { NSFont.systemFont(ofSize: 12, weight: .medium) }
        static var linkFont: NSFont { NSFont.systemFont(ofSize: 11) }
        static var rowFont: NSFont { NSFont.systemFont(ofSize: 13) }
        static var footnoteFont: NSFont { NSFont.systemFont(ofSize: 11) }
    }

    /// The top bar (Claude Code's title bar): the title over the content and the panel's title.
    enum TopBar {
        static var titleFont: NSFont { NSFont.systemFont(ofSize: 13, weight: .regular) }
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
