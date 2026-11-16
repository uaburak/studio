import Foundation
import Network
import Security
import Testing
@testable import StudioKit

@Suite("Pairing client and device token storage")
struct PairingTests {
    private static let device = #"{"id":"d1","name":"Test iPhone","platform":"ios","createdAt":"2026-11-16T10:00:00.000Z","lastSeenAt":null,"revokedAt":null}"#

    @Test func pairsSavesTheTokenAndSendsItAfterwards() async throws {
        let host = uniqueHost()
        let token = "sdt_" + String(repeating: "a", count: 43)
        let session = StubURLProtocol.session(host: host) { request, _ in
            switch request.url?.path {
            case "/api/pairing/claim":
                return .init(status: 201, body: Data(#"{"device":\#(Self.device),"token":"\#(token)"}"#.utf8))
            default:
                return .init(status: 200, body: try Fixture.data("presence"))
            }
        }
        let store = InMemoryDeviceTokenStore()
        let pairing = PairingClient(store: store, session: session)
        #expect(!pairing.isPaired)
        #expect(pairing.client() == nil)

        let url = URL(string: "http://\(host):8791")!
        let device = try await pairing.pair(baseURL: url, serverName: "Burak's Mac", code: "123 456", deviceName: "  Test iPhone ", platform: .ios)
        #expect(device.id == "d1")
        #expect(device.platform == .ios)
        #expect(try store.load() == DeviceCredential(token: token, deviceId: "d1", serverURL: url, serverName: "Burak's Mac"))

        let (claim, body) = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(claim.httpMethod == "POST")
        #expect(claim.value(forHTTPHeaderField: "Authorization") == nil)
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: String]
        #expect(sent == ["code": "123456", "deviceName": "Test iPhone", "platform": "ios"])

        let api = try #require(pairing.client())
        _ = try await api.presence()
        let follow = try #require(StubURLProtocol.recorded(host: host).last?.0)
        #expect(follow.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")

        try pairing.forget()
        #expect(!pairing.isPaired)
    }

    @Test func mapsWrongCodeAndRateLimitErrors() async throws {
        let host = uniqueHost()
        let replies = [
            (401, #"{"error":{"code":"unauthorized","message":"pairing code is wrong, expired or already used"}}"#),
            (429, #"{"error":{"code":"rate_limited","message":"too many failed pairing attempts"}}"#),
        ]
        let counter = Counter()
        let session = StubURLProtocol.session(host: host) { _, _ in
            let (status, body) = replies[min(counter.next(), replies.count - 1)]
            return .init(status: status, body: Data(body.utf8))
        }
        let store = InMemoryDeviceTokenStore()
        let pairing = PairingClient(store: store, session: session)
        let url = URL(string: "http://\(host):8791")!

        let wrong = await #expect(throws: StudioAPIError.self) {
            try await pairing.pair(baseURL: url, serverName: "Mac", code: "000000", deviceName: "x")
        }
        #expect(wrong?.code == .unauthorized)
        let limited = await #expect(throws: StudioAPIError.self) {
            try await pairing.pair(baseURL: url, serverName: "Mac", code: "000000", deviceName: "x")
        }
        #expect(limited?.code == .rateLimited)
        #expect(limited?.errorDescription?.contains("Çok fazla") == true)
        #expect(try store.load() == nil)
    }

    @Test func validatesInputBeforeCallingTheServer() async throws {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host) { _, _ in .init(status: 500, body: Data()) }
        let pairing = PairingClient(store: InMemoryDeviceTokenStore(), session: session)
        let url = URL(string: "http://\(host):8791")!
        await #expect(throws: StudioAPIError.self) {
            try await pairing.pair(baseURL: url, serverName: "Mac", code: "12345", deviceName: "x")
        }
        await #expect(throws: StudioAPIError.self) {
            try await pairing.pair(baseURL: url, serverName: "Mac", code: "123456", deviceName: "   ")
        }
        #expect(StubURLProtocol.recorded(host: host).isEmpty)
    }

    @Test func macSideDeviceCalls() async throws {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host) { request, _ in
            switch request.url?.path {
            case "/api/pairing/codes": return .init(status: 201, body: Data(#"{"code":"042042","expiresAt":"2026-11-16T10:02:00.000Z"}"#.utf8))
            case "/api/devices": return .init(status: 200, body: Data(#"{"items":[\#(Self.device)]}"#.utf8))
            default: return .init(status: 200, body: Data(Self.device.replacingOccurrences(of: #""revokedAt":null"#, with: #""revokedAt":"2026-11-16T10:05:00.000Z""#).utf8))
            }
        }
        let api = APIClient(baseURL: URL(string: "http://\(host):8790")!, session: session)
        #expect(try await api.createPairingCode().code == "042042")
        #expect(try await api.devices().map(\.name) == ["Test iPhone"])
        #expect(try await api.revokeDevice("d1").isRevoked)
        #expect(StubURLProtocol.recorded(host: host).map { "\($0.0.httpMethod ?? "") \($0.0.url?.path ?? "")" } == [
            "POST /api/pairing/codes", "GET /api/devices", "POST /api/devices/d1/revoke",
        ])
    }

    @Test func keychainStoreRoundTrips() throws {
        let store = KeychainDeviceTokenStore(service: "net.burakkoc.studio.tests", account: "device-\(UUID().uuidString)")
        let credential = DeviceCredential(token: "sdt_test", deviceId: "d1", serverURL: URL(string: "http://10.0.0.2:8791")!, serverName: "Mac")
        do {
            try store.save(credential)
        } catch let error as KeychainError where error.status == errSecMissingEntitlement || error.status == errSecInteractionNotAllowed {
            return // no usable keychain in this environment
        }
        defer { try? store.delete() }
        #expect(try store.load() == credential)
        var moved = credential
        moved.serverURL = URL(string: "http://10.0.0.3:8791")!
        try store.save(moved)
        #expect(try store.load() == moved)
        try store.delete()
        #expect(try store.load() == nil)
        try store.delete() // deleting twice is fine
    }

    @Test func readsTheBonjourTXTRecord() {
        let endpoint = NWEndpoint.service(name: "Studio (Mac)", type: "_studio._tcp", domain: "local.", interface: nil)
        let found = DiscoveredStudio(serviceName: "Studio (Mac)", txt: ["name": "Burak's Mac", "api": "1", "pairing": "required"], endpoint: endpoint)
        #expect(found.displayName == "Burak's Mac")
        #expect(found.isSupported)
        #expect(found.pairingRequired)
        let bare = DiscoveredStudio(serviceName: "Other", txt: [:], endpoint: endpoint)
        #expect(bare.displayName == "Other")
        #expect(!bare.isSupported)
        #expect(bare.pairingRequired)
        #expect(StudioBrowser.baseURL(host: .ipv4(.loopback), port: 8791)?.absoluteString == "http://127.0.0.1:8791")
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = -1
    func next() -> Int { lock.withLock { value += 1; return value } }
}

@Suite("Bonjour TXT fallback")
struct BonjourTXTFallbackTests {
    @Test func advertisedURLsComeFromAddrAndPort() {
        let studio = DiscoveredStudio(
            serviceName: "Mac", txt: ["name": "Mac", "api": "1", "addr": "192.168.1.126, 10.0.0.5,bad", "port": "8791"],
            endpoint: .hostPort(host: "127.0.0.1", port: 1))
        #expect(studio.advertisedURLs.map(\.absoluteString) == ["http://192.168.1.126:8791", "http://10.0.0.5:8791"])
    }

    @Test func noPortMeansNoFallback() {
        let studio = DiscoveredStudio(serviceName: "Mac", txt: ["addr": "192.168.1.126"], endpoint: .hostPort(host: "127.0.0.1", port: 1))
        #expect(studio.advertisedURLs.isEmpty)
    }
}
