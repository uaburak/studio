import Foundation
import Security
import Synchronization

/// The device token where the app and its extensions both find it (N20, N22): one Keychain
/// item in the shared access group.
///
/// Before the extensions, the app kept the token in its own Keychain group (`legacy`). The first
/// read moves it to the shared item and deletes the old one; until then, and whenever the shared
/// group cannot be used (no entitlement: unsigned build, free team), the app reads and writes its
/// own item exactly as before. The extensions only ever find the shared one.
public final class SharedDeviceTokenStore: DeviceTokenStore {
    /// Where the token lives right now (Settings → Gelişmiş shows it).
    public enum Location: Sendable, Equatable {
        /// The shared item: the share sheet and the widget can read it.
        case shared
        /// Only the app's own item (no shared group on this build).
        case appOnly
        case none
    }

    private let shared: (any DeviceTokenStore)?
    private let legacy: any DeviceTokenStore
    /// false once the shared group refused with a missing entitlement (not asked again).
    private let sharedUsable: Mutex<Bool>

    public init(shared: (any DeviceTokenStore)?, legacy: any DeviceTokenStore) {
        self.shared = shared
        self.legacy = legacy
        sharedUsable = Mutex(shared != nil)
    }

    /// The token item names: the old one (`paired-device-token`, the app's own group) and the
    /// shared one (another account name, so a query for one never matches the other).
    public static let legacyAccount = "paired-device-token"
    public static let sharedAccount = "shared-device-token"

    /// The store every target of the app uses (service = the app's bundle id).
    public static func standard(container: StudioSharedContainer = .current) -> SharedDeviceTokenStore {
        let legacy = KeychainDeviceTokenStore(service: container.baseBundleId, account: legacyAccount)
        let shared = container.keychainGroup.map {
            KeychainDeviceTokenStore(service: container.baseBundleId, account: sharedAccount, accessGroup: $0)
        }
        return SharedDeviceTokenStore(shared: shared, legacy: legacy)
    }

    private var usableShared: (any DeviceTokenStore)? {
        sharedUsable.withLock { $0 } ? shared : nil
    }

    /// The shared group refused for good (no entitlement): stop asking it.
    private func sharedFailed(_ error: any Error) -> Bool {
        guard Self.isMissingEntitlement(error) else { return false }
        sharedUsable.withLock { $0 = false }
        return true
    }

    public func load() throws -> DeviceCredential? {
        if let shared = usableShared {
            do {
                if let found = try shared.load() { return found }
            } catch {
                if !sharedFailed(error) { throw error }
            }
        }
        guard let old = try legacy.load() else { return nil }
        if let shared = usableShared {
            do {
                try shared.save(old)
                try? legacy.delete()
            } catch {
                _ = sharedFailed(error)
            }
        }
        return old
    }

    public func save(_ credential: DeviceCredential) throws {
        if let shared = usableShared {
            do {
                try shared.save(credential)
                try? legacy.delete()
                return
            } catch {
                if !sharedFailed(error) { throw error }
            }
        }
        try legacy.save(credential)
    }

    public func delete() throws {
        if let shared = usableShared {
            do { try shared.delete() } catch { if !sharedFailed(error) { throw error } }
        }
        try legacy.delete()
    }

    public var location: Location {
        if let shared = usableShared, (try? shared.load()) != nil { return .shared }
        if (try? legacy.load()) != nil { return .appOnly }
        return .none
    }

    /// `errSecMissingEntitlement` (and the "no such group" answers): the build cannot use the group.
    public static func isMissingEntitlement(_ error: any Error) -> Bool {
        guard let keychain = error as? KeychainError else { return false }
        return keychain.status == errSecMissingEntitlement || keychain.status == errSecNoAccessForItem
    }
}
