import AppKit
import StudioKit

/// Settings in the Claude-desktop layout (`⌘,`): a rounded panel over the dimmed main window
/// (`RootViewController` hosts it in the window, not as a separate window): "Ayarlar" + close
/// (×) on top, a sidebar (search + sections in groups) on the left, the section's rows on the
/// right. Remembers the last section; deep links (`AppModel.openSettings(_:)`) pick one.
/// Search filters rows across every section. Esc closes (first clears the search).
final class SettingsSheetViewController: NSViewController, NSSearchFieldDelegate {
    private unowned let app: AppModel
    private unowned let settings: AppSettings
    private let host: LocalHost?
    private let onDone: () -> Void
    private(set) var panelSize: NSSize
    private let navigation: SettingsNavigation
    private var widthConstraint: NSLayoutConstraint?
    private var heightConstraint: NSLayoutConstraint?

    let sidebar = SettingsSidebarView()
    private let contentStack = NSStackView()
    private let scroll = NSScrollView()
    private let emptyLabel = NSTextField.styledLabel("Sonuç yok", font: Theme.Settings.rowTitleFont, color: Theme.textSecondary)
    private var panes: [SettingsSection: SettingsPaneView] = [:]
    private var observation: ObservationToken?

    private(set) var selectedSection: SettingsSection
    private(set) var searchQuery = ""
    /// Sections on screen: the selected one, or every section with search hits.
    private(set) var displayedSections: [SettingsSection] = []

    init(app: AppModel, settings: AppSettings, host: LocalHost?, section: SettingsSection? = nil, parentSize: NSSize? = nil, onDone: @escaping () -> Void) {
        self.app = app
        self.settings = settings
        self.host = host
        self.onDone = onDone
        self.panelSize = SettingsLayout.panelSize(fitting: parentSize)
        let navigation = SettingsNavigation(defaults: settings.defaults)
        self.navigation = navigation
        self.selectedSection = navigation.initialSection(requested: section ?? app.settingsRequestedSection)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = SettingsRootView()
        root.backgroundColor = Theme.Settings.panelBackground
        root.borderColor = Theme.Settings.panelBorder
        root.borderWidth = 1
        root.cornerRadius = Theme.Settings.panelRadius
        root.layer?.masksToBounds = true
        root.translatesAutoresizingMaskIntoConstraints = false
        root.onFind = { [weak self] in self?.focusSearch() }
        root.onEscape = { [weak self] in self?.handleEscape() }
        root.setAccessibilityRole(.group)
        root.setAccessibilityLabel("Ayarlar")

        // Header: title left, close right, hairline under it.
        let titleLabel = NSTextField.styledLabel("Ayarlar", font: Theme.Settings.headerTitleFont, color: Theme.textPrimary)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        let closeButton = GlyphButton(symbol: "xmark", size: 12, weight: .medium) { [weak self] in self?.closeSheet() }
        closeButton.toolTip = "Kapat (Esc)"
        closeButton.setAccessibilityLabel("Ayarları kapat")
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        let headerLine = HairlineView()

        // Sidebar and the vertical hairline beside it.
        sidebar.searchField.delegate = self
        sidebar.searchField.target = self
        sidebar.searchField.action = #selector(searchChanged)
        sidebar.onSelect = { [weak self] section in self?.select(section) }
        let sideLine = ThemedView()
        sideLine.backgroundColor = Theme.hairline
        sideLine.translatesAutoresizingMaskIntoConstraints = false

        // Content: thin overlay scroller, rows top-down.
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

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 36
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(contentStack)
        emptyLabel.isHidden = true

        for view in [titleLabel, closeButton, headerLine, sidebar, sideLine, scroll] as [NSView] {
            root.addSubview(view)
        }

        let inset = Theme.Settings.contentInset
        let width = root.widthAnchor.constraint(equalToConstant: panelSize.width)
        let height = root.heightAnchor.constraint(equalToConstant: panelSize.height)
        widthConstraint = width
        heightConstraint = height
        NSLayoutConstraint.activate([
            width,
            height,

            titleLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            titleLabel.centerYAnchor.constraint(equalTo: root.topAnchor, constant: Theme.Settings.headerHeight / 2),
            closeButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            closeButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),

            headerLine.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            headerLine.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            headerLine.topAnchor.constraint(equalTo: root.topAnchor, constant: Theme.Settings.headerHeight),

            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: Theme.Settings.sidebarWidth),
            sidebar.topAnchor.constraint(equalTo: headerLine.bottomAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            sideLine.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            sideLine.widthAnchor.constraint(equalToConstant: 1),
            sideLine.topAnchor.constraint(equalTo: headerLine.bottomAnchor),
            sideLine.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            scroll.leadingAnchor.constraint(equalTo: sideLine.trailingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: headerLine.bottomAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),

            contentStack.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: inset),
            contentStack.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -inset),
            contentStack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 22),
            contentStack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -inset),
        ])

        view = root
        show(section: selectedSection)
        // A deep link's section is the one ⌘, reopens next time too.
        navigation.lastSection = selectedSection
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Deep links while the sheet is already open ("Ayarlar…" in a banner, the usage popover).
        observation = observe { [weak self] in
            guard let self, let requested = self.app.settingsRequestedSection else { return }
            self.app.settingsRequestedSection = nil
            if requested != self.selectedSection || !self.searchQuery.isEmpty { self.select(requested) }
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.initialFirstResponder = sidebar.searchField
        view.window?.makeFirstResponder(sidebar.searchField)
    }

    override func cancelOperation(_ sender: Any?) {
        handleEscape()
    }

    /// Esc: a search is cleared first, then the panel closes.
    func handleEscape() {
        if !sidebar.searchField.stringValue.isEmpty || !searchQuery.isEmpty {
            sidebar.searchField.stringValue = ""
            search("")
        } else {
            closeSheet()
        }
    }

    /// The window was resized: the panel follows (as large as the reference, never larger than the window).
    func fit(parentSize: NSSize) {
        let size = SettingsLayout.panelSize(fitting: parentSize)
        guard size != panelSize else { return }
        panelSize = size
        widthConstraint?.constant = size.width
        heightConstraint?.constant = size.height
    }

    /// The search field takes the keyboard when the panel opens.
    func focusInitial() {
        view.window?.makeFirstResponder(sidebar.searchField)
    }

    // MARK: Navigation

    /// Shows one section (clears any search) and remembers it for the next ⌘,.
    func select(_ section: SettingsSection) {
        if !searchQuery.isEmpty {
            sidebar.searchField.stringValue = ""
            searchQuery = ""
            panes.values.forEach { $0.query = "" }
        }
        selectedSection = section
        navigation.lastSection = section
        show(section: section)
    }

    /// Filters rows across all sections; an empty query returns to the selected section.
    func search(_ text: String) {
        searchQuery = text
        guard !SettingsSearch.tokens(text).isEmpty else {
            panes.values.forEach { $0.query = "" }
            show(section: selectedSection)
            return
        }
        var hits: [SettingsPaneView] = []
        for section in SettingsSection.allCases {
            let pane = pane(for: section)
            pane.query = text
            pane.refresh()
            if pane.visibleBlockCount > 0 { hits.append(pane) }
        }
        sidebar.selected = nil
        display(hits, sections: hits.compactMap(\.section))
        emptyLabel.isHidden = !hits.isEmpty
        if hits.isEmpty { add(emptyLabel) }
    }

    func pane(for section: SettingsSection) -> SettingsPaneView {
        if let existing = panes[section] { return existing }
        let pane: SettingsPaneView = switch section {
        case .brands: BrandsSectionView(app: app)
        case .usage: UsagePaneView(app: app)
        case .appearance: AppearancePaneView(settings: settings, app: app)
        case .ai: AIPaneView(app: app)
        case .notifications: NotificationsPaneView(app: app)
        case .accounts: AccountsSectionView(app: app)
        case .publishing: PublishingSectionView(app: app)
        case .macServer: MacServerSectionView(app: app, settings: settings, host: app.isSample ? nil : host)
        case .devices: DevicesSectionView(model: app.phonePairing)
        case .about: AboutPaneView(app: app, host: host)
        }
        pane.refresh()
        panes[section] = pane
        return pane
    }

    private func show(section: SettingsSection) {
        sidebar.selected = section
        emptyLabel.isHidden = true
        display([pane(for: section)], sections: [section])
    }

    private func display(_ shown: [SettingsPaneView], sections: [SettingsSection]) {
        contentStack.arrangedSubviews.forEach {
            contentStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        shown.forEach { add($0) }
        displayedSections = sections
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func add(_ view: NSView) {
        contentStack.addArrangedSubview(view)
        if view is SettingsPaneView {
            view.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        }
    }

    private func focusSearch() {
        view.window?.makeFirstResponder(sidebar.searchField)
    }

    @objc private func searchChanged() {
        search(sidebar.searchField.stringValue)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard control === sidebar.searchField, commandSelector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        handleEscape()
        return true
    }

    func closeSheet() {
        closePanes()
        onDone()
        if presentingViewController != nil { dismiss(nil) }
    }

    /// Panes stop their work (an account login waiting on port 8793, polling) however the sheet
    /// goes away: "Bitti", esc, or a button that closes Settings to open something else.
    private var panesClosed = false
    func closePanes() {
        guard !panesClosed else { return }
        panesClosed = true
        panes.values.forEach { $0.willClose() }
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        closePanes()
    }
}

/// Panel root: ⌘F focuses the settings search (the global search is off while Settings is
/// open), Esc clears the search or closes.
private final class SettingsRootView: ThemedView {
    var onFind: (() -> Void)?
    var onEscape: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.numericPad, .function])
        if flags == .command, event.charactersIgnoringModifiers == "f" {
            onFind?()
            return true
        }
        if flags.isEmpty, event.keyCode == 53, window?.attachedSheet == nil {
            onEscape?()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}

// MARK: - Görünüm

final class AppearancePaneView: SettingsPaneView, NSTextFieldDelegate {
    private unowned let settings: AppSettings
    private weak var app: AppModel?
    private var control: NSSegmentedControl!
    private let nameField = SettingsControls.field("Adın")
    private var observation: ObservationToken?

    init(settings: AppSettings, app: AppModel? = nil) {
        self.settings = settings
        self.app = app
        super.init(section: .appearance)
        control = NSSegmentedControl(labels: AppearancePreference.allCases.map(\.label), trackingMode: .selectOne, target: self, action: #selector(changed))
        control.setAccessibilityLabel("Tema")
        addRow(SettingsCatalog.theme, accessory: control)
        nameField.stringValue = settings.ownerName
        nameField.delegate = self
        nameField.setAccessibilityLabel(SettingsCatalog.ownerName.title)
        addRow(SettingsCatalog.ownerName, accessory: nameField)
        observation = observe { [weak self] in
            guard let self else { return }
            if let index = AppearancePreference.allCases.firstIndex(of: self.settings.appearance) {
                self.control.selectedSegment = index
            }
            // The Claude account's name shows as the placeholder while nothing is typed.
            self.nameField.placeholderString = self.app?.presence?.claude?.greetingName ?? "Adın"
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func controlTextDidEndEditing(_ obj: Notification) {
        saveName()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard control === nameField, commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
        saveName()
        return true
    }

    private func saveName() {
        let trimmed = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        nameField.stringValue = trimmed
        if settings.ownerName != trimmed { settings.ownerName = trimmed }
    }

    @objc private func changed() {
        let index = control.selectedSegment
        guard AppearancePreference.allCases.indices.contains(index) else { return }
        settings.appearance = AppearancePreference.allCases[index]
    }
}

// MARK: - Kullanım

final class UsagePaneView: SettingsPaneView {
    private unowned let app: AppModel
    private let windows = SettingsGroupBlock()
    private var summaryRow: SettingsRowView!
    private let updatedValue = SettingsControls.value("")
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        super.init(section: .usage)
        summaryRow = addRow(SettingsCatalog.claudeUsage, accessory: updatedValue)
        add(windows)
        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func render() {
        let presence = app.presence
        if let claude = presence?.claude, claude.status == .signedIn {
            let who = [claude.email, claude.plan].compactMap { $0 }.joined(separator: " · ")
            summaryRow.detail = who.isEmpty ? SettingsCatalog.claudeUsage.detail : who
        } else {
            summaryRow.detail = SettingsCatalog.claudeUsage.detail
        }
        guard let usage = presence?.usage, !usage.windows.isEmpty else {
            updatedValue.stringValue = ""
            let text = presence?.online == true
                ? "Henüz bildirilmedi; Claude Code bir işi bitirince gelir."
                : "Arka plan çalışmıyor; Studio hazır olunca gelir."
            windows.setBlocks([SettingsNoteView(text)])
            return
        }
        updatedValue.stringValue = "Güncellendi: \(UsagePopover.relative(usage.observedAt))"
        windows.setBlocks(usage.windows.map { window in
            let color = window.effectivePercent >= UsageIndicator.warnPercent ? Theme.accent : Theme.textSecondary
            let value = SettingsControls.value(UsagePopover.usedText(window), color: color, monospacedDigits: true)
            let reset = window.resetsAt.map { "Sıfırlanma: \(UsagePopover.relative($0))" }
            return SettingsRowView(title: UsagePopover.title(window.kind), detail: reset, accessory: value, keywords: "kullanım claude")
        })
    }
}

// MARK: - Yapay zekâ (defaults, Claude Code, Gemini)

final class AIPaneView: SettingsPaneView {
    private unowned let app: AppModel
    private var modelPopup: NSPopUpButton!
    private var effortPopup: NSPopUpButton!
    private var claudeRow: SettingsRowView!
    private var geminiRow: SettingsRowView!
    private var claudeLoginButton: PillButton!
    private var claudeRefreshButton: PillButton!
    private var claudeOpenURLButton: PillButton!
    private var geminiRefreshButton: PillButton!

    private var fetchedClaude: ClaudeControl?
    private var fetchedGemini: GeminiControl?
    private var claudeError: String?
    private var claudeBusy = false
    private var geminiBusy = false
    private var observation: ObservationToken?

    private static let modelOrder: [AgentModel] = AgentModel.geminiCases + AgentModel.claudeCases

    init(app: AppModel) {
        self.app = app
        super.init(section: .ai)

        modelPopup = SettingsControls.popup([], target: self, action: #selector(modelPicked))
        for (index, model) in Self.modelOrder.enumerated() {
            if index == AgentModel.geminiCases.count { modelPopup.menu?.addItem(.separator()) }
            let item = NSMenuItem(title: model.displayName, action: nil, keyEquivalent: "")
            item.representedObject = model.rawValue
            modelPopup.menu?.addItem(item)
        }
        modelPopup.setAccessibilityLabel(SettingsCatalog.defaultModel.title)
        effortPopup = SettingsControls.popup(AgentEffort.knownCases.map(\.displayName), target: self, action: #selector(effortPicked))
        effortPopup.setAccessibilityLabel(SettingsCatalog.defaultEffort.title)
        addRow(SettingsCatalog.defaultModel, accessory: modelPopup)
        addRow(SettingsCatalog.defaultEffort, accessory: effortPopup)

        claudeLoginButton = PillButton(title: "Giriş yap", kind: .primary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.startClaudeLogin() }
        }
        claudeRefreshButton = PillButton(title: "Yenile", kind: .secondary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.refreshClaude() }
        }
        claudeOpenURLButton = PillButton(title: "Bağlantıyı aç", kind: .secondary, height: 26) { [weak self] in
            self?.openClaudeLoginURL()
        }
        claudeOpenURLButton.isHidden = true
        claudeRow = addRow(SettingsCatalog.claude, accessory: SettingsControls.buttons([claudeOpenURLButton, claudeRefreshButton, claudeLoginButton]))

        geminiRefreshButton = PillButton(title: "Yenile", kind: .secondary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.refreshGemini() }
        }
        geminiRow = addRow(SettingsCatalog.gemini, accessory: geminiRefreshButton)

        observation = observe { [weak self] in self?.render() }
        Task { @MainActor [weak self] in await self?.loadInitialControls() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var currentClaude: ClaudeAccount? { app.presence?.claude ?? fetchedClaude?.account }
    private var currentGemini: GeminiAccount? { app.presence?.gemini ?? fetchedGemini?.account }

    @objc private func modelPicked() {
        guard let raw = modelPopup.selectedItem?.representedObject as? String, let model = AgentModel(rawValue: raw), model != .unknown else { return }
        var choice = app.lastAgentChoice
        choice.model = model
        app.saveAgentChoice(choice, for: nil)
    }

    @objc private func effortPicked() {
        let cases = AgentEffort.knownCases
        guard cases.indices.contains(effortPopup.indexOfSelectedItem) else { return }
        var choice = app.lastAgentChoice
        choice.effort = cases[effortPopup.indexOfSelectedItem]
        app.saveAgentChoice(choice, for: nil)
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
        claudeError = nil
        render()
        defer {
            claudeBusy = false
            render()
        }
        do {
            fetchedClaude = try await app.dataService.claudeLogin()
            if let raw = fetchedClaude?.account?.loginUrl, let url = URL(string: raw) {
                NSWorkspace.shared.open(url)
            }
        } catch {
            claudeError = AppModel.describe(error)
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
        if let updated = try? await app.dataService.claudeRefresh() { fetchedClaude = updated }
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
        if let updated = try? await app.dataService.geminiRefresh() { fetchedGemini = updated }
    }

    private func render() {
        let choice = app.lastAgentChoice
        if let index = modelPopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == choice.model.rawValue }) {
            modelPopup.selectItem(at: index)
        }
        if let index = AgentEffort.knownCases.firstIndex(of: choice.effort) { effortPopup.selectItem(at: index) }

        let online = app.isOnline || fetchedClaude?.online == true || fetchedGemini?.online == true

        // Claude Code: status in the description, sign-in is the one orange button when it waits on the owner.
        var claudeLines: [String] = []
        if let claude = currentClaude {
            switch claude.status {
            case .signedIn:
                let identity = [claude.email, claude.plan.map { "(\($0))" }].compactMap { $0 }.joined(separator: " ")
                claudeLines.append(identity.isEmpty ? "Giriş yapıldı." : "Giriş yapıldı: \(identity)")
                claudeLoginButton.kind = .secondary
                claudeLoginButton.title = "Hesabı değiştir"
            case .signedOut:
                claudeLines.append("Giriş yapılmadı; sohbet ve içerik üretimi çalışmaz.")
                claudeLoginButton.kind = .primary
                claudeLoginButton.title = "Giriş yap"
            case .signingIn:
                claudeLines.append("Tarayıcıda giriş bekleniyor…")
                claudeLoginButton.kind = .secondary
                claudeLoginButton.title = "Yeniden dene"
            case .notInstalled:
                claudeLines.append("Bu Mac'te Claude Code kurulu değil.")
                claudeLoginButton.kind = .secondary
                claudeLoginButton.title = "Giriş yap"
            case .error, .unknown:
                claudeLines.append("Bağlantı hatası.")
                claudeLoginButton.kind = .primary
                claudeLoginButton.title = "Giriş yap"
            }
            var notes: [String] = []
            if let cli = claude.cliVersion { notes.append("CLI \(cli)") }
            if let detail = claude.detail, !detail.isEmpty { notes.append(detail) }
            if !notes.isEmpty { claudeLines.append(notes.joined(separator: " · ")) }
            claudeOpenURLButton.isHidden = (claude.loginUrl ?? "").isEmpty
        } else {
            claudeLines.append(online ? "Durum okunuyor…" : "Arka plan çalışmıyor; Studio hazır olunca okunur.")
            claudeLines.append(SettingsCatalog.claude.detail)
            claudeOpenURLButton.isHidden = true
        }
        if let claudeError { claudeLines.append(claudeError) }
        claudeRow.detail = claudeLines.joined(separator: "\n")
        claudeLoginButton.showsSpinner = claudeBusy
        claudeLoginButton.isEnabled = online && !claudeBusy && currentClaude?.status != .notInstalled
        claudeRefreshButton.isEnabled = online && !claudeBusy

        // Gemini
        var geminiLines: [String] = []
        if let gemini = currentGemini {
            switch gemini.status {
            case .ready:
                let source = switch gemini.mode {
                case .api: ".env GEMINI_API_KEY"
                case .cli: "Gemini CLI\(gemini.cliVersion.map { " \($0)" } ?? "")"
                case .both: ".env GEMINI_API_KEY + Gemini CLI\(gemini.cliVersion.map { " \($0)" } ?? "")"
                case .none, .unknown: ""
                }
                geminiLines.append(source.isEmpty ? "Hazır." : "Hazır · \(source)")
            case .notConfigured:
                geminiLines.append("Yapılandırılmadı.")
                geminiLines.append(SettingsCatalog.gemini.detail)
            case .error, .unknown:
                geminiLines.append("Hata.")
            }
            var notes: [String] = []
            if let model = gemini.defaultModel { notes.append("Varsayılan model: \(model)") }
            if let detail = gemini.detail, !detail.isEmpty { notes.append(detail) }
            if !notes.isEmpty { geminiLines.append(notes.joined(separator: " · ")) }
        } else {
            geminiLines.append(online ? "Durum okunuyor…" : "Arka plan çalışmıyor; Studio hazır olunca okunur.")
            geminiLines.append(SettingsCatalog.gemini.detail)
        }
        geminiRow.detail = geminiLines.joined(separator: "\n")
        geminiRefreshButton.showsSpinner = geminiBusy
        geminiRefreshButton.isEnabled = online && !geminiBusy
    }
}

// MARK: - Bildirimler

final class NotificationsPaneView: SettingsPaneView {
    private unowned let app: AppModel
    private var toggle: NSSwitch!
    private var permissionRow: SettingsRowView!
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        super.init(section: .notifications)
        toggle = SettingsControls.toggle(target: self, action: #selector(toggled))
        toggle.setAccessibilityLabel(SettingsCatalog.notifications.title)
        addRow(SettingsCatalog.notifications, accessory: toggle).tagText = "Bu Mac"
        let open = PillButton(title: "Aç", kind: .secondary, height: 26) {
            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                NSWorkspace.shared.open(url)
            }
        }
        permissionRow = addRow(SettingsCatalog.notificationPermission, accessory: open)
        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func render() {
        let notifier = app.publishing.notifier
        toggle.state = notifier.enabled ? .on : .off
        permissionRow.isAvailable = notifier.authorized == false
    }

    @objc private func toggled() {
        app.publishing.notifier.enabled = toggle.state == .on
    }
}

// MARK: - Hakkında

final class AboutPaneView: SettingsPaneView {
    private unowned let app: AppModel

    init(app: AppModel, host: LocalHost?) {
        self.app = app
        super.init(section: .about)
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "—"
        let build = info["CFBundleVersion"] as? String
        let versionText = build.map { "\(version) (\($0))" } ?? version
        addRow(SettingsCatalog.version, accessory: SettingsControls.value(versionText, monospacedDigits: true))

        if let host {
            let reveal = PillButton(title: "Göster", kind: .secondary, height: 26) {
                NSWorkspace.shared.activateFileViewerSelecting([host.stateDirectory])
            }
            addRow(SettingsCatalog.dataFolder, detail: "\(SettingsCatalog.dataFolder.detail) \(host.stateDirectory.path)", accessory: reveal)
        }

        let guide = PillButton(title: "Aç", kind: .secondary, height: 26) { [weak app] in
            app?.settingsPresented = false
            app?.onboarding.reopen()
        }
        addRow(SettingsCatalog.onboarding, accessory: guide).isAvailable = !app.isSample

        let shortcuts = PillButton(title: "Göster", kind: .secondary, height: 26) { [weak self] in self?.showShortcuts() }
        addRow(SettingsCatalog.shortcuts, accessory: shortcuts)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func showShortcuts() {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "Klavye kısayolları"
        alert.informativeText = ShortcutGuide.text
        alert.addButton(withTitle: "Tamam")
        alert.beginSheetModal(for: window)
    }
}

// MARK: - Harici sunucu (address + Cloudflare Access), shown in "Gelişmiş"

/// The server the app talks to when it does not run its own (or in sample mode),
/// and the Cloudflare Access service token for it (Keychain).
@MainActor
final class ExternalServerRows: NSObject, NSTextFieldDelegate {
    private unowned let app: AppModel
    private unowned let settings: AppSettings
    private let serverField = SettingsControls.field(APIClient.localDefaultURL.absoluteString, width: nil)
    private let clientIdField = SettingsControls.field("Client ID", width: nil)
    private let clientSecretField = SettingsControls.field("Client Secret", secure: true, width: nil)
    private let serverMessage = SettingsControls.message()
    private let accessMessage = SettingsControls.message()
    private var testButton: PillButton!
    private var saveTokenButton: PillButton!
    private var testing = false
    private(set) var forgetRow: SettingsRowView!

    init(app: AppModel, settings: AppSettings) {
        self.app = app
        self.settings = settings
        super.init()
        serverField.stringValue = settings.serverURLString
        serverField.delegate = self
        clientIdField.stringValue = (try? settings.credentials.load())?.clientId ?? ""
        clientIdField.delegate = self
        clientSecretField.delegate = self
    }

    func serverRow() -> SettingsRowView {
        testButton = PillButton(title: "Bağlantıyı dene", kind: .secondary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.testServer() }
        }
        let save = PillButton(title: "Kaydet ve bağlan", kind: .secondary, height: 26) { [weak self] in self?.saveServer() }
        let footer = SettingsControls.formFooter(fields: [serverField], buttons: [testButton, save], message: serverMessage)
        return SettingsRowView(item: SettingsCatalog.serverURL, footer: footer)
    }

    func accessRow() -> SettingsRowView {
        saveTokenButton = PillButton(title: "Kaydet", kind: .secondary, height: 26) { [weak self] in self?.saveToken() }
        saveTokenButton.isEnabled = false
        let footer = SettingsControls.formFooter(fields: [clientIdField, clientSecretField], buttons: [saveTokenButton], message: accessMessage)
        return SettingsRowView(item: SettingsCatalog.access, footer: footer)
    }

    func makeForgetRow() -> SettingsRowView {
        let delete = PillButton(title: "Sil", kind: .outline, height: 26) { [weak self] in self?.deleteToken() }
        forgetRow = SettingsRowView(item: SettingsCatalog.forgetAccess, accessory: delete)
        forgetRow.isAvailable = (try? settings.credentials.load()) != nil
        return forgetRow
    }

    func controlTextDidChange(_ obj: Notification) {
        saveTokenButton?.isEnabled = !clientIdField.stringValue.isEmpty && !clientSecretField.stringValue.isEmpty
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
        if control === serverField {
            saveServer()
            return true
        }
        if control === clientSecretField, saveTokenButton.isEnabled {
            saveToken()
            return true
        }
        return false
    }

    private func show(_ label: NSTextField, _ text: String, error: Bool = false) {
        label.stringValue = text
        label.textColor = error ? Theme.accent : Theme.textSecondary
        label.isHidden = text.isEmpty
    }

    private func saveServer() {
        settings.serverURLString = serverField.stringValue
        guard settings.serverURL != nil else {
            show(serverMessage, "Adres http:// ya da https:// ile başlamalı.", error: true)
            return
        }
        app.reconnect()
        show(serverMessage, "Kaydedildi.")
    }

    private func testServer() async {
        guard !testing else { return }
        testing = true
        testButton.showsSpinner = true
        testButton.isEnabled = false
        defer {
            testing = false
            testButton.showsSpinner = false
            testButton.isEnabled = true
        }
        let raw = serverField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw), url.scheme?.hasPrefix("http") == true else {
            show(serverMessage, "Adres geçersiz.", error: true)
            return
        }
        do {
            let health = try await APIClient(baseURL: url, auth: AccessServiceTokenAuth(store: settings.credentials)).health()
            show(serverMessage, "Bağlandı: \(health.service) \(health.version), veritabanı \(health.checks.db).")
        } catch {
            show(serverMessage, error.errorDescription ?? error.localizedDescription, error: true)
        }
    }

    private func saveToken() {
        do {
            try settings.credentials.save(AccessServiceToken(clientId: clientIdField.stringValue, clientSecret: clientSecretField.stringValue))
            clientSecretField.stringValue = ""
            saveTokenButton.isEnabled = false
            forgetRow?.isAvailable = true
            show(accessMessage, "Anahtar kaydedildi.")
            app.reconnect()
        } catch {
            show(accessMessage, error.localizedDescription, error: true)
        }
    }

    private func deleteToken() {
        do {
            try settings.credentials.delete()
        } catch {
            show(accessMessage, "Anahtar silinemedi: \(error.localizedDescription)", error: true)
            return
        }
        clientIdField.stringValue = ""
        clientSecretField.stringValue = ""
        saveTokenButton.isEnabled = false
        forgetRow?.isAvailable = false
        show(accessMessage, "Anahtar silindi.")
        app.reconnect()
    }
}
