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

    private let defaults: UserDefaults

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

    let credentials: any CredentialStore

    init(defaults: UserDefaults = .standard, credentials: any CredentialStore = KeychainCredentialStore(), useSampleData: Bool? = nil) {
        self.defaults = defaults
        self.credentials = credentials
        serverURLString = defaults.string(forKey: Self.serverKey) ?? APIClient.localDefaultURL.absoluteString
        appearance = AppearancePreference(rawValue: defaults.string(forKey: Self.appearanceKey) ?? "") ?? .system
        self.useSampleData = useSampleData ?? defaults.bool(forKey: Self.sampleKey)
    }

    var serverURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    func makeClient() -> APIClient {
        APIClient(baseURL: serverURL ?? APIClient.localDefaultURL, auth: AccessServiceTokenAuth(store: credentials))
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
