import AppKit
import StudioKit

/// Root view that forwards ⌘1…⌘4 (tab switching) to the sheet.
private final class KeyedRootView: ThemedView {
    var onCommandDigit: ((Int) -> Bool)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let chars = event.charactersIgnoringModifiers, let digit = Int(chars), (1...9).contains(digit),
           onCommandDigit?(digit) == true {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// Brand settings sheet: Genel · Marka kiti · Profil · Hesaplar (⌘1…⌘4, Esc closes).
final class BrandSettingsSheetController: NSViewController {
    let model: BrandSettingsModel
    private let onDone: () -> Void
    private let startAnalysisOnOpen: Bool

    private var tabControl: NSSegmentedControl!
    private let titleLabel = BrandUI.title("")
    private let subtitleLabel = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textSecondary)
    private let container = NSView()
    private let loadBanner = InlineErrorBannerView()
    private var tabViews: [BrandSettingsTab: NSView] = [:]
    private weak var shownTab: NSView?
    private var observation: ObservationToken?
    private var closing = false

    init(app: AppModel, target: BrandSettingsTarget, onDone: @escaping () -> Void) {
        model = BrandSettingsModel(app: app, brandId: target.brandId, tab: target.tab)
        self.onDone = onDone
        startAnalysisOnOpen = target.startAnalysis
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = KeyedRootView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false
        root.onCommandDigit = { [weak self] digit in
            guard let self, let tab = BrandSettingsTab(rawValue: digit - 1) else { return false }
            self.model.tab = tab
            return true
        }

        let titles = BrandUI.vstack([titleLabel, subtitleLabel], spacing: 2)
        let doneButton = PillButton(title: "Bitti", kind: .secondary, height: 28) { [weak self] in
            self?.requestClose()
        }
        doneButton.toolTip = "Kapat (Esc)"
        let header = BrandUI.hstack([titles, BrandUI.spacer(), doneButton])

        tabControl = NSSegmentedControl(
            labels: BrandSettingsTab.allCases.map(\.title), trackingMode: .selectOne,
            target: self, action: #selector(tabPicked)
        )
        tabControl.segmentStyle = .capsule
        tabControl.translatesAutoresizingMaskIntoConstraints = false
        for (index, tab) in BrandSettingsTab.allCases.enumerated() {
            tabControl.setToolTip("\(tab.title) (⌘\(index + 1))", forSegment: index)
        }

        let hairline = HairlineView()
        container.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(header)
        root.addSubview(tabControl)
        root.addSubview(hairline)
        root.addSubview(container)
        loadBanner.isHidden = true
        loadBanner.onDismiss = { [weak self] in
            guard let self else { return }
            Task { await self.model.load() }
        }
        loadBanner.toolTip = "Kapatınca yeniden denenir"
        root.addSubview(loadBanner)
        NSLayoutConstraint.activate([
            loadBanner.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            loadBanner.topAnchor.constraint(equalTo: hairline.bottomAnchor, constant: 10),
            loadBanner.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            root.widthAnchor.constraint(equalToConstant: 780),
            root.heightAnchor.constraint(equalToConstant: 680),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            tabControl.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            tabControl.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 14),
            hairline.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            hairline.topAnchor.constraint(equalTo: tabControl.bottomAnchor, constant: 12),
            container.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            container.topAnchor.constraint(equalTo: hairline.bottomAnchor),
            container.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in self?.render() }
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.model.load()
            if self.startAnalysisOnOpen {
                if self.model.analysisBlocker == nil {
                    await self.model.startAnalysis()
                } else {
                    self.model.tab = .kit
                }
            }
        }
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        model.stop()
    }

    override func cancelOperation(_ sender: Any?) {
        requestClose()
    }

    @objc private func tabPicked() {
        if let tab = BrandSettingsTab(rawValue: tabControl.selectedSegment) { model.tab = tab }
    }

    private func render() {
        let brand = model.brand
        titleLabel.stringValue = brand?.name ?? "Marka"
        var parts: [String] = []
        if let brand {
            parts.append(brand.slug)
            parts.append(BrandLanguage.label(brand.defaultLanguage))
            if brand.status == .archived { parts.append("Arşivde") }
        }
        if let current = model.currentProfile { parts.append("Profil v\(current.version) geçerli") }
        subtitleLabel.stringValue = parts.joined(separator: " · ")
        tabControl.selectedSegment = model.tab.rawValue
        show(model.tab)
        if let error = model.loadError {
            loadBanner.message = "Marka bilgileri yüklenemedi: \(error)"
            loadBanner.isHidden = false
        } else {
            loadBanner.isHidden = true
        }
    }

    private func show(_ tab: BrandSettingsTab) {
        let next: NSView
        if let existing = tabViews[tab] {
            next = existing
        } else {
            next = switch tab {
            case .general: BrandGeneralTabView(model: model)
            case .kit: BrandKitTabView(model: model)
            case .profile: BrandProfileTabView(model: model)
            case .accounts: BrandAccountsTabView(model: model)
            }
            tabViews[tab] = next
        }
        guard shownTab !== next else { return }
        shownTab?.removeFromSuperview()
        next.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(next)
        NSLayoutConstraint.activate([
            next.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            next.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            next.topAnchor.constraint(equalTo: container.topAnchor),
            next.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        shownTab = next
    }

    /// Save the kit, then ask about unsaved profile edits before closing.
    private func requestClose() {
        guard !closing else { return }
        view.window?.makeFirstResponder(nil) // commit the field being edited
        Task { @MainActor [weak self] in
            guard let self else { return }
            let kitSaved = await self.model.saveKitNow()
            if !kitSaved {
                let reason: String = if case .failed(let message) = self.model.kitSave { message } else { "Marka kiti kaydedilemedi." }
                BrandUI.confirm(
                    in: self.view.window, title: "Marka kiti kaydedilmedi", message: reason,
                    confirm: "Yine de kapat", cancel: "Geri dön"
                ) { [weak self] close in
                    if close { self?.close() } else { self?.model.tab = .kit }
                }
                return
            }
            if self.model.draftDirty {
                let alert = NSAlert()
                alert.messageText = "Profil taslağında kaydedilmemiş değişiklikler var"
                alert.informativeText = "v\(self.model.selectedVersion ?? 0) taslağına yaptığın düzenlemeler kaydedilsin mi?"
                alert.addButton(withTitle: "Kaydet ve kapat")
                alert.addButton(withTitle: "Kaydetmeden kapat")
                alert.addButton(withTitle: "Vazgeç")
                guard let window = self.view.window else { return self.close() }
                alert.beginSheetModal(for: window) { [weak self] response in
                    guard let self else { return }
                    switch response {
                    case .alertFirstButtonReturn:
                        Task { @MainActor in
                            await self.model.saveDraft()
                            if self.model.profileError == nil { self.close() }
                        }
                    case .alertSecondButtonReturn:
                        self.close()
                    default:
                        self.model.tab = .profile
                    }
                }
                return
            }
            self.close()
        }
    }

    private func close() {
        closing = true
        model.stop()
        onDone()
        if presentingViewController != nil { dismiss(nil) }
    }
}

// MARK: - Genel

final class BrandGeneralTabView: NSView {
    private let model: BrandSettingsModel
    private let nameField = BrandUI.field("Örn. MTM Agro")
    private let slugField = BrandUI.field("mtm-agro")
    private var languagePopUp: ClosurePopUp!
    private let problemLabel = BrandUI.note()
    private let messageLabel = BrandUI.note()
    private var saveButton: PillButton!
    private let archiveTitle = NSTextField.styledLabel("", font: NSFont.systemFont(ofSize: 13, weight: .semibold), color: Theme.textPrimary)
    private let archiveNote = BrandUI.note()
    private var archiveButton: PillButton!
    private var handlers: [FieldHandler] = []
    private var observation: ObservationToken?

    init(model: BrandSettingsModel) {
        self.model = model
        super.init(frame: .zero)
        let (scroll, stack) = BrandUI.scrollingStack()
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let nameHandler = FieldHandler(onChange: { [weak model] in model?.nameDraft = $0; model?.generalMessage = nil }, onReturn: { [weak self] in self?.save() })
        let slugHandler = FieldHandler(onChange: { [weak model] in model?.slugDraft = $0; model?.generalMessage = nil }, onReturn: { [weak self] in self?.save() })
        handlers = [nameHandler, slugHandler]
        nameField.delegate = nameHandler
        slugField.delegate = slugHandler
        languagePopUp = ClosurePopUp(
            items: BrandLanguage.options.map { ($0.label, $0.tag as Any) },
            selected: { ($0 as? String) == model.languageDraft },
            onPick: { [weak model] value in
                if let tag = value as? String { model?.languageDraft = tag; model?.generalMessage = nil }
            }
        )

        let (card, cardStack) = BrandUI.card(spacing: 8)
        cardStack.addArrangedSubview(BrandUI.caption("Marka adı"))
        BrandUI.addFull(nameField, to: cardStack)
        cardStack.setCustomSpacing(14, after: nameField)
        cardStack.addArrangedSubview(BrandUI.caption("Kısa ad"))
        BrandUI.addFull(slugField, to: cardStack)
        BrandUI.addFull(BrandUI.note("Dosya adlarında ve bağlantılarda kullanılır; tüm markalarda benzersiz olmalı."), to: cardStack)
        cardStack.setCustomSpacing(14, after: cardStack.arrangedSubviews.last!)
        cardStack.addArrangedSubview(BrandUI.caption("İçerik dili"))
        cardStack.addArrangedSubview(languagePopUp)

        saveButton = PillButton(title: "Kaydet", kind: .primary, height: 28) { [weak self] in self?.save() }
        let actions = BrandUI.hstack([problemLabel, messageLabel, BrandUI.spacer(), saveButton])

        let (archiveCard, archiveStack) = BrandUI.card(spacing: 8)
        archiveButton = PillButton(title: "Markayı arşivle…", kind: .secondary, height: 28) { [weak self] in self?.archiveTapped() }
        archiveStack.addArrangedSubview(archiveTitle)
        BrandUI.addFull(archiveNote, to: archiveStack)
        archiveStack.addArrangedSubview(archiveButton)

        BrandUI.addFull(BrandUI.sectionHeader("Marka bilgileri"), to: stack)
        BrandUI.addFull(card, to: stack)
        BrandUI.addFull(actions, to: stack)
        BrandUI.addFull(BrandUI.sectionHeader("Arşiv"), to: stack)
        BrandUI.addFull(archiveCard, to: stack)

        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func render() {
        if nameField.currentEditor() == nil, nameField.stringValue != model.nameDraft { nameField.stringValue = model.nameDraft }
        if slugField.currentEditor() == nil, slugField.stringValue != model.slugDraft { slugField.stringValue = model.slugDraft }
        if let index = BrandLanguage.options.firstIndex(where: { $0.tag == model.languageDraft }) {
            languagePopUp.selectItem(at: index)
        }
        let archived = model.isArchived
        nameField.isEnabled = !archived
        slugField.isEnabled = !archived
        languagePopUp.isEnabled = !archived

        let problem = model.generalDirty ? model.generalProblem : nil
        problemLabel.stringValue = problem ?? model.generalError ?? ""
        problemLabel.textColor = (problem ?? model.generalError) != nil ? .systemRed : Theme.textSecondary
        problemLabel.isHidden = problemLabel.stringValue.isEmpty
        messageLabel.stringValue = model.generalMessage ?? ""
        messageLabel.isHidden = model.generalMessage == nil || !problemLabel.isHidden
        saveButton.isEnabled = model.generalDirty && model.generalProblem == nil && !model.isSavingBrand && !archived
        saveButton.showsSpinner = model.isSavingBrand

        if archived {
            archiveTitle.stringValue = "Bu marka arşivde"
            archiveNote.stringValue = "Kenar çubuğunda görünmez ve yeni içerik üretilmez. Postları, profili ve geçmişi korunur."
            archiveButton.title = "Geri yükle"
            archiveButton.kind = .primary
        } else {
            archiveTitle.stringValue = "Markayı arşivle"
            archiveNote.stringValue = "Arşivlenen marka kenar çubuğundan kalkar; hiçbir veri silinmez ve istediğin zaman geri yükleyebilirsin."
            archiveButton.title = "Markayı arşivle…"
            archiveButton.kind = .secondary
        }
        archiveButton.isEnabled = model.brand != nil && !model.isArchiving
        archiveButton.showsSpinner = model.isArchiving
    }

    private func save() {
        window?.makeFirstResponder(nil)
        Task { await model.saveGeneral() }
    }

    private func archiveTapped() {
        if model.isArchived {
            Task { await model.restore() }
            return
        }
        let name = model.brand?.name ?? "Bu marka"
        BrandUI.confirm(
            in: window, title: "\(name) arşivlensin mi?",
            message: "Marka kenar çubuğundan kalkar ve yeni içerik üretilmez. Postlar, profil sürümleri ve sohbetler silinmez; Genel sekmesinden geri yükleyebilirsin.",
            confirm: "Arşivle"
        ) { [weak self] ok in
            guard ok, let self else { return }
            Task { await self.model.archive() }
        }
    }
}

// MARK: - Hesaplar

final class BrandAccountsTabView: NSView {
    private let model: BrandSettingsModel
    private let rowsStack = BrandUI.vstack(spacing: 10)
    private let errorBanner = InlineErrorBannerView()
    private var fields: [Platform: NSTextField] = [:]
    private var statusViews: [Platform: NSStackView] = [:]
    private var removeButtons: [Platform: PillButton] = [:]
    private var handlers: [FieldHandler] = []
    private var observation: ObservationToken?

    static let platforms: [Platform] = [.instagram, .facebook, .linkedin]

    init(model: BrandSettingsModel) {
        self.model = model
        super.init(frame: .zero)
        let (scroll, stack) = BrandUI.scrollingStack()
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        BrandUI.addFull(BrandUI.sectionHeader("Sosyal hesaplar"), to: stack)
        BrandUI.addFull(BrandUI.note("Markanın hesap adlarını kaydet. Kaydedilen hesap \"Bekliyor\" durumunda tutulur; yayın için ayrıca bağlanması gerekir."), to: stack)

        for platform in Self.platforms {
            let (card, cardStack) = BrandUI.card(spacing: 6, padding: 12)
            let title = NSTextField.styledLabel(platform.displayName, font: Theme.titleFont, color: Theme.textPrimary)
            title.widthAnchor.constraint(equalToConstant: 90).isActive = true
            let field = BrandUI.field(Self.placeholder(platform))
            let handler = FieldHandler(
                onCommit: { [weak self] value in self?.commit(value, platform) },
                onReturn: { [weak self] in self?.window?.makeFirstResponder(nil) }
            )
            handlers.append(handler)
            field.delegate = handler
            fields[platform] = field
            let status = BrandUI.status("", color: Theme.textTertiary)
            status.widthAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
            statusViews[platform] = status
            let remove = PillButton(title: "Kaldır", kind: .secondary, height: 24) { [weak self] in self?.removeTapped(platform) }
            removeButtons[platform] = remove
            let row = BrandUI.hstack([title, field, status, remove], spacing: 10)
            field.setContentHuggingPriority(.defaultLow, for: .horizontal)
            BrandUI.addFull(row, to: cardStack)
            BrandUI.addFull(card, to: rowsStack)
        }
        BrandUI.addFull(rowsStack, to: stack)

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak model] in model?.accountsError = nil }
        BrandUI.addFull(errorBanner, to: stack)

        let connect = PillButton(title: "Hesabı bağla", kind: .secondary, height: 28)
        connect.isEnabled = false
        connect.toolTip = "Henüz bu ekrandan bağlanamıyor"
        let connectNote = BrandUI.note("Hesap bağlama (Meta ve LinkedIn girişi, şifreli anahtar kasası) bu ekranda henüz yok; yayın ve hesap bağlama adımıyla birlikte gelecek. Şimdilik hesap adlarını kaydedebilirsin.")
        let (connectCard, connectStack) = BrandUI.card(spacing: 8)
        connectStack.addArrangedSubview(connect)
        BrandUI.addFull(connectNote, to: connectStack)
        BrandUI.addFull(connectCard, to: stack)

        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    static func placeholder(_ platform: Platform) -> String {
        switch platform {
        case .instagram: "@kullaniciadi"
        case .facebook: "Sayfa adı"
        case .linkedin: "Şirket sayfası adı"
        case .unknown: ""
        }
    }

    private func render() {
        for platform in Self.platforms {
            let account = model.account(for: platform)
            if let field = fields[platform], field.currentEditor() == nil {
                field.stringValue = account?.handle ?? ""
            }
            fields[platform]?.isEnabled = !model.isArchived && model.savingPlatform == nil
            if let status = statusViews[platform] {
                let (text, color) = Self.statusText(account)
                (status.arrangedSubviews.first as? StatusDotView)?.color = color
                (status.arrangedSubviews.last as? NSTextField)?.stringValue = text
            }
            removeButtons[platform]?.isHidden = account == nil
            removeButtons[platform]?.isEnabled = !model.isArchived
        }
        if let error = model.accountsError {
            errorBanner.message = error
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }
    }

    static func statusText(_ account: SocialAccount?) -> (String, NSColor) {
        guard let account else { return ("Eklenmedi", Theme.textTertiary) }
        switch account.status {
        case .connected:
            if let health = account.tokenHealth, health != .valid, health != .unchecked, health != .unknown {
                return ("Bağlı · \(health.label)", Theme.accent)
            }
            return ("Bağlı", .systemGreen)
        case .pending: return ("Bağlanmadı", Theme.textTertiary)
        case .needsReauth: return ("Yeniden giriş gerekli", Theme.accent)
        case .disabled: return ("Kullanılmıyor", Theme.textTertiary)
        case .unknown: return ("Bilinmiyor", Theme.textTertiary)
        }
    }

    private func commit(_ value: String, _ platform: Platform) {
        Task { await model.saveHandle(value, for: platform) }
    }

    private func removeTapped(_ platform: Platform) {
        guard let account = model.account(for: platform) else { return }
        BrandUI.confirm(
            in: window, title: "\(platform.displayName) hesabı kaldırılsın mı?",
            message: "\(account.handle) bu markada kullanılmaz; geçmiş yayın kayıtları korunur.",
            confirm: "Kaldır"
        ) { [weak self] ok in
            guard ok, let self else { return }
            Task { await self.model.disableAccount(account.id) }
        }
    }
}
