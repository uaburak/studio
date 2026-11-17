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

    private unowned let app: IOSAppModel
    let tableView = UITableView(frame: .zero, style: .plain)
    private let titleLabel = UILabel()
    private(set) lazy var searchButton = UIButton.glassCircle("magnifyingglass", label: "Sohbet ara", side: 44, pointSize: 17) { [weak self] in self?.setSearching(true) }
    let searchField = UISearchTextField()
    private lazy var cancelSearch = UIButton(configuration: .plain(), primaryAction: UIAction(title: "Vazgeç") { [weak self] _ in self?.setSearching(false) })
    /// The brand list is open under the brand row.
    var brandsExpanded: Bool { brandDropdown != nil }
    private var brandDropdown: BrandDropdown?
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

        dataSource = UITableViewDiffableDataSource(tableView: tableView) { [weak self] table, indexPath, item in
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
    private var activeConversationId: EntityID? { pickedConversationId ?? currentConversationId?() }

    func willOpen() {
        pickedConversationId = nil
        brandDropdown?.dismiss(animated: false)
        reload()
        if let id = currentConversationId?(), let indexPath = dataSource.indexPath(for: .conversation(id)) {
            tableView.scrollToRow(at: indexPath, at: .none, animated: false)
        }
    }

    /// First element VoiceOver lands on when the drawer opens.
    var firstAccessibilityElement: UIView { titleLabel }

    /// Opens or closes the brand dropdown: a glass panel that grows out of the brand row
    /// and floats over the list (nothing below moves or reloads).
    func setBrandsExpanded(_ expanded: Bool, completion: (() -> Void)? = nil) {
        if !expanded {
            if let brandDropdown {
                brandDropdown.dismiss(animated: view.window != nil, completion: completion)
            } else {
                completion?()
            }
            return
        }
        guard brandDropdown == nil, let indexPath = dataSource.indexPath(for: .brandPicker) else { completion?(); return }
        tableView.layoutIfNeeded()
        let rowRect = tableView.convert(tableView.rectForRow(at: indexPath), to: view)
        let anchor = rowRect.insetBy(dx: 10, dy: 1)
        let dropdown = BrandDropdown(
            title: app.currentBrand?.name ?? (app.brands.isEmpty ? "Marka yok" : "Marka seç"),
            brands: app.brands.map { ($0.id, $0.name) },
            currentId: app.currentBrandId)
        dropdown.onPick = { [weak self] id in self?.pickBrand(id) }
        dropdown.onProfile = { [weak self] in
            guard let self, let id = self.app.currentBrandId else { return }
            self.setBrandsExpanded(false) { self.app.open(.brand(id)) }
        }
        dropdown.onDismissed = { [weak self, weak dropdown] in
            if self?.brandDropdown === dropdown { self?.brandDropdown = nil }
        }
        brandDropdown = dropdown
        dropdown.present(in: view, from: anchor, source: tableView.cellForRow(at: indexPath), animated: view.window != nil)
        completion?()
    }

    /// Pick a brand from the dropdown: it folds back into the row, then the brand changes.
    func pickBrand(_ id: EntityID) {
        Haptics.selection()
        if let name = app.brand(id)?.name { brandDropdown?.showPicked(name) }
        setBrandsExpanded(false) { [weak self] in
            guard let self, id != self.app.currentBrandId else { return }
            self.app.selectBrand(id)
        }
    }

        // MARK: Search

    func setSearching(_ on: Bool) {
        guard on != isSearching else { return }
        isSearching = on
        titleRow.isHidden = on
        searchRow.isHidden = !on
        if on { brandDropdown?.dismiss(animated: false) }
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
                "Mac'e bağlı değil"
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
                if destination == .posts { hasher.combine(app.posts.attentionCount) }
                if destination == .jobs { hasher.combine(app.connection.label) }
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
        if let initial = app.settings.greetingName?.first {
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
        avatarDot.dotColor = connection == .online ? IOSTheme.accent : IOSTheme.textTertiary
        avatarButton.accessibilityValue = connection.label
        avatarButton.accessibilityHint = "Eşleştirme, bağlantı, bildirimler ve görünüm"
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
            if destination == .posts, app.posts.attentionCount > 0 {
                let count = app.posts.attentionCount
                cell.accessoryView = Self.countBadge(count)
                cell.accessibilityValue = "\(count) post onayını bekliyor"
            } else if destination == .jobs {
                let label = UILabel.studio(app.connection.label, size: 13, color: IOSTheme.textTertiary, style: .footnote)
                label.translatesAutoresizingMaskIntoConstraints = true
                label.sizeToFit()
                cell.accessoryView = label
                cell.accessibilityValue = app.connection.label
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
        cell.contentConfiguration = content
        cell.backgroundColor = .clear
        let selectable: Bool = if case .placeholder = item { false } else { true }
        cell.configurationUpdateHandler = { cell, state in
            var background = UIBackgroundConfiguration.clear()
            let highlighted = selectable && (state.isHighlighted || state.isSelected)
            background.backgroundColor = highlighted || isCurrent ? IOSTheme.fill : .clear
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
            onDestination?(destination)
        case .conversation(let id):
            Haptics.selection()
            if isSearching { setSearching(false) }
            // The tapped row turns active at once (the old one goes back to default) while
            // the drawer closes, not only after the chat has switched.
            pickedConversationId = id
            reload()
            onConversation?(id)
        case .placeholder:
            if app.connection == .notPaired { onDestination?(.settings) }
        case .brandPicker:
            Haptics.selection()
            setBrandsExpanded(!brandsExpanded)
        }
    }

    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard case .conversation(let id) = dataSource.itemIdentifier(for: indexPath) else { return nil }
        let archive = UIContextualAction(style: .destructive, title: "Arşivle") { [weak self] _, _, done in
            guard let self else { return done(false) }
            self.archive(id, done: done)
        }
        archive.image = UIImage(systemName: "archivebox")
        let rename = UIContextualAction(style: .normal, title: "Adlandır") { [weak self] _, _, done in
            self?.rename(id)
            done(true)
        }
        rename.backgroundColor = IOSTheme.textSecondary
        rename.image = UIImage(systemName: "pencil")
        return UISwipeActionsConfiguration(actions: [archive, rename])
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
@MainActor
final class BrandDropdown {
    var onPick: ((EntityID) -> Void)?
    var onProfile: (() -> Void)?
    var onDismissed: (() -> Void)?

    private let catcher = UIControl()
    private let panel = UIVisualEffectView(effect: nil)
    private let list = UIStackView()
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.up.chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)))
    private var anchor: CGRect = .zero
    private var isDismissing = false
    private weak var headerLabel: UILabel?

    /// Shows the picked brand in the card's top row before it folds back into the row.
    func showPicked(_ name: String) {
        guard let headerLabel else { return }
        UIView.transition(with: headerLabel, duration: 0.15, options: .transitionCrossDissolve) {
            headerLabel.text = name
        }
    }
    private var columnLeading: NSLayoutConstraint!
    private var columnTrailing: NSLayoutConstraint!
    private var columnTop: NSLayoutConstraint!
    /// The row the panel grows out of: hidden while the panel stands in for it.
    private weak var source: UIView?
    /// How far the card reaches past the row, and the padding the row slides into.
    private static let outset: CGFloat = 6
    private static let padding: CGFloat = 8

    private func setInset(_ open: Bool) {
        let pad = open ? Self.padding : 0
        columnLeading.constant = pad
        columnTrailing.constant = -pad
        columnTop.constant = pad
        panel.contentView.layoutIfNeeded()
    }

    private static let rowHeight: CGFloat = 44

    init(title: String, brands: [(id: EntityID, name: String)], currentId: EntityID?) {
        catcher.backgroundColor = .clear
        catcher.accessibilityLabel = "Marka seçimini kapat"
        catcher.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)

        panel.clipsToBounds = true
        panel.cornerConfiguration = .corners(radius: .fixed(23))

        // The header repeats the row exactly, so the row seems to open up.
        let header = Self.makeRow(title: title, icon: "tag", trailing: chevron, font: IOSTheme.font(17), color: IOSTheme.textPrimary, iconColor: IOSTheme.textPrimary)
        header.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
        header.accessibilityHint = "Marka seçimini kapatır"
        headerLabel = header.subviews.first?.subviews.compactMap { $0 as? UILabel }.first
        chevron.tintColor = IOSTheme.textTertiary

        list.axis = .vertical
        list.addArrangedSubview(Self.separator())
        if brands.isEmpty {
            let empty = Self.makeRow(title: "Henüz marka yok", icon: nil, trailing: nil, font: IOSTheme.font(16), color: IOSTheme.textTertiary, iconColor: .clear)
            empty.isEnabled = false
            list.addArrangedSubview(empty)
        }
        for brand in brands {
            let current = brand.id == currentId
            let row = Self.makeRow(
                title: brand.name, icon: current ? "checkmark" : nil, trailing: nil,
                font: IOSTheme.font(16, current ? .semibold : .regular),
                color: IOSTheme.textPrimary, iconColor: IOSTheme.accent, iconSize: 13)
            row.accessibilityTraits = current ? [.button, .selected] : .button
            row.addAction(UIAction { [weak self] _ in self?.onPick?(brand.id) }, for: .touchUpInside)
            list.addArrangedSubview(row)
        }
        if currentId != nil {
            list.addArrangedSubview(Self.separator())
            let profile = Self.makeRow(title: "Marka profili", icon: "person.crop.square", trailing: nil, font: IOSTheme.font(16), color: IOSTheme.textSecondary, iconColor: IOSTheme.textSecondary, iconSize: 14)
            profile.addAction(UIAction { [weak self] _ in self?.onProfile?() }, for: .touchUpInside)
            list.addArrangedSubview(profile)
        }
        let bottom = UIView()
        bottom.heightAnchor.constraint(equalToConstant: 6).isActive = true
        list.addArrangedSubview(bottom)

        let column = UIStackView(arrangedSubviews: [header, list])
        column.axis = .vertical
        column.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView.addSubview(column)
        columnLeading = column.leadingAnchor.constraint(equalTo: panel.contentView.leadingAnchor)
        columnTrailing = column.trailingAnchor.constraint(equalTo: panel.contentView.trailingAnchor)
        columnTop = column.topAnchor.constraint(equalTo: panel.contentView.topAnchor)
        NSLayoutConstraint.activate([
            columnLeading,
            columnTrailing,
            columnTop,
            header.heightAnchor.constraint(equalToConstant: 46),
        ])
        // Gives the panel its fitting height; gives way while it is shorter (growing).
        let fit = column.bottomAnchor.constraint(equalTo: panel.contentView.bottomAnchor)
        fit.priority = .defaultLow
        fit.isActive = true
    }

    private static func separator() -> UIView {
        let holder = UIView()
        let line = UIView()
        line.backgroundColor = IOSTheme.hairline
        line.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(line)
        NSLayoutConstraint.activate([
            holder.heightAnchor.constraint(equalToConstant: 9),
            line.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
            line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 16),
            line.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -16),
            line.centerYAnchor.constraint(equalTo: holder.centerYAnchor),
        ])
        return holder
    }

    /// One row: a 22 pt icon slot, the title, an optional trailing view. Dims while pressed.
    private static func makeRow(title: String, icon: String?, trailing: UIView?, font: UIFont, color: UIColor, iconColor: UIColor, iconSize: CGFloat = 16) -> UIControl {
        let control = UIControl()
        let mark = UIImageView()
        if let icon { mark.image = UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: iconSize, weight: icon == "checkmark" ? .semibold : .regular)) }
        mark.tintColor = iconColor
        mark.contentMode = .center
        let label = UILabel()
        label.text = title
        label.font = font
        label.textColor = color
        label.lineBreakMode = .byTruncatingTail
        var views: [UIView] = [mark, label, UIView()]
        if let trailing { views.append(trailing) }
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 16
        stack.setCustomSpacing(8, after: label)
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(stack)
        NSLayoutConstraint.activate([
            control.heightAnchor.constraint(greaterThanOrEqualToConstant: rowHeight),
            mark.widthAnchor.constraint(equalToConstant: 22),
            stack.leadingAnchor.constraint(equalTo: control.leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: control.trailingAnchor, constant: -12),
            stack.centerYAnchor.constraint(equalTo: control.centerYAnchor),
        ])
        if let trailing { trailing.widthAnchor.constraint(equalToConstant: 22).isActive = true }
        control.isAccessibilityElement = true
        control.accessibilityLabel = title
        control.accessibilityTraits = .button
        control.addAction(UIAction { [weak control] _ in UIView.animate(withDuration: 0.08) { control?.alpha = 0.5 } }, for: [.touchDown, .touchDragEnter])
        control.addAction(UIAction { [weak control] _ in UIView.animate(withDuration: 0.2) { control?.alpha = 1 } }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        return control
    }

    func present(in container: UIView, from anchor: CGRect, source: UIView?, animated: Bool) {
        self.anchor = anchor
        self.source = source
        catcher.frame = container.bounds
        catcher.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(catcher)
        container.addSubview(panel)

        // Final size: a card a little wider than the row, as tall as its content (on
        // screen). The row's icon, name and chevron slide from the row into the card.
        let width = anchor.width + 2 * Self.outset
        setInset(true)
        let fitting = panel.contentView.systemLayoutSizeFitting(
            CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        let top = anchor.minY - Self.outset
        let maxHeight = container.bounds.height - top - container.safeAreaInsets.bottom - 90
        let target = CGRect(x: anchor.minX - Self.outset, y: top, width: width, height: min(fitting.height + Self.padding, max(anchor.height, maxHeight)))

        panel.frame = anchor
        setInset(false)
        source?.alpha = 0
        list.alpha = 0
        UIAccessibility.post(notification: .screenChanged, argument: panel)
        guard animated else {
            panel.frame = target
            setInset(true)
            panel.effect = UIGlassEffect(style: .regular)
            list.alpha = 1
            return
        }
        UIView.animate(springDuration: 0.42, bounce: 0.18, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction]) {
            self.panel.frame = target
            self.setInset(true)
            self.panel.effect = UIGlassEffect(style: .regular)
            self.chevron.transform = CGAffineTransform(scaleX: 1, y: 0.85)
        }
        UIView.animate(withDuration: 0.22, delay: 0.06, options: [.curveEaseOut]) {
            self.list.alpha = 1
        }
    }

    func dismiss(animated: Bool, completion: (() -> Void)? = nil) {
        guard !isDismissing else { return }
        isDismissing = true
        let finish = {
            // The brand changes first, so the row reappears already showing the pick.
            completion?()
            self.source?.alpha = 1
            self.panel.removeFromSuperview()
            self.catcher.removeFromSuperview()
            self.onDismissed?()
        }
        guard animated, panel.window != nil else { finish(); return }
        UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseIn]) {
            self.list.alpha = 0
        }
        UIView.animate(springDuration: 0.34, bounce: 0, initialSpringVelocity: 0, delay: 0, options: []) {
            self.panel.frame = self.anchor
            self.setInset(false)
            self.panel.effect = nil
            self.chevron.transform = .identity
        } completion: { _ in
            finish()
        }
    }
}
