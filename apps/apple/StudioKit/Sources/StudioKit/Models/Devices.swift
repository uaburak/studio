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

/// `PairingCode`: shown on the Mac, valid two minutes, single use.
public struct PairingCode: Codable, Sendable, Equatable {
    public var code: String
    public var expiresAt: Date
}

/// `PairingClaim`: what the phone sends.
public struct PairingClaim: Codable, Sendable, Equatable {
    public var code: String
    public var deviceName: String
    public var platform: DevicePlatform

    public init(code: String, deviceName: String, platform: DevicePlatform = .current) {
        self.code = code
        self.deviceName = deviceName
        self.platform = platform
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

/// `PairingResult`: the device and its token (shown only once).
public struct PairingResult: Codable, Sendable, Equatable {
    public var device: PairedDevice
    public var token: String
}

/// `DeviceList`.
public struct DeviceList: Codable, Sendable, Equatable {
    public var items: [PairedDevice]
}

extension APIClient {
    /// `POST /api/pairing/codes` (only from the Mac itself).
    public func createPairingCode() async throws(StudioAPIError) -> PairingCode {
        try await send(PairingCode.self, .post, "/api/pairing/codes")
    }

    /// `POST /api/pairing/claim` (public, rate-limited).
    public func claimPairing(_ claim: PairingClaim) async throws(StudioAPIError) -> PairingResult {
        try await send(PairingResult.self, .post, "/api/pairing/claim", body: claim)
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
