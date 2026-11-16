import AppKit
import StudioKit

/// Pure AppKit Settings → "Mac sunucusu": supervises local API + LAN gateway + worker (`LocalHost`).
final class MacServerSectionView: NSView, NSTextFieldDelegate {
    private unowned let app: AppModel
    private unowned let settings: AppSettings
    private let host: LocalHost

    private var hostToggle: NSButton!
    private let detailsStack = NSStackView()
    private let disabledNote = NSTextField.styledLabel(
        "Kapalı: uygulama aşağıdaki Sunucu adresine bağlanır (elle başlatılan API).",
        font: Theme.smallFont,
        color: Theme.textSecondary,
        wraps: true
    )

    private let statusDot = StatusDotView(size: 8)
    private let statusLabel = NSTextField(labelWithString: "")
    private var restartButton: PillButton!
    private let phasesLabel = NSTextField(wrappingLabelWithString: "")
    private var lanToggle: NSButton!
    private let lanNoteLabel = NSTextField(wrappingLabelWithString: "")
    private var remoteToggle: NSButton!
    private let remoteHostnameField = NSTextField()
    private let tunnelTokenField = NSSecureTextField()
    private var saveTunnelBtn: PillButton!
    private var clearTunnelBtn: PillButton!
    private let remoteNoteLabel = NSTextField(wrappingLabelWithString: "")
    private let repoField = NSTextField()
    private let errorScroll = NSScrollView()
    private let errorTextView = NSTextView()

    private var busy = false
    private var observation: ObservationToken?

    init(app: AppModel, settings: AppSettings, host: LocalHost) {
        self.app = app
        self.settings = settings
        self.host = host
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let group = SettingsGroupCardView(title: "Mac sunucusu")
        addSubview(group)
        NSLayoutConstraint.activate([
            group.leadingAnchor.constraint(equalTo: leadingAnchor),
            group.trailingAnchor.constraint(equalTo: trailingAnchor),
            group.topAnchor.constraint(equalTo: topAnchor),
            group.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        hostToggle = NSButton(checkboxWithTitle: "API ve worker'ı bu uygulama çalıştırsın", target: self, action: #selector(toggleHostEnabled))
        group.stack.addArrangedSubview(hostToggle)

        detailsStack.orientation = .vertical
        detailsStack.alignment = .leading
        detailsStack.spacing = 8
        detailsStack.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = Theme.smallFont
        statusLabel.textColor = Theme.textPrimary
        statusLabel.lineBreakMode = .byTruncatingTail
        let statusSpacer = NSView()
        statusSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        restartButton = PillButton(title: "Yeniden başlat", kind: .secondary, height: 24) { [weak self] in
            guard let self else { return }
            Task { await self.restartHost() }
        }
        let statusRow = NSStackView(views: [statusDot, statusLabel, statusSpacer, restartButton])
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 8
        detailsStack.addArrangedSubview(statusRow)
        statusRow.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        phasesLabel.font = Theme.smallFont
        phasesLabel.textColor = Theme.textSecondary
        detailsStack.addArrangedSubview(phasesLabel)
        phasesLabel.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        lanToggle = NSButton(checkboxWithTitle: "Yerel ağdan erişim", target: self, action: #selector(toggleLanEnabled))
        detailsStack.addArrangedSubview(lanToggle)

        lanNoteLabel.font = Theme.smallFont
        lanNoteLabel.textColor = Theme.textSecondary
        detailsStack.addArrangedSubview(lanNoteLabel)
        lanNoteLabel.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        let remoteDivider = HairlineView()
        detailsStack.addArrangedSubview(remoteDivider)
        remoteDivider.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        remoteToggle = NSButton(
            checkboxWithTitle: "Uzaktan erişim tüneli (Cloudflare Tunnel · L3)",
            target: self,
            action: #selector(toggleRemoteEnabled)
        )
        detailsStack.addArrangedSubview(remoteToggle)

        remoteHostnameField.stringValue = settings.remoteHostname
        remoteHostnameField.placeholderString = AppSettings.defaultRemoteHostname
        remoteHostnameField.bezelStyle = .roundedBezel
        remoteHostnameField.delegate = self
        detailsStack.addArrangedSubview(remoteHostnameField)
        remoteHostnameField.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        tunnelTokenField.placeholderString = "CLOUDFLARE_TUNNEL_TOKEN (Anahtar Zinciri'nde saklanır)"
        tunnelTokenField.bezelStyle = .roundedBezel
        tunnelTokenField.delegate = self
        detailsStack.addArrangedSubview(tunnelTokenField)
        tunnelTokenField.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        saveTunnelBtn = PillButton(title: "Tüneli kaydet ve uygula", kind: .secondary, height: 24) { [weak self] in
            self?.saveTunnelSettings()
        }
        clearTunnelBtn = PillButton(title: "Tünel anahtarını sil", kind: .secondary, height: 24) { [weak self] in
            self?.clearTunnelToken()
        }
        let tunnelBtns = NSStackView(views: [saveTunnelBtn, clearTunnelBtn])
        tunnelBtns.orientation = .horizontal
        tunnelBtns.spacing = 8
        detailsStack.addArrangedSubview(tunnelBtns)

        remoteNoteLabel.font = Theme.smallFont
        remoteNoteLabel.textColor = Theme.textSecondary
        detailsStack.addArrangedSubview(remoteNoteLabel)
        remoteNoteLabel.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        repoField.stringValue = settings.repoPath
        repoField.placeholderString = "Depo klasörü"
        repoField.bezelStyle = .roundedBezel
        repoField.delegate = self
        detailsStack.addArrangedSubview(repoField)
        repoField.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        let repoNote = NSTextField.styledLabel(
            "API ve worker bu klasördeki kaynaklardan çalışır (pnpm install yapılmış olmalı). Uygulamanın içine paketlenmesi sonraki adım. Veriler: \(host.stateDirectory.path)",
            font: Theme.smallFont,
            color: Theme.textSecondary,
            wraps: true
        )
        detailsStack.addArrangedSubview(repoNote)
        repoNote.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        errorScroll.drawsBackground = true
        errorScroll.backgroundColor = Theme.canvas
        errorScroll.borderType = .bezelBorder
        errorScroll.hasVerticalScroller = true
        errorScroll.translatesAutoresizingMaskIntoConstraints = false
        errorScroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
        errorTextView.isEditable = false
        errorTextView.isSelectable = true
        errorTextView.drawsBackground = false
        errorTextView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        errorTextView.textColor = Theme.textPrimary
        errorTextView.isVerticallyResizable = true
        errorTextView.autoresizingMask = [.width]
        errorScroll.documentView = errorTextView
        detailsStack.addArrangedSubview(errorScroll)
        errorScroll.widthAnchor.constraint(equalTo: detailsStack.widthAnchor).isActive = true

        let openLogsBtn = PillButton(title: "Kayıt klasörünü aç", kind: .secondary, height: 24) { [weak host] in
            guard let host else { return }
            NSWorkspace.shared.open(host.logsDirectory)
        }
        detailsStack.addArrangedSubview(openLogsBtn)

        group.addFullWidth(detailsStack)
        group.addFullWidth(disabledNote)

        observation = observe { [weak self] in
            self?.render()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func render() {
        let enabled = settings.hostEnabled
        hostToggle.state = enabled ? .on : .off
        detailsStack.isHidden = !enabled
        disabledNote.isHidden = enabled
        guard enabled else { return }

        switch host.status {
        case .running:
            statusDot.color = .systemGreen
            statusLabel.stringValue = "Çalışıyor · \(host.apiURL?.absoluteString ?? "")"
        case .attached:
            statusDot.color = .systemGreen
            statusLabel.stringValue = "Bu Mac'te zaten çalışan Studio sunucusuna bağlandı · \(host.apiURL?.absoluteString ?? "")"
        case .starting(let step):
            statusDot.color = .systemOrange
            statusLabel.stringValue = "Başlatılıyor: \(step)…"
        case .error(let msg):
            statusDot.color = .systemRed
            statusLabel.stringValue = "Hata: \(msg)"
        case .stopped:
            statusDot.color = Theme.textTertiary
            statusLabel.stringValue = "Durdu"
        }

        restartButton.showsSpinner = busy
        restartButton.isEnabled = !busy

        let phaseSummary = LocalHost.Service.allCases.compactMap { service in
            host.phases[service].map { "\(service.label): \(Self.describe($0))" }
        }.joined(separator: " · ")
        phasesLabel.stringValue = phaseSummary
        phasesLabel.isHidden = phaseSummary.isEmpty

        lanToggle.state = settings.lanEnabled ? .on : .off
        if settings.lanEnabled {
            let urls = host.lanURLs
            lanNoteLabel.stringValue = urls.isEmpty
                ? "Telefonlar aynı ağda Bonjour ile bulur (_studio._tcp); eşleştirme gerekir."
                : "Telefonlar: \(urls.joined(separator: ", ")) · Bonjour ile bulunur; eşleştirme gerekir."
        } else {
            lanNoteLabel.stringValue = "Kapalı: API yalnızca bu Mac'ten (127.0.0.1) erişilebilir."
        }

        remoteToggle.state = settings.remoteControlEnabled ? .on : .off
        let hasSavedTunnelToken = (try? settings.tunnelTokens.load()) != nil
        clearTunnelBtn.isHidden = !hasSavedTunnelToken
        let cleanHost = LocalHost.normalizedHostname(settings.remoteHostname)
        if settings.remoteControlEnabled {
            let phaseText = host.phases[.tunnel].map { "Durum: \(Self.describe($0)). " } ?? ""
            if let note = host.tunnelNote, !note.isEmpty {
                remoteNoteLabel.stringValue = phaseText + note
            } else if hasSavedTunnelToken {
                remoteNoteLabel.stringValue = phaseText + "Anahtar kayıtlı · https://\(cleanHost) üzerinden eşleşmiş telefonlar ev dışından bağlanabilir."
            } else {
                remoteNoteLabel.stringValue = "Kurulum: `brew install cloudflared` kurun ve Cloudflare Zero Trust → Tunnels ekranından aldığınız CLOUDFLARE_TUNNEL_TOKEN değerini yukarıya kaydedin."
            }
        } else {
            remoteNoteLabel.stringValue = "Kapalı: ev dışından iPhone bağlantısı için https://\(cleanHost) Cloudflare Tunnel yönlendirmesi açılır."
        }

        let log = host.errorLog
        errorScroll.isHidden = log.isEmpty
        if errorTextView.string != log {
            errorTextView.string = log
        }
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
        if !token.isEmpty {
            try? settings.tunnelTokens.save(token)
            tunnelTokenField.stringValue = ""
        }
        render()
        if settings.remoteControlEnabled {
            Task { await restartHost() }
        }
    }

    private func clearTunnelToken() {
        try? settings.tunnelTokens.delete()
        tunnelTokenField.stringValue = ""
        render()
        if settings.remoteControlEnabled {
            Task { await restartHost() }
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if control === repoField && commandSelector == #selector(NSResponder.insertNewline(_:)) {
            saveRepo()
            return true
        }
        if (control === remoteHostnameField || control === tunnelTokenField) && commandSelector == #selector(NSResponder.insertNewline(_:)) {
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
        busy = true
        render()
        defer { busy = false; render() }
        ActiveHost.current = host
        await host.restart()
        settings.hostAPIURL = host.apiURL
        app.reconnect()
    }

    private func applyHost(enabled: Bool) async {
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

// MARK: - Settings → "Cihazlar"

final class DevicesSectionView: NSView {
    private let host: LocalHost

    private let contentStack = NSStackView()
    private var devices: [PairedDevice] = []
    private var code: PairingCode?
    private var message: String?
    private var now = Date()
    private var pollTask: Task<Void, Never>?
    private var observation: ObservationToken?

    init(host: LocalHost) {
        self.host = host
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let group = SettingsGroupCardView(title: "Cihazlar")
        addSubview(group)
        NSLayoutConstraint.activate([
            group.leadingAnchor.constraint(equalTo: leadingAnchor),
            group.trailingAnchor.constraint(equalTo: trailingAnchor),
            group.topAnchor.constraint(equalTo: topAnchor),
            group.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 8
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        group.addFullWidth(contentStack)

        observation = observe { [weak self] in
            _ = self?.host.status
            _ = self?.host.apiPort
            self?.restartPolling()
            self?.render()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        pollTask?.cancel()
    }

    private var client: APIClient? {
        guard host.isUp, let url = host.apiURL else { return nil }
        return APIClient(baseURL: url)
    }

    private func restartPolling() {
        pollTask?.cancel()
        guard client != nil else { return }
        pollTask = Task { @MainActor [weak self] in
            while let self, !Task.isCancelled {
                if let api = self.client { await self.loadDevices(api) }
                self.now = Date()
                self.render()
                let interval = (self.code != nil && (self.code?.expiresAt ?? .distantPast) > self.now) ? 1 : 10
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    private func render() {
        contentStack.arrangedSubviews.forEach {
            contentStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        guard let api = client else {
            let note = NSTextField.styledLabel("Cihaz eşleştirmek için Mac sunucusu çalışıyor olmalı.", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
            contentStack.addArrangedSubview(note)
            note.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
            return
        }

        let active = devices.filter { !$0.isRevoked }
        if active.isEmpty {
            contentStack.addArrangedSubview(NSTextField.styledLabel("Eşleşmiş cihaz yok.", font: Theme.smallFont, color: Theme.textSecondary))
        } else {
            for device in active {
                let nameLabel = NSTextField.styledLabel(device.name, font: Theme.rowFont, color: Theme.textPrimary)
                let seen = device.lastSeenAt.map { "son görülme \($0.formatted(.relative(presentation: .named)))" } ?? "henüz bağlanmadı"
                let detailText = "eşleşme \(device.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(seen)"
                let subLabel = NSTextField.styledLabel(detailText, font: Theme.smallFont, color: Theme.textSecondary)
                let infoStack = NSStackView(views: [nameLabel, subLabel])
                infoStack.orientation = .vertical
                infoStack.alignment = .leading
                infoStack.spacing = 2

                let spacer = NSView()
                spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
                let revokeBtn = PillButton(title: "Kaldır", kind: .secondary, height: 22) { [weak self] in
                    guard let self else { return }
                    Task { await self.revoke(device, api: api) }
                }
                let row = NSStackView(views: [infoStack, spacer, revokeBtn])
                row.orientation = .horizontal
                row.alignment = .centerY
                contentStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
            }
        }

        if let code, code.expiresAt > now {
            let formatted = code.code.count == 6 ? "\(code.code.prefix(3)) \(code.code.suffix(3))" : code.code
            let codeLabel = NSTextField(labelWithString: formatted)
            codeLabel.font = NSFont.monospacedSystemFont(ofSize: 28, weight: .semibold)
            codeLabel.textColor = Theme.textPrimary
            codeLabel.isSelectable = true
            contentStack.addArrangedSubview(codeLabel)

            let secs = max(0, Int(code.expiresAt.timeIntervalSince(now).rounded()))
            contentStack.addArrangedSubview(NSTextField.styledLabel(
                "Telefonda bu kodu gir · tek kullanımlık · \(secs) sn geçerli",
                font: Theme.smallFont,
                color: Theme.textSecondary
            ))
            let closeCodeBtn = PillButton(title: "Kodu kapat", kind: .secondary, height: 24) { [weak self] in
                self?.code = nil
                self?.render()
            }
            contentStack.addArrangedSubview(closeCodeBtn)
        } else {
            let addPhoneBtn = PillButton(title: "Telefon ekle", kind: .secondary, height: 24) { [weak self] in
                guard let self else { return }
                Task { await self.createCode(api: api) }
            }
            contentStack.addArrangedSubview(addPhoneBtn)
        }

        if let message, !message.isEmpty {
            let msgLabel = NSTextField.styledLabel(message, font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
            contentStack.addArrangedSubview(msgLabel)
            msgLabel.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        }
    }

    private func loadDevices(_ api: APIClient) async {
        do {
            devices = try await api.devices()
        } catch {
            message = error.errorDescription
        }
    }

    private func createCode(api: APIClient) async {
        do {
            code = try await api.createPairingCode()
            now = Date()
            message = nil
            restartPolling()
            render()
        } catch {
            message = error.errorDescription
            render()
        }
    }

    private func revoke(_ device: PairedDevice, api: APIClient) async {
        do {
            try await api.revokeDevice(device.id)
            message = "\(device.name) kaldırıldı; anahtarı artık çalışmaz."
            await loadDevices(api)
            render()
        } catch {
            message = error.errorDescription
            render()
        }
    }
}
