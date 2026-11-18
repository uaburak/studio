import Foundation

// brand-kit.ts: the user's raw brand input (logos, fonts, palette, sample posts, notes).
// `brand.analyze` reads it and writes a draft `BrandProfile`.

/// Background a logo file is made for.
public enum BrandKitLogoBackground: String, OpenEnum {
    case any, light, dark
    case unknown

    public var label: String {
        switch self {
        case .any: "Her zemin"
        case .light: "Açık zemin için"
        case .dark: "Koyu zemin için"
        case .unknown: "Bilinmiyor"
        }
    }
}

/// Which font role a font file is meant for.
public enum BrandKitFontRole: String, OpenEnum {
    case display, text, any
    case unknown

    public var label: String {
        switch self {
        case .display: "Başlık"
        case .text: "Gövde"
        case .any: "Başlık ve gövde"
        case .unknown: "Bilinmiyor"
        }
    }
}

public struct BrandKitLogo: Codable, Sendable, Hashable {
    public var assetId: EntityID
    public var background: BrandKitLogoBackground
    public var label: String?

    public init(assetId: EntityID, background: BrandKitLogoBackground = .any, label: String? = nil) {
        self.assetId = assetId
        self.background = background
        self.label = label
    }
}

/// Where a kit font comes from (`BrandKitFontSource`): an uploaded file, or a font installed on
/// the Mac. Kept as a string so a source this build does not know survives a save unchanged.
public struct BrandKitFontSource: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// An uploaded font file (`assetId`).
    public static let file: BrandKitFontSource = "file"
    /// Installed on the Mac (no file; `styles` lists the styles the brand uses).
    public static let system: BrandKitFontSource = "system"
}

/// One installed style of a system font (`BrandKitFontStyle`).
public struct BrandKitFontStyle: Codable, Sendable, Hashable {
    /// `Regular`, `Demi Bold Italic`.
    public var name: String
    /// CSS weight (100 … 900).
    public var weight: Int
    public var italic: Bool
    /// `AvenirNext-DemiBold`, when known.
    public var postscriptName: String?

    public init(name: String, weight: Int, italic: Bool = false, postscriptName: String? = nil) {
        self.name = name
        self.weight = weight
        self.italic = italic
        self.postscriptName = postscriptName
    }

    private enum CodingKeys: String, CodingKey { case name, weight, italic, postscriptName }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        weight = try c.decode(Int.self, forKey: .weight)
        italic = try c.decodeIfPresent(Bool.self, forKey: .italic) ?? false
        postscriptName = try c.decodeIfPresent(String.self, forKey: .postscriptName)
    }
}

/// A kit font: an uploaded file (`source: file`, `assetId`) or a font installed on the Mac
/// (`source: system`, no file, `styles`). Kits saved before system fonts have no `source`.
public struct BrandKitFont: Codable, Sendable, Hashable {
    public var source: BrandKitFontSource
    /// The font file; nil for a system font.
    public var assetId: EntityID?
    /// CSS family name the file provides (`Archivo`), or the installed family (`Avenir Next`).
    public var family: String
    public var role: BrandKitFontRole
    /// System fonts: the styles the brand uses (empty = the family as a whole).
    public var styles: [BrandKitFontStyle]
    /// Where it came from and what the licence allows, in the user's words.
    public var licenseNote: String

    /// An uploaded font file.
    public init(assetId: EntityID, family: String, role: BrandKitFontRole = .any, licenseNote: String = "") {
        self.source = .file
        self.assetId = assetId
        self.family = family
        self.role = role
        self.styles = []
        self.licenseNote = licenseNote
    }

    public init(source: BrandKitFontSource, assetId: EntityID?, family: String, role: BrandKitFontRole = .any, styles: [BrandKitFontStyle] = [], licenseNote: String = "") {
        self.source = source
        self.assetId = assetId
        self.family = family
        self.role = role
        self.styles = styles
        self.licenseNote = licenseNote
    }

    private enum CodingKeys: String, CodingKey { case source, assetId, family, role, styles, licenseNote }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(BrandKitFontSource.self, forKey: .source) ?? .file
        assetId = try c.decodeIfPresent(EntityID.self, forKey: .assetId)
        family = try c.decode(String.self, forKey: .family)
        role = try c.decodeIfPresent(BrandKitFontRole.self, forKey: .role) ?? .any
        styles = try c.decodeIfPresent([BrandKitFontStyle].self, forKey: .styles) ?? []
        licenseNote = try c.decodeIfPresent(String.self, forKey: .licenseNote) ?? ""
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(source, forKey: .source)
        try c.encodeIfPresent(assetId, forKey: .assetId)
        try c.encode(family, forKey: .family)
        try c.encode(role, forKey: .role)
        try c.encode(styles, forKey: .styles)
        try c.encode(licenseNote, forKey: .licenseNote)
    }

    /// Installed on the Mac (no file).
    public var isSystem: Bool { source == .system }

    /// Identity of a kit font (`kitFontKey`): its file, or `system:<family>`.
    public var key: String {
        if isSystem || assetId == nil { return "system:\(family.trimmingCharacters(in: .whitespaces).lowercased())" }
        return assetId ?? family
    }
}

public struct BrandKitColor: Codable, Sendable, Hashable {
    /// kebab-case: `accent`, `accent-deep`.
    public var name: String
    /// `#RRGGBB`.
    public var hex: String
    public var use: String?

    public init(name: String, hex: String, use: String? = nil) {
        self.name = name
        self.hex = hex
        self.use = use
    }
}

public struct BrandKitSample: Codable, Sendable, Hashable {
    public var assetId: EntityID
    public var caption: String?

    public init(assetId: EntityID, caption: String? = nil) {
        self.assetId = assetId
        self.caption = caption
    }
}

/// `GET /api/brands/{id}/kit`.
public struct BrandKit: Codable, Sendable, Hashable {
    public static let minSamples = 3
    public static let maxSamples = 12
    public static let maxLogos = 12
    public static let maxFonts = 12
    public static let maxColors = 16

    public var brandId: EntityID
    public var logos: [BrandKitLogo]
    public var fonts: [BrandKitFont]
    public var palette: [BrandKitColor]
    public var samples: [BrandKitSample]
    public var notes: String
    /// nil until the kit was saved once.
    public var updatedAt: Date?

    public init(
        brandId: EntityID, logos: [BrandKitLogo] = [], fonts: [BrandKitFont] = [],
        palette: [BrandKitColor] = [], samples: [BrandKitSample] = [], notes: String = "", updatedAt: Date? = nil
    ) {
        self.brandId = brandId
        self.logos = logos
        self.fonts = fonts
        self.palette = palette
        self.samples = samples
        self.notes = notes
        self.updatedAt = updatedAt
    }

    public static func empty(_ brandId: EntityID) -> BrandKit { BrandKit(brandId: brandId) }

    /// The body for `PUT /api/brands/{id}/kit`.
    public var put: BrandKitPut {
        BrandKitPut(logos: logos, fonts: fonts, palette: palette, samples: samples, notes: notes)
    }

    /// Why `brand.analyze` cannot run on this kit yet, or nil (`brandKitAnalysisBlocker`).
    public var analysisBlocker: String? {
        if samples.count < Self.minSamples {
            return "Profil çıkarmak için en az \(Self.minSamples) örnek post görseli gerekli (şu an \(samples.count))."
        }
        if samples.count > Self.maxSamples {
            return "En fazla \(Self.maxSamples) örnek post görseli kullanılabilir."
        }
        return nil
    }

    /// Every asset the kit references.
    public var assetIds: [EntityID] {
        logos.map(\.assetId) + fonts.compactMap(\.assetId) + samples.map(\.assetId)
    }
}

/// `PUT /api/brands/{id}/kit` body (replaces the whole kit).
public struct BrandKitPut: Codable, Sendable, Equatable {
    public var logos: [BrandKitLogo]
    public var fonts: [BrandKitFont]
    public var palette: [BrandKitColor]
    public var samples: [BrandKitSample]
    public var notes: String

    public init(logos: [BrandKitLogo] = [], fonts: [BrandKitFont] = [], palette: [BrandKitColor] = [], samples: [BrandKitSample] = [], notes: String = "") {
        self.logos = logos
        self.fonts = fonts
        self.palette = palette
        self.samples = samples
        self.notes = notes
    }
}

public enum BrandKitRules {
    /// `#RRGGBB` (also accepts `RRGGBB` and `#RGB`) → `#RRGGBB` upper case, or nil.
    public static func normalizedHex(_ raw: String) -> String? {
        var clean = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if clean.hasPrefix("#") { clean.removeFirst() }
        if clean.count == 3 { clean = clean.map { "\($0)\($0)" }.joined() }
        guard clean.count == 6, clean.allSatisfy({ $0.isHexDigit }) else { return nil }
        return "#\(clean)"
    }

    /// `Ana Vurgu` → `ana-vurgu`; nil when nothing usable remains.
    public static func colorName(_ raw: String) -> String? {
        let slug = Brand.slugify(raw)
        guard let first = slug.first, first.isLetter else { return nil }
        return String(slug.prefix(48))
    }

    /// Family names the contract accepts: letters, digits, spaces, dashes.
    public static func isValidFamily(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.unicodeScalars.first, !trimmed.isEmpty, trimmed.count <= 64 else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -")
        return CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").contains(first)
            && trimmed.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    /// `Archivo-BoldItalic.woff2` → `Archivo`.
    public static func familyGuess(fromFilename filename: String) -> String {
        let base = (filename as NSString).deletingPathExtension
        let head = base.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? base
        // Split CamelCase ("InterDisplay" -> "Inter Display").
        var out = ""
        for ch in head {
            if ch.isUppercase, let last = out.last, last.isLowercase { out.append(" ") }
            out.append(ch)
        }
        let cleaned = out.unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0) || $0 == " "
        }
        let result = String(String.UnicodeScalarView(cleaned)).trimmingCharacters(in: .whitespaces)
        return isValidFamily(result) ? result : "Marka Fontu"
    }
}
