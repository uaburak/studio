import Foundation

/// Phone side of pairing: trade the QR code's secret (or the 6-digit code typed by hand) for
/// a device token, keep it with the Mac's routes in the Keychain, and build an `APIClient`
/// that sends it. The Mac app itself never pairs: it talks to 127.0.0.1.
///
/// ```swift
/// let pairing = PairingClient(store: KeychainDeviceTokenStore())
/// let invite = try PairingInvite.parse(scannedText)
/// let device = try await pairing.pair(invite: invite, deviceName: "iPhone")
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

    /// Pair with the Mac whose QR code (or `studio://pair` link) was read: find an address
    /// in it that answers (LAN first, then the tunnel), claim with the one-time secret and
    /// save the token with the Mac's routes. An earlier pairing of this phone is replaced
    /// (the Mac retires the old device).
    @discardableResult
    public func pair(
        invite: PairingInvite, deviceName: String, platform: DevicePlatform = .current,
        connector: MacConnector? = nil, now: Date = .now
    ) async throws(StudioAPIError) -> PairedDevice {
        if invite.isExpired(at: now) {
            throw .invalidConfiguration(PairingInviteError.expired.errorDescription ?? "")
        }
        let name = try Self.cleanDeviceName(deviceName)
        let connector = connector ?? MacConnector(probe: MacConnector.healthProbe(session: session))
        let candidates = MacRoutePlanner.candidates(routes: invite.routes)
        guard let route = await connector.firstReachable(candidates, macId: invite.macId) else {
            throw .invalidConfiguration(Self.notFoundMessage(hasTunnel: invite.tunnelURL != nil))
        }
        let claim = PairingClaim(secret: invite.secret, deviceName: name, platform: platform, replacesToken: credential()?.token)
        let result = try await claimed(claim, at: route.url)
        let routes = result.routes ?? invite.routes
        try save(DeviceCredential(
            token: result.token, deviceId: result.device.id, serverURL: route.url,
            serverName: routes.macName, macId: routes.macId ?? invite.macId, routes: routes))
        return result.device
    }

    /// Claim `code` (typed by hand) on the Mac at `baseURL`; saves the token on success.
    @discardableResult
    public func pair(baseURL: URL, serverName: String, code: String, deviceName: String,
                     platform: DevicePlatform = .current) async throws(StudioAPIError) -> PairedDevice {
        let digits = code.filter(\.isNumber)
        guard digits.count == 6 else { throw .invalidConfiguration("Kod 6 haneli olmalı.") }
        let name = try Self.cleanDeviceName(deviceName)
        let claim = PairingClaim(code: digits, deviceName: name, platform: platform, replacesToken: credential()?.token)
        let result = try await claimed(claim, at: baseURL)
        try save(DeviceCredential(
            token: result.token, deviceId: result.device.id, serverURL: baseURL,
            serverName: result.routes?.macName ?? serverName, macId: result.routes?.macId, routes: result.routes))
        return result.device
    }

    private func claimed(_ claim: PairingClaim, at url: URL) async throws(StudioAPIError) -> PairingResult {
        let api = APIClient(baseURL: url, auth: NoAuth(), session: session)
        do {
            return try await api.claimPairing(claim)
        } catch let error where error.code == .unauthorized {
            throw .invalidConfiguration(claim.secret != nil
                ? "Bu kod kullanılmış ya da süresi dolmuş. Mac'te yeni kodu okut."
                : "Kod yanlış ya da süresi dolmuş. Mac'teki güncel kodu gir.")
        }
    }

    private func save(_ credential: DeviceCredential) throws(StudioAPIError) {
        do {
            try store.save(credential)
        } catch {
            throw .invalidConfiguration("Anahtar zincirine yazılamadı: \(error.localizedDescription)")
        }
    }

    static func cleanDeviceName(_ raw: String) throws(StudioAPIError) -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw .invalidConfiguration("Cihaz adı boş olamaz.") }
        return String(name.prefix(80))
    }

    static func notFoundMessage(hasTunnel: Bool) -> String {
        hasTunnel
            ? "Mac'e ulaşılamadı. Mac'te Studio açık mı?"
            : "Mac'e ulaşılamadı. iPhone ile Mac aynı Wi-Fi ağında olmalı."
    }

    /// Remember the address that answered (Bonjour found the Mac elsewhere, or the tunnel).
    public func updateServerURL(_ url: URL) throws {
        guard var credential = try store.load(), credential.serverURL != url else { return }
        credential.serverURL = url
        try store.save(credential)
    }

    /// Save the routes the Mac sent after a connect (new LAN address, tunnel turned on).
    public func updateRoutes(_ routes: MacRoutes) throws {
        guard var credential = try store.load() else { return }
        var incoming = routes
        incoming.updatedAt = nil // compared without the server's timestamp
        var saved = credential.routes
        saved?.updatedAt = nil
        guard saved != incoming || credential.serverName != routes.macName || (routes.macId != nil && credential.macId != routes.macId) else { return }
        credential.routes = routes
        credential.serverName = routes.macName
        if let macId = routes.macId { credential.macId = macId }
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
