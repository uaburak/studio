import StudioKit
import UIKit

/// Filters conversations by title (Turkish-aware: "kasim" finds "Kasım", "IŞIK" finds "ışık").
enum ConversationSearch {
    static func fold(_ text: String) -> String {
        text.lowercased(with: TurkishFormat.locale)
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: TurkishFormat.locale)
            .replacingOccurrences(of: "ı", with: "i")
    }

    static func filter(_ conversations: [Conversation], query: String) -> [Conversation] {
        let words = fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return conversations }
        return conversations.filter { conversation in
            let title = fold(conversation.displayTitle)
            return words.allSatisfy { title.contains($0) }
        }
    }
}

/// Drawer math: how far the drawer is open while dragging, and where it settles.
enum DrawerMath {
    /// Width of the drawer: most of the screen, leaving a strip of the chat visible.
    static func width(for containerWidth: CGFloat) -> CGFloat {
        max(0, min(containerWidth - 92, 360))
    }

    /// Open when flicked right, closed when flicked left, else the nearer side.
    static func settlesOpen(progress: CGFloat, velocity: CGFloat) -> Bool {
        if velocity > 350 { return true }
        if velocity < -350 { return false }
        return progress > 0.5
    }

    static func progress(start: CGFloat, translation: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 0 else { return start }
        return min(1, max(0, start + translation / width))
    }
}

/// The left drawer, like the Claude app: a serif "Studio" title with search, the pages
/// (Postlar, Takvim, Markalar, Mac durumu), "Geçmiş" (conversations of the current
/// brand), and at the bottom the avatar (Ayarlar) and "Yeni sohbet".
final class DrawerViewController: UIViewController, UITableViewDelegate, UITextFieldDelegate {
    enum Item: Hashable {
        case destination(IOSDestination)
        case conversation(EntityID)
        case placeholder(String)
        /// The current brand; tapping it opens the brand list in place (like a submenu).
        case brandPicker
    }

    var onDestination: ((IOSDestination) -> Void)?
    var onConversation: ((EntityID) -> Void)?
    var onNewChat: (() -> Void)?
    /// The conversation on screen (highlighted in the list).
    var currentConversationId: (() -> EntityID?)?
    /// The section on screen (Takvim, Medya, …); nil while a chat is shown.
    var currentDestination: (() -> IOSDestination?)?

    private unowned let app: IOSAppModel
    let tableView = UITableView(frame: .zero, style: .plain)
    private let titleLabel = UILabel()
    private(set) lazy var searchButton = UIButton.glassCircle("magnifyingglass", label: "Sohbet ara", side: 44, pointSize: 17) { [weak self] in self?.setSearching(true) }
    let searchField = UISearchTextField()
    private lazy var cancelSearch = UIButton(configuration: .plain(), primaryAction: UIAction(title: "Vazgeç") { [weak self] _ in self?.setSearching(false) })
    /// The brand list is open under the brand row.
    private let titleRow = UIStackView()
    private let searchRow = UIStackView()
    private(set) lazy var avatarButton = UIButton.glassCircle(nil, label: "Ayarlar", side: 44) { [weak self] in self?.onDestination?(.settings) }
    private let avatarDot = IOSStatusDotView(color: IOSTheme.textTertiary, size: 10)
    private(set) lazy var newChatButton = UIButton(configuration: Self.newChatConfig(), primaryAction: UIAction { [weak self] _ in
        Haptics.selection()
        self?.onNewChat?()
    })
    private let bottomBar = UIView()
    private var dataSource: UITableViewDiffableDataSource<Int, Item>!
    private var observation: IOSObservationToken?
    private var rows: [EntityID: Conversation] = [:]
    private var signatures: [Item: Int] = [:]
    private(set) var isSearching = false
    private(set) var query = ""

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.drawer

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = "Studio"
        titleLabel.font = IOSTheme.serif(32, .semibold, style: .largeTitle)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textColor = IOSTheme.textPrimary
        titleLabel.accessibilityTraits = .header
        titleRow.axis = .horizontal
        titleRow.alignment = .center
        titleRow.translatesAutoresizingMaskIntoConstraints = false
        titleRow.addArrangedSubview(titleLabel)
        titleRow.addArrangedSubview(UIView.spacer())
        titleRow.addArrangedSubview(searchButton)

        searchField.translatesAutoresizingMaskIntoConstraints = false
        searchField.placeholder = "Sohbetlerde ara"
        searchField.font = IOSTheme.font(17)
        searchField.adjustsFontForContentSizeCategory = true
        searchField.returnKeyType = .search
        searchField.delegate = self
        searchField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.query = self.searchField.text ?? ""
            self.reload()
        }, for: .editingChanged)
        cancelSearch.configuration?.baseForegroundColor = IOSTheme.textPrimary
        cancelSearch.setContentCompressionResistancePriority(.required, for: .horizontal)
        searchRow.axis = .horizontal
        searchRow.alignment = .center
        searchRow.spacing = 8
        searchRow.translatesAutoresizingMaskIntoConstraints = false
        searchRow.addArrangedSubview(searchField)
        searchRow.addArrangedSubview(cancelSearch)
        searchRow.isHidden = true
        searchField.heightAnchor.constraint(equalToConstant: 44).isActive = true

        let header = UIStackView.v([titleRow, searchRow], spacing: 2, alignment: .fill)
        header.setCustomSpacing(0, after: searchRow)
        // Content scrolls under the header and the bottom bar with a soft edge.
        let topEdge = UIScrollEdgeElementContainerInteraction()
        topEdge.scrollView = tableView
        topEdge.edge = .top
        header.addInteraction(topEdge)

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = .clear
        tableView.separatorStyle = .none
        tableView.delegate = self
        tableView.keyboardDismissMode = .onDrag
        tableView.sectionHeaderTopPadding = 0
        tableView.estimatedRowHeight = 52
        tableView.rowHeight = UITableView.automaticDimension
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        tableView.topEdgeEffect.style = .soft
        tableView.bottomEdgeEffect.style = .soft
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            guard let self else { return }
            Task {
                await self.app.load()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        tableView.refreshControl = refresh

        buildBottomBar()

        view.addSubview(tableView)
        view.addSubview(header)
        view.addSubview(bottomBar)
        let restingBar = bottomBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8)
        restingBar.priority = .defaultLow
        NSLayoutConstraint.activate([
            restingBar,
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 0),
            titleRow.heightAnchor.constraint(equalToConstant: 44),

            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            // The list runs under the header (and the bottom bar) so both edges get the
            // soft scroll-edge effect as rows pass beneath them.
            tableView.topAnchor.constraint(equalTo: view.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            bottomBar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: 4),
        ])

        dataSource = NonEditableDataSource(tableView: tableView) { [weak self] table, indexPath, item in
            let cell = table.dequeueReusableCell(withIdentifier: "row", for: indexPath)
            self?.configure(cell, item: item)
            return cell
        }
        dataSource.defaultRowAnimation = .fade
        headerView = header

        observation = observeIOS { [weak self] in self?.reload() }
    }

    private weak var headerView: UIView?

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Rows start below the header; scrolled ones slide under it.
        let top = max(0, (headerView?.frame.maxY ?? 0) + 4 - view.safeAreaInsets.top)
        if headerView != nil, abs(tableView.contentInset.top - top) > 0.5 {
            let atTop = tableView.contentOffset.y <= -tableView.adjustedContentInset.top + 1
            tableView.contentInset.top = top
            tableView.verticalScrollIndicatorInsets.top = top
            if atTop { tableView.contentOffset.y = -tableView.adjustedContentInset.top }
        }
        let inset = max(0, view.bounds.height - bottomBar.frame.minY - view.safeAreaInsets.bottom) + 12
        if abs(tableView.contentInset.bottom - inset) > 0.5 {
            tableView.contentInset.bottom = inset
            tableView.verticalScrollIndicatorInsets.bottom = inset
        }
    }

    private static func newChatConfig() -> UIButton.Configuration {
        var config = UIButton.Configuration.filled()
        config.cornerStyle = .capsule
        config.baseBackgroundColor = IOSTheme.ink
        config.baseForegroundColor = IOSTheme.onInk
        config.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium))
        config.imagePadding = 8
        config.title = "Yeni sohbet"
        // One line, always: never wrap "Yeni / sohbet" into two lines.
        config.titleLineBreakMode = .byClipping
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 18)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var out = incoming
            out.font = IOSTheme.font(16, .medium, style: .body)
            return out
        }
        return config
    }

    private func buildBottomBar() {
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        avatarDot.layer.borderWidth = 2
        avatarDot.layer.borderColor = IOSTheme.drawer.cgColor
        avatarButton.addSubview(avatarDot)
        avatarDot.isUserInteractionEnabled = false
        NSLayoutConstraint.activate([
            avatarDot.trailingAnchor.constraint(equalTo: avatarButton.trailingAnchor, constant: -2),
            avatarDot.topAnchor.constraint(equalTo: avatarButton.topAnchor, constant: 2),
        ])
        newChatButton.translatesAutoresizingMaskIntoConstraints = false
        newChatButton.accessibilityHint = "Boş bir sohbet açar"
        newChatButton.titleLabel?.numberOfLines = 1
        newChatButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        newChatButton.setContentHuggingPriority(.required, for: .horizontal)
        let row = UIStackView.h([avatarButton, UIView.spacer(), newChatButton], spacing: 12)
        bottomBar.addSubview(row)
        row.pin(to: bottomBar)
        newChatButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
        let edge = UIScrollEdgeElementContainerInteraction()
        edge.scrollView = tableView
        edge.edge = .bottom
        bottomBar.addInteraction(edge)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.avatarDot.layer.borderColor = IOSTheme.drawer.cgColor
        }
    }

    /// Called by the root right before the drawer slides in.
    /// A conversation just tapped, shown as active before the chat has switched to it.
    private var pickedConversationId: EntityID?

    /// The row drawn as active: the tapped one while switching, else the chat on screen.
    private var activeConversationId: EntityID? {
        if pickedDestination != nil { return nil }
        return pickedConversationId ?? currentConversationId?()
    }

    /// A section just tapped, shown as active at once (the previous row goes back to default).
    private var pickedDestination: IOSDestination?

    /// The section drawn as active: the tapped one while switching, else the one on screen.
    private var activeDestination: IOSDestination? {
        if pickedConversationId != nil { return nil }
        return pickedDestination ?? currentDestination?()
    }

    func willOpen() {
        pickedConversationId = nil
        pickedDestination = nil
        reload()
        if let id = currentConversationId?(), let indexPath = dataSource.indexPath(for: .conversation(id)) {
            tableView.scrollToRow(at: indexPath, at: .none, animated: false)
        }
    }

    /// First element VoiceOver lands on when the drawer opens.
    var firstAccessibilityElement: UIView { titleLabel }

    /// The brand row's menu (the system menu, which grows out of the row): brands with a
    /// check on the current one, then "Marka profili".
    func brandMenuElements() -> [UIMenuElement] {
        // The pick waits until the menu has folded back into the row: changing the row
        // while the menu is still morphing into it made the two animations collide.
        StudioMenus.brandSection(app, onPick: { [weak self] id in
            guard let self, id != self.app.currentBrandId else { return }
            self.afterBrandMenuCloses { self.app.selectBrand(id) }
        }, onProfile: { [weak self] id in
            self?.afterBrandMenuCloses { self?.app.open(.brand(id)) }
        })
    }

    private static let brandMenuButtonTag = 0xB4A2D

    /// The active / pressed row: a step darker than the drawer in light mode (the usual fill
    /// would not show on it); in dark mode the usual fill reads well.
    private static let activeRow = UIColor(light: 0xD9D9DD, dark: 0x262628)

    private func afterBrandMenuCloses(_ action: @escaping () -> Void) {
        guard let indexPath = dataSource.indexPath(for: .brandPicker),
              let button = tableView.cellForRow(at: indexPath)?.viewWithTag(Self.brandMenuButtonTag) as? MenuSourceButton else {
            action()
            return
        }
        button.afterMenuCloses(action)
    }

        // MARK: Search

    func setSearching(_ on: Bool) {
        guard on != isSearching else { return }
        isSearching = on
        titleRow.isHidden = on
        searchRow.isHidden = !on
        if on {
            searchField.text = query
            searchField.becomeFirstResponder()
        } else {
            query = ""
            searchField.text = ""
            searchField.resignFirstResponder()
        }
        Haptics.selection()
        reload()
    }

    /// Search text (tests and the field).
    func search(_ text: String) {
        if !isSearching { setSearching(true) }
        query = text
        searchField.text = text
        reload()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    // MARK: Data

    /// Conversations listed now: the current brand's, or every match while searching.
    var listedConversations: [Conversation] {
        isSearching ? ConversationSearch.filter(app.conversations, query: query) : app.visibleConversations
    }

    /// Rebuild the list (also when the conversation on screen changes).
    func reload() {
        guard dataSource != nil else { return }
        let conversations = listedConversations
        rows = Dictionary(conversations.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var snapshot = NSDiffableDataSourceSnapshot<Int, Item>()
        snapshot.appendSections([0, 1])
        if !isSearching {
            snapshot.appendItems([.brandPicker] + IOSDestination.drawerRows.map(Item.destination), toSection: 0)
        }
        var history = conversations.map { Item.conversation($0.id) }
        if history.isEmpty {
            let text: String = if isSearching {
                query.trimmingCharacters(in: .whitespaces).isEmpty ? "Başlıkta aramak için yaz" : "Sonuç yok"
            } else if app.connection == .notPaired {
                "iPhone'u bağla"
            } else {
                app.isLoading ? "Yükleniyor…" : "Henüz sohbet yok"
            }
            history = [.placeholder(text)]
        }
        snapshot.appendItems(history, toSection: 1)

        // Reconfigure rows whose look changed (title, waiting, running, current, badge).
        let current = activeConversationId
        var newSignatures: [Item: Int] = [:]
        for item in snapshot.itemIdentifiers {
            var hasher = Hasher()
            switch item {
            case .destination(let destination):
                hasher.combine(destination)
                hasher.combine(destination == activeDestination)
                if destination == .posts { hasher.combine(app.posts.attentionCount) }
                if destination == .jobs { hasher.combine(app.connection.title) }
            case .conversation(let id):
                hasher.combine(rows[id])
                hasher.combine(id == current)
                hasher.combine(app.isWaitingOnUser(id))
                if isSearching { hasher.combine(app.brand(rows[id]?.brandId)?.name) }
            case .placeholder(let text):
                hasher.combine(text)
            case .brandPicker:
                hasher.combine(app.currentBrand?.name)
                hasher.combine(app.currentBrandId)
                hasher.combine(app.brands.map(\.name))
            }
            newSignatures[item] = hasher.finalize()
        }
        let changed = snapshot.itemIdentifiers.filter { signatures[$0] != nil && signatures[$0] != newSignatures[$0] }
        signatures = newSignatures
        snapshot.reconfigureItems(changed)
        dataSource.apply(snapshot, animatingDifferences: view.window != nil)

        renderChrome()
    }

    /// A symbol centred in the same 22 pt box the rows reserve, so icons and titles line up.
    private static func rowIcon(_ name: String, pointSize: CGFloat = 16) -> UIImage? {
        guard let symbol = UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)) else { return nil }
        let box = CGSize(width: 22, height: 22)
        return UIGraphicsImageRenderer(size: box).image { _ in
            symbol.withTintColor(.black).draw(at: CGPoint(x: (box.width - symbol.size.width) / 2, y: (box.height - symbol.size.height) / 2))
        }.withRenderingMode(.alwaysTemplate)
    }

    private func renderChrome() {
        var avatar = avatarButton.configuration ?? .glass()
        if let initial = app.greetingName?.first {
            avatar.image = nil
            avatar.attributedTitle = AttributedString(String(initial).uppercased(with: TurkishFormat.locale), attributes: AttributeContainer([
                .font: IOSTheme.font(17, .semibold, style: .headline), .foregroundColor: IOSTheme.textPrimary,
            ]))
        } else {
            avatar.attributedTitle = nil
            avatar.image = UIImage(systemName: "person.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18))
        }
        avatarButton.configuration = avatar
        let connection = app.connection
        // Same as the Mac: an orange dot means the Mac is ready, grey that it is not.
        avatarDot.dotColor = connection.isConnected && !app.isMacIdle ? IOSTheme.accent : IOSTheme.textTertiary
        avatarButton.accessibilityValue = connection.title
        avatarButton.accessibilityHint = "Mac bağlantısı, bildirimler ve görünüm"
    }

    private func configure(_ cell: UITableViewCell, item: Item) {
        var content = UIListContentConfiguration.cell()
        content.textProperties.font = IOSTheme.font(17)
        content.textProperties.color = IOSTheme.textPrimary
        content.textProperties.numberOfLines = 1
        content.textProperties.lineBreakMode = .byTruncatingTail
        content.imageToTextPadding = 16
        content.imageProperties.tintColor = IOSTheme.textPrimary
        content.imageProperties.reservedLayoutSize = CGSize(width: 22, height: 22)
        content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 13, leading: 20, bottom: 13, trailing: 16)
        cell.accessoryView = nil
        cell.accessibilityLabel = nil
        cell.accessibilityHint = nil
        cell.accessibilityValue = nil
        cell.accessibilityTraits = .button
        var isCurrent = false

        switch item {
        case .destination(let destination):
            content.text = destination.title
            content.image = Self.rowIcon(destination.symbol)
            isCurrent = destination == activeDestination
            if isCurrent { cell.accessibilityTraits.insert(.selected) }
            if destination == .posts, app.posts.attentionCount > 0 {
                let count = app.posts.attentionCount
                cell.accessoryView = Self.countBadge(count)
                cell.accessibilityValue = "\(count) post onayını bekliyor"
            } else if destination == .jobs {
                let label = UILabel.studio(app.connection.title, size: 13, color: IOSTheme.textTertiary, style: .footnote)
                label.translatesAutoresizingMaskIntoConstraints = true
                label.sizeToFit()
                cell.accessoryView = label
                cell.accessibilityValue = app.connection.title
            }
        case .conversation(let id):
            guard let conversation = rows[id] else { break }
            isCurrent = id == activeConversationId
            content.text = conversation.displayTitle
            if isSearching, let brandId = conversation.brandId, brandId != app.currentBrandId, let name = app.brand(brandId)?.name {
                content.secondaryText = name
                content.secondaryTextProperties.font = IOSTheme.font(13, style: .footnote)
                content.secondaryTextProperties.color = IOSTheme.textSecondary
            }
            content.image = Self.rowIcon("bubble.left", pointSize: 15)
            let waiting = app.isWaitingOnUser(id)
            if waiting {
                cell.accessoryView = IOSStatusDotView(color: IOSTheme.accent, size: 8).sizedForAccessory()
                cell.accessibilityValue = "Onayın bekleniyor"
            } else if conversation.activeRunId != nil {
                let spinner = UIActivityIndicatorView(style: .medium)
                spinner.startAnimating()
                cell.accessoryView = spinner
                cell.accessibilityValue = "Yanıt hazırlanıyor"
            }
            if isCurrent { cell.accessibilityTraits.insert(.selected) }
        case .placeholder(let text):
            content.text = text
            content.textProperties.color = IOSTheme.textTertiary
            content.image = nil
            cell.accessibilityTraits = .staticText
        case .brandPicker:
            content.text = app.currentBrand?.name ?? (app.brands.isEmpty ? "Marka yok" : "Marka seç")
            content.image = Self.rowIcon("tag")
            let chevron = UIImageView(image: UIImage(systemName: "chevron.up.chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)))
            chevron.tintColor = IOSTheme.textTertiary
            chevron.sizeToFit()
            cell.accessoryView = chevron
            cell.accessibilityLabel = "Marka: \(app.currentBrand?.name ?? "seçilmedi")"
            cell.accessibilityHint = "Marka seçimini açar"
        }
        // The brand row opens the native menu: a clear button over the row is the menu's
        // source, so the system menu grows out of the row and folds back into it.
        let menuButton = cell.viewWithTag(Self.brandMenuButtonTag) as? UIButton
        if item == .brandPicker {
            let button = menuButton ?? {
                let button = MenuSourceButton(type: .custom)
                button.tag = Self.brandMenuButtonTag
                button.frame = cell.bounds
                button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                button.showsMenuAsPrimaryAction = true
                button.isAccessibilityElement = false
                cell.addSubview(button)
                return button
            }()
            if button.menu == nil {
                button.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
                    completion(self?.brandMenuElements() ?? [])
                }])
            }
            cell.bringSubviewToFront(button)
            cell.accessibilityCustomActions = nil
        } else {
            menuButton?.removeFromSuperview()
        }
        cell.contentConfiguration = content
        cell.backgroundColor = .clear
        let selectable: Bool = if case .placeholder = item { false } else { true }
        cell.configurationUpdateHandler = { cell, state in
            var background = UIBackgroundConfiguration.clear()
            let highlighted = selectable && (state.isHighlighted || state.isSelected)
            background.backgroundColor = highlighted || isCurrent ? Self.activeRow : .clear
            // Fully rounded (capsule) like every control in the drawer.
            background.cornerRadius = 23
            background.backgroundInsets = NSDirectionalEdgeInsets(top: 1, leading: 10, bottom: 1, trailing: 10)
            cell.backgroundConfiguration = background
        }
        // No system selection fill (it drew a full-width grey band behind the row): the
        // rounded background above is the only highlight.
        cell.selectionStyle = .none
        cell.selectedBackgroundView = nil
        cell.multipleSelectionBackgroundView = nil
    }

    private static func countBadge(_ count: Int) -> UIView {
        let label = PaddedLabel(text: "\(count)")
        label.backgroundColor = IOSTheme.accent
        label.textColor = .white
        label.font = IOSTheme.monoDigits(12, .semibold)
        label.layer.cornerRadius = 9
        label.translatesAutoresizingMaskIntoConstraints = true
        label.frame = CGRect(origin: .zero, size: label.intrinsicContentSize)
        return label
    }

    // MARK: Table delegate

    func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
        guard section == 1 else { return nil }
        let label = UILabel.studio(isSearching ? "Sonuçlar" : "Geçmiş", size: 15, weight: .medium, color: IOSTheme.textSecondary, style: .subheadline)
        label.accessibilityTraits = .header
        let container = UIView()
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -20),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: isSearching ? 4 : 18),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -6),
        ])
        return container
    }

    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat {
        section == 1 ? UITableView.automaticDimension : 0
    }

    func tableView(_ tableView: UITableView, estimatedHeightForHeaderInSection section: Int) -> CGFloat {
        section == 1 ? 44 : 0
    }

    func tableView(_ tableView: UITableView, viewForFooterInSection section: Int) -> UIView? { nil }

    func tableView(_ tableView: UITableView, heightForFooterInSection section: Int) -> CGFloat { 0 }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        if case .placeholder = dataSource.itemIdentifier(for: indexPath) {
            return app.connection == .notPaired
        }
        return true
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let item = dataSource.itemIdentifier(for: indexPath) else { return }
        select(item)
    }

    /// What a tap on a row does (also used by tests).
    func select(_ item: Item) {
        switch item {
        case .destination(let destination):
            Haptics.selection()
            // The tapped row turns active at once while the drawer closes and the page switches.
            pickedConversationId = nil
            pickedDestination = destination
            reload()
            onDestination?(destination)
        case .conversation(let id):
            Haptics.selection()
            if isSearching { setSearching(false) }
            // The tapped row turns active at once (the old one goes back to default) while
            // the drawer closes, not only after the chat has switched.
            pickedDestination = nil
            pickedConversationId = id
            reload()
            onConversation?(id)
        case .placeholder:
            if app.connection == .notPaired { app.open(.pair) }
        case .brandPicker:
            // VoiceOver activation of the row: the button behind it shows the menu.
            break
        }
    }

    func tableView(_ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard case .conversation(let id) = dataSource.itemIdentifier(for: indexPath) else { return nil }
        return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil) { [weak self] _ in
            UIMenu(children: [
                UIAction(title: "Aç", image: UIImage(systemName: "bubble.left")) { _ in self?.select(.conversation(id)) },
                UIAction(title: "Yeniden adlandır", image: UIImage(systemName: "pencil")) { _ in self?.rename(id) },
                UIAction(title: "Arşivle", image: UIImage(systemName: "archivebox"), attributes: .destructive) { _ in self?.archive(id, done: nil) },
            ])
        }
    }

    private func archive(_ id: EntityID, done: ((Bool) -> Void)?) {
        let wasCurrent = id == currentConversationId?()
        Task {
            do {
                try await app.archiveConversation(id)
                done?(true)
                if wasCurrent { onNewChat?() }
            } catch {
                presentError(IOSAppModel.describe(error))
                done?(false)
            }
        }
    }

    private func rename(_ id: EntityID) {
        let current = rows[id]?.title
        prompt("Sohbeti adlandır", text: current, placeholder: "Başlık") { [weak self] title in
            guard let self else { return }
            Task {
                do { try await self.app.renameConversation(id, to: title) } catch { self.presentError(IOSAppModel.describe(error)) }
            }
        }
    }

    override func accessibilityPerformEscape() -> Bool {
        if isSearching {
            setSearching(false)
            return true
        }
        return false
    }
}

private extension UIView {
    /// A fixed-size view usable as a table cell's `accessoryView`.
    func sizedForAccessory() -> UIView {
        let box = UIView(frame: CGRect(x: 0, y: 0, width: 20, height: 20))
        box.isUserInteractionEnabled = false
        translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(self)
        NSLayoutConstraint.activate([centerXAnchor.constraint(equalTo: box.centerXAnchor), centerYAnchor.constraint(equalTo: box.centerYAnchor)])
        return box
    }
}

/// The brand dropdown: a Liquid Glass panel that grows out of the brand row (its top is
/// the row itself) and floats over the drawer. Brands with a check on the current one,
/// then "Marka profili". Tapping outside or picking folds it back into the row.

/// A button whose menu can run work once the menu has fully closed (its fold-back
/// animation into the button is over).
final class MenuSourceButton: UIButton {
    private var pending: [() -> Void] = []
    private var menuOpen = false

    func afterMenuCloses(_ action: @escaping () -> Void) {
        if menuOpen { pending.append(action) } else { action() }
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        menuOpen = true
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        let run = { [weak self] in
            guard let self else { return }
            self.menuOpen = false
            let actions = self.pending
            self.pending.removeAll()
            actions.forEach { $0() }
        }
        if let animator { animator.addCompletion(run) } else { run() }
    }
}

/// The drawer's rows are not editable: no swipe actions, so the table's own swipe recognizer
/// stays out of the way and a leftward swipe on a row closes the drawer.
private final class NonEditableDataSource<Section: Hashable & Sendable, Row: Hashable & Sendable>: UITableViewDiffableDataSource<Section, Row> {
    override func tableView(_ tableView: UITableView, canEditRowAt indexPath: IndexPath) -> Bool { false }
}
