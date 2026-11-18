import Foundation

// brand-product.ts: a brand's products ("Ürünler"), N23 on the phone.

public enum ProductLimits {
    /// `MAX_PRODUCT_IMAGES`.
    public static let maxImages = 8
    /// `MAX_PRODUCT_TAGS`.
    public static let maxTags = 12
    public static let nameMax = 120
    public static let descriptionMax = 500
    public static let categoryMax = 80
    public static let tagMax = 40
    public static let notesMax = 4000
}

/// `BrandProduct`: name, description, category, tags, notes and photos (`image` assets of the
/// brand; the first one is the cover).
public struct BrandProduct: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var name: String
    public var description: String
    public var category: String
    public var tags: [String]
    public var notes: String
    public var imageAssetIds: [EntityID]
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, brandId: EntityID, name: String, description: String = "", category: String = "",
        tags: [String] = [], notes: String = "", imageAssetIds: [EntityID] = [], createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.brandId = brandId
        self.name = name
        self.description = description
        self.category = category
        self.tags = tags
        self.notes = notes
        self.imageAssetIds = imageAssetIds
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var coverAssetId: EntityID? { imageAssetIds.first }

    private enum CodingKeys: String, CodingKey {
        case id, brandId, name, description, category, tags, notes, imageAssetIds, createdAt, updatedAt
    }

    /// Lists and texts the server may leave out decode as empty.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(EntityID.self, forKey: .id)
        brandId = try c.decode(EntityID.self, forKey: .brandId)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? ""
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        notes = try c.decodeIfPresent(String.self, forKey: .notes) ?? ""
        imageAssetIds = try c.decodeIfPresent([EntityID].self, forKey: .imageAssetIds) ?? []
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
    }
}

/// `BrandProductCreate`.
public struct BrandProductCreate: Encodable, Sendable, Equatable {
    public var name: String
    public var description: String
    public var category: String
    public var tags: [String]
    public var notes: String
    public var imageAssetIds: [EntityID]

    public init(name: String, description: String = "", category: String = "", tags: [String] = [], notes: String = "", imageAssetIds: [EntityID] = []) {
        self.name = name
        self.description = description
        self.category = category
        self.tags = tags
        self.notes = notes
        self.imageAssetIds = imageAssetIds
    }

    /// Trimmed and cut to the contract's limits (tags: unique ignoring case, at most 12).
    public var cleaned: BrandProductCreate {
        var seen = Set<EntityID>()
        let photos = imageAssetIds.filter { seen.insert($0).inserted }
        return BrandProductCreate(
            name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ProductLimits.nameMax)),
            description: String(description.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ProductLimits.descriptionMax)),
            category: String(category.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ProductLimits.categoryMax)),
            tags: ProductTags.clean(tags),
            notes: String(notes.prefix(ProductLimits.notesMax)),
            imageAssetIds: Array(photos.prefix(ProductLimits.maxImages)))
    }

    /// Why it cannot be saved yet (nil: fine).
    public var problem: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Ürünün adını yaz." }
        return nil
    }
}

/// `BrandProductUpdate`: only the fields that are set are sent (lists replace the stored ones).
public struct BrandProductUpdate: Encodable, Sendable, Equatable {
    public var name: String?
    public var description: String?
    public var category: String?
    public var tags: [String]?
    public var notes: String?
    public var imageAssetIds: [EntityID]?

    public init(name: String? = nil, description: String? = nil, category: String? = nil, tags: [String]? = nil, notes: String? = nil, imageAssetIds: [EntityID]? = nil) {
        self.name = name
        self.description = description
        self.category = category
        self.tags = tags
        self.notes = notes
        self.imageAssetIds = imageAssetIds
    }

    public var isEmpty: Bool {
        name == nil && description == nil && category == nil && tags == nil && notes == nil && imageAssetIds == nil
    }

    /// The fields of `edited` that differ from `product`.
    public static func changes(from product: BrandProduct, to edited: BrandProductCreate) -> BrandProductUpdate {
        let edited = edited.cleaned
        var update = BrandProductUpdate()
        if edited.name != product.name { update.name = edited.name }
        if edited.description != product.description { update.description = edited.description }
        if edited.category != product.category { update.category = edited.category }
        if edited.tags != product.tags { update.tags = edited.tags }
        if edited.notes != product.notes { update.notes = edited.notes }
        if edited.imageAssetIds != product.imageAssetIds { update.imageAssetIds = edited.imageAssetIds }
        return update
    }
}

public enum ProductTags {
    /// "a, b ,a" → ["a", "b"]: trimmed, unique ignoring Turkish case, each at most 40, at most 12.
    public static func parse(_ text: String) -> [String] {
        clean(text.split(whereSeparator: { $0 == "," || $0 == "\n" }).map(String.init))
    }

    public static func clean(_ tags: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        let turkish = Locale(identifier: "tr_TR")
        for raw in tags {
            let tag = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ProductLimits.tagMax))
            guard !tag.isEmpty, seen.insert(tag.lowercased(with: turkish)).inserted else { continue }
            out.append(tag)
            if out.count == ProductLimits.maxTags { break }
        }
        return out
    }

    public static func text(_ tags: [String]) -> String { tags.joined(separator: ", ") }
}

// MARK: - What the Mac read on a photo (N12), for "Fotoğrafla hızlı ekle"

/// The parts of `AssetAnalysis` the phone uses: Turkish tags, the text read on the picture and
/// the AI caption. Decoded leniently (a newer server may add fields or states).
public struct AssetAnalysisSummary: Codable, Sendable, Hashable {
    public enum Status: String, OpenEnum {
        case complete, partial, failed
        case unknown
    }

    public struct Tag: Codable, Sendable, Hashable {
        public var id: String
        public var label: String
        public var confidence: Double

        public init(id: String, label: String, confidence: Double) {
            self.id = id
            self.label = label
            self.confidence = confidence
        }
    }

    public var status: Status
    public var tags: [Tag]
    /// Text read on the picture, lines joined with newlines.
    public var text: String
    /// The AI's Turkish description (only when the owner turned it on).
    public var caption: String?
    public var isCutout: Bool

    public init(status: Status, tags: [Tag] = [], text: String = "", caption: String? = nil, isCutout: Bool = false) {
        self.status = status
        self.tags = tags
        self.text = text
        self.caption = caption
        self.isCutout = isCutout
    }

    private enum CodingKeys: String, CodingKey { case status, tags, text, caption, isCutout }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decode(Status.self, forKey: .status)) ?? .unknown
        tags = (try? c.decode([Tag].self, forKey: .tags)) ?? []
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        caption = try? c.decodeIfPresent(String.self, forKey: .caption)
        isCutout = (try? c.decode(Bool.self, forKey: .isCutout)) ?? false
    }
}

/// Name, description and tags the phone offers for a new product from what the Mac read on its
/// photo (pure; tested). Only empty fields are filled; the owner edits before saving.
public struct ProductSuggestion: Sendable, Equatable {
    public var name: String?
    public var description: String?
    public var tags: [String]

    public init(name: String? = nil, description: String? = nil, tags: [String] = []) {
        self.name = name
        self.description = description
        self.tags = tags
    }

    public var isEmpty: Bool { name == nil && description == nil && tags.isEmpty }

    public static func from(_ analysis: AssetAnalysisSummary?) -> ProductSuggestion {
        guard let analysis, analysis.status != .failed else { return ProductSuggestion() }
        let name = nameLine(in: analysis.text)
        let caption = analysis.caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        let tags = ProductTags.clean(
            analysis.tags.filter { $0.confidence >= 0.3 }
                .sorted { $0.confidence > $1.confidence }
                .map(\.label)
                .prefix(5)
                .map { $0 })
        return ProductSuggestion(
            name: name,
            description: caption.flatMap { $0.isEmpty ? nil : String($0.prefix(ProductLimits.descriptionMax)) },
            tags: tags)
    }

    /// The label's most name-like line: the first line with letters, 3–60 characters, that is
    /// not only a number, a weight or a web address.
    static func nameLine(in text: String) -> String? {
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (3...60).contains(line.count), line.contains(where: \.isLetter) else { continue }
            let lower = line.lowercased()
            if lower.hasPrefix("www.") || lower.hasPrefix("http") || lower.contains("@") { continue }
            let letters = line.filter(\.isLetter).count
            if letters < 3 { continue }
            if line.range(of: #"^[\d.,\s]+(kg|g|gr|ml|l|lt|cl|mg|%)\.?$"#, options: [.regularExpression, .caseInsensitive]) != nil { continue }
            return String(line.prefix(ProductLimits.nameMax))
        }
        return nil
    }
}
