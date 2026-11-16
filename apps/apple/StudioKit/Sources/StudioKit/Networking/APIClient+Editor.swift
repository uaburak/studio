import Foundation

/// Output format of a `content.render` job.
public enum RenderFormat: String, Sendable, Hashable, CaseIterable {
    /// Rendered JPEGs on the version (missing renders / layer boxes only, unless `force`).
    case jpeg
    /// Lossless PNG exports (`pngAssetIds`); the version is not changed.
    case png
    /// One multi-page PDF (`pdfAssetId`).
    case pdf
    case both
}

/// Payload of a `content.render` job (`ContentRenderPayload` in packages/contract/src/job.ts).
public struct ContentRenderRequest: Sendable, Hashable {
    /// Version to start from (default: the current one).
    public var version: Int?
    public var format: RenderFormat
    /// design-kit edits; with any, a new `manual_edit` version is stored and rendered.
    public var patches: [DesignPatch]
    /// `slotLayerId -> assetId`: fill image slots with uploaded pictures.
    public var slotAssignments: [String: EntityID]
    /// Slides (0-based) to export as PNG; nil = all.
    public var slides: [Int]?
    /// Re-render every slide.
    public var force: Bool
    /// Note stored on the new version (edits only).
    public var note: String?

    public init(
        version: Int? = nil, format: RenderFormat = .jpeg, patches: [DesignPatch] = [],
        slotAssignments: [String: EntityID] = [:], slides: [Int]? = nil, force: Bool = false, note: String? = nil
    ) {
        self.version = version
        self.format = format
        self.patches = patches
        self.slotAssignments = slotAssignments
        self.slides = slides
        self.force = force
        self.note = note
    }

    public var payload: JSONObject {
        var payload: JSONObject = ["format": .string(format.rawValue)]
        if let version { payload["version"] = .number(Double(version)) }
        if !patches.isEmpty { payload["patches"] = .array(patches.map { .object($0.toJSONObject()) }) }
        if !slotAssignments.isEmpty { payload["slotAssignments"] = .object(slotAssignments.mapValues { .string($0) }) }
        if let slides { payload["slides"] = .array(slides.map { .number(Double($0)) }) }
        if force { payload["force"] = .bool(true) }
        if let note, !note.isEmpty { payload["note"] = .string(String(note.prefix(2000))) }
        return payload
    }
}

/// What a finished `content.render` job reports (`job.output`).
public struct ContentRenderOutput: Sendable, Hashable {
    public var version: Int?
    public var versionId: EntityID?
    public var renderedAssetIds: [EntityID?]
    public var pngAssetIds: [EntityID?]
    public var pdfAssetId: EntityID?
    /// The edits changed nothing; no new version was stored.
    public var unchanged: Bool

    public init(_ output: JSONObject?) {
        let o = output ?? [:]
        version = o["version"]?.doubleValue.map { Int($0) }
        versionId = o["versionId"]?.stringValue
        renderedAssetIds = o["renderedAssetIds"]?.arrayValue?.map(\.stringValue) ?? []
        pngAssetIds = o["pngAssetIds"]?.arrayValue?.map(\.stringValue) ?? []
        pdfAssetId = o["pdfAssetId"]?.stringValue
        unchanged = o["unchanged"]?.boolValue ?? false
    }
}

extension JSONValue {
    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}

/// `POST /api/contents/{id}/duplicate`.
public struct ContentDuplicate: Encodable, Sendable, Equatable {
    public var title: String?
    public init(title: String? = nil) { self.title = title }
}

/// `POST /api/contents/{id}/versions/{version}/restore`.
public struct ContentVersionRestore: Encodable, Sendable, Equatable {
    public var note: String?
    public init(note: String? = nil) { self.note = note }
}

extension APIClient {
    /// `DELETE /api/contents/{id}` (409 while scheduled, publishing or published).
    public func deleteContent(_ id: EntityID) async throws(StudioAPIError) {
        let request = try await makeRequest(.delete, "/api/contents/\(Self.enc(id))")
        _ = try await data(for: request)
    }

    /// New draft copy with the current version (no approval, no schedules).
    public func duplicateContent(_ id: EntityID, title: String? = nil) async throws(StudioAPIError) -> Content {
        try await send(Content.self, .post, "/api/contents/\(Self.enc(id))/duplicate", body: ContentDuplicate(title: title))
    }

    /// New version copying `version` exactly (renders and layer boxes reused).
    public func restoreContentVersion(contentId: EntityID, version: Int, note: String? = nil) async throws(StudioAPIError) -> ContentVersion {
        try await send(
            ContentVersion.self, .post, "/api/contents/\(Self.enc(contentId))/versions/\(version)/restore",
            body: ContentVersionRestore(note: note))
    }

    /// Queue a `content.render` job.
    public func renderContent(contentId: EntityID, _ request: ContentRenderRequest) async throws(StudioAPIError) -> Job {
        try await createJob(JobCreate(type: .contentRender, payload: request.payload, contentId: contentId))
    }

    /// "Neyi değiştireyim?": a `content.generate` job that revises `baseVersion` with `instructions`.
    public func requestRevision(of content: Content, baseVersion: Int, instructions: String) async throws(StudioAPIError) -> Job {
        let payload: JSONObject = [
            "brief": .string(content.brief.isEmpty ? content.title : content.brief),
            "title": .string(content.title),
            "type": .string(content.type.rawValue),
            "instructions": .string(String(instructions.prefix(4000))),
            "baseVersion": .number(Double(baseVersion)),
        ]
        return try await createJob(JobCreate(type: .contentGenerate, payload: payload, brandId: content.brandId, contentId: content.id))
    }
}
