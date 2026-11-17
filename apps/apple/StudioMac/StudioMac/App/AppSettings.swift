import AppKit
import Foundation
import StudioKit

/// Persisted preferences (UserDefaults) and the services they produce.
@MainActor
@Observable
final class AppSettings {
    static let serverKey = "studio.serverURL"
    static let appearanceKey = "studio.appearance"
    static let sampleKey = "StudioSampleData"
    static let hostEnabledKey = "studio.host.enabled"
    static let lanEnabledKey = "studio.host.lan"
    static let repoPathKey = "studio.host.repoPath"
    static let remoteControlEnabledKey = "studio.host.remoteControlEnabled"
    static let remoteHostnameKey = "studio.host.remoteHostname"
    static let ownerNameKey = "studio.ownerName"
    nonisolated static let defaultRemoteHostname = "social.burakkoc.net"

    let defaults: UserDefaults

    var serverURLString: String {
        didSet { defaults.set(serverURLString, forKey: Self.serverKey) }
    }

    var appearance: AppearancePreference {
        didSet {
            defaults.set(appearance.rawValue, forKey: Self.appearanceKey)
            applyAppearance()
        }
    }

    /// `-StudioSampleData YES` (launch argument): use the in-memory sample
    /// instead of the API. For demos without a server; never the default.
    let useSampleData: Bool

    /// The app runs the API and worker itself (LocalHost). Off: talk to `serverURLString`.
    var hostEnabled: Bool {
        didSet { defaults.set(hostEnabled, forKey: Self.hostEnabledKey) }
    }

    /// The host's LAN gateway + Bonjour ("Yerel ağdan erişim"); off = 127.0.0.1 only.
    var lanEnabled: Bool {
        didSet { defaults.set(lanEnabled, forKey: Self.lanEnabledKey) }
    }

    /// Repo checkout the host runs the API and worker from.
    var repoPath: String {
        didSet { defaults.set(repoPath, forKey: Self.repoPathKey) }
    }

    /// Remote Control (`L3`): supervise `cloudflared` tunnel to expose LAN gateway / API.
    var remoteControlEnabled: Bool {
        didSet { defaults.set(remoteControlEnabled, forKey: Self.remoteControlEnabledKey) }
    }

    /// Public hostname routed to this Mac's tunnel (default `social.burakkoc.net`).
    var remoteHostname: String {
        didSet { defaults.set(remoteHostname, forKey: Self.remoteHostnameKey) }
    }

    /// "Adın": the name the sidebar shows ("" = the Claude account's name).
    var ownerName: String {
        didSet { defaults.set(ownerName, forKey: Self.ownerNameKey) }
    }

    /// The running host's API (`http://127.0.0.1:<port>`); set at runtime, not saved.
    var hostAPIURL: URL?

    var hostConfiguration: HostConfiguration {
        HostConfiguration(
            repoPath: repoPath,
            lanEnabled: lanEnabled,
            remoteControlEnabled: remoteControlEnabled,
            remoteHostname: remoteHostname,
            tunnelToken: try? tunnelTokens.load()
        )
    }

    let credentials: any CredentialStore
    let tunnelTokens: any TunnelTokenStore
    /// Model / effort per conversation and the last one used.
    let agentChoices: AgentChoiceStore

    init(
        defaults: UserDefaults = .standard,
        credentials: any CredentialStore = KeychainCredentialStore(),
        tunnelTokens: any TunnelTokenStore = TunnelTokenKeychain(),
        useSampleData: Bool? = nil
    ) {
        self.defaults = defaults
        agentChoices = AgentChoiceStore(defaults: defaults)
        self.credentials = credentials
        self.tunnelTokens = tunnelTokens
        serverURLString = defaults.string(forKey: Self.serverKey) ?? APIClient.localDefaultURL.absoluteString
        appearance = AppearancePreference(rawValue: defaults.string(forKey: Self.appearanceKey) ?? "") ?? .system
        self.useSampleData = useSampleData ?? defaults.bool(forKey: Self.sampleKey)
        hostEnabled = defaults.object(forKey: Self.hostEnabledKey) as? Bool ?? true
        lanEnabled = defaults.object(forKey: Self.lanEnabledKey) as? Bool ?? true
        repoPath = defaults.string(forKey: Self.repoPathKey) ?? HostEnvironment.defaultRepoPath
        remoteControlEnabled = defaults.object(forKey: Self.remoteControlEnabledKey) as? Bool ?? false
        remoteHostname = defaults.string(forKey: Self.remoteHostnameKey) ?? Self.defaultRemoteHostname
        ownerName = defaults.string(forKey: Self.ownerNameKey) ?? ""
    }

    var serverURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    func makeClient() -> APIClient {
        // The Mac app talks to its own host on 127.0.0.1 (trusted as local, no token).
        if hostEnabled, let hostAPIURL { return APIClient(baseURL: hostAPIURL) }
        return APIClient(baseURL: serverURL ?? APIClient.localDefaultURL, auth: AccessServiceTokenAuth(store: credentials))
    }

    /// Apply to every window immediately (no restart).
    func applyAppearance() {
        NSApp?.appearance = appearance.nsAppearance
    }
}

/// Images the user uploaded for a post's slot, remembered until a new version arrives.
@MainActor
final class PendingSlotImageStore {
    private let defaults: UserDefaults
    private let key = "studio.pendingSlotImages"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func all() -> [EntityID: PendingSlotImage] {
        guard let data = defaults.data(forKey: key),
              let list = try? JSONDecoder().decode([PendingSlotImage].self, from: data) else { return [:] }
        return Dictionary(list.map { ($0.contentId, $0) }, uniquingKeysWith: { $1 })
    }

    func save(_ image: PendingSlotImage) {
        var current = all()
        current[image.contentId] = image
        if let data = try? JSONEncoder().encode(Array(current.values)) { defaults.set(data, forKey: key) }
    }
}
