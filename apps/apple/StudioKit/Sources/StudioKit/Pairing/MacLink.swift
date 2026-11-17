import Foundation
import Synchronization

// How a paired phone finds its Mac, silently, wherever both are:
//
//   1. the Mac's Bonjour service, resolved on the spot (same Wi-Fi, address may be new),
//   2. the address that answered last time and the Mac's LAN addresses (from the QR code,
//      refreshed after each connect),
//   3. the Remote Control tunnel (away from home), started a moment later so a Mac on the
//      same Wi-Fi wins.
//
// Every address is checked with `GET /api/health`; one that answers with another Mac's id is
// skipped (an old address now used by another computer). The first that answers is used.

/// One way to reach the Mac.
public struct MacRoute: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable {
        /// Found with Bonjour just now.
        case bonjour
        /// The address that answered last time.
        case lastKnown
        /// A LAN address the Mac published.
        case lan
        /// The Remote Control tunnel the Mac published.
        case tunnel
        /// An address typed under Gelişmiş.
        case manual
    }

    public var kind: Kind
    public var url: URL

    public init(_ kind: Kind, _ url: URL) {
        self.kind = kind
        self.url = url
    }

    /// Reached over the internet (tried after the local ones).
    public var isRemote: Bool {
        switch kind {
        case .tunnel, .manual: true
        case .bonjour, .lan: false
        case .lastKnown: MacRoutePlanner.isRemote(url)
        }
    }
}

/// Orders the addresses to try (pure; tested).
public enum MacRoutePlanner {
    /// Bonjour first, then the last answering address and the LAN addresses, then the tunnel and
    /// a manual address. Duplicates are dropped (first one wins); a last-known tunnel address
    /// keeps its place among the remote ones.
    public static func candidates(
        bonjour: [URL] = [], lastKnown: URL? = nil, routes: MacRoutes? = nil, manual: URL? = nil
    ) -> [MacRoute] {
        var local: [MacRoute] = bonjour.map { MacRoute(.bonjour, $0) }
        var remote: [MacRoute] = []
        if let lastKnown {
            let route = MacRoute(.lastKnown, lastKnown)
            if route.isRemote { remote.append(route) } else { local.append(route) }
        }
        local += (routes?.lanURLs ?? []).map { MacRoute(.lan, $0) }
        if let tunnel = routes?.tunnelUrl { remote.append(MacRoute(.tunnel, tunnel)) }
        if let manual { remote.append(MacRoute(.manual, manual)) }

        var seen = Set<String>()
        return (local + remote).filter { seen.insert(key($0.url)).inserted }
    }

    /// Not a private / link-local / `.local` address: reached over the internet.
    public static func isRemote(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        if host.hasSuffix(".local") || host == "localhost" { return false }
        if IPv4Text.isValid(host) {
            let octets = host.split(separator: ".").compactMap { Int($0) }
            switch (octets[0], octets[1]) {
            case (10, _), (127, _), (169, 254), (192, 168): return false
            case (172, let b) where (16...31).contains(b): return false
            case (100, let b) where (64...127).contains(b): return false // CGNAT / Tailscale
            default: return true
            }
        }
        if host.contains(":") { return !(host.hasPrefix("fe80") || host.hasPrefix("fd") || host.hasPrefix("fc") || host == "::1") }
        return url.scheme?.lowercased() == "https"
    }

    static func key(_ url: URL) -> String {
        var text = url.absoluteString.lowercased()
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }
}

/// Tries addresses and returns the first one where the paired Mac answers.
public struct MacConnector: Sendable {
    public enum ProbeResult: Sendable, Equatable {
        /// `/api/health` answered; `instance` is the host id it reported (nil when started by hand).
        case reachable(instance: String?)
        case unreachable
    }

    public typealias Probe = @Sendable (_ url: URL, _ timeout: Duration) async -> ProbeResult

    public var probe: Probe
    /// Per-address limit for LAN / Bonjour addresses.
    public var localTimeout: Duration
    /// Per-address limit for the tunnel (Cloudflare is slower to answer).
    public var remoteTimeout: Duration
    /// Remote addresses wait until every local one failed, at most this long.
    public var remoteHeadStart: Duration
    public var sleep: @Sendable (Duration) async throws -> Void

    public init(
        probe: @escaping Probe = MacConnector.healthProbe(session: .shared),
        localTimeout: Duration = .seconds(3),
        remoteTimeout: Duration = .seconds(8),
        remoteHeadStart: Duration = .milliseconds(1500),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.probe = probe
        self.localTimeout = localTimeout
        self.remoteTimeout = remoteTimeout
        self.remoteHeadStart = remoteHeadStart
        self.sleep = sleep
    }

    /// The first candidate where this Mac (`macId`, when known) answers; nil when none does.
    /// Local candidates run in parallel at once; remote ones after `remoteHeadStart` or as soon
    /// as every local one failed. `extraLocal` may add addresses found while this runs
    /// (Bonjour); it counts as one more local attempt.
    public func firstReachable(
        _ candidates: [MacRoute], macId: String?,
        extraLocal: (@Sendable () async -> [MacRoute])? = nil
    ) async -> MacRoute? {
        let local = candidates.filter { !$0.isRemote }
        let remote = candidates.filter(\.isRemote)
        let pendingLocal = Mutex(local.count + (extraLocal == nil ? 0 : 1))
        let probe = self.probe
        let localTimeout = self.localTimeout
        let remoteTimeout = self.remoteTimeout
        let headStart = self.remoteHeadStart
        let sleep = self.sleep

        @Sendable func check(_ route: MacRoute, timeout: Duration) async -> MacRoute? {
            switch await probe(route.url, timeout) {
            case .reachable(let instance):
                if let macId, let instance, macId != instance { return nil }
                return route
            case .unreachable:
                return nil
            }
        }

        return await withTaskGroup(of: MacRoute?.self) { group in
            for route in local {
                group.addTask {
                    defer { pendingLocal.withLock { $0 -= 1 } }
                    return await check(route, timeout: localTimeout)
                }
            }
            if let extraLocal {
                group.addTask {
                    defer { pendingLocal.withLock { $0 -= 1 } }
                    let found = await extraLocal()
                    return await withTaskGroup(of: MacRoute?.self) { inner in
                        for route in found { inner.addTask { await check(route, timeout: localTimeout) } }
                        for await result in inner where result != nil {
                            inner.cancelAll()
                            return result
                        }
                        return nil
                    }
                }
            }
            for route in remote {
                group.addTask {
                    // Wait for the local tries (in small steps, so cancellation stops it quickly).
                    let step = Duration.milliseconds(50)
                    var waited = Duration.zero
                    while waited < headStart, pendingLocal.withLock({ $0 > 0 }) {
                        do { try await sleep(step) } catch { return nil }
                        waited += step
                    }
                    if Task.isCancelled { return nil }
                    return await check(route, timeout: remoteTimeout)
                }
            }
            for await result in group {
                if let result {
                    group.cancelAll()
                    return result
                }
            }
            return nil
        }
    }

    /// `GET <url>/api/health` within `timeout`: 200 with Studio's health body.
    public static func healthProbe(session: URLSession) -> Probe {
        { url, timeout in
            var request = URLRequest(url: url.appending(path: "api/health"))
            request.timeoutInterval = max(1, timeout.seconds)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            guard let (data, response) = try? await session.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let health = try? StudioJSON.decoder().decode(HealthResponse.self, from: data),
                  health.service == "studio-api" else { return .unreachable }
            return .reachable(instance: health.instance)
        }
    }
}

// MARK: - What the connection UI says

/// Why the phone is not talking to its Mac right now.
public enum MacLinkFailure: Sendable, Equatable {
    /// No address answered (Mac asleep, Studio closed, other network without a tunnel).
    case notFound
    /// The Mac does not accept this phone's key any more (removed on the Mac, or reinstalled).
    case notRecognized
    /// Anything else, with a short Turkish explanation.
    case other(String)
}

/// What the connection manager is doing.
public enum MacLinkPhase: Sendable, Equatable {
    /// Nothing tried yet.
    case idle
    /// Trying addresses (also while retrying after a failure).
    case searching
    case connected(MacRoute)
    case failed(MacLinkFailure)
}

/// The only four things the connection UI says.
public enum MacLinkState: Sendable, Equatable {
    /// "Mac'e bağlı".
    case connected
    /// "Mac'e bağlanıyor…".
    case connecting
    /// "Mac'e ulaşılamıyor" with one short reason and one action.
    case unreachable(reason: String, action: MacLinkAction)
    /// "Bağlı değil" + "iPhone'u bağla".
    case notPaired

    public var title: String {
        switch self {
        case .connected: "Mac'e bağlı"
        case .connecting: "Mac'e bağlanıyor…"
        case .unreachable: "Mac'e ulaşılamıyor"
        case .notPaired: "Bağlı değil"
        }
    }

    /// The one-line reason under the title (unreachable only).
    public var reason: String? {
        if case .unreachable(let reason, _) = self { return reason }
        return nil
    }

    /// The button offered with the state (nil while connected or connecting).
    public var action: MacLinkAction? {
        switch self {
        case .connected, .connecting: nil
        case .unreachable(_, let action): action
        case .notPaired: .pair
        }
    }

    public var isConnected: Bool { self == .connected }

    /// Map what the phone knows to one of the four states.
    public static func make(isPaired: Bool, phase: MacLinkPhase) -> MacLinkState {
        guard isPaired else { return .notPaired }
        switch phase {
        case .idle, .searching: return .connecting
        case .connected: return .connected
        case .failed(.notFound):
            return .unreachable(reason: "Mac kapalı, uykuda ya da başka bir ağda olabilir.", action: .retry)
        case .failed(.notRecognized):
            return .unreachable(reason: "Mac bu iPhone'u artık tanımıyor.", action: .repair)
        case .failed(.other(let reason)):
            return .unreachable(reason: reason, action: .retry)
        }
    }

    /// The failure a request error means (nil: not a connection problem).
    public static func failure(for error: StudioAPIError) -> MacLinkFailure? {
        switch error {
        case .unauthorized(let status) where status == 401: return .notRecognized
        case .server(let status, _, _, _) where status == 401: return .notRecognized
        case .offline, .timedOut, .transport: return .notFound
        default: return nil
        }
    }
}

/// The single button next to a connection state.
public enum MacLinkAction: Sendable, Equatable {
    /// "Tekrar dene": search again now.
    case retry
    /// "Yeniden bağla": scan the Mac's QR code again.
    case repair
    /// "iPhone'u bağla": first pairing.
    case pair

    public var title: String {
        switch self {
        case .retry: "Tekrar dene"
        case .repair: "Yeniden bağla"
        case .pair: "iPhone'u bağla"
        }
    }
}
