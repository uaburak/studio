import Foundation

// The brand screens as plain values (port of the desktop's brand-model.ts and templates-model.ts):
// what a brand's row and header say, the profile's design tokens as editable rows, the kit's
// checks, the new-brand form and the template fill form. Kept here so the phone and the tests
// share one copy.

// MARK: - Languages

public enum BrandLanguages {
    public static let all: [(tag: String, label: String)] = [
        ("tr", "Türkçe"), ("en", "İngilizce"), ("de", "Almanca"), ("fr", "Fransızca"),
        ("es", "İspanyolca"), ("it", "İtalyanca"), ("ar", "Arapça"), ("ru", "Rusça"),
    ]

    public static func label(_ tag: String) -> String {
        all.first { $0.tag == tag }?.label ?? tag
    }
}

// MARK: - Brand card

/// One platform's line under a brand: "@mtmagro", "Bağlı değil", "Yeniden bağla".
public struct BrandPlatformLine: Sendable, Hashable {
    public var platform: Platform
    public var value: String
    public var connected: Bool
    /// The owner has to act (reconnect, token trouble).
    public var needsOwner: Bool
    /// The account this line is about (nil: none).
    public var account: SocialAccount?
}

public struct BrandSwatch: Sendable, Hashable {
    public var name: String
    /// `#RRGGBB`.
    public var hex: String
}

/// What a brand's row and page header show (`brandCard`): the approved profile's tokens win over
/// the raw kit for colours and fonts.
public struct BrandOverview: Sendable, Hashable {
    public static let platforms: [Platform] = [.instagram, .facebook, .linkedin]
    public static let maxSwatches = 8
    public static let voiceLimit = 220

    public var name: String
    /// "mtm-agro · Türkçe".
    public var subtitle: String
    public var initials: String
    /// The logo for a light background (or the first one).
    public var logoAssetId: EntityID?
    /// "Onaylı profil · v3", "Taslak profil · v1", "Profil yok".
    public var profileLine: String
    public var swatches: [BrandSwatch]
    /// "Archivo (Başlık)", "Inter (Gövde)".
    public var fonts: [String]
    /// The voice text's opening (nil: no voice written yet).
    public var voice: String?
    public var platforms: [BrandPlatformLine]

    public init(brand: Brand, kit: BrandKit?, profile: BrandProfile?, accounts: [SocialAccount]) {
        let rows = profile.map { BrandTokens.rows($0.tokens) } ?? []
        var swatches: [BrandSwatch] = rows.filter { $0.kind == .color }.compactMap { row in
            BrandKitRules.normalizedHex(row.value).map { BrandSwatch(name: row.label, hex: $0) }
        }
        if swatches.isEmpty {
            swatches = (kit?.palette ?? []).compactMap { color in
                BrandKitRules.normalizedHex(color.hex).map { BrandSwatch(name: color.name, hex: $0) }
            }
        }
        var fonts = rows.filter { $0.path.last == "family" }.map { "\($0.value) (\($0.label.replacingOccurrences(of: " ailesi", with: "")))" }
        if fonts.isEmpty {
            var seen = Set<String>()
            fonts = (kit?.fonts ?? []).compactMap { font in
                let family = font.family.trimmingCharacters(in: .whitespaces)
                guard !family.isEmpty, seen.insert(family.lowercased()).inserted else { return nil }
                return font.role == .any ? family : "\(family) (\(BrandOverview.roleLabel(font.role)))"
            }
        }
        let logo = kit?.logos.first { $0.background != .dark } ?? kit?.logos.first
        let own = accounts.filter { $0.brandId == brand.id }
        name = brand.name
        subtitle = "\(brand.slug) · \(BrandLanguages.label(brand.defaultLanguage))"
        initials = Self.initials(brand.name)
        logoAssetId = logo?.assetId
        profileLine = Self.profileLine(profile)
        self.swatches = Array(swatches.prefix(Self.maxSwatches))
        self.fonts = fonts
        voice = profile.flatMap { Self.voiceSummary($0.voice) }
        platforms = Self.platforms.map { Self.platformLine($0, accounts: own) }
    }

    /// `FONT_ROLE_LABEL`: "Başlık", "Gövde", "Her ikisi".
    public static func roleLabel(_ role: BrandKitFontRole) -> String {
        switch role {
        case .display: "Başlık"
        case .text: "Gövde"
        default: "Her ikisi"
        }
    }

    /// "MTM Agro" → "MA", "Finvo" → "F".
    public static func initials(_ name: String) -> String {
        let words = name.split { !($0.isLetter || $0.isNumber) }
        let letters = words.prefix(2).compactMap { $0.first.map { String($0).uppercased(with: Locale(identifier: "tr_TR")) } }
        return letters.isEmpty ? "?" : letters.joined()
    }

    public static func profileLine(_ profile: BrandProfile?) -> String {
        guard let profile else { return "Profil yok" }
        return profile.status == .approved ? "Onaylı profil · v\(profile.version)" : "Taslak profil · v\(profile.version)"
    }

    /// The profile a card shows: the current (approved) one, else the newest (`cardProfile`).
    public static func cardProfile(_ profiles: [BrandProfile]) -> BrandProfile? {
        profiles.first { $0.isCurrent } ?? profiles.max { $0.version < $1.version }
    }

    /// The voice text's opening (markdown marks dropped), at most `voiceLimit` characters.
    public static func voiceSummary(_ voice: String) -> String? {
        let lines = voice.split(whereSeparator: \.isNewline).map { line -> String in
            var text = line.trimmingCharacters(in: .whitespaces)
            while let first = text.first, "#-*> ".contains(first) { text.removeFirst() }
            return text.trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
        let joined = lines.joined(separator: " ")
        guard !joined.isEmpty else { return nil }
        guard joined.count > voiceLimit else { return joined }
        let cut = String(joined.prefix(voiceLimit))
        if let end = cut.lastIndex(where: { ".!?".contains($0) }), cut.distance(from: cut.startIndex, to: end) > voiceLimit / 2 {
            return String(cut[...end])
        }
        return cut.trimmingCharacters(in: .whitespaces) + "…"
    }

    public static func platformLine(_ platform: Platform, accounts: [SocialAccount]) -> BrandPlatformLine {
        let candidates = accounts.filter { $0.platform == platform && $0.status != .disabled }
        guard let account = candidates.first(where: { $0.status == .connected }) ?? candidates.first else {
            return BrandPlatformLine(platform: platform, value: "Bağlı değil", connected: false, needsOwner: false, account: nil)
        }
        let handle = account.handle.trimmingCharacters(in: .whitespaces)
        let shown = handle.isEmpty ? "Bağlı" : (platform == .instagram && !handle.hasPrefix("@") ? "@\(handle)" : handle)
        switch account.status {
        case .connected:
            let trouble: Set<TokenHealthStatus> = [.expiringSoon, .invalid, .missingScopes]
            let needs = account.tokenHealth.map { trouble.contains($0) } ?? false
            return BrandPlatformLine(platform: platform, value: needs ? "Kontrol et" : shown, connected: true, needsOwner: needs, account: account)
        case .needsReauth:
            return BrandPlatformLine(platform: platform, value: "Yeniden bağla", connected: false, needsOwner: true, account: account)
        default:
            return BrandPlatformLine(platform: platform, value: "Bekliyor", connected: false, needsOwner: false, account: account)
        }
    }

    /// "3 hesap bağlı", "Hesap bağlı değil", "Instagram yeniden bağlanmalı".
    public static func platformsSummary(_ lines: [BrandPlatformLine]) -> (text: String, attention: Bool) {
        let trouble = lines.filter(\.needsOwner)
        if !trouble.isEmpty {
            return (trouble.map(\.platform.displayName).joined(separator: ", ") + " yeniden bağlanmalı", true)
        }
        let connected = lines.filter(\.connected).count
        return (connected == 0 ? "Hesap bağlı değil" : "\(connected) hesap bağlı", false)
    }

    /// Why "AI ile analiz et" cannot start, or nil (`analysisBlocker`).
    public static func analysisBlocker(brand: Brand, kit: BrandKit?, workerOnline: Bool) -> String? {
        if brand.status == .archived { return "Arşivlenmiş markada profil çıkarılamaz." }
        if let blocker = (kit ?? .empty(brand.id)).analysisBlocker { return blocker }
        if !workerOnline { return "Arka plan çalışmıyor; Studio hazır olunca profil çıkarılabilir." }
        return nil
    }

    /// Brands of the Etkin / Arşiv list (a search looks at both), by name.
    public static func shown(_ brands: [Brand], archived: Bool, query: String) -> [Brand] {
        let locale = Locale(identifier: "tr_TR")
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(with: locale)
        return brands
            .filter { brand in
                q.isEmpty
                    ? (brand.status == .archived) == archived
                    : [brand.name, brand.slug, BrandLanguages.label(brand.defaultLanguage)].contains { $0.lowercased(with: locale).contains(q) }
            }
            .sorted { $0.name.compare($1.name, locale: locale) == .orderedAscending }
    }

    /// New brand form → `BrandCreate`, or a Turkish reason (`newBrandInput`).
    public static func newBrandInput(name: String, slug: String, language: String) -> Result<BrandCreate, BrandFormProblem> {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty { return .failure(BrandFormProblem("Marka adı boş olamaz.")) }
        if n.count > 120 { return .failure(BrandFormProblem("Marka adı en fazla 120 karakter olabilir.")) }
        let typed = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        let s = (typed.isEmpty ? Brand.slugify(n) : typed).lowercased()
        if let problem = slugProblem(s) { return .failure(BrandFormProblem(problem)) }
        return .success(BrandCreate(name: n, slug: s, defaultLanguage: language.isEmpty ? "tr" : language))
    }

    /// Why a short name is refused, or nil: lowercase letters and digits with single dashes.
    public static func slugProblem(_ slug: String) -> String? {
        let parts = slug.split(separator: "-", omittingEmptySubsequences: false)
        let valid = slug.count >= 2 && !parts.contains { $0.isEmpty }
            && slug.unicodeScalars.allSatisfy { ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57) || $0 == "-" }
        return valid ? nil : "Kısa ad yalnızca küçük harf, rakam ve tek tire içerebilir."
    }
}

public struct BrandFormProblem: Error, Sendable, Equatable {
    public var message: String
    public init(_ message: String) { self.message = message }
}

// MARK: - Kit

extension BrandKitRules {
    /// File names that suggest a logo for dark backgrounds.
    public static func looksLikeNegativeLogo(_ filename: String) -> Bool {
        let lower = filename.lowercased(with: Locale(identifier: "tr_TR"))
        return ["negatif", "negative", "beyaz", "white", "dark", "koyu", "inverse", "ters"].contains { lower.contains($0) }
    }

    /// The next free colour name ("renk-1", "renk-2", …).
    public static func nextColorName(_ palette: [BrandKitColor]) -> String {
        let used = Set(palette.map(\.name))
        var index = 1
        while used.contains("renk-\(index)") { index += 1 }
        return "renk-\(index)"
    }

    /// The first reason the kit cannot be saved as it is (Turkish), or nil (`kitProblem`).
    public static func problem(_ kit: BrandKitPut) -> String? {
        var names = Set<String>()
        for color in kit.palette {
            let valid = color.name.count <= 48 && color.name.first.map { $0.isLetter && $0.isLowercase } == true
                && color.name.unicodeScalars.allSatisfy { ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57) || $0 == "-" }
            if !valid { return "“\(color.name.isEmpty ? "adsız" : color.name)” renk adı küçük harf, rakam ve tire içermeli." }
            if !names.insert(color.name).inserted { return "“\(color.name)” adı iki renkte kullanılmış." }
            if normalizedHex(color.hex) != color.hex.uppercased() || !color.hex.hasPrefix("#") {
                return "“\(color.name)” rengi #RRGGBB biçiminde olmalı."
            }
        }
        if kit.fonts.contains(where: { !isValidFamily($0.family) }) {
            return "Font adı yalnızca harf, rakam, boşluk ve tire içerebilir."
        }
        if kit.samples.count > BrandKit.maxSamples { return "En fazla \(BrandKit.maxSamples) örnek post görseli kullanılabilir." }
        return nil
    }

    /// "Tüm stiller" or "Regular · Demi Bold".
    public static func stylesLabel(_ font: BrandKitFont) -> String {
        font.styles.isEmpty ? "Tüm stiller" : font.styles.map(\.name).joined(separator: " · ")
    }

    /// A file whose family is also an installed kit font: used only when that font is missing.
    public static func isFallbackFile(_ font: BrandKitFont, in fonts: [BrandKitFont]) -> Bool {
        !font.isSystem && fonts.contains { $0.isSystem && $0.family.lowercased() == font.family.lowercased() }
    }
}

// MARK: - Profile tokens

/// The editable scalars of a profile's `brand.json` tokens (`tokenRows` / `setToken`).
public enum BrandTokens {
    public enum Kind: String, Sendable, Hashable { case color, text, number }

    public enum Group: String, Sendable, Hashable, CaseIterable {
        case colors = "Renkler"
        case fonts = "Yazı tipleri"
        case spacing = "Boşluk"
        case radius = "Köşeler"
    }

    public struct Row: Sendable, Hashable {
        public var path: [String]
        public var label: String
        public var group: Group
        public var kind: Kind
        public var value: String
        public var note: String?
    }

    private static func ordered(_ keys: [String], preferred: [String]) -> [String] {
        preferred.filter { keys.contains($0) } + keys.filter { !preferred.contains($0) }.sorted()
    }

    private static func format(_ number: Double) -> String {
        number == number.rounded() ? String(Int(number)) : String((number * 100).rounded() / 100)
    }

    public static func rows(_ tokens: JSONObject) -> [Row] {
        var rows: [Row] = []
        if case .object(let colors)? = tokens["color"] {
            for name in ordered(Array(colors.keys), preferred: ["paper", "mist", "ink", "graphite", "stone", "line", "accent", "accent-deep"]) {
                switch colors[name] {
                case .string(let value)?:
                    rows.append(Row(path: ["color", name], label: name, group: .colors, kind: .color, value: value, note: nil))
                case .object(let entry)?:
                    if case .string(let value)? = entry["value"] {
                        var note: String?
                        if case .string(let use)? = entry["use"] { note = use }
                        rows.append(Row(path: ["color", name, "value"], label: name, group: .colors, kind: .color, value: value, note: note))
                    }
                default: break
                }
            }
        }
        if case .object(let fonts)? = tokens["font"] {
            for role in ordered(Array(fonts.keys), preferred: ["display", "text"]) {
                guard case .object(let entry)? = fonts[role] else { continue }
                let roleLabel = role == "display" ? "Başlık" : (role == "text" ? "Gövde" : role)
                if case .string(let family)? = entry["family"] {
                    var files = 0
                    if case .array(let list)? = entry["files"] { files = list.count }
                    rows.append(Row(path: ["font", role, "family"], label: "\(roleLabel) ailesi", group: .fonts, kind: .text, value: family, note: files > 0 ? "\(files) dosya" : "Dosya yok, sistem fontu"))
                }
                if case .string(let license)? = entry["license"] {
                    rows.append(Row(path: ["font", role, "license"], label: "\(roleLabel) lisansı", group: .fonts, kind: .text, value: license, note: nil))
                }
            }
        }
        if case .object(let space)? = tokens["space"] {
            let labels = ["margin": "Kenar boşluğu", "gutter": "Aralık", "unit": "Birim", "columns": "Sütun"]
            for key in ["margin", "gutter", "unit", "columns"] {
                if case .number(let value)? = space[key] {
                    rows.append(Row(path: ["space", key], label: labels[key] ?? key, group: .spacing, kind: .number, value: format(value), note: key == "columns" ? nil : "px"))
                }
            }
        }
        if case .object(let radius)? = tokens["radius"] {
            for key in ordered(Array(radius.keys), preferred: ["sm", "md", "lg", "pill"]) {
                if case .number(let value)? = radius[key] {
                    rows.append(Row(path: ["radius", key], label: key, group: .radius, kind: .number, value: format(value), note: "px"))
                }
            }
        }
        let order = Group.allCases
        return rows.enumerated().sorted { lhs, rhs in
            let l = order.firstIndex(of: lhs.element.group) ?? 0
            let r = order.firstIndex(of: rhs.element.group) ?? 0
            return l != r ? l < r : lhs.offset < rhs.offset
        }.map(\.element)
    }

    /// nil when `value` is acceptable for the kind, else a Turkish reason.
    public static func problem(_ kind: Kind, _ value: String) -> String? {
        let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .color:
            return BrandKitRules.normalizedHex(t) == nil ? "Renk #RRGGBB biçiminde olmalı." : nil
        case .number:
            guard let n = Double(t.replacingOccurrences(of: ",", with: ".")), n >= 0, n <= 2000 else { return "0 ile 2000 arasında bir sayı girin." }
            _ = n
            return nil
        case .text:
            return t.isEmpty ? "Boş bırakılamaz." : nil
        }
    }

    /// Tokens with `row.path` set to `value` (normalised), or the Turkish reason it is refused.
    public static func set(_ tokens: JSONObject, row: Row, value: String) -> Result<JSONObject, BrandFormProblem> {
        if let problem = problem(row.kind, value) { return .failure(BrandFormProblem(problem)) }
        let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if row.path.first == "font", row.path.last == "family", !BrandKitRules.isValidFamily(t) {
            return .failure(BrandFormProblem("Font adı yalnızca harf, rakam, boşluk ve tire içerebilir."))
        }
        let json: JSONValue = switch row.kind {
        case .color: .string(BrandKitRules.normalizedHex(t) ?? t)
        case .number: .number(Double(t.replacingOccurrences(of: ",", with: ".")) ?? 0)
        case .text: .string(t)
        }
        return .success(setPath(tokens, row.path, json))
    }

    private static func setPath(_ object: JSONObject, _ path: [String], _ value: JSONValue) -> JSONObject {
        guard let head = path.first else { return object }
        var out = object
        if path.count == 1 {
            out[head] = value
            return out
        }
        var child: JSONObject = [:]
        if case .object(let existing)? = object[head] { child = existing }
        out[head] = .object(setPath(child, Array(path.dropFirst()), value))
        return out
    }
}

// MARK: - Templates

public enum TemplateRules {
    /// "Carousel · 4 kare · 1080×1350 · 6 alan" (`templateLine`).
    public static func line(_ template: ContentTemplate) -> String {
        let type = switch template.contentType {
        case .post: "Post"
        case .carousel: "Carousel"
        case .story: "Story"
        case .reel: "Reels"
        case .unknown: "Post"
        }
        var parts = [type]
        if template.slideCount > 1 { parts.append("\(template.slideCount) kare") }
        parts.append("\(template.width)×\(template.height)")
        parts.append("\(template.fillableFields().count) alan")
        if template.kind == .canvas { parts.append("tuval") }
        return parts.joined(separator: " · ")
    }

    /// "3 kez kullanıldı" / "Henüz kullanılmadı".
    public static func uses(_ template: ContentTemplate) -> String {
        template.useCount == 0 ? "Henüz kullanılmadı" : "\(template.useCount) kez kullanıldı"
    }

    public static func matches(_ template: ContentTemplate, query: String) -> Bool {
        let locale = Locale(identifier: "tr_TR")
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(with: locale)
        guard !q.isEmpty else { return true }
        return [template.name, template.description, template.source.title, line(template)].joined(separator: " ").lowercased(with: locale).contains(q)
    }

    /// The "Bu şablonla yeni post" form.
    public struct FillForm: Sendable, Equatable {
        public var mode: TemplateFillMode = .manual
        public var title: String
        public var brief = ""
        /// Text per field key ("" = keep the template's text).
        public var values: [String: String] = [:]
        /// Picture per image field key; missing = keep the template's.
        public var images: [String: EntityID] = [:]
        public var autoFit = true

        public init(template: ContentTemplate) { title = template.name }
    }

    /// Why the form cannot be sent (Turkish), or nil (`fillProblem`).
    public static func problem(_ form: FillForm) -> String? {
        if form.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Postun başlığını yaz." }
        if form.mode == .ai {
            return form.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "AI'ın ne yazacağını (konu) yaz." : nil
        }
        let texts = form.values.values.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !texts && form.images.isEmpty { return "En az bir alanı doldur ya da AI doldursun." }
        return nil
    }

    /// What the form sends (`templateUseInput`): only unlocked fields, empty texts left out.
    public static func useInput(_ template: ContentTemplate, _ form: FillForm) -> TemplateUse {
        let textKeys = Set(template.fillableFields(.text).map(\.key))
        let imageKeys = Set(template.fillableFields(.image).map(\.key))
        var values: [String: String] = [:]
        for (key, value) in form.values where textKeys.contains(key) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { values[key] = trimmed }
        }
        let images = form.images.filter { imageKeys.contains($0.key) }
        let brief = form.brief.trimmingCharacters(in: .whitespacesAndNewlines)
        return TemplateUse(
            title: form.title.trimmingCharacters(in: .whitespacesAndNewlines),
            brief: form.mode == .ai && !brief.isEmpty ? brief : nil,
            values: values.isEmpty ? nil : values,
            images: images.isEmpty ? nil : images,
            fill: form.mode,
            autoFit: form.autoFit)
    }

    /// "12 / ~40 karakter" against a field's hint; `over` past it.
    public static func count(_ field: TemplateField, _ value: String) -> (text: String, over: Bool)? {
        guard let limit = field.maxChars, !value.isEmpty else { return nil }
        let over = value.count > limit
        return ("\(value.count) / ~\(limit) karakter" + (over ? " · uzun: sığmazsa küçültülür" : ""), over)
    }
}
