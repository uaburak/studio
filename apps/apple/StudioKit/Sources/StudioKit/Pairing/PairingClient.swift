import Foundation

/// Phone side of pairing (task L1): trade the 6-digit code shown in the Mac
/// app for a device token, keep it in the Keychain, and build an `APIClient`
/// that sends it. The Mac app itself never pairs: it talks to 127.0.0.1.
///
/// ```swift
/// let pairing = PairingClient(store: KeychainDeviceTokenStore())
/// let device = try await pairing.pair(baseURL: url, serverName: studio.name, code: "123456", deviceName: "iPhone")
/// let api = pairing.client()   // nil until paired
/// ```
public struct PairingClient: Sendable {
    public var store: any DeviceTokenStore
    public var session: URLSession

    public init(store: any DeviceTokenStore, session: URLSession = .shared) {
        self.store = store
        self.session = session
    }

    /// The saved pairing, if any.
    public func credential() -> DeviceCredential? {
        try? store.load()
    }

    public var isPaired: Bool { credential() != nil }

    /// Claim `code` on the Mac at `baseURL`; saves the token on success.
    @discardableResult
    public func pair(baseURL: URL, serverName: String, code: String, deviceName: String,
                     platform: DevicePlatform = .current) async throws(StudioAPIError) -> PairedDevice {
        let digits = code.filter(\.isNumber)
        guard digits.count == 6 else { throw .invalidConfiguration("Eşleştirme kodu 6 haneli olmalı.") }
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw .invalidConfiguration("Cihaz adı boş olamaz.") }
        let api = APIClient(baseURL: baseURL, auth: NoAuth(), session: session)
        let result = try await api.claimPairing(PairingClaim(code: digits, deviceName: name, platform: platform))
        do {
            try store.save(DeviceCredential(token: result.token, deviceId: result.device.id, serverURL: baseURL, serverName: serverName))
        } catch {
            throw .invalidConfiguration("Anahtar zincirine yazılamadı: \(error.localizedDescription)")
        }
        return result.device
    }

    /// Point the saved pairing at a new address (Bonjour found the Mac elsewhere).
    public func updateServerURL(_ url: URL) throws {
        guard var credential = try store.load() else { return }
        credential.serverURL = url
        try store.save(credential)
    }

    /// Forget the pairing on this device (the Mac revokes on its side).
    public func forget() throws {
        try store.delete()
    }

    /// API client for the paired Mac, or nil when not paired. `baseURL`
    /// overrides the saved address (e.g. a fresh Bonjour resolution).
    public func client(baseURL: URL? = nil) -> APIClient? {
        guard let credential = credential() else { return nil }
        return APIClient(baseURL: baseURL ?? credential.serverURL, auth: DeviceTokenAuth(store: store), session: session)
    }
}
