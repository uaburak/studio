import StudioKit
import Testing
import UIKit
@testable import StudioIOS

private let tunnel = URL(string: "https://social.example.net")!
private let routes = MacRoutes(
    macName: "Deniz's MacBook Pro", macId: "mac-1", lanAddresses: ["192.168.1.20"], lanPort: 8791,
    bonjourName: "Deniz's MacBook Pro", tunnelUrl: tunnel)
private let paired = DeviceCredential(
    token: "sdt_test", deviceId: "d-1", serverURL: URL(string: "http://192.168.1.20:8791")!,
    serverName: "Deniz's MacBook Pro", macId: "mac-1", routes: routes)

/// A paired (or not) phone whose connection manager runs over in-memory services: the
/// probe, Bonjour and the routes call are fakes, so nothing leaves the simulator.
@MainActor
private func makeRemoteApp(
    credential: DeviceCredential? = paired,
    answering: [String: String?] = [:],
    bonjour: [URL] = [],
    macRoutes: MacRoutes? = nil
) -> (IOSAppModel, InMemoryDeviceTokenStore) {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.ios.link.\(UUID().uuidString)")!
    let store = InMemoryDeviceTokenStore(credential)
    let settings = IOSAppSettings(defaults: defaults, tokenStore: store, useSampleData: false)
    let app = IOSAppModel(settings: settings, conversationService: backend, dataService: backend,
                          notifier: IOSNotifier(delivering: .silent), treatAsRemote: true)
    app.autoRetry = false
    app.connector = MacConnector(probe: { url, _ in
        guard let host = url.host(), let instance = answering[host] else { return .unreachable }
        return .reachable(instance: instance)
    }, remoteHeadStart: .milliseconds(100))
    app.locateOnNetwork = { _, _ in bonjour }
    app.fetchRoutes = { _ in macRoutes }
    return (app, store)
}

@Suite("Finding the Mac from the phone")
@MainActor
struct IOSConnectionTests {
    @Test func notPairedSaysSoAndOffersToPair() async {
        let (app, _) = makeRemoteApp(credential: nil)
        await app.load()
        #expect(app.connection == .notPaired)
        #expect(app.connection.title == "Bağlı değil")
        #expect(app.connection.action?.title == "iPhone'u bağla")
    }

    @Test func usesTheTunnelWhenTheLANAddressIsGoneAndRemembersIt() async throws {
        let (app, store) = makeRemoteApp(answering: ["social.example.net": "mac-1"])
        await app.load()
        #expect(app.connection == .connected)
        #expect(app.client.baseURL == tunnel)
        #expect(try store.load()?.serverURL == tunnel)
        #expect(app.brands.count == 4, "data loaded after connecting")
        guard case .connected(let route) = app.linkPhase else {
            Issue.record("not connected")
            return
        }
        #expect(route.kind == .tunnel)
    }

    @Test func followsTheMacToItsNewWiFiAddress() async throws {
        let moved = URL(string: "http://192.168.1.77:8791")!
        let (app, store) = makeRemoteApp(answering: ["192.168.1.77": "mac-1", "social.example.net": "mac-1"], bonjour: [moved])
        await app.load()
        #expect(app.connection == .connected)
        #expect(app.client.baseURL == moved)
        #expect(try store.load()?.serverURL == moved)
    }

    @Test func ignoresAnotherMacAtTheOldAddress() async {
        let (app, _) = makeRemoteApp(answering: ["192.168.1.20": "someone-else"])
        await app.load()
        #expect(app.connection.title == "Mac'e ulaşılamıyor")
        #expect(app.connection.action == .retry)
        #expect(app.connection.reason?.isEmpty == false)
        #expect(app.client.baseURL.absoluteString == "http://192.168.1.20:8791", "stays on the last address until the Mac answers")
    }

    @Test func savesTheRoutesTheMacSendsAfterConnecting() async throws {
        var fresh = routes
        fresh.lanAddresses = ["10.0.0.9"]
        let (app, store) = makeRemoteApp(answering: ["192.168.1.20": "mac-1"], macRoutes: fresh)
        await app.load()
        #expect(app.connection == .connected)
        #expect(try store.load()?.routes?.lanAddresses == ["10.0.0.9"])
    }

    @Test func aForgottenPhoneIsAskedToReconnect() async {
        let (app, _) = makeRemoteApp(answering: ["192.168.1.20": "mac-1"])
        await app.load()
        app.linkLost(.notRecognized)
        #expect(app.connection.title == "Mac'e ulaşılamıyor")
        #expect(app.connection.action == .repair)
        #expect(app.connection.action?.title == "Yeniden bağla")
        // "Tekrar dene" finds it again when the Mac answers.
        app.retryConnection()
        for _ in 0..<50 where app.connection != .connected { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(app.connection == .connected)
    }

    @Test func pairingLinksOpenTheScanner() {
        let (app, _) = makeRemoteApp(credential: nil)
        let invite = PairingInvite(macName: "Deniz's MacBook Pro", secret: String(repeating: "x", count: 43), expiresAt: .now.addingTimeInterval(600), tunnelURL: tunnel)
        #expect(app.openLink(invite.url))
        #expect(app.pendingRoute == .pair)
        #expect(app.pendingInvite == invite)
        #expect(!app.openLink(URL(string: "https://example.com")!))
    }

    @Test func greetsWithTheClaudeAccountName() async {
        let (app, _) = makeRemoteApp(answering: ["192.168.1.20": "mac-1"])
        await app.load()
        // The sample worker reports the Claude account "Deniz".
        for _ in 0..<50 where app.presence == nil { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(app.greetingName == "Deniz")
        app.settings.ownerName = "Ayşe"
        #expect(app.greetingName == "Ayşe")
    }

    @Test func settingsSpeakPlainly() async throws {
        let (unpaired, _) = makeRemoteApp(credential: nil)
        await unpaired.load()
        let first = IOSSettingsViewController(app: unpaired)
        first.loadViewIfNeeded()
        #expect(first.macRowTitles == ["Bağlı değil", "iPhone'u bağla", "Kodu elle gir"])

        let (app, _) = makeRemoteApp(answering: ["192.168.1.20": "mac-1"])
        await app.load()
        let settings = IOSSettingsViewController(app: app)
        settings.loadViewIfNeeded()
        #expect(settings.macRowTitles.first == "Deniz's MacBook Pro")
        #expect(settings.macRowTitles.contains("Bağlantıyı kaldır"))
        // Technical words stay under Gelişmiş.
        let table = settings.tableView!
        var texts: [String] = []
        for section in 0..<table.numberOfSections {
            for row in 0..<table.numberOfRows(inSection: section) {
                let cell = settings.tableView(table, cellForRowAt: IndexPath(row: row, section: section))
                if let content = cell.contentConfiguration as? UIListContentConfiguration {
                    texts += [content.text ?? "", content.secondaryText ?? ""]
                }
            }
            texts.append(settings.tableView(table, titleForFooterInSection: section) ?? "")
        }
        let all = texts.joined(separator: " ").lowercased()
        for banned in ["sunucu", "gateway", "port", "adres"] { #expect(!all.contains(banned), "\(banned) in settings") }

        let advanced = IOSAdvancedConnectionViewController(app: app)
        advanced.loadViewIfNeeded()
        #expect(advanced.rowTitles.contains("Kullanılan adres"))
        #expect(advanced.rowTitles.contains("Bu adresi de dene"))
    }
}
