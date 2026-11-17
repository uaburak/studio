import Foundation

// agent.ts: tool steps, consent cards, agent sessions, Claude & Gemini worker status.

// MARK: - Tool steps

public enum ToolStepState: String, OpenEnum {
    case running, done, error
    case unknown
}

/// One tool call of the agent, shown as a compact secondary row (`ToolStepPart` in agent.ts).
public struct ToolStepPart: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var label: String
    public var state: ToolStepState
    public var summary: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, label, state, summary
    }

    public init(id: String, name: String, label: String, state: ToolStepState, summary: String? = nil) {
        self.id = id
        self.name = name
        self.label = label
        self.state = state
        self.summary = summary
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        label = try c.decode(String.self, forKey: .label)
        state = try c.decode(ToolStepState.self, forKey: .state)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(label, forKey: .label)
        try c.encode(state, forKey: .state)
        if let summary { try c.encode(summary, forKey: .summary) } else { try c.encodeNil(forKey: .summary) }
    }
}

// MARK: - Consent cards

public enum ConsentState: String, OpenEnum {
    case pending, allowed, denied, expired
    case unknown
}

/// "May I do this?" card: Allow once / Deny (`ConsentPart` in agent.ts).
public struct ConsentPart: Codable, Sendable, Hashable {
    public var consentId: String
    public var tool: String
    public var title: String
    public var detail: String?
    public var state: ConsentState
    public var decidedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case consentId, tool, title, detail, state, decidedAt
    }

    public init(
        consentId: String, tool: String, title: String, detail: String? = nil,
        state: ConsentState = .pending, decidedAt: Date? = nil
    ) {
        self.consentId = consentId
        self.tool = tool
        self.title = title
        self.detail = detail
        self.state = state
        self.decidedAt = decidedAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        consentId = try c.decode(String.self, forKey: .consentId)
        tool = try c.decode(String.self, forKey: .tool)
        title = try c.decode(String.self, forKey: .title)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        state = try c.decode(ConsentState.self, forKey: .state)
        decidedAt = try c.decodeIfPresent(Date.self, forKey: .decidedAt)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(consentId, forKey: .consentId)
        try c.encode(tool, forKey: .tool)
        try c.encode(title, forKey: .title)
        if let detail { try c.encode(detail, forKey: .detail) } else { try c.encodeNil(forKey: .detail) }
        try c.encode(state, forKey: .state)
        if let decidedAt { try c.encode(decidedAt, forKey: .decidedAt) } else { try c.encodeNil(forKey: .decidedAt) }
    }
}

/// `POST /api/conversations/{id}/messages/{messageId}/consent`.
public struct ConsentDecisionCreate: Encodable, Sendable, Equatable {
    public var consentId: String
    public var allow: Bool

    public init(consentId: String, allow: Bool) {
        self.consentId = consentId
        self.allow = allow
    }
}

public struct ConsentDecisionResult: Decodable, Sendable, Equatable {
    public var message: Message

    public init(message: Message) {
        self.message = message
    }
}

// MARK: - Agent session

/// Claude Code session kept on a conversation (`AgentSession` in agent.ts).
public struct AgentSession: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var messageCount: Int
    public var runId: EntityID
    public var updatedAt: Date

    public init(id: String, messageCount: Int, runId: EntityID, updatedAt: Date) {
        self.id = id
        self.messageCount = messageCount
        self.runId = runId
        self.updatedAt = updatedAt
    }
}

// MARK: - Claude sign-in

public enum ClaudeAccountStatus: String, OpenEnum {
    case signedIn = "signed_in"
    case signedOut = "signed_out"
    case signingIn = "signing_in"
    case notInstalled = "not_installed"
    case error
    case unknown
}

/// `claude auth status` as the worker last read it (`ClaudeAccount` in agent.ts).
public struct ClaudeAccount: Codable, Sendable, Hashable {
    public var status: ClaudeAccountStatus
    public var email: String?
    public var plan: String?
    public var cliVersion: String?
    public var loginUrl: String?
    public var detail: String?
    /// First name from Claude Code's local profile on the Mac (`~/.claude.json`); the apps greet
    /// with it unless the owner typed a name. Nil from older workers or when signed out.
    public var displayName: String?
    public var checkedAt: Date

    public init(
        status: ClaudeAccountStatus, email: String? = nil, plan: String? = nil, cliVersion: String? = nil,
        loginUrl: String? = nil, detail: String? = nil, displayName: String? = nil, checkedAt: Date
    ) {
        self.status = status
        self.email = email
        self.plan = plan
        self.cliVersion = cliVersion
        self.loginUrl = loginUrl
        self.detail = detail
        self.displayName = displayName
        self.checkedAt = checkedAt
    }

    /// The greeting name the Mac reported, cleaned (nil when absent or blank).
    public var greetingName: String? {
        guard status == .signedIn, let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }
}

/// `GET /api/workers/claude` and the answer of its commands (`ClaudeControl` in agent.ts).
public struct ClaudeControl: Codable, Sendable, Hashable {
    public var account: ClaudeAccount?
    public var online: Bool
    public var sent: Int

    public init(account: ClaudeAccount? = nil, online: Bool, sent: Int = 0) {
        self.account = account
        self.online = online
        self.sent = sent
    }
}

// MARK: - Gemini connection

public enum GeminiAccountStatus: String, OpenEnum {
    case ready
    case notConfigured = "not_configured"
    case error
    case unknown
}

public enum GeminiMode: String, OpenEnum {
    case api, cli, both, none
    case unknown
}

/// Gemini API key / CLI readiness as the worker last saw it (`GeminiAccount` in agent.ts).
public struct GeminiAccount: Codable, Sendable, Hashable {
    public var status: GeminiAccountStatus
    public var mode: GeminiMode
    public var apiKeyConfigured: Bool
    public var cliVersion: String?
    public var defaultModel: String?
    public var detail: String?
    public var checkedAt: Date

    public init(
        status: GeminiAccountStatus, mode: GeminiMode, apiKeyConfigured: Bool, cliVersion: String? = nil,
        defaultModel: String? = nil, detail: String? = nil, checkedAt: Date
    ) {
        self.status = status
        self.mode = mode
        self.apiKeyConfigured = apiKeyConfigured
        self.cliVersion = cliVersion
        self.defaultModel = defaultModel
        self.detail = detail
        self.checkedAt = checkedAt
    }
}

/// `GET /api/workers/gemini` and the answer of its refresh command (`GeminiControl` in agent.ts).
public struct GeminiControl: Codable, Sendable, Hashable {
    public var account: GeminiAccount?
    public var online: Bool
    public var sent: Int

    public init(account: GeminiAccount? = nil, online: Bool, sent: Int = 0) {
        self.account = account
        self.online = online
        self.sent = sent
    }
}
