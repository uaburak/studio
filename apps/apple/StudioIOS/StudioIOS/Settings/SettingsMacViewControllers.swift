import StudioKit
import UIKit

/// Ayarlar → Gelişmiş: the Mac host as the Mac app's Gelişmiş shows it, through the settings
/// bridge: state and server health, starting with the Mac and keeping it awake, local network
/// access, remote access (switch, tunnel address and token), the worker's keys; then this
/// iPhone's own connection details. A change that would cut the connection the phone is using
/// right now is refused here (and by the API) with a plain explanation; the others that drop
/// the connection for a moment ask first.
final class SettingsMacAdvancedViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Gelişmiş")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async {
        async let host: Void = store.loadHost()
        async let health: Void = store.loadHealth()
        _ = await (host, health)
    }

    override func buildSections() -> [SettingsSection] {
        var sections: [SettingsSection] = []
        let view = store.host
        let state = view?.state
        let values = store.hostValues
        let canChange = store.canChange && state != nil

        // Mac and its server
        var status: [SettingsRow] = []
        var statusFooter: [String] = []
        if let info = state?.info {
            status.append(.info("Durum", detail: info.hostStatus, icon: info.hostError ? "exclamationmark.triangle" : "checkmark.circle", tint: info.hostError ? IOSTheme.accent : nil))
            status.append(.info("Studio sunucusu", value: info.hostEnabled ? "Bu Mac'te çalışıyor" : "Başka bir sunucuya bağlı"))
            let ports = [info.apiPort.map { "API \($0)" }, info.lanPort.map { "Yerel ağ \($0)" }].compactMap { $0 }
            if !ports.isEmpty { status.append(.info("Portlar", value: ports.joined(separator: " · "))) }
            status.append(.action("Sunucuyu yeniden başlat", icon: "arrow.clockwise", enabled: canChange) { [weak self] in
                self?.restartServer()
            })
        } else {
            status.append(.info("Mac ayarları okunamadı", detail: store.hostError ?? "Mac'e bağlanınca görünür.", icon: "laptopcomputer.slash"))
        }
        if let view, !view.live, state != nil {
            statusFooter.append("Mac'teki Studio son \(view.seenAt.map { AssistantStatus.relative($0) } ?? "bir süredir") eşitlemedi; değişiklikler Mac'teki uygulama açılınca uygulanır.")
        }
        if store.waitingForMac { statusFooter.append("Değişiklik Mac'e iletiliyor…") }
        if let failure = view?.lastFailure, let message = failure.message { statusFooter.append("Son değişiklik uygulanamadı: \(message)") }
        if !store.canChange { statusFooter.append("Mac'e ulaşılamıyor; son bilinen değerler gösteriliyor.") }
        sections.append(SettingsSection("Mac", footer: statusFooter.isEmpty ? nil : statusFooter.joined(separator: "\n"), rows: status))

        // Server health (/api/health components)
        var health: [SettingsRow] = []
        for component in store.health?.components ?? [] {
            let (icon, tint): (String, UIColor?) = switch component.state {
            case "ok": ("checkmark.circle", nil)
            case "warn": ("exclamationmark.circle", IOSTheme.accent)
            default: ("xmark.octagon", .systemRed)
            }
            health.append(.info(component.label, detail: component.detail.isEmpty ? nil : component.detail, icon: icon, tint: tint))
        }
        if let migrations = store.health?.migrations {
            health.append(.info("Veritabanı sürümü", value: migrations.last == migrations.expected ? "Güncel" : "\(migrations.applied) göç · beklenen \(migrations.expected)"))
        }
        if health.isEmpty { health.append(.info(store.healthError ?? "Denetleniyor…")) }
        health.append(.action("Denetle", icon: "stethoscope") { [weak self] in
            Task { await self?.store.loadHealth() }
        })
        sections.append(SettingsSection("Sunucu sağlığı", footer: "Veritabanı, depo, worker, tuval çalıştırıcısı, kasa, bulut yayıncı ve tünel.", rows: health))

        guard let values, let info = state?.info else {
            sections.append(connectionSection())
            return sections
        }

        // Start and sleep
        let awakeDetail = values.keepAwake && info.keepAwakeActive ? "Şu an uyanık: \(info.keepAwakeReason ?? "iş var")." : "İşler sürerken ya da bir saat içinde zamanlanmış yayın varken Mac uykuya geçmez (ekran kapanabilir)."
        sections.append(SettingsSection("Başlangıç ve uyku", rows: [
            .toggle("Mac açılınca Studio'yu başlat", detail: info.loginItemNote.isEmpty ? nil : info.loginItemNote, isOn: values.loginItem, enabled: canChange && info.loginItemSupported) { [weak self] on in
                self?.send(HostSettingsChangeCreate(values: HostSettingsPatch(loginItem: on)))
            },
            .toggle("Mac'i uyanık tut", detail: awakeDetail, isOn: values.keepAwake, enabled: canChange) { [weak self] on in
                self?.send(HostSettingsChangeCreate(values: HostSettingsPatch(keepAwake: on)))
            },
        ]))

        // Local network
        let lanDetail: String = values.lanEnabled
            ? (info.lanUrls.isEmpty ? "Telefonlar aynı ağda Bonjour ile bulur; eşleştirme gerekir." : "Telefonlar: \(info.lanUrls.joined(separator: ", ")) · Bonjour ile bulunur.")
            : "Kapalı: Mac'e yalnızca kendisinden ve uzaktan erişimle ulaşılır."
        sections.append(SettingsSection("Yerel ağ", footer: store.via == .lan ? "Bu iPhone şu an yerel ağdan bağlı." : nil, rows: [
            .toggle("Yerel ağdan erişim", detail: lanDetail, isOn: values.lanEnabled, enabled: canChange) { [weak self] on in
                self?.send(
                    HostSettingsChangeCreate(values: HostSettingsPatch(lanEnabled: on)),
                    confirm: ("Yerel ağ erişimi \(on ? "açılsın" : "kapatılsın") mı?", "Studio sunucusu birkaç saniye yeniden başlar; çalışan işler kısa süre durur.", on ? "Aç" : "Kapat"))
            },
        ]))

        // Remote access
        let tunnelKey = state?.key(.cloudflareTunnelToken)
        let remoteDetail = values.remoteControlEnabled
            ? info.tunnel.detail
            : (values.remoteHostname.isEmpty ? "Kapalı. Açınca ev dışındaki iPhone tünel adresi üzerinden bağlanır." : "Kapalı. Açınca ev dışındaki iPhone https://\(values.remoteHostname) ile bağlanır.")
        sections.append(SettingsSection("Uzaktan erişim", footer: store.via == .tunnel ? "Bu iPhone şu an uzaktan erişimle bağlı: uzaktan erişimi kapatmak, adresini ya da anahtarını değiştirmek bağlantıyı keser; bunları aynı Wi-Fi'deyken ya da Mac'te yap." : "Cloudflare Tunnel. Anahtar (CLOUDFLARE_TUNNEL_TOKEN) Mac'te şifreli saklanır.", rows: [
            .toggle("Uzaktan erişim", detail: remoteDetail, isOn: values.remoteControlEnabled, enabled: canChange) { [weak self] on in
                self?.send(
                    HostSettingsChangeCreate(values: HostSettingsPatch(remoteControlEnabled: on)),
                    confirm: ("Uzaktan erişim \(on ? "açılsın" : "kapatılsın") mı?", on ? "Studio sunucusu birkaç saniye yeniden başlar." : "Ev dışındayken bu iPhone Mac'e bağlanamaz. Studio sunucusu birkaç saniye yeniden başlar.", on ? "Aç" : "Kapat"))
            },
            .navigate("Tünel adresi", value: values.remoteHostname.isEmpty ? "Yok" : values.remoteHostname, icon: "globe", enabled: canChange) { [weak self] in
                self?.editHostname(values.remoteHostname)
            },
            .navigate("Tünel anahtarı", value: tunnelKey?.statusText ?? "—", icon: "key", enabled: canChange) { [weak self] in
                guard let self else { return }
                if self.store.via == .tunnel {
                    self.presentError(HostLockout.tunnel, title: "Bu bağlantıdan yapılamaz")
                    return
                }
                self.editHostKey(title: "Tünel anahtarı", key: tunnelKey, name: .cloudflareTunnelToken)
            },
        ]))

        // Worker keys
        let workerKeys = (state?.keys ?? []).filter { $0.group == .worker }
        var keyRows: [SettingsRow] = workerKeys.map { key in
            .navigate(key.label, value: key.statusText, icon: key.secret ? "key" : "textformat", enabled: canChange) { [weak self] in
                self?.editHostKey(title: key.label, key: key, name: key.name)
            }
        }
        keyRows.append(.action("Sunucuyu yeniden başlat", detail: "Yeni anahtarlar worker'a sunucu yeniden başlayınca geçer.", icon: "arrow.clockwise", enabled: canChange) { [weak self] in
            self?.restartServer()
        })
        sections.append(SettingsSection("Worker anahtarları", footer: (info.keysSealed ? "Değerler Mac'te şifreli saklanır" : "Mac'te Anahtar Zinciri erişimi yok: değerler şifresiz (yalnızca senin okuyabileceğin) dosyada") + "; telefona geri gönderilmez.", rows: keyRows))

        sections.append(connectionSection())
        sections.append(SettingsSection(footer: "Depo klasörü, yedekleme ve geri yükleme, kayıt klasörü ve sunucuyu bu Mac'te çalıştırma ayarı yalnızca Mac'teki Studio'dan değişir (dosya seçme ve süreç yönetimi Mac'te).", rows: []))
        return sections
    }

    private func connectionSection() -> SettingsSection {
        SettingsSection("Bu iPhone", rows: [
            .navigate("Bağlantı ayrıntıları", detail: "Kullanılan adres, yerel ağdaki Mac'ler, ek uzak adres", icon: "antenna.radiowaves.left.and.right") { [weak self] in
                guard let self else { return }
                self.push(IOSAdvancedConnectionViewController(app: self.app))
            },
        ])
    }

    // MARK: Changes

    /// Refuse what would cut the phone's own route (with the API's words), ask when the
    /// connection drops for a moment, then queue the change. A cancelled switch flips back.
    private func send(_ input: HostSettingsChangeCreate, confirm question: (String, String, String)? = nil) {
        if input.cuts(store.via, current: store.host?.state?.values) {
            Haptics.warning()
            presentError(store.via == .tunnel ? HostLockout.tunnel : HostLockout.lan, title: "Bu bağlantıdan yapılamaz")
            rebuild()
            return
        }
        let go = { [weak self] in
            guard let self else { return }
            Task {
                do {
                    try await self.store.changeHost(input)
                } catch {
                    Haptics.error()
                    self.presentError(IOSSettingsStore.describe(error))
                    self.rebuild()
                }
            }
        }
        guard let (title, message, action) = question else { return go() }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel) { [weak self] _ in self?.rebuild() })
        alert.addAction(UIAlertAction(title: action, style: .default) { _ in go() })
        present(alert, animated: true)
    }

    private func restartServer() {
        confirm("Sunucu yeniden başlatılsın mı?", message: "Mac'teki Studio sunucusu birkaç saniye durur; çalışan işler kesilir ve yeniden denenir. Telefon kendiliğinden yeniden bağlanır.", action: "Yeniden başlat") { [weak self] in
            self?.send(HostSettingsChangeCreate(values: HostSettingsPatch(restartHost: true)))
        }
    }

    private func editHostname(_ current: String) {
        if store.via == .tunnel {
            presentError(HostLockout.tunnel, title: "Bu bağlantıdan yapılamaz")
            return
        }
        enterText(title: "Tünel adresi", message: "Cloudflare tünelinin genel adresi (ör. studio.ornek.com). Değişince tünel yeniden başlar.", placeholder: "studio.ornek.com", text: current, secure: false, keyboard: .URL) { [weak self] value in
            guard let self else { return }
            try await self.store.changeHost(values: HostSettingsPatch(remoteHostname: value))
        }
    }
}
