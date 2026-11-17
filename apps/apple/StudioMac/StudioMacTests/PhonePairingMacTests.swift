import AppKit
import Foundation
import StudioKit
import Synchronization
import Testing
@testable import StudioMac

/// A tiny local API for the pairing pane: offers, devices, revoke. Keyed by host.
private final class PairingStub: URLProtocol, @unchecked Sendable {
    struct State {
        var devices: [String] = []
        var offers = 0
        var revoked: [String] = []
    }

    static let states = Mutex<[String: State]>([:])

    static func session(host: String) -> URLSession {
        states.withLock { $0[host] = State() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingStub.self]
        return URLSession(configuration: configuration)
    }

    static func update(_ host: String, _ change: (inout State) -> Void) {
        states.withLock { change(&$0[host, default: State()]) }
    }

    static func state(_ host: String) -> State { states.withLock { $0[host] ?? State() } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let host = request.url?.host ?? ""
        let path = request.url?.path ?? ""
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var status = 200
        var body = "{}"
        switch (request.httpMethod ?? "GET", path) {
        case ("POST", "/api/pairing/codes"):
            Self.update(host) { $0.offers += 1 }
            status = 201
            let secret = String(repeating: "S", count: 42) + String(Self.state(host).offers)
            body = #"{"code":"123456","expiresAt":"\#(iso.string(from: Date().addingTimeInterval(120)))","secret":"\#(secret)","secretExpiresAt":"\#(iso.string(from: Date().addingTimeInterval(600)))"}"#
        case ("GET", "/api/devices"):
            let items = Self.state(host).devices.map { name in
                #"{"id":"d-\#(name.count)","name":"\#(name)","platform":"ios","createdAt":"\#(iso.string(from: Date()))","lastSeenAt":null,"revokedAt":\#(Self.state(host).revoked.contains("d-\(name.count)") ? "\"\(iso.string(from: Date()))\"" : "null")}"#
            }
            body = #"{"items":[\#(items.joined(separator: ","))]}"#
        case ("POST", let revoke) where revoke.hasSuffix("/revoke"):
            let id = revoke.split(separator: "/").dropLast().last.map(String.init) ?? ""
            Self.update(host) { $0.revoked.append(id) }
            body = #"{"id":"\#(id)","name":"x","platform":"ios","createdAt":"\#(iso.string(from: Date()))","lastSeenAt":null,"revokedAt":"\#(iso.string(from: Date()))"}"#
        case ("PUT", "/api/pairing/routes"):
            body = #"{"macName":"Burak's MacBook Pro","macId":"mac-1","lanAddresses":["192.168.1.20"],"lanPort":8791,"bonjourName":"Burak's MacBook Pro","tunnelUrl":null,"updatedAt":"2026-11-16T10:00:00.000Z"}"#
        default:
            status = 404
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
private func makePairing() -> (PhonePairingModel, String) {
    let host = "pairing-\(UUID().uuidString.lowercased()).test"
    let model = PhonePairingModel()
    model.autoRefresh = false
    model.clientOverride = APIClient(baseURL: URL(string: "http://\(host)")!, session: PairingStub.session(host: host))
    model.routesOverride = MacRoutes(
        macName: "Burak's MacBook Pro", macId: "mac-1", lanAddresses: ["192.168.1.20"], lanPort: 8791,
        bonjourName: "Burak's MacBook Pro", tunnelUrl: URL(string: "https://social.example.net"))
    return (model, host)
}

@Suite("iPhone pairing on the Mac")
@MainActor
struct PhonePairingMacTests {
    @Test func qrCodeHoldsThePairingLink() throws {
        let invite = PairingInvite(
            macName: "Burak’s MacBook Pro", secret: String(repeating: "k", count: 43),
            expiresAt: Date(timeIntervalSince1970: 1_794_900_000), macId: "8f1c2a4e-0000-4000-8000-000000000001",
            lanAddresses: ["192.168.1.20", "10.0.0.5"], lanPort: 8791, tunnelURL: URL(string: "https://social.example.net"))
        let image = try #require(QRCode.image(for: invite.url.absoluteString))
        #expect(image.size.width >= 200)
        let text = try #require(QRCode.decode(image))
        #expect(try PairingInvite.parse(text) == invite)
    }

    @Test func showsAFreshOfferAndNoticesThePhone() async throws {
        let (model, host) = makePairing()
        model.showQR()
        await model.step()
        #expect(model.phase == .ready)
        #expect(model.needsFirstPhone)
        let invite = try #require(model.invite)
        #expect(invite.secret == String(repeating: "S", count: 42) + "1")
        #expect(invite.macId == "mac-1")
        #expect(invite.tunnelURL?.absoluteString == "https://social.example.net")
        #expect(model.formattedCode == "123 456")
        #expect((110...120).contains(model.codeSecondsLeft))
        let qr = try #require(model.qrImage)
        #expect(try PairingInvite.parse(try #require(QRCode.decode(qr))) == invite)

        // Still fresh: the next round does not make another offer.
        await model.step()
        #expect(PairingStub.state(host).offers == 1)

        // The card says what to do, with the code for typing by hand.
        let card = PhonePairingCardView(model: model)
        #expect(card.displayedTitle == "iPhone'u bağla")
        #expect(card.displaysQR)
        #expect(card.displayedCode.contains("123 456"))
        for banned in ["sunucu", "port", "adres", "gateway"] {
            #expect(!(card.displayedSteps + card.displayedCode).lowercased().contains(banned))
        }

        // The phone pairs: the card says so and the used code disappears.
        PairingStub.update(host) { $0.devices = ["Burak'ın iPhone'u"] }
        await model.loadDevices()
        #expect(model.phase == .paired("Burak'ın iPhone'u"))
        #expect(model.invite == nil && model.qrImage == nil)
        #expect(!model.needsFirstPhone)
        try? await Task.sleep(for: .milliseconds(80)) // the card re-renders on the next main-actor turn
        #expect(card.displayedTitle == "iPhone bağlandı")

        // "Başka bir iPhone bağla" makes a new offer.
        await model.renewOffer()
        #expect(model.phase == .ready)
        #expect(PairingStub.state(host).offers == 2)
        #expect(model.invite?.secret.hasSuffix("2") == true)
        model.hideQR()
    }

    @Test func aCardOpenedAgainAfterPairingOrRemovalOffersANewCode() async throws {
        let (model, host) = makePairing()
        model.showQR()
        await model.step()
        PairingStub.update(host) { $0.devices = ["Burak'ın iPhone'u"] }
        await model.loadDevices()
        #expect(model.phase == .paired("Burak'ın iPhone'u"))
        model.hideQR()

        // Settings → Cihazlar opened again later: a fresh code, not the old "bağlandı".
        model.showQR()
        #expect(model.phase == .ready)
        await model.step()
        #expect(model.invite != nil)
        #expect(PairingStub.state(host).offers == 2)

        // Paired again, then the phone is removed: "bağlandı" no longer holds.
        PairingStub.update(host) { $0.devices = ["Burak'ın iPhone'u", "İkinci iPhone"] }
        await model.loadDevices()
        if case .paired = model.phase {} else { Issue.record("expected paired, got \(model.phase)") }
        await model.remove(try #require(model.activeDevices.first))
        #expect(model.phase == .ready)
        model.hideQR()
    }

    @Test func theCardOffersCodesOnlyWhileItsWindowIsOnScreen() {
        func shown(_ inWindow: Bool = true, visible: Bool = true, hidden: Bool = false, occlusion: NSWindow.OcclusionState = .visible, closing: Bool = false) -> Bool {
            PhonePairingCardView.isOnScreen(inWindow: inWindow, windowVisible: visible, hidden: hidden, occlusion: occlusion, closing: closing)
        }
        #expect(shown())
        #expect(shown(occlusion: []), "a window that has not reported yet")
        #expect(!shown(false))
        #expect(!shown(visible: false), "the main window closed (Studio keeps running) or the sheet went away")
        #expect(!shown(occlusion: [.init(rawValue: 1 << 20)]), "fully covered or minimized")
        #expect(!shown(hidden: true))
        #expect(!shown(closing: true))
    }

    @Test func aCancelledRoundIsNotShownAsAnError() async {
        let (model, _) = makePairing()
        model.showQR()
        let round = Task { await model.step() }
        round.cancel()
        await round.value
        #expect(model.message == nil, "a cancelled request is not 'İptal edildi.'")
        if case .failed(let reason) = model.phase { Issue.record("cancelled round shown as \(reason)") }
        model.hideQR()
    }

    @Test func renewsAnOfferBeforeItsQRRunsOut() async {
        let (model, host) = makePairing()
        model.showQR()
        await model.step()
        #expect(PairingStub.state(host).offers == 1)
        // Twenty seconds before the QR secret expires, the next round replaces it.
        model.now = { Date().addingTimeInterval(590) }
        await model.step()
        #expect(PairingStub.state(host).offers == 2)
        model.hideQR()
    }

    @Test func removesAPairedPhone() async {
        let (model, host) = makePairing()
        PairingStub.update(host) { $0.devices = ["Test iPhone"] }
        await model.loadDevices()
        #expect(model.activeDevices.map(\.name) == ["Test iPhone"])
        #expect(!model.needsFirstPhone)
        await model.remove(model.activeDevices[0])
        #expect(PairingStub.state(host).revoked == ["d-11"])
        #expect(model.activeDevices.isEmpty)
        #expect(model.message?.contains("kaldırıldı") == true)
        #expect(model.needsFirstPhone)
    }

    @Test func saysWhyPairingIsUnavailableWithoutTheMacsOwnServer() async {
        let model = PhonePairingModel()
        model.autoRefresh = false
        model.showQR()
        await model.step()
        guard case .unavailable(let message) = model.phase else {
            Issue.record("expected unavailable, got \(model.phase)")
            return
        }
        #expect(message.contains("Studio"))
        #expect(!model.needsFirstPhone)
        let card = PhonePairingCardView(model: model)
        #expect(!card.displaysQR)
    }

    @Test func devicesPaneListsPairedIPhones() async throws {
        let (model, host) = makePairing()
        PairingStub.update(host) { $0.devices = ["Ayşe'nin iPhone'u"] }
        await model.loadDevices()
        let pane = DevicesSectionView(model: model)
        #expect(pane.listedDevices == ["Ayşe'nin iPhone'u"])
        #expect(pane.section?.title == "Cihazlar")
        #expect(SettingsSearch.results(for: "qr").map(\.section) == [.devices])
        #expect(SettingsCatalog.pairPhone.title == "iPhone'u bağla")
    }

    @Test func greetsWithTheClaudeAccountNameUnlessOneIsTyped() async {
        let defaults = UserDefaults(suiteName: "studio.tests.name.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), tunnelTokens: InMemoryTunnelTokenStore(), useSampleData: true)
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
        let account = ClaudeAccount(status: .signedIn, displayName: "Deniz", checkedAt: .now)
        app.jobBoard.apply(.message(.presence(WorkerPresence(online: true, claude: account))))
        #expect(app.ownerName == "Deniz")
        settings.ownerName = "  Burak "
        #expect(app.ownerName == "Burak")
        #expect(defaults.string(forKey: AppSettings.ownerNameKey) == "  Burak ")
        settings.ownerName = ""
        app.jobBoard.apply(.message(.presence(WorkerPresence(online: true, claude: ClaudeAccount(status: .signedOut, displayName: "Deniz", checkedAt: .now)))))
        #expect(app.ownerName == nil)
        #expect(SidebarFooter.title(owner: app.ownerName, brandName: nil) == "Studio")
    }

    @Test func plainWordsInTheMacsStatus() {
        let issues: [ConnectionIssue] = [.hostStarting("Hazırlanıyor"), .hostFailed("x"), .apiUnreachable, .unauthorized, .apiError("x"),
                                         .workerOffline, .claudeSignedOut, .claudeSigningIn, .claudeNotInstalled]
        for issue in issues {
            #expect(!issue.message.lowercased().contains("sunucu"), "\(issue)")
            #expect(!issue.shortLabel.lowercased().contains("sunucu"), "\(issue)")
        }
        #expect(SettingsSection.macServer.title == "Gelişmiş")
    }

    @Test func hostHasNoRoutesUntilItRuns() {
        let host = LocalHost(stateDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)) {
            HostConfiguration(repoPath: "/nonexistent", lanEnabled: true)
        }
        #expect(host.routes == nil)
        #expect(host.tunnelURL == nil)
    }
}
