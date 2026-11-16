import Foundation

// Hand-written mirrors of the zod schemas in packages/contract/src. Property
// names match the OpenAPI components one to one; `OpenAPIDriftTests` compares
// them against the document the API serves (`/api/openapi.json`), and
// `DecodingTests` decodes responses captured from the running API.

// MARK: - Common

enum Platform: String, ResilientEnum, Identifiable {
    case instagram, facebook, linkedin
    case unknown
    var id: String { rawValue }
}

/// `{ items, nextCursor }` — every list endpoint.
struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    var items: [Item]
    var nextCursor: String?
}

// MARK: - Brand

enum BrandStatus: String, ResilientEnum {
    case active, archived
    case unknown
}

struct Brand: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var slug: String
    var defaultLanguage: String
    var status: BrandStatus
    var createdAt: Date
    var updatedAt: Date
}

// MARK: - Social account

enum SocialAccountStatus: String, ResilientEnum {
    case pending, connected
    case needsReauth = "needs_reauth"
    case disabled
    case unknown
}

struct SocialAccount: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var brandId: String
    var platform: Platform
    var handle: String
    var externalId: String?
    var status: SocialAccountStatus
    var createdAt: Date
    var updatedAt: Date
}

// MARK: - Asset

enum AssetKind: String, ResilientEnum {
    case image, video, audio, font, logo, other
    case unknown
}

enum AssetSource: String, ResilientEnum {
    case upload, generated, ingested
    case unknown
}

struct Asset: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var brandId: String
    var kind: AssetKind
    var source: AssetSource
    var objectKey: String
    var mimeType: String
    var bytes: Int
    var sha256: String
    var width: Int?
    var height: Int?
    var durationMs: Int?
    var originalFilename: String?
    var createdAt: Date
}

// MARK: - Content

enum ContentType: String, ResilientEnum, Identifiable {
    case post, carousel, story, reel
    case unknown
    var id: String { rawValue }
}

/// Lifecycle from PLAN.md §8.
enum ContentStatus: String, ResilientEnum, Identifiable {
    case draft
    case inReview = "in_review"
    case approved, scheduled, publishing, published, failed
    case unknown
    var id: String { rawValue }

    /// `APPROVABLE_STATUSES`
    var isApprovable: Bool { self == .draft || self == .inReview }
    /// `SCHEDULABLE_STATUSES`
    var isSchedulable: Bool { self == .approved || self == .scheduled || self == .failed }
    /// Caption changes are refused while publishing or published.
    var allowsCaptionEdit: Bool { self != .publishing && self != .published && self != .unknown }
    /// Changing the caption drops the approval (back to draft).
    var captionEditRevokesApproval: Bool {
        self == .approved || self == .scheduled || self == .failed
    }
}

enum ContentVersionOrigin: String, ResilientEnum {
    case generated
    case manualEdit = "manual_edit"
    case aiEdit = "ai_edit"
    case unknown
}

struct ContentVersionRef: Codable, Hashable, Sendable {
    var id: String
    var version: Int
    var contentHash: String
}

struct ContentApproval: Codable, Hashable, Sendable {
    var versionId: String
    var contentHash: String
    var approvedAt: Date
}

struct Content: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var brandId: String
    var type: ContentType
    var title: String
    var brief: String
    var status: ContentStatus
    var targetPlatforms: [Platform]
    var caption: String
    var currentVersion: ContentVersionRef?
    var approval: ContentApproval?
    var createdAt: Date
    var updatedAt: Date
}

struct Slide: Codable, Hashable, Sendable {
    var html: String
    var width: Int
    var height: Int
    var renderedAssetId: String?
}

/// Version without slide HTML (list responses).
struct ContentVersionSummary: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var contentId: String
    var version: Int
    var origin: ContentVersionOrigin
    var contentHash: String
    var slideCount: Int
    var note: String?
    var jobId: String?
    var createdAt: Date
    var updatedAt: Date
}

struct ContentVersion: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var contentId: String
    var version: Int
    var origin: ContentVersionOrigin
    var contentHash: String
    var slideCount: Int
    var note: String?
    var jobId: String?
    var createdAt: Date
    var updatedAt: Date
    var slides: [Slide]

    var summary: ContentVersionSummary {
        ContentVersionSummary(
            id: id, contentId: contentId, version: version, origin: origin,
            contentHash: contentHash, slideCount: slideCount, note: note, jobId: jobId,
            createdAt: createdAt, updatedAt: updatedAt)
    }
}

// MARK: - Jobs and presence

enum JobType: String, ResilientEnum {
    case demoEcho = "demo.echo"
    case contentGenerate = "content.generate"
    case contentRender = "content.render"
    case brandAnalyze = "brand.analyze"
    case unknown
}

enum JobStatus: String, ResilientEnum {
    case queued, running, succeeded, failed, cancelled
    case unknown

    /// `TERMINAL_JOB_STATUSES`
    var isTerminal: Bool { self == .succeeded || self == .failed || self == .cancelled }
    var isActive: Bool { self == .queued || self == .running }
}

struct Job: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var type: JobType
    var status: JobStatus
    var payload: [String: JSONValue]
    var brandId: String?
    var contentId: String?
    var createdAt: Date
    var updatedAt: Date
    var startedAt: Date?
    var finishedAt: Date?
    var progress: Double?
    var output: [String: JSONValue]?
    var error: String?
    var priority: Int?
    var attempts: Int?
    var maxAttempts: Int?
    var workerId: String?
    var progressMessage: String?
    var cancelRequestedAt: Date?

    /// Queued jobs cancel at once; running ones wait for the worker.
    var isCancellable: Bool { status.isActive && cancelRequestedAt == nil }
}

struct ConnectedWorker: Codable, Hashable, Sendable {
    var workerId: String
    var workerVersion: String?
    var capabilities: [String]
    var concurrency: Int
    var connectedAt: Date
    var lastSeenAt: Date
    var draining: Bool
}

struct PresenceJob: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var type: JobType
    var brandId: String?
    var workerId: String?
    var progress: Double?
    var progressMessage: String?
    var startedAt: Date?
}

/// "Is the Mac online?" — `GET /api/workers/presence` and the job stream.
struct WorkerPresence: Codable, Hashable, Sendable {
    var online: Bool
    var lastSeenAt: Date?
    var workers: [ConnectedWorker]
    var currentJobs: [PresenceJob]
    var queueLength: Int
}

// MARK: - Schedules

enum ScheduleStatus: String, ResilientEnum {
    case pending, publishing, published, failed, cancelled
    case unknown

    var isActive: Bool { self == .pending || self == .publishing }
}

struct Schedule: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var contentId: String
    var brandId: String
    var platform: Platform
    var socialAccountId: String
    var versionId: String
    var contentHash: String
    var scheduledAt: Date
    var status: ScheduleStatus
    var cancelledAt: Date?
    var createdAt: Date
    var updatedAt: Date
}

// MARK: - Health

struct HealthResponse: Codable, Hashable, Sendable {
    struct Checks: Codable, Hashable, Sendable { var db: String }
    var status: String
    var service: String
    var version: String
    var time: Date
    var checks: Checks
}
