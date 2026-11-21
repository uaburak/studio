import StudioKit
import UIKit

/// Ayarlar → Hesaplar: every brand's social accounts with their connection state (check, and
/// disconnect), and the Meta / LinkedIn app credentials the Mac connects with. Connecting a new
/// account opens a browser sign-in on the Mac, so it starts there.
final class SettingsAccountsViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Hesaplar")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async {
        await store.loadHost()
        if let accounts = try? await app.dataService.socialAccounts(brandId: nil) { app.accounts = accounts }
    }

    static func accountLine(_ account: SocialAccount) -> String {
        var parts = [account.status.label]
        if let health = account.tokenHealth, health != .valid, account.status == .connected { parts.append(health.label) }
        if let expires = account.tokenExpiresAt, account.status == .connected {
            parts.append("bitiş \(expires.formatted(date: .abbreviated, time: .omitted))")
        }
        return parts.joined(separator: " · ")
    }

    override func buildSections() -> [SettingsSection] {
        var sections: [SettingsSection] = []
        let brands = app.brands.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        for brand in brands {
            let accounts = app.accounts.filter { $0.brandId == brand.id }
            guard !accounts.isEmpty else { continue }
            sections.append(SettingsSection(brand.name, rows: accounts.map { account in
                let warn = account.status == .needsReauth || account.tokenHealth == .invalid || account.tokenHealth == .expiringSoon
                return .navigate("\(account.platform.displayName) · \(account.handle)", detail: Self.accountLine(account), icon: "person.crop.circle", tint: warn ? IOSTheme.accent : nil) { [weak self] in
                    guard let self else { return }
                    self.push(SettingsAccountViewController(app: self.app, accountId: account.id))
                }
            }))
        }
        if sections.isEmpty {
            sections.append(SettingsSection(rows: [.info("Bağlı hesap yok", detail: "Instagram, Facebook ve LinkedIn hesapları Mac'te Ayarlar → Hesaplar'dan bağlanır.")]))
        }

        let values = store.hostValues
        let state = store.host?.state
        let canChange = store.canChange && values != nil
        sections.append(SettingsSection("Meta uygulaması", footer: "Instagram ve Facebook için kendi Meta uygulaman. Secret Mac'te şifreli saklanır; telefona geri gönderilmez.", rows: [
            .navigate("App ID", value: values.map { $0.metaAppId.isEmpty ? "Yok" : $0.metaAppId } ?? "—", icon: "number", enabled: canChange) { [weak self] in
                guard let self else { return }
                self.enterText(title: "Meta App ID", message: "Yalnızca rakamlar.", placeholder: "1234567890", text: values?.metaAppId, secure: false, keyboard: .numberPad) { id in
                    try await self.store.changeHost(values: HostSettingsPatch(metaAppId: id))
                }
            },
            secretRow("App Secret", key: state?.key(.metaAppSecret), name: .metaAppSecret, enabled: canChange),
        ]))
        sections.append(SettingsSection("LinkedIn uygulaması", footer: "LinkedIn'e yayın için kendi LinkedIn uygulaman.", rows: [
            .navigate("Client ID", value: values.map { $0.linkedInClientId.isEmpty ? "Yok" : $0.linkedInClientId } ?? "—", icon: "number", enabled: canChange) { [weak self] in
                guard let self else { return }
                self.enterText(title: "LinkedIn Client ID", message: nil, placeholder: "Client ID", text: values?.linkedInClientId, secure: false) { id in
                    try await self.store.changeHost(values: HostSettingsPatch(linkedInClientId: id))
                }
            },
            secretRow("Client Secret", key: state?.key(.linkedInClientSecret), name: .linkedInClientSecret, enabled: canChange),
        ]))
        return sections
    }

    private func secretRow(_ title: String, key: HostKeyState?, name: HostKeyName, enabled: Bool) -> SettingsRow {
        .navigate(title, value: key?.statusText ?? "—", icon: "key", enabled: enabled) { [weak self] in
            self?.editHostKey(title: title, key: key, name: name)
        }
    }
}

extension SettingsTableViewController {
    /// A Mac key: paste a new value (sent once, never shown again) or remove it.
    func editHostKey(title: String, key: HostKeyState?, name: HostKeyName, confirmCut: Bool = false) {
        let sheet = UIAlertController(title: title, message: key?.saved == true ? "Kayıtlı. Değer telefona geri gönderilmez." : "Kayıtlı değil.", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: key?.saved == true ? "Yeni değer yapıştır" : "Değeri yapıştır", style: .default) { [weak self] _ in
            guard let self else { return }
            self.enterText(title: title, message: "Değer bir kez gönderilir ve Mac'te saklanır; burada bir daha gösterilmez.", placeholder: key?.name.rawValue ?? title, secure: key?.secret ?? true) { value in
                try await self.store.changeHost(keys: [HostKeyChange(name: name, value: value)])
            }
        })
        if key?.saved == true, key?.source != .envFile {
            sheet.addAction(UIAlertAction(title: "Sil", style: .destructive) { [weak self] _ in
                guard let self else { return }
                self.confirm("\(title) silinsin mi?", message: nil, action: "Sil") {
                    self.run("Silindi") { try await self.store.changeHost(keys: [HostKeyChange(name: name, value: nil)]) }
                }
            })
        }
        sheet.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        present(sheet, animated: true)
    }
}

/// One social account: state, token expiry, check now, disconnect.
final class SettingsAccountViewController: SettingsTableViewController {
    private let accountId: EntityID

    init(app: IOSAppModel, accountId: EntityID) {
        self.accountId = accountId
        super.init(app: app, title: "Hesap")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var account: SocialAccount? { app.accounts.first { $0.id == accountId } }

    override func buildSections() -> [SettingsSection] {
        guard let account else { return [SettingsSection(rows: [.info("Hesap bulunamadı")])] }
        title = account.platform.displayName
        var info: [SettingsRow] = [
            .info("Hesap", value: account.handle),
            .info("Marka", value: app.brand(account.brandId)?.name ?? "—"),
            .info("Durum", value: account.status.label),
        ]
        if let health = account.tokenHealth { info.append(.info("Erişim", value: health.label)) }
        if let expires = account.tokenExpiresAt { info.append(.info("Bitiş", value: expires.formatted(date: .abbreviated, time: .shortened))) }
        if let checked = account.tokenCheckedAt { info.append(.info("Denetlendi", value: AssistantStatus.relative(checked))) }
        var sections = [SettingsSection(footer: account.status == .needsReauth ? "Yeniden bağlamak için Mac'te Ayarlar → Hesaplar'da girişi yenile." : nil, rows: info)]
        sections.append(SettingsSection(footer: account.platform == .linkedin ? nil : "Meta hesapları burada bitiş tarihine göre denetlenir; canlı denetim Mac'te yapılır.", rows: [
            .action("Şimdi denetle", icon: "checkmark.shield", enabled: store.canChange && account.hasToken != false) { [weak self] in
                guard let self else { return }
                self.run("Denetlendi") {
                    let updated = try await self.app.dataService.checkSocialAccount(id: account.id, SocialAccountCheckInput(live: account.platform == .linkedin))
                    self.replace(updated)
                }
            },
        ]))
        if account.status != .disabled {
            sections.append(SettingsSection(rows: [
                .action("Bağlantıyı kes", icon: "link.badge.plus", destructive: true, enabled: store.canChange) { [weak self] in
                    guard let self else { return }
                    self.confirm("\(account.handle) bağlantısı kesilsin mi?", message: "Erişim anahtarı silinir; bekleyen zamanlanmış yayın varsa kesilmez. Yeniden bağlamak Mac'ten yapılır.", action: "Bağlantıyı kes") {
                        self.run("Bağlantı kesildi") {
                            let updated = try await self.app.dataService.disconnectSocialAccount(id: account.id)
                            self.replace(updated)
                        }
                    }
                },
            ]))
        }
        return sections
    }

    private func replace(_ account: SocialAccount) {
        if let index = app.accounts.firstIndex(where: { $0.id == account.id }) { app.accounts[index] = account }
    }
}

/// Ayarlar → Yayın: who publishes (this Mac or the cloud publisher), the last sync, the cloud
/// publisher's address and token, and how late a schedule may still go out.
final class SettingsPublishingViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Yayın")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async { await store.loadPublishing() }

    static func latenessText(_ minutes: Int) -> String {
        if minutes % (24 * 60) == 0 { return "\(minutes / (24 * 60)) gün" }
        if minutes % 60 == 0 { return "\(minutes / 60) saat" }
        return "\(minutes) dakika"
    }

    override func buildSections() -> [SettingsSection] {
        guard let status = store.publishing else { return [SettingsSection(rows: [.info("Okunuyor…")])] }
        let cloud = status.cloud
        var state: [SettingsRow] = [
            .info("Yayını yapan", value: status.mode == .cloud ? "Bulut yayıncı" : "Bu Mac", icon: status.mode == .cloud ? "cloud" : "laptopcomputer"),
        ]
        if cloud.configured {
            let sync: String = if let at = cloud.lastSyncAt {
                cloud.lastSyncOk == false ? "Hata · \(AssistantStatus.relative(at))" : AssistantStatus.relative(at)
            } else {
                "Henüz yok"
            }
            state.append(.info("Son eşitleme", detail: cloud.lastSyncOk == false ? cloud.lastSyncError : nil, value: sync, icon: "arrow.triangle.2.circlepath", tint: cloud.lastSyncOk == false ? IOSTheme.accent : nil))
            state.append(.action("Şimdi eşitle", icon: "arrow.clockwise", enabled: store.canChange) { [weak self] in
                self?.run("Eşitleme istendi") { try await self?.store.syncPublishing() }
            })
        }
        var sections = [SettingsSection(footer: status.vaultReady ? nil : "Mac'in kasa anahtarı yok; hesap anahtarları saklanamıyor.", rows: state)]

        var cloudRows: [SettingsRow] = [
            .navigate(cloud.configured ? "Bulut yayıncıyı değiştir" : "Bulut yayıncı kur", detail: cloud.url, icon: "cloud", enabled: store.canChange) { [weak self] in
                self?.setCloud(current: cloud.url)
            },
        ]
        if cloud.configured {
            cloudRows.append(.action("Bulut yayıncıyı kaldır", icon: "trash", destructive: true, enabled: store.canChange) { [weak self] in
                guard let self else { return }
                self.confirm("Bulut yayıncı kaldırılsın mı?", message: "Bundan sonra yayını bu Mac yapar; Mac kapalıyken zamanlanmış postlar gitmez.", action: "Kaldır") {
                    self.run("Kaldırıldı") { try await self.store.clearCloudPublisher() }
                }
            })
        }
        sections.append(SettingsSection("Bulut yayıncı", footer: "Mac kapalıyken de zamanında paylaşır. Instagram ve Facebook görselleri için gerekir.", rows: cloudRows))

        let lateness = status.maxLatenessMinutes ?? 120
        let options = [15, 30, 60, 120, 240, 720, 1440, 2880, 10080]
        let menuOptions = (options.contains(lateness) ? options : (options + [lateness]).sorted()).map { ($0, Self.latenessText($0)) }
        sections.append(SettingsSection("Gecikme sınırı", footer: "Saati bundan uzun süre önce geçmiş bir yayın (Mac uykudaydı, bulut yayıncı kapalıydı) gönderilmez; kaçırıldı olarak işaretlenir ve yeniden zamanlanır.", rows: [
            .menu("En fazla", value: Self.latenessText(lateness), icon: "clock", enabled: store.canChange, Self.choiceMenu(menuOptions, selected: lateness) { [weak self] minutes in
                self?.run { try await self?.store.setMaxLateness(minutes: minutes) }
            }),
        ]))
        return sections
    }

    private func setCloud(current: String?) {
        let alert = UIAlertController(title: "Bulut yayıncı", message: "Cloudflare Worker'ın adresi ve anahtarı (PUBLISHER_TOKEN). Anahtar Mac'te şifreli saklanır; telefona geri gönderilmez.", preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "https://social.ornek.com"
            field.text = current
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addTextField { field in
            field.placeholder = "PUBLISHER_TOKEN"
            field.isSecureTextEntry = true
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
        alert.addAction(UIAlertAction(title: "Kaydet", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let url = (alert?.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let token = (alert?.textFields?.last?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard url.lowercased().hasPrefix("https://"), !token.isEmpty else {
                self.presentError("Adres https:// ile başlamalı ve anahtar boş olmamalı.")
                return
            }
            self.run("Bulut yayıncı kaydedildi") { try await self.store.setCloudPublisher(url: url, token: token) }
        })
        present(alert, animated: true)
    }
}

/// Ayarlar → Cihazlar: phones paired with the Mac; revoke the others (this iPhone forgets the
/// Mac from Ayarlar → Mac → Bağlantıyı kaldır).
final class SettingsDevicesViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Cihazlar")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async { await store.loadDevices() }

    override func buildSections() -> [SettingsSection] {
        guard let list = store.devices else { return [SettingsSection(rows: [.info("Okunuyor…")])] }
        let active = list.items.filter { !$0.isRevoked }
        let revoked = list.items.filter(\.isRevoked)
        var sections = [SettingsSection("Eşleşmiş", footer: "Yeni bir iPhone'u bağlamak için Mac'te Ayarlar → Cihazlar'daki QR kodu okut.", rows: active.map { device in
            let isThis = device.id == list.currentDeviceId
            let seen = device.lastSeenAt.map { "Son görülme \(AssistantStatus.relative($0))" } ?? "Hiç bağlanmadı"
            let detail = isThis ? "Bu iPhone · \(seen)" : seen
            if isThis { return .info(device.name, detail: detail, icon: "iphone", tint: IOSTheme.accent) }
            return .action(device.name, detail: detail, icon: "iphone", destructive: false, enabled: store.canChange) { [weak self] in
                self?.revoke(device)
            }
        })]
        if !revoked.isEmpty {
            sections.append(SettingsSection("Kaldırılanlar", rows: revoked.map { device in
                .info(device.name, detail: device.revokedAt.map { "Kaldırıldı \(AssistantStatus.relative($0))" }, icon: "iphone.slash")
            }))
        }
        return sections
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = super.tableView(tableView, cellForRowAt: indexPath)
        // Device names read as names, not as orange actions.
        if case .action = sections[indexPath.section].rows[indexPath.row].kind, var content = cell.contentConfiguration as? UIListContentConfiguration {
            content.textProperties.color = IOSTheme.textPrimary
            cell.contentConfiguration = content
            cell.accessoryType = .detailButton
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, accessoryButtonTappedForRowWith indexPath: IndexPath) {
        self.tableView(tableView, didSelectRowAt: indexPath)
    }

    private func revoke(_ device: PairedDevice) {
        confirm("\(device.name) kaldırılsın mı?", message: "Bu cihaz Mac'e bir daha bağlanamaz; yeniden eşleştirmek gerekir.", action: "Kaldır") { [weak self] in
            guard let self else { return }
            self.run("Kaldırıldı") { try await self.store.revokeDevice(device.id) }
        }
    }
}
