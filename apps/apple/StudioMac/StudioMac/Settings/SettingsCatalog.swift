import Foundation

/// Settings sections in sidebar order (Claude-desktop style: icon + label, thin
/// separators between groups). Pure model: no views, testable without a window.
enum SettingsSection: String, CaseIterable, Sendable {
    case brands
    case usage
    case appearance
    case ai
    case notifications
    case accounts
    case publishing
    case devices
    case macServer
    case about

    /// First open (nothing remembered yet).
    static let `default`: SettingsSection = .brands

    var title: String {
        switch self {
        case .brands: "Markalar"
        case .usage: "Kullanım"
        case .appearance: "Görünüm"
        case .ai: "Yapay zekâ"
        case .notifications: "Bildirimler"
        case .accounts: "Hesaplar"
        case .publishing: "Yayın"
        case .macServer: "Gelişmiş"
        case .devices: "Cihazlar"
        case .about: "Hakkında"
        }
    }

    /// SF Symbol (line style) for the sidebar row.
    var symbol: String {
        switch self {
        case .brands: "square.stack"
        case .usage: "gauge.with.dots.needle.33percent"
        case .appearance: "circle.lefthalf.filled"
        case .ai: "sparkles"
        case .notifications: "bell"
        case .accounts: "person.2"
        case .publishing: "paperplane"
        case .macServer: "gearshape.2"
        case .devices: "iphone"
        case .about: "info.circle"
        }
    }

    /// Sidebar group; a separator sits between groups.
    var group: Int {
        switch self {
        case .brands, .usage: 0
        case .appearance, .ai, .notifications: 1
        case .accounts, .publishing: 2
        case .devices, .macServer, .about: 3
        }
    }

    /// Extra words a search for the whole section may use.
    var keywords: String {
        switch self {
        case .brands: "marka brand"
        case .usage: "limit kota sınır yüzde"
        case .appearance: "tema açık koyu karanlık mod"
        case .ai: "claude gemini model efor"
        case .notifications: "bildirim uyarı"
        case .accounts: "instagram facebook linkedin meta sosyal"
        case .publishing: "bulut yayıncı zamanlama"
        case .macServer: "mac sunucusu sunucu api worker ağ tünel adres port"
        case .devices: "telefon iphone eşleştir bağla qr kod"
        case .about: "sürüm versiyon"
        }
    }

    var searchText: String { "\(title) \(keywords)" }

    /// Sections split into sidebar groups, in order.
    static var groups: [[SettingsSection]] {
        var result: [[SettingsSection]] = []
        for section in allCases {
            if let last = result.last?.last, last.group == section.group {
                result[result.count - 1].append(section)
            } else {
                result.append([section])
            }
        }
        return result
    }
}

/// One fixed settings row: what the row says and what search matches.
/// Rows built from lists (brands, accounts, devices) carry their own text.
struct SettingsItem: Hashable, Sendable {
    let id: String
    let section: SettingsSection
    let title: String
    let detail: String
    let keywords: String

    init(_ id: String, _ section: SettingsSection, _ title: String, _ detail: String = "", keywords: String = "") {
        self.id = id
        self.section = section
        self.title = title
        self.detail = detail
        self.keywords = keywords
    }

    var searchText: String { "\(title) \(detail) \(keywords)" }
}

/// Every fixed row of the settings sheet. Panes build their rows from these, so the
/// sidebar search and the rows on screen use the same words.
enum SettingsCatalog {
    // Markalar
    static let newBrand = SettingsItem("brands.new", .brands, "Yeni marka", "Ad, dil ve ses tonuyla yeni bir marka oluştur.", keywords: "ekle oluştur")

    // Kullanım
    static let claudeUsage = SettingsItem("usage.claude", .usage, "Claude aboneliği", "Claude Code'un bildirdiği 5 saatlik ve haftalık kullanım.", keywords: "haftalık sıfırlanma")

    // Görünüm
    static let theme = SettingsItem("appearance.theme", .appearance, "Tema", "Sistem, macOS ayarını izler. ⇧⌘L ile de değişir.", keywords: "dark light")
    static let ownerName = SettingsItem("appearance.name", .appearance, "Adın", "Kenar çubuğunda görünür. Boş bırakırsan Claude hesabındaki adın kullanılır.", keywords: "isim ad profil selam")

    // Yapay zekâ
    static let defaultModel = SettingsItem("ai.model", .ai, "Varsayılan model", "Yeni sohbetler bu modelle başlar; sohbette değiştirilebilir.", keywords: "opus sonnet haiku flash pro")
    static let defaultEffort = SettingsItem("ai.effort", .ai, "Varsayılan efor", "Yeni sohbetlerde düşünme düzeyi.", keywords: "düşük orta yüksek effort")
    static let claude = SettingsItem("ai.claude", .ai, "Claude Code", "Opus, Sonnet ve Haiku için bu Mac'teki Claude girişi kullanılır.", keywords: "giriş oturum hesap abonelik login cli")
    static let gemini = SettingsItem("ai.gemini", .ai, "Gemini", "Depodaki .env içindeki GEMINI_API_KEY ya da Gemini CLI otomatik algılanır.", keywords: "api key cli anahtar")

    // Bildirimler
    static let notifications = SettingsItem("notifications.enabled", .notifications, "macOS bildirimleri", "Yayınlandı / yayınlanamadı, uzun süren işler ve süresi dolmak üzere olan hesaplar.", keywords: "bildirim")
    static let notificationPermission = SettingsItem("notifications.permission", .notifications, "macOS izni kapalı", "Sistem Ayarları → Bildirimler → Studio'dan aç.", keywords: "izin")

    // Hesaplar
    static let accountsBrand = SettingsItem("accounts.brand", .accounts, "Marka", "Hesapları gösterilen marka.")
    static let connectMeta = SettingsItem("accounts.connectMeta", .accounts, "Instagram ve Facebook", "Tarayıcıda Facebook girişi açılır.", keywords: "bağla hesap ekle")
    static let connectLinkedIn = SettingsItem("accounts.connectLinkedIn", .accounts, "LinkedIn", "Tarayıcıda LinkedIn girişi açılır.", keywords: "bağla hesap ekle")
    static let metaApp = SettingsItem("accounts.metaApp", .accounts, "Meta uygulaması", "Instagram ve Facebook için kendi Meta uygulaman.", keywords: "app id secret kimlik")
    static let linkedInApp = SettingsItem("accounts.linkedInApp", .accounts, "LinkedIn uygulaması", "LinkedIn'e yayın için kendi LinkedIn uygulaman.", keywords: "client id secret")
    static let forgetMetaSecret = SettingsItem("accounts.forgetMetaSecret", .accounts, "Meta App Secret'ı sil", "Bağlantılar bundan sonra ~1 saat geçerli olur.", keywords: "anahtar kaldır")

    // Yayın
    static let publisher = SettingsItem("publishing.mode", .publishing, "Yayını yapan", "", keywords: "mac bulut")
    static let lastSync = SettingsItem("publishing.sync", .publishing, "Son eşitleme", "", keywords: "eşitleme hata kasa")
    static let cloudPublisher = SettingsItem("publishing.cloud", .publishing, "Bulut yayıncı", "Mac kapalıyken de zamanında paylaşır. Instagram ve Facebook görselleri için gerekir.", keywords: "cloudflare worker PUBLISHER_TOKEN adres")
    static let removeCloudPublisher = SettingsItem("publishing.remove", .publishing, "Bulut yayıncıyı kaldır", "Bundan sonra yayını bu Mac yapar.", keywords: "sil")

    // Mac sunucusu
    static let hostEnabled = SettingsItem("macServer.host", .macServer, "Studio sunucusu", "API ve worker'ı bu uygulama çalıştırır. Kapalıysa harici sunucuya bağlanır.", keywords: "api worker")
    static let hostStatus = SettingsItem("macServer.status", .macServer, "Durum", "", keywords: "yeniden başlat")
    static let lan = SettingsItem("macServer.lan", .macServer, "Yerel ağdan erişim", "", keywords: "lan bonjour wifi telefon")
    static let repo = SettingsItem("macServer.repo", .macServer, "Depo klasörü", "API ve worker bu klasörden çalışır (pnpm install yapılmış olmalı).", keywords: "repo yol")
    static let remote = SettingsItem("macServer.remote", .macServer, "Uzaktan erişim", "", keywords: "cloudflare tunnel tünel remote control ev dışı")
    static let tunnel = SettingsItem("macServer.tunnel", .macServer, "Tünel adresi ve anahtarı", "Anahtar (CLOUDFLARE_TUNNEL_TOKEN) Anahtar Zinciri'nde saklanır.", keywords: "cloudflare tunnel hostname token")
    static let errorLog = SettingsItem("macServer.errorLog", .macServer, "Hata kaydı", "API, worker ve tünelin son hata çıktıları.", keywords: "log")
    static let logsFolder = SettingsItem("macServer.logs", .macServer, "Kayıt klasörü", "API, worker ve tünel günlükleri.", keywords: "log günlük")
    static let serverURL = SettingsItem("macServer.serverURL", .macServer, "Sunucu adresi", "Studio sunucusu kapalıyken bağlanılan API.", keywords: "url bağlantı harici")
    static let access = SettingsItem("macServer.access", .macServer, "Cloudflare Access", "Sunucu Access arkasındaysa servis anahtarı. Anahtar Zinciri'nde saklanır.", keywords: "client id secret token anahtar güvenlik")
    static let forgetTunnel = SettingsItem("macServer.forgetTunnel", .macServer, "Tünel anahtarını sil", "Uzaktan erişim yeni anahtar girilene kadar çalışmaz.", keywords: "kaldır")
    static let forgetAccess = SettingsItem("macServer.forgetAccess", .macServer, "Access anahtarını sil", "Access arkasındaki harici sunucuya bağlanılamaz.", keywords: "kaldır cloudflare")

    // Cihazlar
    static let pairPhone = SettingsItem("devices.pair", .devices, "iPhone'u bağla", "iPhone'daki Studio ile QR kodu okut; kod tek kullanımlık.", keywords: "eşleştir iphone kod qr telefon ekle")

    // Hakkında
    static let version = SettingsItem("about.version", .about, "Sürüm", "", keywords: "versiyon")
    static let dataFolder = SettingsItem("about.data", .about, "Veri klasörü", "Veritabanı, medya ve kayıtlar bu Mac'te durur.", keywords: "data")
    static let onboarding = SettingsItem("about.onboarding", .about, "Başlangıç rehberi", "Kurulum adımlarını yeniden göster.", keywords: "kurulum onboarding")
    static let shortcuts = SettingsItem("about.shortcuts", .about, "Klavye kısayolları", "⇧⌘/ ile de açılır.", keywords: "kısayol")

    static let items: [SettingsItem] = [
        newBrand,
        claudeUsage,
        theme, ownerName,
        defaultModel, defaultEffort, claude, gemini,
        notifications, notificationPermission,
        accountsBrand, connectMeta, connectLinkedIn, metaApp, linkedInApp, forgetMetaSecret,
        publisher, lastSync, cloudPublisher, removeCloudPublisher,
        hostEnabled, hostStatus, lan, repo, remote, tunnel, errorLog, logsFolder, serverURL, access, forgetTunnel, forgetAccess,
        pairPhone,
        version, dataFolder, onboarding, shortcuts,
    ]
}

/// Search across every section: Turkish-aware, case and accent folding
/// ("gorunum" finds "Görünüm", "zeka" finds "zekâ"), every word must match.
enum SettingsSearch {
    private static let turkish = Locale(identifier: "tr_TR")

    static func normalize(_ text: String) -> String {
        text.lowercased(with: turkish)
            .folding(options: [.diacriticInsensitive, .widthInsensitive], locale: turkish)
            .replacingOccurrences(of: "ı", with: "i")
    }

    static func tokens(_ query: String) -> [String] {
        normalize(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// True when every word of `query` appears in `text` (an empty query matches).
    static func matches(_ query: String, in text: String) -> Bool {
        let words = tokens(query)
        guard !words.isEmpty else { return true }
        let haystack = normalize(text)
        return words.allSatisfy { haystack.contains($0) }
    }

    /// A row matches by its own words or its section's.
    static func matches(_ query: String, item: SettingsItem) -> Bool {
        matches(query, in: item.searchText) || matches(query, in: item.section.searchText)
    }

    static func matches(_ query: String, rowText: String, section: SettingsSection?) -> Bool {
        if matches(query, in: rowText) { return true }
        guard let section else { return false }
        return matches(query, in: section.searchText)
    }

    /// Fixed rows matching `query`, grouped by section in sidebar order.
    static func results(for query: String, in items: [SettingsItem] = SettingsCatalog.items) -> [(section: SettingsSection, items: [SettingsItem])] {
        guard !tokens(query).isEmpty else { return [] }
        return SettingsSection.allCases.compactMap { section in
            let hits = items.filter { $0.section == section && matches(query, item: $0) }
            return hits.isEmpty ? nil : (section, hits)
        }
    }
}

/// Remembers the last section shown; ⌘, opens there, deep links override it.
struct SettingsNavigation {
    static let lastSectionKey = "studio.settings.lastSection"

    let defaults: UserDefaults

    var lastSection: SettingsSection {
        get { defaults.string(forKey: Self.lastSectionKey).flatMap(SettingsSection.init(rawValue:)) ?? .default }
        nonmutating set { defaults.set(newValue.rawValue, forKey: Self.lastSectionKey) }
    }

    /// A deep link wins; otherwise the remembered section.
    func initialSection(requested: SettingsSection?) -> SettingsSection {
        requested ?? lastSection
    }
}

/// Panel size: as large as the reference layout, never larger than the window.
enum SettingsLayout {
    static let preferredSize = NSSize(width: 860, height: 640)
    static let minimumSize = NSSize(width: 680, height: 480)

    static func panelSize(fitting parent: NSSize?) -> NSSize {
        guard let parent, parent.width > 0, parent.height > 0 else { return preferredSize }
        return NSSize(
            width: max(minimumSize.width, min(preferredSize.width, parent.width - 120)),
            height: max(minimumSize.height, min(preferredSize.height, parent.height - 80))
        )
    }
}
