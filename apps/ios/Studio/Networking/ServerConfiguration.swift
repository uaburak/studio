import Foundation

/// Where the API lives. The default reaches `pnpm --filter @studio/api dev`
/// from the iOS Simulator (the simulator shares the Mac's loopback).
struct ServerConfiguration: Sendable, Equatable {
    var baseURL: URL

    static let defaultBaseURL = URL(string: "http://127.0.0.1:8787")!
    static let `default` = ServerConfiguration(baseURL: defaultBaseURL)

    /// `http(s)://host[:port][/prefix]` → URL without a trailing slash.
    static func parseBaseURL(_ text: String) -> Result<URL, APIError> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.invalidConfiguration("Sunucu adresi boş.")) }
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty
        else {
            return .failure(.invalidConfiguration("Adres http:// ya da https:// ile başlamalı, ör. http://127.0.0.1:8787"))
        }
        guard components.query == nil, components.fragment == nil else {
            return .failure(.invalidConfiguration("Adres sorgu (?) ya da # içermemeli."))
        }
        components.scheme = scheme
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else {
            return .failure(.invalidConfiguration("Adres okunamadı."))
        }
        return .success(url)
    }

    /// HTTP URL for an API path such as `/api/brands`.
    func url(path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = components.percentEncodedPath + path
        let items = query.filter { $0.value != nil }
        components.queryItems = items.isEmpty ? nil : items
        return components.url!
    }

    /// WebSocket URL (`ws`/`wss`) for an API path.
    func webSocketURL(path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: url(path: path, query: query), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url!
    }

    /// True for loopback / LAN hosts where plain http is acceptable.
    var isLocal: Bool {
        guard let host = baseURL.host()?.lowercased() else { return false }
        if host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local") { return true }
        return host.hasPrefix("10.") || host.hasPrefix("192.168.") || host.hasPrefix("172.")
    }
}

/// Cloudflare Access service token (PLAN.md §4: "iOS ve worker için servis token'ı").
/// Stored in the Keychain; sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
struct AccessCredentials: Codable, Sendable, Equatable {
    var clientId: String
    var clientSecret: String

    var isComplete: Bool {
        !clientId.trimmingCharacters(in: .whitespaces).isEmpty
            && !clientSecret.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

/// Seam for authentication. Every HTTP request and the WebSocket upgrade get
/// these headers. Today: the Access service token when one is saved; later a
/// different scheme can be swapped in without touching the client.
protocol RequestAuthorizing: Sendable {
    func authorizationHeaders() async -> [String: String]
}

struct AccessServiceTokenAuthorizer: RequestAuthorizing {
    var credentials: AccessCredentials?

    func authorizationHeaders() async -> [String: String] {
        guard let credentials, credentials.isComplete else { return [:] }
        return [
            "CF-Access-Client-Id": credentials.clientId,
            "CF-Access-Client-Secret": credentials.clientSecret,
        ]
    }
}
