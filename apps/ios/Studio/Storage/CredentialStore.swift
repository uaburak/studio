import Foundation
import Security

/// Where the Cloudflare Access service token lives.
protocol CredentialStore: Sendable {
    func load() throws(KeychainError) -> AccessCredentials?
    func save(_ credentials: AccessCredentials) throws(KeychainError)
    func delete() throws(KeychainError)
}

struct KeychainError: Error, Equatable, LocalizedError {
    var status: OSStatus

    var errorDescription: String? {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return "Anahtar zinciri hatası: \(message)"
    }
}

/// Generic-password item holding the JSON-encoded credentials. Readable after
/// the first unlock (so background refresh could use it later), never synced
/// to other devices or included in backups restored elsewhere.
struct KeychainCredentialStore: CredentialStore {
    var service = "net.burakkoc.studio"
    var account = "cloudflare-access-service-token"

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load() throws(KeychainError) -> AccessCredentials? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return try? JSONDecoder().decode(AccessCredentials.self, from: data)
    }

    func save(_ credentials: AccessCredentials) throws(KeychainError) {
        guard let data = try? JSONEncoder().encode(credentials) else { throw KeychainError(status: errSecParam) }
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func delete() throws(KeychainError) {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// For tests and the UI-test stub mode.
final class InMemoryCredentialStore: CredentialStore {
    private let stored: Locked<AccessCredentials?>

    init(_ credentials: AccessCredentials? = nil) {
        stored = Locked(credentials)
    }

    func load() throws(KeychainError) -> AccessCredentials? { stored.value }
    func save(_ credentials: AccessCredentials) throws(KeychainError) { stored.value = credentials }
    func delete() throws(KeychainError) { stored.value = nil }
}
