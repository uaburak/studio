import Foundation

// Two per-brand settings shown under Marka Kiti, saved as you go:
// - content-check.ts "brand settings": which generation checks run, banned words, strictness and
//   automatic fixes (`/api/brands/{id}/check-settings`);
// - planning.ts / special-days.ts: the brand's sector tags and switched-off special-day
//   categories (`/api/brands/{id}/planning-settings`) and the bayram date corrections every brand
//   shares (`/api/special-days/overrides`).

// MARK: - Checks

/// `GET /api/brands/{id}/check-settings` (defaults with `updatedAt: nil` until saved once).
public struct BrandCheckSettings: Codable, Sendable, Hashable {
    public var brandId: EntityID
    /// Switched-off checks (every other check runs).
    public var disabledChecks: [String]
    /// Words that must not appear in the caption or slide texts.
    public var bannedWords: [String]
    public var strictness: CheckStrictness
    /// Fix fixable findings right after a generation (a new version).
    public var autoFix: Bool
    public var updatedAt: Date?

    public init(brandId: EntityID, disabledChecks: [String] = [], bannedWords: [String] = [], strictness: CheckStrictness = .standard, autoFix: Bool = true, updatedAt: Date? = nil) {
        self.brandId = brandId
        self.disabledChecks = disabledChecks
        self.bannedWords = bannedWords
        self.strictness = strictness
        self.autoFix = autoFix
        self.updatedAt = updatedAt
    }

    /// The PUT body (unknown check ids and strictness are not sent back).
    public var put: BrandCheckSettingsPut {
        BrandCheckSettingsPut(
            disabledChecks: CheckCatalog.ids.filter { disabledChecks.contains($0) },
            bannedWords: bannedWords,
            strictness: strictness == .unknown ? .standard : strictness,
            autoFix: autoFix)
    }

    public func isEnabled(_ id: String) -> Bool { !disabledChecks.contains(id) }
}

public struct BrandCheckSettingsPut: Codable, Sendable, Equatable {
    public var disabledChecks: [String]
    public var bannedWords: [String]
    public var strictness: CheckStrictness
    public var autoFix: Bool

    public init(disabledChecks: [String], bannedWords: [String], strictness: CheckStrictness, autoFix: Bool) {
        self.disabledChecks = disabledChecks
        self.bannedWords = bannedWords
        self.strictness = strictness
        self.autoFix = autoFix
    }
}

extension CheckStrictness {
    public var label: String {
        switch self {
        case .relaxed: "Esnek"
        case .standard: "Standart"
        case .strict: "Sıkı"
        case .unknown: "Bilinmiyor"
        }
    }

    /// The desktop's `STRICTNESS_OPTIONS` detail line.
    public var detail: String {
        switch self {
        case .relaxed: "Kozmetik uyarılar gizlenir; dil ve marka bulguları yalnızca uyarıdır."
        case .standard: "Başarısız kontroller onaydan önce sorulur, uyarılar listede kalır."
        case .strict: "Uyarılar da onaydan önce sorulur."
        case .unknown: ""
        }
    }
}

/// `CHECK_CATALOG`: every check with its category, Turkish label and line.
public enum CheckCatalog {
    public struct Check: Sendable, Hashable, Identifiable {
        public var id: String
        public var category: CheckCategory
        public var label: String
        public var description: String
        /// Rules on the render (`deterministic`), the model pass (`model`) or both.
        public var source: String
        public var fixable: Bool

        /// "Kural", "AI", "Kural + AI" (`sourceLabel`).
        public var sourceLabel: String {
            switch source {
            case "model": "AI"
            case "both": "Kural + AI"
            default: "Kural"
            }
        }
    }

    public static let maxBannedWords = 100

    public static let all: [Check] = [
        Check(id: "brief.completeness", category: .brief, label: "Brief eksiksiz", description: "Brief, hedef platform ve görsel yuvaları tasarım için yeterli.", source: "deterministic", fixable: false),
        Check(id: "brand.colors", category: .brand, label: "Marka renkleri", description: "Renkler marka kiti ve token'lardan geliyor.", source: "deterministic", fixable: false),
        Check(id: "brand.fonts", category: .brand, label: "Marka fontları", description: "Metinler marka fontlarıyla yazılı ve fontlar yüklü.", source: "deterministic", fixable: false),
        Check(id: "brand.logo", category: .brand, label: "Logo kullanımı", description: "Logo kitteki dosyadan, boşluk alanı korunmuş, üzerine metin binmiyor.", source: "deterministic", fixable: false),
        Check(id: "brand.voice", category: .brand, label: "Ses tonu ve skill kuralları", description: "Metinler markanın ses tonuna ve skill kurallarına uyuyor.", source: "model", fixable: false),
        Check(id: "layout.overflow", category: .layout, label: "Metin taşması", description: "Metin kutusuna sığıyor, kesilmiyor, başka metinle çakışmıyor.", source: "deterministic", fixable: true),
        Check(id: "layout.safe-area", category: .layout, label: "Güvenli alan", description: "Metin ve logo platformun güvenli alanında (story / Reels arayüzü altında kalmıyor).", source: "deterministic", fixable: true),
        Check(id: "layout.contrast", category: .layout, label: "Okunabilirlik kontrastı", description: "Metin arka planına karşı WCAG kontrastını sağlıyor (4.5:1, büyük metin 3:1).", source: "deterministic", fixable: true),
        Check(id: "layout.legibility", category: .layout, label: "Yazı boyutu", description: "Metinler telefonda okunacak büyüklükte, Türkçe harfler satırlara çarpmıyor.", source: "deterministic", fixable: false),
        Check(id: "layout.consistency", category: .layout, label: "Carousel tutarlılığı", description: "Logo, sayaç ve fontlar her slaytta aynı yerde ve doğru; slaytlar aynı boyutta.", source: "deterministic", fixable: false),
        Check(id: "text.caption-length", category: .text, label: "Açıklama uzunluğu", description: "Açıklama her hedef platformun karakter sınırında.", source: "deterministic", fixable: true),
        Check(id: "text.hashtags", category: .text, label: "Hashtag'ler", description: "Hashtag sayısı platform sınırında, tekrar yok.", source: "deterministic", fixable: true),
        Check(id: "text.banned-words", category: .text, label: "Yasak kelimeler", description: "Markanın yasak kelime listesindeki ifadeler geçmiyor.", source: "deterministic", fixable: false),
        Check(id: "text.language", category: .text, label: "Yazım ve dil bilgisi", description: "Türkçe yazım, noktalama ve dil bilgisi.", source: "model", fixable: false),
        Check(id: "accuracy.products", category: .accuracy, label: "Ürün adları", description: "Ürün adları ve özellikleri Ürünler listesiyle uyumlu.", source: "model", fixable: false),
        Check(id: "accuracy.claims", category: .accuracy, label: "İddialar ve rakamlar", description: "Rakamlar ve iddialar markanın doğrulanmış bilgilerinde var.", source: "model", fixable: false),
        Check(id: "visual.resolution", category: .visual, label: "Çözünürlük", description: "Görseller yeterli çözünürlükte, yükleniyor ve dosya platform sınırında.", source: "deterministic", fixable: false),
        Check(id: "visual.distortion", category: .visual, label: "Bozulma", description: "Görseller esnetilmemiş, yuvalar oranlarına uygun.", source: "deterministic", fixable: false),
        Check(id: "visual.logo-legibility", category: .visual, label: "Logo okunurluğu", description: "Logo okunacak büyüklükte.", source: "deterministic", fixable: false),
    ]

    public static var ids: [String] { all.map(\.id) }

    /// Checks grouped by category, in step order.
    public static var byCategory: [(category: CheckCategory, checks: [Check])] {
        CheckCategory.knownCases.sorted { $0.step < $1.step }.map { category in
            (category, all.filter { $0.category == category })
        }
    }

    /// Typed words added to the list: split on commas / new lines, trimmed, without duplicates
    /// (Turkish case folded), at most `maxBannedWords` (`addBannedWords`).
    public static func addBannedWords(_ list: [String], typed: String) -> [String] {
        var out = list
        var seen = Set(out.map { $0.lowercased(with: Locale(identifier: "tr_TR")) })
        for raw in typed.split(whereSeparator: { $0 == "," || $0 == "\n" || $0 == ";" }) {
            let word = String(raw.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(60))
            guard !word.isEmpty else { continue }
            let key = word.lowercased(with: Locale(identifier: "tr_TR"))
            guard !seen.contains(key), out.count < maxBannedWords else { continue }
            seen.insert(key)
            out.append(word)
        }
        return out
    }

    /// Switch a set of checks on or off (a category's switch passes all of its checks).
    public static func toggle(_ disabled: [String], checks: [String], on: Bool) -> [String] {
        on ? disabled.filter { !checks.contains($0) } : disabled + checks.filter { !disabled.contains($0) }
    }
}

// MARK: - Special days

/// `SpecialDayCategory`.
public enum SpecialDayCategory: String, OpenEnum {
    case resmi, dini, anma, ticari, toplumsal, sektor
    case unknown

    public var label: String {
        switch self {
        case .resmi: "Resmî tatiller ve millî bayramlar"
        case .dini: "Dinî bayramlar ve günler"
        case .anma: "Anma günleri"
        case .ticari: "Ticari günler"
        case .toplumsal: "Toplumsal günler"
        case .sektor: "Sektör günleri"
        case .unknown: "Diğer"
        }
    }

    /// Examples of the category's days (`CATEGORY_EXAMPLES`).
    public var examples: String {
        switch self {
        case .resmi: "Yılbaşı, 23 Nisan, 19 Mayıs, 30 Ağustos, 29 Ekim"
        case .dini: "Ramazan ve Kurban Bayramı, kandiller, Ramazan'ın başlangıcı"
        case .anma: "10 Kasım, 18 Mart, 6 Şubat"
        case .ticari: "Sevgililer Günü, Anneler Günü, 11.11, Black Friday, yılbaşı gecesi"
        case .toplumsal: "Kadınlar Günü, Öğretmenler Günü"
        case .sektor: "Seçtiğin sektörlerin günleri (ör. Dünya Çiftçiler Günü)"
        case .unknown: ""
        }
    }
}

/// `SectorTag`: which sector days a brand's plan and calendar show.
public enum SectorTag: String, OpenEnum {
    case tarim, gida, saglik, egitim, teknoloji, cevre, moda, eticaret, evcil, turizm, finans, spor, insaat, hukuk, kultur
    case unknown

    public var label: String {
        switch self {
        case .tarim: "Tarım"
        case .gida: "Gıda ve içecek"
        case .saglik: "Sağlık"
        case .egitim: "Eğitim"
        case .teknoloji: "Teknoloji"
        case .cevre: "Çevre"
        case .moda: "Moda ve güzellik"
        case .eticaret: "Perakende ve e-ticaret"
        case .evcil: "Evcil hayvan"
        case .turizm: "Turizm"
        case .finans: "Finans"
        case .spor: "Spor"
        case .insaat: "Mimarlık ve inşaat"
        case .hukuk: "Hukuk"
        case .kultur: "Kültür ve sanat"
        case .unknown: "Diğer"
        }
    }
}

/// `GET /api/brands/{id}/planning-settings` (defaults with `updatedAt: nil` until saved once).
public struct BrandPlanningSettings: Codable, Sendable, Hashable {
    public var brandId: EntityID
    public var sectorTags: [SectorTag]
    public var disabledCategories: [SpecialDayCategory]
    /// Tags guessed from the brand profile and products.
    public var suggestedTags: [SectorTag]
    public var updatedAt: Date?

    public init(brandId: EntityID, sectorTags: [SectorTag] = [], disabledCategories: [SpecialDayCategory] = [], suggestedTags: [SectorTag] = [], updatedAt: Date? = nil) {
        self.brandId = brandId
        self.sectorTags = sectorTags
        self.disabledCategories = disabledCategories
        self.suggestedTags = suggestedTags
        self.updatedAt = updatedAt
    }

    /// The tags in effect: the owner's once saved, the suggestion before (`effectiveSectorTags`).
    public var effectiveTags: [SectorTag] { updatedAt == nil ? suggestedTags : sectorTags }

    /// The tags are the profile's suggestion, never saved yet.
    public var isSuggestion: Bool { updatedAt == nil && !suggestedTags.isEmpty }
}

/// `PUT /api/brands/{id}/planning-settings` (in catalogue order).
public struct BrandPlanningSettingsPut: Codable, Sendable, Equatable {
    public var sectorTags: [SectorTag]
    public var disabledCategories: [SpecialDayCategory]

    public init(tags: Set<SectorTag>, disabled: Set<SpecialDayCategory>) {
        sectorTags = SectorTag.knownCases.filter { tags.contains($0) }
        disabledCategories = SpecialDayCategory.knownCases.filter { disabled.contains($0) }
    }
}

/// An owner's correction of a year's bayram first days (`YYYY-MM-DD`; nil = the computed one).
public struct ReligiousDayOverride: Codable, Sendable, Hashable {
    public var year: Int
    public var ramazanBayrami: String?
    public var kurbanBayrami: String?

    public init(year: Int, ramazanBayrami: String? = nil, kurbanBayrami: String? = nil) {
        self.year = year
        self.ramazanBayrami = ramazanBayrami
        self.kurbanBayrami = kurbanBayrami
    }

    /// Encodes nils as `null` (the contract's shape).
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(year, forKey: .year)
        try c.encode(ramazanBayrami, forKey: .ramazanBayrami)
        try c.encode(kurbanBayrami, forKey: .kurbanBayrami)
    }
}

/// `GET /api/special-days/overrides` (every brand).
public struct SpecialDayOverrides: Codable, Sendable, Hashable {
    public var overrides: [ReligiousDayOverride]
    public var updatedAt: Date?

    public init(overrides: [ReligiousDayOverride] = [], updatedAt: Date? = nil) {
        self.overrides = overrides
        self.updatedAt = updatedAt
    }
}

/// One special day as `GET /api/special-days` lists it (the fields the phone reads).
public struct SpecialDay: Codable, Sendable, Hashable, Identifiable {
    /// `<ruleId>-<YYYY>`.
    public var id: String
    public var ruleId: String
    /// First day, `YYYY-MM-DD`.
    public var date: String
    public var days: Int
    public var name: String
    public var category: SpecialDayCategory
    /// Computed from the Hijri calendar and not confirmed by Diyanet or an override (±1 day).
    public var approximate: Bool

    public init(id: String, ruleId: String, date: String, days: Int = 1, name: String, category: SpecialDayCategory, approximate: Bool = false) {
        self.id = id
        self.ruleId = ruleId
        self.date = date
        self.days = days
        self.name = name
        self.category = category
        self.approximate = approximate
    }
}

public struct SpecialDayList: Codable, Sendable, Hashable {
    public var days: [SpecialDay]

    public init(days: [SpecialDay]) { self.days = days }
}

/// The bayram rows of Marka Kiti → Özel günler: one year's first days as they are in effect,
/// whether the owner corrected them, and whether they are only computed (±1 day).
public struct BayramYear: Sendable, Hashable {
    public enum Which: String, Sendable, CaseIterable {
        case ramazan = "ramazan-bayrami"
        case kurban = "kurban-bayrami"

        public var label: String { self == .ramazan ? "Ramazan Bayramı" : "Kurban Bayramı" }
    }

    public var year: Int
    public var ramazan: String?
    public var kurban: String?
    public var ramazanCorrected: Bool
    public var kurbanCorrected: Bool
    public var approximate: Bool

    public init(year: Int, ramazan: String?, kurban: String?, ramazanCorrected: Bool = false, kurbanCorrected: Bool = false, approximate: Bool = false) {
        self.year = year
        self.ramazan = ramazan
        self.kurban = kurban
        self.ramazanCorrected = ramazanCorrected
        self.kurbanCorrected = kurbanCorrected
        self.approximate = approximate
    }

    public func date(_ which: Which) -> String? { which == .ramazan ? ramazan : kurban }
    public func corrected(_ which: Which) -> Bool { which == .ramazan ? ramazanCorrected : kurbanCorrected }

    /// A year's row from its special days (overrides already applied by the API).
    public static func from(year: Int, days: [SpecialDay], overrides: [ReligiousDayOverride]) -> BayramYear {
        let own = overrides.first { $0.year == year }
        let ramazan = days.first { $0.ruleId == Which.ramazan.rawValue && $0.date.hasPrefix("\(year)-") }
        let kurban = days.first { $0.ruleId == Which.kurban.rawValue && $0.date.hasPrefix("\(year)-") }
        return BayramYear(
            year: year,
            ramazan: own?.ramazanBayrami ?? ramazan?.date,
            kurban: own?.kurbanBayrami ?? kurban?.date,
            ramazanCorrected: own?.ramazanBayrami != nil,
            kurbanCorrected: own?.kurbanBayrami != nil,
            approximate: (ramazan?.approximate ?? false) || (kurban?.approximate ?? false))
    }

    /// The overrides with one first day set (a date) or cleared (nil: back to the computed one);
    /// a year left with no correction drops out.
    public static func setting(_ which: Which, of year: Int, to date: String?, in overrides: [ReligiousDayOverride]) -> [ReligiousDayOverride] {
        var row = overrides.first { $0.year == year } ?? ReligiousDayOverride(year: year)
        if which == .ramazan { row.ramazanBayrami = date } else { row.kurbanBayrami = date }
        var out = overrides.filter { $0.year != year }
        if row.ramazanBayrami != nil || row.kurbanBayrami != nil { out.append(row) }
        return out.sorted { $0.year < $1.year }
    }
}
