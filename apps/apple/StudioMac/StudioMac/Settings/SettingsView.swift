import AppKit
import StudioKit

/// Reusable card-style grouped section container for the AppKit Settings sheet.
final class SettingsGroupCardView: NSView {
    let stack = NSStackView()

    init(title: String) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let header = NSTextField.styledLabel(title, font: NSFont.systemFont(ofSize: 12, weight: .semibold), color: Theme.textSecondary)

        let card = ThemedView()
        card.backgroundColor = Theme.fill
        card.borderColor = Theme.hairline
        card.borderWidth = 1
        card.cornerRadius = 14
        card.translatesAutoresizingMaskIntoConstraints = false

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        let outer = NSStackView(views: [header, card])
        outer.orientation = .vertical
        outer.alignment = .leading
        outer.spacing = 6
        outer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(outer)

        card.widthAnchor.constraint(equalTo: outer.widthAnchor).isActive = true

        NSLayoutConstraint.activate([
            outer.leadingAnchor.constraint(equalTo: leadingAnchor),
            outer.trailingAnchor.constraint(equalTo: trailingAnchor),
            outer.topAnchor.constraint(equalTo: topAnchor),
            outer.bottomAnchor.constraint(equalTo: bottomAnchor),

            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func addFullWidth(_ view: NSView) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
}

/// Pure AppKit Settings sheet (`⌘,`, 560x640):
/// 1. Görünüm (`NSSegmentedControl`: Sistem / Açık / Koyu)
/// 2. Yapay Zekâ Bağlantıları (`Claude Code` in-app sign-in & status + `Gemini` API/CLI status)
/// 3. Mac sunucusu (`LocalHost`)
/// 4. Cihazlar (6-digit phone pairing)
/// 5. Sunucu & Cloudflare Access.
final class SettingsSheetViewController: NSViewController, NSTextFieldDelegate {
    private unowned let app: AppModel
    private unowned let settings: AppSettings
    private let host: LocalHost?
    private let onDone: () -> Void

    private var appearanceControl: NSSegmentedControl!
    private let serverField = NSTextField()
    private let serverStatusLabel = NSTextField(wrappingLabelWithString: "")
    private var testServerButton: PillButton!
    private let clientIdField = NSTextField()
    private let clientSecretField = NSSecureTextField()
    private var saveTokenButton: PillButton!

    private var observation: ObservationToken?
    private var testingServer = false

    init(app: AppModel, settings: AppSettings, host: LocalHost?, onDone: @escaping () -> Void) {
        self.app = app
        self.settings = settings
        self.host = host
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        // Top sheet bar
        let titleLabel = NSTextField.styledLabel("Ayarlar", font: NSFont.systemFont(ofSize: 15, weight: .semibold), color: Theme.textPrimary)
        let topSpacer = NSView()
        topSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let doneButton = PillButton(title: "Bitti", kind: .primary, height: 26) { [weak self] in
            self?.closeSheet()
        }
        let headerRow = NSStackView(views: [titleLabel, topSpacer, doneButton])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        let headerHairline = HairlineView()
        headerHairline.translatesAutoresizingMaskIntoConstraints = false

        // Scrollable form body
        let scroll = NSScrollView()
        let clip = FlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let doc = FlippedDocumentView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = doc
        scroll.applyMinimalScroller()

        let formStack = NSStackView()
        formStack.orientation = .vertical
        formStack.alignment = .leading
        formStack.spacing = 18
        formStack.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(formStack)

        // 1. Görünüm
        let appearanceGroup = SettingsGroupCardView(title: "Görünüm")
        let labels = AppearancePreference.allCases.map(\.label)
        appearanceControl = NSSegmentedControl(labels: labels, trackingMode: .selectOne, target: self, action: #selector(appearanceChanged))
        appearanceGroup.stack.addArrangedSubview(appearanceControl)
        appearanceGroup.addFullWidth(NSTextField.styledLabel(
            "Sistem: macOS ayarını izler. Değişiklik hemen uygulanır (⇧⌘L ile de değişir).",
            font: Theme.smallFont,
            color: Theme.textSecondary,
            wraps: true
        ))
        addSection(appearanceGroup, to: formStack)

        // 2. Yapay Zekâ Bağlantıları (Claude + Gemini)
        let aiSection = AIConnectionsSectionView(app: app)
        addSection(aiSection, to: formStack)

        // 3 & 4. Mac sunucusu & Cihazlar
        if !app.isSample, let host {
            addSection(MacServerSectionView(app: app, settings: settings, host: host), to: formStack)
            addSection(DevicesSectionView(host: host), to: formStack)
        }

        // 5. Sunucu
        let serverGroup = SettingsGroupCardView(title: "Sunucu")
        if app.isSample {
            serverGroup.addFullWidth(NSTextField.styledLabel(
                "Uygulama örnek verilerle açıldı (-StudioSampleData YES). Sunucu ayarı bu oturumda kullanılmıyor.",
                font: Theme.smallFont,
                color: Theme.textSecondary,
                wraps: true
            ))
        }
        serverField.stringValue = settings.serverURLString
        serverField.placeholderString = APIClient.localDefaultURL.absoluteString
        serverField.bezelStyle = .roundedBezel
        serverField.delegate = self
        serverGroup.addFullWidth(serverField)

        let saveServerBtn = PillButton(title: "Kaydet ve bağlan", kind: .secondary) { [weak self] in
            self?.saveServer()
        }
        testServerButton = PillButton(title: "Bağlantıyı dene", kind: .secondary) { [weak self] in
            guard let self else { return }
            Task { await self.testServer() }
        }
        let serverBtns = NSStackView(views: [saveServerBtn, testServerButton])
        serverBtns.orientation = .horizontal
        serverBtns.spacing = 8
        serverGroup.stack.addArrangedSubview(serverBtns)

        serverStatusLabel.font = Theme.smallFont
        serverStatusLabel.textColor = Theme.textSecondary
        serverStatusLabel.isHidden = true
        serverGroup.addFullWidth(serverStatusLabel)
        addSection(serverGroup, to: formStack)

        // 6. Cloudflare Access
        let cfGroup = SettingsGroupCardView(title: "Cloudflare Access")
        cfGroup.addFullWidth(NSTextField.styledLabel(
            "Sunucu Access arkasındaysa servis anahtarını gir. Anahtar zincirinde saklanır.",
            font: Theme.smallFont,
            color: Theme.textSecondary,
            wraps: true
        ))
        clientIdField.stringValue = (try? settings.credentials.load())?.clientId ?? ""
        clientIdField.placeholderString = "Client ID"
        clientIdField.bezelStyle = .roundedBezel
        clientIdField.delegate = self
        cfGroup.addFullWidth(clientIdField)

        clientSecretField.placeholderString = "Client Secret"
        clientSecretField.bezelStyle = .roundedBezel
        clientSecretField.delegate = self
        cfGroup.addFullWidth(clientSecretField)

        saveTokenButton = PillButton(title: "Anahtarı kaydet", kind: .secondary) { [weak self] in
            self?.saveToken()
        }
        saveTokenButton.isEnabled = false
        let deleteTokenBtn = PillButton(title: "Anahtarı sil", kind: .secondary) { [weak self] in
            self?.deleteToken()
        }
        let cfBtns = NSStackView(views: [saveTokenButton, deleteTokenBtn])
        cfBtns.orientation = .horizontal
        cfBtns.spacing = 8
        cfGroup.stack.addArrangedSubview(cfBtns)
        addSection(cfGroup, to: formStack)

        root.addSubview(headerRow)
        root.addSubview(headerHairline)
        root.addSubview(scroll)

        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 560),
            root.heightAnchor.constraint(equalToConstant: 640),

            headerRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            headerRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            headerRow.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),

            headerHairline.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            headerHairline.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            headerHairline.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 12),

            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: headerHairline.bottomAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),

            formStack.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: 20),
            formStack.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -20),
            formStack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 16),
            formStack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -20),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            guard let self else { return }
            if let idx = AppearancePreference.allCases.firstIndex(of: self.settings.appearance) {
                self.appearanceControl.selectedSegment = idx
            }
        }
    }

    override func cancelOperation(_ sender: Any?) {
        closeSheet()
    }

    private func closeSheet() {
        onDone()
        dismiss(nil)
    }

    private func addSection(_ section: NSView, to stack: NSStackView) {
        stack.addArrangedSubview(section)
        section.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    @objc private func appearanceChanged() {
        let idx = appearanceControl.selectedSegment
        guard AppearancePreference.allCases.indices.contains(idx) else { return }
        settings.appearance = AppearancePreference.allCases[idx]
    }

    func controlTextDidChange(_ obj: Notification) {
        saveTokenButton.isEnabled = !clientIdField.stringValue.isEmpty && !clientSecretField.stringValue.isEmpty
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if control === serverField && commandSelector == #selector(NSResponder.insertNewline(_:)) {
            saveServer()
            return true
        }
        return false
    }

    private func showServerStatus(_ message: String) {
        serverStatusLabel.stringValue = message
        serverStatusLabel.isHidden = false
    }

    private func saveServer() {
        settings.serverURLString = serverField.stringValue
        guard settings.serverURL != nil else {
            showServerStatus("Adres http:// ya da https:// ile başlamalı.")
            return
        }
        app.reconnect()
        showServerStatus("Kaydedildi.")
    }

    private func testServer() async {
        guard !testingServer else { return }
        testingServer = true
        testServerButton.showsSpinner = true
        testServerButton.isEnabled = false
        defer {
            testingServer = false
            testServerButton.showsSpinner = false
            testServerButton.isEnabled = true
        }
        let raw = serverField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw), url.scheme?.hasPrefix("http") == true else {
            showServerStatus("Adres geçersiz.")
            return
        }
        do {
            let health = try await APIClient(baseURL: url, auth: AccessServiceTokenAuth(store: settings.credentials)).health()
            showServerStatus("Bağlandı: \(health.service) \(health.version), veritabanı \(health.checks.db).")
        } catch {
            showServerStatus(error.errorDescription ?? error.localizedDescription)
        }
    }

    private func saveToken() {
        do {
            try settings.credentials.save(AccessServiceToken(clientId: clientIdField.stringValue, clientSecret: clientSecretField.stringValue))
            clientSecretField.stringValue = ""
            saveTokenButton.isEnabled = false
            showServerStatus("Anahtar kaydedildi.")
            app.reconnect()
        } catch {
            showServerStatus(error.localizedDescription)
        }
    }

    private func deleteToken() {
        try? settings.credentials.delete()
        clientIdField.stringValue = ""
        clientSecretField.stringValue = ""
        saveTokenButton.isEnabled = false
        showServerStatus("Anahtar silindi.")
        app.reconnect()
    }
}

// MARK: - Yapay Zekâ Bağlantıları (Claude Code & Gemini)

private final class AIConnectionsSectionView: NSView {
    private unowned let app: AppModel

    private let claudeDot = StatusDotView()
    private let claudeStatusLabel = NSTextField(wrappingLabelWithString: "")
    private let claudeDetailLabel = NSTextField(wrappingLabelWithString: "")
    private var claudeLoginButton: PillButton!
    private var claudeRefreshButton: PillButton!
    private var claudeOpenURLButton: PillButton!

    private let geminiDot = StatusDotView()
    private let geminiStatusLabel = NSTextField(wrappingLabelWithString: "")
    private let geminiDetailLabel = NSTextField(wrappingLabelWithString: "")
    private var geminiRefreshButton: PillButton!

    private var fetchedClaude: ClaudeControl?
    private var fetchedGemini: GeminiControl?
    private var claudeBusy = false
    private var geminiBusy = false
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let group = SettingsGroupCardView(title: "Yapay Zekâ Bağlantıları")
        addSubview(group)
        NSLayoutConstraint.activate([
            group.leadingAnchor.constraint(equalTo: leadingAnchor),
            group.trailingAnchor.constraint(equalTo: trailingAnchor),
            group.topAnchor.constraint(equalTo: topAnchor),
            group.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        // Claude block
        let claudeTitle = NSTextField.styledLabel("Claude Code", font: Theme.titleFont, color: Theme.textPrimary)
        claudeStatusLabel.font = Theme.captionFont
        claudeStatusLabel.textColor = Theme.textPrimary
        let claudeHeader = NSStackView(views: [claudeDot, claudeTitle, claudeStatusLabel])
        claudeHeader.orientation = .horizontal
        claudeHeader.alignment = .centerY
        claudeHeader.spacing = 8
        group.addFullWidth(claudeHeader)

        claudeDetailLabel.font = Theme.smallFont
        claudeDetailLabel.textColor = Theme.textSecondary
        group.addFullWidth(claudeDetailLabel)

        claudeLoginButton = PillButton(title: "Claude ile giriş yap", kind: .primary, height: 24) { [weak self] in
            guard let self else { return }
            Task { await self.startClaudeLogin() }
        }
        claudeRefreshButton = PillButton(title: "Durumu yenile", kind: .secondary, height: 24) { [weak self] in
            guard let self else { return }
            Task { await self.refreshClaude() }
        }
        claudeOpenURLButton = PillButton(title: "Giriş bağlantısını aç", kind: .outline, height: 24) { [weak self] in
            self?.openClaudeLoginURL()
        }
        claudeOpenURLButton.isHidden = true

        let claudeBtns = NSStackView(views: [claudeLoginButton, claudeRefreshButton, claudeOpenURLButton])
        claudeBtns.orientation = .horizontal
        claudeBtns.alignment = .centerY
        claudeBtns.spacing = 8
        group.stack.addArrangedSubview(claudeBtns)

        group.addFullWidth(HairlineView())

        // Gemini block
        let geminiTitle = NSTextField.styledLabel("Gemini", font: Theme.titleFont, color: Theme.textPrimary)
        geminiStatusLabel.font = Theme.captionFont
        geminiStatusLabel.textColor = Theme.textPrimary
        let geminiHeader = NSStackView(views: [geminiDot, geminiTitle, geminiStatusLabel])
        geminiHeader.orientation = .horizontal
        geminiHeader.alignment = .centerY
        geminiHeader.spacing = 8
        group.addFullWidth(geminiHeader)

        geminiDetailLabel.font = Theme.smallFont
        geminiDetailLabel.textColor = Theme.textSecondary
        group.addFullWidth(geminiDetailLabel)

        geminiRefreshButton = PillButton(title: "Durumu yenile", kind: .secondary, height: 24) { [weak self] in
            guard let self else { return }
            Task { await self.refreshGemini() }
        }
        group.stack.addArrangedSubview(geminiRefreshButton)

        observation = observe { [weak self] in
            self?.render()
        }

        Task { @MainActor [weak self] in
            await self?.loadInitialControls()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var currentClaude: ClaudeAccount? {
        app.presence?.claude ?? fetchedClaude?.account
    }

    private var currentGemini: GeminiAccount? {
        app.presence?.gemini ?? fetchedGemini?.account
    }

    private func loadInitialControls() async {
        async let c = try? app.dataService.claudeControl()
        async let g = try? app.dataService.geminiControl()
        fetchedClaude = await c
        fetchedGemini = await g
        render()
    }

    private func startClaudeLogin() async {
        guard !claudeBusy else { return }
        claudeBusy = true
        render()
        defer {
            claudeBusy = false
            render()
        }
        do {
            fetchedClaude = try await app.dataService.claudeLogin()
            if let urlStr = fetchedClaude?.account?.loginUrl, let url = URL(string: urlStr) {
                NSWorkspace.shared.open(url)
            }
        } catch {
            claudeDetailLabel.stringValue = AppModel.describe(error)
            claudeDetailLabel.isHidden = false
        }
    }

    private func refreshClaude() async {
        guard !claudeBusy else { return }
        claudeBusy = true
        render()
        defer {
            claudeBusy = false
            render()
        }
        if let updated = try? await app.dataService.claudeRefresh() {
            fetchedClaude = updated
        }
    }

    private func openClaudeLoginURL() {
        guard let raw = currentClaude?.loginUrl, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func refreshGemini() async {
        guard !geminiBusy else { return }
        geminiBusy = true
        render()
        defer {
            geminiBusy = false
            render()
        }
        if let updated = try? await app.dataService.geminiRefresh() {
            fetchedGemini = updated
        }
    }

    private func render() {
        let online = app.isOnline || fetchedClaude?.online == true || fetchedGemini?.online == true

        // Claude
        if let claude = currentClaude {
            switch claude.status {
            case .signedIn:
                claudeDot.color = .systemGreen
                let identity = [claude.email, claude.plan.map { "(\($0))" }].compactMap { $0 }.joined(separator: " ")
                claudeStatusLabel.stringValue = identity.isEmpty ? "Giriş yapıldı" : "Giriş yapıldı: \(identity)"
                claudeLoginButton.kind = .secondary
                claudeLoginButton.title = "Hesabı değiştir"
            case .signedOut:
                claudeDot.color = Theme.accent
                claudeStatusLabel.stringValue = "Giriş yapılmadı"
                claudeLoginButton.kind = .primary
                claudeLoginButton.title = "Claude ile giriş yap"
            case .signingIn:
                claudeDot.color = Theme.accent
                claudeStatusLabel.stringValue = "Tarayıcıda giriş bekleniyor…"
                claudeLoginButton.kind = .secondary
                claudeLoginButton.title = "Yeniden dene"
            case .notInstalled:
                claudeDot.color = Theme.textTertiary
                claudeStatusLabel.stringValue = "Kurulu değil"
                claudeLoginButton.kind = .secondary
                claudeLoginButton.title = "Claude ile giriş yap"
            case .error, .unknown:
                claudeDot.color = .systemRed
                claudeStatusLabel.stringValue = "Bağlantı hatası"
                claudeLoginButton.kind = .primary
                claudeLoginButton.title = "Claude ile giriş yap"
            }
            var notes: [String] = []
            if let cli = claude.cliVersion { notes.append("CLI \(cli)") }
            if let detail = claude.detail, !detail.isEmpty { notes.append(detail) }
            claudeDetailLabel.stringValue = notes.joined(separator: " · ")
            claudeDetailLabel.isHidden = notes.isEmpty
            claudeOpenURLButton.isHidden = (claude.loginUrl ?? "").isEmpty
        } else {
            claudeDot.color = Theme.textTertiary
            claudeStatusLabel.stringValue = online ? "Durum okunuyor…" : "Mac worker bağlı değil"
            claudeDetailLabel.stringValue = "Claude abonelik modelleri (Opus, Sonnet, Haiku) için Mac'te Claude girişi kullanılır."
            claudeDetailLabel.isHidden = false
            claudeOpenURLButton.isHidden = true
        }
        claudeLoginButton.showsSpinner = claudeBusy
        claudeLoginButton.isEnabled = online && !claudeBusy && currentClaude?.status != .notInstalled
        claudeRefreshButton.isEnabled = online && !claudeBusy

        // Gemini
        if let gemini = currentGemini {
            switch gemini.status {
            case .ready:
                geminiDot.color = .systemGreen
                let sourceText = switch gemini.mode {
                case .api: ".env GEMINI_API_KEY"
                case .cli: "Gemini CLI\(gemini.cliVersion.map { " \($0)" } ?? "")"
                case .both: ".env GEMINI_API_KEY + Gemini CLI\(gemini.cliVersion.map { " \($0)" } ?? "")"
                case .none, .unknown: "Hazır"
                }
                geminiStatusLabel.stringValue = "Hazır · \(sourceText)"
            case .notConfigured:
                geminiDot.color = Theme.textTertiary
                geminiStatusLabel.stringValue = "Yapılandırılmadı"
            case .error, .unknown:
                geminiDot.color = .systemRed
                geminiStatusLabel.stringValue = "Hata"
            }
            var notes: [String] = []
            if let defModel = gemini.defaultModel { notes.append("Varsayılan model: \(defModel)") }
            if let detail = gemini.detail, !detail.isEmpty { notes.append(detail) }
            geminiDetailLabel.stringValue = notes.joined(separator: " · ")
            geminiDetailLabel.isHidden = notes.isEmpty
        } else {
            geminiDot.color = Theme.textTertiary
            geminiStatusLabel.stringValue = online ? "Durum okunuyor…" : "Mac worker bağlı değil"
            geminiDetailLabel.stringValue = "Depo klasöründeki .env içindeki GEMINI_API_KEY veya Gemini CLI otomatik algılanır."
            geminiDetailLabel.isHidden = false
        }
        geminiRefreshButton.showsSpinner = geminiBusy
        geminiRefreshButton.isEnabled = online && !geminiBusy
    }
}
