import Foundation

// content-check.ts: production checks ("Kontroller") stored per content version as check runs
// (`GET /api/contents/{id}/checks`, newest first), run on demand by a `content.check` job.

public enum CheckStatus: String, OpenEnum {
    case pass, warn, fail, fixed, skipped
    case unknown

    /// The desktop's wording (checks-model.ts `STATUS_LABEL`).
    public var label: String {
        switch self {
        case .fail: "Başarısız"
        case .warn: "Uyarı"
        case .fixed: "Düzeltildi"
        case .pass: "Geçti"
        case .skipped: "Atlandı"
        case .unknown: "Bilinmiyor"
        }
    }
}

public enum CheckCategory: String, OpenEnum {
    case brief, brand, layout, text, accuracy, visual
    case unknown

    /// Step (roadmap 13) and Turkish label (`CHECK_CATEGORIES`).
    public var step: Int {
        switch self {
        case .brief: 1
        case .brand: 2
        case .layout: 3
        case .text: 4
        case .accuracy: 5
        case .visual: 6
        case .unknown: 7
        }
    }

    public var label: String {
        switch self {
        case .brief: "Brief"
        case .brand: "Marka uyumu"
        case .layout: "Yerleşim"
        case .text: "Metin"
        case .accuracy: "İçerik doğruluğu"
        case .visual: "Görsel kalite"
        case .unknown: "Diğer"
        }
    }
}

public enum CheckStrictness: String, OpenEnum {
    case relaxed, standard, strict
    case unknown
}

public enum CheckTrigger: String, OpenEnum {
    case generate, render, manual, fix
    case unknown
}

/// Where a finding is: a slide (0-based) and / or a layer (`data-layer` id).
public struct CheckRef: Codable, Sendable, Hashable {
    public var slide: Int?
    public var layer: String?

    public init(slide: Int?, layer: String?) {
        self.slide = slide
        self.layer = layer
    }
}

public struct ContentCheckResult: Codable, Sendable, Hashable {
    /// A check id (`layout.overflow`); kept a string so results of a newer worker still read.
    public var checkId: String
    public var category: CheckCategory
    public var status: CheckStatus
    /// Turkish, for the list.
    public var message: String
    public var refs: [CheckRef]
    /// `deterministic` or `model`.
    public var source: String
    /// "Düzelt" can fix it automatically (on the Mac).
    public var fixable: Bool

    public init(checkId: String, category: CheckCategory, status: CheckStatus, message: String, refs: [CheckRef] = [], source: String = "deterministic", fixable: Bool = false) {
        self.checkId = checkId
        self.category = category
        self.status = status
        self.message = message
        self.refs = refs
        self.source = source
        self.fixable = fixable
    }

    private enum CodingKeys: String, CodingKey { case checkId, category, status, message, refs, source, fixable }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checkId = try c.decode(String.self, forKey: .checkId)
        category = try c.decodeIfPresent(CheckCategory.self, forKey: .category) ?? .unknown
        status = try c.decode(CheckStatus.self, forKey: .status)
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        refs = (try? c.decodeIfPresent([CheckRef].self, forKey: .refs)) ?? []
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "deterministic"
        fixable = try c.decodeIfPresent(Bool.self, forKey: .fixable) ?? false
    }

    /// From the model pass ("AI").
    public var isModel: Bool { source == "model" }
}

public struct CheckSummary: Codable, Sendable, Hashable {
    public var pass: Int
    public var warn: Int
    public var fail: Int
    public var fixed: Int
    public var skipped: Int

    public init(pass: Int = 0, warn: Int = 0, fail: Int = 0, fixed: Int = 0, skipped: Int = 0) {
        self.pass = pass
        self.warn = warn
        self.fail = fail
        self.fixed = fixed
        self.skipped = skipped
    }
}

/// One run of the checks over one content version.
public struct ContentCheckRun: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var contentId: EntityID
    public var brandId: EntityID
    public var version: Int
    public var versionId: EntityID?
    public var trigger: CheckTrigger
    public var jobId: String?
    public var strictness: CheckStrictness
    public var summary: CheckSummary
    /// Results that hold approval back (`fail`, plus `warn` when strict).
    public var blocking: Int
    /// Problems first, then passes.
    public var results: [ContentCheckResult]
    public var model: String?
    /// This version is an automatic fix of that version.
    public var fromVersion: Int?
    /// An automatic fix of this version was stored as that version.
    public var fixedVersion: Int?
    public var note: String
    public var createdAt: Date

    public init(
        id: EntityID, contentId: EntityID, brandId: EntityID, version: Int, versionId: EntityID? = nil,
        trigger: CheckTrigger = .manual, jobId: String? = nil, strictness: CheckStrictness = .standard,
        summary: CheckSummary? = nil, blocking: Int? = nil, results: [ContentCheckResult], model: String? = nil,
        fromVersion: Int? = nil, fixedVersion: Int? = nil, note: String = "", createdAt: Date
    ) {
        self.id = id
        self.contentId = contentId
        self.brandId = brandId
        self.version = version
        self.versionId = versionId
        self.trigger = trigger
        self.jobId = jobId
        self.strictness = strictness
        let computed = ContentChecks.summarize(results, strictness: strictness)
        self.summary = summary ?? computed.summary
        self.blocking = blocking ?? computed.blocking
        self.results = results
        self.model = model
        self.fromVersion = fromVersion
        self.fixedVersion = fixedVersion
        self.note = note
        self.createdAt = createdAt
    }
}
