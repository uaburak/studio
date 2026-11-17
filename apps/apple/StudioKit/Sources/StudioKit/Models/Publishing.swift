import Foundation

// Mirrors packages/contract/src/publishing.ts and the P3 additions of
// social-account.ts / schedule.ts.

// MARK: - Publishing path

public enum PublishingMode: String, OpenEnum {
    case cloud, local
    case unknown
}

public struct PublishingStatus: Codable, Sendable, Equatable {
    public struct Cloud: Codable, Sendable, Equatable {
        public var configured: Bool
        public var url: String?
        public var lastSyncAt: Date?
        public var lastSyncOk: Bool?
        public var lastSyncError: String?
        public var syncRequestedAt: Date?

        public init(configured: Bool, url: String? = nil, lastSyncAt: Date? = nil, lastSyncOk: Bool? = nil, lastSyncError: String? = nil, syncRequestedAt: Date? = nil) {
            self.configured = configured
            self.url = url
            self.lastSyncAt = lastSyncAt
            self.lastSyncOk = lastSyncOk
            self.lastSyncError = lastSyncError
            self.syncRequestedAt = syncRequestedAt
        }
    }

    public var mode: PublishingMode
    public var cloud: Cloud
    /// False when the API has no token vault key (tokens cannot be stored).
    public var vaultReady: Bool

    public init(mode: PublishingMode, cloud: Cloud, vaultReady: Bool) {
        self.mode = mode
        self.cloud = cloud
        self.vaultReady = vaultReady
    }

    /// Before the API answered (or an older API): this Mac publishes.
    public static let unknownLocal = PublishingStatus(mode: .local, cloud: Cloud(configured: false), vaultReady: true)
}

public struct PublishingCloudPut: Encodable, Sendable, Equatable {
    public var url: String
    public var token: String

    public init(url: String, token: String) {
        self.url = url
        self.token = token
    }
}

// MARK: - Preflight

public struct PreflightIssue: Codable, Sendable, Hashable {
    public var code: String
    public var path: String
    /// Turkish, user-presentable.
    public var message: String

    public init(code: String, path: String = "", message: String) {
        self.code = code
        self.path = path
        self.message = message
    }
}

public struct SchedulePreflightTarget: Codable, Sendable, Hashable {
    public var socialAccountId: EntityID
    public var platform: Platform
    public var handle: String
    public var kind: String
    public var ok: Bool
    public var errors: [PreflightIssue]
    public var warnings: [PreflightIssue]

    public init(socialAccountId: EntityID, platform: Platform, handle: String, kind: String, ok: Bool, errors: [PreflightIssue] = [], warnings: [PreflightIssue] = []) {
        self.socialAccountId = socialAccountId
        self.platform = platform
        self.handle = handle
        self.kind = kind
        self.ok = ok
        self.errors = errors
        self.warnings = warnings
    }
}

public struct SchedulePreflight: Codable, Sendable, Equatable {
    public var mode: PublishingMode
    public var ok: Bool
    public var errors: [PreflightIssue]
    public var targets: [SchedulePreflightTarget]

    public init(mode: PublishingMode, ok: Bool, errors: [PreflightIssue] = [], targets: [SchedulePreflightTarget]) {
        self.mode = mode
        self.ok = ok
        self.errors = errors
        self.targets = targets
    }

    public func target(_ accountId: EntityID) -> SchedulePreflightTarget? {
        targets.first { $0.socialAccountId == accountId }
    }
}

public struct SchedulePreflightInput: Encodable, Sendable, Equatable {
    public var contentId: EntityID
    public var socialAccountIds: [EntityID]?
    /// Planned publish time, for per-day limits (30 Facebook Reels per Page); nil = now.
    public var scheduledAt: Date?

    public init(contentId: EntityID, socialAccountIds: [EntityID]? = nil, scheduledAt: Date? = nil) {
        self.contentId = contentId
        self.socialAccountIds = socialAccountIds
        self.scheduledAt = scheduledAt
    }
}

// MARK: - Publish now, reschedule

public struct PublishNowInput: Encodable, Sendable, Equatable {
    public var contentId: EntityID
    public var socialAccountIds: [EntityID]

    public init(contentId: EntityID, socialAccountIds: [EntityID]) {
        self.contentId = contentId
        self.socialAccountIds = socialAccountIds
    }
}

public struct PublishNowResult: Decodable, Sendable, Equatable {
    public var schedules: [Schedule]
    public var jobs: [Job]
}

public struct ScheduleUpdate: Encodable, Sendable, Equatable {
    public var scheduledAt: Date

    public init(scheduledAt: Date) {
        self.scheduledAt = scheduledAt
    }
}

// MARK: - Publish log feed

public struct PublishLogFeedItem: Codable, Sendable, Hashable, Identifiable {
    public var log: PublishLog
    public var schedule: Schedule
    public var contentTitle: String
    public var accountHandle: String

    public var id: EntityID { log.id }

    public init(log: PublishLog, schedule: Schedule, contentTitle: String, accountHandle: String) {
        self.log = log
        self.schedule = schedule
        self.contentTitle = contentTitle
        self.accountHandle = accountHandle
    }
}

public struct PublishLogFeed: Codable, Sendable, Equatable {
    public var items: [PublishLogFeedItem]

    public init(items: [PublishLogFeedItem]) {
        self.items = items
    }
}

// MARK: - OAuth connect (Mac)

/// Finish Facebook Login: `code` (+ secret, redirect URI) or an implicit-flow `accessToken`.
public struct MetaExchangeInput: Encodable, Sendable, Equatable {
    public var appId: String
    public var appSecret: String?
    public var code: String?
    public var redirectUri: String?
    public var accessToken: String?

    public init(appId: String, appSecret: String? = nil, code: String? = nil, redirectUri: String? = nil, accessToken: String? = nil) {
        self.appId = appId
        self.appSecret = appSecret
        self.code = code
        self.redirectUri = redirectUri
        self.accessToken = accessToken
    }
}

public struct MetaExchangeResult: Decodable, Sendable, Equatable {
    /// Kept in memory only, for the next `discoverMetaAccounts` call.
    public var userAccessToken: String
    public var expiresAt: Date?
    public var longLived: Bool
    public var grantedScopes: [String]
    public var missingScopes: [String]
    public var pages: [MetaDiscoveredPage]

    public init(userAccessToken: String, expiresAt: Date?, longLived: Bool, grantedScopes: [String] = [], missingScopes: [String] = [], pages: [MetaDiscoveredPage]) {
        self.userAccessToken = userAccessToken
        self.expiresAt = expiresAt
        self.longLived = longLived
        self.grantedScopes = grantedScopes
        self.missingScopes = missingScopes
        self.pages = pages
    }
}

public struct LinkedInOAuthInput: Encodable, Sendable, Equatable {
    public var brandId: EntityID
    public var clientId: String
    public var clientSecret: String
    public var code: String
    public var redirectUri: String

    public init(brandId: EntityID, clientId: String, clientSecret: String, code: String, redirectUri: String) {
        self.brandId = brandId
        self.clientId = clientId
        self.clientSecret = clientSecret
        self.code = code
        self.redirectUri = redirectUri
    }
}

/// `POST /api/social-accounts/{id}/check`; `live` asks the platform.
public struct SocialAccountCheckInput: Encodable, Sendable, Equatable {
    public var live: Bool
    public var appId: String?
    public var appSecret: String?

    public init(live: Bool, appId: String? = nil, appSecret: String? = nil) {
        self.live = live
        self.appId = appId
        self.appSecret = appSecret
    }
}
