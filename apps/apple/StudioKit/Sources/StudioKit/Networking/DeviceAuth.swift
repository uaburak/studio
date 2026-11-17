import Foundation
import Security
import Synchronization

/// What a paired phone remembers about its Mac: the device token (secret)
/// plus where and who it paired with. Kept in the Keychain as one item.
/// Items written before QR pairing decode with `macId` and `routes` nil.
public struct DeviceCredential: Codable, Sendable, Equatable {
    public var token: String
    public var deviceId: EntityID
    /// The address that answered last (a LAN address or the tunnel); tried early next time.
    public var serverURL: URL
    /// The Mac's name (`TXT name` / `MacRoutes.macName`), for display and rediscovery.
    public var serverName: String
    /// Host id of the paired Mac (`HealthResponse.instance`), when known.
    public var macId: String?
    /// Every way to reach the Mac, from the QR code and refreshed after each connect.
    public var routes: MacRoutes?

    public init(token: String, deviceId: EntityID, serverURL: URL, serverName: String, macId: String? = nil, routes: MacRoutes? = nil) {
        self.token = token
        self.deviceId = deviceId
        self.serverURL = serverURL
        self.serverName = serverName
        self.macId = macId
        self.routes = routes
    }

    /// The Bonjour service name to look for (saved routes, else the Mac's name).
    public var bonjourName: String { routes?.bonjourName ?? serverName }
}

/// Where the device token lives.
public protocol DeviceTokenStore: Sendable {
    func load() throws -> DeviceCredential?
    func save(_ credential: DeviceCredential) throws
    func delete() throws
}

/// Generic-password Keychain item (this device only, never synced).
public struct KeychainDeviceTokenStore: DeviceTokenStore {
    public var service: String
    public var account: String

    public init(service: String = "net.burakkoc.studio", account: String = "paired-device-token") {
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

    public func load() throws -> DeviceCredential? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return try? JSONDecoder().decode(DeviceCredential.self, from: data)
    }

    public func save(_ credential: DeviceCredential) throws {
        let data = try JSONEncoder().encode(credential)
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
public final class InMemoryDeviceTokenStore: DeviceTokenStore {
    private let stored: Mutex<DeviceCredential?>

    public init(_ credential: DeviceCredential? = nil) {
        stored = Mutex(credential)
    }

    public func load() throws -> DeviceCredential? { stored.withLock { $0 } }
    public func save(_ credential: DeviceCredential) throws { stored.withLock { $0 = credential } }
    public func delete() throws { stored.withLock { $0 = nil } }
}

/// `Authorization: Bearer <device token>` when the device is paired; nothing otherwise.
public struct DeviceTokenAuth: AuthProvider {
    public var store: any DeviceTokenStore

    public init(store: any DeviceTokenStore) {
        self.store = store
    }

    public func headers() async throws -> [String: String] {
        guard let credential = try store.load() else { return [:] }
        return ["Authorization": "Bearer \(credential.token)"]
    }
}
