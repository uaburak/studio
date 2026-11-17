import AppKit
import StudioKit

// The top bar in the Claude Code layout, as plain values (tested without views):
//
//   ● ● ●  ▤  ‹  ›  [💬|▦]  │ Kasım planı ⌄            ≡  ◷  ▦  ▣  ⌂  ▯  …  │ Arka plan işleri   🗑 ⤢ ✕
//   └──────── over the sidebar ───────┘ └───────────── over the content ─────────────┘ └──── over the right panel ────┘
//
// One continuous bar, hairline below the content and the panel, the sidebar column running up
// into it. The panel's own title and actions live in the bar above the panel.

/// What a top bar icon does.
enum TopBarAction: Equatable {
    /// Open this pane of the right panel, or close the panel when it already shows it.
    case togglePanel(RightPanelPane)
    /// Go to a screen.
    case navigate(Route)
    /// The working brand's settings (a new brand when there is none).
    case brandSettings
    /// Settings → Cihazlar: the QR code that pairs an iPhone.
    case pairPhone
    /// The "…" menu.
    case moreMenu
}

/// The icons on the right of the centre segment (Claude Code: list, terminal, diff, globe, …),
/// only Studio tools that exist.
enum TopBarTool: CaseIterable, Equatable {
    case details, jobs, calendar, media, brand, phone, more

    var symbol: String {
        switch self {
        case .details: "list.bullet"
        case .jobs: "clock.arrow.circlepath"
        case .calendar: "calendar"
        case .media: "photo.on.rectangle"
        case .brand: "tag"
        case .phone: "iphone"
        case .more: "ellipsis"
        }
    }

    /// VoiceOver name.
    var title: String {
        switch self {
        case .details: "Ayrıntılar"
        case .jobs: "Arka plan işleri"
        case .calendar: "Takvim"
        case .media: "Medya"
        case .brand: "Marka ayarları"
        case .phone: "iPhone'u bağla"
        case .more: "Diğer seçenekler"
        }
    }

    var help: String {
        switch self {
        case .details: "Ayrıntılar: ortam, kullanım, bağlam ve hesaplar (⌥⌘I)"
        case .jobs: "Arka plan işleri"
        case .calendar: "Yayın takvimi (⇧⌘K)"
        case .media: "Medya kütüphanesi (⇧⌘M)"
        case .brand: "Marka ayarları: kit, profil, hesaplar (⇧⌘B)"
        case .phone: "iPhone'u bağla: QR kod (Ayarlar → Cihazlar)"
        case .more: "Diğer seçenekler"
        }
    }

    var action: TopBarAction {
        switch self {
        case .details: .togglePanel(.details)
        case .jobs: .togglePanel(.jobs)
        case .calendar: .navigate(.calendar)
        case .media: .navigate(.media)
        case .brand: .brandSettings
        case .phone: .pairPhone
        case .more: .moreMenu
        }
    }

    /// Drawn with the "open" fill: its pane is showing, or its screen is the current one.
    func isActive(route: Route, panelPresented: Bool, pane: RightPanelPane) -> Bool {
        switch action {
        case .togglePanel(let target): panelPresented && pane == target
        case .navigate(let target): route == target
        case .brandSettings, .pairPhone, .moreMenu: false
        }
    }
}

/// The right panel's header, drawn in the top bar above the panel.
struct PanelHeader: Equatable {
    enum Action: Equatable {
        /// "Bitenleri temizle" (jobs pane).
        case clearFinished
        case expand
        case collapse
        case close

        var symbol: String {
            switch self {
            case .clearFinished: "trash"
            case .expand: "arrow.up.left.and.arrow.down.right"
            case .collapse: "arrow.down.right.and.arrow.up.left"
            case .close: "xmark"
            }
        }

        var help: String {
            switch self {
            case .clearFinished: "Biten işleri listeden temizle"
            case .expand: "Paneli genişlet"
            case .collapse: "Paneli daralt"
            case .close: "Paneli kapat (⌥⌘I)"
            }
        }
    }

    var title: String
    var actions: [Action]
    /// Trash is greyed out while there is nothing finished to clear.
    var clearEnabled: Bool

    static func make(pane: RightPanelPane, expanded: Bool, finishedCount: Int) -> PanelHeader {
        let size: Action = expanded ? .collapse : .expand
        switch pane {
        case .details:
            return PanelHeader(title: pane.title, actions: [size, .close], clearEnabled: false)
        case .jobs:
            return PanelHeader(title: pane.title, actions: [.clearFinished, size, .close], clearEnabled: finishedCount > 0)
        }
    }
}

/// Where the bar's segments go, from the split view's dividers (bar coordinates).
struct TopBarLayout: Equatable {
    /// The bar's width.
    var width: CGFloat
    /// Right edge of the sidebar (nil: collapsed).
    var sidebarMaxX: CGFloat?
    /// Left edge of the right panel (nil: closed).
    var panelMinX: CGFloat?
    /// Where the leading cluster (sidebar toggle, ‹ ›, mode pill) starts: after the traffic lights.
    var leadingInset: CGFloat
    /// Width of that cluster.
    var clusterWidth: CGFloat

    /// The title keeps this distance from the sidebar edge (Claude Code: ~20 pt) …
    static let titleGap: CGFloat = 12
    /// … and from the cluster when the sidebar is hidden.
    static let clusterGap: CGFloat = 14

    var centerMinX: CGFloat { sidebarMaxX ?? 0 }
    var centerMaxX: CGFloat { max(centerMinX, panelMinX ?? width) }

    /// The title control's leading edge, relative to the centre segment.
    var titleLeading: CGFloat {
        let afterCluster = leadingInset + clusterWidth + Self.clusterGap
        return max(Self.titleGap, afterCluster - centerMinX)
    }

    var sidebarFrameWidth: CGFloat { sidebarMaxX ?? 0 }
    var panelWidth: CGFloat { panelMinX.map { max(0, width - $0) } ?? 0 }
}

/// Traffic lights → cluster spacing (the toggle sits ~21 pt after the zoom button's centre).
enum TopBarMetrics {
    static let buttonSize: CGFloat = 28
    static let iconPointSize: CGFloat = 14
    /// After the zoom button's right edge.
    static let afterTrafficLights: CGFloat = 7
    /// No traffic lights (full screen) or no window yet.
    static let bareInset: CGFloat = 10
    /// Compact title bar's zoom button right edge when no window is around (tests); the bar
    /// measures the real one.
    static let defaultZoomMaxX: CGFloat = 72
    static let pillWidth: CGFloat = 70
    static let pillHeight: CGFloat = 28
    static let pillGap: CGFloat = 20
}
