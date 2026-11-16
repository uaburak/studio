import AppKit
import StudioKit

/// Pure AppKit left sidebar (`NSSplitViewItem(sidebarWithViewController:)`):
/// - Uses a native `.sourceList` `NSTableView` for macOS sidebar styling & keyboard navigation
/// - Top actions: Yeni sohbet (`+`), Ara (`magnifyingglass`), Postlar (`square.grid.2x2`), Takvim (`calendar`), Medya
/// - Collapsible brand sections with conversation rows (orange dot when `activeRunId != nil`, right-click archive)
/// - Bottom `UserRowView` (monogram, Mac server status, appearance menu + Settings gear).
final class SidebarViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    private unowned let app: AppModel
    private unowned let settings: AppSettings

    private let scrollView = NSScrollView()
    private let tableView = SidebarTableView()
    private var rows: [Row] = []
    private var isSyncingSelection = false
    private var observation: ObservationToken?

    private enum Row: Equatable {
        case actionNewChat
        case actionSearch
        case posts
        case calendar
        case media
        case spacer
        case brandHeader(Brand, expanded: Bool, current: Bool)
        case conversation(Conversation)
        case emptyBrand(EntityID)
        case actionNewBrand
        case unbrandedHeader
        case loadError(String)
    }

    init(app: AppModel, settings: AppSettings) {
        self.app = app
        self.settings = settings
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("main"))
        column.resizingMask = .autoresizingMask
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.style = .sourceList
        tableView.backgroundColor = .clear
        tableView.rowSizeStyle = .custom
        tableView.intercellSpacing = NSSize(width: 0, height: 2)
        tableView.floatsGroupRows = false
        tableView.dataSource = self
        tableView.delegate = self
        tableView.onArchiveConversation = { [weak self] convId in
            guard let self else { return }
            Task { await self.app.conversationModel(convId).archive() }
        }
        tableView.brandMenu = { [weak self] brandId in self?.brandMenu(brandId) }

        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.automaticallyAdjustsContentInsets = true
        scrollView.documentView = tableView
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.applyMinimalScroller()

        let userRow = SidebarUserRowView(app: app, settings: settings)

        root.addSubview(scrollView)
        root.addSubview(userRow)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: userRow.topAnchor),

            userRow.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            userRow.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            userRow.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.reloadSidebar()
        }
    }

    private func buildRows() -> [Row] {
        var list: [Row] = [
            .actionNewChat,
            .actionSearch,
            .posts,
            .calendar,
            .media,
        ]
        for brand in app.sidebarBrands {
            list.append(.spacer)
            let expanded = app.expandedBrands.contains(brand.id)
            list.append(.brandHeader(brand, expanded: expanded, current: brand.id == app.currentBrandId))
            if expanded {
                let convs = app.conversations(of: brand.id)
                if convs.isEmpty {
                    list.append(.emptyBrand(brand.id))
                } else {
                    for conv in convs { list.append(.conversation(conv)) }
                }
            }
        }
        list.append(.spacer)
        list.append(.actionNewBrand)
        let unbranded = app.unbrandedConversations
        if !unbranded.isEmpty {
            list.append(.spacer)
            list.append(.unbrandedHeader)
            for conv in unbranded { list.append(.conversation(conv)) }
        }
        if let err = app.loadError {
            list.append(.spacer)
            list.append(.loadError(err))
        }
        return list
    }

    private func reloadSidebar() {
        let next = buildRows()
        let selection = app.sidebarSelection
        if next != rows {
            rows = next
            tableView.rowConversationIds = rows.map {
                if case .conversation(let c) = $0 { return c.id }
                return nil
            }
            tableView.rowBrandIds = rows.map {
                if case .brandHeader(let brand, _, _) = $0 { return brand.id }
                return nil
            }
            isSyncingSelection = true
            tableView.reloadData()
            isSyncingSelection = false
        }
        syncSelection(to: selection)
    }

    private func syncSelection(to item: SidebarItem?) {
        isSyncingSelection = true
        defer { isSyncingSelection = false }
        guard let item else {
            tableView.deselectAll(nil)
            return
        }
        let targetIndex = rows.firstIndex { row in
            switch (row, item) {
            case (.posts, .posts): true
            case (.calendar, .calendar): true
            case (.media, .media): true
            case (.conversation(let c), .conversation(let id)): c.id == id
            default: false
            }
        }
        if let targetIndex {
            if tableView.selectedRow != targetIndex {
                tableView.selectRowIndexes(IndexSet(integer: targetIndex), byExtendingSelection: false)
            }
        } else {
            tableView.deselectAll(nil)
        }
    }

    // MARK: NSTableViewDataSource / Delegate

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        switch rows[row] {
        case .spacer: 10
        case .brandHeader, .unbrandedHeader: 24
        case .loadError: 62
        default: 28
        }
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        guard rows.indices.contains(row) else { return false }
        switch rows[row] {
        case .actionNewChat:
            app.startNewChat()
            return false
        case .actionSearch:
            app.searchPresented = true
            return false
        case .actionNewBrand:
            app.newBrandPresented = true
            return false
        case .brandHeader(let brand, _, _):
            activateBrand(brand.id)
            return false
        case .posts, .calendar, .media, .conversation:
            return true
        case .spacer, .emptyBrand, .unbrandedHeader, .loadError:
            return false
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !isSyncingSelection else { return }
        let idx = tableView.selectedRow
        guard rows.indices.contains(idx) else { return }
        switch rows[idx] {
        case .posts:
            app.sidebarSelection = .posts
        case .calendar:
            app.sidebarSelection = .calendar
        case .media:
            app.sidebarSelection = .media
        case .conversation(let conv):
            app.sidebarSelection = .conversation(conv.id)
        default:
            break
        }
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = rows[row]
        switch item {
        case .spacer:
            return NSView()

        case .actionNewChat:
            return makeIconLabelCell(symbol: "plus", title: "Yeni sohbet", help: "Yeni sohbet (⌘N)")

        case .actionSearch:
            return makeIconLabelCell(symbol: "magnifyingglass", title: "Ara", help: "Markalarda, sohbetlerde ve postlarda ara (⌘F)")

        case .posts:
            return makeIconLabelCell(symbol: "square.grid.2x2", title: "Postlar", help: "Postlar (⇧⌘P)")

        case .calendar:
            return makeIconLabelCell(symbol: "calendar", title: "Takvim", help: "Yayın takvimi (⇧⌘K)")

        case .media:
            return makeIconLabelCell(symbol: "photo.on.rectangle.angled", title: "Medya", help: "Medya kütüphanesi ve AI görsel üretimi (⇧⌘M)")

        case .actionNewBrand:
            return makeIconLabelCell(symbol: "plus.circle", title: "Yeni marka…", muted: false, help: "Yeni müşteri markası ekle (⇧⌘N)")

        case .brandHeader(let brand, let expanded, let current):
            return makeBrandHeaderCell(brand: brand, expanded: expanded, current: current)

        case .unbrandedHeader:
            let cell = NSTableCellView()
            let label = NSTextField.styledLabel("Markasız", font: Theme.captionFont, color: Theme.textSecondary)
            label.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
                label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell

        case .emptyBrand:
            let cell = NSTableCellView()
            let label = NSTextField.styledLabel("Henüz sohbet yok", font: Theme.captionFont, color: Theme.textTertiary)
            label.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
                label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell

        case .conversation(let conv):
            return makeConversationCell(conv)

        case .loadError(let message):
            let cell = NSTableCellView()
            let lbl = NSTextField.styledLabel(message, font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
            let btn = PillButton(title: "Yeniden dene", kind: .secondary, height: 22) { [weak app] in
                guard let app else { return }
                Task { await app.load() }
            }
            let stack = NSStackView(views: [lbl, btn])
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 6
            stack.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
                stack.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
                stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell
        }
    }

    private func makeIconLabelCell(symbol: String, title: String, trailingText: String? = nil, muted: Bool = false, help: String?) -> NSView {
        let cell = NSTableCellView()
        cell.toolTip = help

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        icon.contentTintColor = muted ? Theme.textTertiary : Theme.textSecondary
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true

        let label = NSTextField.styledLabel(title, font: Theme.rowFont, color: muted ? Theme.textTertiary : Theme.textPrimary)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        cell.textField = label

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [icon, label, spacer]
        if let trailingText {
            views.append(NSTextField.styledLabel(trailingText, font: Theme.smallFont, color: Theme.textTertiary))
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    /// Brand header click: switch to that brand (chat, posts, calendar and media follow);
    /// clicking the current brand again folds or unfolds its conversations.
    private func activateBrand(_ id: EntityID) {
        if app.currentBrandId == id {
            app.toggleBrand(id)
        } else {
            app.selectBrand(id)
        }
    }

    private func brandMenu(_ brandId: EntityID) -> NSMenu? {
        guard let brand = app.brand(brandId) else { return nil }
        let menu = NSMenu()
        func item(_ title: String, _ action: @escaping () -> Void) {
            let entry = ClosureMenuItem(title: title, action: action)
            menu.addItem(entry)
        }
        if app.currentBrandId != brandId {
            item("Bu markaya geç") { [weak app] in app?.selectBrand(brandId) }
            menu.addItem(.separator())
        }
        item("Marka ayarları…") { [weak app] in app?.openBrandSettings(brandId) }
        item("Marka kiti…") { [weak app] in app?.openBrandSettings(brandId, tab: .kit) }
        item("Marka profili…") { [weak app] in app?.openBrandSettings(brandId, tab: .profile) }
        menu.addItem(.separator())
        item("Postlar") { [weak app] in
            app?.selectBrand(brandId)
            app?.navigate(to: .posts)
        }
        item("Takvim") { [weak app] in
            app?.selectBrand(brandId)
            app?.navigate(to: .calendar)
        }
        menu.addItem(.separator())
        item("Markayı arşivle…") { [weak self] in self?.confirmArchive(brand) }
        return menu
    }

    private func confirmArchive(_ brand: Brand) {
        let alert = NSAlert()
        alert.messageText = "\(brand.name) arşivlensin mi?"
        alert.informativeText = "Marka kenar çubuğundan kalkar ve yeni içerik üretilmez. Postlar, profil sürümleri ve sohbetler silinmez; Marka ayarları → Genel'den geri yükleyebilirsin."
        alert.addButton(withTitle: "Arşivle")
        alert.addButton(withTitle: "Vazgeç")
        alert.buttons.last?.keyEquivalent = "\u{1b}"
        let run: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task { @MainActor in
                do {
                    try await self.app.archiveBrand(brand.id)
                } catch {
                    self.app.show(error: error)
                }
            }
        }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: run) } else { run(alert.runModal()) }
    }

    private func makeBrandHeaderCell(brand: Brand, expanded: Bool, current: Bool) -> NSView {
        let cell = BrandHeaderCellView { [weak self] in
            self?.activateBrand(brand.id)
        }
        cell.setAccessibilityLabel("\(brand.name)\(current ? ", seçili marka" : ""), \(expanded ? "daralt" : "genişlet")")
        cell.toolTip = current ? "Seçili marka · tıkla: sohbetleri aç/kapat · sağ tık: marka ayarları" : "Bu markaya geç · sağ tık: marka ayarları"

        let label = NSTextField.styledLabel(
            brand.name,
            font: current ? NSFont.systemFont(ofSize: 12, weight: .semibold) : Theme.captionFont,
            color: current ? Theme.textPrimary : Theme.textSecondary
        )
        let chevron = NSImageView()
        chevron.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 8, weight: .semibold))
        chevron.contentTintColor = Theme.textSecondary

        let row = NSStackView(views: [label, chevron])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    private func makeConversationCell(_ conversation: Conversation) -> NSView {
        let cell = NSTableCellView()
        let label = NSTextField.styledLabel(conversation.displayTitle, font: Theme.rowFont, color: Theme.textPrimary)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        cell.textField = label

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [label, spacer]
        if conversation.activeRunId != nil {
            let dot = StatusDotView(color: Theme.accent)
            dot.toolTip = "Yanıt bekleniyor"
            views.append(dot)
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }
}

private final class BrandHeaderCellView: NSTableCellView {
    private let onClick: () -> Void

    init(onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onClick()
    }
}

/// Menu item that runs a closure.
final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(title: String, action handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func run() { handler() }
}

private final class SidebarTableView: NSTableView {
    var rowConversationIds: [EntityID?] = []
    var rowBrandIds: [EntityID?] = []
    var onArchiveConversation: ((EntityID) -> Void)?
    var brandMenu: ((EntityID) -> NSMenu?)?

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        let row = self.row(at: point)
        if row >= 0, row < rowBrandIds.count, let brandId = rowBrandIds[row] {
            return brandMenu?(brandId)
        }
        guard row >= 0, row < rowConversationIds.count, let convId = rowConversationIds[row] else { return nil }
        let menu = NSMenu()
        let item = NSMenuItem(title: "Sohbeti arşivle", action: #selector(archiveClicked(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = convId
        menu.addItem(item)
        return menu
    }

    @objc private func archiveClicked(_ sender: NSMenuItem) {
        guard let convId = sender.representedObject as? EntityID else { return }
        onArchiveConversation?(convId)
    }
}

// MARK: - Bottom User Row (`● Burak  ⚙`)

private final class SidebarUserRowView: NSView {
    private unowned let app: AppModel
    private unowned let settings: AppSettings
    private let userButton = NSControl()
    private let statusDot = StatusDotView(color: Theme.textTertiary, size: 6)
    private let statusLabel = NSTextField(labelWithString: "")
    private var statusObservation: ObservationToken?

    init(app: AppModel, settings: AppSettings) {
        self.app = app
        self.settings = settings
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        // Neutral monogram: orange is reserved for the primary action and "waiting on you".
        let avatar = ThemedView()
        avatar.translatesAutoresizingMaskIntoConstraints = false
        avatar.backgroundColor = Theme.ink
        avatar.cornerRadius = 11
        let initial = NSTextField.styledLabel("B", font: NSFont.systemFont(ofSize: 11, weight: .semibold), color: Theme.canvas)
        initial.translatesAutoresizingMaskIntoConstraints = false
        avatar.addSubview(initial)
        NSLayoutConstraint.activate([
            avatar.widthAnchor.constraint(equalToConstant: 22),
            avatar.heightAnchor.constraint(equalToConstant: 22),
            initial.centerXAnchor.constraint(equalTo: avatar.centerXAnchor),
            initial.centerYAnchor.constraint(equalTo: avatar.centerYAnchor),
        ])
        let nameLabel = NSTextField.styledLabel("Burak", font: NSFont.systemFont(ofSize: 13, weight: .medium), color: Theme.textPrimary)
        statusLabel.font = Theme.smallFont
        statusLabel.textColor = Theme.textSecondary
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let statusRow = NSStackView(views: [statusDot, statusLabel])
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 5
        let nameColumn = NSStackView(views: [nameLabel, statusRow])
        nameColumn.orientation = .vertical
        nameColumn.alignment = .leading
        nameColumn.spacing = 1

        let profileControl = SidebarUserMenuTrigger { [weak self] anchor in
            self?.showUserMenu(from: anchor)
        }
        profileControl.toolTip = "Görünüm, Mac sunucusu ve ayarlar"
        profileControl.setAccessibilityRole(.popUpButton)
        profileControl.setAccessibilityLabel("Burak: görünüm ve ayarlar")
        let profileStack = NSStackView(views: [avatar, nameColumn])
        profileStack.orientation = .horizontal
        profileStack.alignment = .centerY
        profileStack.spacing = 10
        profileStack.translatesAutoresizingMaskIntoConstraints = false
        profileControl.addSubview(profileStack)
        NSLayoutConstraint.activate([
            profileStack.leadingAnchor.constraint(equalTo: profileControl.leadingAnchor),
            profileStack.trailingAnchor.constraint(equalTo: profileControl.trailingAnchor),
            profileStack.topAnchor.constraint(equalTo: profileControl.topAnchor),
            profileStack.bottomAnchor.constraint(equalTo: profileControl.bottomAnchor),
        ])

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let gear = GlyphButton(symbol: "gearshape", size: 13) { [weak app] in
            app?.openSettings()
        }
        gear.toolTip = "Ayarlar (⌘,)"
        gear.setAccessibilityLabel("Ayarlar")

        let row = NSStackView(views: [profileControl, spacer, gear])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])

        statusObservation = observe { [weak self] in self?.syncStatus() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Mac server status under the name: accent only when something waits on the owner.
    private func syncStatus() {
        let status = app.serverStatus
        statusLabel.stringValue = status.text
        statusDot.color = status.needsOwner ? Theme.accent : (status.text.hasPrefix("Mac hazır") ? Theme.ink : Theme.textTertiary)
        statusLabel.toolTip = app.connectionIssue?.message ?? status.text
        statusLabel.setAccessibilityLabel("Mac sunucusu: \(status.text)")
    }

    private func showUserMenu(from anchor: NSView) {
        let menu = NSMenu()
        let statusItem = NSMenuItem(title: "Mac sunucusu: \(app.serverStatus.text)", action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)
        if let issue = app.connectionIssue {
            for action in issue.actions {
                let entry = ClosureMenuItem(title: RootViewController.title(for: action)) { [weak app] in app?.perform(action) }
                menu.addItem(entry)
            }
        }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Görünüm"))
        for option in AppearancePreference.allCases {
            let item = NSMenuItem(title: option.label, action: #selector(pickAppearance(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = option.rawValue
            item.image = NSImage(systemSymbolName: option.symbol, accessibilityDescription: nil)
            item.state = settings.appearance == option ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "Ayarlar…", action: #selector(openSettings), keyEquivalent: "")
        settingsItem.target = self
        menu.addItem(settingsItem)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: anchor.bounds.height + 4), in: anchor)
    }

    @objc private func pickAppearance(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let pref = AppearancePreference(rawValue: raw) else { return }
        settings.appearance = pref
    }

    @objc private func openSettings() {
        app.openSettings()
    }
}

private final class SidebarUserMenuTrigger: NSControl {
    private let onClick: (NSView) -> Void

    init(onClick: @escaping (NSView) -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onClick(self)
    }

    override func accessibilityPerformPress() -> Bool {
        onClick(self)
        return true
    }

    override func accessibilityPerformShowMenu() -> Bool {
        onClick(self)
        return true
    }
}
