import Foundation

// approval.ts, generation.ts and mention.ts (docs/URETIM-RESIM.md, Faz 0 / Faz 1): approval
// requests ("Onay bekleyenler"), the post production engine, and `@product` / `@post` mentions.
// Every field a newer server added is optional or defaulted so older servers still decode.

// MARK: - Generation engine

/// `GenerationEngine`: who designs a post. `wecra`, `html` and `svg` run today; `code` is "yakında".
public enum GenerationEngine: String, OpenEnum {
    case wecra, html, svg, code
    case unknown

    /// `READY_GENERATION_ENGINES`.
    public static let ready: [GenerationEngine] = [.wecra, .html, .svg]
    /// The order the brand page lists them in.
    public static let listed: [GenerationEngine] = [.wecra, .html, .svg, .code]

    public var isReady: Bool { Self.ready.contains(self) }

    /// `GENERATION_ENGINE_LABELS`.
    public var label: String {
        switch self {
        case .wecra: "Wecra"
        case .html: "HTML"
        case .svg: "SVG"
        case .code: "Kod"
        case .unknown: "Bilinmeyen"
        }
    }

    public var detail: String {
        switch self {
        case .wecra: "Wecra'nın kendi araçlarıyla, tuvalde düzenlenebilir"
        case .html: "HTML/CSS ile tasarım"
        case .svg: "Vektör; hızlı, ucuz, her seferinde aynı sonuç"
        case .code: "Python ile, kapalı bir alanda"
        case .unknown: ""
        }
    }
}

/// `MAX_IMAGE_STYLE_PRESET_LENGTH`.
public enum ImageStylePreset {
    public static let maxLength = 500
}

// MARK: - Approval requests

/// `ApprovalKind`.
public enum ApprovalKind: String, OpenEnum {
    case productImage = "product_image"
    case variant
    case productPhotoUpgrade = "product_photo_upgrade"
    case unknown

    public var label: String {
        switch self {
        case .productImage: "Ürün görseli"
        case .variant: "Varyant"
        case .productPhotoUpgrade: "Ürün fotoğrafı iyileştirme"
        case .unknown: "Görsel"
        }
    }
}

/// `ApprovalStatus`.
public enum ApprovalStatus: String, OpenEnum {
    case pending, approved, rejected, superseded
    case unknown

    public var label: String {
        switch self {
        case .pending: "Onay bekliyor"
        case .approved: "Onaylandı"
        case .rejected: "Reddedildi"
        case .superseded: "Yeniden üretildi"
        case .unknown: "Bilinmeyen"
        }
    }
}

/// `status` of `GET /api/approvals` (`all` lists every status).
public enum ApprovalStatusFilter: String, Sendable, CaseIterable {
    case pending, approved, rejected, superseded, all
}

/// One aspect the AI compared with the product's own photos and facts ("Etiket yazısı").
public struct ApprovalCheckItem: Codable, Sendable, Hashable {
    public var aspect: String
    public var ok: Bool
    /// What is wrong ("" when fine).
    public var note: String

    public init(aspect: String, ok: Bool, note: String = "") {
        self.aspect = aspect
        self.ok = ok
        self.note = note
    }

    private enum CodingKeys: String, CodingKey { case aspect, ok, note }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        aspect = try c.decodeIfPresent(String.self, forKey: .aspect) ?? ""
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
    }
}

/// The AI check's report on the candidate pictures.
public struct ApprovalCheckReport: Codable, Sendable, Hashable {
    public var passed: Bool
    public var items: [ApprovalCheckItem]
    /// One or two sentences for the chat ("Şu kısımlar hatalı geldi: …").
    public var summary: String

    public init(passed: Bool, items: [ApprovalCheckItem] = [], summary: String = "") {
        self.passed = passed
        self.items = items
        self.summary = summary
    }

    private enum CodingKeys: String, CodingKey { case passed, items, summary }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent([ApprovalCheckItem].self, forKey: .items)) ?? []
        passed = try c.decodeIfPresent(Bool.self, forKey: .passed) ?? !items.contains { !$0.ok }
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
    }

    public var failed: [ApprovalCheckItem] { items.filter { !$0.ok } }

    /// One short line for lists: the summary, else "Sorun yok" / "2 sorun: Etiket yazısı, Kapak".
    public var shortLine: String {
        let text = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        let failed = self.failed
        if failed.isEmpty { return items.isEmpty ? (passed ? "Kontrol sorunsuz" : "Kontrol sorun buldu") : "\(items.count) kontrol sorunsuz" }
        return "\(failed.count) sorun: " + failed.map(\.aspect).joined(separator: ", ")
    }
}

/// `ApprovalRequest`: a generated picture that needs the owner's word before it is used.
public struct ApprovalRequest: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var contentId: EntityID?
    public var productId: EntityID?
    public var conversationId: EntityID?
    public var messageId: EntityID?
    public var kind: ApprovalKind
    /// The candidate pictures (1–4).
    public var assetIds: [EntityID]
    /// Nil when no check ran.
    public var checkReport: ApprovalCheckReport?
    public var status: ApprovalStatus
    public var slotId: String?
    public var replacesAssetId: EntityID?
    public var approvedAssetId: EntityID?
    public var sourceJobId: EntityID?
    public var regenerateJobId: EntityID?
    /// True when "Yeniden üret" can run.
    public var canRegenerate: Bool
    public var decisionNote: String?
    public var createdAt: Date
    public var updatedAt: Date
    public var decidedAt: Date?

    public init(
        id: EntityID, brandId: EntityID, contentId: EntityID? = nil, productId: EntityID? = nil,
        conversationId: EntityID? = nil, messageId: EntityID? = nil, kind: ApprovalKind, assetIds: [EntityID],
        checkReport: ApprovalCheckReport? = nil, status: ApprovalStatus = .pending, slotId: String? = nil,
        replacesAssetId: EntityID? = nil, approvedAssetId: EntityID? = nil, sourceJobId: EntityID? = nil,
        regenerateJobId: EntityID? = nil, canRegenerate: Bool = true, decisionNote: String? = nil,
        createdAt: Date, updatedAt: Date, decidedAt: Date? = nil
    ) {
        self.id = id
        self.brandId = brandId
        self.contentId = contentId
        self.productId = productId
        self.conversationId = conversationId
        self.messageId = messageId
        self.kind = kind
        self.assetIds = assetIds
        self.checkReport = checkReport
        self.status = status
        self.slotId = slotId
        self.replacesAssetId = replacesAssetId
        self.approvedAssetId = approvedAssetId
        self.sourceJobId = sourceJobId
        self.regenerateJobId = regenerateJobId
        self.canRegenerate = canRegenerate
        self.decisionNote = decisionNote
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.decidedAt = decidedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, brandId, contentId, productId, conversationId, messageId, kind, assetIds, checkReport, status, slotId
        case replacesAssetId, approvedAssetId, sourceJobId, regenerateJobId, canRegenerate, decisionNote
        case createdAt, updatedAt, decidedAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(EntityID.self, forKey: .id)
        brandId = try c.decode(EntityID.self, forKey: .brandId)
        contentId = try c.decodeIfPresent(EntityID.self, forKey: .contentId)
        productId = try c.decodeIfPresent(EntityID.self, forKey: .productId)
        conversationId = try c.decodeIfPresent(EntityID.self, forKey: .conversationId)
        messageId = try c.decodeIfPresent(EntityID.self, forKey: .messageId)
        kind = try c.decodeIfPresent(ApprovalKind.self, forKey: .kind) ?? .unknown
        assetIds = try c.decodeIfPresent([EntityID].self, forKey: .assetIds) ?? []
        checkReport = try? c.decodeIfPresent(ApprovalCheckReport.self, forKey: .checkReport)
        status = try c.decodeIfPresent(ApprovalStatus.self, forKey: .status) ?? .unknown
        slotId = try c.decodeIfPresent(String.self, forKey: .slotId)
        replacesAssetId = try c.decodeIfPresent(EntityID.self, forKey: .replacesAssetId)
        approvedAssetId = try c.decodeIfPresent(EntityID.self, forKey: .approvedAssetId)
        sourceJobId = try c.decodeIfPresent(EntityID.self, forKey: .sourceJobId)
        regenerateJobId = try c.decodeIfPresent(EntityID.self, forKey: .regenerateJobId)
        canRegenerate = try c.decodeIfPresent(Bool.self, forKey: .canRegenerate) ?? false
        decisionNote = try c.decodeIfPresent(String.self, forKey: .decisionNote)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
        decidedAt = try c.decodeIfPresent(Date.self, forKey: .decidedAt)
    }

    public var isPending: Bool { status == .pending }

    /// The picture a decided request settled on (the approved one), else the first candidate.
    public var coverAssetId: EntityID? { approvedAssetId ?? assetIds.first }

    /// The check in one line ("Kontrol yapılmadı" without one).
    public var checkLine: String { checkReport?.shortLine ?? "Kontrol yapılmadı" }

    /// The check found something wrong.
    public var hasProblems: Bool { checkReport.map { !$0.passed || !$0.failed.isEmpty } ?? false }

    /// What a decided request's card says ("Onaylandı · 2. görsel kullanıldı").
    public var outcomeText: String {
        switch status {
        case .approved:
            if assetIds.count > 1, let approved = approvedAssetId, let index = assetIds.firstIndex(of: approved) {
                return "Onaylandı · \(index + 1). görsel kullanıldı"
            }
            return kind == .productPhotoUpgrade ? "Onaylandı · ürün fotoğrafı değişti" : "Onaylandı"
        case .rejected:
            let note = decisionNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return note.isEmpty ? "Reddedildi; görseller medyada duruyor" : "Reddedildi: \(note)"
        case .superseded:
            return "Yeniden üretiliyor; yeni görseller gelince ayrı bir kart olarak düşer"
        case .pending:
            return "Onayın bekleniyor"
        case .unknown:
            return "Durumu bilinmiyor"
        }
    }
}

/// `POST /api/approvals/{id}/approve`.
public struct ApprovalApprove: Encodable, Sendable, Equatable {
    /// Which candidate to use (default: the first).
    public var assetId: EntityID?
    public init(assetId: EntityID? = nil) { self.assetId = assetId }
}

/// `POST /api/approvals/{id}/reject`.
public struct ApprovalReject: Encodable, Sendable, Equatable {
    public var note: String?
    public init(note: String? = nil) {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.note = trimmed?.isEmpty == false ? String(trimmed!.prefix(2000)) : nil
    }
}

/// `POST /api/approvals/{id}/regenerate`: the owner's explicit consent to generate again (paid).
public struct ApprovalRegenerate: Encodable, Sendable, Equatable {
    /// "Etiketi birebir koruyarak yerleştir".
    public var preserveLabelComposite: Bool
    /// Extra words for this round ("daha sıcak ışık").
    public var instructions: String?

    public init(preserveLabelComposite: Bool = false, instructions: String? = nil) {
        self.preserveLabelComposite = preserveLabelComposite
        let trimmed = instructions?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.instructions = trimmed?.isEmpty == false ? String(trimmed!.prefix(2000)) : nil
    }
}

/// What a decision changed.
public struct ApprovalActionResult: Decodable, Sendable, Equatable {
    public var approval: ApprovalRequest
    /// The post after an approval placed the picture.
    public var content: Content?
    /// The product after a photo upgrade.
    public var product: BrandProduct?
    /// The job queued: the post's render (approve) or the new generation (regenerate).
    public var job: Job?

    public init(approval: ApprovalRequest, content: Content? = nil, product: BrandProduct? = nil, job: Job? = nil) {
        self.approval = approval
        self.content = content
        self.product = product
        self.job = job
    }

    private enum CodingKeys: String, CodingKey { case approval, content, product, job }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approval = try c.decode(ApprovalRequest.self, forKey: .approval)
        content = try? c.decodeIfPresent(Content.self, forKey: .content)
        product = try? c.decodeIfPresent(BrandProduct.self, forKey: .product)
        job = try? c.decodeIfPresent(Job.self, forKey: .job)
    }
}

// MARK: - @product / @post mentions

/// `MentionEntityKind`.
public enum MentionEntityKind: String, OpenEnum {
    case product, content
    case unknown

    public var label: String {
        switch self {
        case .product: "Ürün"
        case .content: "Post"
        case .unknown: ""
        }
    }
}

/// One resolved `@name` of a product or post in a user message (UTF-16 offsets, `end` exclusive,
/// covering `@` and the name).
public struct MessageEntityMention: Codable, Sendable, Hashable {
    public var kind: MentionEntityKind
    /// Product id or content id.
    public var id: EntityID
    /// The name as written (lower-cased, without `@`).
    public var name: String
    public var start: Int
    public var end: Int

    public init(kind: MentionEntityKind, id: EntityID, name: String, start: Int, end: Int) {
        self.kind = kind
        self.id = id
        self.name = name
        self.start = start
        self.end = end
    }
}

/// A product or post the composer offers after `@` (`GET /api/brands/{id}/mention-candidates`).
public struct EntityMentionCandidate: Codable, Sendable, Hashable, Identifiable {
    public var kind: MentionEntityKind
    public var id: EntityID
    /// The mention name without `@`: `boro`, `venta-boro`.
    public var slug: String
    /// The product's name or the post's title.
    public var label: String
    public var imageAssetId: EntityID?
    /// Products: the category; posts: the post's status.
    public var detail: String
    /// Posts: approval requests still waiting.
    public var pendingApprovals: Int

    public init(kind: MentionEntityKind, id: EntityID, slug: String, label: String, imageAssetId: EntityID? = nil, detail: String = "", pendingApprovals: Int = 0) {
        self.kind = kind
        self.id = id
        self.slug = slug
        self.label = label
        self.imageAssetId = imageAssetId
        self.detail = detail
        self.pendingApprovals = pendingApprovals
    }

    private enum CodingKeys: String, CodingKey { case kind, id, slug, label, imageAssetId, detail, pendingApprovals }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(MentionEntityKind.self, forKey: .kind) ?? .unknown
        id = try c.decode(EntityID.self, forKey: .id)
        slug = try c.decode(String.self, forKey: .slug)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? slug
        imageAssetId = try c.decodeIfPresent(EntityID.self, forKey: .imageAssetId)
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
        pendingApprovals = try c.decodeIfPresent(Int.self, forKey: .pendingApprovals) ?? 0
    }
}

/// `MentionCandidateList`.
public struct EntityMentionCandidateList: Decodable, Sendable {
    public var items: [EntityMentionCandidate]

    private enum CodingKeys: String, CodingKey { case items }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // One unreadable row (a newer kind) does not hide the rest.
        items = (try c.decodeIfPresent([Lossy<EntityMentionCandidate>].self, forKey: .items) ?? []).compactMap(\.value)
    }
}

/// Mention names (`mentionBase` / `allocateMentionSlugs` / `resolveEntityMentions` in mention.ts).
public enum EntityMentionNames {
    /// The name a product or post would like to have: `"Venta Boro"` → `venta-boro`.
    public static func base(_ name: String, kind: MentionEntityKind) -> String {
        let tag = kind == .product ? "urun" : "post"
        var base = trimHyphens(String(Brand.slugify(name).prefix(ImageAlias.maxLength)))
        if base.isEmpty { return tag }
        if let first = base.unicodeScalars.first, !("a"..."z").contains(first) { base = "\(tag)-\(base)" }
        if isFileAlias(base) { base = "\(base)-\(tag)" }
        return trimHyphens(String(base.prefix(ImageAlias.maxLength)))
    }

    /// Unique names in the given order; `taken` grows with the names given.
    public static func allocate(_ items: [(id: EntityID, name: String)], kind: MentionEntityKind, taken: inout Set<String>) -> [EntityID: String] {
        var out: [EntityID: String] = [:]
        for item in items {
            let base = base(item.name, kind: kind)
            var slug = base
            var n = 2
            while taken.contains(slug) {
                let suffix = "-\(n)"
                slug = trimHyphens(String(base.prefix(ImageAlias.maxLength - suffix.count))) + suffix
                n += 1
            }
            taken.insert(slug)
            out[item.id] = slug
        }
        return out
    }

    /// `@name` tokens that name a candidate, skipping `skip` (the conversation's file aliases win).
    public static func resolve(_ text: String, candidates: [EntityMentionCandidate], skip: Set<String> = []) -> [MessageEntityMention] {
        var bySlug: [String: EntityMentionCandidate] = [:]
        for candidate in candidates where bySlug[candidate.slug] == nil { bySlug[candidate.slug] = candidate }
        return MentionText.scanTokens(text).compactMap { token in
            guard !skip.contains(token.alias), let target = bySlug[token.alias] else { return nil }
            return MessageEntityMention(kind: target.kind, id: target.id, name: token.alias, start: token.start, end: token.end)
        }
    }

    private static func isFileAlias(_ name: String) -> Bool {
        for prefix in ["image", "video", "audio", "file"] {
            if name == prefix { return true }
            if name.hasPrefix(prefix + "-"), Int(name.dropFirst(prefix.count + 1)) != nil { return true }
        }
        return false
    }

    private static func trimHyphens(_ text: String) -> String {
        var out = text
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }
}
