import StudioKit
import UIKit
import UserNotifications

/// Ayarlar: the Mac connection in plain words (one state, one action), AI status and usage,
/// brands, notifications, appearance, the greeting name, and "Gelişmiş" for the technical
/// details (addresses, extra remote address, manual pairing).
final class IOSSettingsViewController: UITableViewController {
    private enum Section: Int, CaseIterable {
        case mac, ai, brands, notifications, appearance, greeting, advanced, about

        var title: String? {
            switch self {
            case .mac: "Mac"
            case .ai: "Yapay zekâ"
            case .brands: nil
            case .notifications: "Bildirimler"
            case .appearance: "Görünüm"
            case .greeting: "Karşılama"
            case .advanced: nil
            case .about: nil
            }
        }
    }

    private struct Row {
        var title: String
        var detail: String? = nil
        var icon: String? = nil
        var tint: UIColor? = nil
        var destructive = false
        var accessory: UITableViewCell.AccessoryType = .none
        /// Trailing closure of rows without `toggle:`.
        var action: (() -> Void)? = nil
        var toggle: Bool? = nil
        /// Trailing closure of rows with `toggle:`.
        var onToggle: ((Bool) -> Void)? = nil
        var custom: UIView? = nil
    }

    private unowned let app: IOSAppModel
    private var observation: IOSObservationToken?
    private var rows: [Section: [Row]] = [:]

    /// Titles of the Mac section's rows (tests).
    var macRowTitles: [String] { rows[.mac]?.map(\.title) ?? [] }

    init(app: IOSAppModel) {
        self.app = app
        super.init(style: .insetGrouped)
        title = "Ayarlar"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            guard let self else { return }
            Task {
                await self.app.load()
                await self.app.notifier.refreshAuthorization()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        refreshControl = refresh
        observation = observeIOS { [weak self] in self?.rebuild() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await app.notifier.refreshAuthorization() }
    }

    // MARK: Model -> rows

    private func rebuild() {
        let settings = app.settings
        let presence = app.presence
        let credential = settings.savedCredential
        var rows: [Section: [Row]] = [:]

        // Mac: one plain state and one action.
        var mac: [Row] = []
        let connection = app.connection
        if app.isSample {
            mac.append(Row(title: "Örnek veri", detail: "-StudioSampleData YES ile açıldı", icon: "testtube.2"))
        } else if let credential {
            var detail = connection.title
            if let reason = connection.reason { detail += " · \(reason)" }
            if connection.isConnected, app.isMacIdle { detail += " · Studio şu an iş almıyor" }
            mac.append(Row(title: credential.serverName, detail: detail, icon: "laptopcomputer", tint: connection.isConnected ? IOSTheme.accent : IOSTheme.textTertiary))
            if let action = connection.action {
                mac.append(Row(title: action.title, icon: action == .repair ? "qrcode.viewfinder" : "arrow.clockwise", tint: IOSTheme.accent) { [weak self] in
                    self?.perform(action)
                })
            }
            mac.append(Row(title: "Mac durumu ve işler", detail: jobsSummary(), icon: "list.bullet.rectangle", accessory: .disclosureIndicator) { [weak self] in
                guard let self else { return }
                self.navigationController?.pushViewController(JobsViewController(app: self.app), animated: true)
            })
            mac.append(Row(title: "Bağlantıyı kaldır", icon: "minus.circle", tint: IOSTheme.accent, destructive: true) { [weak self] in
                guard let self else { return }
                self.confirm("Bağlantı kaldırılsın mı?", message: "Bu iPhone Mac'i unutur. Yeniden bağlamak için Mac'teki QR kodu okutman yeter.", action: "Kaldır") {
                    self.app.forgetMac()
                }
            })
        } else {
            mac.append(Row(title: connection.title, detail: "Studio Mac'inde çalışır. Mac'teki QR kodu okutarak bağla.", icon: "laptopcomputer.slash"))
            mac.append(Row(title: MacLinkAction.pair.title, icon: "qrcode.viewfinder", tint: IOSTheme.accent) { [weak self] in
                self?.app.open(.pair)
            })
            mac.append(Row(title: "Kodu elle gir", icon: "keyboard", accessory: .disclosureIndicator) { [weak self] in
                self?.openCodeEntry()
            })
        }
        rows[.mac] = mac

        // AI
        var ai: [Row] = [
            Row(title: "Claude", detail: AssistantStatus.claudeLine(presence), icon: "sparkle"),
            Row(title: "Gemini", detail: AssistantStatus.geminiLine(presence), icon: "sparkles"),
        ]
        for window in presence?.usage?.windows ?? [] {
            let detail = AssistantStatus.usedText(window) + (window.resetsAt.map { " · sıfırlanma \(AssistantStatus.relative($0))" } ?? "")
            ai.append(Row(title: "\(AssistantStatus.windowTitle(window.kind)) kullanım", detail: detail, icon: "gauge.with.dots.needle.50percent", tint: AssistantStatus.isWarning(window.effectivePercent) ? IOSTheme.accent : nil))
        }
        ai.append(Row(title: "Durumu yenile", icon: "arrow.clockwise") { [weak self] in
            guard let self else { return }
            Task {
                _ = try? await self.app.dataService.claudeRefresh()
                _ = try? await self.app.dataService.geminiRefresh()
                Toast.show("Mac'ten durum istendi", in: self.view)
            }
        })
        rows[.ai] = ai

        rows[.brands] = [Row(title: "Markalar", detail: app.currentBrand.map { "Seçili: \($0.name)" } ?? "\(app.brands.count) marka", icon: "building.2", accessory: .disclosureIndicator) { [weak self] in
            guard let self else { return }
            self.navigationController?.pushViewController(BrandsViewController(app: self.app), animated: true)
        }]

        // Notifications
        var notifications: [Row] = []
        let notifier = app.notifier
        switch notifier.authorization {
        case .denied:
            notifications.append(Row(title: "Bildirimler kapalı", detail: "iOS Ayarlar → Studio → Bildirimler'den aç", icon: "bell.slash", tint: IOSTheme.accent, accessory: .disclosureIndicator) {
                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
            })
        case .notDetermined:
            notifications.append(Row(title: "Bildirimlere izin ver", detail: "Post hazır olunca ve onayın beklenince haber ver", icon: "bell.badge") {
                Task { await notifier.requestAuthorization() }
            })
        default:
            break
        }
        for category in ActivityNotice.Category.allCases {
            notifications.append(Row(title: category.label, icon: Self.icon(category), toggle: settings.isNoticeEnabled(category)) { [weak self] on in
                self?.app.settings.setNotice(category, enabled: on)
            })
        }
        rows[.notifications] = notifications

        // Appearance
        let segmented = UISegmentedControl(items: IOSAppearancePreference.allCases.map(\.label))
        segmented.selectedSegmentIndex = IOSAppearancePreference.allCases.firstIndex(of: settings.appearance) ?? 0
        segmented.addAction(UIAction { [weak self, weak segmented] _ in
            guard let self, let segmented else { return }
            self.app.settings.appearance = IOSAppearancePreference.allCases[segmented.selectedSegmentIndex]
            Haptics.selection()
        }, for: .valueChanged)
        rows[.appearance] = [Row(title: "", custom: segmented)]

        // Greeting name (home screen, drawer avatar)
        let typedName = settings.ownerName.trimmingCharacters(in: .whitespacesAndNewlines)
        let accountName = presence?.claude?.greetingName
        let nameDetail: String = if !typedName.isEmpty {
            typedName
        } else if let accountName {
            "Claude hesabından: \(accountName)"
        } else if let guess = settings.greetingName {
            "Mac'in adından: \(guess)"
        } else {
            "Ayarlanmadı"
        }
        rows[.greeting] = [Row(title: "Adın", detail: nameDetail, icon: "person.crop.circle", accessory: .disclosureIndicator) { [weak self] in
            guard let self else { return }
            self.prompt("Adın", message: "Ana ekrandaki selamlamada kullanılır. Boş bırakırsan Mac'teki Claude hesabındaki adın kullanılır.", text: self.app.settings.ownerName, placeholder: self.app.greetingName ?? "Adın") { name in
                self.app.settings.ownerName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }]

        // Technical details live one level down.
        rows[.advanced] = [Row(title: "Gelişmiş", detail: "Bağlantı ayrıntıları ve elle bağlanma", icon: "gearshape.2", accessory: .disclosureIndicator) { [weak self] in
            guard let self else { return }
            self.navigationController?.pushViewController(IOSAdvancedConnectionViewController(app: self.app), animated: true)
        }]

        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        rows[.about] = [Row(title: "Studio", detail: "Sürüm \(version) (\(build))", icon: "info.circle")]

        self.rows = rows
        tableView.reloadData()
    }

    private static func icon(_ category: ActivityNotice.Category) -> String {
        switch category {
        case .waiting: "hand.raised"
        case .production: "square.grid.2x2"
        case .publishing: "paperplane"
        case .replies: "bubble.left"
        }
    }

    private func jobsSummary() -> String {
        let active = app.jobBoard.jobs.filter { $0.status.isActive }.count
        let queue = app.presence?.queueLength ?? 0
        if active == 0 { return queue > 0 ? "\(queue) iş sırada" : "Çalışan iş yok" }
        return "\(active) iş sürüyor"
    }

    // MARK: Table

    override func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows[Section(rawValue: section)!]?.count ?? 0
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        Section(rawValue: section)?.title
    }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        switch Section(rawValue: section)! {
        case .mac where app.connection == .notPaired && !app.isSample: "Kod, Mac'te Studio → Ayarlar → Cihazlar'da görünür."
        case .notifications: "Uygulama açıkken ve kısa süre arka plandayken anında; kapalıyken iOS'un izin verdiği aralıklarla gelir."
        default: nil
        }
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        cell.backgroundColor = IOSTheme.elevated
        cell.contentView.subviews.filter { $0.tag == 77 }.forEach { $0.removeFromSuperview() }
        guard let row = rows[Section(rawValue: indexPath.section)!]?[indexPath.row] else { return cell }
        cell.accessoryView = nil
        cell.accessoryType = row.accessory
        cell.selectionStyle = row.action == nil ? .none : .default
        if let custom = row.custom {
            cell.contentConfiguration = nil
            custom.tag = 77
            custom.translatesAutoresizingMaskIntoConstraints = false
            cell.contentView.addSubview(custom)
            custom.pin(to: cell.contentView, insets: UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16))
            return cell
        }
        var content = UIListContentConfiguration.subtitleCell()
        content.text = row.title
        content.textProperties.color = row.destructive ? IOSTheme.accent : IOSTheme.textPrimary
        content.secondaryText = row.detail
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        content.secondaryTextProperties.numberOfLines = 3
        if let icon = row.icon {
            content.image = UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: icon == "circle.fill" ? 9 : 15))
            content.imageProperties.tintColor = row.tint ?? IOSTheme.textSecondary
            content.imageProperties.reservedLayoutSize = CGSize(width: 26, height: 26)
        }
        cell.contentConfiguration = content
        if let toggle = row.toggle {
            let toggleView = UISwitch()
            toggleView.isOn = toggle
            toggleView.onTintColor = IOSTheme.ink
            let handler = row.onToggle
            toggleView.addAction(UIAction { [weak toggleView] _ in handler?(toggleView?.isOn ?? false) }, for: .valueChanged)
            cell.accessoryView = toggleView
            cell.selectionStyle = .none
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        rows[Section(rawValue: indexPath.section)!]?[indexPath.row].action?()
    }

    // MARK: Actions

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
