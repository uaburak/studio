import Foundation
import Security

/// Adds authentication headers to every request (HTTP and WebSocket upgrade).
/// The iPhone sends its paired-device token (`DeviceTokenAuth`, DeviceAuth.swift).
public protocol AuthProvider: Sendable {
    func headers() async throws -> [String: String]
}

/// No authentication (local development).
public struct NoAuth: AuthProvider {
    public init() {}
    public func headers() async throws -> [String: String] { [:] }
}

public struct KeychainError: Error, Equatable, LocalizedError {
    public var status: OSStatus

    public init(status: OSStatus) { self.status = status }

    public var errorDescription: String? {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return "Anahtar zinciri hatası: \(message)"
    }
}
