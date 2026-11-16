import StudioKit
import SwiftUI

/// The row under the chat composer: model and effort menus, the subscription
/// usage ring, and "Mac hazır" on the right.
struct ComposerFooter: View {
    @Bindable var model: ConversationModel

    var body: some View {
        HStack(spacing: 12) {
            FooterMenu(title: model.agentChoice.model.displayName, help: "Model") {
                Picker("Model", selection: $model.agentChoice.model) {
                    ForEach(AgentModel.knownCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            FooterMenu(title: model.agentChoice.effort.displayName, help: "Düşünme düzeyi") {
                Picker("Düşünme düzeyi", selection: $model.agentChoice.effort) {
                    ForEach(AgentEffort.knownCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            UsageIndicator(usage: model.state?.presence?.usage ?? model.app.presence?.usage)
            Spacer(minLength: 0)
            MacStatusView()
        }
    }
}

/// Small secondary text that opens a native menu.
private struct FooterMenu<Content: View>: View {
    var title: String
    var help: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        Menu(content: content) {
            HStack(spacing: 3) {
                Text(title)
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .semibold))
            }
            .font(Theme.smallFont)
            .foregroundStyle(Theme.textSecondary)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(help)
        .accessibilityLabel("\(help): \(title)")
    }
}

/// The fullest usage window as a small ring with its percent; click for every window.
struct UsageIndicator: View {
    var usage: WorkerUsage?
    @State private var showing = false

    var body: some View {
        if let usage, let top = usage.mostUsed {
            let percent = top.effectivePercent
            Button { showing.toggle() } label: {
                HStack(spacing: 4) {
                    UsageRing(fraction: percent / 100, color: UsageIndicator.color(percent))
                    Text(UsageIndicator.percentText(percent))
                        .font(Theme.smallFont)
                        .foregroundStyle(percent >= UsageIndicator.warnPercent ? Theme.accent : Theme.textSecondary)
                        .monospacedDigit()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Abonelik kullanımı")
            .accessibilityLabel("Abonelik kullanımı \(UsageIndicator.percentText(percent))")
            .popover(isPresented: $showing, arrowEdge: .top) {
                UsagePopover(usage: usage)
            }
        } else {
            Text("—")
                .font(Theme.smallFont)
                .foregroundStyle(Theme.textSecondary)
                .help("Mac henüz kullanım bildirmedi")
                .accessibilityLabel("Kullanım bilinmiyor: Mac henüz kullanım bildirmedi")
        }
    }

    /// From here on the ring and percent turn orange ("near the limit").
    static let warnPercent: Double = 90

    static func color(_ percent: Double) -> Color {
        percent >= warnPercent ? Theme.accent : Theme.textSecondary
    }

    static func percentText(_ percent: Double) -> String {
        "%\(Int(percent.rounded()))"
    }
}

private struct UsageRing: View {
    var fraction: Double
    var color: Color

    var body: some View {
        ZStack {
            Circle().stroke(Theme.fillStrong, lineWidth: 2)
            Circle()
                .trim(from: 0, to: max(0, min(fraction, 1)))
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 11, height: 11)
    }
}

/// Every reported window: used percent and when it resets.
struct UsagePopover: View {
    var usage: WorkerUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Kullanım").font(Theme.titleFont).foregroundStyle(Theme.textPrimary)
            ForEach(Array(usage.windows.enumerated()), id: \.offset) { _, window in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(Self.title(window.kind)).font(Theme.captionFont).foregroundStyle(Theme.textPrimary)
                        Spacer(minLength: 12)
                        Text(Self.usedText(window))
                            .font(Theme.captionFont)
                            .foregroundStyle(window.effectivePercent >= UsageIndicator.warnPercent ? Theme.accent : Theme.textSecondary)
                            .monospacedDigit()
                    }
                    if let resetsAt = window.resetsAt {
                        Text("sıfırlanma: \(Self.relative(resetsAt))")
                            .font(Theme.smallFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            Text("Güncellendi: \(Self.relative(usage.observedAt))")
                .font(Theme.smallFont)
                .foregroundStyle(Theme.textTertiary)
        }
        .padding(14)
        .frame(width: 240, alignment: .leading)
    }

    static func title(_ kind: UsageWindow.Kind) -> String {
        switch kind {
        case .fiveHour: "5 saatlik"
        case .weekly: "Haftalık"
        case .other, .unknown: "Diğer"
        }
    }

    static func usedText(_ window: UsageWindow) -> String {
        if window.limited { return "Sınıra ulaşıldı" }
        guard window.usedPercent != nil else { return "—" }
        return "\(UsageIndicator.percentText(window.effectivePercent)) kullanıldı"
    }

    static func relative(_ date: Date) -> String {
        date.formatted(.relative(presentation: .named, unitsStyle: .wide).locale(Locale(identifier: "tr_TR")))
    }
}
