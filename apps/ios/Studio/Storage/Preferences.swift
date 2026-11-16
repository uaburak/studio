import Foundation

/// Non-secret settings in UserDefaults: server address and the last brand.
/// Secrets never go here (see `CredentialStore`).
struct Preferences: @unchecked Sendable {
    // UserDefaults is thread-safe; it is just not annotated Sendable.
    let defaults: UserDefaults

    private enum Key {
        static let baseURL = "server.baseURL"
        static let selectedBrandId = "brand.selectedId"
    }

    var baseURL: URL {
        get {
            defaults.string(forKey: Key.baseURL).flatMap { try? ServerConfiguration.parseBaseURL($0).get() }
                ?? ServerConfiguration.defaultBaseURL
        }
        nonmutating set { defaults.set(newValue.absoluteString, forKey: Key.baseURL) }
    }

    var selectedBrandId: String? {
        get { defaults.string(forKey: Key.selectedBrandId) }
        nonmutating set { defaults.set(newValue, forKey: Key.selectedBrandId) }
    }

    func resetBaseURL() {
        defaults.removeObject(forKey: Key.baseURL)
    }
}
