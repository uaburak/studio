import Foundation
import Security
import Synchronization

/// Named secrets the owner types once (Meta App Secret, LinkedIn Client Secret, cloud
/// publisher token). Read only when needed (connect, health check), never at launch: an
/// ad-hoc signed rebuild makes macOS ask for the keychain password on every read.
public protocol SecretStore: Sendable {
    func load(_ name: String) throws -> String?
    func save(_ value: String, name: String) throws
    func delete(_ name: String) throws
}

public enum PublishingSecret {
    public static let metaAppSecret = "meta-app-secret"
    public static let linkedInClientSecret = "linkedin-client-secret"
    public static let cloudPublisherToken = "cloud-publisher-token"
}

/// Generic-password Keychain items under one service, this device only, never synced.
public struct KeychainSecretStore: SecretStore {
    public var service: String

    public init(service: String = "net.burakkoc.studio.publishing") {
        self.service = service
    }

    private func query(_ name: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name,
        ]
    }

    public func load(_ name: String) throws -> String? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return String(data: data, encoding: .utf8)
    }

    public func save(_ value: String, name: String) throws {
        let update: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(name) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(name)
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete(_ name: String) throws {
        let status = SecItemDelete(query(name) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// For tests and previews.
public final class InMemorySecretStore: SecretStore {
    private let values = Mutex<[String: String]>([:])

    public init(_ initial: [String: String] = [:]) {
        values.withLock { $0 = initial }
    }

    public func load(_ name: String) throws -> String? { values.withLock { $0[name] } }
    public func save(_ value: String, name: String) throws { values.withLock { $0[name] = value } }
    public func delete(_ name: String) throws { _ = values.withLock { $0.removeValue(forKey: name) } }
}
