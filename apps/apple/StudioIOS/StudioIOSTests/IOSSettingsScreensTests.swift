import StudioKit
import Testing
import UIKit
@testable import StudioIOS

/// Ayarlar parity: every settings screen builds on sample data, mirrors the Mac app's sections,
/// uses orange switches, and keeps the phone from cutting its own connection.
@Suite("StudioIOS settings screens")
@MainActor
struct IOSSettingsScreensTests {
    private func makeApp() async -> (IOSAppModel, SampleBackend) {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let defaults = UserDefaults(suiteName: "studio.ios.settings.\(UUID().uuidString)")!
        let settings = IOSAppSettings(defaults: defaults, tokenStore: InMemoryDeviceTokenStore(), useSampleData: true)
        let app = IOSAppModel(settings: settings, conversationService: backend, dataService: backend, notifier: IOSNotifier(delivering: .silent))
        await app.load()
        return (app, backend)
    }

    private func show(_ controller: SettingsTableViewController) async {
        let nav = UINavigationController(rootViewController: controller)
        nav.loadViewIfNeeded()
        nav.view.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        controller.loadViewIfNeeded()
        controller.viewWillAppear(false)
        await controller.refresh()
        controller.rebuild()
        nav.view.layoutIfNeeded()
    }

    private func switches(_ controller: SettingsTableViewController) -> [UISwitch] {
        let table = controller.tableView!
        var out: [UISwitch] = []
        for section in 0..<table.numberOfSections {
            for row in 0..<table.numberOfRows(inSection: section) {
                let cell = controller.tableView(table, cellForRowAt: IndexPath(row: row, section: section))
                if let toggle = cell.accessoryView as? UISwitch { out.append(toggle) }
            }
        }
        return out
    }

    @Test func mainScreenMirrorsTheMacSections() async {
        let (app, _) = await makeApp()
        let settings = IOSSettingsViewController(app: app)
        await show(settings)
        for title in ["Yapay zekâ", "Kullanım", "Görünüm", "Bildirimler", "Markalar", "Hesaplar", "Yayın", "Cihazlar", "Gelişmiş", "Araçlar", "Hakkında"] {
            #expect(settings.rowTitles.contains(title), "\(title)")
        }
    }

    @Test func everyScreenBuildsWithOrangeSwitches() async {
        let (app, _) = await makeApp()
        let screens: [SettingsTableViewController] = [
            SettingsAIViewController(app: app),
            SettingsAIKeyViewController(app: app, provider: .gemini),
            SettingsUsageViewController(app: app),
            SettingsAppearanceViewController(app: app),
            SettingsNotificationsViewController(app: app),
            SettingsAccountsViewController(app: app),
            SettingsPublishingViewController(app: app),
            SettingsDevicesViewController(app: app),
            SettingsMacAdvancedViewController(app: app),
            SettingsToolsViewController(app: app),
            SettingsAboutViewController(app: app),
        ]
        var total = 0
        for screen in screens {
            await show(screen)
            #expect(!screen.sections.isEmpty, "\(type(of: screen))")
            let found = switches(screen)
            total += found.count
            for toggle in found { #expect(toggle.onTintColor == IOSTheme.accent) }
        }
        #expect(total >= 6)
        if let account = app.accounts.first {
            let detail = SettingsAccountViewController(app: app, accountId: account.id)
            await show(detail)
            #expect(detail.rowTitles.contains("Şimdi denetle"))
        }
    }

    @Test func macAdvancedShowsTheHostSettingsAndKeysWithoutValues() async {
        let (app, _) = await makeApp()
        let screen = SettingsMacAdvancedViewController(app: app)
        await show(screen)
        for title in ["Mac'i uyanık tut", "Yerel ağdan erişim", "Uzaktan erişim", "Tünel adresi", "Tünel anahtarı", "Bağlantı ayrıntıları"] {
            #expect(screen.rowTitles.contains(title), "\(title)")
        }
        #expect(screen.rowTitles.contains { $0.contains("ElevenLabs") })
    }

    @Test func changesReachTheMacAndTheLockoutGuardHolds() async throws {
        let (app, backend) = await makeApp()
        let store = app.settingsStore
        await store.loadHost()
        try await store.changeHost(values: HostSettingsPatch(keepAwake: false))
        #expect(store.hostValues?.keepAwake == false)
        #expect(try await backend.hostSettings().state?.values.keepAwake == false)

        // Through the LAN, turning local network access off is refused with the API's words.
        await #expect(throws: StudioAPIError.self) {
            try await store.changeHost(values: HostSettingsPatch(lanEnabled: false))
        }
        do {
            try await store.changeHost(values: HostSettingsPatch(lanEnabled: false))
        } catch {
            #expect(IOSSettingsStore.describe(error) == HostLockout.lan)
        }

        await store.loadDevices()
        let own = try #require(store.devices?.currentDeviceId)
        do {
            try await store.revokeDevice(own)
            Issue.record("revoking itself must fail")
        } catch {
            #expect(IOSSettingsStore.describe(error).contains("kendini"))
        }
    }

    @Test func toolsListTheMacsProgramsAndInstallFromThePhone() async throws {
        let (app, backend) = await makeApp()
        let screen = SettingsToolsViewController(app: app)
        await show(screen)
        #expect(screen.rowTitles.contains("Chromium"))
        #expect(screen.rowTitles.contains("ffmpeg"))
        let ffmpeg = try #require(screen.sections.flatMap(\.rows).first { $0.id == "ffmpeg" })
        #expect(ffmpeg.value == "Kur")
        #expect(ffmpeg.detail?.contains("~29 MB") == true)
        #expect(screen.sections.contains { $0.header == "İsteğe bağlı" })

        try await app.settingsStore.installTool("ffmpeg", update: false)
        screen.rebuild()
        #expect(try await backend.tools().tools.first { $0.id == "ffmpeg" }?.state == .installed)
        let after = try #require(screen.sections.flatMap(\.rows).first { $0.id == "ffmpeg" })
        #expect(after.value == nil)
        #expect(after.detail?.contains("Studio'nun kopyası") == true)
    }
}
