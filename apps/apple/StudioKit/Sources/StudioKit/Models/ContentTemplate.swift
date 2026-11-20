import Foundation

// template.ts (N9): an approved post saved as a layout. Its text layers and picture slots become
// fillable fields; "Bu şablonla yeni post" makes a draft post whose `content.generate` job fills
// the layout with new texts and pictures (typed, or written by AI from a subject).

public enum TemplateKind: String, OpenEnum {
    case html, canvas
    case unknown
}

public enum TemplateFieldKind: String, OpenEnum {
    case text, image
    case unknown
}

/// One fillable field of a template.
public struct TemplateField: Codable, Sendable, Hashable {
    /// kebab-case, unique in the template (`headline`, `body-2`, `slot`).
    public var key: String
    /// Turkish, shown in the fill form ("Başlık", "Görsel · Kare 2").
    public var label: String
    public var kind: TemplateFieldKind
    public var role: String?
    /// 0-based slide.
    public var slide: Int
    public var layer: String
    /// The source's text (a text field) or picture file (`/media/…`, an image field).
    public var example: String
    /// About how many characters fit at the source's size (a hint; auto-fit decides).
    public var maxChars: Int?
    public var multiline: Bool
    /// Image fields: the slot's `W:H`.
    public var ratio: String?
    /// A longer text shrinks its font instead of overflowing.
    public var autoFit: Bool
    /// The field keeps the template's own text or picture (it is never filled).
    public var locked: Bool

    public init(
        key: String, label: String, kind: TemplateFieldKind, role: String? = nil, slide: Int = 0, layer: String,
        example: String, maxChars: Int? = nil, multiline: Bool = false, ratio: String? = nil, autoFit: Bool = true, locked: Bool = false
    ) {
        self.key = key
        self.label = label
        self.kind = kind
        self.role = role
        self.slide = slide
        self.layer = layer
        self.example = example
        self.maxChars = maxChars
        self.multiline = multiline
        self.ratio = ratio
        self.autoFit = autoFit
        self.locked = locked
    }

    private enum CodingKeys: String, CodingKey { case key, label, kind, role, slide, layer, example, maxChars, multiline, ratio, autoFit, locked }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        kind = try c.decodeIfPresent(TemplateFieldKind.self, forKey: .kind) ?? .unknown
        role = try c.decodeIfPresent(String.self, forKey: .role)
        slide = try c.decodeIfPresent(Int.self, forKey: .slide) ?? 0
        layer = try c.decodeIfPresent(String.self, forKey: .layer) ?? key
        example = try c.decodeIfPresent(String.self, forKey: .example) ?? ""
        maxChars = try c.decodeIfPresent(Int.self, forKey: .maxChars)
        multiline = try c.decodeIfPresent(Bool.self, forKey: .multiline) ?? false
        ratio = try c.decodeIfPresent(String.self, forKey: .ratio)
        autoFit = try c.decodeIfPresent(Bool.self, forKey: .autoFit) ?? true
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
    }
}

/// The post a template was made from.
public struct TemplateSource: Codable, Sendable, Hashable {
    /// nil once that post was deleted for good.
    public var contentId: EntityID?
    public var version: Int
    public var title: String

    public init(contentId: EntityID?, version: Int, title: String) {
        self.contentId = contentId
        self.version = version
        self.title = title
    }
}

/// `GET /api/brands/{brandId}/templates` (newest first). The canvas document is left out: the
/// phone never fills a template itself.
public struct ContentTemplate: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var brandId: EntityID
    public var name: String
    public var description: String
    public var kind: TemplateKind
    public var contentType: ContentType
    public var width: Int
    public var height: Int
    public var slideCount: Int
    public var fields: [TemplateField]
    /// The source version's renders, one per slide (the template's preview).
    public var previewAssetIds: [EntityID?]
    public var source: TemplateSource
    /// Posts made from it so far.
    public var useCount: Int
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, brandId: EntityID, name: String, description: String = "", kind: TemplateKind = .html,
        contentType: ContentType, width: Int = 1080, height: Int = 1350, slideCount: Int = 1, fields: [TemplateField],
        previewAssetIds: [EntityID?] = [], source: TemplateSource, useCount: Int = 0, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.brandId = brandId
        self.name = name
        self.description = description
        self.kind = kind
        self.contentType = contentType
        self.width = width
        self.height = height
        self.slideCount = slideCount
        self.fields = fields
        self.previewAssetIds = previewAssetIds
        self.source = source
        self.useCount = useCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// The first slide's render (nil while there is none).
    public var previewAssetId: EntityID? { previewAssetIds.compactMap { $0 }.first }

    /// Unlocked fields, optionally of one kind (`fillableFields`).
    public func fillableFields(_ kind: TemplateFieldKind? = nil) -> [TemplateField] {
        fields.filter { !$0.locked && (kind == nil || $0.kind == kind) }
    }
}

/// One field's changed settings in `PATCH /api/templates/{id}`.
public struct TemplateFieldUpdate: Encodable, Sendable, Equatable {
    public var key: String
    public var label: String?
    public var autoFit: Bool?
    public var locked: Bool?

    public init(key: String, label: String? = nil, autoFit: Bool? = nil, locked: Bool? = nil) {
        self.key = key
        self.label = label
        self.autoFit = autoFit
        self.locked = locked
    }
}

/// `PATCH /api/templates/{id}`.
public struct ContentTemplateUpdate: Encodable, Sendable, Equatable {
    public var name: String?
    public var description: String?
    public var fields: [TemplateFieldUpdate]?

    public init(name: String? = nil, description: String? = nil, fields: [TemplateFieldUpdate]? = nil) {
        self.name = name
        self.description = description
        self.fields = fields
    }

    public var isEmpty: Bool { name == nil && description == nil && (fields?.isEmpty ?? true) }
}

public enum TemplateFillMode: String, OpenEnum {
    case manual, ai
    case unknown
}

/// `POST /api/templates/{id}/use`: a new draft post from the template, filled by a job.
public struct TemplateUse: Encodable, Sendable, Equatable {
    public var title: String?
    public var brief: String?
    /// Text by field key.
    public var values: [String: String]?
    /// Picture (an image asset of the brand) by field key.
    public var images: [String: EntityID]?
    public var fill: TemplateFillMode?
    public var autoFit: Bool?

    public init(title: String? = nil, brief: String? = nil, values: [String: String]? = nil, images: [String: EntityID]? = nil, fill: TemplateFillMode? = nil, autoFit: Bool? = nil) {
        self.title = title
        self.brief = brief
        self.values = values
        self.images = images
        self.fill = fill
        self.autoFit = autoFit
    }
}

public struct TemplateUseResult: Codable, Sendable, Hashable {
    public var content: Content
    public var job: Job

    public init(content: Content, job: Job) {
        self.content = content
        self.job = job
    }
}
