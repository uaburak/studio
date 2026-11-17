import AppKit
import StudioKit

// MARK: - Sidebar rows (pure: built from the app state, tested)

/// The fixed actions at the top of the sidebar (Claude Code: "New session", "Search", …).
enum SidebarAction: CaseIterable, Equatable {
    case newChat, search, posts, calendar, media, brands

    var title: String {
        switch self {
        case .newChat: "Yeni sohbet"
        case .search: "Ara"
        case .posts: "Postlar"
        case .calendar: "Takvim"
        case .media: "Medya"
        case .brands: "Markalar"
        }
    }

    var symbol: String {
        switch self {
        case .newChat: "plus"
        case .search: "magnifyingglass"
        case .posts: "square.grid.2x2"
        case .calendar: "calendar"
        case .media: "photo.on.rectangle.angled"
        case .brands: "tag"
        }
    }

    var help: String {
        switch self {
        case .newChat: "Yeni sohbet (⌘N)"
        case .search: "Sohbetlerde, postlarda ve markalarda ara (⌘K)"
        case .posts: "Postlar (⇧⌘P)"
        case .calendar: "Yayın takvimi (⇧⌘K)"
        case .media: "Medya kütüphanesi ve AI görsel üretimi (⇧⌘M)"
        case .brands: "Markalar: ekle, arşivle, ayarlar"
        }
    }

    /// Shortcut shown greyed on the right of the row.
    var shortcutHint: String? {
        switch self {
        case .search: "⌘K"
        default: nil
        }
    }

    /// The screen this row stands for: it is highlighted while that screen is shown.
    var route: Route? {
        switch self {
        case .newChat: .newChat
        case .posts: .posts
        case .calendar: .calendar
        case .media: .media
        case .search, .brands: nil
        }
    }
}

/// A collapsible history group: one brand's conversations, or the unbranded ones.
struct SidebarGroup: Equatable {
    /// nil: the "Markasız" group.
    var brandId: EntityID?
    var title: String
    var expanded: Bool
    /// The working brand (new chats, posts, calendar and media follow it).
    var current: Bool
}

enum SidebarRow: Equatable {
    case action(SidebarAction)
    case spacer(CGFloat)
    case groupHeader(SidebarGroup)
    case conversation(Conversation)
    case emptyGroup
    case loadError(String)

    /// Claude Code: every row 34 pt (a 32 pt rounded fill), group headers included.
    var height: CGFloat {
        switch self {
        case .action: 34
        case .spacer(let height): height
        case .groupHeader: 34
        case .conversation: 34
        case .emptyGroup: 28
        case .loadError: 62
        }
    }

    /// Rows that get the rounded hover fill.
    var isHoverable: Bool {
        switch self {
        case .action, .conversation: true
        default: false
        }
    }
}

enum SidebarRows {
    static let unbrandedTitle = "Markasız"
    /// Space after the actions and between history groups.
    static let groupSpacing: CGFloat = 18

    /// Actions, then the history grouped by brand (sidebar order), then unbranded conversations.
    static func build(
        brands: [Brand],
        conversations: (EntityID) -> [Conversation],
        unbranded: [Conversation],
        expandedBrands: Set<EntityID>,
        unbrandedExpanded: Bool,
        currentBrandId: EntityID?,
        loadError: String?
    ) -> [SidebarRow] {
        var list: [SidebarRow] = SidebarAction.allCases.map { .action($0) }
        list.append(.spacer(groupSpacing))
        for brand in brands {
            let expanded = expandedBrands.contains(brand.id)
            list.append(.groupHeader(SidebarGroup(brandId: brand.id, title: brand.name, expanded: expanded, current: brand.id == currentBrandId)))
            if expanded {
                let items = conversations(brand.id)
                if items.isEmpty {
                    list.append(.emptyGroup)
                } else {
                    list += items.map { .conversation($0) }
                }
            }
            list.append(.spacer(groupSpacing))
        }
        if !unbranded.isEmpty {
            list.append(.groupHeader(SidebarGroup(brandId: nil, title: unbrandedTitle, expanded: unbrandedExpanded, current: false)))
            if unbrandedExpanded { list += unbranded.map { .conversation($0) } }
            list.append(.spacer(groupSpacing))
        }
        if let loadError { list.append(.loadError(loadError)) }
        return list
    }

    @MainActor
    static func build(app: AppModel, unbrandedExpanded: Bool = true) -> [SidebarRow] {
        build(
            brands: app.sidebarBrands,
            conversations: { app.conversations(of: $0) },
            unbranded: app.unbrandedConversations,
            expandedBrands: app.expandedBrands,
            unbrandedExpanded: unbrandedExpanded,
            currentBrandId: app.currentBrandId,
            loadError: app.loadError
        )
    }

    /// The row highlighted for `route` (nil: none stands for it).
    static func index(of route: Route, in rows: [SidebarRow]) -> Int? {
        rows.firstIndex { row in
            switch row {
            case .action(let action): action.route == route
            case .conversation(let conversation): route == .conversation(conversation.id)
            default: false
            }
        }
    }
}

/// Footer text: who is working and on which brand.
enum SidebarFooter {
    /// When neither "Adın" nor the Claude account gives a name.
    static let fallbackName = "Studio"

    static func name(_ owner: String?) -> String {
        let trimmed = owner?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? fallbackName : trimmed
    }

    static func initial(_ owner: String?) -> String {
        String(name(owner).prefix(1)).uppercased(with: Locale(identifier: "tr_TR"))
    }

    static func title(owner: String?, brandName: String?) -> String {
        let name = name(owner)
        guard let brandName, !brandName.isEmpty else { return name }
        return "\(name) · \(brandName)"
    }
}

// MARK: - SidebarViewController

/// Flush left sidebar in the Claude Code layout (pure AppKit, plain `NSTableView`):
/// - Actions with SF Symbols: Yeni sohbet, Ara, Postlar, Takvim, Medya, Markalar
/// - History grouped by brand: small grey header with a chevron (click folds, hover "+" starts a
///   chat in that brand, right-click: brand menu); single-line conversation rows with a rounded
///   selection, an orange dot while a reply runs and a "…" menu on hover (rename, archive)
/// - Footer: orange "B" avatar, one line "Burak · <marka> ⌄" (menu: brand switch, Mac server
///   status, appearance, iPhone, settings) and a gear.
/// Every row is 34 pt; the column runs up under the top bar (`TopBarView`), whose sidebar part
/// shares this background.
final class SidebarViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    private unowned let app: AppModel
    private unowned let settings: AppSettings

    private let scrollView = NSScrollView()
    private let tableView = SidebarTableView()
    /// What the table shows now (tests read it).
    private(set) var rows: [SidebarRow] = []
    private var unbrandedExpanded = true
    private var isSyncingSelection = false
    private var observation: ObservationToken?

    init(app: AppModel, settings: AppSettings) {
        self.app = app
        self.settings = settings
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.sidebarBackground
        root.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("main"))
        column.resizingMask = .autoresizingMask
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.style = .plain
        tableView.backgroundColor = .clear
        tableView.rowSizeStyle = .custom
        tableView.intercellSpacing = NSSize(width: 0, height: 0)
        tableView.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        tableView.focusRingType = .none
        tableView.floatsGroupRows = false
        tableView.allowsEmptySelection = true
        tableView.dataSource = self
        tableView.delegate = self
        tableView.target = self
        tableView.action = #selector(rowClicked)
        tableView.setAccessibilityLabel("Kenar çubuğu")
        tableView.menuProvider = { [weak self] row in self?.contextMenu(forRow: row) }

        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.automaticallyAdjustsContentInsets = true
        scrollView.documentView = tableView
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.applyMinimalScroller()

        let footer = SidebarFooterView(app: app, settings: settings)

        root.addSubview(scrollView)
        root.addSubview(footer)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: footer.topAnchor),

            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.reloadSidebar()
        }
    }

    private func reloadSidebar() {
        let next = SidebarRows.build(app: app, unbrandedExpanded: unbrandedExpanded)
        let route = app.route
        if next != rows {
            rows = next
            isSyncingSelection = true
            tableView.reloadData()
            isSyncingSelection = false
        }
        syncSelection(to: route)
    }

    private func syncSelection(to route: Route) {
        isSyncingSelection = true
        defer { isSyncingSelection = false }
        if let target = SidebarRows.index(of: route, in: rows) {
            if tableView.selectedRow != target {
                tableView.selectRowIndexes(IndexSet(integer: target), byExtendingSelection: false)
            }
        } else {
            tableView.deselectAll(nil)
        }
    }

    // MARK: Actions

    /// A click on the already highlighted "Yeni sohbet" row (no selection change) still
    /// brings the focus back to the composer.
    @objc private func rowClicked() {
        let row = tableView.clickedRow
        guard rows.indices.contains(row), rows[row] == .action(.newChat), row == tableView.selectedRow, app.route == .newChat else { return }
        app.newChat.focusRequest += 1
    }

    private func perform(_ action: SidebarAction) {
        switch action {
        case .newChat: app.startNewChat()
        case .search: app.searchPresented = true
        case .posts: app.sidebarSelection = .posts
        case .calendar: app.sidebarSelection = .calendar
        case .media: app.sidebarSelection = .media
        case .brands: app.openSettings(.brands)
        }
    }

    private func toggle(_ group: SidebarGroup) {
        if let brandId = group.brandId {
            app.toggleBrand(brandId)
        } else {
            unbrandedExpanded.toggle()
            reloadSidebar()
        }
    }

    /// "+" on a brand header: a new chat in that brand.
    private func startChat(inBrand brandId: EntityID) {
        guard app.switchToBrand(brandId) else {
            app.banner = "Eklenmiş görseller markaya bağlı; markayı değiştirmek için önce onları kaldır."
            return
        }
        app.startNewChat()
    }

    private func contextMenu(forRow row: Int) -> NSMenu? {
        guard rows.indices.contains(row) else { return nil }
        switch rows[row] {
        case .groupHeader(let group):
            return group.brandId.flatMap { brandMenu($0) }
        case .conversation(let conversation):
            return ConversationActions.makeMenu(app: app, conversationId: conversation.id) { [weak self] in self?.view.window }
        default:
            return nil
        }
    }

    private func brandMenu(_ brandId: EntityID) -> NSMenu? {
        guard let brand = app.brand(brandId) else { return nil }
        let menu = NSMenu()
        func item(_ title: String, _ action: @escaping () -> Void) {
            menu.addItem(ClosureMenuItem(title: title, action: action))
        }
        if app.currentBrandId != brandId {
            item("Bu markaya geç") { [weak app] in app?.selectBrand(brandId) }
        }
        item("Bu markada yeni sohbet") { [weak self] in self?.startChat(inBrand: brandId) }
        menu.addItem(.separator())
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

    // MARK: NSTableViewDataSource / Delegate

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        rows.indices.contains(row) ? rows[row].height : 28
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = SidebarRowView()
        view.isHoverable = rows.indices.contains(row) && rows[row].isHoverable
        return view
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        guard rows.indices.contains(row) else { return false }
        switch rows[row] {
        case .action(let action):
            switch action {
            case .posts, .calendar, .media:
                return true
            case .newChat, .search, .brands:
                perform(action)
                return false
            }
        case .conversation:
            return true
        case .spacer, .groupHeader, .emptyGroup, .loadError:
            return false
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !isSyncingSelection else { return }
        let index = tableView.selectedRow
        guard rows.indices.contains(index) else { return }
        switch rows[index] {
        case .action(let action):
            perform(action)
        case .conversation(let conversation):
            app.sidebarSelection = .conversation(conversation.id)
        default:
            break
        }
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        switch rows[row] {
        case .spacer:
            return NSView()

        case .action(let action):
            return SidebarActionCellView(action: action)

        case .groupHeader(let group):
            let cell = SidebarGroupHeaderCellView(group: group)
            cell.onToggle = { [weak self] in self?.toggle(group) }
            if let brandId = group.brandId {
                cell.onNewChat = { [weak self] in self?.startChat(inBrand: brandId) }
            }
            return cell

        case .conversation(let conversation):
            let cell = SidebarConversationCellView(conversation: conversation)
            cell.makeMenu = { [weak self] in
                guard let self else { return NSMenu() }
                return ConversationActions.makeMenu(app: self.app, conversationId: conversation.id) { [weak self] in self?.view.window }
            }
            return cell

        case .emptyGroup:
            let cell = NSTableCellView()
            let label = NSTextField.styledLabel("Henüz sohbet yok", font: Theme.captionFont, color: Theme.textTertiary)
            label.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: SidebarMetrics.contentLeading),
                label.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -SidebarMetrics.contentLeading),
                label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell

        case .loadError(let message):
            let cell = NSTableCellView()
            let label = NSTextField.styledLabel(message, font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
            let retry = PillButton(title: "Yeniden dene", kind: .secondary, height: 22) { [weak app] in
                guard let app else { return }
                Task { await app.load() }
            }
            let stack = NSStackView(views: [label, retry])
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 6
            stack.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: SidebarMetrics.contentLeading),
                stack.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -SidebarMetrics.contentLeading),
                stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell
        }
    }
}

// MARK: - Metrics

private enum SidebarMetrics {
    /// Text and icons start here: the row's rounded fill inset plus its inner padding.
    static let contentLeading: CGFloat = Theme.sidebarRowInset + 10
    static let contentTrailing: CGFloat = Theme.sidebarRowInset + 6
}

// MARK: - Table, row view and cells

private final class SidebarTableView: NSTableView {
    var menuProvider: ((Int) -> NSMenu?)?

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        return menuProvider?(row(at: point))
    }
}

/// Rounded neutral selection and hover fill, inset from the sidebar edges (Claude Code style).
final class SidebarRowView: NSTableRowView {
    var isHoverable = true
    private var hovering = false {
        didSet { if hovering != oldValue { needsDisplay = true } }
    }
    private var trackingArea: NSTrackingArea?

    /// Text stays in its normal colours on the grey selection (no "emphasized" white text).
    override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }

    private var fillRect: NSRect { bounds.insetBy(dx: Theme.sidebarRowInset, dy: 1) }

    override func drawSelection(in dirtyRect: NSRect) {
        guard selectionHighlightStyle != .none else { return }
        Theme.sidebarSelection.setFill()
        NSBezierPath(roundedRect: fillRect, xRadius: Theme.sidebarRowRadius, yRadius: Theme.sidebarRowRadius).fill()
    }

    override func drawBackground(in dirtyRect: NSRect) {
        guard isHoverable, hovering, !isSelected else { return }
        Theme.sidebarHover.setFill()
        NSBezierPath(roundedRect: fillRect, xRadius: Theme.sidebarRowRadius, yRadius: Theme.sidebarRowRadius).fill()
    }

    override func drawSeparator(in dirtyRect: NSRect) {}

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

private final class SidebarActionCellView: NSTableCellView {
    init(action: SidebarAction) {
        super.init(frame: .zero)
        toolTip = action.help
        setAccessibilityLabel(action.title)

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: action.symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        icon.contentTintColor = Theme.textSecondary
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true

        let label = NSTextField.styledLabel(action.title, font: Theme.rowFont, color: Theme.textPrimary)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textField = label

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [icon, label, spacer]
        if let hint = action.shortcutHint {
            let hintLabel = NSTextField.styledLabel(hint, font: Theme.smallFont, color: Theme.textTertiary)
            hintLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
            views.append(hintLabel)
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: SidebarMetrics.contentLeading - 2),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -SidebarMetrics.contentTrailing - 4),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Small grey brand header: click folds / unfolds; on hover a "+" starts a chat in that brand.
private final class SidebarGroupHeaderCellView: NSTableCellView {
    var onToggle: (() -> Void)?
    var onNewChat: (() -> Void)? {
        didSet { plusButton.isHidden = true }
    }

    private let plusButton = GlyphButton(symbol: "plus", size: 10, weight: .semibold, diameter: 20)
    private var trackingArea: NSTrackingArea?

    init(group: SidebarGroup) {
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("\(group.title)\(group.current ? ", seçili marka" : ""), \(group.expanded ? "daralt" : "genişlet")")
        toolTip = group.brandId == nil
            ? "Markasız sohbetler · tıkla: aç/kapat"
            : "Tıkla: sohbetleri aç/kapat · sağ tık: marka menüsü"

        let label = NSTextField.styledLabel(
            group.title,
            font: NSFont.systemFont(ofSize: 12, weight: group.current ? .semibold : .medium),
            color: group.current ? Theme.textPrimary : Theme.textSecondary
        )
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let chevron = NSImageView()
        chevron.image = NSImage(systemSymbolName: group.expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 8, weight: .semibold))
        chevron.contentTintColor = Theme.textTertiary

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        plusButton.isHidden = true
        plusButton.toolTip = "Bu markada yeni sohbet"
        plusButton.onAction = { [weak self] in self?.onNewChat?() }

        let row = NSStackView(views: [label, chevron, spacer, plusButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: SidebarMetrics.contentLeading),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -SidebarMetrics.contentTrailing),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            row.heightAnchor.constraint(equalToConstant: 20),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) { onToggle?() }

    override func accessibilityPerformPress() -> Bool {
        onToggle?()
        return true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { plusButton.isHidden = onNewChat == nil }
    override func mouseExited(with event: NSEvent) { plusButton.isHidden = true }
}

/// One conversation: a single truncated line, an orange dot while a reply runs, "…" on hover.
private final class SidebarConversationCellView: NSTableCellView {
    var makeMenu: (() -> NSMenu)?

    private let moreButton = GlyphButton(symbol: "ellipsis", size: 11, weight: .semibold, diameter: 20)
    private var trackingArea: NSTrackingArea?

    init(conversation: Conversation) {
        super.init(frame: .zero)
        let label = NSTextField.styledLabel(conversation.displayTitle, font: Theme.rowFont, color: Theme.textPrimary)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textField = label
        toolTip = conversation.displayTitle

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [label, spacer]
        if conversation.activeRunId != nil {
            let dot = StatusDotView(color: Theme.accent)
            dot.toolTip = "Yanıt bekleniyor"
            dot.setAccessibilityLabel("Yanıt bekleniyor")
            views.append(dot)
        }
        moreButton.isHidden = true
        moreButton.toolTip = "Sohbet seçenekleri"
        moreButton.onAction = { [weak self] in self?.showMenu() }
        views.append(moreButton)

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: SidebarMetrics.contentLeading),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -SidebarMetrics.contentTrailing),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            row.heightAnchor.constraint(equalToConstant: 20),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func showMenu() {
        guard let menu = makeMenu?() else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -2), in: moreButton)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { moreButton.isHidden = false }
    override func mouseExited(with event: NSEvent) { moreButton.isHidden = true }
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

// MARK: - Footer (`(B) Burak · MTM Agro ⌄   ⚙`)

/// Claude Code's footer: an orange monogram, "Burak · MTM Agro ⌄" (the menu: brand switch, Mac
/// server status, appearance, iPhone, settings) and the gear on the right.
private final class SidebarFooterView: NSView {
    private unowned let app: AppModel
    private unowned let settings: AppSettings
    private let nameLabel = NSTextField(labelWithString: "")
    private let initialLabel = NSTextField(labelWithString: "")
    private let profileControl: SidebarMenuTrigger
    private var observation: ObservationToken?

    init(app: AppModel, settings: AppSettings) {
        self.app = app
        self.settings = settings
        self.profileControl = SidebarMenuTrigger()
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let avatar = ThemedView()
        avatar.translatesAutoresizingMaskIntoConstraints = false
        avatar.backgroundColor = Theme.accent
        avatar.cornerRadius = 9
        initialLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
        initialLabel.textColor = Theme.onAccent
        initialLabel.translatesAutoresizingMaskIntoConstraints = false
        avatar.addSubview(initialLabel)
        NSLayoutConstraint.activate([
            avatar.widthAnchor.constraint(equalToConstant: 18),
            avatar.heightAnchor.constraint(equalToConstant: 18),
            initialLabel.centerXAnchor.constraint(equalTo: avatar.centerXAnchor),
            initialLabel.centerYAnchor.constraint(equalTo: avatar.centerYAnchor),
        ])

        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let chevron = NSImageView()
        chevron.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 8, weight: .semibold))
        chevron.contentTintColor = Theme.textSecondary
        chevron.setContentCompressionResistancePriority(.required, for: .horizontal)

        profileControl.onClick = { [weak self] anchor in self?.showMenu(from: anchor) }
        profileControl.setAccessibilityRole(.popUpButton)
        let profileStack = NSStackView(views: [avatar, nameLabel, chevron])
        profileStack.orientation = .horizontal
        profileStack.alignment = .centerY
        profileStack.spacing = 8
        profileStack.setCustomSpacing(6, after: nameLabel)
        profileStack.translatesAutoresizingMaskIntoConstraints = false
        profileControl.addSubview(profileStack)
        NSLayoutConstraint.activate([
            profileStack.leadingAnchor.constraint(equalTo: profileControl.leadingAnchor),
            profileStack.trailingAnchor.constraint(equalTo: profileControl.trailingAnchor),
            profileStack.topAnchor.constraint(equalTo: profileControl.topAnchor),
            profileStack.bottomAnchor.constraint(equalTo: profileControl.bottomAnchor),
        ])
        profileControl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let gear = GlyphButton(symbol: "gearshape", size: 14) { [weak app] in
            app?.openSettings()
        }
        gear.toolTip = "Ayarlar (⌘,)"
        gear.setAccessibilityLabel("Ayarlar")

        let row = NSStackView(views: [profileControl, spacer, gear])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: SidebarMetrics.contentLeading),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -(SidebarMetrics.contentTrailing - 2)),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 9),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
        ])

        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// "Burak" in the primary colour, " · MTM Agro" in grey; the Mac server status in the tooltip.
    private func sync() {
        let name = SidebarFooter.name(app.ownerName)
        let title = SidebarFooter.title(owner: app.ownerName, brandName: app.brand(app.currentBrandId)?.name)
        let text = NSMutableAttributedString(string: name, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .medium),
            .foregroundColor: Theme.textPrimary,
        ])
        if title.count > name.count {
            text.append(NSAttributedString(string: String(title.dropFirst(name.count)), attributes: [
                .font: Theme.captionFont,
                .foregroundColor: Theme.textSecondary,
            ]))
        }
        nameLabel.attributedStringValue = text
        initialLabel.stringValue = SidebarFooter.initial(app.ownerName)
        let status = app.serverStatus
        profileControl.toolTip = "\(app.connectionIssue?.message ?? status.text)\nMarka, durum, görünüm ve ayarlar"
        profileControl.setAccessibilityLabel("\(title), \(status.text): marka ve ayarlar menüsü")
    }

    private func showMenu(from anchor: NSView) {
        let menu = NSMenu()
        menu.addItem(.sectionHeader(title: "Marka"))
        for brand in app.brandMenuOrder {
            let item = ClosureMenuItem(title: brand.name) { [weak app] in _ = app?.switchToBrand(brand.id) }
            item.state = app.currentBrandId == brand.id ? .on : .off
            if !app.canSwitchBrand(to: brand.id) {
                item.isEnabled = false
                item.toolTip = "Eklenmiş görseller markaya bağlı; markayı değiştirmek için önce onları kaldır."
            }
            menu.addItem(item)
        }
        menu.autoenablesItems = false
        menu.addItem(ClosureMenuItem(title: "Yeni marka…") { [weak app] in app?.newBrandPresented = true })
        if let brandId = app.currentBrandId {
            menu.addItem(ClosureMenuItem(title: "Marka ayarları…") { [weak app] in app?.openBrandSettings(brandId) })
        }

        menu.addItem(.separator())
        let statusItem = NSMenuItem(title: "Durum: \(app.serverStatus.text)", action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)
        if let issue = app.connectionIssue {
            for action in issue.actions {
                menu.addItem(ClosureMenuItem(title: RootViewController.title(for: action)) { [weak app] in app?.perform(action) })
            }
        }

        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Görünüm"))
        for option in AppearancePreference.allCases {
            let item = ClosureMenuItem(title: option.label) { [weak settings] in settings?.appearance = option }
            item.image = NSImage(systemSymbolName: option.symbol, accessibilityDescription: nil)
            item.state = settings.appearance == option ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "iPhone'u bağla…") { [weak app] in app?.openSettings(.devices) })
        menu.addItem(ClosureMenuItem(title: "Ayarlar…") { [weak app] in app?.openSettings() })
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: anchor.bounds.height + 4), in: anchor)
    }
}

private final class SidebarMenuTrigger: NSControl {
    var onClick: ((NSView) -> Void)?

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onClick?(self)
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?(self)
        return true
    }

    override func accessibilityPerformShowMenu() -> Bool {
        onClick?(self)
        return true
    }
}
