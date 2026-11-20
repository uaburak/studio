import CoreGraphics
import Foundation

// content.ts, schedule.ts

public enum ContentType: String, OpenEnum {
    case post, carousel, story, reel
    case unknown
}

/// Lifecycle from PLAN.md §8.
public enum ContentStatus: String, OpenEnum {
    case draft
    case inReview = "in_review"
    case approved, scheduled, publishing, published, failed
    case unknown

    /// `APPROVABLE_STATUSES`: approve-by-hash is accepted from these.
    public var isApprovable: Bool { self == .draft || self == .inReview }

    /// `SCHEDULABLE_STATUSES`.
    public var isSchedulable: Bool { self == .approved || self == .scheduled || self == .failed }

    /// Approved or further along (the approval is still attached).
    public var hasApproval: Bool {
        switch self {
        case .approved, .scheduled, .publishing, .published: true
        default: false
        }
    }

    /// Caption / platform edits are refused (`409`) in these.
    public var isLocked: Bool { self == .publishing || self == .published }
}

/// Where one `[data-layer]` element sat in a rendered slide (`SlideLayerBox`):
/// border box in artboard px, transforms included, as the renderer measured it.
public struct SlideLayerBox: Codable, Sendable, Hashable, Identifiable {
    /// `data-layer` id.
    public var id: String
    /// `data-type` (`text`, `image`, `shape`, `logo`, `slot`, `group`).
    public var type: String
    public var role: String?
    /// Enclosing layer (a group), nil on the artboard.
    public var parent: String?
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    /// Painted (not hidden, not zero-sized).
    public var visible: Bool

    public init(id: String, type: String, role: String? = nil, parent: String? = nil, x: Double, y: Double, w: Double, h: Double, visible: Bool = true) {
        self.id = id
        self.type = type
        self.role = role
        self.parent = parent
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.visible = visible
    }

    public var rect: CGRect { CGRect(x: x, y: y, width: w, height: h) }
}

public struct Slide: Codable, Sendable, Hashable {
    /// Full HTML document following the design contract. Never rendered by the apps.
    public var html: String
    public var width: Int
    public var height: Int
    /// Rendered image of this slide, once the worker has produced it.
    public var renderedAssetId: EntityID?
    /// Layer boxes measured in that render (nil until a render stored them).
    public var layers: [SlideLayerBox]?

    public init(html: String, width: Int, height: Int, renderedAssetId: EntityID? = nil, layers: [SlideLayerBox]? = nil) {
        self.html = html
        self.width = width
        self.height = height
        self.renderedAssetId = renderedAssetId
        self.layers = layers
    }
}

public enum ContentVersionOrigin: String, OpenEnum {
    case generated
    case manualEdit = "manual_edit"
    case aiEdit = "ai_edit"
    case unknown
}

/// Version without slide HTML (list responses).
public struct ContentVersionSummary: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var contentId: EntityID
    public var version: Int
    public var origin: ContentVersionOrigin
    public var contentHash: String
    public var slideCount: Int
    public var note: String?
    public var jobId: EntityID?
    public var createdAt: Date
    public var updatedAt: Date
}

public struct ContentVersion: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var contentId: EntityID
    /// 1, 2, 3, ... per content item.
    public var version: Int
    public var origin: ContentVersionOrigin
    public var contentHash: String
    public var slideCount: Int
    public var note: String?
    public var jobId: EntityID?
    public var createdAt: Date
    public var updatedAt: Date
    public var slides: [Slide]

    public init(
        id: EntityID, contentId: EntityID, version: Int, origin: ContentVersionOrigin = .generated,
        contentHash: String, note: String? = nil, jobId: EntityID? = nil, createdAt: Date, updatedAt: Date,
        slides: [Slide]
    ) {
        self.id = id
        self.contentId = contentId
        self.version = version
        self.origin = origin
        self.contentHash = contentHash
        self.slideCount = slides.count
        self.note = note
        self.jobId = jobId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.slides = slides
    }
}

public struct ContentVersionRef: Codable, Sendable, Hashable {
    public var id: EntityID
    public var version: Int
    public var contentHash: String

    public init(id: EntityID, version: Int, contentHash: String) {
        self.id = id
        self.version = version
        self.contentHash = contentHash
    }
}

public struct ContentApproval: Codable, Sendable, Hashable {
    public var versionId: EntityID
    /// Hash the user approved; equals the current version's hash.
    public var contentHash: String
    public var approvedAt: Date

    public init(versionId: EntityID, contentHash: String, approvedAt: Date) {
        self.versionId = versionId
        self.contentHash = contentHash
        self.approvedAt = approvedAt
    }
}

public struct Content: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var type: ContentType
    public var title: String
    /// The brief / prompt the content was (or will be) generated from.
    public var brief: String
    public var status: ContentStatus
    public var targetPlatforms: [Platform]
    public var caption: String
    /// Latest version; nil until the first version is added.
    public var currentVersion: ContentVersionRef?
    public var approval: ContentApproval?
    public var createdAt: Date
    public var updatedAt: Date
    /// Set while the post is in the trash (restore with `POST /api/contents/{id}/restore`).
    public var deletedAt: Date?
    /// Approval requests of this post still waiting (above 0: "Onay bekliyor"); nil from older servers.
    public var pendingApprovals: Int?

    /// `pendingApprovals`, 0 when the server did not say.
    public var waitingApprovals: Int { max(0, pendingApprovals ?? 0) }

    public init(
        id: EntityID, brandId: EntityID, type: ContentType, title: String, brief: String = "",
        status: ContentStatus, targetPlatforms: [Platform], caption: String,
        currentVersion: ContentVersionRef?, approval: ContentApproval? = nil, createdAt: Date, updatedAt: Date,
        deletedAt: Date? = nil, pendingApprovals: Int? = nil
    ) {
        self.deletedAt = deletedAt
        self.pendingApprovals = pendingApprovals
        self.id = id
        self.brandId = brandId
        self.type = type
        self.title = title
        self.brief = brief
        self.status = status
        self.targetPlatforms = targetPlatforms
        self.caption = caption
        self.currentVersion = currentVersion
        self.approval = approval
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// `PATCH /api/contents/{id}`. Changing `caption` or `targetPlatforms` revokes an approval.
public struct ContentUpdate: Encodable, Sendable, Equatable {
    public var title: String?
    public var brief: String?
    public var targetPlatforms: [Platform]?
    public var caption: String?

    public init(title: String? = nil, brief: String? = nil, targetPlatforms: [Platform]? = nil, caption: String? = nil) {
        self.title = title
        self.brief = brief
        self.targetPlatforms = targetPlatforms
        self.caption = caption
    }
}

/// `POST /api/contents/{id}/transition` (manual transitions only).
public enum ContentManualTransition: String, Encodable, Sendable {
    case draft
    case inReview = "in_review"
    case approved
}

// MARK: - Schedules

public enum ScheduleStatus: String, OpenEnum {
    case pending, publishing, published, failed, cancelled
    case unknown

    /// Holds a slot (one active schedule per content + account).
    public var isActive: Bool { self == .pending || self == .publishing }
}

public struct Schedule: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var contentId: EntityID
    public var brandId: EntityID
    public var platform: Platform
    public var socialAccountId: EntityID
    public var versionId: EntityID
    public var contentHash: String
    public var scheduledAt: Date
    public var status: ScheduleStatus
    public var permalink: String?
    /// Who publishes it (P3): `cloud` once the order reached the cloud publisher, `local` = this Mac.
    public var delivery: ScheduleDelivery?
    /// When the order and its media reached the cloud publisher; nil = not (or no longer) there.
    public var cloudSyncedAt: Date?
    /// Last publishing error (Turkish), e.g. why the cloud refused the order or Meta's reason.
    public var lastError: String?
    public var cancelledAt: Date?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, contentId: EntityID, brandId: EntityID, platform: Platform, socialAccountId: EntityID,
        versionId: EntityID, contentHash: String, scheduledAt: Date, status: ScheduleStatus,
        permalink: String? = nil, delivery: ScheduleDelivery? = nil, cloudSyncedAt: Date? = nil, lastError: String? = nil,
        cancelledAt: Date? = nil, createdAt: Date, updatedAt: Date
    ) {
        self.delivery = delivery
        self.cloudSyncedAt = cloudSyncedAt
        self.lastError = lastError
        self.id = id
        self.contentId = contentId
        self.brandId = brandId
        self.platform = platform
        self.socialAccountId = socialAccountId
        self.versionId = versionId
        self.contentHash = contentHash
        self.scheduledAt = scheduledAt
        self.status = status
        self.permalink = permalink
        self.cancelledAt = cancelledAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// `ScheduleDelivery` in schedule.ts.
public enum ScheduleDelivery: String, OpenEnum {
    case local, cloud
    case unknown
}

public enum PublishLogStatus: String, OpenEnum {
    case started, succeeded, failed
    case unknown
}

public struct PublishLog: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var scheduleId: EntityID
    public var attempt: Int
    public var status: PublishLogStatus
    public var externalPostId: String?
    public var permalink: String?
    public var error: String?
    public var startedAt: Date
    public var finishedAt: Date?
    public var createdAt: Date

    public init(
        id: EntityID, scheduleId: EntityID, attempt: Int = 1, status: PublishLogStatus,
        externalPostId: String? = nil, permalink: String? = nil, error: String? = nil,
        startedAt: Date, finishedAt: Date? = nil, createdAt: Date
    ) {
        self.id = id
        self.scheduleId = scheduleId
        self.attempt = attempt
        self.status = status
        self.externalPostId = externalPostId
        self.permalink = permalink
        self.error = error
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.createdAt = createdAt
    }
}

public struct ScheduleCreate: Encodable, Sendable, Equatable {
    public var contentId: EntityID
    public var socialAccountId: EntityID
    public var platform: Platform?
    /// Must be in the future.
    public var scheduledAt: Date

    public init(contentId: EntityID, socialAccountId: EntityID, platform: Platform? = nil, scheduledAt: Date) {
        self.contentId = contentId
        self.socialAccountId = socialAccountId
        self.platform = platform
        self.scheduledAt = scheduledAt
    }
}
