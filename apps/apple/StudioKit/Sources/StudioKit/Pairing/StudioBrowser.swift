import Foundation
import Network
import Synchronization

/// A Mac running Studio, found on the local network with Bonjour.
public struct DiscoveredStudio: Sendable, Hashable, Identifiable {
    /// Bonjour service name (unique on the network).
    public var serviceName: String
    /// TXT `name`: the Mac's name for display.
    public var displayName: String
    /// TXT `api`: LAN API version (see `StudioBrowser.supportedAPIVersion`).
    public var apiVersion: String?
    /// TXT `pairing`: "required" when a device token is needed.
    public var pairingRequired: Bool
    /// TXT `id`: the Mac host id (`HealthResponse.instance`), when advertised.
    public var macId: String?
    public var endpoint: NWEndpoint
    /// `http://<ipv4>:<port>` candidates from TXT `addr` / `port` (fallback when resolving fails).
    public var advertisedURLs: [URL]

    public var id: String { serviceName }

    public var isSupported: Bool { apiVersion == StudioBrowser.supportedAPIVersion }

    /// Whether this result is the paired Mac: the same host id when both are known, else the same name.
    public func matches(macId: String?, names: [String]) -> Bool {
        if let macId, let own = self.macId { return macId == own }
        return names.contains { !$0.isEmpty && ($0 == displayName || $0 == serviceName) }
    }

    /// Build from a Bonjour TXT record (missing keys fall back to safe values).
    public init(serviceName: String, txt: [String: String], endpoint: NWEndpoint) {
        self.serviceName = serviceName
        displayName = txt["name"].flatMap { $0.isEmpty ? nil : $0 } ?? serviceName
        apiVersion = txt["api"]
        pairingRequired = txt["pairing"] != "none"
        macId = txt["id"].flatMap { $0.isEmpty ? nil : $0 }
        self.endpoint = endpoint
        if let port = txt["port"].flatMap(Int.init), (1...65535).contains(port) {
            advertisedURLs = (txt["addr"] ?? "").split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && IPv4Address($0) != nil }
                .compactMap { URL(string: "http://\($0):\(port)") }
        } else {
            advertisedURLs = []
        }
    }
}

/// Browses `_studio._tcp` (advertised by the Mac app) and resolves a result to
/// an `http://host:port` base URL for `PairingClient` / `APIClient`.
/// Needs `NSLocalNetworkUsageDescription` and `NSBonjourServices` in Info.plist.
public final class StudioBrowser: Sendable {
    public static let serviceType = "_studio._tcp"
    public static let supportedAPIVersion = "1"

    private let browser: NWBrowser

    public init() {
        browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: .tcp)
    }

    /// Current results on every change. Stops browsing when the stream ends.
    public func results() -> AsyncStream<[DiscoveredStudio]> {
        let browser = self.browser
        return AsyncStream { continuation in
            browser.browseResultsChangedHandler = { results, _ in
                continuation.yield(results.compactMap(Self.discovered).sorted { $0.displayName < $1.displayName })
            }
            browser.stateUpdateHandler = { state in
                if case .failed = state { continuation.finish() }
            }
            continuation.onTermination = { _ in browser.cancel() }
            browser.start(queue: .global(qos: .userInitiated))
        }
    }

    static func discovered(_ result: NWBrowser.Result) -> DiscoveredStudio? {
        guard case .service(let name, _, _, _) = result.endpoint else { return nil }
        var txt: [String: String] = [:]
        if case .bonjour(let record) = result.metadata { txt = record.dictionary }
        return DiscoveredStudio(serviceName: name, txt: txt, endpoint: result.endpoint)
    }

    /// Best address for a discovered Mac: resolve the Bonjour endpoint, and if that
    /// fails try the addresses the Mac advertised in its TXT record (first one whose
    /// `/api/health` answers). Never falls back to localhost.
    public static func resolve(_ studio: DiscoveredStudio, session: URLSession = .shared) async throws(StudioAPIError) -> URL {
        var lastError: StudioAPIError = .unexpectedResponse("Mac'in adresi çözümlenemedi")
        do {
            return try await resolve(studio.endpoint)
        } catch {
            lastError = error
        }
        for url in studio.advertisedURLs where await isReachable(url, session: session) {
            return url
        }
        throw lastError
    }

    /// Look for the paired Mac on this network for up to `timeout` and return the addresses to
    /// try: the resolved Bonjour endpoint first, then the addresses its TXT record lists.
    /// Empty when it is not found (other network, Studio closed, no local network permission).
    public static func locate(macId: String?, names: [String], timeout: Duration = .seconds(3)) async -> [URL] {
        let browser = StudioBrowser()
        let found: DiscoveredStudio? = await withTaskGroup(of: DiscoveredStudio?.self) { group in
            group.addTask {
                for await list in browser.results() {
                    if let match = list.first(where: { $0.matches(macId: macId, names: names) }) { return match }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        guard let found else { return [] }
        var urls: [URL] = []
        if let resolved = try? await resolve(found.endpoint, timeout: timeout) { urls.append(resolved) }
        for url in found.advertisedURLs where !urls.contains(url) { urls.append(url) }
        return urls
    }

    /// True when `<url>/api/health` answers 200 within a few seconds.
    public static func isReachable(_ url: URL, session: URLSession = .shared) async -> Bool {
        var request = URLRequest(url: url.appending(path: "api/health"))
        request.timeoutInterval = 4
        guard let (_, response) = try? await session.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    /// Resolve a Bonjour endpoint to `http://<ipv4>:<port>` by opening (and
    /// closing) a TCP connection to it. `.waiting` (e.g. while iOS shows the local
    /// network permission prompt) is not a failure: keep waiting until `timeout`.
    public static func resolve(_ endpoint: NWEndpoint, timeout: Duration = .seconds(10)) async throws(StudioAPIError) -> URL {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: endpoint, using: parameters)
        let lastWaiting = LockedString()
        let result: Result<URL, StudioAPIError> = await withCheckedContinuation { continuation in
            let once = OnceFlag()
            @Sendable func finish(_ value: Result<URL, StudioAPIError>) {
                guard once.claim() else { return }
                connection.cancel()
                continuation.resume(returning: value)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port)? = connection.currentPath?.remoteEndpoint,
                       let url = baseURL(host: host, port: port) {
                        finish(.success(url))
                    } else {
                        finish(.failure(.unexpectedResponse("Mac'in adresi çözümlenemedi")))
                    }
                case .failed(let error):
                    finish(.failure(.transport(error.localizedDescription)))
                case .waiting(let error):
                    lastWaiting.set(error.localizedDescription)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
            Task {
                try? await Task.sleep(for: timeout)
                if let reason = lastWaiting.get() {
                    finish(.failure(.transport("Mac'e ulaşılamadı: \(reason). Ayarlar → Gizlilik → Yerel Ağ'da Studio'nun açık olduğundan emin ol.")))
                } else {
                    finish(.failure(.timedOut))
                }
            }
        }
        return try result.get()
    }

    static func baseURL(host: NWEndpoint.Host, port: NWEndpoint.Port) -> URL? {
        let hostString: String
        switch host {
        case .ipv4(let address): hostString = "\(address)"
        case .ipv6(let address):
            // Strip the zone (`%en0`): URL hosts cannot carry it unescaped.
            let raw = "\(address)"
            hostString = "[\(raw.split(separator: "%").first.map(String.init) ?? raw)]"
        case .name(let name, _): hostString = name
        @unknown default: return nil
        }
        return URL(string: "http://\(hostString):\(port.rawValue)")
    }
}

/// Thread-safe "first caller wins".
private final class OnceFlag: Sendable {
    private let done = Synchronization.Mutex(false)
    func claim() -> Bool {
        done.withLock { value in
            if value { return false }
            value = true
            return true
        }
    }
}

/// Thread-safe optional string.
private final class LockedString: Sendable {
    private let value = Synchronization.Mutex<String?>(nil)
    func set(_ new: String) { value.withLock { $0 = new } }
    func get() -> String? { value.withLock { $0 } }
}
