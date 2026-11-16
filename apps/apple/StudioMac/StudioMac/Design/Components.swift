import StudioKit
import SwiftUI

/// Pill buttons of the drafts: orange primary, grey secondary.
struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    var kind: Kind = .secondary
    var height: CGFloat = 26

    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.buttonFont)
            .lineLimit(1)
            .foregroundStyle(kind == .primary ? Theme.onAccent : Theme.textPrimary)
            .padding(.horizontal, 13)
            .frame(height: height)
            .background(Capsule().fill(kind == .primary ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Theme.fill)))
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var pillPrimary: PillButtonStyle { PillButtonStyle(kind: .primary) }
    static var pillSecondary: PillButtonStyle { PillButtonStyle(kind: .secondary) }
}

/// A plain borderless glyph button (toolbar-like), neutral colours.
struct GlyphButtonStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.textSecondary)
            .frame(width: 26, height: 26)
            .background(Circle().fill(hovering || configuration.isPressed ? Theme.fill : .clear))
            .contentShape(Circle())
            .onHover { hovering = $0 }
    }
}

struct StatusDot: View {
    var color: Color
    var size: CGFloat = 6

    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
    }
}

/// `● Görsel bekliyor`
struct PostStateLabel: View {
    var state: PostState

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(color: state.tone.color)
            Text(state.label)
                .font(Theme.smallFont)
                .foregroundStyle(Theme.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct Hairline: View {
    var body: some View {
        Rectangle().fill(Theme.hairline).frame(height: 1)
    }
}

/// Grey section title (`Marka`, `Arka plan işleri`).
struct SectionTitle: View {
    var text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.smallFont)
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Mac hazır" / "Mac çevrimdışı" from worker presence.
struct MacStatusView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let online = app.isOnline
        HStack(spacing: 6) {
            StatusDot(color: online ? Theme.accent : Theme.textTertiary)
            Text(online ? "Mac hazır" : "Mac çevrimdışı")
                .font(Theme.smallFont)
                .foregroundStyle(Theme.textSecondary)
        }
        .help(online ? "Mac worker bağlı; işler hemen çalışır." : "Mac worker bağlı değil; işler sırada bekler.")
        .accessibilityElement(children: .combine)
    }
}

/// A banner for errors (neutral, not orange).
struct InlineError: View {
    var message: String
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(Theme.textSecondary)
            Text(message)
                .font(Theme.captionFont)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let onDismiss {
                Button(action: onDismiss) { Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)) }
                    .buttonStyle(GlyphButtonStyle())
                    .accessibilityLabel("Kapat")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.fill))
    }
}

extension View {
    /// The chat column: centred, at most 634 pt, at least 84 pt from the sides.
    func chatColumn() -> some View {
        frame(maxWidth: Theme.columnMaxWidth)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Theme.columnMinMargin)
    }
}
