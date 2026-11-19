import StudioKit
import UIKit

/// What a Postlar tab lists, like an Instagram profile: the grid (posts and carousels), Reels
/// and stories.
enum PostTab: Int, CaseIterable {
    case grid, reels, stories

    var symbol: String {
        switch self {
        case .grid: "square.grid.3x3"
        case .reels: "play.rectangle"
        case .stories: "circle.dashed"
        }
    }

    var label: String {
        switch self {
        case .grid: "Gönderiler"
        case .reels: "Reels"
        case .stories: "Hikâyeler"
        }
    }

    func matches(_ type: ContentType) -> Bool {
        switch self {
        case .grid: type != .reel && type != .story
        case .reels: type == .reel
        case .stories: type == .story
        }
    }

    /// Height ÷ width of a tile (Instagram's 3:4 grid, tall Reels and stories).
    var tileRatio: CGFloat { self == .grid ? 4.0 / 3.0 : 16.0 / 9.0 }
}

/// Postlar, like an Instagram profile (no tab bar): the drawer button, the brand picker in the
/// middle and "+" at the right; under the brand's header, Gönderiler / Reels / Hikâyeler tabs that
/// stay pinned and also change with a sideways swipe; a three-column grid. A post opens like
/// Instagram (zooming out of its tile): posts as a feed, Reels full screen, stories in the story
/// player; "Düzenle" there opens the editor.
final class IOSPostsViewController: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate, DrawerSwipeBlocking {
    private unowned let app: IOSAppModel
    private var model: IOSPostsModel { app.posts }

    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, EntityID>!
    private let profile = PostsProfileHeader()
    private let tabs = PostsTabBar()
    private let brandButton = UIButton(type: .system)
    private let approveBar = UIView()
    private let approveLabel = UILabel.studio("", size: 15, weight: .semibold, style: .subheadline)
    private var approveButton: UIButton!
    private let emptyView = EmptyStateView()
    private var observation: IOSObservationToken?
    private var lastBrandId: EntityID?
    private var signatures: [EntityID: Int] = [:]

    private var currentTab: PostTab = .grid
    /// The page sliding sideways between tabs (stopped where it is when a swipe catches it).
    private var pageAnimator: UIViewPropertyAnimator?
    private var pageTarget: PostTab?
    private var pageOffset: CGFloat = 0
    private var panBase: CGFloat = 0
    private var isPaging = false
    private lazy var pagePan = UIPanGestureRecognizer(target: self, action: #selector(paged(_:)))

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        title = "Postlar"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        buildBar()

        collectionView = UICollectionView(frame: .zero, collectionViewLayout: makeLayout())
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = IOSTheme.canvas
        collectionView.delegate = self
        collectionView.alwaysBounceVertical = true
        collectionView.contentInset.bottom = 90
        collectionView.topEdgeEffect.style = .soft
        setContentScrollView(collectionView, for: .top)
        view.addSubview(collectionView)
        collectionView.pin(to: view)
        pagePan.delegate = self
        view.addGestureRecognizer(pagePan)
        collectionView.panGestureRecognizer.require(toFail: pagePan)

        let cellRegistration = UICollectionView.CellRegistration<PostGridCell, EntityID> { [weak self] cell, _, id in
            guard let self, let card = self.model.card(id) else { return }
            cell.configure(card: card, images: self.app.images, job: self.model.activeJob(for: id), upload: self.model.slotUploads[id])
            cell.transform = CGAffineTransform(translationX: self.pageOffset, y: 0)
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { collectionView, indexPath, id in
            collectionView.dequeueConfiguredReusableCell(using: cellRegistration, for: indexPath, item: id)
        }
        let profileRegistration = UICollectionView.SupplementaryRegistration<UICollectionReusableView>(elementKind: PostsLayout.profileKind) { [weak self] supplementary, _, _ in
            guard let self, self.profile.superview !== supplementary else { return }
            supplementary.subviews.forEach { $0.removeFromSuperview() }
            supplementary.addSubview(self.profile)
            self.profile.pin(to: supplementary)
        }
        let tabsRegistration = UICollectionView.SupplementaryRegistration<UICollectionReusableView>(elementKind: PostsLayout.tabsKind) { [weak self] supplementary, _, _ in
            guard let self, self.tabs.superview !== supplementary else { return }
            supplementary.subviews.forEach { $0.removeFromSuperview() }
            supplementary.addSubview(self.tabs)
            self.tabs.pin(to: supplementary)
        }
        dataSource.supplementaryViewProvider = { collectionView, kind, indexPath in
            kind == PostsLayout.profileKind
                ? collectionView.dequeueConfiguredReusableSupplementary(using: profileRegistration, for: indexPath)
                : collectionView.dequeueConfiguredReusableSupplementary(using: tabsRegistration, for: indexPath)
        }

        tabs.onSelect = { [weak self] tab in self?.slide(to: tab) }
        profile.onCreate = { [weak self] in self?.app.open(.newConversation) }
        profile.onCalendar = { [weak self] in self?.app.open(.calendar) }

        emptyView.isUserInteractionEnabled = true
        emptyView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(emptyView)
        NSLayoutConstraint.activate([
            emptyView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            emptyView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
            emptyView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 290),
        ])

        buildApproveBar()

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            guard let self else { return }
            Task {
                await self.model.load()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        collectionView.refreshControl = refresh

        observation = observeIOS { [weak self] in self?.render() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if model.hasLoaded { Task { await model.load() } }
    }

    // MARK: Bar

    /// The brand picker in the middle (its menu lists the brands), "+" at the right; the drawer
    /// button at the left comes from the root.
    private func buildBar() {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        config.imagePlacement = .trailing
        config.imagePadding = 5
        config.baseForegroundColor = IOSTheme.textPrimary
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { var a = $0; a.font = .systemFont(ofSize: 20, weight: .bold); return a }
        brandButton.configuration = config
        brandButton.showsMenuAsPrimaryAction = true
        brandButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            guard let self else { return completion([]) }
            completion(StudioMenus.brandSection(self.app, onPick: { self.app.selectBrand($0) }, onProfile: { self.app.open(.brand($0)) }))
        }])
        brandButton.accessibilityHint = "Markayı değiştirir"
        navigationItem.titleView = brandButton
        navigationItem.largeTitleDisplayMode = .never
        let create = UIBarButtonItem(image: UIImage(systemName: "plus"), menu: UIMenu(children: [
            UIAction(title: "Sohbette üret", image: UIImage(systemName: "bubble.left.and.text.bubble.right")) { [weak self] _ in self?.app.open(.newConversation) },
            UIAction(title: "Takvimi aç", image: UIImage(systemName: "calendar")) { [weak self] _ in self?.app.open(.calendar) },
        ]))
        create.accessibilityLabel = "Yeni post"
        navigationItem.rightBarButtonItem = create
    }

    private func renderBar() {
        let name = app.currentBrand?.name ?? (app.brands.isEmpty ? "Marka yok" : "Marka seç")
        var config = brandButton.configuration
        config?.title = name.count > 20 ? String(name.prefix(19)) + "…" : name
        brandButton.configuration = config
        brandButton.accessibilityLabel = "Marka: \(app.currentBrand?.name ?? "seçilmedi")"
        brandButton.sizeToFit()
    }

    // MARK: Layout

    private func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { [weak self] sectionIndex, environment in
            let width = environment.container.effectiveContentSize.width
            if sectionIndex == 0 {
                // The brand's header (no items; it scrolls away).
                let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(0.1)))
                let group = NSCollectionLayoutGroup.horizontal(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(0.1)), subitems: [item])
                let section = NSCollectionLayoutSection(group: group)
                let header = NSCollectionLayoutBoundarySupplementaryItem(
                    layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(170)),
                    elementKind: PostsLayout.profileKind, alignment: .top)
                section.boundarySupplementaryItems = [header]
                return section
            }
            let tab = self?.currentTab ?? .grid
            let spacing: CGFloat = 1.5
            let itemWidth = (width - 2 * spacing) / 3
            let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1 / 3), heightDimension: .fractionalHeight(1)))
            let group = NSCollectionLayoutGroup.horizontal(
                layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute((itemWidth * tab.tileRatio).rounded())),
                repeatingSubitem: item, count: 3)
            group.interItemSpacing = .fixed(spacing)
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = spacing
            // The tabs stay under the bar while the grid scrolls (as on Instagram).
            let tabs = NSCollectionLayoutBoundarySupplementaryItem(
                layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(48)),
                elementKind: PostsLayout.tabsKind, alignment: .top)
            tabs.pinToVisibleBounds = true
            tabs.zIndex = 2
            section.boundarySupplementaryItems = [tabs]
            return section
        }
    }

    private func buildApproveBar() {
        approveBar.translatesAutoresizingMaskIntoConstraints = false
        approveBar.backgroundColor = IOSTheme.elevated
        approveBar.layer.cornerRadius = 26
        approveBar.layer.cornerCurve = .continuous
        approveBar.layer.borderWidth = 1
        approveBar.layer.borderColor = IOSTheme.border.cgColor
        approveBar.layer.shadowColor = UIColor.black.cgColor
        approveBar.layer.shadowOpacity = 0.12
        approveBar.layer.shadowRadius = 16
        approveBar.layer.shadowOffset = CGSize(width: 0, height: 6)
        approveBar.isHidden = true
        approveButton = UIButton.studioPill(title: "Tümünü onayla", kind: .primary) { [weak self] in
            self?.approveAll()
        }
        let row = UIStackView.h([IOSStatusDotView(color: IOSTheme.ink, size: 7), approveLabel, UIView.spacer(), approveButton], spacing: 10)
        approveBar.addSubview(row)
        row.pin(to: approveBar, insets: UIEdgeInsets(top: 8, left: 18, bottom: 8, right: 8))
        view.addSubview(approveBar)
        NSLayoutConstraint.activate([
            approveBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: IOSTheme.gutter),
            approveBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -IOSTheme.gutter),
            approveBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),
        ])
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.approveBar.layer.borderColor = IOSTheme.border.cgColor
        }
    }

    // MARK: Render

    /// Every post of the brand on the tab, newest day first (undated last).
    private func cards(on tab: PostTab) -> [PostCard] {
        model.board.cards
            .filter { tab.matches($0.content.type) }
            .sorted { lhs, rhs in
                switch (lhs.day, rhs.day) {
                case let (l?, r?): l != r ? l > r : lhs.title < rhs.title
                case (_?, nil): true
                case (nil, _?): false
                default: lhs.title < rhs.title
                }
            }
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }
        renderBar()
        let counts = Dictionary(uniqueKeysWithValues: PostTab.allCases.map { ($0, cards(on: $0).count) })
        profile.configure(brand: app.currentBrand?.name ?? "Marka seçilmedi", counts: counts, waiting: model.attentionCount, loading: model.isLoading)
        tabs.select(currentTab, animated: false)

        let cards = cards(on: currentTab)
        var newSignatures: [EntityID: Int] = [:]
        for card in cards {
            var hasher = Hasher()
            hasher.combine(card)
            hasher.combine(model.activeJob(for: card.id)?.progressMessage)
            hasher.combine(model.activeJob(for: card.id)?.status)
            hasher.combine(model.slotUploads[card.id])
            newSignatures[card.id] = hasher.finalize()
        }
        let changed = cards.map(\.id).filter { signatures[$0] != nil && signatures[$0] != newSignatures[$0] }
        signatures = newSignatures
        var snapshot = NSDiffableDataSourceSnapshot<Int, EntityID>()
        snapshot.appendSections([0, 1])
        snapshot.appendItems(cards.map(\.id), toSection: 1)
        snapshot.reconfigureItems(changed)
        dataSource.apply(snapshot, animatingDifferences: view.window != nil && !isPaging)

        if app.connection == .notPaired {
            emptyView.isHidden = false
            emptyView.configure(icon: "laptopcomputer.and.iphone", title: MacLinkState.notPaired.title, message: "Postlar Mac'te üretilir. Mac'teki QR kodu okutarak iPhone'u bağla.",
                                actions: [UIButton.studioPill(title: MacLinkAction.pair.title, kind: .primary) { [weak self] in self?.app.open(.pair) }])
        } else if let error = model.error, model.board.cards.isEmpty {
            emptyView.isHidden = false
            emptyView.configure(icon: "exclamationmark.triangle", title: "Postlar yüklenemedi", message: error,
                                actions: [UIButton.studioPill(title: "Yeniden dene", kind: .secondary) { [weak self] in Task { await self?.model.load() } }])
        } else if cards.isEmpty && model.hasLoaded {
            emptyView.isHidden = false
            let what = switch currentTab {
            case .grid: "Henüz gönderi yok"
            case .reels: "Henüz Reels yok"
            case .stories: "Henüz hikâye yok"
            }
            emptyView.configure(icon: currentTab.symbol, title: what,
                                message: "Sohbette “bu ayın postlarını üret” de; plan onaylanınca burada belirir.",
                                actions: [UIButton.studioPill(title: "Sohbette üret", kind: .primary) { [weak self] in self?.app.open(.newConversation) }])
        } else {
            emptyView.isHidden = true
        }
        emptyView.transform = CGAffineTransform(translationX: pageOffset, y: 0)

        let ready = model.approvable.count
        approveBar.isHidden = ready == 0
        approveLabel.text = "\(ready) post onaya hazır"
        approveButton.setPill(title: "Tümünü onayla", kind: .primary, busy: model.isApproving)
        approveButton.isEnabled = !model.isApproving
    }

    // MARK: Tabs: swipe and slide

    private var pageHeading: PostTab { pageAnimator != nil ? (pageTarget ?? currentTab) : currentTab }

    /// Rightward swipes page back while not on the first tab; on it the drawer takes them.
    var blocksDrawerSwipe: Bool { pageHeading != .grid }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pagePan else { return true }
        let velocity = pagePan.velocity(in: view)
        guard abs(velocity.x) > abs(velocity.y) * 1.2 else { return false }
        if velocity.x < 0 { return pageAnimator != nil || currentTab != .stories }
        return pageHeading != .grid
    }

    @objc private func paged(_ pan: UIPanGestureRecognizer) {
        let width = max(collectionView.bounds.width, 1)
        let dx = pan.translation(in: view).x
        switch pan.state {
        case .began:
            panBase = interruptPaging()
            pageTarget = nil
        case .changed:
            var offset = panBase + dx
            if (currentTab == .grid && offset > 0) || (currentTab == .stories && offset < 0) { offset *= 0.3 }
            setPage(offset: offset)
        case .ended, .cancelled, .failed:
            let offset = pageOffset
            let velocity = pan.state == .ended ? pan.velocity(in: view).x : 0
            var target = currentTab
            if offset < -width * 0.25 || velocity < -500 {
                target = (neighborSide < 0 ? neighborTab : nil) ?? PostTab(rawValue: currentTab.rawValue + 1) ?? currentTab
            }
            if offset > width * 0.25 || velocity > 500 {
                target = (neighborSide > 0 ? neighborTab : nil) ?? PostTab(rawValue: currentTab.rawValue - 1) ?? currentTab
            }
            slide(to: target, from: offset)
        default:
            break
        }
    }

    /// Space between the two pages while they slide: the same hairline as between the tiles.
    private let pageGap: CGFloat = 1.5
    /// The other tab's tiles, riding right beside the current page while it slides.
    private var neighborPage: UIView?
    private var neighborTab: PostTab?
    /// -1: the neighbour is to the right (the next tab), 1: to the left, 0: none.
    private var neighborSide: CGFloat = 0
    /// Carries the page's offset through the animators, so a catch knows where the page is.
    private lazy var pageTracker: UIView = {
        let tracker = UIView()
        tracker.isUserInteractionEnabled = false
        view.insertSubview(tracker, at: 0)
        return tracker
    }()

    /// The grid's tiles and the empty state moved sideways (the header and the tabs stay), with
    /// the neighbouring tab's page glued to their side.
    private func setPage(offset: CGFloat) {
        pageOffset = offset
        let move = CGAffineTransform(translationX: offset, y: 0)
        for cell in collectionView.visibleCells { cell.transform = move }
        emptyView.transform = move
        pageTracker.transform = move
        let side: CGFloat = offset < 0 ? -1 : (offset > 0 ? 1 : 0)
        // While a finger drags, the side it uncovers decides which tab shows there.
        if pageTarget == nil, side != 0, side != neighborSide {
            showNeighbor(PostTab(rawValue: currentTab.rawValue - Int(side)), side: side)
        }
        let span = collectionView.bounds.width + pageGap
        neighborPage?.transform = CGAffineTransform(translationX: offset - neighborSide * span, y: 0)
        // The underline under the tabs moves with the page (a jump over two tabs covers both).
        let steps = neighborTab.map { CGFloat(abs($0.rawValue - currentTab.rawValue)) } ?? 1
        tabs.follow(CGFloat(currentTab.rawValue) - offset / max(span, 1) * max(steps, 1))
    }

    /// Lays `tab`'s tiles out as its grid would show them at the current scroll, on `side`.
    private func showNeighbor(_ tab: PostTab?, side: CGFloat) {
        neighborPage?.removeFromSuperview()
        neighborPage = nil
        neighborTab = tab
        neighborSide = side
        guard let tab, collectionView.bounds.width > 0 else { return }
        UIView.performWithoutAnimation {
            let width = collectionView.bounds.width
            let itemWidth = (width - 2 * pageGap) / 3
            let rowHeight = (itemWidth * tab.tileRatio).rounded()
            var top: CGFloat = 0
            if collectionView.numberOfItems(inSection: 1) > 0, let first = collectionView.layoutAttributesForItem(at: IndexPath(item: 0, section: 1)) {
                top = first.frame.minY
            } else if let header = collectionView.layoutAttributesForSupplementaryElement(ofKind: PostsLayout.profileKind, at: IndexPath(item: 0, section: 0)) {
                top = header.frame.maxY + 48
            }
            let visibleTop = collectionView.contentOffset.y
            let visibleBottom = visibleTop + collectionView.bounds.height
            let page = UIView(frame: CGRect(x: 0, y: top, width: width, height: max(visibleBottom - top, 0)))
            page.isUserInteractionEnabled = false
            for (index, card) in cards(on: tab).enumerated() {
                let y = CGFloat(index / 3) * (rowHeight + pageGap)
                if top + y > visibleBottom { break }
                if top + y + rowHeight < visibleTop { continue }
                let cell = PostGridCell(frame: CGRect(x: CGFloat(index % 3) * (itemWidth + pageGap), y: y, width: itemWidth, height: rowHeight))
                cell.configure(card: card, images: app.images, job: model.activeJob(for: card.id), upload: model.slotUploads[card.id])
                page.addSubview(cell)
                cell.layoutIfNeeded()
            }
            collectionView.insertSubview(page, at: 0)
            neighborPage = page
        }
    }

    private func dropNeighbor() {
        neighborPage?.removeFromSuperview()
        neighborPage = nil
        neighborTab = nil
        neighborSide = 0
    }

    /// Stops a running slide where it is on screen and returns the page's offset. A slide caught
    /// on its way to another tab hands over to that tab at once (its page becomes the current
    /// one, at the same spot on screen), so a quick second swipe carries on from there: from
    /// Hikâye through Reels to Gönderiler without stopping at Reels.
    private func interruptPaging() -> CGFloat {
        if let animator = pageAnimator {
            pageAnimator = nil
            animator.stopAnimation(false)
            animator.finishAnimation(at: .current)
            setPage(offset: pageTracker.transform.tx)
            if let target = pageTarget, target != currentTab, neighborTab == target {
                let onScreen = pageOffset - neighborSide * (collectionView.bounds.width + pageGap)
                let previous = currentTab
                pageTarget = nil
                isPaging = true
                currentTab = target
                collectionView.collectionViewLayout.invalidateLayout()
                render()
                collectionView.layoutIfNeeded()
                isPaging = false
                dropNeighbor()
                // The page it left stays beside it (also after a jump over two tabs).
                if onScreen != 0 { showNeighbor(previous, side: onScreen < 0 ? -1 : 1) }
                setPage(offset: onScreen)
            }
        }
        tabs.select(currentTab, animated: true)
        return pageOffset
    }

    /// To `target`: both pages slide together, side by side, until the other tab's fills the
    /// screen; or back into place. Interruptible at any moment (a new swipe or tap takes over).
    private func slide(to target: PostTab, from offset: CGFloat? = nil) {
        let start = offset ?? interruptPaging()
        if let animator = pageAnimator {
            pageAnimator = nil
            animator.stopAnimation(true)
        }
        let width = max(collectionView.bounds.width, 1)
        tabs.select(target, animated: true)
        pageTarget = target
        guard target != currentTab else {
            setPage(offset: start)
            let back = UIViewPropertyAnimator(duration: 0.32, dampingRatio: 1) { self.setPage(offset: 0) }
            back.addCompletion { [weak self] position in
                guard let self, position == .end, self.pageAnimator === back else { return }
                self.pageAnimator = nil
                self.pageTarget = nil
                self.dropNeighbor()
            }
            pageAnimator = back
            back.startAnimation()
            return
        }
        let side: CGFloat = target.rawValue > currentTab.rawValue ? -1 : 1
        if neighborTab != target || neighborSide != side || neighborPage == nil { showNeighbor(target, side: side) }
        setPage(offset: start)
        let end = side * (width + pageGap)
        let remaining = min(max(abs(end - start) / width, 0.3), 1)
        let across = UIViewPropertyAnimator(duration: 0.38 * remaining, dampingRatio: 1) { self.setPage(offset: end) }
        across.addCompletion { [weak self] position in
            guard let self, position == .end, self.pageAnimator === across else { return }
            self.pageAnimator = nil
            self.pageTarget = nil
            self.isPaging = true
            self.currentTab = target
            self.collectionView.collectionViewLayout.invalidateLayout()
            self.render()
            self.collectionView.layoutIfNeeded()
            self.isPaging = false
            self.dropNeighbor()
            self.setPage(offset: 0)
        }
        pageAnimator = across
        across.startAnimation()
        Haptics.selection()
    }

    // MARK: Opening a post

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard let id = dataSource.itemIdentifier(for: indexPath), let card = model.card(id) else { return }
        open(card)
    }

    /// The tab's posts open like Instagram, the picture zooming out of its tile: the grid as a
    /// feed of posts, Reels one per screen, stories in the story player. A post with no picture
    /// yet opens the editor.
    private func open(_ card: PostCard) {
        guard card.renderedAssetIds.first != nil, !card.needsImage else {
            navigationController?.pushViewController(IOSPostDetailViewController(app: app, card: card), animated: true)
            return
        }
        let tab = currentTab
        let ids = cards(on: tab).map(\.id)
        // The tile a post flies out of and back into; scrolled into view when it is off screen
        // (the feed may close on another post than the one opened).
        let sourceFor: (EntityID) -> UIView? = { [weak self] id in
            guard let self, self.currentTab == tab, let path = self.dataSource.indexPath(for: id) else { return nil }
            if self.collectionView.cellForItem(at: path) == nil || !self.collectionView.bounds.intersects(self.collectionView.layoutAttributesForItem(at: path)?.frame ?? .zero) {
                self.collectionView.scrollToItem(at: path, at: .centeredVertically, animated: false)
                self.collectionView.layoutIfNeeded()
            }
            return (self.collectionView.cellForItem(at: path) as? PostGridCell)?.artworkView
        }
        if navigationController?.delegate == nil { navigationController?.delegate = PhotoViewerNavigationDelegate.shared }
        // Only the chevron on the opened page's back button, as on Instagram.
        navigationItem.backButtonDisplayMode = .minimal
        let page: UIViewController = switch tab {
        case .grid: PostFeedViewController(app: app, ids: ids, start: card.id, sourceFor: sourceFor)
        case .reels: PostReelsViewController(app: app, ids: ids, start: card.id, sourceFor: sourceFor)
        case .stories: PostStoryViewController(app: app, ids: ids, start: card.id, sourceFor: sourceFor)
        }
        navigationController?.pushViewController(page, animated: true)
    }

    func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint) -> UIContextMenuConfiguration? {
        guard let indexPath = indexPaths.first, let id = dataSource.itemIdentifier(for: indexPath), let card = model.card(id) else { return nil }
        let source = collectionView.cellForItem(at: indexPath)
        return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            return self.menu(for: card, source: source)
        }
    }

    private func menu(for card: PostCard, source: UIView?) -> UIMenu {
        var primary: [UIMenuElement] = [UIAction(title: "Aç", image: UIImage(systemName: "arrow.up.left.and.arrow.down.right")) { [weak self] _ in self?.open(card) }]
        if card.state == .ready, card.approvableHash != nil {
            primary.append(UIAction(title: "Onayla", image: UIImage(systemName: "checkmark.circle")) { [weak self] _ in
                guard let self else { return }
                self.approveGuarded(card)
            })
        }
        if card.state == .generationFailed {
            primary.append(UIAction(title: "Yeniden dene", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in
                guard let self else { return }
                Task {
                    if await self.model.retryGeneration(card) { Toast.show("Yeniden üretiliyor", in: self.view) } else if let error = self.model.error { self.presentError(error) }
                }
            })
        }
        if !card.slots.isEmpty, !card.isCanvasVersion {
            var slotActions: [UIMenuElement] = [UIAction(title: "Fotoğraflardan", image: UIImage(systemName: "photo")) { [weak self] _ in
                guard let self else { return }
                ImagePicking.photos(from: self) { images in if let first = images.first { self.model.fillSlot(of: card, with: first) } }
            }]
            if ImagePicking.cameraAvailable {
                slotActions.append(UIAction(title: "Kamerayla çek", image: UIImage(systemName: "camera")) { [weak self] _ in
                    guard let self else { return }
                    ImagePicking.camera(from: self) { images in if let first = images.first { self.model.fillSlot(of: card, with: first) } }
                })
            }
            primary.append(UIMenu(title: card.needsImage ? "Görsel ekle" : "Görseli değiştir", image: UIImage(systemName: "photo.badge.plus"), children: slotActions))
        }
        let share: [UIMenuElement] = [
            UIAction(title: "Açıklamayı kopyala", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
                UIPasteboard.general.string = card.content.caption
                Toast.show("Açıklama kopyalandı", in: self?.view)
            },
            UIAction(title: "Paylaş", image: UIImage(systemName: "square.and.arrow.up"), attributes: card.renderedAssetIds.isEmpty ? .disabled : []) { [weak self] _ in
                self?.share(card, source: source)
            },
        ]
        let manage: [UIMenuElement] = [
            UIAction(title: "Çoğalt", image: UIImage(systemName: "plus.square.on.square")) { [weak self] _ in
                guard let self else { return }
                Task {
                    if let copy = await self.model.duplicate(card) { Toast.show("“\(copy.title)” oluşturuldu", in: self.view) } else if let error = self.model.error { self.presentError(error) }
                }
            },
            UIAction(title: "Sil…", image: UIImage(systemName: "trash"), attributes: IOSPostsModel.deletionBlocker(card) == nil ? .destructive : [.destructive, .disabled]) { [weak self] _ in
                guard let self else { return }
                self.confirm("“\(card.title)” silinsin mi?", message: IOSPostsModel.deleteMessage, action: "Sil") {
                    Task {
                        if await self.model.delete(card) {
                            Haptics.success()
                            IOSPostsModel.showUndo(for: card, model: self.model, in: self.view)
                        } else if let error = self.model.error { self.presentError(error) }
                    }
                }
            },
        ]
        return UIMenu(children: [
            UIMenu(options: .displayInline, children: primary),
            UIMenu(options: .displayInline, children: share),
            UIMenu(options: .displayInline, children: manage),
        ])
    }

    private func share(_ card: PostCard, source: UIView?) {
        Task {
            var images: [UIImage] = []
            for id in card.renderedAssetIds {
                if let data = await app.images.data(id), let image = UIImage(data: data) { images.append(image) }
            }
            guard !images.isEmpty else { return presentError("Görsel indirilemedi.") }
            FileSharing.share(images + [card.content.caption], from: self, source: source)
        }
    }
}

/// Element kinds of the Postlar layout.
enum PostsLayout {
    static let profileKind = "posts-profile"
    static let tabsKind = "posts-tabs"
}

// MARK: - Brand header

/// The brand at the top, like an Instagram profile: its initial in a ring, its name, the number
/// of posts, Reels and stories, and two wide buttons.
final class PostsProfileHeader: UIView {
    var onCreate: (() -> Void)?
    var onCalendar: (() -> Void)?

    private let avatar = UILabel()
    private let ring = UIView()
    private let nameLabel = UILabel.studio("", size: 17, weight: .semibold, style: .headline)
    private let waitingLabel = UILabel.studio("", size: 14, color: IOSTheme.textSecondary, lines: 2, style: .subheadline)
    private let countStack = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        ring.translatesAutoresizingMaskIntoConstraints = false
        ring.layer.cornerRadius = 43
        ring.layer.borderWidth = 2.5
        ring.layer.borderColor = IOSTheme.accent.cgColor
        avatar.translatesAutoresizingMaskIntoConstraints = false
        avatar.font = .systemFont(ofSize: 32, weight: .bold)
        avatar.textAlignment = .center
        avatar.textColor = IOSTheme.textPrimary
        avatar.backgroundColor = IOSTheme.fill
        avatar.layer.cornerRadius = 38
        avatar.clipsToBounds = true
        ring.addSubview(avatar)
        NSLayoutConstraint.activate([
            ring.widthAnchor.constraint(equalToConstant: 86),
            ring.heightAnchor.constraint(equalToConstant: 86),
            avatar.widthAnchor.constraint(equalToConstant: 76),
            avatar.heightAnchor.constraint(equalToConstant: 76),
            avatar.centerXAnchor.constraint(equalTo: ring.centerXAnchor),
            avatar.centerYAnchor.constraint(equalTo: ring.centerYAnchor),
        ])
        countStack.axis = .horizontal
        countStack.distribution = .fillEqually
        countStack.spacing = 8
        spinner.hidesWhenStopped = true
        let nameRow = UIStackView.h([nameLabel, spinner, UIView.spacer()], spacing: 6)
        let right = UIStackView.v([nameRow, countStack], spacing: 6)
        let top = UIStackView.h([ring, right], spacing: 18, alignment: .center)

        let create = UIButton.studioPill(title: "Sohbette üret", kind: .secondary) { [weak self] in self?.onCreate?() }
        let calendar = UIButton.studioPill(title: "Takvim", kind: .secondary) { [weak self] in self?.onCalendar?() }
        let buttons = UIStackView.h([create, calendar], spacing: 8)
        buttons.distribution = .fillEqually
        let stack = UIStackView.v([top, waitingLabel, buttons], spacing: 12)
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 8, left: IOSTheme.gutter, bottom: 14, right: IOSTheme.gutter))
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.ring.layer.borderColor = IOSTheme.accent.cgColor
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(brand: String, counts: [PostTab: Int], waiting: Int, loading: Bool) {
        nameLabel.text = brand
        avatar.text = String(brand.prefix(1)).uppercased(with: Locale(identifier: "tr_TR"))
        loading ? spinner.startAnimating() : spinner.stopAnimating()
        waitingLabel.text = waiting > 0 ? "\(waiting) post seni bekliyor (onay ya da görsel)" : nil
        waitingLabel.isHidden = waiting == 0
        ring.layer.borderColor = (waiting > 0 ? IOSTheme.accent : IOSTheme.border).cgColor
        countStack.removeAllArranged()
        for (tab, title) in [(PostTab.grid, "gönderi"), (.reels, "reels"), (.stories, "hikâye")] {
            let number = UILabel.studio("\(counts[tab] ?? 0)", size: 17, weight: .semibold, style: .headline)
            let label = UILabel.studio(title, size: 14, color: IOSTheme.textSecondary, style: .subheadline)
            let column = UIStackView.v([number, label], spacing: 0)
            column.isAccessibilityElement = true
            column.accessibilityLabel = "\(counts[tab] ?? 0) \(title)"
            countStack.addArrangedSubview(column)
        }
    }
}

// MARK: - Tabs

/// Gönderiler / Reels / Hikâyeler as icons with a sliding underline (pinned under the bar).
final class PostsTabBar: UIView {
    var onSelect: ((PostTab) -> Void)?
    private var buttons: [UIButton] = []
    private let underline = UIView()
    private var selected: PostTab = .grid

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = IOSTheme.canvas
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false
        for tab in PostTab.allCases {
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: tab.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 21, weight: .regular)), for: .normal)
            button.accessibilityLabel = tab.label
            button.addAction(UIAction { [weak self] _ in self?.onSelect?(tab) }, for: .touchUpInside)
            buttons.append(button)
            row.addArrangedSubview(button)
        }
        addSubview(row)
        row.pin(to: self)
        underline.backgroundColor = IOSTheme.textPrimary
        addSubview(underline)
        select(.grid, animated: false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeUnderline()
    }

    /// Where the underline stands, in tabs (1.5 = halfway between Reels and stories). The page
    /// drives it, so it moves with the finger and with the page's animations.
    private var position: CGFloat = 0

    /// Lights `tab`'s icon (the underline follows the page, see `follow`).
    func select(_ tab: PostTab, animated: Bool) {
        selected = tab
        for (index, button) in buttons.enumerated() {
            button.tintColor = index == tab.rawValue ? IOSTheme.textPrimary : IOSTheme.textTertiary
            button.accessibilityTraits = index == tab.rawValue ? [.button, .selected] : .button
        }
    }

    func follow(_ position: CGFloat) {
        let last = CGFloat(PostTab.allCases.count - 1)
        self.position = min(max(position, 0), last)
        if let nearest = PostTab(rawValue: Int(self.position.rounded())), nearest != selected { select(nearest, animated: false) }
        placeUnderline()
    }

    private func placeUnderline() {
        guard bounds.width > 0 else { return }
        let width = bounds.width / CGFloat(PostTab.allCases.count)
        underline.frame = CGRect(x: width * position + width * 0.18, y: bounds.height - 1.5, width: width * 0.64, height: 1.5)
    }
}

// MARK: - Tile

/// One tile of the grid: the rendered picture (or the post's title on its tone while it has
/// none), a carousel / Reels mark at the top right, a status dot at the top left and a badge
/// while it is being made.
final class PostGridCell: UICollectionViewCell {
    /// About how wide a tile is on an iPhone (three columns), in points: grids load thumbnails.
    static let displayWidth: CGFloat = 140
    private let imageView = IOSAssetImageView(store: nil, cornerRadius: 0, displayWidth: PostGridCell.displayWidth)
    private let placeholder = UIStackView()
    private let titleLabel = UILabel.studio("", size: 12, weight: .heavy, lines: 5, style: .caption1)
    private let slotHint = UILabel.studio("+ Görsel", size: 11, weight: .semibold, color: IOSTheme.accent, style: .caption2)
    private let kindMark = UIImageView()
    private let dot = IOSStatusDotView(size: 8)
    private let badge = UIView()
    private let badgeSpinner = UIActivityIndicatorView(style: .medium)
    private let badgeLabel = UILabel.studio("", size: 10, weight: .semibold, color: .white, style: .caption2)

    /// The picture the viewer zooms out of and back into.
    var artworkView: UIView { imageView }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.clipsToBounds = true
        contentView.addSubview(imageView)
        imageView.pin(to: contentView)

        placeholder.axis = .vertical
        placeholder.alignment = .leading
        placeholder.spacing = 4
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholder.addArrangedSubview(titleLabel)
        placeholder.addArrangedSubview(UIView.spacer())
        placeholder.addArrangedSubview(slotHint)
        contentView.addSubview(placeholder)
        placeholder.pin(to: contentView, insets: UIEdgeInsets(top: 24, left: 8, bottom: 10, right: 8))

        kindMark.translatesAutoresizingMaskIntoConstraints = false
        kindMark.tintColor = .white
        kindMark.layer.shadowColor = UIColor.black.cgColor
        kindMark.layer.shadowOpacity = 0.35
        kindMark.layer.shadowRadius = 3
        kindMark.layer.shadowOffset = .zero
        contentView.addSubview(kindMark)
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.layer.borderColor = UIColor.white.cgColor
        dot.layer.borderWidth = 1.5
        contentView.addSubview(dot)

        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        badge.layer.cornerRadius = 10
        badgeSpinner.color = .white
        badgeSpinner.transform = CGAffineTransform(scaleX: 0.55, y: 0.55)
        let badgeRow = UIStackView.h([badgeSpinner, badgeLabel], spacing: 0)
        badge.addSubview(badgeRow)
        badgeRow.pin(to: badge, insets: UIEdgeInsets(top: 2, left: 2, bottom: 2, right: 7))
        contentView.addSubview(badge)
        NSLayoutConstraint.activate([
            kindMark.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 7),
            kindMark.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -7),
            dot.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
            dot.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            badge.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 6),
            badge.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -6),
            badge.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -6),
        ])
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func prepareForReuse() {
        super.prepareForReuse()
        transform = .identity
    }

    func configure(card: PostCard, images: IOSImageStore, job: Job?, upload: Double?) {
        imageView.store = images
        let rendered = card.renderedAssetIds.first
        let showImage = rendered != nil && !card.needsImage
        if showImage { imageView.assetId = rendered }
        imageView.isHidden = !showImage
        placeholder.isHidden = showImage
        switch card.placeholderTone {
        case .light: contentView.backgroundColor = IOSTheme.postLight
        case .dark: contentView.backgroundColor = IOSTheme.postDark
        case .muted: contentView.backgroundColor = IOSTheme.postMuted
        }
        titleLabel.text = TurkishFormat.upper(card.title)
        titleLabel.textColor = card.placeholderTone == .dark ? .white : (card.placeholderTone == .light ? .black : IOSTheme.textPrimary)
        slotHint.isHidden = !card.needsImage

        let mark: String? = switch card.content.type {
        case .carousel: "square.fill.on.square.fill"
        case .reel: "play.fill"
        default: card.renderedAssetIds.count > 1 ? "square.fill.on.square.fill" : nil
        }
        kindMark.image = mark.map { UIImage(systemName: $0, withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)) } ?? nil
        kindMark.isHidden = mark == nil
        // Published posts carry no dot (they are simply on the profile); the rest show their state.
        dot.dotColor = card.state.tone.uiColor
        dot.isHidden = card.state == .published

        var badgeText: String?
        if let upload {
            badgeText = upload >= 1 ? "Yerleştiriliyor" : "%\(Int(upload * 100))"
        } else if let job {
            badgeText = job.type == .contentRender ? "Render" : (job.status == .queued ? "Sırada" : "Üretiliyor")
        } else if card.state == .generating {
            badgeText = "Üretiliyor"
        }
        badge.isHidden = badgeText == nil
        badgeLabel.text = badgeText
        badgeText == nil ? badgeSpinner.stopAnimating() : badgeSpinner.startAnimating()

        accessibilityLabel = "\(card.title), \(card.day.map(TurkishFormat.longDay) ?? "tarih yok"), \(card.state.label)\(badgeText.map { ", \($0)" } ?? "")"
        accessibilityHint = "Postu açar. Daha fazla işlem için basılı tut."
    }
}

// MARK: - Approving with the checks

extension IOSPostsViewController {
    /// One post: ask first when its checks found problems, still run, or never ran.
    fileprivate func approveGuarded(_ card: PostCard) {
        Task {
            let gate = await model.approvalGates([card])[card.id] ?? .clear
            let approve: (Bool) -> Void = { acknowledging in
                Task {
                    if await self.model.approve(card, acknowledgingChecks: acknowledging) { Haptics.success() } else if let error = self.model.error { self.presentError(error) }
                }
            }
            guard let question = gate.question else {
                approve(false)
                return
            }
            // "Yine de onayla": the approval tells the API the user saw the checks (E7).
            confirm(question.title, message: "\(card.title)\n\(question.message ?? "")", action: "Yine de onayla", destructive: false) { approve(true) }
        }
    }

    /// "Tümünü onayla": posts whose checks are not clear are named, and can be left out.
    fileprivate func approveAll() {
        let cards = model.approvable
        let count = cards.count
        Task {
            let gates = await model.approvalGates(cards)
            let flagged = cards.filter { gates[$0.id]?.question != nil }
            let run = { (only: Set<EntityID>?, acknowledged: Set<EntityID>) in
                let approving = only?.count ?? count
                Task {
                    await self.model.approveReady(only: only, acknowledged: acknowledged)
                    if let error = self.model.error { self.presentError(error) } else {
                        Haptics.success()
                        Toast.show("\(approving) post onaylandı", in: self.view)
                    }
                }
            }
            guard !flagged.isEmpty else {
                confirm("\(count) post onaylansın mı?", message: "Her post gördüğün sürümün özetiyle (hash) onaylanır.", action: "Onayla", destructive: false) { run(nil, []) }
                return
            }
            let names = flagged.prefix(5).map { card -> String in
                switch gates[card.id] {
                case .problems(let checkRun): "• \(card.title): \(checkRun.blocking) sorun"
                case .running: "• \(card.title): kontroller sürüyor"
                case .notChecked: "• \(card.title): kontrol edilmedi"
                default: "• \(card.title): kontroller okunamadı"
                }
            }
            let more = flagged.count > 5 ? "\n… ve \(flagged.count - 5) post daha" : ""
            let alert = UIAlertController(
                title: "\(flagged.count) postun kontrolleri temiz değil",
                message: names.joined(separator: "\n") + more, preferredStyle: .alert)
            let clean = Set(cards.map(\.id)).subtracting(flagged.map(\.id))
            if !clean.isEmpty {
                alert.addAction(UIAlertAction(title: "Yalnızca sorunsuz \(clean.count) postu onayla", style: .default) { _ in run(clean, []) })
            }
            // "Yine de": the flagged posts' approvals tell the API the user saw their checks (E7).
            alert.addAction(UIAlertAction(title: "Yine de \(count) postu onayla", style: .destructive) { _ in run(nil, Set(flagged.map(\.id))) })
            alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
            present(alert, animated: true)
        }
    }
}
