import Foundation
import Observation
import StudioKit

/// What the Ayarlar screens read and change through the API, kept on the app model so a screen
/// opens with the last values at once (also while the Mac is out of reach) and refreshes behind.
///
/// - `host`: the Mac app's own settings (local network, remote access, keeping awake, keys …) as
///   its settings bridge last sent them; changes are queued and the Mac applies them in seconds.
/// - AI keys, publishing, paired devices and the server's health come straight from the API.
@MainActor
@Observable
final class IOSSettingsStore {
    @ObservationIgnored weak var app: IOSAppModel?

    private(set) var host: HostSettingsView?
    private(set) var hostError: String?
    private(set) var aiKeys: AIKeyList?
    private(set) var publishing: PublishingStatus?
    private(set) var devices: DeviceList?
    private(set) var health: HealthResponse?
    private(set) var healthError: String?
    private(set) var tools: ToolsControl?
    private(set) var toolsError: String?
    /// A tool job was just queued (until the list shows it running or finished).
    private(set) var toolJobRunning = false
    /// A change was sent and the Mac has not taken it yet (the screens show "Mac'e iletiliyor…").
    private(set) var waitingForMac = false

    @ObservationIgnored private var followTask: Task<Void, Never>?

    private var service: (any StudioDataService)? { app?.dataService }

    /// Talking to a Mac right now (or sample data): changes can be sent.
    var canChange: Bool {
        guard let app else { return false }
        return app.isSample || app.connection == .connected
    }

    /// The Mac app's values with the still pending changes applied.
    var hostValues: HostSettingsValues? { host?.effectiveValues }

    /// Which way the phone reaches the Mac (the lockout guard).
    var via: HostRoute { host?.via ?? .unknown }

    // MARK: Loading

    func loadHost() async {
        guard let service else { return }
        do {
            host = try await service.hostSettings()
            hostError = nil
        } catch {
            hostError = Self.describeHostRead(error)
        }
    }

    func loadAIKeys() async {
        guard let service else { return }
        if let keys = try? await service.aiKeys() { aiKeys = keys }
    }

    func loadPublishing() async {
        guard let service else { return }
        if let status = try? await service.publishingStatus() { publishing = status }
    }

    func loadDevices() async {
        guard let service else { return }
        if let list = try? await service.pairedDevices() { devices = list }
    }

    func loadHealth() async {
        guard let service else { return }
        do {
            health = try await service.serverHealth()
            healthError = nil
        } catch {
            healthError = Self.describe(error)
        }
    }

    // MARK: Tools (Ayarlar → Araçlar)

    /// Live from presence `tools` (the job stream) when the Mac reports it there, else the last list.
    var currentTools: [ToolStatus] {
        app?.presence?.tools ?? tools?.tools ?? []
    }

    func loadTools() async {
        guard let service else { return }
        do {
            tools = try await service.tools()
            toolsError = nil
            if !(tools?.tools.contains { $0.state == .installing } ?? false) { toolJobRunning = false }
        } catch {
            toolsError = Self.describe(error)
        }
    }

    func refreshTools() async throws {
        guard let service else { return }
        tools = try await service.refreshTools()
    }

    func installTool(_ id: String, update: Bool) async throws {
        guard let service else { return }
        _ = try await service.installTool(id, update: update)
        toolJobRunning = true
        await loadTools()
    }

    func uninstallTool(_ id: String) async throws {
        guard let service else { return }
        _ = try await service.uninstallTool(id)
        toolJobRunning = true
        await loadTools()
    }

    // MARK: Changes

    /// Queue a change of the Mac app's settings; the view shows the new value right away and
    /// follows the Mac until it took it (or says why not).
    func changeHost(_ input: HostSettingsChangeCreate) async throws {
        guard let service else { throw StudioAPIError.invalidConfiguration("Mac'e bağlı değil.") }
        let change = try await service.changeHostSettings(input)
        if var view = host {
            view.changes.removeAll { $0.id == change.id }
            view.changes.insert(change, at: 0)
            host = view
        }
        await loadHost()
        follow()
    }

    func changeHost(values: HostSettingsPatch = HostSettingsPatch(), keys: [HostKeyChange] = []) async throws {
        try await changeHost(HostSettingsChangeCreate(values: values, keys: keys))
    }

    /// Poll the view about once a second until no change is pending (at most ~20 s).
    private func follow() {
        followTask?.cancel()
        waitingForMac = host?.pendingCount ?? 0 > 0
        followTask = Task { [weak self] in
            for _ in 0..<20 {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                await self.loadHost()
                if (self.host?.pendingCount ?? 0) == 0 { break }
            }
            self?.waitingForMac = false
        }
    }

    func setAIKey(_ provider: AIKeyProvider, key: String) async throws {
        guard let service else { return }
        let state = try await service.setAIKey(provider, key: key)
        replaceKey(state)
    }

    func checkAIKey(_ provider: AIKeyProvider) async throws {
        guard let service else { return }
        replaceKey(try await service.checkAIKey(provider))
    }

    func deleteAIKey(_ provider: AIKeyProvider) async throws {
        guard let service else { return }
        replaceKey(try await service.deleteAIKey(provider))
    }

    private func replaceKey(_ state: AIKeyState) {
        var list = aiKeys ?? AIKeyList(items: [], vaultReady: true)
        if let index = list.items.firstIndex(where: { $0.provider == state.provider }) {
            list.items[index] = state
        } else {
            list.items.append(state)
        }
        aiKeys = list
    }

    func setAIPreferences(_ input: AIPreferencesPut) async throws {
        guard let service, let app else { return }
        _ = try await service.setAIPreferences(input)
        await app.loadAISpend()
    }

    func setCloudPublisher(url: String, token: String) async throws {
        guard let service else { return }
        publishing = try await service.setCloudPublisher(url: url, token: token)
    }

    func clearCloudPublisher() async throws {
        guard let service else { return }
        publishing = try await service.clearCloudPublisher()
    }

    func syncPublishing() async throws {
        guard let service else { return }
        publishing = try await service.requestPublishingSync()
    }

    func setMaxLateness(minutes: Int) async throws {
        guard let service else { return }
        publishing = try await service.setPublishingSettings(PublishingSettingsPatch(maxLatenessMinutes: minutes))
    }

    func revokeDevice(_ id: EntityID) async throws {
        guard let service else { return }
        let device = try await service.revokeDevice(id)
        if var list = devices, let index = list.items.firstIndex(where: { $0.id == id }) {
            list.items[index] = device
            devices = list
        }
    }

    // MARK: Errors

    /// The API's Turkish refusals as they are (lockout guard, self-revoke); an older Mac in plain words.
    static func describe(_ error: any Error) -> String {
        let api = StudioAPIError.from(error)
        switch api {
        case .server(_, .conflict, let message, _):
            return message
        case .server(_, .forbidden, _, _):
            return "Mac'teki Studio bunu telefondan değiştirmeye izin vermiyor. Mac'teki Studio'yu güncelle ya da Mac'te değiştir."
        case .server(_, .validationError, let message, _) where !message.hasPrefix("invalid request"):
            return message
        default:
            return IOSAppModel.describe(error)
        }
    }

    private static func describeHostRead(_ error: any Error) -> String {
        let api = StudioAPIError.from(error)
        switch api {
        case .server(404, _, _, _), .http(404):
            return "Mac'teki Studio bu ayarları henüz göndermiyor. Mac'te Studio'yu güncelle."
        default:
            return describe(error)
        }
    }
}
