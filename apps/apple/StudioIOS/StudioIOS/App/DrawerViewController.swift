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
    }

    var onDestination: ((IOSDestination) -> Void)?
    var onConversation: ((EntityID) -> Void)?
    var onNewChat: (() -> Void)?
    /// The conversation on screen (highlighted in the list).
    var currentConversationId: (() -> EntityID?)?

    private unowned let app: IOSAppModel
    let tableView = UITableView(frame: .zero, style: .plain)
    private let titleLabel = UILabel()
    private(set) lazy var searchButton = UIButton.glassCircle("magnifyingglass", label: "Sohbet ara", side: 48) { [weak self] in self?.setSearching(true) }
    let searchField = UISearchTextField()
    private lazy var cancelSearch = UIButton(configuration: .plain(), primaryAction: UIAction(title: "Vazgeç") { [weak self] _ in self?.setSearching(false) })
    private let brandButton = UIButton(type: .system)
    private let titleRow = UIStackView()
    private let searchRow = UIStackView()
    private(set) lazy var avatarButton = UIButton.glassCircle(nil, label: "Ayarlar", side: 52) { [weak self] in self?.onDestination?(.settings) }
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

        brandButton.translatesAutoresizingMaskIntoConstraints = false
        brandButton.showsMenuAsPrimaryAction = true
        brandButton.contentHorizontalAlignment = .leading
        brandButton.accessibilityHint = "Markayı değiştirir"
        brandButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            guard let self else { return completion([]) }
            completion(StudioMenus.brandSection(self.app, onPick: { self.app.selectBrand($0) }, onProfile: { [weak self] brandId in
                self?.app.open(.brand(brandId))
            }))
        }])

        let header = UIStackView.v([titleRow, searchRow, brandButton], spacing: 2, alignment: .fill)
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
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6),
            titleRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),

            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 4),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),
            bottomBar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -8),
        ])

        dataSource = UITableViewDiffableDataSource(tableView: tableView) { [weak self] table, indexPath, item in
            let cell = table.dequeueReusableCell(withIdentifier: "row", for: indexPath)
            self?.configure(cell, item: item)
            return cell
        }
        dataSource.defaultRowAnimation = .fade

        observation = observeIOS { [weak self] in self?.reload() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
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
        config.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .medium))
        config.imagePadding = 8
        config.title = "Yeni sohbet"
        // One line, always: never wrap "Yeni / sohbet" into two lines.
        config.titleLineBreakMode = .byClipping
        config.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 20, bottom: 14, trailing: 22)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var out = incoming
            out.font = IOSTheme.font(17, .medium, style: .body)
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
        newChatButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        let edge = UIScrollEdgeElementContainerInteraction()
        edge.scrollView = tableView
        edge.edge = .bottom
        bottomBar.addInteraction(edge)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.avatarDot.layer.borderColor = IOSTheme.drawer.cgColor
        }
    }

    /// Called by the root right before the drawer slides in.
    func willOpen() {
        reload()
        if let id = currentConversationId?(), let indexPath = dataSource.indexPath(for: .conversation(id)) {
            tableView.scrollToRow(at: indexPath, at: .none, animated: false)
        }
    }

    /// First element VoiceOver lands on when the drawer opens.
    var firstAccessibilityElement: UIView { titleLabel }

    // MARK: Search

    func setSearching(_ on: Bool) {
        guard on != isSearching else { return }
        isSearching = on
        titleRow.isHidden = on
        searchRow.isHidden = !on
        brandButton.isHidden = on
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
            snapshot.appendItems(IOSDestination.drawerRows.map(Item.destination), toSection: 0)
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
        let current = currentConversationId?()
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
            }
            newSignatures[item] = hasher.finalize()
        }
        let changed = snapshot.itemIdentifiers.filter { signatures[$0] != nil && signatures[$0] != newSignatures[$0] }
        signatures = newSignatures
        snapshot.reconfigureItems(changed)
        dataSource.apply(snapshot, animatingDifferences: view.window != nil)

        renderChrome()
    }

    private func renderChrome() {
        var config = UIButton.Configuration.plain()
        let brand = app.currentBrand?.name ?? (app.brands.isEmpty ? "Marka yok" : "Marka seç")
        config.attributedTitle = AttributedString(brand, attributes: AttributeContainer([
            .font: IOSTheme.font(15, .medium, style: .subheadline), .foregroundColor: IOSTheme.textSecondary,
        ]))
        config.image = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
        config.imagePlacement = .trailing
        config.imagePadding = 5
        config.baseForegroundColor = IOSTheme.textSecondary
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 8)
        brandButton.configuration = config
        brandButton.accessibilityLabel = "Marka: \(app.currentBrand?.name ?? "seçilmedi")"

        var avatar = avatarButton.configuration ?? .glass()
        if let initial = app.settings.greetingName?.first {
            avatar.image = nil
            avatar.attributedTitle = AttributedString(String(initial).uppercased(with: TurkishFormat.locale), attributes: AttributeContainer([
                .font: IOSTheme.font(19, .semibold, style: .headline), .foregroundColor: IOSTheme.textPrimary,
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
        content.imageProperties.reservedLayoutSize = CGSize(width: 26, height: 26)
        content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 13, leading: 20, bottom: 13, trailing: 16)
        cell.accessoryView = nil
        cell.accessibilityValue = nil
        cell.accessibilityTraits = .button
        var isCurrent = false

        switch item {
        case .destination(let destination):
            content.text = destination.title
            content.image = UIImage(systemName: destination.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular))
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
            isCurrent = id == currentConversationId?()
            content.text = conversation.displayTitle
            if isSearching, let brandId = conversation.brandId, brandId != app.currentBrandId, let name = app.brand(brandId)?.name {
                content.secondaryText = name
                content.secondaryTextProperties.font = IOSTheme.font(13, style: .footnote)
                content.secondaryTextProperties.color = IOSTheme.textSecondary
            }
            content.image = UIImage(systemName: "bubble.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))
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
        }
        cell.contentConfiguration = content
        cell.backgroundColor = .clear
        let selectable: Bool = if case .placeholder = item { false } else { true }
        cell.configurationUpdateHandler = { cell, state in
            var background = UIBackgroundConfiguration.clear()
            let highlighted = selectable && (state.isHighlighted || state.isSelected)
            background.backgroundColor = highlighted || isCurrent ? IOSTheme.fill : .clear
            background.cornerRadius = 16
            background.backgroundInsets = NSDirectionalEdgeInsets(top: 1, leading: 10, bottom: 1, trailing: 10)
            cell.backgroundConfiguration = background
        }
        cell.selectionStyle = selectable ? .default : .none
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
            onConversation?(id)
        case .placeholder:
            if app.connection == .notPaired { onDestination?(.settings) }
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
