import Foundation

// Request bodies (contract `*Create`, `*Update`, ...). Optional properties are
// omitted from the JSON when nil (synthesised `encodeIfPresent`).

struct ContentCreate: Encodable, Sendable, Equatable {
    var brandId: String
    var type: ContentType
    var title: String
    var brief: String
    var targetPlatforms: [Platform]
    var caption: String?
}

/// Only the fields the app edits. Changing `caption` drops an existing approval.
struct ContentUpdate: Encodable, Sendable, Equatable {
    var title: String?
    var brief: String?
    var caption: String?
    var targetPlatforms: [Platform]?
}

struct ContentApprove: Encodable, Sendable, Equatable {
    /// Hash of the current version the user looked at.
    var hash: String
}

struct ContentTransition: Encodable, Sendable, Equatable {
    enum Target: String, Encodable, Sendable { case draft, inReview = "in_review", approved }
    var to: Target
}

struct JobCreate: Encodable, Sendable, Equatable {
    var type: JobType
    var payload: [String: JSONValue]
    var brandId: String?
    var contentId: String?
}

struct ScheduleCreate: Encodable, Sendable, Equatable {
    var contentId: String
    var socialAccountId: String
    var platform: Platform?
    /// UTC, `...Z`; must be in the future.
    var scheduledAt: Date
}

/// Payload of a `content.generate` job. The contract leaves it free-form until
/// the worker pipeline (F1-3) defines it; this matches what the web app sends
/// (`apps/web/src/features/contents/generate.ts`) plus `assetIds` for the
/// photos/videos attached on the phone.
enum GeneratePayload {
    static func make(for content: Content, assetIds: [String]) -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "brief": .string(content.brief),
            "title": .string(content.title),
            "type": .string(content.type.rawValue),
            "targetPlatforms": .array(content.targetPlatforms.map { .string($0.rawValue) }),
        ]
        if !assetIds.isEmpty {
            payload["assetIds"] = .array(assetIds.map { .string($0) })
        }
        if let version = content.currentVersion?.version {
            payload["baseVersion"] = .number(Double(version))
        }
        return payload
    }
}
