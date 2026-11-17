import Foundation

/// `DevicePlatform` in device.ts.
public enum DevicePlatform: String, OpenEnum {
    case ios, ipados, macos, other
    case unknown

    /// The platform this code runs on.
    public static var current: DevicePlatform {
        #if os(iOS)
        return .ios
        #elseif os(macOS)
        return .macos
        #else
        return .other
        #endif
    }
}

/// `PairingCode`: one pairing offer made on the Mac. The 6-digit code (typed by hand, valid
/// two minutes) and the QR secret (inside the QR code, valid ten minutes) unlock the same
/// single-use claim: using either uses up both.
public struct PairingCode: Codable, Sendable, Equatable {
    public var code: String
    public var expiresAt: Date
    /// Only for the QR code; never shown or logged. Nil from servers before QR pairing.
    public var secret: String?
    public var secretExpiresAt: Date?

    public init(code: String, expiresAt: Date, secret: String? = nil, secretExpiresAt: Date? = nil) {
        self.code = code
        self.expiresAt = expiresAt
        self.secret = secret
        self.secretExpiresAt = secretExpiresAt
    }
}

/// `PairingClaim`: what the phone sends (exactly one of `code` and `secret`).
public struct PairingClaim: Codable, Sendable, Equatable {
    public var code: String?
    public var secret: String?
    public var deviceName: String
    public var platform: DevicePlatform
    /// The token this phone used before; the Mac retires that device once the claim succeeds.
    public var replacesToken: String?

    public init(code: String, deviceName: String, platform: DevicePlatform = .current, replacesToken: String? = nil) {
        self.code = code
        self.deviceName = deviceName
        self.platform = platform
        self.replacesToken = replacesToken
    }

    public init(secret: String, deviceName: String, platform: DevicePlatform = .current, replacesToken: String? = nil) {
        self.secret = secret
        self.deviceName = deviceName
        self.platform = platform
        self.replacesToken = replacesToken
    }
}

/// `MacRoutes`: every way a phone may reach this Mac. Published by the Mac app, saved by the
/// phone (in its credential) and refreshed after every connect.
public struct MacRoutes: Codable, Sendable, Equatable, Hashable {
    /// "Burak's MacBook Pro".
    public var macName: String
    /// Host id (`HealthResponse.instance`): an address answering with another id is not this Mac.
    public var macId: String?
    /// LAN IPv4 addresses (no port).
    public var lanAddresses: [String]
    /// LAN gateway port; nil while local network access is off.
    public var lanPort: Int?
    /// Bonjour service name (`_studio._tcp`).
    public var bonjourName: String?
    /// Remote Control tunnel (`https://…`), when configured.
    public var tunnelUrl: URL?
    public var updatedAt: Date?

    public init(
        macName: String, macId: String? = nil, lanAddresses: [String] = [], lanPort: Int? = nil,
        bonjourName: String? = nil, tunnelUrl: URL? = nil, updatedAt: Date? = nil
    ) {
        self.macName = macName
        self.macId = macId
        self.lanAddresses = lanAddresses
        self.lanPort = lanPort
        self.bonjourName = bonjourName
        self.tunnelUrl = tunnelUrl
        self.updatedAt = updatedAt
    }

    /// `http://<ip>:<port>` for every LAN address (empty without a port).
    public var lanURLs: [URL] {
        guard let lanPort, (1...65535).contains(lanPort) else { return [] }
        return lanAddresses.compactMap { address in
            IPv4Text.isValid(address) ? URL(string: "http://\(address):\(lanPort)") : nil
        }
    }

    private enum CodingKeys: String, CodingKey {
        case macName, macId, lanAddresses, lanPort, bonjourName, tunnelUrl, updatedAt
    }

    /// The contract's nullable fields are required keys: write `null`, never leave them out.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(macName, forKey: .macName)
        try container.encode(macId, forKey: .macId)
        try container.encode(lanAddresses, forKey: .lanAddresses)
        try container.encode(lanPort, forKey: .lanPort)
        try container.encode(bonjourName, forKey: .bonjourName)
        try container.encode(tunnelUrl, forKey: .tunnelUrl)
        try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
    }

    /// The body of `PUT /api/pairing/routes` (`updatedAt` is stamped by the server).
    public var input: MacRoutes {
        var copy = self
        copy.updatedAt = nil
        return copy
    }
}

/// Dotted-quad IPv4 check without Network.framework (usable in pure model code).
enum IPv4Text {
    static func isValid(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            guard !part.isEmpty, part.count <= 3, part.allSatisfy(\.isASCII), part.allSatisfy(\.isNumber), let value = Int(part) else { return false }
            return value <= 255 && (part.count == 1 || part.first != "0")
        }
    }
}

/// `Device`: a paired phone.
public struct PairedDevice: Codable, Sendable, Equatable, Identifiable {
    public var id: EntityID
    public var name: String
    public var platform: DevicePlatform
    public var createdAt: Date
    public var lastSeenAt: Date?
    public var revokedAt: Date?

    public var isRevoked: Bool { revokedAt != nil }
}

/// `PairingResult`: the device and its token (shown only once), plus the Mac's routes.
public struct PairingResult: Codable, Sendable, Equatable {
    public var device: PairedDevice
    public var token: String
    public var routes: MacRoutes?
}

/// `DeviceList`.
public struct DeviceList: Codable, Sendable, Equatable {
    public var items: [PairedDevice]
}

extension APIClient {
    /// `POST /api/pairing/codes` (only from the Mac itself): a new code and QR secret.
    public func createPairingCode() async throws(StudioAPIError) -> PairingCode {
        try await send(PairingCode.self, .post, "/api/pairing/codes")
    }

    /// `POST /api/pairing/claim` (public, rate-limited).
    public func claimPairing(_ claim: PairingClaim) async throws(StudioAPIError) -> PairingResult {
        try await send(PairingResult.self, .post, "/api/pairing/claim", body: claim)
    }

    /// `GET /api/pairing/routes`: where phones can reach this Mac.
    public func macRoutes() async throws(StudioAPIError) -> MacRoutes {
        try await get(MacRoutes.self, "/api/pairing/routes")
    }

    /// `PUT /api/pairing/routes` (only from the Mac itself).
    @discardableResult
    public func publishMacRoutes(_ routes: MacRoutes) async throws(StudioAPIError) -> MacRoutes {
        try await send(MacRoutes.self, .put, "/api/pairing/routes", body: routes.input)
    }

    /// `GET /api/devices` (only from the Mac itself).
    public func devices() async throws(StudioAPIError) -> [PairedDevice] {
        try await get(DeviceList.self, "/api/devices").items
    }

    /// `POST /api/devices/{id}/revoke` (only from the Mac itself).
    @discardableResult
    public func revokeDevice(_ id: EntityID) async throws(StudioAPIError) -> PairedDevice {
        try await send(PairedDevice.self, .post, "/api/devices/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/revoke")
    }
}
