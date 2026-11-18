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

/// Model family the user picks for a turn or a generation (`AgentModel` in common.ts).
/// `codex`: Codex CLI (ChatGPT sign-in), `gpt`: OpenAI API key, `antigravity`: Antigravity CLI.
public enum AgentModel: String, OpenEnum {
    case opus, sonnet, haiku
    case geminiFlashLite = "gemini-flash-lite"
    case geminiFlash = "gemini-flash"
    case geminiPro = "gemini-pro"
    case codex, gpt, antigravity
    case unknown

    public var displayName: String {
        switch self {
        case .opus: "Opus"
        case .sonnet: "Sonnet"
        case .haiku: "Haiku"
        case .geminiFlashLite: "Gemini Flash-Lite"
        case .geminiFlash: "Gemini Flash"
        case .geminiPro: "Gemini Pro"
        case .codex: "Codex (ChatGPT)"
        case .gpt: "GPT (OpenAI API)"
        case .antigravity: "Antigravity"
        case .unknown: "Bilinmeyen model"
        }
    }

    public var isGemini: Bool {
        switch self {
        case .geminiFlashLite, .geminiFlash, .geminiPro: true
        case .opus, .sonnet, .haiku, .codex, .gpt, .antigravity, .unknown: false
        }
    }

    /// The provider row in presence `providers` that runs this model (nil: Claude / Gemini).
    public var otherProvider: AIProvider? {
        switch self {
        case .codex: .codex
        case .gpt: .openai
        case .antigravity: .antigravity
        default: nil
        }
    }

    /// Codex, GPT (OpenAI API) and Antigravity (the desktop app offers them; the phone shows their names).
    public static var otherCases: [AgentModel] { [.codex, .gpt, .antigravity] }

    public static var claudeCases: [AgentModel] { [.opus, .sonnet, .haiku] }
    public static var geminiCases: [AgentModel] { [.geminiFlashLite, .geminiFlash, .geminiPro] }
}

/// Reasoning effort the user picks for a turn or a generation (`AgentEffort` in common.ts).
public enum AgentEffort: String, OpenEnum {
    case low, medium, high, xhigh
    case unknown

    public var displayName: String {
        switch self {
        case .low: "Düşük"
        case .medium: "Orta"
        case .high: "Yüksek"
        case .xhigh: "Çok yüksek"
        case .unknown: "Bilinmeyen"
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
    case unauthorized
    case forbidden
    case rateLimited = "rate_limited"
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
