import StudioKit
import UIKit

/// Ayarlar (`100% Pure UIKit`):
/// - Live Bonjour Mac discovery (`StudioBrowser` over `_studio._tcp`)
/// - Paired Mac status + 6-digit pairing (`PairingSheetViewController`)
/// - Remote Control URL (`https://social.burakkoc.net`)
/// - Claude & Gemini readiness from `WorkerPresence`
/// - Sistem / Açık / Koyu appearance switch.
final class IOSSettingsViewController: UIViewController {
    private unowned let app: IOSAppModel

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()

    private let pairedInfoLabel = UILabel.studio("", size: 14, lines: 0)
    private let bonjourStack = UIStackView()
    private let remoteSwitch = UISwitch()
    private let remoteURLField = UITextField()
    private let aiStatusLabel = UILabel.studio("", size: 13, color: IOSTheme.textSecondary, lines: 0)
    private var appearanceSegment: UISegmentedControl!

    private var discoveredMacs: [DiscoveredStudio] = []
    private var bonjourTask: Task<Void, Never>?
    private var observation: IOSObservationToken?

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        title = "Ayarlar"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        bonjourTask?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.keyboardDismissMode = .interactive
        contentStack.axis = .vertical
        contentStack.spacing = 16
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)
        view.addSubview(scrollView)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -16),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 16),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -32),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -32),
        ])

        buildPairingAndBonjourCard()
        buildRemoteControlCard()
        buildAIStatusCard()
        buildAppearanceCard()

        observation = observeIOS { [weak self] in
            self?.render()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        startBonjourDiscovery()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        bonjourTask?.cancel()
        bonjourTask = nil
    }

    private func buildPairingAndBonjourCard() {
        let card = IOSCardView(padding: 16, spacing: 12)
        card.stack.addArrangedSubview(UILabel.studio("Eşleşmiş Mac ve Yerel Ağ (Bonjour)", size: 16, weight: .bold))
        card.stack.addArrangedSubview(pairedInfoLabel)

        let manualPairBtn = UIButton.studioPill(title: "Eşleştirme Kodu Gir…", primary: true) { [weak self] in
            self?.openPairingSheet(baseURL: nil, serverName: "Studio Mac")
        }
        let forgetBtn = UIButton.studioPill(title: "Eşleştirmeyi Unut") { [weak self] in
            guard let self else { return }
            try? self.app.settings.pairingClient.forget()
            self.render()
        }
        let pairRow = UIStackView(arrangedSubviews: [manualPairBtn, forgetBtn, UIView()])
        pairRow.axis = .horizontal
        pairRow.spacing = 8
        card.stack.addArrangedSubview(pairRow)

        card.stack.addArrangedSubview(UILabel.studio("Aynı Wi-Fi Ağındaki Mac'ler (_studio._tcp)", size: 13, weight: .semibold, color: IOSTheme.textSecondary))
        bonjourStack.axis = .vertical
        bonjourStack.spacing = 8
        card.stack.addArrangedSubview(bonjourStack)
        contentStack.addArrangedSubview(card)
    }

    private func buildRemoteControlCard() {
        let card = IOSCardView(padding: 16, spacing: 10)
        card.stack.addArrangedSubview(UILabel.studio("Uzaktan Erişim (Cloudflare Tunnel · L3)", size: 16, weight: .bold))

        remoteSwitch.onTintColor = IOSTheme.accent
        remoteSwitch.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.app.settings.useRemoteControlURL = self.remoteSwitch.isOn
            self.app.reconnect()
        }, for: .valueChanged)

        let toggleRow = UIStackView(arrangedSubviews: [
            UILabel.studio("Ev dışından uzaktan adresle bağlan", size: 14),
            UIView(),
            remoteSwitch,
        ])
        toggleRow.axis = .horizontal
        toggleRow.alignment = .center
        card.stack.addArrangedSubview(toggleRow)

        remoteURLField.text = app.settings.remoteURLString
        remoteURLField.placeholder = IOSAppSettings.defaultRemoteURLString
        remoteURLField.keyboardType = .URL
        remoteURLField.autocapitalizationType = .none
        remoteURLField.autocorrectionType = .no
        remoteURLField.font = UIFont.systemFont(ofSize: 14)
        remoteURLField.textColor = IOSTheme.textPrimary
        remoteURLField.backgroundColor = IOSTheme.fill
        remoteURLField.layer.cornerRadius = 12
        remoteURLField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        remoteURLField.leftViewMode = .always
        remoteURLField.translatesAutoresizingMaskIntoConstraints = false
        remoteURLField.heightAnchor.constraint(equalToConstant: 40).isActive = true
        card.stack.addArrangedSubview(remoteURLField)

        let saveRemoteBtn = UIButton.studioPill(title: "Uzaktan Adresi Kaydet") { [weak self] in
            guard let self else { return }
            self.app.settings.remoteURLString = self.remoteURLField.text ?? IOSAppSettings.defaultRemoteURLString
            if self.app.settings.useRemoteControlURL {
                self.app.reconnect()
            }
        }
        let btnRow = UIStackView(arrangedSubviews: [saveRemoteBtn, UIView()])
        btnRow.axis = .horizontal
        card.stack.addArrangedSubview(btnRow)
        contentStack.addArrangedSubview(card)
    }

    private func buildAIStatusCard() {
        let card = IOSCardView(padding: 16, spacing: 10)
        card.stack.addArrangedSubview(UILabel.studio("Yapay Zekâ Durumu (Claude & Gemini)", size: 16, weight: .bold))
        card.stack.addArrangedSubview(aiStatusLabel)

        let refreshAIBtn = UIButton.studioPill(title: "Durumu Yenile") { [weak self] in
            guard let self else { return }
            Task {
                _ = try? await self.app.dataService.claudeRefresh()
                _ = try? await self.app.dataService.geminiRefresh()
                await self.app.load()
            }
        }
        let row = UIStackView(arrangedSubviews: [refreshAIBtn, UIView()])
        row.axis = .horizontal
        card.stack.addArrangedSubview(row)
        contentStack.addArrangedSubview(card)
    }

    private func buildAppearanceCard() {
        let card = IOSCardView(padding: 16, spacing: 10)
        card.stack.addArrangedSubview(UILabel.studio("Görünüm", size: 16, weight: .bold))

        appearanceSegment = UISegmentedControl(items: IOSAppearancePreference.allCases.map(\.label))
        appearanceSegment.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            let idx = self.appearanceSegment.selectedSegmentIndex
            if IOSAppearancePreference.allCases.indices.contains(idx) {
                self.app.settings.appearance = IOSAppearancePreference.allCases[idx]
            }
        }, for: .valueChanged)
        card.stack.addArrangedSubview(appearanceSegment)
        contentStack.addArrangedSubview(card)
    }

    private func startBonjourDiscovery() {
        bonjourTask?.cancel()
        let browser = StudioBrowser()
        bonjourTask = Task { @MainActor [weak self] in
            for await list in browser.results() {
                guard let self, !Task.isCancelled else { return }
                self.discoveredMacs = list
                self.rebuildBonjourRows()
            }
        }
    }

    private func rebuildBonjourRows() {
        bonjourStack.arrangedSubviews.forEach {
            bonjourStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        if discoveredMacs.isEmpty {
            bonjourStack.addArrangedSubview(UILabel.studio("Yerel ağda Studio çalışan Mac aranıyor…", size: 13, color: IOSTheme.textTertiary))
            return
        }
        for mac in discoveredMacs {
            let connectBtn = UIButton.studioPill(title: "Eşleştir") { [weak self] in
                guard let self else { return }
                Task {
                    do {
                        let url = try await StudioBrowser.resolve(mac)
                        self.openPairingSheet(baseURL: url, serverName: mac.displayName)
                    } catch {
                        let alert = UIAlertController(
                            title: "Mac'e ulaşılamadı",
                            message: ((error as? StudioAPIError)?.errorDescription ?? error.localizedDescription)
                                + "\n\nMac'te Studio açık ve Ayarlar → Mac sunucusu çalışıyor olmalı. Adresi elle de girebilirsin.",
                            preferredStyle: .alert)
                        alert.addAction(UIAlertAction(title: "Elle gir", style: .default) { _ in
                            self.openPairingSheet(baseURL: mac.advertisedURLs.first, serverName: mac.displayName)
                        })
                        alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
                        self.present(alert, animated: true)
                    }
                }
            }
            let row = UIStackView(arrangedSubviews: [
                IOSStatusDotView(color: IOSTheme.accent, size: 8),
                UILabel.studio(mac.displayName, size: 14, weight: .medium),
                UIView(),
                connectBtn,
            ])
            row.axis = .horizontal
            row.alignment = .center
            row.spacing = 8
            bonjourStack.addArrangedSubview(row)
        }
    }

    private func openPairingSheet(baseURL: URL?, serverName: String) {
        let vc = PairingSheetViewController(app: app, baseURL: baseURL, serverName: serverName) { [weak self] in
            self?.render()
        }
        let nav = UINavigationController(rootViewController: vc)
        present(nav, animated: true)
    }

    private func render() {
        if app.isSample {
            pairedInfoLabel.text = "Örnek veri kipi (-StudioSampleData YES) açık."
        } else if let cred = app.settings.savedCredential {
            pairedInfoLabel.text = "Bağlı Mac: \(cred.serverName)\nAdres: \(cred.serverURL.absoluteString)"
        } else {
            pairedInfoLabel.text = "Henüz eşleşmiş bir Mac yok. Aynı Wi-Fi'de aşağıdaki listeden seçin ya da Eşleştirme Kodu Gir'e dokunun."
        }

        remoteSwitch.isOn = app.settings.useRemoteControlURL
        if !remoteURLField.isFirstResponder && remoteURLField.text != app.settings.remoteURLString {
            remoteURLField.text = app.settings.remoteURLString
        }

        let claude = app.presence?.claude
        let gemini = app.presence?.gemini
        let claudeLine = switch claude?.status {
        case .signedIn: "Claude Code: Giriş yapıldı (\(claude?.email ?? "aktif"))"
        case .signedOut: "Claude Code: Giriş yapılmadı"
        case .signingIn: "Claude Code: Giriş bekleniyor"
        case .notInstalled: "Claude Code: Kurulu değil"
        case .error: "Claude Code: Hata"
        case .unknown, nil: app.isOnline ? "Claude Code: Okunuyor" : "Claude Code: Mac çevrimdışı"
        }
        let geminiLine = switch gemini?.status {
        case .ready: "Gemini: Hazır (\(gemini?.defaultModel ?? "API/CLI"))"
        case .notConfigured: "Gemini: Yapılandırılmadı"
        case .error: "Gemini: Hata"
        case .unknown, nil: app.isOnline ? "Gemini: Okunuyor" : "Gemini: Mac çevrimdışı"
        }
        aiStatusLabel.text = "\(claudeLine)\n\(geminiLine)"

        if let idx = IOSAppearancePreference.allCases.firstIndex(of: app.settings.appearance) {
            appearanceSegment.selectedSegmentIndex = idx
        }
        rebuildBonjourRows()
    }
}
