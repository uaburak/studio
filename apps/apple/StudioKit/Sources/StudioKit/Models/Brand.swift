import Foundation

// brand.ts, social-account.ts, asset.ts

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
}

/// - `pending`: registered, no credentials yet (the token vault is a later phase).
/// - `connected`: credentials stored and healthy.
/// - `needs_reauth`: credentials expired or revoked.
/// - `disabled`: kept for history, never used for publishing.
public enum SocialAccountStatus: String, OpenEnum {
    case pending, connected
    case needsReauth = "needs_reauth"
    case disabled
    case unknown
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

    public init(
        id: EntityID, brandId: EntityID, platform: Platform, handle: String, externalId: String? = nil,
        status: SocialAccountStatus, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.brandId = brandId
        self.platform = platform
        self.handle = handle
        self.externalId = externalId
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public enum AssetKind: String, OpenEnum {
    case image, video, audio, font, logo, other
    case unknown
}

public enum AssetSource: String, OpenEnum {
    case upload, generated, ingested
    case unknown
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

    public init(
        id: EntityID, brandId: EntityID, kind: AssetKind, source: AssetSource, objectKey: String,
        mimeType: String, bytes: Int, sha256: String, width: Int?, height: Int?, durationMs: Int? = nil,
        originalFilename: String?, createdAt: Date
    ) {
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

    /// Mime types accepted as images, by file extension.
    public static let imageTypes: [String: String] = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "webp": "image/webp", "gif": "image/gif", "heic": "image/heic",
    ]

    /// `image/heic` is not on the server's list; callers convert it first.
    public static let serverImageTypes: Set<String> = ["image/jpeg", "image/png", "image/webp", "image/gif"]
}
