import AppKit
import StudioKit

// The top bar in the Claude Code layout, as plain values (tested without views):
//
//   ● ● ●  ▤  ‹  ›  [💬|▦]  │ Kasım planı ⌄            ≡  ◷  ▦  ▣  ⌂  ▯  …  │ Arka plan işleri   🗑 ⤢ ✕
//   └──────── over the sidebar ───────┘ └───────────── over the content ─────────────┘ └──── over the right panel ────┘
//
// One continuous bar, hairline below the content and the panel, the sidebar column running up
// into it. The panel's own title and actions live in the bar above the panel.

/// What a top bar icon does. Claude Code: every icon swaps the right panel; none of them
/// replaces the centre (the conversation stays).
enum TopBarAction: Equatable {
    /// Open this pane of the right panel, or close the panel when it already shows it.
    case togglePanel(RightPanelPane)
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
        case .more: "Diğer seçenekler"
        default: pane?.title ?? ""
        }
    }

    var help: String {
        switch self {
        case .details: "Ayrıntılar: ortam, kullanım, bağlam ve hesaplar (⌥⌘I)"
        case .jobs: "Arka plan işleri"
        case .calendar: "Takvim: ay görünümü ve günün yayınları"
        case .media: "Medya: markanın görselleri; sohbete sürükleyip ekle"
        case .brand: "Marka: logo, renkler, yazı tipleri, ses tonu ve platformlar"
        case .phone: "iPhone: QR kodla bağla, bağlı iPhone'lar"
        case .more: "Diğer seçenekler"
        }
    }

    /// The right panel's pane this icon opens (nil: the "…" menu).
    var pane: RightPanelPane? {
        switch self {
        case .details: .details
        case .jobs: .jobs
        case .calendar: .calendar
        case .media: .media
        case .brand: .brand
        case .phone: .phone
        case .more: nil
        }
    }

    var action: TopBarAction {
        pane.map { .togglePanel($0) } ?? .moreMenu
    }

    /// Drawn with the rounded "open" fill: its pane is showing.
    func isActive(panelPresented: Bool, pane shown: RightPanelPane) -> Bool {
        guard let pane else { return false }
        return panelPresented && shown == pane
    }
}

/// The right panel's header, drawn in the top bar above the panel.
struct PanelHeader: Equatable {
    enum Action: Equatable {
        /// "Bitenleri temizle" (jobs pane).
        case clearFinished
        /// Reload the pane's data (Takvim).
        case refresh
        /// Upload files to the brand's media (Medya).
        case upload
        /// The brand's settings sheet (Marka).
        case brandSettings
        case expand
        case collapse
        case close

        var symbol: String {
            switch self {
            case .clearFinished: "trash"
            case .refresh: "arrow.clockwise"
            case .upload: "plus"
            case .brandSettings: "gearshape"
            case .expand: "arrow.up.left.and.arrow.down.right"
            case .collapse: "arrow.down.right.and.arrow.up.left"
            case .close: "xmark"
            }
        }

        var help: String {
            switch self {
            case .clearFinished: "Biten işleri listeden temizle"
            case .refresh: "Yenile"
            case .upload: "Medya yükle"
            case .brandSettings: "Marka ayarları (⇧⌘B)"
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
        case .details, .phone:
            return PanelHeader(title: pane.title, actions: [size, .close], clearEnabled: false)
        case .jobs:
            return PanelHeader(title: pane.title, actions: [.clearFinished, size, .close], clearEnabled: finishedCount > 0)
        case .calendar:
            return PanelHeader(title: pane.title, actions: [.refresh, size, .close], clearEnabled: false)
        case .media:
            return PanelHeader(title: pane.title, actions: [.upload, size, .close], clearEnabled: false)
        case .brand:
            return PanelHeader(title: pane.title, actions: [.brandSettings, size, .close], clearEnabled: false)
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
