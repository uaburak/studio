import Foundation

// job.ts

/// Job types. Open: the worker learns new work over time, so an unknown type
/// is kept verbatim instead of failing the response.
public struct JobType: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
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

    public static let demoEcho: JobType = "demo.echo"
    public static let contentGenerate: JobType = "content.generate"
    public static let contentRender: JobType = "content.render"
    public static let brandAnalyze: JobType = "brand.analyze"
    public static let imageGenerate: JobType = "image.generate"
    public static let schedulePublish: JobType = "schedule.publish"
    public static let chatTurn: JobType = "chat.turn"

    /// Short Turkish label for job lists.
    public var label: String {
        switch self {
        case .contentGenerate: "Post üretimi"
        case .contentRender: "Görsel çıktısı"
        case .brandAnalyze: "Marka analizi"
        case .imageGenerate: "AI görsel üretimi"
        case .schedulePublish: "Zamanlı yayın"
        case .chatTurn: "Sohbet yanıtı"
        case .demoEcho: "Deneme işi"
        default: rawValue
        }
    }
}

public enum JobStatus: String, OpenEnum {
    case queued, running, succeeded, failed, cancelled
    case unknown

    public var isTerminal: Bool { self == .succeeded || self == .failed || self == .cancelled }
    public var isActive: Bool { self == .queued || self == .running }
}

public struct Job: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var type: JobType
    public var status: JobStatus
    public var payload: JSONObject
    public var brandId: EntityID?
    public var contentId: EntityID?
    public var createdAt: Date
    public var updatedAt: Date
    public var startedAt: Date?
    public var finishedAt: Date?
    /// 0...1, last reported progress.
    public var progress: Double?
    public var output: JSONObject?
    public var error: String?
    public var priority: Int?
    public var attempts: Int?
    public var maxAttempts: Int?
    public var workerId: String?
    public var progressMessage: String?
    /// Set while a cancel is pending on the worker (status is still `running`).
    public var cancelRequestedAt: Date?

    public init(
        id: EntityID, type: JobType, status: JobStatus, payload: JSONObject = [:], brandId: EntityID? = nil,
        contentId: EntityID? = nil, createdAt: Date, updatedAt: Date, startedAt: Date? = nil,
        finishedAt: Date? = nil, progress: Double? = nil, output: JSONObject? = nil, error: String? = nil,
        progressMessage: String? = nil
    ) {
        self.id = id
        self.type = type
        self.status = status
        self.payload = payload
        self.brandId = brandId
        self.contentId = contentId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.progress = progress
        self.output = output
        self.error = error
        self.progressMessage = progressMessage
    }

    /// Human title: the payload's `title` (content.generate), else the type label.
    public var displayTitle: String {
        if let title = payload["title"]?.stringValue, !title.isEmpty { return title }
        if let text = payload["text"]?.stringValue, !text.isEmpty, type == .demoEcho { return text }
        return type.label
    }
}

/// `POST /api/jobs`.
public struct JobCreate: Encodable, Sendable, Equatable {
    public var type: JobType
    public var payload: JSONObject
    public var brandId: EntityID?
    public var contentId: EntityID?
    public var priority: Int?

    public init(type: JobType, payload: JSONObject = [:], brandId: EntityID? = nil, contentId: EntityID? = nil, priority: Int? = nil) {
        self.type = type
        self.payload = payload
        self.brandId = brandId
        self.contentId = contentId
        self.priority = priority
    }
}

// MARK: - Worker presence

public struct ConnectedWorker: Codable, Sendable, Hashable {
    public var workerId: String
    public var workerVersion: String?
    public var capabilities: [String]
    public var concurrency: Int
    public var connectedAt: Date
    public var lastSeenAt: Date
    /// True after the worker announced a graceful shutdown.
    public var draining: Bool

    public init(
        workerId: String, workerVersion: String? = nil, capabilities: [String], concurrency: Int = 1,
        connectedAt: Date, lastSeenAt: Date, draining: Bool = false
    ) {
        self.workerId = workerId
        self.workerVersion = workerVersion
        self.capabilities = capabilities
        self.concurrency = concurrency
        self.connectedAt = connectedAt
        self.lastSeenAt = lastSeenAt
        self.draining = draining
    }
}

public struct PresenceJob: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var type: JobType
    public var brandId: EntityID?
    public var workerId: String?
    public var progress: Double?
    public var progressMessage: String?
    public var startedAt: Date?
}

/// One subscription limit window (`UsageWindow` in job.ts).
public struct UsageWindow: Codable, Sendable, Hashable {
    public enum Kind: String, OpenEnum {
        case fiveHour = "five_hour"
        case weekly, other
        case unknown
    }

    public var kind: Kind
    /// 0...100; nil when the worker could not read it.
    public var usedPercent: Double?
    public var resetsAt: Date?
    /// True when the window's limit is reached.
    public var limited: Bool

    public init(kind: Kind, usedPercent: Double? = nil, resetsAt: Date? = nil, limited: Bool = false) {
        self.kind = kind
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.limited = limited
    }
}

/// Remaining subscription usage, last reported by the Mac (`WorkerUsage` in job.ts).
public struct WorkerUsage: Codable, Sendable, Hashable {
    public var windows: [UsageWindow]
    public var source: String
    public var observedAt: Date

    public init(windows: [UsageWindow], source: String, observedAt: Date) {
        self.windows = windows
        self.source = source
        self.observedAt = observedAt
    }

    /// The fullest window (a limited one counts as 100 %): what a single usage ring shows.
    public var mostUsed: UsageWindow? {
        windows.max { $0.effectivePercent < $1.effectivePercent }
    }
}

extension UsageWindow {
    /// `usedPercent` clamped to 0...100; 100 when limited, 0 when unknown.
    public var effectivePercent: Double {
        if limited { return 100 }
        return min(max(usedPercent ?? 0, 0), 100)
    }
}

/// "Is the Mac online?": `GET /api/workers/presence` and the stream frames.
public struct WorkerPresence: Codable, Sendable, Hashable {
    public var online: Bool
    /// Last message from any worker; nil if no worker ever connected.
    public var lastSeenAt: Date?
    public var workers: [ConnectedWorker]
    public var currentJobs: [PresenceJob]
    public var queueLength: Int
    /// Latest subscription usage the Mac reported; nil until it sent one.
    public var usage: WorkerUsage?
    /// Latest Claude sign-in status the Mac reported; nil until it sent one.
    public var claude: ClaudeAccount?
    /// Latest Gemini API / CLI readiness the Mac reported; nil until it sent one.
    public var gemini: GeminiAccount?
    /// Codex CLI / OpenAI API / Antigravity CLI as the Mac last reported them; nil from older workers.
    public var providers: [AIProviderStatus]?

    public init(
        online: Bool, lastSeenAt: Date? = nil, workers: [ConnectedWorker] = [], currentJobs: [PresenceJob] = [], queueLength: Int = 0,
        usage: WorkerUsage? = nil, claude: ClaudeAccount? = nil, gemini: GeminiAccount? = nil,
        providers: [AIProviderStatus]? = nil
    ) {
        self.online = online
        self.lastSeenAt = lastSeenAt
        self.workers = workers
        self.currentJobs = currentJobs
        self.queueLength = queueLength
        self.usage = usage
        self.claude = claude
        self.gemini = gemini
        self.providers = providers
    }

    public static let offline = WorkerPresence(online: false)

    /// Whether a connected worker announced it can run `type`.
    public func canRun(_ type: JobType) -> Bool {
        workers.contains { !$0.draining && $0.capabilities.contains(type.rawValue) }
    }
}
