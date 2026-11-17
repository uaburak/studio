import Foundation

/// What the Mac's "iPhone'u bağla" QR code holds: who the Mac is, a one-time pairing secret
/// and every way the phone may reach it. Written as a link, so the system Camera app can
/// open Studio with it too:
///
///     studio://pair?v=1&n=<Mac name>&s=<secret>&e=<expiry, Unix s>&i=<Mac id>
///                  &a=<IPv4,IPv4>&p=<LAN port>&b=<Bonjour name>&t=<tunnel URL>
///
/// `v`, `n`, `s`, `e` are required; the rest are left out when unknown (`b` also when it
/// equals `n`). The secret is single use and expires (`PAIRING_SECRET_TTL_MS`, ten
/// minutes); the Mac enforces both, the phone refuses an expired link before asking.
public struct PairingInvite: Sendable, Equatable {
    public static let scheme = "studio"
    public static let host = "pair"
    public static let version = 1

    public var macName: String
    /// One-time secret for `POST /api/pairing/claim`. Never shown or logged.
    public var secret: String
    public var expiresAt: Date
    /// Host id (`HealthResponse.instance`), to tell this Mac from another one at the same address.
    public var macId: String?
    public var lanAddresses: [String]
    public var lanPort: Int?
    public var bonjourName: String?
    public var tunnelURL: URL?

    public init(
        macName: String, secret: String, expiresAt: Date, macId: String? = nil,
        lanAddresses: [String] = [], lanPort: Int? = nil, bonjourName: String? = nil, tunnelURL: URL? = nil
    ) {
        self.macName = macName
        self.secret = secret
        // The link carries whole seconds; keep the value equal to what a round trip gives.
        self.expiresAt = Date(timeIntervalSince1970: expiresAt.timeIntervalSince1970.rounded(.down))
        self.macId = macId
        self.lanAddresses = lanAddresses
        self.lanPort = lanPort
        // Bonjour advertises the Mac under its own name unless told otherwise.
        self.bonjourName = bonjourName ?? macName
        self.tunnelURL = tunnelURL
    }

    /// The invite for a fresh pairing offer (`POST /api/pairing/codes`) and the Mac's routes.
    public init?(offer: PairingCode, routes: MacRoutes) {
        guard let secret = offer.secret, let expiresAt = offer.secretExpiresAt else { return nil }
        self.init(
            macName: routes.macName, secret: secret, expiresAt: expiresAt, macId: routes.macId,
            lanAddresses: routes.lanAddresses, lanPort: routes.lanPort,
            bonjourName: routes.bonjourName, tunnelURL: routes.tunnelUrl)
    }

    /// The routes the invite describes (what the phone saves after pairing).
    public var routes: MacRoutes {
        MacRoutes(
            macName: macName, macId: macId, lanAddresses: lanAddresses, lanPort: lanPort,
            bonjourName: bonjourName, tunnelUrl: tunnelURL)
    }

    public func isExpired(at now: Date = .now) -> Bool { now >= expiresAt }

    // MARK: Link

    /// `studio://pair?...` (the QR code's text).
    public var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = Self.host
        var items = [
            URLQueryItem(name: "v", value: String(Self.version)),
            URLQueryItem(name: "n", value: macName),
            URLQueryItem(name: "s", value: secret),
            URLQueryItem(name: "e", value: String(Int64(expiresAt.timeIntervalSince1970))),
        ]
        if let macId { items.append(URLQueryItem(name: "i", value: macId)) }
        let addresses = lanAddresses.filter(IPv4Text.isValid)
        if !addresses.isEmpty { items.append(URLQueryItem(name: "a", value: addresses.joined(separator: ","))) }
        if let lanPort { items.append(URLQueryItem(name: "p", value: String(lanPort))) }
        if let bonjourName, bonjourName != macName { items.append(URLQueryItem(name: "b", value: bonjourName)) }
        if let tunnelURL { items.append(URLQueryItem(name: "t", value: tunnelURL.absoluteString)) }
        components.queryItems = items
        // `+` would read as a space in some decoders; percent-encode it (and `&`, `=` are already).
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url!
    }

    /// True for links meant for this parser (`studio://pair...`), valid or not.
    public static func isPairingLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host()?.lowercased() == host
    }

    /// Read a scanned QR text or an opened link.
    public static func parse(_ text: String) throws(PairingInviteError) -> PairingInvite {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw .notStudioLink }
        return try parse(url)
    }

    public static func parse(_ url: URL) throws(PairingInviteError) -> PairingInvite {
        guard isPairingLink(url), let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw .notStudioLink
        }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] where values[item.name] == nil {
            values[item.name] = item.value ?? ""
        }
        guard let version = values["v"].flatMap(Int.init) else { throw .missingField("v") }
        guard version == Self.version else { throw .unsupportedVersion(version) }
        guard let name = values["n"]?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { throw .missingField("n") }
        guard let secret = values["s"], !secret.isEmpty else { throw .missingField("s") }
        guard secret.count >= 32, secret.count <= 128,
              secret.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" }) else {
            throw .invalidField("s")
        }
        guard let expiryText = values["e"] else { throw .missingField("e") }
        guard let expiry = Int64(expiryText) else { throw .invalidField("e") }

        var port: Int?
        if let text = values["p"] {
            guard let value = Int(text), (1...65535).contains(value) else { throw .invalidField("p") }
            port = value
        }
        var tunnel: URL?
        if let text = values["t"], !text.isEmpty {
            guard let value = URL(string: text), value.scheme?.lowercased() == "https", value.host() != nil else { throw .invalidField("t") }
            tunnel = value
        }
        let addresses = (values["a"] ?? "").split(separator: ",").map(String.init).filter(IPv4Text.isValid)
        let bonjour = values["b"].flatMap { $0.isEmpty ? nil : $0 } ?? name
        return PairingInvite(
            macName: name, secret: secret, expiresAt: Date(timeIntervalSince1970: TimeInterval(expiry)),
            macId: values["i"].flatMap { $0.isEmpty ? nil : $0 }, lanAddresses: addresses, lanPort: port,
            bonjourName: bonjour, tunnelURL: tunnel)
    }
}

/// Why a scanned code or opened link is not a usable pairing invite.
public enum PairingInviteError: Error, Equatable, Sendable, LocalizedError {
    /// Some other QR code or link.
    case notStudioLink
    /// Made by a newer Studio on the Mac.
    case unsupportedVersion(Int)
    case missingField(String)
    case invalidField(String)
    /// The ten minutes are over.
    case expired

    public var errorDescription: String? {
        switch self {
        case .notStudioLink: "Bu bir Studio bağlantı kodu değil. Mac'te Ayarlar → Cihazlar'daki kodu okut."
        case .unsupportedVersion: "Bu kod daha yeni bir Studio'dan geliyor. iPhone'daki Studio'yu güncelle."
        case .missingField, .invalidField: "Kod okunamadı. Mac'teki kodu yeniden okut."
        case .expired: "Bu kodun süresi doldu. Mac'te yeni kod göründüğünde yeniden okut."
        }
    }
}
