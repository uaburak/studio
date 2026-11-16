import Foundation
import Security
import Synchronization

/// Adds authentication headers to every request (HTTP and WebSocket upgrade).
///
/// Today the API has no client auth (`middleware/access.ts` is a no-op). Once
/// Cloudflare Access protects it, the apps send an Access *service token*:
/// `CF-Access-Client-Id` + `CF-Access-Client-Secret`, kept in the Keychain.
/// This protocol is the single seam for that.
public protocol AuthProvider: Sendable {
    func headers() async throws -> [String: String]
}

/// No authentication (local development).
public struct NoAuth: AuthProvider {
    public init() {}
    public func headers() async throws -> [String: String] { [:] }
}

/// A Cloudflare Access service token.
public struct AccessServiceToken: Codable, Sendable, Equatable {
    public var clientId: String
    public var clientSecret: String

    public init(clientId: String, clientSecret: String) {
        self.clientId = clientId
        self.clientSecret = clientSecret
    }
}

/// Sends the Access service token from `store` when one is saved, nothing otherwise.
public struct AccessServiceTokenAuth: AuthProvider {
    public var store: any CredentialStore

    public init(store: any CredentialStore) {
        self.store = store
    }

    public func headers() async throws -> [String: String] {
        guard let token = try store.load() else { return [:] }
        return [
            "CF-Access-Client-Id": token.clientId,
            "CF-Access-Client-Secret": token.clientSecret,
        ]
    }
}

public struct KeychainError: Error, Equatable, LocalizedError {
    public var status: OSStatus

    public init(status: OSStatus) { self.status = status }

    public var errorDescription: String? {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return "Anahtar zinciri hatası: \(message)"
    }
}

/// Where the Access service token lives.
public protocol CredentialStore: Sendable {
    func load() throws -> AccessServiceToken?
    func save(_ token: AccessServiceToken) throws
    func delete() throws
}

/// Generic-password Keychain item holding the JSON-encoded token; never synced.
public struct KeychainCredentialStore: CredentialStore {
    public var service: String
    public var account: String

    public init(service: String = "net.burakkoc.studio", account: String = "cloudflare-access-service-token") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() throws -> AccessServiceToken? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return try? JSONDecoder().decode(AccessServiceToken.self, from: data)
    }

    public func save(_ token: AccessServiceToken) throws {
        let data = try JSONEncoder().encode(token)
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

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// For tests and previews.
public final class InMemoryCredentialStore: CredentialStore {
    private let stored: Mutex<AccessServiceToken?>

    public init(_ token: AccessServiceToken? = nil) {
        stored = Mutex(token)
    }

    public func load() throws -> AccessServiceToken? { stored.withLock { $0 } }
    public func save(_ token: AccessServiceToken) throws { stored.withLock { $0 = token } }
    public func delete() throws { stored.withLock { $0 = nil } }
}
