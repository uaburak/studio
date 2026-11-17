import AppKit
import StudioKit

/// Settings → "Gelişmiş": the local API + LAN gateway + worker (`LocalHost`), remote
/// access (Cloudflare Tunnel), logs, and — for when the app does not run its own
/// server — the external server address and its Cloudflare Access key.
final class MacServerSectionView: SettingsPaneView, NSTextFieldDelegate {
    private unowned let app: AppModel
    private unowned let settings: AppSettings
    private let host: LocalHost?
    private let external: ExternalServerRows

    private var hostToggle: NSSwitch!
    private var statusRow: SettingsRowView!
    private var restartButton: PillButton!
    private var lanToggle: NSSwitch!
    private var lanRow: SettingsRowView!
    private var repoRow: SettingsRowView!
    private var remoteToggle: NSSwitch!
    private var remoteRow: SettingsRowView!
    private var tunnelRow: SettingsRowView!
    private var errorRow: SettingsRowView!
    private var logsRow: SettingsRowView!
    private var forgetTunnelRow: SettingsRowView!
    private var hostOnlyBlocks: [SettingsBlock] = []
    private let remoteHostnameField = SettingsControls.field(AppSettings.defaultRemoteHostname, width: nil)
    private let tunnelTokenField = SettingsControls.field("CLOUDFLARE_TUNNEL_TOKEN", secure: true, width: nil)
    private let repoField = SettingsControls.field("Depo klasörü", width: nil)
    private let errorScroll = NSScrollView()
    private let errorTextView = NSTextView()

    private var busy = false
    private var observation: ObservationToken?

    init(app: AppModel, settings: AppSettings, host: LocalHost?) {
        self.app = app
        self.settings = settings
        self.host = host
        self.external = ExternalServerRows(app: app, settings: settings)
        super.init(section: .macServer)

        if let host {
            buildHostRows(host)
        } else {
            addNote(app.isSample
                ? "Örnek verilerle açıldı (-StudioSampleData YES): sunucu ayarları bu oturumda kullanılmıyor."
                : "Bu oturumda Studio sunucusu yok; uygulama aşağıdaki adrese bağlanır.")
        }

        addSubheader("Harici sunucu")
        add(external.serverRow())
        add(external.accessRow())

        // Destructive actions last, each in its own row.
        if host != nil {
            let forget = PillButton(title: "Sil", kind: .outline, height: 26) { [weak self] in self?.clearTunnelToken() }
            forgetTunnelRow = addRow(SettingsCatalog.forgetTunnel, accessory: forget)
        }
        add(external.makeForgetRow())

        if host != nil {
            observation = observe { [weak self] in self?.render() }
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildHostRows(_ host: LocalHost) {
        hostToggle = SettingsControls.toggle(target: self, action: #selector(toggleHostEnabled))
        hostToggle.setAccessibilityLabel(SettingsCatalog.hostEnabled.title)
        addRow(SettingsCatalog.hostEnabled, accessory: hostToggle).tagText = "Bu Mac"

        restartButton = PillButton(title: "Yeniden başlat", kind: .secondary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.restartHost() }
        }
        statusRow = addRow(SettingsCatalog.hostStatus, accessory: restartButton)

        lanToggle = SettingsControls.toggle(target: self, action: #selector(toggleLanEnabled))
        lanToggle.setAccessibilityLabel(SettingsCatalog.lan.title)
        lanRow = addRow(SettingsCatalog.lan, accessory: lanToggle)

        repoField.stringValue = settings.repoPath
        repoField.delegate = self
        let saveRepo = PillButton(title: "Kaydet", kind: .secondary, height: 26) { [weak self] in self?.saveRepo() }
        repoRow = addRow(SettingsCatalog.repo, footer: SettingsControls.formFooter(fields: [repoField], buttons: [saveRepo]))

        let remoteHeader = addSubheader("Uzaktan erişim")
        remoteToggle = SettingsControls.toggle(target: self, action: #selector(toggleRemoteEnabled))
        remoteToggle.setAccessibilityLabel(SettingsCatalog.remote.title)
        remoteRow = addRow(SettingsCatalog.remote, accessory: remoteToggle)

        remoteHostnameField.stringValue = settings.remoteHostname
        remoteHostnameField.delegate = self
        tunnelTokenField.delegate = self
        let saveTunnel = PillButton(title: "Kaydet ve uygula", kind: .secondary, height: 26) { [weak self] in self?.saveTunnelSettings() }
        tunnelRow = addRow(SettingsCatalog.tunnel, footer: SettingsControls.formFooter(fields: [remoteHostnameField, tunnelTokenField], buttons: [saveTunnel]))

        let logsHeader = addSubheader("Kayıtlar")
        errorScroll.drawsBackground = true
        errorScroll.backgroundColor = Theme.fill
        errorScroll.borderType = .noBorder
        errorScroll.hasVerticalScroller = true
        errorScroll.applyMinimalScroller()
        errorScroll.wantsLayer = true
        errorScroll.layer?.cornerRadius = 8
        errorScroll.translatesAutoresizingMaskIntoConstraints = false
        errorScroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
        errorTextView.isEditable = false
        errorTextView.isSelectable = true
        errorTextView.drawsBackground = false
        errorTextView.textContainerInset = NSSize(width: 6, height: 6)
        errorTextView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        errorTextView.textColor = Theme.textPrimary
        errorTextView.isVerticallyResizable = true
        errorTextView.autoresizingMask = [.width]
        errorScroll.documentView = errorTextView
        errorRow = addRow(SettingsCatalog.errorLog, footer: errorScroll)

        let openLogs = PillButton(title: "Aç", kind: .secondary, height: 26) { [weak host] in
            guard let host else { return }
            NSWorkspace.shared.open(host.logsDirectory)
        }
        logsRow = addRow(SettingsCatalog.logsFolder, detail: "\(SettingsCatalog.logsFolder.detail) \(host.logsDirectory.path)", accessory: openLogs)

        // Everything but the main switch hides while the app does not run its own server.
        hostOnlyBlocks = [statusRow, lanRow, repoRow, remoteHeader, remoteRow, tunnelRow, logsHeader, logsRow]
    }

    private func render() {
        guard let host else { return }
        let enabled = settings.hostEnabled
        hostToggle.state = enabled ? .on : .off
        hostOnlyBlocks.forEach { $0.isAvailable = enabled }

        let hasSavedTunnelToken = (try? settings.tunnelTokens.load()) != nil
        forgetTunnelRow?.isAvailable = enabled && hasSavedTunnelToken

        let log = host.errorLog
        errorRow.isAvailable = enabled && !log.isEmpty
        if errorTextView.string != log { errorTextView.string = log }
        guard enabled else { return }

        var status: String
        switch host.status {
        case .running: status = "Çalışıyor · \(host.apiURL?.absoluteString ?? "")"
        case .attached: status = "Bu Mac'te zaten çalışan Studio sunucusuna bağlandı · \(host.apiURL?.absoluteString ?? "")"
        case .starting(let step): status = "Başlatılıyor: \(step)…"
        case .error(let msg): status = "Hata: \(msg)"
        case .stopped: status = "Durdu."
        }
        if case .error = host.status { statusRow.detailColor = Theme.accent } else { statusRow.detailColor = Theme.textSecondary }
        let phaseSummary = LocalHost.Service.allCases.compactMap { service in
            host.phases[service].map { "\(service.label): \(Self.describe($0))" }
        }.joined(separator: " · ")
        if !phaseSummary.isEmpty { status += "\n\(phaseSummary)" }
        statusRow.detail = status
        restartButton.showsSpinner = busy
        restartButton.isEnabled = !busy

        lanToggle.state = settings.lanEnabled ? .on : .off
        if settings.lanEnabled {
            let urls = host.lanURLs
            lanRow.detail = urls.isEmpty
                ? "Telefonlar aynı ağda Bonjour ile bulur (_studio._tcp); eşleştirme gerekir."
                : "Telefonlar: \(urls.joined(separator: ", ")) · Bonjour ile bulunur; eşleştirme gerekir."
        } else {
            lanRow.detail = "Kapalı: API yalnızca bu Mac'ten (127.0.0.1) erişilebilir."
        }

        remoteToggle.state = settings.remoteControlEnabled ? .on : .off
        let cleanHost = LocalHost.normalizedHostname(settings.remoteHostname)
        if settings.remoteControlEnabled {
            let phaseText = host.phases[.tunnel].map { "Durum: \(Self.describe($0)). " } ?? ""
            if let note = host.tunnelNote, !note.isEmpty {
                remoteRow.detail = phaseText + note
            } else if hasSavedTunnelToken {
                remoteRow.detail = phaseText + "Anahtar kayıtlı · eşleşmiş telefonlar ev dışından https://\(cleanHost) ile bağlanır."
            } else {
                remoteRow.detail = "Kurulum: `brew install cloudflared`, sonra Cloudflare Zero Trust → Tunnels'tan aldığın CLOUDFLARE_TUNNEL_TOKEN'ı aşağıya kaydet."
            }
        } else {
            remoteRow.detail = "Kapalı. Açınca ev dışındaki iPhone https://\(cleanHost) üzerinden Cloudflare Tunnel ile bağlanır."
        }
        if let tunnelTokenError { remoteRow.detail = tunnelTokenError }
    }

    static func describe(_ phase: ServiceSupervisor.Phase) -> String {
        switch phase {
        case .idle: "bekliyor"
        case .running: "çalışıyor"
        case .restarting(_, let delay): "yeniden başlıyor (\(Int(delay.components.seconds)) sn)"
        case .failed: "durdu (hata)"
        case .stopped: "durdu"
        }
    }

    @objc private func toggleHostEnabled() {
        let next = hostToggle.state == .on
        settings.hostEnabled = next
        Task { await applyHost(enabled: next) }
    }

    @objc private func toggleLanEnabled() {
        settings.lanEnabled = lanToggle.state == .on
        Task { await restartHost() }
    }

    @objc private func toggleRemoteEnabled() {
        settings.remoteControlEnabled = remoteToggle.state == .on
        Task { await restartHost() }
    }

    private func saveTunnelSettings() {
        let hostText = LocalHost.normalizedHostname(remoteHostnameField.stringValue)
        settings.remoteHostname = hostText
        remoteHostnameField.stringValue = hostText
        let token = tunnelTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        tunnelTokenError = nil
        if !token.isEmpty {
            do {
                try settings.tunnelTokens.save(token)
                tunnelTokenField.stringValue = ""
            } catch {
                // Keep what was typed and say so (it used to look saved).
                tunnelTokenError = "Tünel anahtarı Anahtar Zinciri'ne kaydedilemedi: \(error.localizedDescription)"
            }
        }
        render()
        if settings.remoteControlEnabled {
            Task { await restartHost() }
        }
    }

    private var tunnelTokenError: String?

    private func clearTunnelToken() {
        tunnelTokenError = nil
        try? settings.tunnelTokens.delete()
        tunnelTokenField.stringValue = ""
        render()
        if settings.remoteControlEnabled {
            Task { await restartHost() }
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
        if control === repoField {
            saveRepo()
            return true
        }
        if control === remoteHostnameField || control === tunnelTokenField {
            saveTunnelSettings()
            return true
        }
        return false
    }

    private func saveRepo() {
        let trimmed = repoField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != settings.repoPath else { return }
        settings.repoPath = trimmed
        Task { await restartHost() }
    }

    private func restartHost() async {
        guard let host else { return }
        busy = true
        render()
        defer { busy = false; render() }
        ActiveHost.current = host
        await host.restart()
        settings.hostAPIURL = host.apiURL
        app.reconnect()
    }

    private func applyHost(enabled: Bool) async {
        guard let host else { return }
        busy = true
        render()
        defer { busy = false; render() }
        if enabled {
            ActiveHost.current = host
            await host.start()
            settings.hostAPIURL = host.apiURL
        } else {
            await host.stop()
            settings.hostAPIURL = nil
        }
        app.reconnect()
    }
}
