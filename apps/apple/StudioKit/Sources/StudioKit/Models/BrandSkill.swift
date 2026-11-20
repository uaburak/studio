import Foundation

// brand-skill.ts: the brand's Markdown instructions for the agent ("Skill'ler" under Marka Kiti),
// versioned per skill, switched on and off without deleting. `brand.skill_draft` drafts one with
// AI (it arrives switched off).

/// Where a version came from: typed by hand, drafted by AI, or an older version brought back.
public enum BrandSkillOrigin: String, OpenEnum {
    case manual
    case aiDraft = "ai_draft"
    case restore
    case unknown

    /// The desktop's wording (skills-model.ts `ORIGIN_LABEL`).
    public var label: String {
        switch self {
        case .manual: "Elle"
        case .aiDraft: "AI taslağı"
        case .restore: "Geri yüklendi"
        case .unknown: "Bilinmiyor"
        }
    }
}

/// `GET /api/brands/{brandId}/skills` (oldest first).
public struct BrandSkill: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    /// kebab-case, unique per brand (`tek-gorsel-post`).
    public var name: String
    public var description: String
    /// Markdown instructions.
    public var body: String
    /// Switched-off skills are kept but never reach the agent.
    public var enabled: Bool
    /// Current version (1, 2, 3 … per skill).
    public var version: Int
    public var origin: BrandSkillOrigin
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, brandId: EntityID, name: String, description: String = "", body: String,
        enabled: Bool = true, version: Int = 1, origin: BrandSkillOrigin = .manual, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.brandId = brandId
        self.name = name
        self.description = description
        self.body = body
        self.enabled = enabled
        self.version = version
        self.origin = origin
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// One stored version of a skill (newest first in the list).
public struct BrandSkillVersion: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var skillId: EntityID
    public var brandId: EntityID
    public var version: Int
    public var name: String
    public var description: String
    public var body: String
    public var origin: BrandSkillOrigin
    /// What changed, in the user's words ("" when none).
    public var note: String
    /// The `brand.skill_draft` job that wrote it, for AI drafts.
    public var jobId: String?
    public var createdAt: Date

    public init(
        id: EntityID, skillId: EntityID, brandId: EntityID, version: Int, name: String, description: String,
        body: String, origin: BrandSkillOrigin, note: String = "", jobId: String? = nil, createdAt: Date
    ) {
        self.id = id
        self.skillId = skillId
        self.brandId = brandId
        self.version = version
        self.name = name
        self.description = description
        self.body = body
        self.origin = origin
        self.note = note
        self.jobId = jobId
        self.createdAt = createdAt
    }
}

/// `POST /api/brands/{brandId}/skills`.
public struct BrandSkillCreate: Encodable, Sendable, Equatable {
    public var name: String
    public var description: String
    public var body: String
    public var enabled: Bool?
    public var note: String?

    public init(name: String, description: String = "", body: String, enabled: Bool? = nil, note: String? = nil) {
        self.name = name
        self.description = description
        self.body = body
        self.enabled = enabled
        self.note = note
    }
}

/// `PATCH /api/brands/{brandId}/skills/{id}`: a change of name, description or body stores a
/// new version; `enabled` alone does not.
public struct BrandSkillUpdate: Encodable, Sendable, Equatable {
    public var name: String?
    public var description: String?
    public var body: String?
    public var enabled: Bool?
    public var note: String?

    public init(name: String? = nil, description: String? = nil, body: String? = nil, enabled: Bool? = nil, note: String? = nil) {
        self.name = name
        self.description = description
        self.body = body
        self.enabled = enabled
        self.note = note
    }
}

/// The skill editor's rules (skills-model.ts), so the phone refuses what the API would.
public enum BrandSkillRules {
    public static let maxSkills = 30
    public static let maxBodyChars = 40_000
    public static let maxDescriptionChars = 300

    /// The starting text of a new skill (`NEW_SKILL_BODY`).
    public static let newBody = """
    # Başlık

    ## Ne zaman kullanılır
    -

    ## Ölçüler ve yerleşim
    - Tuval 1080×1350, kenar boşluğu 72 px.
    -

    ## Tipografi ve renk
    -

    ## Ton ve metin
    -

    ## Yapılacaklar
    -

    ## Yapılmayacaklar
    -

    """

    /// `ad`, `ad-2`, `ad-3` …: the first name not in `taken` (`uniqueSkillName`).
    public static func uniqueName(_ base: String, taken: [String]) -> String {
        let used = Set(taken)
        var clean = String(Brand.slugify(base).prefix(44))
        while clean.hasSuffix("-") { clean.removeLast() }
        if clean.isEmpty { clean = "skill" }
        if !used.contains(clean) { return clean }
        var index = 2
        while used.contains("\(clean)-\(index)") { index += 1 }
        return "\(clean)-\(index)"
    }

    /// The first reason the form cannot be saved (Turkish), or nil (`skillFormProblem`).
    public static func problem(name: String, description: String, body: String, otherNames: [String]) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Skill'e bir ad ver." }
        if trimmed.count > 48 || !isValidName(trimmed) {
            return "Ad küçük harf, rakam ve tire içermeli (ör. tek-gorsel-post)."
        }
        if otherNames.contains(trimmed) { return "“\(trimmed)” adında bir skill zaten var." }
        if description.trimmingCharacters(in: .whitespacesAndNewlines).count > maxDescriptionChars {
            return "Açıklama en fazla \(maxDescriptionChars) karakter olabilir."
        }
        if body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Skill metni boş olamaz." }
        if body.count > maxBodyChars { return "Skill metni en fazla 40.000 karakter olabilir." }
        return nil
    }

    /// kebab-case starting with a letter or digit.
    public static func isValidName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, isLowerOrDigit(first) else { return false }
        return name.unicodeScalars.allSatisfy { isLowerOrDigit($0) || $0 == "-" }
    }

    private static func isLowerOrDigit(_ scalar: Unicode.Scalar) -> Bool {
        (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
    }

    /// Why "Yeni skill" cannot add one, or nil.
    public static func addBlocker(count: Int) -> String? {
        count >= maxSkills ? "Bir markada en fazla \(maxSkills) skill olabilir." : nil
    }

    /// Why "AI ile çıkar" cannot start, or nil.
    public static func draftBlocker(archived: Bool, workerOnline: Bool, count: Int) -> String? {
        if archived { return "Arşivlenmiş markada skill çıkarılamaz." }
        if let limit = addBlocker(count: count) { return limit }
        if !workerOnline { return "Arka plan çalışmıyor; Studio hazır olunca skill çıkarılabilir." }
        return nil
    }

    /// "v3 · AI taslağı · kapalı" under a skill in the list (`skillMeta`).
    public static func meta(_ skill: BrandSkill) -> String {
        var parts = ["v\(skill.version)"]
        if skill.origin != .manual { parts.append(skill.origin.label) }
        if !skill.enabled { parts.append("kapalı") }
        return parts.joined(separator: " · ")
    }

    /// The `brand.skill_draft` payload ("AI ile çıkar"; an empty focus lets the model pick).
    public static func draftPayload(focus: String) -> JSONObject {
        let trimmed = focus.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? [:] : ["focus": .string(String(trimmed.prefix(2000)))]
    }
}
