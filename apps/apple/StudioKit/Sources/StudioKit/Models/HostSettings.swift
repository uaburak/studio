import Foundation

// Mirrors packages/contract/src/host-settings.ts (the Mac host settings bridge) and the settings
// the phone may now change through the API (AI keys, preferences, publishing lateness, paired
// devices, server health): iOS Ayarlar parity with the Mac app.

// MARK: - Mac host settings bridge

/// The Mac's theme (`HostAppearance`).
public enum HostAppearance: String, OpenEnum {
    case system, light, dark
    case unknown

    public var label: String {
        switch self {
        case .system: "Sistem"
        case .light: "Açık"
        case .dark: "Koyu"
        case .unknown: "Bilinmeyen"
        }
    }
}

/// Keys the phone may set or remove on the Mac (`HostKeyName`). Values never come back.
public enum HostKeyName: String, OpenEnum {
    case cloudflareTunnelToken = "CLOUDFLARE_TUNNEL_TOKEN"
    case geminiAPIKey = "GEMINI_API_KEY"
    case elevenLabsAPIKey = "ELEVENLABS_API_KEY"
    case elevenLabsVoiceID = "STUDIO_ELEVENLABS_VOICE_ID"
    case cloudPublisherURL = "STUDIO_CLOUD_PUBLISHER_URL"
    case cloudPublisherToken = "STUDIO_CLOUD_PUBLISHER_TOKEN"
    case metaAppSecret = "META_APP_SECRET"
    case linkedInClientSecret = "LINKEDIN_CLIENT_SECRET"
    case unknown
}

/// `HostKeyState`: whether a key is saved on the Mac (never its value).
public struct HostKeyState: Codable, Sendable, Hashable, Identifiable {
    public enum Group: String, OpenEnum {
        case tunnel, worker, accounts
        case unknown
    }

    public enum Source: String, OpenEnum {
        case settings
        case envFile = "env-file"
        case unknown
    }

    public var name: HostKeyName
    public var label: String
    public var group: Group
    public var secret: Bool
    public var saved: Bool
    public var source: Source?

    public var id: String { name.rawValue }

    public init(name: HostKeyName, label: String, group: Group, secret: Bool, saved: Bool, source: Source? = nil) {
        self.name = name
        self.label = label
        self.group = group
        self.secret = secret
        self.saved = saved
        self.source = source
    }

    /// "Kayıtlı", "Kayıtlı (.env)", "Yok": the only thing the phone ever shows about a key.
    public var statusText: String {
        guard saved else { return "Yok" }
        return source == .envFile ? "Kayıtlı (depodaki .env)" : "Kayıtlı"
    }
}

/// `HostInfo`: read-only facts about the Mac host.
public struct HostInfo: Codable, Sendable, Hashable {
    public struct Tunnel: Codable, Sendable, Hashable {
        public var state: String
        public var detail: String

        public init(state: String, detail: String) {
            self.state = state
            self.detail = detail
        }
    }

    public var macName: String
    public var appVersion: String
    public var mode: String
    public var hostEnabled: Bool
    public var hostStatus: String
    public var hostError: Bool
    public var apiPort: Int?
    public var lanPort: Int?
    public var lanUrls: [String]
    public var tunnel: Tunnel
    public var loginItemSupported: Bool
    public var loginItemNote: String
    public var keepAwakeActive: Bool
    public var keepAwakeReason: String?
    public var keysSealed: Bool
    public var updatesNote: String

    public init(
        macName: String, appVersion: String, mode: String = "packaged", hostEnabled: Bool = true,
        hostStatus: String, hostError: Bool = false, apiPort: Int? = nil, lanPort: Int? = nil,
        lanUrls: [String] = [], tunnel: Tunnel = Tunnel(state: "off", detail: "Kapalı."),
        loginItemSupported: Bool = true, loginItemNote: String = "", keepAwakeActive: Bool = false,
        keepAwakeReason: String? = nil, keysSealed: Bool = true, updatesNote: String = ""
    ) {
        self.macName = macName
        self.appVersion = appVersion
        self.mode = mode
        self.hostEnabled = hostEnabled
        self.hostStatus = hostStatus
        self.hostError = hostError
        self.apiPort = apiPort
        self.lanPort = lanPort
        self.lanUrls = lanUrls
        self.tunnel = tunnel
        self.loginItemSupported = loginItemSupported
        self.loginItemNote = loginItemNote
        self.keepAwakeActive = keepAwakeActive
        self.keepAwakeReason = keepAwakeReason
        self.keysSealed = keysSealed
        self.updatesNote = updatesNote
    }
}

/// `HostSettingsValues`: the Mac app's own non-secret settings.
public struct HostSettingsValues: Codable, Sendable, Hashable {
    public var lanEnabled: Bool
    public var remoteControlEnabled: Bool
    public var remoteHostname: String
    public var keepAwake: Bool
    public var notificationsEnabled: Bool
    public var appearance: HostAppearance
    public var ownerName: String
    public var loginItem: Bool
    public var defaultModel: String?
    public var defaultEffort: String?
    public var metaAppId: String
    public var linkedInClientId: String

    public init(
        lanEnabled: Bool = true, remoteControlEnabled: Bool = false, remoteHostname: String = "",
        keepAwake: Bool = true, notificationsEnabled: Bool = true, appearance: HostAppearance = .system,
        ownerName: String = "", loginItem: Bool = false, defaultModel: String? = nil,
        defaultEffort: String? = nil, metaAppId: String = "", linkedInClientId: String = ""
    ) {
        self.lanEnabled = lanEnabled
        self.remoteControlEnabled = remoteControlEnabled
        self.remoteHostname = remoteHostname
        self.keepAwake = keepAwake
        self.notificationsEnabled = notificationsEnabled
        self.appearance = appearance
        self.ownerName = ownerName
        self.loginItem = loginItem
        self.defaultModel = defaultModel
        self.defaultEffort = defaultEffort
        self.metaAppId = metaAppId
        self.linkedInClientId = linkedInClientId
    }

    /// The patch's values applied (what the Mac will show once it took the change).
    public func applying(_ patch: HostSettingsPatch) -> HostSettingsValues {
        var next = self
        if let v = patch.lanEnabled { next.lanEnabled = v }
        if let v = patch.remoteControlEnabled { next.remoteControlEnabled = v }
        if let v = patch.remoteHostname { next.remoteHostname = v }
        if let v = patch.keepAwake { next.keepAwake = v }
        if let v = patch.notificationsEnabled { next.notificationsEnabled = v }
        if let v = patch.appearance { next.appearance = v }
        if let v = patch.ownerName { next.ownerName = v }
        if let v = patch.loginItem { next.loginItem = v }
        if let v = patch.defaultModel { next.defaultModel = v.rawValue }
        if let v = patch.defaultEffort { next.defaultEffort = v.rawValue }
        if let v = patch.metaAppId { next.metaAppId = v }
        if let v = patch.linkedInClientId { next.linkedInClientId = v }
        return next
    }
}

/// `HostSettingsState`: what the Mac app sends on every sync.
public struct HostSettingsState: Codable, Sendable, Hashable {
    public var values: HostSettingsValues
    public var keys: [HostKeyState]
    public var info: HostInfo

    public init(values: HostSettingsValues, keys: [HostKeyState], info: HostInfo) {
        self.values = values
        self.keys = keys
        self.info = info
    }

    public func key(_ name: HostKeyName) -> HostKeyState? { keys.first { $0.name == name } }
}

/// `HostSettingsPatch`: only the fields set are sent.
public struct HostSettingsPatch: Codable, Sendable, Hashable {
    public var lanEnabled: Bool?
    public var remoteControlEnabled: Bool?
    public var remoteHostname: String?
    public var keepAwake: Bool?
    public var notificationsEnabled: Bool?
    public var appearance: HostAppearance?
    public var ownerName: String?
    public var loginItem: Bool?
    public var defaultModel: AgentModel?
    public var defaultEffort: AgentEffort?
    public var metaAppId: String?
    public var linkedInClientId: String?
    /// An action: restart the Studio server once (new worker keys take effect).
    public var restartHost: Bool?

    public init(
        lanEnabled: Bool? = nil, remoteControlEnabled: Bool? = nil, remoteHostname: String? = nil,
        keepAwake: Bool? = nil, notificationsEnabled: Bool? = nil, appearance: HostAppearance? = nil,
        ownerName: String? = nil, loginItem: Bool? = nil, defaultModel: AgentModel? = nil,
        defaultEffort: AgentEffort? = nil, metaAppId: String? = nil, linkedInClientId: String? = nil,
        restartHost: Bool? = nil
    ) {
        self.lanEnabled = lanEnabled
        self.remoteControlEnabled = remoteControlEnabled
        self.remoteHostname = remoteHostname
        self.keepAwake = keepAwake
        self.notificationsEnabled = notificationsEnabled
        self.appearance = appearance
        self.ownerName = ownerName
        self.loginItem = loginItem
        self.defaultModel = defaultModel
        self.defaultEffort = defaultEffort
        self.metaAppId = metaAppId
        self.linkedInClientId = linkedInClientId
        self.restartHost = restartHost == true ? true : nil
    }

    public var isEmpty: Bool { self == HostSettingsPatch() }
}

/// `HostKeyChange`: set (`value`) or remove (`value == nil`, sent as `null`).
public struct HostKeyChange: Codable, Sendable, Hashable {
    public var name: HostKeyName
    public var value: String?

    public init(name: HostKeyName, value: String?) {
        self.name = name
        self.value = value
    }

    private enum CodingKeys: String, CodingKey { case name, value }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(value, forKey: .value)
    }
}

/// `POST /api/host/settings/changes`.
public struct HostSettingsChangeCreate: Encodable, Sendable, Hashable {
    public var values: HostSettingsPatch
    public var keys: [HostKeyChange]

    public init(values: HostSettingsPatch = HostSettingsPatch(), keys: [HostKeyChange] = []) {
        self.values = values
        self.keys = keys
    }

    /// Would cut the route the phone uses (the API refuses it too; the app asks first).
    public func cuts(_ via: HostRoute, current: HostSettingsValues?) -> Bool {
        switch via {
        case .tunnel:
            if values.remoteControlEnabled == false { return true }
            if let host = values.remoteHostname, host != (current?.remoteHostname ?? host) { return true }
            return keys.contains { $0.name == .cloudflareTunnelToken }
        case .lan:
            return values.lanEnabled == false
        case .local, .unknown:
            return false
        }
    }
}

public enum HostSettingsChangeStatus: String, OpenEnum {
    case pending, applied, failed
    case unknown
}

/// `HostSettingsChange` (key values never).
public struct HostSettingsChange: Codable, Sendable, Hashable, Identifiable {
    public struct KeyAction: Codable, Sendable, Hashable {
        public var name: HostKeyName
        public var action: String
    }

    public var id: EntityID
    public var values: HostSettingsPatch
    public var keys: [KeyAction]
    public var deviceId: String?
    public var status: HostSettingsChangeStatus
    public var message: String?
    public var createdAt: Date
    public var finishedAt: Date?

    public init(id: EntityID, values: HostSettingsPatch, keys: [KeyAction] = [], deviceId: String? = nil, status: HostSettingsChangeStatus, message: String? = nil, createdAt: Date, finishedAt: Date? = nil) {
        self.id = id
        self.values = values
        self.keys = keys
        self.deviceId = deviceId
        self.status = status
        self.message = message
        self.createdAt = createdAt
        self.finishedAt = finishedAt
    }
}

/// Which way the phone reached the Mac (`HostRoute`).
public enum HostRoute: String, OpenEnum {
    case local, lan, tunnel
    case unknown
}

/// `GET /api/host/settings`.
public struct HostSettingsView: Codable, Sendable, Hashable {
    public var state: HostSettingsState?
    public var seenAt: Date?
    /// The Mac app synced within 30 s: changes are applied in a few seconds.
    public var live: Bool
    public var via: HostRoute
    public var changes: [HostSettingsChange]

    public init(state: HostSettingsState?, seenAt: Date? = nil, live: Bool, via: HostRoute, changes: [HostSettingsChange] = []) {
        self.state = state
        self.seenAt = seenAt
        self.live = live
        self.via = via
        self.changes = changes
    }

    /// The values with the still pending changes applied (oldest first), so a switch the owner
    /// just turned stays where they put it while the Mac catches up.
    public var effectiveValues: HostSettingsValues? {
        guard var values = state?.values else { return nil }
        for change in changes.reversed() where change.status == .pending {
            values = values.applying(change.values)
        }
        return values
    }

    public var pendingCount: Int { changes.filter { $0.status == .pending }.count }

    /// The newest finished change that failed, if it is the newest finished one.
    public var lastFailure: HostSettingsChange? {
        guard let latest = changes.first(where: { $0.status != .pending }), latest.status == .failed else { return nil }
        return latest
    }
}

/// The API's lockout refusals (`HOST_LOCKOUT_MESSAGES`), to explain before asking.
public enum HostLockout {
    public static let tunnel = "Bu değişiklik, telefonun şu an kullandığı uzaktan erişim bağlantısını keser. Aynı Wi-Fi'deyken (yerel ağdan) ya da Mac'te değiştir."
    public static let lan = "Telefon Mac'e şu an yerel ağdan bağlı; yerel ağ erişimini kapatırsan bağlantı kesilir. Uzaktan erişim üzerinden ya da Mac'te kapat."
}

// MARK: - AI keys and preferences

/// Providers whose API key the vault keeps (`AiKeyProvider`).
public enum AIKeyProvider: String, OpenEnum {
    case gemini, openai
    case unknown

    public var displayName: String {
        switch self {
        case .gemini: "Gemini API anahtarı"
        case .openai: "OpenAI API anahtarı"
        case .unknown: "API anahtarı"
        }
    }

    /// Where the owner gets a key.
    public var keyPage: URL? {
        switch self {
        case .gemini: URL(string: "https://aistudio.google.com/apikey")
        case .openai: URL(string: "https://platform.openai.com/api-keys")
        case .unknown: nil
        }
    }
}

/// `AiKeyState` (a phone never gets the hint).
public struct AIKeyState: Codable, Sendable, Hashable, Identifiable {
    public var provider: AIKeyProvider
    public var configured: Bool
    public var hint: String?
    public var valid: Bool?
    public var checkedAt: Date?
    public var detail: String?
    public var models: [String]
    public var updatedAt: Date?

    public var id: String { provider.rawValue }

    public init(provider: AIKeyProvider, configured: Bool, hint: String? = nil, valid: Bool? = nil, checkedAt: Date? = nil, detail: String? = nil, models: [String] = [], updatedAt: Date? = nil) {
        self.provider = provider
        self.configured = configured
        self.hint = hint
        self.valid = valid
        self.checkedAt = checkedAt
        self.detail = detail
        self.models = models
        self.updatedAt = updatedAt
    }

    /// "Kayıtlı · geçerli", "Kayıtlı · reddedildi", "Yok".
    public var statusText: String {
        guard configured else { return "Yok" }
        switch valid {
        case true: return "Kayıtlı · geçerli"
        case false: return "Kayıtlı · reddedildi"
        default: return "Kayıtlı · denetlenmedi"
        }
    }
}

/// `GET /api/ai/keys`.
public struct AIKeyList: Codable, Sendable, Hashable {
    public var items: [AIKeyState]
    public var vaultReady: Bool

    public init(items: [AIKeyState], vaultReady: Bool) {
        self.items = items
        self.vaultReady = vaultReady
    }
}

/// `PUT /api/ai/keys/{provider}`.
public struct AIKeyPut: Encodable, Sendable, Hashable {
    public var key: String
    public init(key: String) { self.key = key }
}

/// `PUT /api/ai/preferences`: only the fields set change; `clearBudget` sends `null`.
public struct AIPreferencesPut: Encodable, Sendable, Hashable {
    public var claudeLimit: ClaudeLimitMode?
    public var monthlyBudgetUsd: Double?
    public var clearBudget: Bool
    public var stopAtBudget: Bool?
    public var mediaCaptions: Bool?

    public init(claudeLimit: ClaudeLimitMode? = nil, monthlyBudgetUsd: Double? = nil, clearBudget: Bool = false, stopAtBudget: Bool? = nil, mediaCaptions: Bool? = nil) {
        self.claudeLimit = claudeLimit
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.clearBudget = clearBudget
        self.stopAtBudget = stopAtBudget
        self.mediaCaptions = mediaCaptions
    }

    private enum CodingKeys: String, CodingKey { case claudeLimit, monthlyBudgetUsd, stopAtBudget, mediaCaptions }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(claudeLimit, forKey: .claudeLimit)
        if clearBudget {
            try container.encodeNil(forKey: .monthlyBudgetUsd)
        } else {
            try container.encodeIfPresent(monthlyBudgetUsd, forKey: .monthlyBudgetUsd)
        }
        try container.encodeIfPresent(stopAtBudget, forKey: .stopAtBudget)
        try container.encodeIfPresent(mediaCaptions, forKey: .mediaCaptions)
    }
}

// MARK: - Publishing, health

/// `PATCH /api/publishing/settings`.
public struct PublishingSettingsPatch: Encodable, Sendable, Hashable {
    public var maxLatenessMinutes: Int?
    public init(maxLatenessMinutes: Int? = nil) { self.maxLatenessMinutes = maxLatenessMinutes }

    public static let minLateness = 5
    public static let maxLateness = 7 * 24 * 60
}

/// `HealthComponent` of `GET /api/health` (the server's parts, ok / warn / fail).
public struct HealthComponent: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var state: String
    public var label: String
    public var detail: String

    public init(id: String, state: String, label: String, detail: String) {
        self.id = id
        self.state = state
        self.label = label
        self.detail = detail
    }
}

/// `HealthResponse.migrations`.
public struct HealthMigrations: Codable, Sendable, Hashable {
    public var applied: Int
    public var last: String?
    public var expected: String
}
