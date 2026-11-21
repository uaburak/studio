import StudioKit
import UIKit
import UserNotifications

/// Ayarlar → Görünüm: this iPhone's theme and greeting name, the Mac's theme and sidebar name.
final class SettingsAppearanceViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Görünüm")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async { await store.loadHost() }

    override func buildSections() -> [SettingsSection] {
        let settings = app.settings
        let typedName = settings.ownerName.trimmingCharacters(in: .whitespacesAndNewlines)
        let accountName = app.presence?.claude?.greetingName
        let nameValue: String = if !typedName.isEmpty {
            typedName
        } else if let accountName {
            "Claude hesabından: \(accountName)"
        } else if let guess = settings.greetingName {
            "Mac'in adından: \(guess)"
        } else {
            "Ayarlanmadı"
        }
        var sections = [
            SettingsSection("Bu iPhone", footer: "Ad, ana ekrandaki selamlamada kullanılır. Boş bırakırsan Mac'teki Claude hesabındaki adın kullanılır.", rows: [
                .menu("Tema", value: settings.appearance.label, icon: "circle.lefthalf.filled", Self.choiceMenu(IOSAppearancePreference.allCases.map { ($0, $0.label) }, selected: settings.appearance) { [weak self] value in
                    self?.app.settings.appearance = value
                }),
                .navigate("Adın", value: nameValue, icon: "person.crop.circle") { [weak self] in
                    guard let self else { return }
                    self.prompt("Adın", message: "Ana ekrandaki selamlamada kullanılır.", text: self.app.settings.ownerName, placeholder: self.app.greetingName ?? "Adın") { name in
                        self.app.settings.ownerName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                },
            ]),
        ]
        let values = store.hostValues
        let canChange = store.canChange && values != nil
        sections.append(SettingsSection("Mac", footer: store.hostError ?? "Mac'teki Studio'nun teması ve kenar çubuğundaki adın. Sistem, macOS ayarını izler.", rows: [
            .menu("Tema", value: values?.appearance.label ?? "—", icon: "laptopcomputer", enabled: canChange, Self.choiceMenu(HostAppearance.knownCases.map { ($0, $0.label) }, selected: values?.appearance) { [weak self] value in
                self?.run { try await self?.store.changeHost(values: HostSettingsPatch(appearance: value)) }
            }),
            .navigate("Adın", value: values.map { $0.ownerName.isEmpty ? "Claude hesabından" : $0.ownerName } ?? "—", icon: "person.text.rectangle", enabled: canChange) { [weak self] in
                guard let self else { return }
                self.prompt("Mac'teki adın", message: "Kenar çubuğunda görünür. Boş bırakırsan Claude hesabındaki adın kullanılır.", text: values?.ownerName, placeholder: "Adın") { name in
                    self.run { try await self.store.changeHost(values: HostSettingsPatch(ownerName: name.trimmingCharacters(in: .whitespacesAndNewlines))) }
                }
            },
        ]))
        return sections
    }
}

/// Ayarlar → Bildirimler: this iPhone's permission and categories, the Mac's macOS notifications.
final class SettingsNotificationsViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Bildirimler")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async {
        async let auth: Void = app.notifier.refreshAuthorization()
        async let host: Void = store.loadHost()
        _ = await (auth, host)
    }

    private static func icon(_ category: ActivityNotice.Category) -> String {
        switch category {
        case .waiting: "hand.raised"
        case .production: "square.grid.2x2"
        case .publishing: "paperplane"
        case .replies: "bubble.left"
        }
    }

    override func buildSections() -> [SettingsSection] {
        var phone: [SettingsRow] = []
        let notifier = app.notifier
        let allowed: Bool
        switch notifier.authorization {
        case .denied:
            allowed = false
            phone.append(.navigate("Bildirimler kapalı", detail: "iOS Ayarlar → Studio → Bildirimler'den aç", icon: "bell.slash", tint: IOSTheme.accent) {
                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
            })
        case .notDetermined:
            allowed = false
            phone.append(.action("Bildirimlere izin ver", detail: "Post hazır olunca ve onayın beklenince haber ver", icon: "bell.badge") {
                Task { await notifier.requestAuthorization() }
            })
        default:
            allowed = true
        }
        for category in ActivityNotice.Category.allCases {
            phone.append(.toggle(category.label, icon: Self.icon(category), isOn: app.settings.isNoticeEnabled(category), enabled: allowed) { [weak self] on in
                self?.app.settings.setNotice(category, enabled: on)
            })
        }
        let values = store.hostValues
        return [
            SettingsSection("Bu iPhone", footer: "Uygulama açıkken ve kısa süre arka plandayken anında; kapalıyken iOS'un izin verdiği aralıklarla gelir.", rows: phone),
            SettingsSection("Mac", footer: store.hostError ?? "Yayınlandı / yayınlanamadı, uzun süren işler ve süresi dolmak üzere olan hesaplar.", rows: [
                .toggle("macOS bildirimleri", icon: "laptopcomputer", isOn: values?.notificationsEnabled ?? false, enabled: store.canChange && values != nil) { [weak self] on in
                    self?.run { try await self?.store.changeHost(values: HostSettingsPatch(notificationsEnabled: on)) }
                },
            ]),
        ]
    }
}

/// Ayarlar → Hakkında: this app's version, the Mac app's version and how it updates.
final class SettingsAboutViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Hakkında")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async { await store.loadHost() }

    override func buildSections() -> [SettingsSection] {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        var sections = [SettingsSection("Bu iPhone", rows: [.info("Studio", value: "\(version) (\(build))", icon: "iphone")])]
        if let info = store.host?.state?.info {
            sections.append(SettingsSection("Mac", footer: info.updatesNote.isEmpty ? nil : info.updatesNote, rows: [
                .info("Studio", value: info.appVersion, icon: "laptopcomputer"),
                .info("Kurulum", value: info.mode == "dev" ? "Geliştirme kopyası" : "Studio.app"),
                .info("Mac", value: info.macName),
            ]))
        } else if let error = store.hostError {
            sections.append(SettingsSection("Mac", footer: error, rows: []))
        }
        return sections
    }
}
