import AppKit
import StudioKit
import SwiftUI

/// Design tokens of the approved drafts (apps/mac/Design).
///
/// Black, white and greys only; one accent (#FF6A00) for the primary action
/// and for "something is waiting on you". Every colour is semantic with a
/// light and a dark value, so both appearances stay consistent.
enum Theme {
    // MARK: Colours

    /// Main content background (chat, posts).
    static let canvas = Color(light: 0xFFFFFF, dark: 0x161617)
    /// Raised neutral fill: user bubble, secondary pills, image-needed post placeholder.
    static let fill = Color(light: 0xF4F4F5, dark: 0x262628)
    /// Selected pill row, hovered pills.
    static let fillStrong = Color(light: 0xEBEBED, dark: 0x323235)
    /// Hairlines: row dividers, card borders.
    static let hairline = Color(light: 0xECECEE, dark: 0x2E2E31)
    /// Card borders that must stay visible on white cards / black cards in dark.
    static let border = Color(light: 0xE4E4E7, dark: 0x3A3A3D)

    static let textPrimary = Color(light: 0x101010, dark: 0xF2F2F3)
    /// Secondary labels: dates, section titles, placeholders. Contrast ≥ 4.5:1 on canvas in both.
    static let textSecondary = Color(light: 0x7C7C82, dark: 0x9C9CA2)
    static let textTertiary = Color(light: 0xA6A6AB, dark: 0x6E6E74)

    /// The single accent.
    static let accent = Color(red: 1, green: 0x6A / 255, blue: 0)
    static let onAccent = Color.white

    /// "Primary" status dot (Hazır): black in light, white in dark.
    static let ink = Color(light: 0x0A0A0A, dark: 0xF5F5F5)

    // MARK: Post placeholders (content, not chrome: they keep their tone, softened in dark)

    static let postDark = Color(light: 0x0A0A0A, dark: 0x0A0A0A)
    static let postDarkText = Color.white
    static let postLight = Color(light: 0xFFFFFF, dark: 0xECECEE)
    static let postLightText = Color(light: 0x0A0A0A, dark: 0x0A0A0A)
    static let postMuted = Color(light: 0xF4F4F5, dark: 0x262628)
    static let postMutedText = Color(light: 0x0A0A0A, dark: 0xF2F2F3)
    /// Image slot inside a large dark post (06).
    static let slotFill = Color(white: 0x23 / 255)

    // MARK: Metrics

    static let sidebarWidth: CGFloat = 228
    static let inspectorWidth: CGFloat = 268
    /// Chat column: at most this wide, at least `columnMinMargin` from each side.
    static let columnMaxWidth: CGFloat = 634
    static let columnMinMargin: CGFloat = 84
    static let cardRadius: CGFloat = 20
    static let panelRadius: CGFloat = 24
    static let composerHeight: CGFloat = 46

    // MARK: Liquid Glass

    /// Floating controls (composer, approve bar, search): regular glass tinted
    /// toward the canvas so it reads as the drafts' white (light) / near-black (dark) pill.
    static var floatingGlass: Glass { .regular.tint(canvas.opacity(0.72)) }

    // MARK: Type (SF, system sizes from the drafts)

    static let chatFont = Font.system(size: 14)
    static let rowFont = Font.system(size: 13)
    static let smallFont = Font.system(size: 11)
    static let captionFont = Font.system(size: 12)
    static let buttonFont = Font.system(size: 12, weight: .semibold)
    static let titleFont = Font.system(size: 13, weight: .semibold)
}

extension Color {
    /// A dynamic colour from two sRGB hex values.
    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua, .vibrantDark, .vibrantLight]).map { $0 == .darkAqua || $0 == .vibrantDark } ?? false
            return NSColor(hex: isDark ? dark : light)
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
    }
}

extension StatusTone {
    var color: Color {
        switch self {
        case .attention: Theme.accent
        case .primary: Theme.ink
        case .muted: Theme.textTertiary
        }
    }
}

/// User preference: follow the system, or force light / dark.
enum AppearancePreference: String, CaseIterable, Identifiable {
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

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
