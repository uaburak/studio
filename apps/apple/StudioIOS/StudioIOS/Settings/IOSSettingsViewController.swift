import StudioKit
import UIKit
import UserNotifications

/// Ayarlar: the Mac connection in plain words (one state, one action), then the same sections as
/// the Mac app's Ayarlar (Yapay zekâ, Kullanım · Görünüm, Bildirimler · Markalar, Hesaplar, Yayın ·
/// Cihazlar, Gelişmiş, Araçlar · Hakkında), each one level down. Technical words stay one level
/// down too (Gelişmiş).
final class IOSSettingsViewController: SettingsTableViewController {
    /// Titles of the Mac section's rows (tests).
    var macRowTitles: [String] { sections.first?.rows.map(\.title) ?? [] }

    init(app: IOSAppModel) {
        super.init(app: app, title: "Ayarlar")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.largeTitleDisplayMode = .automatic
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await app.notifier.refreshAuthorization() }
    }

    override func refresh() async {
        guard app.settings.isConnectedSetup else { return }
        async let host: Void = store.loadHost()
        async let spend: Void = app.loadAISpend()
        async let publishing: Void = store.loadPublishing()
        async let devices: Void = store.loadDevices()
        _ = await (host, spend, publishing, devices)
    }

    override func buildSections() -> [SettingsSection] {
        var sections = [macSection()]
        guard app.settings.isConnectedSetup else { return sections }
        let presence = app.presence
        let values = store.hostValues
        let offline = !store.canChange

        let model = values?.defaultModel.flatMap(AgentModel.init(rawValue:))
        let effort = values?.defaultEffort.flatMap(AgentEffort.init(rawValue:))
        let modelText = [model?.displayName, effort?.displayName].compactMap { $0 }.joined(separator: " · ")
        sections.append(SettingsSection(footer: offline ? "Mac'e ulaşılamıyor; son bilinen değerler gösteriliyor. Değişiklik için Mac'e bağlan." : nil, rows: [
            .navigate("Yapay zekâ", value: modelText.isEmpty ? nil : modelText, icon: "sparkles") { [weak self] in
                guard let self else { return }
                self.push(SettingsAIViewController(app: self.app))
            },
            .navigate("Kullanım", value: app.aiSpend?.budgetLine, icon: "gauge.with.dots.needle.50percent",
                      tint: (presence?.usage?.windows ?? []).contains { AssistantStatus.isWarning($0.effectivePercent) } ? IOSTheme.accent : nil) { [weak self] in
                guard let self else { return }
                self.push(SettingsUsageViewController(app: self.app))
            },
        ]))

        let notificationsValue: String = switch app.notifier.authorization {
        case .denied: "Kapalı"
        case .notDetermined: "İzin yok"
        default: "Açık"
        }
        sections.append(SettingsSection(rows: [
            .navigate("Görünüm", value: app.settings.appearance.label, icon: "circle.lefthalf.filled") { [weak self] in
                guard let self else { return }
                self.push(SettingsAppearanceViewController(app: self.app))
            },
            .navigate("Bildirimler", value: notificationsValue, icon: "bell") { [weak self] in
                guard let self else { return }
                self.push(SettingsNotificationsViewController(app: self.app))
            },
        ]))

        let needsAttention = app.accounts.contains { $0.status == .needsReauth || $0.tokenHealth == .invalid || $0.tokenHealth == .expiringSoon }
        let publishingValue: String? = store.publishing.map { $0.mode == .cloud ? "Bulut" : "Bu Mac" }
        sections.append(SettingsSection(rows: [
            .navigate("Markalar", value: app.currentBrand.map { $0.name } ?? "\(app.brands.count) marka", icon: "building.2") { [weak self] in
                guard let self else { return }
                self.push(BrandsViewController(app: self.app))
            },
            .navigate("Hesaplar", value: needsAttention ? "Dikkat" : "\(app.accounts.count) hesap", icon: "person.2", tint: needsAttention ? IOSTheme.accent : nil) { [weak self] in
                guard let self else { return }
                self.push(SettingsAccountsViewController(app: self.app))
            },
            .navigate("Yayın", value: publishingValue, icon: "paperplane") { [weak self] in
                guard let self else { return }
                self.push(SettingsPublishingViewController(app: self.app))
            },
        ]))

        let activeDevices = store.devices?.items.filter { !$0.isRevoked }.count
        sections.append(SettingsSection(rows: [
            .navigate("Cihazlar", value: activeDevices.map { "\($0) cihaz" }, icon: "iphone") { [weak self] in
                guard let self else { return }
                self.push(SettingsDevicesViewController(app: self.app))
            },
            .navigate("Gelişmiş", detail: "Uzaktan erişim, yerel ağ, uyku, anahtarlar ve bağlantı ayrıntıları", icon: "gearshape.2") { [weak self] in
                guard let self else { return }
                self.push(SettingsMacAdvancedViewController(app: self.app))
            },
            .navigate("Araçlar", detail: "Claude, Gemini, Chromium, ffmpeg ve diğerleri", icon: "wrench.and.screwdriver") { [weak self] in
                guard let self else { return }
                self.push(SettingsToolsViewController(app: self.app))
            },
        ]))

        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        sections.append(SettingsSection(rows: [
            .navigate("Hakkında", value: "Sürüm \(version)", icon: "info.circle") { [weak self] in
                guard let self else { return }
                self.push(SettingsAboutViewController(app: self.app))
            },
        ]))
        return sections
    }

    // MARK: Mac: one plain state and one action

    private func macSection() -> SettingsSection {
        var rows: [SettingsRow] = []
        let connection = app.connection
        let credential = app.settings.savedCredential
        if app.isSample {
            rows.append(.info("Örnek veri", detail: "-StudioSampleData YES ile açıldı", icon: "testtube.2"))
        } else if let credential {
            var detail = connection.title
            if let reason = connection.reason { detail += " · \(reason)" }
            if connection.isConnected, app.isMacIdle { detail += " · Studio şu an iş almıyor" }
            rows.append(.info(credential.serverName, detail: detail, icon: "laptopcomputer", tint: connection.isConnected ? IOSTheme.accent : IOSTheme.textTertiary))
            if let action = connection.action {
                rows.append(SettingsRow(title: action.title, icon: action == .repair ? "qrcode.viewfinder" : "arrow.clockwise", tint: IOSTheme.accent, kind: .action(destructive: false) { [weak self] in
                    self?.perform(action)
                }))
            }
        } else {
            rows.append(.info(connection.title, detail: "Studio Mac'inde çalışır. Mac'teki QR kodu okutarak bağla.", icon: "laptopcomputer.slash"))
            rows.append(SettingsRow(title: MacLinkAction.pair.title, icon: "qrcode.viewfinder", tint: IOSTheme.accent, kind: .action(destructive: false) { [weak self] in
                self?.app.open(.pair)
            }))
            rows.append(.navigate("Kodu elle gir", icon: "keyboard") { [weak self] in
                self?.openCodeEntry()
            })
            return SettingsSection("Mac", footer: app.isSample ? nil : "Kod, Mac'te Studio → Ayarlar → Cihazlar'da görünür.", rows: rows)
        }
        rows.append(.navigate("Mac durumu ve işler", detail: jobsSummary(), icon: "list.bullet.rectangle") { [weak self] in
            guard let self else { return }
            self.push(JobsViewController(app: self.app))
        })
        if !app.isSample {
            rows.append(SettingsRow(title: "Bağlantıyı kaldır", icon: "minus.circle", tint: .systemRed, kind: .action(destructive: true) { [weak self] in
                guard let self else { return }
                self.confirm("Bağlantı kaldırılsın mı?", message: "Bu iPhone Mac'i unutur. Yeniden bağlamak için Mac'teki QR kodu okutman yeter.", action: "Kaldır") {
                    self.app.forgetMac()
                }
            }))
        }
        return SettingsSection("Mac", rows: rows)
    }

    private func jobsSummary() -> String {
        let active = app.jobBoard.jobs.filter { $0.status.isActive }.count
        let queue = app.presence?.queueLength ?? 0
        if active == 0 { return queue > 0 ? "\(queue) iş sırada" : "Çalışan iş yok" }
        return "\(active) iş sürüyor"
    }

    private func perform(_ action: MacLinkAction) {
        switch action {
        case .retry:
            app.retryConnection()
            Toast.show(MacLinkState.connecting.title, in: view)
        case .repair, .pair:
            app.open(.pair)
        }
    }

    private func openCodeEntry() {
        let vc = PairingSheetViewController(app: app) { [weak self] in
            self?.rebuild()
            Toast.show("Mac'e bağlandı", in: self?.view)
        }
        presentSheet(vc, detents: [.large()])
    }
}

/// Mac status: workers, queue and the latest jobs (cancel the running ones).
final class JobsViewController: UITableViewController {
    private unowned let app: IOSAppModel
    private var observation: IOSObservationToken?
    private var jobs: [Job] = []

    init(app: IOSAppModel) {
        self.app = app
        super.init(style: .insetGrouped)
        title = "Mac durumu"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.largeTitleDisplayMode = .never
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "job")
        observation = observeIOS { [weak self] in
            guard let self else { return }
            self.jobs = self.app.jobBoard.jobs
            _ = self.app.presence
            self.tableView.reloadData()
        }
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 2 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? 3 : max(1, jobs.count)
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        section == 0 ? "Mac" : "Son işler"
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "job", for: indexPath)
        cell.backgroundColor = IOSTheme.elevated
        cell.selectionStyle = .none
        var content = UIListContentConfiguration.valueCell()
        let presence = app.presence
        if indexPath.section == 0 {
            switch indexPath.row {
            case 0:
                content.text = "Durum"
                content.secondaryText = AssistantStatus.macLine(presence)
            case 1:
                content.text = "İşçi"
                content.secondaryText = presence?.workers.first.map { "\($0.workerId) · \($0.workerVersion ?? "?")" } ?? "Bağlı değil"
            default:
                content.text = "Sıra"
                content.secondaryText = "\(presence?.queueLength ?? 0) iş bekliyor"
            }
            cell.contentConfiguration = content
            return cell
        }
        guard jobs.indices.contains(indexPath.row) else {
            content.text = "Henüz iş yok"
            cell.contentConfiguration = content
            return cell
        }
        let job = jobs[indexPath.row]
        var sub = UIListContentConfiguration.subtitleCell()
        sub.text = job.displayTitle
        let status: String = switch job.status {
        case .queued: "Sırada"
        case .running: job.progressMessage ?? "Çalışıyor"
        case .succeeded: "Bitti"
        case .failed: "Hata: \(job.error ?? "")"
        case .cancelled: "İptal"
        case .unknown: job.status.rawValue
        }
        sub.secondaryText = "\(job.type.label) · \(status) · \(AssistantStatus.relative(job.updatedAt))"
        sub.secondaryTextProperties.color = IOSTheme.textSecondary
        sub.secondaryTextProperties.numberOfLines = 2
        sub.image = UIImage(systemName: "circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 8))
        sub.imageProperties.tintColor = job.status.isActive ? IOSTheme.accent : (job.status == .failed ? IOSTheme.accent : IOSTheme.textTertiary)
        cell.contentConfiguration = sub
        return cell
    }

    override func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard indexPath.section == 1, jobs.indices.contains(indexPath.row), jobs[indexPath.row].status.isActive else { return nil }
        let job = jobs[indexPath.row]
        let cancel = UIContextualAction(style: .destructive, title: "İptal et") { [weak self] _, _, done in
            guard let self else { return done(false) }
            Task {
                do {
                    _ = try await self.app.dataService.cancelJob(job.id)
                    done(true)
                } catch {
                    self.presentError(IOSAppModel.describe(error))
                    done(false)
                }
            }
        }
        return UISwipeActionsConfiguration(actions: [cancel])
    }
}
