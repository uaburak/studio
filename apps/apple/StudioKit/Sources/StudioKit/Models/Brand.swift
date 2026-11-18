import Foundation

// brand.ts, brand-profile.ts, social-account.ts, asset.ts

public enum BrandStatus: String, OpenEnum {
    case active, archived
    case unknown
}

public struct Brand: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var name: String
    public var slug: String
    public var defaultLanguage: String
    public var status: BrandStatus
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, name: String, slug: String, defaultLanguage: String = "tr",
        status: BrandStatus = .active, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.name = name
        self.slug = slug
        self.defaultLanguage = defaultLanguage
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// `"MTM Agro / Venta"` -> `"mtm-agro-venta"`; Turkish letters are folded to ASCII (`slugify` in brand.ts).
    public static func slugify(_ name: String) -> String {
        let map: [Character: String] = [
            "ç": "c", "Ç": "c",
            "ğ": "g", "Ğ": "g",
            "ı": "i", "İ": "i",
            "ö": "o", "Ö": "o",
            "ş": "s", "Ş": "s",
            "ü": "u", "Ü": "u",
        ]
        var folded = ""
        for ch in name {
            if let repl = map[ch] {
                folded += repl
            } else {
                folded.append(ch)
            }
        }
        let decomposed = folded.decomposedStringWithCompatibilityMapping
            .unicodeScalars
            .filter { !CharacterSet.nonBaseCharacters.contains($0) }
        let ascii = String(String.UnicodeScalarView(decomposed)).lowercased()
        var parts: [String] = []
        var current = ""
        for scalar in ascii.unicodeScalars {
            if (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57) {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                parts.append(current)
                current = ""
            }
        }
        if !current.isEmpty { parts.append(current) }
        let joined = parts.joined(separator: "-")
        let sliced = String(joined.prefix(64))
        return sliced.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

/// `POST /api/brands`.
public struct BrandCreate: Codable, Sendable, Equatable {
    public var name: String
    public var slug: String?
    public var defaultLanguage: String

    public init(name: String, slug: String? = nil, defaultLanguage: String = "tr") {
        self.name = name
        self.slug = slug
        self.defaultLanguage = defaultLanguage
    }
}

/// `PATCH /api/brands/{id}`.
public struct BrandUpdate: Codable, Sendable, Equatable {
    public var name: String?
    public var slug: String?
    public var defaultLanguage: String?
    public var status: BrandStatus?

    public init(name: String? = nil, slug: String? = nil, defaultLanguage: String? = nil, status: BrandStatus? = nil) {
        self.name = name
        self.slug = slug
        self.defaultLanguage = defaultLanguage
        self.status = status
    }
}

// MARK: - Brand Profiles (brand-profile.ts)

public enum BrandProfileStatus: String, OpenEnum {
    case draft, approved
    case unknown

    public var label: String {
        switch self {
        case .draft: "Taslak"
        case .approved: "Onaylı"
        case .unknown: "Bilinmeyen"
        }
    }
}

public struct BrandProfile: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var version: Int
    public var status: BrandProfileStatus
    public var isCurrent: Bool
    public var tokens: JSONObject
    /// `DESIGN.md` equivalent.
    public var designRules: String
    /// `VOICE.md` equivalent.
    public var voice: String
    public var createdAt: Date
    public var updatedAt: Date
    public var approvedAt: Date?

    public init(
        id: EntityID, brandId: EntityID, version: Int, status: BrandProfileStatus, isCurrent: Bool,
        tokens: JSONObject = [:], designRules: String = "", voice: String = "",
        approvedAt: Date? = nil, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.brandId = brandId
        self.version = version
        self.status = status
        self.isCurrent = isCurrent
        self.tokens = tokens
        self.designRules = designRules
        self.voice = voice
        self.approvedAt = approvedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct BrandProfileCreate: Codable, Sendable, Equatable {
    public var tokens: JSONObject
    public var designRules: String
    public var voice: String

    public init(tokens: JSONObject = [:], designRules: String = "", voice: String = "") {
        self.tokens = tokens
        self.designRules = designRules
        self.voice = voice
    }
}

public struct BrandProfileUpdate: Codable, Sendable, Equatable {
    public var tokens: JSONObject?
    public var designRules: String?
    public var voice: String?

    public init(tokens: JSONObject? = nil, designRules: String? = nil, voice: String? = nil) {
        self.tokens = tokens
        self.designRules = designRules
        self.voice = voice
    }
}

// MARK: - Social Accounts & Token Vault (social-account.ts)

/// - `pending`: registered, no credentials yet.
/// - `connected`: credentials stored and healthy.
/// - `needs_reauth`: credentials expired or revoked.
/// - `disabled`: kept for history, never used for publishing.
public enum SocialAccountStatus: String, OpenEnum {
    case pending, connected
    case needsReauth = "needs_reauth"
    case disabled
    case unknown

    public var label: String {
        switch self {
        case .pending: "Bekliyor"
        case .connected: "Bağlı"
        case .needsReauth: "Yeniden giriş gerekli"
        case .disabled: "Devre dışı"
        case .unknown: "Bilinmeyen"
        }
    }
}

public enum TokenHealthStatus: String, OpenEnum {
    case valid
    case expiringSoon = "expiring_soon"
    case invalid
    case missingScopes = "missing_scopes"
    case unchecked
    case unknown

    public var label: String {
        switch self {
        case .valid: "Geçerli"
        case .expiringSoon: "Yakında doluyor"
        case .invalid: "Yeniden giriş gerekli"
        case .missingScopes: "Eksik yetki"
        case .unchecked: "Denetlenmedi"
        case .unknown: "Bilinmiyor"
        }
    }
}

public struct SocialAccount: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var platform: Platform
    /// Display handle, e.g. `@mtmagro` or a page name.
    public var handle: String
    public var externalId: String?
    public var status: SocialAccountStatus
    public var createdAt: Date
    public var updatedAt: Date
    public var hasToken: Bool?
    public var tokenExpiresAt: Date?
    public var tokenScopes: [String]?
    public var tokenHealth: TokenHealthStatus?
    public var tokenCheckedAt: Date?

    public init(
        id: EntityID, brandId: EntityID, platform: Platform, handle: String, externalId: String? = nil,
        status: SocialAccountStatus, createdAt: Date, updatedAt: Date,
        hasToken: Bool? = nil, tokenExpiresAt: Date? = nil, tokenScopes: [String]? = nil,
        tokenHealth: TokenHealthStatus? = nil, tokenCheckedAt: Date? = nil
    ) {
        self.id = id
        self.brandId = brandId
        self.platform = platform
        self.handle = handle
        self.externalId = externalId
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.hasToken = hasToken
        self.tokenExpiresAt = tokenExpiresAt
        self.tokenScopes = tokenScopes
        self.tokenHealth = tokenHealth
        self.tokenCheckedAt = tokenCheckedAt
    }
}

public struct SocialAccountCreate: Codable, Sendable, Equatable {
    public var brandId: EntityID
    public var platform: Platform
    public var handle: String
    public var externalId: String?
    public var status: SocialAccountStatus?

    public init(
        brandId: EntityID, platform: Platform, handle: String,
        externalId: String? = nil, status: SocialAccountStatus? = .pending
    ) {
        self.brandId = brandId
        self.platform = platform
        self.handle = handle
        self.externalId = externalId
        self.status = status
    }
}

public struct SocialAccountUpdate: Codable, Sendable, Equatable {
    public var handle: String?
    public var externalId: String?
    public var status: SocialAccountStatus?

    public init(handle: String? = nil, externalId: String? = nil, status: SocialAccountStatus? = nil) {
        self.handle = handle
        self.externalId = externalId
        self.status = status
    }
}

public struct SocialAccountTokenPut: Codable, Sendable, Equatable {
    public var accessToken: String
    public var expiresAt: Date?
    public var scopes: [String]?
    public var externalId: String?
    public var handle: String?

    public init(
        accessToken: String, expiresAt: Date? = nil, scopes: [String]? = nil,
        externalId: String? = nil, handle: String? = nil
    ) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.scopes = scopes
        self.externalId = externalId
        self.handle = handle
    }
}

public struct MetaDiscoveredPage: Codable, Sendable, Hashable {
    public struct InstagramAccount: Codable, Sendable, Hashable {
        public var igUserId: String
        public var username: String

        public init(igUserId: String, username: String) {
            self.igUserId = igUserId
            self.username = username
        }
    }

    public var pageId: String
    public var pageName: String
    public var canPublish: Bool
    public var pageAccessToken: String?
    public var instagram: InstagramAccount?

    public init(
        pageId: String, pageName: String, canPublish: Bool,
        pageAccessToken: String? = nil, instagram: InstagramAccount? = nil
    ) {
        self.pageId = pageId
        self.pageName = pageName
        self.canPublish = canPublish
        self.pageAccessToken = pageAccessToken
        self.instagram = instagram
    }
}

public struct MetaDiscoverInput: Codable, Sendable, Equatable {
    public var brandId: EntityID
    public var userAccessToken: String
    public var appId: String?
    public var appSecret: String?
    public var autoConnect: Bool
    /// Connect only these Pages / Instagram accounts (nil = every publishable Page).
    public var selections: [MetaPageSelection]?
    /// Expiry of `userAccessToken` when it came from `exchangeMeta` (skips a second exchange).
    public var userTokenExpiresAt: Date?

    public init(
        brandId: EntityID, userAccessToken: String,
        appId: String? = nil, appSecret: String? = nil, autoConnect: Bool = true,
        selections: [MetaPageSelection]? = nil, userTokenExpiresAt: Date? = nil
    ) {
        self.brandId = brandId
        self.userAccessToken = userAccessToken
        self.appId = appId
        self.appSecret = appSecret
        self.autoConnect = autoConnect
        self.selections = selections
        self.userTokenExpiresAt = userTokenExpiresAt
    }
}

/// `MetaPageSelection` in social-account.ts.
public struct MetaPageSelection: Codable, Sendable, Hashable {
    public var pageId: String
    public var facebook: Bool
    public var instagram: Bool

    public init(pageId: String, facebook: Bool, instagram: Bool) {
        self.pageId = pageId
        self.facebook = facebook
        self.instagram = instagram
    }
}

public struct MetaDiscoverResult: Codable, Sendable, Equatable {
    public var pages: [MetaDiscoveredPage]
    public var connectedAccounts: [SocialAccount]

    public init(pages: [MetaDiscoveredPage], connectedAccounts: [SocialAccount]) {
        self.pages = pages
        self.connectedAccounts = connectedAccounts
    }
}

public struct LinkedInConnectInput: Codable, Sendable, Equatable {
    public var brandId: EntityID
    public var handle: String
    public var personUrn: String
    public var accessToken: String
    public var expiresInSeconds: Int?

    public init(
        brandId: EntityID, handle: String, personUrn: String,
        accessToken: String, expiresInSeconds: Int? = nil
    ) {
        self.brandId = brandId
        self.handle = handle
        self.personUrn = personUrn
        self.accessToken = accessToken
        self.expiresInSeconds = expiresInSeconds
    }
}

// MARK: - Assets (asset.ts)

public enum AssetKind: String, OpenEnum {
    case image, video, audio, document, font, logo, other
    case unknown

    public var label: String {
        switch self {
        case .image: "Görsel"
        case .video: "Video"
        case .audio: "Ses"
        case .document: "Belge (PDF)"
        case .font: "Yazı tipi"
        case .logo: "Logo"
        case .other: "Diğer"
        case .unknown: "Bilinmeyen"
        }
    }
}

public enum AssetSource: String, OpenEnum {
    case upload, generated, ingested
    case unknown

    public var label: String {
        switch self {
        case .upload: "Yüklendi"
        case .generated: "AI Üretimi"
        case .ingested: "Markadan alındı"
        case .unknown: "Diğer"
        }
    }
}

public struct Asset: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var kind: AssetKind
    public var source: AssetSource
    public var objectKey: String
    public var mimeType: String
    public var bytes: Int
    /// Hex SHA-256 of the stored bytes.
    public var sha256: String
    public var width: Int?
    public var height: Int?
    public var durationMs: Int?
    public var originalFilename: String?
    public var createdAt: Date
    /// Set while the file is in the trash (restore with `POST /api/assets/{id}/restore`).
    public var deletedAt: Date?
    /// What the Mac read on a picture (N12); nil until analysed, absent from older servers.
    public var analysis: AssetAnalysisSummary?

    public init(
        id: EntityID, brandId: EntityID, kind: AssetKind, source: AssetSource, objectKey: String,
        mimeType: String, bytes: Int, sha256: String, width: Int?, height: Int?, durationMs: Int? = nil,
        originalFilename: String?, createdAt: Date, deletedAt: Date? = nil, analysis: AssetAnalysisSummary? = nil
    ) {
        self.analysis = analysis
        self.deletedAt = deletedAt
        self.id = id
        self.brandId = brandId
        self.kind = kind
        self.source = source
        self.objectKey = objectKey
        self.mimeType = mimeType
        self.bytes = bytes
        self.sha256 = sha256
        self.width = width
        self.height = height
        self.durationMs = durationMs
        self.originalFilename = originalFilename
        self.createdAt = createdAt
    }
}

/// Upload allow-list subset the apps send (`ASSET_MIME_RULES` in asset.ts).
public enum AssetMimeRules {
    public static let imageMaxBytes = 20 * 1024 * 1024
    public static let videoMaxBytes = 50 * 1024 * 1024
    public static let documentMaxBytes = 50 * 1024 * 1024
    public static let audioMaxBytes = 50 * 1024 * 1024

    /// Mime types accepted as images, by file extension.
    public static let imageTypes: [String: String] = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "webp": "image/webp", "gif": "image/gif", "heic": "image/heic",
    ]

    /// Mime types accepted across media library uploads, by file extension.
    public static let mediaTypes: [String: (mime: String, kind: AssetKind, maxBytes: Int)] = [
        "jpg": ("image/jpeg", .image, imageMaxBytes),
        "jpeg": ("image/jpeg", .image, imageMaxBytes),
        "png": ("image/png", .image, imageMaxBytes),
        "webp": ("image/webp", .image, imageMaxBytes),
        "gif": ("image/gif", .image, imageMaxBytes),
        "svg": ("image/svg+xml", .logo, 2 * 1024 * 1024),
        "mp4": ("video/mp4", .video, videoMaxBytes),
        "mov": ("video/quicktime", .video, videoMaxBytes),
        "pdf": ("application/pdf", .document, documentMaxBytes),
        "mp3": ("audio/mpeg", .audio, audioMaxBytes),
        "m4a": ("audio/mp4", .audio, audioMaxBytes),
        "aac": ("audio/aac", .audio, audioMaxBytes),
        "wav": ("audio/wav", .audio, audioMaxBytes),
    ]

    /// `image/heic` is not on the server's list; callers convert it first.
    public static let serverImageTypes: Set<String> = ["image/jpeg", "image/png", "image/webp", "image/gif"]
}
