import Foundation
import Network
import Synchronization
import Testing
@testable import StudioKit

private let secret = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c"
private let device = #"{"id":"d2","name":"Test iPhone","platform":"ios","createdAt":"2026-11-16T10:00:00.000Z","lastSeenAt":null,"revokedAt":null}"#

private func health(_ instance: String?) -> Data {
    let id = instance.map { #","instance":"\#($0)""# } ?? ""
    return Data(#"{"status":"ok","service":"studio-api","version":"0.0.0","time":"2026-11-16T10:00:00.000Z","checks":{"db":"ok"}\#(id)}"#.utf8)
}

@Suite("QR pairing invite")
struct PairingInviteTests {
    private static let full = PairingInvite(
        macName: "Deniz’s MacBook Pro & Co + 2", secret: secret,
        expiresAt: Date(timeIntervalSince1970: 1_794_900_000), macId: "8f1c2a4e-0000-4000-8000-000000000001",
        lanAddresses: ["192.168.1.20", "10.0.0.5"], lanPort: 8791, bonjourName: "Deniz’s MacBook Pro (2)",
        tunnelURL: URL(string: "https://social.example.net"))

    @Test func roundTripsThroughTheLink() throws {
        let url = Self.full.url
        #expect(url.scheme == "studio")
        #expect(url.host() == "pair")
        #expect(PairingInvite.isPairingLink(url))
        #expect(try PairingInvite.parse(url) == Self.full)
        #expect(try PairingInvite.parse(url.absoluteString) == Self.full)
        #expect(try PairingInvite.parse("  \(url.absoluteString)\n") == Self.full)
        // Compact enough for a comfortable QR code.
        #expect(url.absoluteString.count < 400)
    }

    @Test func minimalInviteRoundTripsAndLeavesOutUnknownFields() throws {
        let minimal = PairingInvite(macName: "Mac", secret: secret, expiresAt: Date(timeIntervalSince1970: 1_794_900_000))
        let text = minimal.url.absoluteString
        for key in ["i=", "a=", "p=", "b=", "t="] { #expect(!text.contains("&\(key)")) }
        let parsed = try PairingInvite.parse(minimal.url)
        #expect(parsed.macName == "Mac")
        #expect(parsed.bonjourName == "Mac", "the Bonjour name defaults to the Mac's name")
        #expect(parsed.lanAddresses.isEmpty && parsed.lanPort == nil && parsed.tunnelURL == nil && parsed.macId == nil)
        // The Bonjour name is left out when it equals the Mac's name.
        var same = minimal
        same.bonjourName = "Mac"
        #expect(!same.url.absoluteString.contains("&b="))
    }

    @Test func roundsTheExpiryToWholeSeconds() throws {
        let invite = PairingInvite(macName: "Mac", secret: secret, expiresAt: Date(timeIntervalSince1970: 1_794_900_000.75))
        #expect(invite.expiresAt == Date(timeIntervalSince1970: 1_794_900_000))
        #expect(try PairingInvite.parse(invite.url).expiresAt == invite.expiresAt)
    }

    @Test func expires() {
        let invite = Self.full
        #expect(!invite.isExpired(at: invite.expiresAt.addingTimeInterval(-1)))
        #expect(invite.isExpired(at: invite.expiresAt))
        #expect(invite.isExpired(at: invite.expiresAt.addingTimeInterval(600)))
    }

    @Test func refusesOtherLinksAndBrokenFields() {
        func error(_ text: String) -> PairingInviteError? {
            do { _ = try PairingInvite.parse(text); return nil } catch { return error }
        }
        let good = Self.full.url.absoluteString
        #expect(error("https://example.com/pair?v=1") == .notStudioLink)
        #expect(error("studio://other?v=1") == .notStudioLink)
        #expect(error("hello") == .notStudioLink)
        #expect(error(good.replacingOccurrences(of: "v=1", with: "v=2")) == .unsupportedVersion(2))
        #expect(error("studio://pair?v=1&n=Mac&e=1") == .missingField("s"))
        #expect(error("studio://pair?v=1&s=\(secret)&e=1") == .missingField("n"))
        #expect(error("studio://pair?v=1&n=Mac&s=short&e=1") == .invalidField("s"))
        #expect(error("studio://pair?v=1&n=Mac&s=\(secret)") == .missingField("e"))
        #expect(error("studio://pair?v=1&n=Mac&s=\(secret)&e=1&p=99999") == .invalidField("p"))
        #expect(error("studio://pair?v=1&n=Mac&s=\(secret)&e=1&t=http://plain.example.net") == .invalidField("t"))
        // Junk addresses are dropped, not fatal.
        let parsed = try? PairingInvite.parse("studio://pair?v=1&n=Mac&s=\(secret)&e=1&a=1.2.3.4,999.1.1.1,fe80::1,abc&p=8791")
        #expect(parsed?.lanAddresses == ["1.2.3.4"])
        #expect(parsed?.routes.lanURLs.map(\.absoluteString) == ["http://1.2.3.4:8791"])
        #expect(PairingInviteError.expired.errorDescription?.contains("süresi") == true)
    }

    @Test func buildsFromAnOfferAndTheMacRoutes() throws {
        let routes = MacRoutes(macName: "Mac", macId: "m1", lanAddresses: ["192.168.1.2"], lanPort: 8791, bonjourName: "Mac", tunnelUrl: nil)
        let offer = PairingCode(code: "123456", expiresAt: .now, secret: secret, secretExpiresAt: Date(timeIntervalSince1970: 1_794_900_000))
        let invite = try #require(PairingInvite(offer: offer, routes: routes))
        #expect(invite.secret == secret)
        #expect(invite.macId == "m1")
        #expect(invite.routes.lanURLs.map(\.absoluteString) == ["http://192.168.1.2:8791"])
        #expect(PairingInvite(offer: PairingCode(code: "123456", expiresAt: .now), routes: routes) == nil, "an old server without QR secrets")
    }
}

@Suite("QR pairing client")
struct QRPairingClientTests {
    /// Answers health with `instance`, claims with a token and the Mac's routes.
    private static func macSession(host: String, instance: String = "mac-1", claim: @escaping @Sendable () -> StubURLProtocol.Response) -> URLSession {
        StubURLProtocol.session(host: host) { request, _ in
            switch request.url?.path {
            case "/api/health": return .init(status: 200, body: health(instance))
            case "/api/pairing/claim": return claim()
            default: return .init(status: 404, body: Data())
            }
        }
    }

    @Test func pairsThroughTheFirstAddressThatAnswersAndSavesTheRoutes() async throws {
        let host = uniqueHost()
        let token = "sdt_" + String(repeating: "b", count: 43)
        let routesJSON = #"{"macName":"Deniz's MacBook Pro","macId":"mac-1","lanAddresses":["192.0.2.1"],"lanPort":8791,"bonjourName":"Deniz's MacBook Pro","tunnelUrl":"https://\#(host)","updatedAt":"2026-11-16T10:00:00.000Z"}"#
        let session = Self.macSession(host: host) {
            .init(status: 201, body: Data(#"{"device":\#(device),"token":"\#(token)","routes":\#(routesJSON)}"#.utf8))
        }
        let store = InMemoryDeviceTokenStore(DeviceCredential(token: "old-token", deviceId: "d1", serverURL: URL(string: "http://10.0.0.9:8791")!, serverName: "Mac"))
        let pairing = PairingClient(store: store, session: session)
        // The LAN address (TEST-NET, no stub) does not answer; the tunnel does.
        let invite = PairingInvite(
            macName: "Deniz's MacBook Pro", secret: secret, expiresAt: .now.addingTimeInterval(600), macId: "mac-1",
            lanAddresses: ["192.0.2.1"], lanPort: 8791, tunnelURL: URL(string: "https://\(host)"))
        let connector = MacConnector(probe: MacConnector.healthProbe(session: session), remoteHeadStart: .milliseconds(100))

        let paired = try await pairing.pair(invite: invite, deviceName: " Test iPhone ", platform: .ios, connector: connector)
        #expect(paired.id == "d2")

        let saved = try #require(try store.load())
        #expect(saved.token == token)
        #expect(saved.deviceId == "d2")
        #expect(saved.serverURL.absoluteString == "https://\(host)")
        #expect(saved.serverName == "Deniz's MacBook Pro")
        #expect(saved.macId == "mac-1")
        #expect(saved.routes?.lanAddresses == ["192.0.2.1"])
        #expect(saved.routes?.tunnelUrl?.absoluteString == "https://\(host)")

        let claim = try #require(StubURLProtocol.recorded(host: host).first { $0.0.url?.path == "/api/pairing/claim" })
        let body = try #require(try JSONSerialization.jsonObject(with: claim.1) as? [String: String])
        #expect(body == ["secret": secret, "deviceName": "Test iPhone", "platform": "ios", "replacesToken": "old-token"])
        #expect(claim.0.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func aUsedCodeSaysSoInPlainWords() async throws {
        let host = uniqueHost()
        let session = Self.macSession(host: host) {
            .init(status: 401, body: Data(#"{"error":{"code":"unauthorized","message":"pairing code is wrong, expired or already used"}}"#.utf8))
        }
        let store = InMemoryDeviceTokenStore()
        let pairing = PairingClient(store: store, session: session)
        let invite = PairingInvite(macName: "Mac", secret: secret, expiresAt: .now.addingTimeInterval(600), tunnelURL: URL(string: "https://\(host)"))
        let connector = MacConnector(probe: MacConnector.healthProbe(session: session), remoteHeadStart: .zero)
        let error = await #expect(throws: StudioAPIError.self) {
            try await pairing.pair(invite: invite, deviceName: "x", connector: connector)
        }
        #expect(error?.errorDescription?.contains("kullanılmış") == true)
        #expect(try store.load() == nil)
    }

    @Test func refusesAnExpiredInviteWithoutAskingTheMac() async throws {
        let host = uniqueHost()
        let session = Self.macSession(host: host) { .init(status: 500, body: Data()) }
        let pairing = PairingClient(store: InMemoryDeviceTokenStore(), session: session)
        let invite = PairingInvite(macName: "Mac", secret: secret, expiresAt: Date(timeIntervalSince1970: 1_000), tunnelURL: URL(string: "https://\(host)"))
        let error = await #expect(throws: StudioAPIError.self) {
            try await pairing.pair(invite: invite, deviceName: "x")
        }
        #expect(error?.errorDescription?.contains("süresi doldu") == true)
        #expect(StubURLProtocol.recorded(host: host).isEmpty)
    }

    @Test func skipsAnAddressWhereAnotherMacAnswers() async throws {
        let host = uniqueHost()
        let session = Self.macSession(host: host, instance: "someone-else") { .init(status: 500, body: Data()) }
        let pairing = PairingClient(store: InMemoryDeviceTokenStore(), session: session)
        let invite = PairingInvite(macName: "Mac", secret: secret, expiresAt: .now.addingTimeInterval(600), macId: "mac-1", tunnelURL: URL(string: "https://\(host)"))
        let connector = MacConnector(probe: MacConnector.healthProbe(session: session), remoteHeadStart: .zero)
        let error = await #expect(throws: StudioAPIError.self) {
            try await pairing.pair(invite: invite, deviceName: "x", connector: connector)
        }
        #expect(error?.errorDescription?.contains("Mac'e ulaşılamadı") == true)
        #expect(!StubURLProtocol.recorded(host: host).contains { $0.0.url?.path == "/api/pairing/claim" })
    }

    @Test func keepsTheRoutesTheMacSendsLater() throws {
        let store = InMemoryDeviceTokenStore(DeviceCredential(token: "t", deviceId: "d1", serverURL: URL(string: "http://10.0.0.2:8791")!, serverName: "Old name"))
        let pairing = PairingClient(store: store)
        let routes = MacRoutes(macName: "New name", macId: "mac-9", lanAddresses: ["10.0.0.3"], lanPort: 8791, bonjourName: "New name", tunnelUrl: nil, updatedAt: .now)
        try pairing.updateRoutes(routes)
        try pairing.updateServerURL(URL(string: "http://10.0.0.3:8791")!)
        let saved = try #require(try store.load())
        #expect(saved.routes == routes)
        #expect(saved.serverName == "New name")
        #expect(saved.macId == "mac-9")
        #expect(saved.serverURL.absoluteString == "http://10.0.0.3:8791")
        #expect(saved.token == "t")
    }

    @Test func oldKeychainItemsStillDecode() throws {
        let old = #"{"token":"t","deviceId":"d1","serverURL":"http:\/\/10.0.0.2:8791","serverName":"Mac"}"#
        let credential = try JSONDecoder().decode(DeviceCredential.self, from: Data(old.utf8))
        #expect(credential.macId == nil)
        #expect(credential.routes == nil)
        #expect(credential.bonjourName == "Mac")
        // And the new fields survive the store's own round trip.
        var updated = credential
        updated.routes = MacRoutes(macName: "Mac", lanAddresses: ["10.0.0.2"], lanPort: 8791, bonjourName: "Mac (2)", updatedAt: Date(timeIntervalSince1970: 1_794_900_000))
        let again = try JSONDecoder().decode(DeviceCredential.self, from: JSONEncoder().encode(updated))
        #expect(again == updated)
        #expect(again.bonjourName == "Mac (2)")
    }

    @Test func routesEncodeTheContractsNullsAndPublish() async throws {
        let routes = MacRoutes(macName: "Mac", lanAddresses: ["10.0.0.2"], lanPort: nil)
        let json = try #require(try JSONSerialization.jsonObject(with: StudioJSON.encoder().encode(routes.input)) as? [String: Any])
        #expect(Set(json.keys) == ["macName", "macId", "lanAddresses", "lanPort", "bonjourName", "tunnelUrl"])
        #expect(json["macId"] is NSNull)
        #expect(routes.lanURLs.isEmpty, "no port, no LAN address")

        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host) { request, body in
            .init(status: 200, body: request.httpMethod == "PUT"
                ? Data(#"{"macName":"Mac","macId":"m1","lanAddresses":["10.0.0.2"],"lanPort":null,"bonjourName":null,"tunnelUrl":null,"updatedAt":"2026-11-16T10:00:00.000Z"}"#.utf8)
                : Data())
        }
        let api = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)
        let saved = try await api.publishMacRoutes(routes)
        #expect(saved.macId == "m1")
        #expect(saved.updatedAt != nil)
        #expect(StubURLProtocol.recorded(host: host).map { "\($0.0.httpMethod ?? "") \($0.0.url?.path ?? "")" } == ["PUT /api/pairing/routes"])
    }

    @Test func movesTheClientToANewAddress() throws {
        let client = APIClient(baseURL: URL(string: "http://10.0.0.2:8791")!)
        client.updateBaseURL(URL(string: "https://social.example.net")!)
        #expect(try client.url("/api/brands").absoluteString == "https://social.example.net/api/brands")
        #expect(try client.webSocketURL("/api/jobs/stream").absoluteString == "wss://social.example.net/api/jobs/stream")
    }

    @Test func matchesTheBonjourServiceByIdThenName() {
        let endpoint = NWEndpoint.service(name: "Deniz's Mac", type: "_studio._tcp", domain: "local.", interface: nil)
        let withId = DiscoveredStudio(serviceName: "Deniz's Mac", txt: ["name": "Deniz's Mac", "id": "mac-1"], endpoint: endpoint)
        #expect(withId.macId == "mac-1")
        #expect(withId.matches(macId: "mac-1", names: []))
        #expect(!withId.matches(macId: "mac-2", names: ["Deniz's Mac"]), "another Mac with the same name")
        let noId = DiscoveredStudio(serviceName: "Deniz's Mac (2)", txt: ["name": "Deniz's Mac"], endpoint: endpoint)
        #expect(noId.matches(macId: "mac-1", names: ["Deniz's Mac"]))
        #expect(noId.matches(macId: nil, names: ["Deniz's Mac (2)"]))
        #expect(!noId.matches(macId: nil, names: ["Other"]))
    }
}

@Suite("Finding the Mac")
struct MacRouteTests {
    private static let routes = MacRoutes(
        macName: "Mac", macId: "mac-1", lanAddresses: ["192.168.1.20", "10.0.0.5"], lanPort: 8791,
        bonjourName: "Mac", tunnelUrl: URL(string: "https://social.example.net"))

    @Test func ordersBonjourThenLastKnownThenLANThenTunnel() {
        let candidates = MacRoutePlanner.candidates(
            bonjour: [URL(string: "http://192.168.1.30:8791")!],
            lastKnown: URL(string: "http://192.168.1.20:8791/")!,
            routes: Self.routes,
            manual: URL(string: "https://backup.example.net")!)
        #expect(candidates.map(\.kind) == [.bonjour, .lastKnown, .lan, .tunnel, .manual])
        #expect(candidates.map(\.url.absoluteString) == [
            "http://192.168.1.30:8791", "http://192.168.1.20:8791/", "http://10.0.0.5:8791",
            "https://social.example.net", "https://backup.example.net",
        ], "the LAN address equal to the last known one is not tried twice")
        #expect(candidates.map(\.isRemote) == [false, false, false, true, true])
    }

    @Test func aLastKnownTunnelStaysWithTheRemoteOnes() {
        let candidates = MacRoutePlanner.candidates(lastKnown: URL(string: "https://social.example.net")!, routes: Self.routes)
        #expect(candidates.map(\.kind) == [.lan, .lan, .lastKnown])
        #expect(MacRoutePlanner.isRemote(URL(string: "http://172.20.1.1:8791")!) == false)
        #expect(MacRoutePlanner.isRemote(URL(string: "http://studio.local:8791")!) == false)
        #expect(MacRoutePlanner.isRemote(URL(string: "http://100.100.1.1:8791")!) == false)
        #expect(MacRoutePlanner.isRemote(URL(string: "http://8.8.8.8:8791")!) == true)
    }

    /// A probe that answers after `delay` with `instance` for the hosts in `answers`.
    private final class Calls: Sendable {
        let hosts = Mutex<[String]>([])
    }

    private static func probe(_ answers: [String: String?], delay: Duration = .milliseconds(5), calls: Calls? = nil) -> MacConnector.Probe {
        { url, _ in
            calls?.hosts.withLock { $0.append(url.host() ?? "") }
            try? await Task.sleep(for: delay)
            guard let host = url.host(), let instance = answers[host] else { return .unreachable }
            return .reachable(instance: instance)
        }
    }

    @Test func prefersTheMacOnTheSameNetwork() async {
        let connector = MacConnector(probe: Self.probe(["192.168.1.20": "mac-1", "social.example.net": "mac-1"]), remoteHeadStart: .milliseconds(300))
        let route = await connector.firstReachable(MacRoutePlanner.candidates(routes: Self.routes), macId: "mac-1")
        #expect(route == MacRoute(.lan, URL(string: "http://192.168.1.20:8791")!))
    }

    @Test func fallsBackToTheTunnelWhenNoLANAddressAnswers() async {
        let calls = Calls()
        let connector = MacConnector(probe: Self.probe(["social.example.net": "mac-1"], calls: calls), remoteHeadStart: .seconds(5))
        let start = ContinuousClock.now
        let route = await connector.firstReachable(MacRoutePlanner.candidates(routes: Self.routes), macId: "mac-1")
        #expect(route?.kind == .tunnel)
        // The tunnel did not wait for the whole head start: every local try had failed.
        #expect(ContinuousClock.now - start < .seconds(2))
        #expect(calls.hosts.withLock { $0 }.last == "social.example.net")
    }

    @Test func skipsAnotherMacAtAnOldAddress() async {
        let connector = MacConnector(probe: Self.probe(["192.168.1.20": "someone-else", "10.0.0.5": "mac-1"]), remoteHeadStart: .milliseconds(300))
        let route = await connector.firstReachable(MacRoutePlanner.candidates(routes: Self.routes), macId: "mac-1")
        #expect(route?.url.host() == "10.0.0.5")
        // An API started by hand reports no id: accepted.
        let unnamed = MacConnector(probe: Self.probe(["192.168.1.20": nil]), remoteHeadStart: .milliseconds(300))
        #expect(await unnamed.firstReachable(MacRoutePlanner.candidates(routes: Self.routes), macId: "mac-1")?.url.host() == "192.168.1.20")
    }

    @Test func usesTheBonjourAddressFoundMeanwhile() async {
        let connector = MacConnector(probe: Self.probe(["192.168.1.77": "mac-1"]), remoteHeadStart: .milliseconds(500))
        let route = await connector.firstReachable(MacRoutePlanner.candidates(routes: Self.routes), macId: "mac-1") {
            try? await Task.sleep(for: .milliseconds(20))
            return [MacRoute(.bonjour, URL(string: "http://192.168.1.77:8791")!)]
        }
        #expect(route?.kind == .bonjour)
    }

    @Test func givesUpWhenNothingAnswers() async {
        let connector = MacConnector(probe: Self.probe([:]), remoteHeadStart: .milliseconds(50))
        #expect(await connector.firstReachable(MacRoutePlanner.candidates(routes: Self.routes), macId: "mac-1") == nil)
        #expect(await connector.firstReachable([], macId: nil) == nil)
    }
}

@Suite("Plain connection states")
struct MacLinkStateTests {
    @Test func mapsToTheFourStates() {
        let lan = MacRoute(.lan, URL(string: "http://10.0.0.2:8791")!)
        #expect(MacLinkState.make(isPaired: false, phase: .connected(lan)) == .notPaired)
        #expect(MacLinkState.make(isPaired: true, phase: .idle) == .connecting)
        #expect(MacLinkState.make(isPaired: true, phase: .searching) == .connecting)
        #expect(MacLinkState.make(isPaired: true, phase: .connected(lan)) == .connected)

        let notFound = MacLinkState.make(isPaired: true, phase: .failed(.notFound))
        #expect(notFound.title == "Mac'e ulaşılamıyor")
        #expect(notFound.action == .retry)
        #expect(notFound.reason?.isEmpty == false)
        let forgotten = MacLinkState.make(isPaired: true, phase: .failed(.notRecognized))
        #expect(forgotten.action == .repair)
        #expect(forgotten.action?.title == "Yeniden bağla")
        #expect(MacLinkState.make(isPaired: true, phase: .failed(.other("Ağ yok."))) == .unreachable(reason: "Ağ yok.", action: .retry))

        #expect(MacLinkState.connected.title == "Mac'e bağlı")
        #expect(MacLinkState.connecting.title == "Mac'e bağlanıyor…")
        #expect(MacLinkState.notPaired.title == "Bağlı değil")
        #expect(MacLinkState.notPaired.action?.title == "iPhone'u bağla")
        #expect(MacLinkState.connected.action == nil && MacLinkState.connecting.action == nil)
        // No technical words in anything the four states say.
        let words = [MacLinkState.connected, .connecting, notFound, forgotten, .notPaired]
            .flatMap { [$0.title, $0.reason ?? "", $0.action?.title ?? ""] }.joined(separator: " ").lowercased()
        for banned in ["sunucu", "gateway", "port", "adres"] { #expect(!words.contains(banned), "\(banned)") }
    }

    @Test func tellsWhichErrorsAreConnectionProblems() {
        #expect(MacLinkState.failure(for: .offline) == .notFound)
        #expect(MacLinkState.failure(for: .timedOut) == .notFound)
        #expect(MacLinkState.failure(for: .transport("x")) == .notFound)
        #expect(MacLinkState.failure(for: .server(status: 401, code: .unauthorized, message: "", issues: [])) == .notRecognized)
        #expect(MacLinkState.failure(for: .unauthorized(status: 401)) == .notRecognized)
        #expect(MacLinkState.failure(for: .server(status: 404, code: .notFound, message: "", issues: [])) == nil)
        #expect(MacLinkState.failure(for: .cancelled) == nil)
    }

    @Test func claudeGreetingNameComesFromTheSignedInAccountOnly() throws {
        let json = #"{"status":"signed_in","email":null,"plan":null,"cliVersion":null,"loginUrl":null,"detail":null,"displayName":" Deniz ","checkedAt":"2026-11-16T10:00:00.000Z"}"#
        let account = try StudioJSON.decoder().decode(ClaudeAccount.self, from: Data(json.utf8))
        #expect(account.greetingName == "Deniz")
        var signedOut = account
        signedOut.status = .signedOut
        #expect(signedOut.greetingName == nil)
        let old = json.replacingOccurrences(of: #""displayName":" Deniz ","#, with: "")
        #expect(try StudioJSON.decoder().decode(ClaudeAccount.self, from: Data(old.utf8)).greetingName == nil)
    }
}
