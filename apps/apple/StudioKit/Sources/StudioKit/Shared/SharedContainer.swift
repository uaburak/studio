import Foundation
import Security
import Synchronization

// Where the iPhone app and its extensions (share extension N20, widget N22) meet:
//
// - the App Group container (`group.<bundle id>`): files (upload bodies, the widget's cached
//   snapshot, shares still uploading) and a shared `UserDefaults`;
// - the shared Keychain access group (`<team>.<bundle id>.shared`): the paired device token.
//
// Both need entitlements that only a signed build with registered identifiers has. Without them
// (an unsigned simulator build, a free personal team, the wildcard-profile install) each part
// degrades on its own: the app keeps its own Keychain item and `UserDefaults.standard`, the
// extensions say "Studio'yu aç" or upload only while their sheet is open.

/// The identifiers of the shared storage and whether this process can use them.
public struct StudioSharedContainer: Sendable {
    /// The app's bundle id (`STUDIO_BUNDLE_ID`); an extension's own id has a suffix.
    public var baseBundleId: String
    /// `group.<baseBundleId>`.
    public var appGroupId: String
    /// `<team prefix><baseBundleId>.shared`; nil when the team prefix is unknown.
    public var keychainGroup: String?
    /// The App Group folder; nil when this process is not entitled to it.
    public var containerURL: URL?

    public init(baseBundleId: String, appGroupId: String? = nil, keychainGroup: String?, containerURL: URL?) {
        self.baseBundleId = baseBundleId
        self.appGroupId = appGroupId ?? Self.appGroupId(for: baseBundleId)
        self.keychainGroup = keychainGroup
        self.containerURL = containerURL
    }

    /// Read from the running bundle: `StudioBaseBundleID`, `StudioAppGroup` and
    /// `StudioAppIdentifierPrefix` are written into every target's Info.plist from the build
    /// settings (Config/*.xcconfig). The team prefix falls back to the Keychain's own answer.
    public init(bundle: Bundle) {
        let info = bundle.infoDictionary ?? [:]
        let base = Self.clean(info["StudioBaseBundleID"] as? String)
            ?? Self.baseBundleId(fromBundleId: bundle.bundleIdentifier ?? "studio.ios")
        let group = Self.clean(info["StudioAppGroup"] as? String) ?? Self.appGroupId(for: base)
        let prefix = Self.validTeamPrefix(info["StudioAppIdentifierPrefix"] as? String) ?? KeychainTeamPrefix.current
        self.init(
            baseBundleId: base, appGroupId: group,
            keychainGroup: prefix.map { Self.keychainGroup(teamPrefix: $0, baseBundleId: base) },
            containerURL: FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group))
    }

    /// This process's shared storage (read once).
    public static let current = StudioSharedContainer(bundle: .main)

    /// The App Group is there (files and defaults are shared with the extensions).
    public var isAppGroupAvailable: Bool { containerURL != nil }

    /// The App Group's defaults; nil without the App Group.
    public var sharedDefaults: UserDefaults? {
        guard isAppGroupAvailable else { return nil }
        return UserDefaults(suiteName: appGroupId)
    }

    /// A folder inside the App Group (created on first use); nil without the App Group.
    public func directory(_ name: String) -> URL? {
        guard let containerURL else { return nil }
        let url = containerURL.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The background upload session of the app (`<bundle id>.uploads`).
    public var appUploadSessionId: String { "\(baseBundleId).uploads" }
    /// The share extension's own background session: a session id may be used by one process
    /// at a time, and the system wakes the app with this id when the extension is gone.
    public var shareUploadSessionId: String { "\(baseBundleId).share.uploads" }

    // MARK: Identifiers (pure; tested)

    public static func appGroupId(for baseBundleId: String) -> String { "group.\(baseBundleId)" }

    public static func keychainGroup(teamPrefix: String, baseBundleId: String) -> String {
        let prefix = teamPrefix.hasSuffix(".") ? teamPrefix : teamPrefix + "."
        return "\(prefix)\(baseBundleId).shared"
    }

    /// Extension ids end in a known suffix (`.share`, `.widget`); the app's id is the base.
    public static func baseBundleId(fromBundleId id: String) -> String {
        for suffix in [".share", ".widget", ".tests"] where id.hasSuffix(suffix) {
            return String(id.dropLast(suffix.count))
        }
        return id
    }

    /// `ABCDE12345.` (ten upper-case letters or digits and a dot); nil for an empty or
    /// unexpanded build setting.
    public static func validTeamPrefix(_ raw: String?) -> String? {
        guard var text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        if !text.hasSuffix(".") { text += "." }
        let team = text.dropLast()
        guard team.count == 10, team.allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber) }) else { return nil }
        return text
    }

    private static func clean(_ raw: String?) -> String? {
        guard let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, !text.contains("$(") else { return nil }
        return text
    }
}

/// The team prefix of this process's own Keychain group, read the one way iOS offers: add a
/// throwaway item and look at the access group it got (the application identifier).
enum KeychainTeamPrefix {
    static let current: String? = probe()

    static func probe() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "studio.team-prefix-probe",
            kSecAttrAccount as String: "probe",
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            status = SecItemAdd(query as CFDictionary, &result)
        }
        guard status == errSecSuccess, let attributes = result as? [String: Any],
              let group = attributes[kSecAttrAccessGroup as String] as? String,
              let dot = group.firstIndex(of: ".") else { return nil }
        return StudioSharedContainer.validTeamPrefix(String(group[...dot]))
    }
}

// MARK: - Settings the extensions read

/// `UserDefaults` keys the app shares with its extensions (in the App Group's defaults).
public enum SharedSettingsKeys {
    /// Gelişmiş → "Ek uzak adres" switch and address (tried after the Mac's own routes).
    public static let remoteEnabled = "studio.ios.useRemoteURL"
    public static let remoteURL = "studio.ios.remoteURL"
    /// The brand the app last showed (the share sheet starts there).
    public static let lastBrand = "studio.ios.brand"
    /// Brands the app loaded last (`[SharedBrand]` JSON): the share sheet lists them at once.
    public static let brands = "studio.shared.brands"

    /// Moved from the app's own defaults into the App Group on first launch with it.
    public static let migrated = [remoteEnabled, remoteURL, lastBrand]

    /// The manual remote address, when switched on and valid.
    public static func manualRemoteURL(in defaults: UserDefaults) -> URL? {
        guard defaults.bool(forKey: remoteEnabled),
              let raw = defaults.string(forKey: remoteURL)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: raw), url.scheme == "http" || url.scheme == "https", url.host != nil else { return nil }
        return url
    }
}

/// A brand as the extensions list it before the Mac answers.
public struct SharedBrand: Codable, Sendable, Hashable, Identifiable {
    public var id: EntityID
    public var name: String

    public init(id: EntityID, name: String) {
        self.id = id
        self.name = name
    }

    public static func load(from defaults: UserDefaults) -> [SharedBrand] {
        guard let data = defaults.data(forKey: SharedSettingsKeys.brands) else { return [] }
        return (try? JSONDecoder().decode([SharedBrand].self, from: data)) ?? []
    }

    public static func save(_ brands: [SharedBrand], to defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(brands) else { return }
        if defaults.data(forKey: SharedSettingsKeys.brands) != data { defaults.set(data, forKey: SharedSettingsKeys.brands) }
    }
}

public enum SharedDefaults {
    /// Move `keys` from the app's own defaults into the shared ones: a value already in the
    /// shared store wins, the old copy is removed either way. Returns the keys that were copied.
    @discardableResult
    public static func migrate(keys: [String] = SharedSettingsKeys.migrated, from old: UserDefaults, to shared: UserDefaults) -> [String] {
        guard old !== shared else { return [] }
        var moved: [String] = []
        for key in keys {
            guard let value = old.object(forKey: key) else { continue }
            if shared.object(forKey: key) == nil {
                shared.set(value, forKey: key)
                moved.append(key)
            }
            old.removeObject(forKey: key)
        }
        return moved
    }

    /// The defaults the app keeps shared settings in: the App Group's (after moving the old
    /// values there once), or `fallback` without the App Group.
    public static func store(container: StudioSharedContainer = .current, fallback: UserDefaults = .standard) -> UserDefaults {
        guard let shared = container.sharedDefaults else { return fallback }
        migrate(from: fallback, to: shared)
        return shared
    }
}
