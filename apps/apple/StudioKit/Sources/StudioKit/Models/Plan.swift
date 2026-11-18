import Foundation

// plan.ts: content plans the chat agent proposes.

/// What a plan item expects for its image slot(s).
public enum ImageSlotExpectation: String, OpenEnum {
    case none
    case userUpload = "user_upload"
    case aiGenerate = "ai_generate"
    case unknown
}

public enum PlanStatus: String, OpenEnum {
    case draft, proposed, accepted, rejected, superseded
    case unknown

    /// Edits and acceptance are allowed only while open.
    public var isOpen: Bool { self == .draft || self == .proposed }
}

public enum PlanItemStatus: String, OpenEnum {
    case planned, accepted, skipped
    case unknown
}

public struct PlanItemGeneration: Codable, Sendable, Hashable {
    public var jobId: EntityID
    public var status: JobStatus
    public var error: String?

    public init(jobId: EntityID, status: JobStatus, error: String? = nil) {
        self.jobId = jobId
        self.status = status
        self.error = error
    }
}

public struct PlanItem: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var planId: EntityID
    public var position: Int
    public var date: CalendarDay?
    public var platforms: [Platform]
    public var contentType: ContentType
    public var title: String
    public var brief: String
    /// Content pillar / theme, e.g. "ürün tanıtımı".
    public var pillar: String?
    public var imageSlot: ImageSlotExpectation
    public var imageBrief: String?
    public var status: PlanItemStatus
    /// Draft content item created when the plan was accepted.
    public var contentId: EntityID?
    public var generation: PlanItemGeneration?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, planId: EntityID, position: Int, date: CalendarDay?, platforms: [Platform],
        contentType: ContentType = .post, title: String, brief: String = "", pillar: String? = nil,
        imageSlot: ImageSlotExpectation = .none, imageBrief: String? = nil, status: PlanItemStatus = .planned,
        contentId: EntityID? = nil, generation: PlanItemGeneration? = nil, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.planId = planId
        self.position = position
        self.date = date
        self.platforms = platforms
        self.contentType = contentType
        self.title = title
        self.brief = brief
        self.pillar = pillar
        self.imageSlot = imageSlot
        self.imageBrief = imageBrief
        self.status = status
        self.contentId = contentId
        self.generation = generation
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct Plan: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var conversationId: EntityID?
    public var runId: EntityID?
    public var title: String
    public var periodStart: CalendarDay
    public var periodEnd: CalendarDay
    public var status: PlanStatus
    public var summary: String
    /// Bumped by every edit; accepting requires the revision the user looked at.
    public var revision: Int
    public var decidedAt: Date?
    public var rejectionReason: String?
    public var items: [PlanItem]
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, brandId: EntityID, conversationId: EntityID?, runId: EntityID? = nil, title: String,
        periodStart: CalendarDay, periodEnd: CalendarDay, status: PlanStatus, summary: String, revision: Int = 1,
        decidedAt: Date? = nil, rejectionReason: String? = nil, items: [PlanItem], createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.brandId = brandId
        self.conversationId = conversationId
        self.runId = runId
        self.title = title
        self.periodStart = periodStart
        self.periodEnd = periodEnd
        self.status = status
        self.summary = summary
        self.revision = revision
        self.decidedAt = decidedAt
        self.rejectionReason = rejectionReason
        self.items = items
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Items that leave an image slot for the user.
    public var userImageItemCount: Int { items.filter { $0.imageSlot == .userUpload }.count }
}

public struct PlanAccept: Encodable, Sendable, Equatable {
    public var revision: Int
    public var skipItemIds: [EntityID]

    public init(revision: Int, skipItemIds: [EntityID] = []) {
        self.revision = revision
        self.skipItemIds = skipItemIds
    }
}

public struct PlanReject: Encodable, Sendable, Equatable {
    public var reason: String?
    public init(reason: String? = nil) { self.reason = reason }
}

public struct PlanGenerate: Encodable, Sendable, Equatable {
    public var itemIds: [EntityID]?
    public var instructions: String?
    /// Copied into each `content.generate` job; nil = worker default.
    public var model: AgentModel?
    public var effort: AgentEffort?

    public init(itemIds: [EntityID]? = nil, instructions: String? = nil, model: AgentModel? = nil, effort: AgentEffort? = nil) {
        self.itemIds = itemIds
        self.instructions = instructions
        self.model = model?.sendable
        self.effort = effort?.sendable
    }
}

/// Why `POST /api/plans/{id}/generate` left an accepted item alone (`PlanGenerateSkipReason`).
public enum PlanGenerateSkipReason: String, OpenEnum {
    case generating, generated, edited, approved, published
    case noContent = "no_content"
    case unknown

    public var label: String {
        switch self {
        case .generating: "zaten üretiliyor"
        case .generated: "tasarımı hazır"
        case .edited: "elle düzenlenmiş"
        case .approved: "onaylanmış"
        case .published: "yayınlanmış"
        case .noContent: "postu silinmiş"
        case .unknown: "atlandı"
        }
    }
}

public struct PlanGenerateSkip: Codable, Sendable, Hashable {
    public var itemId: EntityID
    public var reason: PlanGenerateSkipReason

    public init(itemId: EntityID, reason: PlanGenerateSkipReason) {
        self.itemId = itemId
        self.reason = reason
    }
}

public struct PlanGenerateResult: Decodable, Sendable, Equatable {
    public var plan: Plan
    public var jobs: [Job]
    /// Accepted items left alone this round (absent from older servers: empty).
    public var skipped: [PlanGenerateSkip]

    public init(plan: Plan, jobs: [Job] = [], skipped: [PlanGenerateSkip] = []) {
        self.plan = plan
        self.jobs = jobs
        self.skipped = skipped
    }

    enum CodingKeys: String, CodingKey { case plan, jobs, skipped }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        plan = try c.decode(Plan.self, forKey: .plan)
        jobs = try c.decodeIfPresent([Job].self, forKey: .jobs) ?? []
        skipped = try c.decodeIfPresent([PlanGenerateSkip].self, forKey: .skipped) ?? []
    }

    /// "2 post atlandı: Kahvaltı (tasarımı hazır), …" (nil when nothing was skipped).
    public var skippedSummary: String? {
        guard !skipped.isEmpty else { return nil }
        let names = skipped.prefix(4).map { skip -> String in
            let title = plan.items.first { $0.id == skip.itemId }?.title ?? "Post"
            return "\(title) (\(skip.reason.label))"
        }
        let more = skipped.count > 4 ? ", … ve \(skipped.count - 4) post daha" : ""
        return "\(skipped.count) post atlandı: " + names.joined(separator: ", ") + more
    }
}
