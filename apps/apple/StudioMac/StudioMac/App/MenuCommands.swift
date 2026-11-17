import Foundation
import StudioKit

/// Every command of the main menu that needs validation.
enum MenuCommand: Equatable {
    case newChat
    case search
    case settings
    case newBrand
    case brandSettings
    case brandKit
    case brandProfile
    /// ⌘1…⌘9, 0-based in `AppModel.brandMenuOrder`.
    case selectBrand(Int)
    case back
    case forward
    case posts
    case calendar
    case media
    case toggleSidebar
    case toggleInspector
    case appearance
    case reload
    case onboarding
    case shortcuts
    case revealLogs
}

/// What validation needs to know about the app (built from `AppModel` + the window).
struct MenuState: Equatable {
    var canGoBack = false
    var canGoForward = false
    var brandIds: [EntityID] = []
    var currentBrandId: EntityID?
    /// Brands the composer would let you switch to (attached images lock a new chat's brand).
    var switchableBrandIds: Set<EntityID> = []
    /// A sheet (settings, brand settings, onboarding…) covers the window.
    var sheetOpen = false
    /// The main window exists and is on screen.
    var hasWindow = true
    var isSample = false
    var isLoading = false
    /// Logs exist only when this app runs the Mac server.
    var hasHostLogs = false
}

enum MenuValidator {
    /// Commands that act on the main window are off while a sheet covers it, so a shortcut
    /// never opens a second sheet or changes the screen behind the one being edited.
    static func isEnabled(_ command: MenuCommand, in state: MenuState) -> Bool {
        switch command {
        case .appearance, .shortcuts:
            return true
        case .revealLogs:
            return state.hasHostLogs
        default:
            break
        }
        guard state.hasWindow, !state.sheetOpen else { return false }
        switch command {
        case .newChat, .search, .settings, .newBrand, .toggleSidebar, .toggleInspector, .posts, .calendar, .media:
            return true
        case .brandSettings, .brandKit, .brandProfile:
            return state.currentBrandId != nil
        case .selectBrand(let index):
            guard state.brandIds.indices.contains(index) else { return false }
            return state.switchableBrandIds.contains(state.brandIds[index])
        case .back:
            return state.canGoBack
        case .forward:
            return state.canGoForward
        case .reload:
            return !state.isLoading
        case .onboarding:
            return !state.isSample
        case .appearance, .shortcuts, .revealLogs:
            return true
        }
    }
}

/// The shortcut list (Yardım → Klavye kısayolları), kept next to the menu it documents.
enum ShortcutGuide {
    static let sections: [(String, [(String, String)])] = [
        ("Genel", [
            ("⌘N", "Yeni sohbet"),
            ("⌘F  ·  ⌘K", "Ara: sohbetler, postlar, markalar"),
            ("⌘,", "Ayarlar"),
            ("⌘R", "Yenile"),
            ("⌘1 … ⌘9", "Markaya geç"),
            ("⇧⌘N  ·  ⇧⌘B", "Yeni marka  ·  Marka ayarları"),
        ]),
        ("Gezinme", [
            ("⌘[  ·  ⌘]", "Geri  ·  İleri"),
            ("⇧⌘P  ·  ⇧⌘K  ·  ⇧⌘M", "Postlar  ·  Takvim  ·  Medya"),
            ("⌘\\  ·  ⌃⌘S", "Kenar çubuğu"),
            ("⌥⌘I", "Sağ panel: Ayrıntılar, işler, takvim, medya, marka, iPhone"),
            ("⇧⌘L", "Görünüm: Sistem → Açık → Koyu"),
            ("⌃⌘F", "Tam ekran"),
        ]),
        ("Sohbet", [
            ("↩  ·  ⇧↩", "Gönder  ·  Yeni satır"),
            ("@", "Görsel takma adı öner"),
            ("⌘V", "Görseli yapıştır (eklenir)"),
        ]),
        ("Postlar ve editör", [
            ("Oklar  ·  ↩  ·  boşluk", "Seç  ·  Aç  ·  Hızlı bakış"),
            ("⌘D  ·  ⌘E  ·  ⌫", "Çoğalt  ·  Dışa aktar  ·  Sil"),
            ("⌘Z  ·  ⇧⌘Z", "Geri al  ·  Yinele"),
            ("⌘↩  ·  ⌘W  ·  esc", "Onayla  ·  Kapat  ·  Seçimi kaldır"),
        ]),
    ]

    static var text: String {
        sections.map { title, rows in
            ([title] + rows.map { "\($0.0)   \($0.1)" }).joined(separator: "\n")
        }.joined(separator: "\n\n")
    }
}
