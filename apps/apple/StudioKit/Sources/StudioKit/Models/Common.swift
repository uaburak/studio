import Foundation

/// Opaque entity id (UUIDv7 strings minted by the API; never parse them).
public typealias EntityID = String

/// A string enum mirrored from the contract that decodes values it does not
/// know (added by a newer server) as `unknown` instead of failing the whole
/// response. `unknown` is never sent back to the server.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable, CaseIterable where RawValue == String {
    static var unknown: Self { get }
}

extension OpenEnum {
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.unknown
    }

    /// Every case the server defines (for pickers and filters).
    public static var knownCases: [Self] { allCases.filter { $0 != unknown } }
}

/// `Platform` in common.ts.
public enum Platform: String, OpenEnum {
    case instagram, facebook, linkedin
    case unknown

    public var displayName: String {
        switch self {
        case .instagram: "Instagram"
        case .facebook: "Facebook"
        case .linkedin: "LinkedIn"
        case .unknown: "Bilinmeyen platform"
        }
    }
}

/// Machine-readable error codes (`ErrorCode` in common.ts).
public enum APIErrorCode: String, OpenEnum {
    case validationError = "validation_error"
    case notFound = "not_found"
    case conflict
    case invalidTransition = "invalid_transition"
    case hashMismatch = "hash_mismatch"
    case payloadTooLarge = "payload_too_large"
    case unsupportedMediaType = "unsupported_media_type"
    case internalError = "internal_error"
    case unknown
}

/// `{ "error": { "code", "message", "issues"? } }`: every non-2xx response.
public struct APIErrorBody: Codable, Sendable, Equatable {
    public struct Issue: Codable, Sendable, Hashable {
        /// Dotted path of the offending field, e.g. `slides.0.html`; "" for the root.
        public var path: String
        public var message: String
    }

    public struct Detail: Codable, Sendable, Equatable {
        public var code: APIErrorCode
        public var message: String
        public var issues: [Issue]?
    }

    public var error: Detail
}

/// List responses: `{ items, nextCursor }` (`nextCursor` is null on the last page).
public struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    public var items: [Item]
    public var nextCursor: String?

    public init(items: [Item], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

extension Page: Equatable where Item: Equatable {}
