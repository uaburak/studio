import Foundation

/// Where a post stands, as the posts screen shows it.
public enum PostState: String, Sendable, Hashable {
    /// No version yet and a generation job is queued or running.
    case generating
    /// No version yet, nothing running.
    case draft
    /// The latest generation failed and nothing newer replaced it ("Üretilemedi", A3).
    case generationFailed
    /// The design has an empty image slot (or the plan asked for the user's image).
    case imageNeeded
    /// The user uploaded an image for the slot; the slot-fill pipeline has not placed it yet.
    case imageUploaded
    /// Has a version and can be approved.
    case ready
    case approved
    case scheduled
    case publishing
    case published
    case failed

    public var label: String {
        switch self {
        case .generating: "Üretiliyor"
        case .draft: "Taslak"
        case .generationFailed: "Üretilemedi"
        case .imageNeeded: "Görsel bekliyor"
        case .imageUploaded: "Görsel yüklendi"
        case .ready: "Hazır"
        case .approved: "Onaylandı"
        case .scheduled: "Zamanlandı"
        case .publishing: "Yayınlanıyor"
        case .published: "Yayında"
        case .failed: "Yayın hatası"
        }
    }

    /// Semantic tone of the status dot.
    public var tone: StatusTone {
        switch self {
        case .imageNeeded, .generating: .attention
        case .ready: .primary
        case .failed, .generationFailed: .attention
        default: .muted
        }
    }
}

/// Dot colour roles: attention = the accent (something waits on you or runs),
/// primary = black/white, muted = grey.
public enum StatusTone: Sendable, Hashable { case attention, primary, muted }

public enum PostFilter: String, CaseIterable, Sendable, Hashable {
    case all, ready, imageNeeded, approved

    public var label: String {
        switch self {
        case .all: "Tümü"
        case .ready: "Hazır"
        case .imageNeeded: "Görsel bekliyor"
        case .approved: "Onaylandı"
        }
    }

    public func matches(_ state: PostState) -> Bool {
        switch self {
        case .all: true
        case .ready: state == .ready
        case .imageNeeded: state == .imageNeeded || state == .imageUploaded
        case .approved: [.approved, .scheduled, .publishing, .published].contains(state)
        }
    }
}

/// Neutral placeholder look for a post without rendered images.
public enum PlaceholderTone: Sendable, Hashable {
    case light, dark, muted

    /// Stable per id (FNV-1a), so a card keeps its tone across launches.
    public static func stable(for id: String) -> PlaceholderTone {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in id.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return hash % 2 == 0 ? .light : .dark
    }
}

/// An image the user uploaded for a post's slot, kept until a version fills it.
public struct PendingSlotImage: Sendable, Hashable, Codable {
    public var contentId: EntityID
    public var assetId: EntityID
    /// The version that was current when the image was uploaded.
    public var forVersion: Int?
    public var uploadedAt: Date

    public init(contentId: EntityID, assetId: EntityID, forVersion: Int?, uploadedAt: Date) {
        self.contentId = contentId
        self.assetId = assetId
        self.forVersion = forVersion
        self.uploadedAt = uploadedAt
    }
}

/// One card of the posts screen: a content item with everything known about it.
public struct PostCard: Sendable, Hashable, Identifiable {
    public var content: Content
    public var version: ContentVersion?
    public var planItem: PlanItem?
    /// The active (pending/publishing) schedule, if any.
    public var schedule: Schedule?
    public var pendingImage: PendingSlotImage?
    /// The latest generation job for this content.
    public var job: Job?

    public var id: EntityID { content.id }

    public init(content: Content, version: ContentVersion? = nil, planItem: PlanItem? = nil, schedule: Schedule? = nil, pendingImage: PendingSlotImage? = nil, job: Job? = nil) {
        self.content = content
        self.version = version
        self.planItem = planItem
        self.schedule = schedule
        self.pendingImage = pendingImage
        self.job = job
    }

    public var title: String { content.title }

    /// The plan's pillar, as the card's eyebrow (`YENİ ÜRÜN`).
    public var eyebrow: String? {
        guard let pillar = planItem?.pillar, !pillar.isEmpty else { return nil }
        return TurkishFormat.upper(pillar)
    }

    public var slots: [ImageSlot] { version.map { SlotScanner.slots(in: $0.slides) } ?? [] }

    /// Whether the user still owes an image.
    public var needsImage: Bool {
        if let version {
            let slots = SlotScanner.slots(in: version.slides)
            if !slots.isEmpty { return slots.contains(where: \.isEmpty) }
        }
        return planItem?.imageSlot == .userUpload && version == nil
    }

    /// Rendered slide images, when the worker produced them.
    public var renderedAssetIds: [EntityID] {
        version?.slides.compactMap(\.renderedAssetId) ?? []
    }

    /// Publication day: the active schedule, else the plan's date.
    public var day: CalendarDay? {
        if let schedule { return CalendarDay(schedule.scheduledAt) }
        return planItem?.date
    }

    public var state: PostState {
        switch content.status {
        case .approved: return .approved
        case .scheduled: return .scheduled
        case .publishing: return .publishing
        case .published: return .published
        case .failed: return .failed
        case .draft, .inReview, .unknown:
            if content.currentVersion == nil {
                if let job, job.status.isActive { return .generating }
                if let generation = planItem?.generation, generation.status.isActive { return .generating }
                if generationFailure != nil { return .generationFailed }
                return planItem?.imageSlot == .userUpload ? .imageNeeded : .draft
            }
            if generationFailure != nil { return .generationFailed }
            if needsImage {
                if let pendingImage, pendingImage.forVersion == content.currentVersion?.version { return .imageUploaded }
                return .imageNeeded
            }
            return .ready
        }
    }

    /// The failed generation the card shows (A3): no version yet, or the failure came after the
    /// current version (a revision that failed). A cancelled job is not a failure; a newer job
    /// (running or done) settles it. Mirrors `generationFailure` in the desktop board.
    public var generationFailure: GenerationFailure? {
        var failed: (id: EntityID, error: String?, at: Date)?
        if let job, job.type == .contentGenerate {
            guard job.status == .failed else { return nil }
            failed = (job.id, job.error, job.finishedAt ?? job.updatedAt)
        } else if let item = planItem, let generation = item.generation, generation.status == .failed {
            failed = (generation.jobId, generation.error, item.updatedAt)
        }
        guard let failed else { return nil }
        if content.currentVersion != nil {
            // A version made after the failure settles it; without the loaded version the
            // failure is not shown on a post that has a design.
            guard let version, version.createdAt < failed.at else { return nil }
        }
        return GenerationFailure(jobId: failed.id, error: failed.error)
    }

    public var placeholderTone: PlaceholderTone {
        needsImage || state == .imageUploaded ? .muted : .stable(for: content.id)
    }

    /// Hash to approve with, when the loaded version is the current one and
    /// its recomputed hash matches what the server reports.
    public var approvableHash: String? {
        guard content.status.isApprovable, let ref = content.currentVersion else { return nil }
        guard let version, version.version == ref.version else { return nil }
        let local = ContentHash.compute(version.slides)
        return local == ref.contentHash ? local : nil
    }
}

/// Why a post could not be generated, and the job "Yeniden dene" retries.
public struct GenerationFailure: Sendable, Hashable {
    public var jobId: EntityID
    /// The server's message as it came.
    public var error: String?

    public init(jobId: EntityID, error: String?) {
        self.jobId = jobId
        self.error = error
    }

    /// The reason in plain Turkish (`failureText` in the desktop app).
    public var reason: String { Self.text(error) }

    private static let patterns: [(String, String)] = [
        ("lost the job|gave up after", "Mac'teki işçi işi yarıda bıraktı."),
        ("usage limit|rate.?limit|\\b429\\b|quota", "Yapay zekâ kullanım sınırına takıldı."),
        ("timed? ?out|timeout|deadline", "İş zamanında bitmedi."),
        ("render(ing)? failed|could not render|chromium|playwright", "Görsel oluşturulamadı."),
        ("invalid json|unexpected token|did not match|schema|parse", "Yapay zekâ geçersiz bir yanıt verdi."),
        ("ECONN|ENOTFOUND|network|fetch failed|socket hang up", "Bağlantı kurulamadı."),
        ("cancel", "İş durduruldu."),
        ("not found|\\b404\\b", "Gerekli kayıt bulunamadı (silinmiş olabilir)."),
    ]

    private static let turkish = "[çğıöşüÇĞİÖŞÜ]|\\b(post|marka|görsel|yapay zekâ|sürüm|kontrol|hata|bulunamadı)\\b"

    public static func text(_ error: String?) -> String {
        let raw = (error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "Neden bildirilmedi." }
        if raw.range(of: turkish, options: [.regularExpression, .caseInsensitive]) != nil { return raw }
        for (pattern, text) in patterns where raw.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil {
            return text
        }
        return "İş başarısız oldu."
    }
}

/// Builds and filters the cards of one brand's month.
public struct PostBoard: Sendable, Equatable {
    public var cards: [PostCard]

    public init(cards: [PostCard]) {
        self.cards = cards
    }

    public init(
        contents: [Content], versions: [EntityID: ContentVersion], plans: [Plan], schedules: [Schedule],
        jobs: [Job] = [], pendingImages: [EntityID: PendingSlotImage] = [:]
    ) {
        var itemsByContent: [EntityID: PlanItem] = [:]
        // Older plans first, so the newest plan wins for a content id.
        for plan in plans.sorted(by: { $0.createdAt < $1.createdAt }) {
            for item in plan.items { if let id = item.contentId { itemsByContent[id] = item } }
        }
        var scheduleByContent: [EntityID: Schedule] = [:]
        for schedule in schedules where schedule.status.isActive {
            if let existing = scheduleByContent[schedule.contentId], existing.scheduledAt <= schedule.scheduledAt { continue }
            scheduleByContent[schedule.contentId] = schedule
        }
        var jobByContent: [EntityID: Job] = [:]
        for job in jobs where job.type == .contentGenerate || job.type == .contentRender {
            guard let id = job.contentId else { continue }
            if let existing = jobByContent[id], existing.createdAt >= job.createdAt { continue }
            jobByContent[id] = job
        }
        cards = contents.filter { $0.deletedAt == nil }.map { content in
            let version = versions[content.id].flatMap { $0.version == content.currentVersion?.version ? $0 : nil }
            return PostCard(
                content: content, version: version, planItem: itemsByContent[content.id],
                schedule: scheduleByContent[content.id], pendingImage: pendingImages[content.id],
                job: jobByContent[content.id])
        }
        sort()
    }

    /// By day (undated last), then creation time.
    public mutating func sort() {
        cards.sort { a, b in
            switch (a.day, b.day) {
            case let (x?, y?) where x != y: return x < y
            case (.some, nil): return true
            case (nil, .some): return false
            default: return a.content.createdAt < b.content.createdAt
            }
        }
    }

    /// Cards of `month`; undated cards belong to the month they were created in.
    public func cards(in month: MonthKey, timeZone: TimeZone = .current) -> [PostCard] {
        cards.filter { card in
            (card.day?.monthKey ?? MonthKey(card.content.createdAt, in: timeZone)) == month
        }
    }

    /// Months that have cards, ascending.
    public func months(timeZone: TimeZone = .current) -> [MonthKey] {
        Set(cards.map { $0.day?.monthKey ?? MonthKey($0.content.createdAt, in: timeZone) }).sorted()
    }

    public static func counts(_ cards: [PostCard]) -> [PostFilter: Int] {
        var counts: [PostFilter: Int] = [:]
        for filter in PostFilter.allCases {
            counts[filter] = cards.filter { filter.matches($0.state) }.count
        }
        return counts
    }

    /// Cards the floating bar approves in one go: ready, with a verified hash.
    public static func approvable(_ cards: [PostCard]) -> [PostCard] {
        cards.filter { $0.state == .ready && $0.approvableHash != nil }
    }
}

/// Which post a finished job changed (M6): the phone refreshes only that post instead of the
/// whole list. Chat answers, brand work and echo jobs touch no post (nil).
public enum PostRefreshPlanner {
    public static func affectedContent(of job: Job) -> EntityID? {
        switch job.type {
        case .contentGenerate, .contentRender, .contentCheck, .schedulePublish, .canvasApply:
            return job.contentId
        case .imageGenerate:
            return job.contentId ?? job.payload["targetContentId"]?.stringValue
        default:
            return nil
        }
    }
}
