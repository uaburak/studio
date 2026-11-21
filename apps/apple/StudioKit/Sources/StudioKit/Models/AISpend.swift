import Foundation

// ai.ts (spend, preferences S7) and agent.ts (`ClaudeLimitState`).

/// What happens when Claude's usage window is used up (`ClaudeLimitMode`).
public enum ClaudeLimitMode: String, OpenEnum {
    case ask, gemini, wait
    case unknown

    public var label: String {
        switch self {
        case .ask: "Sor"
        case .gemini: "Gemini ile devam et"
        case .wait: "Sınırı bekle"
        case .unknown: "Bilinmiyor"
        }
    }
}

/// The owner's answer while Claude is at its limit (`ClaudeLimitChoice`).
public enum ClaudeLimitChoice: String, OpenEnum {
    case gemini, wait
    case unknown

    public var label: String {
        switch self {
        case .gemini: "Gemini ile devam et"
        case .wait: "Sınırı bekle"
        case .unknown: "Bilinmiyor"
        }
    }
}

/// Presence `claude.limit`: Claude's window is used up and work waits for it.
public struct ClaudeLimitState: Codable, Sendable, Hashable {
    public var resetsAt: Date
    public var mode: ClaudeLimitMode
    /// The owner's answer for this window; nil = none (mode `ask`: the work waits for one).
    public var decision: ClaudeLimitChoice?
    /// Claude calls waiting for the reset or the answer.
    public var waiting: Int
    /// A Gemini key is ready, so "Gemini ile devam et" can work.
    public var geminiReady: Bool

    public init(resetsAt: Date, mode: ClaudeLimitMode, decision: ClaudeLimitChoice? = nil, waiting: Int = 0, geminiReady: Bool = false) {
        self.resetsAt = resetsAt
        self.mode = mode
        self.decision = decision
        self.waiting = waiting
        self.geminiReady = geminiReady
    }

    /// Mode `ask` with no answer yet: the owner has to choose.
    public var needsDecision: Bool { mode == .ask && decision == nil }

    /// Stable key per limit window (one notification per window).
    public var noticeKey: String { "claude-limit:\(Int(resetsAt.timeIntervalSince1970))" }
}

/// `ClaudeLimitDecision`.
public struct ClaudeLimitDecision: Codable, Sendable, Hashable {
    public var choice: ClaudeLimitChoice
    public var until: Date
    public var decidedAt: Date

    public init(choice: ClaudeLimitChoice, until: Date, decidedAt: Date) {
        self.choice = choice
        self.until = until
        self.decidedAt = decidedAt
    }
}

/// `POST /api/ai/claude-limit/decision` body.
public struct ClaudeLimitDecisionCreate: Encodable, Sendable, Equatable {
    public var choice: ClaudeLimitChoice
    public var until: Date?

    public init(choice: ClaudeLimitChoice, until: Date? = nil) {
        self.choice = choice
        self.until = until
    }
}

/// `GET /api/ai/preferences`.
public struct AIPreferences: Codable, Sendable, Hashable {
    public var claudeLimit: ClaudeLimitMode
    /// Monthly budget of the paid AI calls in USD; nil = none.
    public var monthlyBudgetUsd: Double?
    public var stopAtBudget: Bool
    public var limitDecision: ClaudeLimitDecision?
    /// N12: describe each new picture with the AI (paid); absent from older servers = off.
    public var mediaCaptions: Bool?
    public var updatedAt: Date?

    public init(claudeLimit: ClaudeLimitMode = .ask, monthlyBudgetUsd: Double? = nil, stopAtBudget: Bool = false, limitDecision: ClaudeLimitDecision? = nil, mediaCaptions: Bool? = nil, updatedAt: Date? = nil) {
        self.claudeLimit = claudeLimit
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.stopAtBudget = stopAtBudget
        self.limitDecision = limitDecision
        self.mediaCaptions = mediaCaptions
        self.updatedAt = updatedAt
    }
}

/// Services whose calls cost money (`AiSpendProvider`).
public enum AISpendProvider: String, OpenEnum {
    case claude, gemini, codex, openai, antigravity, elevenlabs
    case unknown

    public var displayName: String {
        switch self {
        case .claude: "Claude"
        case .gemini: "Gemini"
        case .codex: "Codex"
        case .openai: "OpenAI"
        case .antigravity: "Antigravity"
        case .elevenlabs: "ElevenLabs"
        case .unknown: "Diğer"
        }
    }
}

/// `AiSpendTotals`.
public struct AISpendTotals: Codable, Sendable, Hashable {
    public var costUsd: Double
    public var calls: Int
    /// Calls whose model has no price in the worker's table (not in `costUsd`).
    public var unpricedCalls: Int
    public var inputTokens: Int
    public var outputTokens: Int
    public var thoughtsTokens: Int

    public init(costUsd: Double = 0, calls: Int = 0, unpricedCalls: Int = 0, inputTokens: Int = 0, outputTokens: Int = 0, thoughtsTokens: Int = 0) {
        self.costUsd = costUsd
        self.calls = calls
        self.unpricedCalls = unpricedCalls
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.thoughtsTokens = thoughtsTokens
    }
}

/// `AiSpendModel` (totals of one model this month).
public struct AISpendModel: Codable, Sendable, Hashable {
    public var model: String
    public var provider: AISpendProvider?
    public var costUsd: Double
    public var calls: Int
    public var unpricedCalls: Int
}

/// `AiSpendProviderTotals` (this month of one service).
public struct AISpendProviderTotals: Codable, Sendable, Hashable {
    public var provider: AISpendProvider
    public var costUsd: Double
    public var calls: Int
    public var unpricedCalls: Int
}

/// `AiBudget`.
public struct AIBudget: Codable, Sendable, Hashable {
    public var monthlyUsd: Double?
    public var remainingUsd: Double?
    public var usedPercent: Double?
    /// True from 80 % of the budget on.
    public var warning: Bool
    public var stopAtBudget: Bool?
    /// Paid calls are refused (stop-at-budget and the budget is used up).
    public var exhausted: Bool?

    public init(monthlyUsd: Double? = nil, remainingUsd: Double? = nil, usedPercent: Double? = nil, warning: Bool = false, stopAtBudget: Bool? = nil, exhausted: Bool? = nil) {
        self.monthlyUsd = monthlyUsd
        self.remainingUsd = remainingUsd
        self.usedPercent = usedPercent
        self.warning = warning
        self.stopAtBudget = stopAtBudget
        self.exhausted = exhausted
    }
}

/// `GET /api/ai/spend`: paid AI spend (Gemini, OpenAI, ElevenLabs, …).
public struct AISpendSummary: Codable, Sendable, Hashable {
    public var today: AISpendTotals
    public var month: AISpendTotals
    public var byModel: [AISpendModel]
    /// Absent from older APIs.
    public var byProvider: [AISpendProviderTotals]?
    public var budget: AIBudget
    public var pricingVersion: String?
    public var monthStart: Date

    public init(today: AISpendTotals, month: AISpendTotals, byModel: [AISpendModel] = [], byProvider: [AISpendProviderTotals]? = nil, budget: AIBudget = AIBudget(), pricingVersion: String? = nil, monthStart: Date) {
        self.today = today
        self.month = month
        self.byModel = byModel
        self.byProvider = byProvider
        self.budget = budget
        self.pricingVersion = pricingVersion
        self.monthStart = monthStart
    }

    /// "$1,23" in Turkish style (two decimals; under a cent: "<$0,01").
    public static func usd(_ value: Double) -> String {
        if value > 0, value < 0.005 { return "<$0,01" }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "tr_TR")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return "$" + (formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value))
    }

    /// One line per service this month, most expensive first (older APIs: per model's provider).
    public var providerLines: [(name: String, text: String)] {
        let rows: [AISpendProviderTotals] = byProvider ?? {
            var sums: [AISpendProvider: AISpendProviderTotals] = [:]
            for model in byModel {
                let provider = model.provider ?? .gemini
                var row = sums[provider] ?? AISpendProviderTotals(provider: provider, costUsd: 0, calls: 0, unpricedCalls: 0)
                row.costUsd += model.costUsd
                row.calls += model.calls
                row.unpricedCalls += model.unpricedCalls
                sums[provider] = row
            }
            return sums.values.sorted { $0.costUsd > $1.costUsd }
        }()
        return rows.map { row in
            (row.provider.displayName, "\(Self.usd(row.costUsd)) · \(row.calls) çağrı")
        }
    }

    /// "$4,20 / $20,00 (%21)" or "$4,20 · bütçe yok".
    public var budgetLine: String {
        guard let monthly = budget.monthlyUsd else { return "\(Self.usd(month.costUsd)) · bütçe yok" }
        let percent = budget.usedPercent.map { " (%\(Int($0.rounded())))" } ?? ""
        return "\(Self.usd(month.costUsd)) / \(Self.usd(monthly))\(percent)"
    }
}
