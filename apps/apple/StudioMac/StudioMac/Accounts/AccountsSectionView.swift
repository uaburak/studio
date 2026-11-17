import AppKit
import StudioKit

/// Small layout helpers for the accounts and publishing sections.
@MainActor
enum P3UI {
    static func vstack(_ views: [NSView] = [], spacing: CGFloat = 8) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = .vertical
        s.alignment = .leading
        s.spacing = spacing
        return s
    }

    static func hstack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = .horizontal
        s.alignment = .centerY
        s.spacing = spacing
        return s
    }

    static func note(_ text: String, color: NSColor = Theme.textSecondary, width: CGFloat = 470) -> NSTextField {
        let label = NSTextField.styledLabel(text, font: Theme.smallFont, color: color, wraps: true)
        label.preferredMaxLayoutWidth = width
        return label
    }

    static func spacer() -> NSView {
        let v = NSView()
        v.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return v
    }

    static func field(_ placeholder: String, secure: Bool = false, value: String = "") -> NSTextField {
        let f: NSTextField = secure ? NSSecureTextField() : NSTextField()
        f.placeholderString = placeholder
        f.stringValue = value
        f.bezelStyle = .roundedBezel
        return f
    }

    static func steps(_ items: [String]) -> NSStackView {
        let s = vstack(spacing: 4)
        for (i, text) in items.enumerated() {
            s.addArrangedSubview(note("\(i + 1). \(text)"))
        }
        return s
    }

    static func addFull(_ view: NSView, to stack: NSStackView) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
}

/// Settings → "Hesaplar" (and the brand's account sheet): the owner's Meta / LinkedIn app
/// credentials, connected accounts per brand with health, reconnect, check, disconnect.
/// In Settings it uses Claude's tabs + table layout ("Hesaplar | Uygulamalar", search,
/// "+ Bağla", a table of the brand's accounts with "Bağla" rows for missing platforms); the
/// brand's account sheet keeps the plain rows. Presentation only; the logic lives in `AccountsModel`.
final class AccountsSectionView: SettingsPaneView, NSTextFieldDelegate {
    enum Tab: Int, CaseIterable {
        case accounts, apps

        var title: String {
            switch self {
            case .accounts: "Hesaplar"
            case .apps: "Uygulamalar"
            }
        }
    }

    private unowned let app: AppModel
    let model: AccountsModel
    /// Fixed brand (account sheet) or nil (Settings: follows a brand picker).
    private let fixedBrandId: EntityID?
    private let focusPlatform: Platform?
    private var brandId: EntityID?
    /// Settings: tabs + table; the account sheet: plain rows.
    var usesTable: Bool { fixedBrandId == nil }
    private(set) var tab: Tab = .accounts

    private let brandPopup = NSPopUpButton()
    private let accountsList = SettingsGroupBlock()
    private let connectList = SettingsGroupBlock()
    private(set) var toolbar: SettingsTableToolbar?
    let accountsTable = SettingsTableBlock(columns: [
        .init(title: "Hesap", width: nil),
        .init(title: "Platform", width: 96),
        .init(title: "Durum", width: 150),
        .init(title: "", width: 130),
    ])
    private var connectButton: PillButton?
    private var brandRow: SettingsRowView?
    private var appsHeader: SettingsSubheaderView!
    private let flowBox = P3UI.vstack(spacing: 8)
    private var flowBlock: SettingsCustomBlock!
    private var metaRow: SettingsRowView!
    private var linkedInRow: SettingsRowView!
    private var forgetSecretRow: SettingsRowView!
    private let metaSteps = SettingsControls.message()
    private let linkedInSteps = SettingsControls.message()
    private var metaStepsButton: PillButton!
    private var linkedInStepsButton: PillButton!
    private var metaIdField = SettingsControls.field("Uygulama Kimliği (App ID)", width: nil)
    private var metaSecretField = SettingsControls.field("App Secret (isteğe bağlı)", secure: true, width: nil)
    private var linkedInIdField = SettingsControls.field("Client ID", width: nil)
    private var linkedInSecretField = SettingsControls.field("Client Secret", secure: true, width: nil)
    private var observation: ObservationToken?
    private var signature = ""

    init(app: AppModel, brandId: EntityID? = nil, focus platform: Platform? = nil) {
        self.app = app
        self.model = AccountsModel(app: app, defaults: app.settings.defaults)
        self.fixedBrandId = brandId
        self.focusPlatform = platform
        self.brandId = brandId ?? app.currentBrandId
        super.init(section: .accounts, showsTitle: brandId == nil)

        if fixedBrandId == nil {
            let tabs = SettingsTabsView(titles: Tab.allCases.map(\.title))
            tabs.onSelect = { [weak self] index in self?.show(Tab(rawValue: index) ?? .accounts) }
            let connect = PillButton(title: "+ Bağla", kind: .ink, height: 26) { [weak self] in self?.showConnectMenu() }
            connect.toolTip = "Hesap bağla: Instagram ve Facebook ya da LinkedIn"
            connectButton = connect
            let bar = SettingsTableToolbar(tabs: tabs, searchPlaceholder: "Hesaplarda ara", trailing: [connect])
            bar.searchField.target = self
            bar.searchField.action = #selector(localSearchChanged)
            toolbar = bar
            add(SettingsCustomBlock(bar, searchText: nil, verticalPadding: 8))

            brandPopup.target = self
            brandPopup.action = #selector(brandChanged)
            brandPopup.setAccessibilityLabel(SettingsCatalog.accountsBrand.title)
            brandRow = addRow(SettingsCatalog.accountsBrand, accessory: brandPopup)
            flowBlock = SettingsCustomBlock(flowBox, searchText: "hesap bağla instagram facebook linkedin")
            add(flowBlock)
            accountsTable.emptyText = "Önce bir marka oluştur."
            add(accountsTable)
        } else {
            add(accountsList)
            flowBlock = SettingsCustomBlock(flowBox, searchText: "hesap bağla instagram facebook linkedin")
            add(flowBlock)
            add(connectList)
        }

        appsHeader = addSubheader("Uygulamalar")
        metaStepsButton = PillButton(title: "Kurulum adımları", kind: .secondary, height: 26) { [weak self] in
            self?.showSteps(PublishingSetupGuide.meta, title: "Meta uygulaması kurulumu")
        }
        let metaSave = PillButton(title: "Kaydet", kind: .secondary, height: 26) { [weak self] in self?.saveMeta() }
        metaIdField.delegate = self
        metaRow = addRow(SettingsCatalog.metaApp, footer: SettingsControls.formFooter(fields: [metaSteps, metaIdField, metaSecretField], buttons: [metaStepsButton, metaSave]))

        linkedInStepsButton = PillButton(title: "Kurulum adımları", kind: .secondary, height: 26) { [weak self] in
            self?.showSteps(PublishingSetupGuide.linkedIn, title: "LinkedIn uygulaması kurulumu")
        }
        let linkedInSave = PillButton(title: "Kaydet", kind: .secondary, height: 26) { [weak self] in self?.saveLinkedIn() }
        linkedInRow = addRow(SettingsCatalog.linkedInApp, footer: SettingsControls.formFooter(fields: [linkedInSteps, linkedInIdField, linkedInSecretField], buttons: [linkedInStepsButton, linkedInSave]))

        let forget = PillButton(title: "Sil", kind: .outline, height: 26) { [weak self] in try? self?.model.forgetMetaSecret() }
        forgetSecretRow = addRow(SettingsCatalog.forgetMetaSecret, accessory: forget)

        if usesTable { applyTab() }
        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func stop() { model.cancelFlow() }

    override func willClose() { stop() }

    // MARK: Tabs + table (Settings)

    /// "Hesaplar": the brand picker and the accounts table; "Uygulamalar": the Meta / LinkedIn apps.
    func show(_ next: Tab) {
        tab = next
        if let tabs = toolbar?.tabs, tabs.selectedIndex != next.rawValue { tabs.selectedIndex = next.rawValue }
        applyTab()
    }

    private func applyTab() {
        let accountsTab = tab == .accounts
        brandRow?.tabHidden = !accountsTab
        accountsTable.tabHidden = !accountsTab
        for block in [appsHeader, metaRow, linkedInRow, forgetSecretRow] as [SettingsBlock?] {
            block?.tabHidden = accountsTab
        }
        refresh()
    }

    @objc private func localSearchChanged() {
        accountsTable.localQuery = toolbar?.searchField.stringValue ?? ""
        refresh()
    }

    /// "+ Bağla": Instagram ve Facebook / LinkedIn for the brand shown (a native menu).
    private func showConnectMenu() {
        guard let button = connectButton else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in connectMenuItems() { menu.addItem(item) }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.isFlipped ? button.bounds.height + 4 : -4), in: button)
    }

    func connectMenuItems() -> [NSMenuItem] {
        let brand = brandId
        let meta = ClosureMenuItem(title: "Instagram ve Facebook…") { [weak self] in
            guard let self, let brand else { return }
            self.model.startMetaConnect(brandId: brand)
        }
        meta.isEnabled = brand != nil && model.metaConfigured && !model.isBusy
        let linkedIn = ClosureMenuItem(title: "LinkedIn…") { [weak self] in
            guard let self, let brand else { return }
            self.model.startLinkedInConnect(brandId: brand)
        }
        linkedIn.isEnabled = brand != nil && model.linkedInConfigured && !model.isBusy
        var items: [NSMenuItem] = [meta, linkedIn]
        if !model.metaConfigured || !model.linkedInConfigured {
            items.append(.separator())
            items.append(ClosureMenuItem(title: "Uygulamaları ayarla…") { [weak self] in self?.show(.apps) })
        }
        return items
    }

    private func renderTable(_ accounts: [SocialAccount]) {
        guard let brandId else {
            accountsTable.setRows([])
            return
        }
        var rows = accounts.map(tableRow)
        for platform in Platform.knownCases where !accounts.contains(where: { $0.platform == platform && $0.status != .disabled }) {
            rows.append(missingRow(platform, brandId: brandId))
        }
        accountsTable.emptyText = "Bu markaya bağlı hesap yok."
        accountsTable.setRows(rows)
    }

    private func accountMenu(_ account: SocialAccount) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let busy = model.busyAccountIds.contains(account.id)
        if account.status != .disabled {
            let check = ClosureMenuItem(title: "Denetle") { [weak self] in
                guard let self else { return }
                Task { await self.model.check(account) }
            }
            check.isEnabled = !busy && !model.isBusy
            menu.addItem(check)
        }
        let reconnect = ClosureMenuItem(title: account.status == .disabled ? "Bağla" : "Yeniden bağla") { [weak self] in self?.model.reconnect(account) }
        reconnect.isEnabled = !model.isBusy && (account.platform == .linkedin ? model.linkedInConfigured : model.metaConfigured)
        menu.addItem(reconnect)
        if account.status != .disabled {
            menu.addItem(.separator())
            let disconnect = ClosureMenuItem(title: "Bağlantıyı kes…") { [weak self] in self?.confirmDisconnect(account) }
            disconnect.isEnabled = !busy
            menu.addItem(disconnect)
        }
        return menu
    }

    private func tableRow(_ account: SocialAccount) -> SettingsTableBlock.Row {
        let needs = TokenHealthText.needsOwner(account)
        let status = TokenHealthText.label(for: account)
        let busy = model.busyAccountIds.contains(account.id)
        let handle = account.handle.trimmingCharacters(in: .whitespaces)
        let shownHandle = account.platform == .instagram && !handle.hasPrefix("@") && !handle.isEmpty ? "@\(handle)" : (handle.isEmpty ? account.platform.displayName : handle)
        let menu = accountMenu(account)
        var controls: [NSView] = []
        if busy {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            controls.append(spinner)
        } else if needs || account.status == .disabled {
            let reconnect = PillButton(title: account.status == .disabled ? "Bağla" : "Yeniden bağla", kind: needs ? .primary : .secondary, height: 26) { [weak self] in
                self?.model.reconnect(account)
            }
            reconnect.isEnabled = !model.isBusy && (account.platform == .linkedin ? model.linkedInConfigured : model.metaConfigured)
            reconnect.toolTip = TokenHealthText.hint(for: account)
            controls.append(reconnect)
        } else {
            controls.append(SettingsTableCells.check("Bağlı"))
        }
        controls.append(SettingsTableCells.moreButton(accountMenu(account), help: "\(shownHandle): seçenekler"))
        return SettingsTableBlock.Row(
            id: account.id,
            searchText: "\(shownHandle) \(account.platform.displayName) \(status) hesap",
            cells: [
                SettingsTableCells.title(shownHandle, symbol: account.platform.panelSymbol),
                SettingsTableCells.text(account.platform.displayName),
                SettingsTableCells.text(status, color: needs ? Theme.accent : Theme.textSecondary),
                SettingsTableCells.controls(controls),
            ],
            dimmed: account.status == .disabled,
            menu: menu
        )
    }

    private func missingRow(_ platform: Platform, brandId: EntityID) -> SettingsTableBlock.Row {
        let linkedIn = platform == .linkedin
        let configured = linkedIn ? model.linkedInConfigured : model.metaConfigured
        let connect = PillButton(title: "Bağla", kind: .secondary, height: 26) { [weak self] in
            guard let self else { return }
            if linkedIn { self.model.startLinkedInConnect(brandId: brandId) } else { self.model.startMetaConnect(brandId: brandId) }
        }
        connect.isEnabled = configured && !model.isBusy
        connect.toolTip = configured
            ? (linkedIn ? SettingsCatalog.connectLinkedIn.detail : SettingsCatalog.connectMeta.detail)
            : "Önce Uygulamalar sekmesinde \(linkedIn ? "LinkedIn" : "Meta") uygulamasını kaydet."
        connect.setAccessibilityLabel("\(platform.displayName): bağla")
        return SettingsTableBlock.Row(
            id: "missing-\(platform.rawValue)",
            searchText: "\(platform.displayName) bağla hesap ekle",
            cells: [
                SettingsTableCells.title(platform.displayName, symbol: platform.panelSymbol, color: Theme.textSecondary),
                SettingsTableCells.text(platform.displayName),
                SettingsTableCells.text(configured ? "Bağlı değil" : "Uygulama gerekli", color: Theme.textTertiary),
                connect,
            ]
        )
    }

    @objc private func brandChanged() {
        let brands = sortedBrands
        let index = brandPopup.indexOfSelectedItem
        guard brands.indices.contains(index) else { return }
        brandId = brands[index].id
        signature = ""
        render()
    }

    private var sortedBrands: [Brand] { app.brands.sorted { $0.name.localizedCompare($1.name) == .orderedAscending } }

    private func render() {
        let accounts = app.accounts(of: brandId)
        let next = [
            "\(brandId ?? "")", "\(model.phase)", "\(model.credentialsRevision)", "\(model.busyAccountIds.sorted())",
            "\(model.selections.values.map { "\($0.pageId)\($0.facebook)\($0.instagram)" }.sorted())",
            accounts.map { "\($0.id)\($0.status.rawValue)\($0.tokenHealth?.rawValue ?? "")\($0.tokenExpiresAt?.timeIntervalSince1970 ?? 0)\($0.hasToken ?? false)" }.joined(),
            app.brands.map(\.id).joined(),
        ].joined(separator: "|")
        guard next != signature else { return }
        signature = next

        if fixedBrandId == nil {
            brandPopup.removeAllItems()
            for brand in sortedBrands { brandPopup.addItem(withTitle: brand.name) }
            if let index = sortedBrands.firstIndex(where: { $0.id == brandId }) { brandPopup.selectItem(at: index) }
        }
        if usesTable {
            renderTable(accounts)
        } else {
            renderAccounts(accounts)
            renderConnectRows()
        }
        renderFlow()
        renderMeta()
        renderLinkedIn()
        refresh()
    }

    private func renderAccounts(_ accounts: [SocialAccount]) {
        let shown = accounts.filter { focusPlatform == nil || $0.platform == focusPlatform || ($0.platform != .linkedin && focusPlatform != .linkedin) }
        if shown.isEmpty {
            accountsList.setBlocks([SettingsNoteView(brandId == nil ? "Önce bir marka oluştur." : "Bu markaya bağlı hesap yok.")])
            return
        }
        accountsList.setBlocks(shown.map { row($0) })
    }

    private func row(_ account: SocialAccount) -> SettingsRowView {
        let needs = TokenHealthText.needsOwner(account)
        var detail = TokenHealthText.label(for: account)
        if let hint = TokenHealthText.hint(for: account) { detail += "\n\(hint)" }
        let busy = model.busyAccountIds.contains(account.id)
        var buttons: [NSView] = []
        if account.status != .disabled {
            let check = PillButton(title: "Denetle", kind: .secondary, height: 26) { [weak self] in
                guard let self else { return }
                Task { await self.model.check(account) }
            }
            check.isEnabled = !busy && !model.isBusy
            check.showsSpinner = busy
            buttons.append(check)
        }
        let reconnect = PillButton(title: account.status == .disabled ? "Bağla" : "Yeniden bağla", kind: needs ? .primary : .secondary, height: 26) { [weak self] in
            self?.model.reconnect(account)
        }
        reconnect.isEnabled = !model.isBusy && (account.platform == .linkedin ? model.linkedInConfigured : model.metaConfigured)
        buttons.append(reconnect)
        if account.status != .disabled {
            let disconnect = PillButton(title: "Bağlantıyı kes", kind: .outline, height: 26) { [weak self] in self?.confirmDisconnect(account) }
            disconnect.isEnabled = !busy
            buttons.append(disconnect)
        }
        let row = SettingsRowView(title: "\(account.platform.displayName) · \(account.handle)", detail: detail, accessory: SettingsControls.buttons(buttons), keywords: "hesap \(account.platform.rawValue)")
        row.detailColor = needs ? Theme.accent : Theme.textSecondary
        if account.status == .disabled { row.titleColor = Theme.textSecondary }
        return row
    }

    private func confirmDisconnect(_ account: SocialAccount) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "\(account.handle) bağlantısı kesilsin mi?"
        alert.informativeText = "Erişim anahtarı Studio'dan silinir ve bu hesaba yayın yapılmaz. Bekleyen zamanlamalar varsa önce onları iptal etmen istenir. Sonra yeniden bağlayabilirsin."
        alert.addButton(withTitle: "Bağlantıyı kes")
        alert.addButton(withTitle: "Vazgeç")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task { await self.model.disconnect(account) }
        }
    }

    private func renderConnectRows() {
        guard let brandId else {
            connectList.setBlocks([])
            return
        }
        var rows: [SettingsBlock] = []
        if focusPlatform != .linkedin {
            let meta = PillButton(title: "Bağla", kind: .secondary, height: 26) { [weak self] in
                self?.model.startMetaConnect(brandId: brandId)
            }
            meta.isEnabled = model.metaConfigured && !model.isBusy
            meta.toolTip = model.metaConfigured ? "Tarayıcıda Facebook girişi açılır" : "Önce aşağıya Meta Uygulama Kimliğini gir"
            let detail = model.metaConfigured ? SettingsCatalog.connectMeta.detail : "Önce aşağıda Meta uygulamasını kaydet."
            rows.append(SettingsRowView(item: SettingsCatalog.connectMeta, detail: detail, accessory: meta))
        }
        if focusPlatform == nil || focusPlatform == .linkedin {
            let li = PillButton(title: "Bağla", kind: .secondary, height: 26) { [weak self] in
                self?.model.startLinkedInConnect(brandId: brandId)
            }
            li.isEnabled = model.linkedInConfigured && !model.isBusy
            li.toolTip = model.linkedInConfigured ? "Tarayıcıda LinkedIn girişi açılır" : "Önce aşağıya LinkedIn Client ID ve Secret gir"
            let detail = model.linkedInConfigured ? SettingsCatalog.connectLinkedIn.detail : "Önce aşağıda LinkedIn uygulamasını kaydet."
            rows.append(SettingsRowView(item: SettingsCatalog.connectLinkedIn, detail: detail, accessory: li))
        }
        connectList.setBlocks(rows)
    }

    private func renderFlow() {
        flowBox.arrangedSubviews.forEach { $0.removeFromSuperview() }
        switch model.phase {
        case .idle:
            flowBlock.isAvailable = false
            return
        case .waitingForBrowser(let platform):
            flowBox.addArrangedSubview(progressLine("Tarayıcıda \(platform == .linkedin ? "LinkedIn" : "Facebook") girişi bekleniyor… Girişten sonra Studio'ya dön."))
        case .exchanging:
            flowBox.addArrangedSubview(progressLine("Sayfalar ve Instagram hesapları okunuyor…"))
        case .connecting:
            flowBox.addArrangedSubview(progressLine("Hesaplar bağlanıyor, erişim anahtarları şifreli kasaya yazılıyor…"))
        case .picking:
            renderPicker()
        case .finished(let message):
            flowBox.addArrangedSubview(P3UI.hstack([P3UI.note(message, color: Theme.textPrimary, width: 380), P3UI.spacer(),
                                                    PillButton(title: "Tamam", kind: .secondary, height: 26) { [weak self] in self?.model.dismissResult() }]))
        case .failed(let message):
            flowBox.addArrangedSubview(P3UI.hstack([P3UI.note(message, color: Theme.accent, width: 380), P3UI.spacer(),
                                                    PillButton(title: "Kapat", kind: .secondary, height: 26) { [weak self] in self?.model.dismissResult() }]))
        }
        for view in flowBox.arrangedSubviews where view is NSStackView && (view as? NSStackView)?.orientation == .horizontal {
            view.widthAnchor.constraint(equalTo: flowBox.widthAnchor).isActive = true
        }
        flowBlock.isAvailable = true
    }

    private func progressLine(_ text: String) -> NSView {
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let cancel = PillButton(title: "Vazgeç", kind: .secondary, height: 26) { [weak self] in self?.model.cancelFlow() }
        return P3UI.hstack([spinner, P3UI.note(text, color: Theme.textPrimary, width: 330), P3UI.spacer(), cancel])
    }

    private func renderPicker() {
        guard let exchange = model.exchange else { return }
        let brandName = app.brand(brandId)?.name ?? "marka"
        flowBox.addArrangedSubview(NSTextField.styledLabel("\(brandName) için bağlanacak hesapları seç", font: Theme.titleFont))
        if !exchange.missingScopes.isEmpty {
            flowBox.addArrangedSubview(P3UI.note("Verilmeyen izinler: \(exchange.missingScopes.joined(separator: ", ")). Yayın için gerekebilir; eksikse yeniden bağlarken onayla.", color: Theme.accent))
        }
        for page in exchange.pages {
            let sel = model.selections[page.pageId]
            let fb = NSButton(checkboxWithTitle: "Facebook Sayfası · \(page.pageName)", target: self, action: #selector(togglePick(_:)))
            fb.identifier = NSUserInterfaceItemIdentifier("fb:\(page.pageId)")
            fb.state = sel?.facebook == true ? .on : .off
            fb.isEnabled = page.canPublish
            flowBox.addArrangedSubview(fb)
            if let ig = page.instagram {
                let igBox = NSButton(checkboxWithTitle: "Instagram · @\(ig.username)  (\(page.pageName) Sayfasına bağlı)", target: self, action: #selector(togglePick(_:)))
                igBox.identifier = NSUserInterfaceItemIdentifier("ig:\(page.pageId)")
                igBox.state = sel?.instagram == true ? .on : .off
                igBox.isEnabled = page.canPublish
                flowBox.addArrangedSubview(igBox)
            }
            if !page.canPublish {
                flowBox.addArrangedSubview(P3UI.note("Bu Sayfada içerik oluşturma yetkin yok (Sayfa rolü gerekir).", color: Theme.textTertiary))
            }
        }
        let connect = PillButton(title: "Seçilenleri bağla (\(model.pickedCount))", kind: .primary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.model.confirmMetaSelection() }
        }
        connect.isEnabled = model.pickedCount > 0
        let cancel = PillButton(title: "Vazgeç", kind: .secondary, height: 26) { [weak self] in self?.model.cancelFlow() }
        flowBox.addArrangedSubview(P3UI.hstack([P3UI.spacer(), cancel, connect]))
    }

    @objc private func togglePick(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue else { return }
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        let on = sender.state == .on
        if parts[0] == "fb" { model.toggle(pageId: parts[1], facebook: on) } else { model.toggle(pageId: parts[1], instagram: on) }
    }

    private func renderMeta() {
        let shown = focusPlatform != .linkedin
        metaRow.isAvailable = shown
        forgetSecretRow.isAvailable = shown && model.metaHasSecret
        guard shown else { return }
        if model.metaConfigured {
            metaRow.detail = "Uygulama Kimliği: \(model.metaAppId) · App Secret: \(model.metaHasSecret ? "Anahtar Zinciri'nde" : "yok (bağlantılar ~1 saat geçerli olur)")"
            metaSteps.isHidden = true
        } else {
            metaRow.detail = "Hesap bağlamak için kendi Meta uygulaman gerekir."
            metaSteps.stringValue = Self.numbered(PublishingSetupGuide.meta)
            metaSteps.isHidden = false
        }
        metaStepsButton.isHidden = !model.metaConfigured
        metaIdField.stringValue = model.metaAppId
        metaSecretField.stringValue = ""
    }

    private func renderLinkedIn() {
        let shown = focusPlatform == nil || focusPlatform == .linkedin
        linkedInRow.isAvailable = shown
        guard shown else { return }
        if model.linkedInConfigured {
            linkedInRow.detail = "Client ID: \(model.linkedInClientId) · Client Secret Anahtar Zinciri'nde."
            linkedInSteps.isHidden = true
        } else {
            linkedInRow.detail = "LinkedIn'e yayın için kendi LinkedIn uygulaman gerekir."
            linkedInSteps.stringValue = Self.numbered(PublishingSetupGuide.linkedIn)
            linkedInSteps.isHidden = false
        }
        linkedInStepsButton.isHidden = !model.linkedInConfigured
        linkedInIdField.stringValue = model.linkedInClientId
        linkedInSecretField.stringValue = ""
    }

    private static func numbered(_ steps: [String]) -> String {
        "Yapılacaklar:\n" + steps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
    }

    private func saveMeta() {
        do {
            try model.saveMetaApp(appId: metaIdField.stringValue, secret: metaSecretField.stringValue)
        } catch {
            showError(AppModel.describe(error))
        }
    }

    private func saveLinkedIn() {
        do {
            try model.saveLinkedInApp(clientId: linkedInIdField.stringValue, secret: linkedInSecretField.stringValue)
        } catch {
            showError(AppModel.describe(error))
        }
    }

    private func showSteps(_ steps: [String], title: String) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = steps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n\n")
        alert.addButton(withTitle: "Tamam")
        alert.beginSheetModal(for: window)
    }

    private func showError(_ message: String) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "Kaydedilemedi"
        alert.informativeText = message
        alert.beginSheetModal(for: window)
    }
}
