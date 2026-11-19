import Observation
import StudioKit
import UIKit

/// Medya (N21): the brand's pictures and videos, newest first, with uploads from Photos, the
/// camera and Files. A video is checked and, when it does not fit the Mac's 50 MB limit, exported
/// again on the phone before it goes. A video can start a Reels ("Bu çekimden Reels yap").
@MainActor
@Observable
final class IOSMediaModel {
    enum Filter: Int, CaseIterable {
        case all, images, videos

        var label: String {
            switch self {
            case .all: "Tümü"
            case .images: "Resim"
            case .videos: "Video"
            }
        }

        func matches(_ asset: Asset) -> Bool {
            switch self {
            case .all: asset.kind == .image || asset.kind == .logo || asset.kind == .video
            case .images: asset.kind == .image || asset.kind == .logo
            case .videos: asset.kind == .video
            }
        }
    }

    struct Upload: Identifiable, Equatable {
        enum Stage: Equatable {
            case preparing(Double)
            case uploading(Double)
            case failed(String)
        }

        let id = UUID()
        var name: String
        var isVideo: Bool
        var stage: Stage
    }

    weak var app: IOSAppModel?
    private(set) var assets: [Asset] = []
    var filter: Filter = .all
    /// Search text: matches the file name and the labels the picture analysis found.
    var query = ""
    /// Labels from the picture analysis picked in the filter menu (a picture must have all).
    var selectedTags: Set<String> = []
    private(set) var uploads: [Upload] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var loadedBrandId: EntityID?
    var error: String?

    init(app: IOSAppModel) {
        self.app = app
    }

    var brandId: EntityID? { app?.currentBrandId }
    /// The analysis labels of the library's pictures, most used first, with their counts.
    var tagCounts: [(label: String, count: Int)] {
        var counts: [String: Int] = [:]
        for asset in assets where filter.matches(asset) {
            for tag in asset.analysis?.tags ?? [] { counts[tag.label, default: 0] += 1 }
        }
        return counts.map { (label: $0.key, count: $0.value) }.sorted { $0.count != $1.count ? $0.count > $1.count : $0.label < $1.label }
    }

    var visible: [Asset] { visible(in: filter) }

    /// What `filter`'s page shows with the current search and tags.
    func visible(in filter: Filter) -> [Asset] {
        let words = query.lowercased(with: Locale(identifier: "tr_TR")).split(separator: " ").map(String.init)
        return assets.filter { asset in
            guard filter.matches(asset) else { return false }
            if !selectedTags.isEmpty {
                let labels = Set(asset.analysis?.tags.map(\.label) ?? [])
                guard selectedTags.isSubset(of: labels) else { return false }
            }
            if words.isEmpty { return true }
            let haystack = ([asset.originalFilename ?? ""] + (asset.analysis?.tags.map(\.label) ?? []))
                .joined(separator: " ").lowercased(with: Locale(identifier: "tr_TR"))
            return words.allSatisfy { haystack.contains($0) }
        }
    }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await app.dataService.assets(brandId: brandId, kind: nil)
            guard brandId == self.brandId else { return }
            assets = loaded.filter { $0.deletedAt == nil && Filter.all.matches($0) }.sorted { $0.createdAt > $1.createdAt }
            loadedBrandId = brandId
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
        hasLoaded = true
    }

    // MARK: Uploads

    func add(_ picked: MediaPicking.Picked) {
        guard let brandId else {
            error = "Yüklemek için önce bir marka seç."
            for video in picked.videos { MediaPicking.discard(video) }
            return
        }
        for (index, image) in picked.images.enumerated() {
            uploadImage(image, index: index, brandId: brandId)
        }
        for video in picked.videos {
            uploadVideo(video, brandId: brandId)
        }
    }

    private func uploadImage(_ image: UIImage, index: Int, brandId: EntityID) {
        guard let app else { return }
        let imported: IOSImageImport.Imported
        do {
            imported = try IOSImageImport.from(image: image, filename: "medya-\(index + 1).jpg")
        } catch {
            self.error = IOSAppModel.describe(error)
            return
        }
        let upload = Upload(name: imported.file.filename, isVideo: false, stage: .uploading(0))
        uploads.append(upload)
        let service = app.dataService
        Task {
            do {
                let asset = try await service.uploadAsset(imported.file, brandId: brandId, kind: .image) { progress in
                    Task { @MainActor in self.set(upload.id, .uploading(progress)) }
                }
                app.images.seed(imported.thumbnail, for: asset.id)
                finished(upload.id, asset: asset)
            } catch {
                set(upload.id, .failed(IOSAppModel.describe(error)))
            }
        }
    }

    private func uploadVideo(_ source: URL, brandId: EntityID) {
        guard let app else { return }
        let upload = Upload(name: source.lastPathComponent, isVideo: true, stage: .preparing(0))
        uploads.append(upload)
        let service = app.dataService
        Task {
            defer { MediaPicking.discard(source) }
            do {
                let prepared = try await VideoPreparation.prepare(source, workDirectory: source.deletingLastPathComponent()) { progress in
                    Task { @MainActor in self.set(upload.id, .preparing(progress)) }
                }
                set(upload.id, .uploading(0))
                let asset = try await service.uploadAsset(prepared.file, brandId: brandId, kind: .video) { progress in
                    Task { @MainActor in self.set(upload.id, .uploading(progress)) }
                }
                finished(upload.id, asset: asset)
            } catch {
                set(upload.id, .failed(IOSAppModel.describe(error)))
            }
        }
    }

    private func set(_ id: UUID, _ stage: Upload.Stage) {
        guard let index = uploads.firstIndex(where: { $0.id == id }) else { return }
        if case .failed = uploads[index].stage { return }
        uploads[index].stage = stage
    }

    private func finished(_ id: UUID, asset: Asset) {
        uploads.removeAll { $0.id == id }
        if asset.brandId == brandId, !assets.contains(where: { $0.id == asset.id }) { assets.insert(asset, at: 0) }
    }

    func dismissUpload(_ id: UUID) {
        uploads.removeAll { $0.id == id }
    }

    // MARK: Reels

    /// "Bu çekimden Reels yap": what the Mac's chat tool does with a clip.
    func makeReel(from asset: Asset, brief: String) async throws -> Content {
        guard let app else { throw CancellationError() }
        let platforms = app.accounts(of: asset.brandId).map(\.platform).filter { $0 != .unknown }
        let (content, _) = try await app.dataService.createReel(ReelFromFootage(
            brandId: asset.brandId, clipAssetId: asset.id, brief: brief,
            platforms: platforms.isEmpty ? [.instagram] : Array(Set(platforms)).sorted { $0.rawValue < $1.rawValue }))
        return content
    }
}

final class IOSMediaViewController: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate, DrawerSwipeBlocking, UISearchResultsUpdating {
    private unowned let app: IOSAppModel
    private let model: IOSMediaModel
    private var observation: IOSObservationToken?
    /// Resim / Video only (no "Tümü"): pictures by default.
    private let segmented = UISegmentedControl(items: [IOSMediaModel.Filter.images.label, IOSMediaModel.Filter.videos.label])
    private let filterItem = UIBarButtonItem()
    /// While the page slides, the grid changes at once (no fade of the old pictures).
    private var isPaging = false
    /// The slide between Resim and Video (stopped where it is when a swipe catches it).
    private var pageAnimator: UIViewPropertyAnimator?
    private var panBase: CGFloat = 0
    /// Where the running slide is going.
    private var pageTarget: IOSMediaModel.Filter?
    private lazy var pagePan = UIPanGestureRecognizer(target: self, action: #selector(paged(_:)))
    private let searchController = UISearchController(searchResultsController: nil)
    private let uploadsStack = UIStackView.v([], spacing: 6)
    private let emptyView = EmptyStateView()
    private var collection: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, EntityID>!
    private var assetsById: [EntityID: Asset] = [:]
    private var lastBrandId: EntityID?

    init(app: IOSAppModel) {
        self.app = app
        self.model = IOSMediaModel(app: app)
        super.init(nibName: nil, bundle: nil)
        title = "Medya"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        let add = UIBarButtonItem(systemItem: .add)
        add.menu = addMenu()
        add.accessibilityLabel = "Fotoğraf ya da video yükle"
        navigationItem.rightBarButtonItem = add

        model.filter = .images
        segmented.selectedSegmentIndex = 0
        segmented.translatesAutoresizingMaskIntoConstraints = false
        segmented.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            // A tap moves the pill with the system's own animation; only a finger dragging the
            // page carries it by hand.
            self.segmentLens?.transform = .identity
            self.pillByTap = true
            self.slide(to: self.segmented.selectedSegmentIndex == 1 ? .videos : .images)
        }, for: .valueChanged)

        collection = UICollectionView(frame: .zero, collectionViewLayout: Self.layout())
        collection.translatesAutoresizingMaskIntoConstraints = false
        collection.backgroundColor = .clear
        collection.delegate = self
        collection.alwaysBounceVertical = true
        // The other page rides beside the grid (inside it, past its side) while it slides.
        collection.clipsToBounds = false
        // An invisible page control: swiping sideways moves between Resim and Video.
        pagePan.delegate = self
        view.addGestureRecognizer(pagePan)
        collection.panGestureRecognizer.require(toFail: pagePan)
        // The same soft edge as the chat: pictures fade out under the navigation bar and the toolbar.
        collection.topEdgeEffect.style = .soft
        collection.bottomEdgeEffect.style = .soft
        setContentScrollView(collection, for: .top)
        setContentScrollView(collection, for: .bottom)
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            Task { await self?.model.load(); refresh?.endRefreshing() }
        }, for: .valueChanged)
        collection.refreshControl = refresh
        let registration = UICollectionView.CellRegistration<MediaCell, EntityID> { [weak self] cell, _, id in
            guard let self, let asset = self.assetsById[id] else { return }
            cell.configure(asset, store: self.app.images)
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: collection) { collectionView, indexPath, id in
            collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
        }

        emptyView.translatesAutoresizingMaskIntoConstraints = false
        let top = UIStackView.v([uploadsStack], spacing: 10)
        view.addSubview(collection)
        view.addSubview(top)
        view.addSubview(emptyView)
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            top.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: IOSTheme.gutter),
            top.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -IOSTheme.gutter),
            collection.topAnchor.constraint(equalTo: view.topAnchor),
            collection.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collection.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collection.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            emptyView.centerYAnchor.constraint(equalTo: collection.centerYAnchor),
            emptyView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            emptyView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])

        buildToolbar()
        observation = observeIOS { [weak self] in self?.render() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Upload rows sit over the top of the grid; the grid starts below them and scrolls under
        // the navigation bar.
        let rows = uploadsStack.arrangedSubviews.isEmpty ? 0 : uploadsStack.frame.height + 18
        if collection.contentInset.top != rows {
            let atTop = collection.contentOffset.y <= -collection.adjustedContentInset.top + 1
            collection.contentInset.top = rows
            collection.verticalScrollIndicatorInsets.top = rows
            if atTop { collection.contentOffset.y = -collection.adjustedContentInset.top }
        }
    }

    func updateSearchResults(for searchController: UISearchController) {
        model.query = searchController.searchBar.text ?? ""
    }

    // MARK: Resim / Video pages

    /// On the Video page a rightward swipe goes back to Resim, so the drawer stays shut there;
    /// on the Resim page it opens the drawer as everywhere else (not while a page is sliding).
    var blocksDrawerSwipe: Bool { pageHeading == .videos }

    /// The page the screen is on or sliding to (a slide toward Resim already counts as Resim, so
    /// a quick swipe right after it opens the drawer instead of catching the slide).
    private var pageHeading: IOSMediaModel.Filter { pageAnimator != nil ? (pageTarget ?? model.filter) : model.filter }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pagePan else { return true }
        let velocity = pagePan.velocity(in: view)
        guard abs(velocity.x) > abs(velocity.y) * 1.2 else { return false }
        // Leftward always pages (Resim → Video, or catching a slide). Rightward pages only on or
        // toward Video; on or toward Resim the drawer takes it.
        if velocity.x < 0 { return pageAnimator != nil || model.filter == .images }
        return pageHeading == .videos
    }

    @objc private func paged(_ pan: UIPanGestureRecognizer) {
        let width = max(collection.bounds.width, 1)
        let dx = pan.translation(in: view).x
        switch pan.state {
        case .began:
            // Catch the page wherever it is (the slide stops there, no waiting for it to end).
            panBase = interruptPaging()
            pillByTap = false
        case .changed:
            var offset = panBase + dx
            // Nothing beyond the two pages: resist past the ends.
            if (model.filter == .images && offset > 0) || (model.filter == .videos && offset < 0) { offset *= 0.3 }
            setPage(offset: offset)
        case .ended, .cancelled, .failed:
            let offset = pageOffset
            let velocity = pan.state == .ended ? pan.velocity(in: view).x : 0
            var target = model.filter
            if offset < -width * 0.25 || velocity < -500 { target = .videos }
            if offset > width * 0.25 || velocity > 500 { target = .images }
            slide(to: target, from: offset)
        default:
            break
        }
    }

    /// Where the page is now (the grid and its empty state move together).
    private var pageOffset: CGFloat { collection.transform.tx }

    /// From one page to the other: a screen width less the hairline the pages would otherwise
    /// double, so between the two the gap is the same 2pt as between the tiles.
    private var pageSpan: CGFloat { max(collection.bounds.width - 2, 1) }

    /// The other page's tiles, inside the grid past its side (they move with it).
    private var neighborPage: UIView?
    /// -1: the other page is to the right (Video), 1: to the left (Resim), 0: none.
    private var neighborSide: CGFloat = 0

    /// The page (the grid and its empty state) moved sideways by `offset`, the other page glued
    /// to its side and the segmented control's pill following along.
    private func setPage(offset: CGFloat) {
        let move = CGAffineTransform(translationX: offset, y: 0)
        collection.transform = move
        emptyView.transform = move
        let side: CGFloat = offset < 0 ? -1 : (offset > 0 ? 1 : 0)
        if pageTarget == nil, side != 0, side != neighborSide {
            showNeighbor(side == -1 && model.filter == .images ? .videos : (side == 1 && model.filter == .videos ? .images : nil), side: side)
        }
        let index: CGFloat = model.filter == .videos ? 1 : 0
        followSegment(index - offset / pageSpan)
    }

    /// Lays `filter`'s tiles out as its grid would show them at the current scroll, on `side`.
    private func showNeighbor(_ filter: IOSMediaModel.Filter?, side: CGFloat) {
        neighborPage?.removeFromSuperview()
        neighborPage = nil
        neighborSide = side
        guard let filter, collection.bounds.width > 0 else { return }
        UIView.performWithoutAnimation {
            // The grid's geometry (see `layout()`): thirds of the width less the 1pt side
            // insets, each tile inset by 1pt.
            let width = collection.bounds.width
            let third = (width - 2) / 3
            let top = collection.contentOffset.y
            let bottom = top + collection.bounds.height
            let page = UIView(frame: CGRect(x: -side * pageSpan, y: 0, width: width, height: max(bottom, 0)))
            page.isUserInteractionEnabled = false
            for (index, asset) in model.visible(in: filter).enumerated() {
                let y = CGFloat(index / 3) * third
                if y > bottom { break }
                if y + third < top { continue }
                let cell = MediaCell(frame: CGRect(x: 1 + CGFloat(index % 3) * third + 1, y: y + 1, width: third - 2, height: third - 2))
                cell.configure(asset, store: app.images)
                page.addSubview(cell)
                cell.layoutIfNeeded()
            }
            collection.insertSubview(page, at: 0)
            neighborPage = page
        }
    }

    private func dropNeighbor() {
        neighborPage?.removeFromSuperview()
        neighborPage = nil
        neighborSide = 0
    }

    // MARK: Segmented pill

    /// The system segmented control's selection pill (the Liquid Glass lens). There is no API to
    /// put it between two segments, so it is moved by hand while the page slides; if a later
    /// iOS names it differently, the pill just jumps as before.
    private var segmentLens: UIView? {
        func find(in view: UIView) -> UIView? {
            for subview in view.subviews {
                if NSStringFromClass(type(of: subview)) == "_UILiquidLensView" { return subview }
                if let found = find(in: subview) { return found }
            }
            return nil
        }
        return find(in: segmented)
    }

    /// The running slide came from a tap on the segmented control (the system moves the pill).
    private var pillByTap = false

    /// The pill at `position` (0 on Resim, 1 on Video, fractions between them).
    private func followSegment(_ position: CGFloat) {
        guard !pillByTap else { return }
        let clamped = min(max(position, 0), 1)
        let segment = segmented.bounds.width / 2
        segmentLens?.transform = CGAffineTransform(translationX: (clamped - CGFloat(segmented.selectedSegmentIndex)) * segment, y: 0)
    }

    /// The segmented control selects `filter` at once, without its own animation (the next
    /// `setPage` puts the pill where the page has it).
    private func settleSegment(on filter: IOSMediaModel.Filter) {
        let index = filter == .videos ? 1 : 0
        guard segmented.selectedSegmentIndex != index else { return }
        let lens = segmentLens
        UIView.performWithoutAnimation {
            lens?.transform = .identity
            segmented.selectedSegmentIndex = index
            segmented.layoutIfNeeded()
        }
        lens?.layer.removeAllAnimations()
    }

    /// Stops a running slide where it is on screen and returns that offset.
    private func interruptPaging() -> CGFloat {
        if let animator = pageAnimator {
            pageAnimator = nil
            animator.stopAnimation(false)
            animator.finishAnimation(at: .current)
        }
        pageTarget = nil
        return pageOffset
    }

    /// Slides to `filter`: both pages move together, side by side, until the other fills the
    /// screen; or back into place when it stays. Interruptible at any moment (a new swipe or tap
    /// takes over).
    private func slide(to filter: IOSMediaModel.Filter, from offset: CGFloat? = nil) {
        let start = offset ?? interruptPaging()
        if let animator = pageAnimator {
            pageAnimator = nil
            animator.stopAnimation(true)
        }
        let width = max(collection.bounds.width, 1)
        pageTarget = filter
        guard filter != model.filter else {
            setPage(offset: start)
            let back = UIViewPropertyAnimator(duration: 0.32, dampingRatio: 1) { self.setPage(offset: 0) }
            back.addCompletion { [weak self] position in
                guard let self, position == .end, self.pageAnimator === back else { return }
                self.pageAnimator = nil
                self.pageTarget = nil
                self.pillByTap = false
                self.dropNeighbor()
            }
            pageAnimator = back
            back.startAnimation()
            return
        }
        let side: CGFloat = filter == .videos ? -1 : 1
        if neighborSide != side || neighborPage == nil { showNeighbor(filter, side: side) }
        setPage(offset: start)
        let end = side * pageSpan
        let remaining = min(max(abs(end - start) / width, 0.3), 1)
        let across = UIViewPropertyAnimator(duration: 0.38 * remaining, dampingRatio: 1) { self.setPage(offset: end) }
        across.addCompletion { [weak self] position in
            // Stopped midway (caught by a swipe): the pages stay where they are, nothing switches.
            guard let self, position == .end, self.pageAnimator === across else { return }
            self.pageAnimator = nil
            self.pageTarget = nil
            self.isPaging = true
            self.model.filter = filter
            self.render()
            self.collection.layoutIfNeeded()
            self.isPaging = false
            self.dropNeighbor()
            self.settleSegment(on: filter)
            self.pillByTap = false
            self.setPage(offset: 0)
        }
        pageAnimator = across
        across.startAnimation()
        Haptics.selection()
    }

    // MARK: Toolbar

    /// The segmented control in the navigation bar's middle; the system toolbar (Liquid Glass)
    /// with the tag filter at the left and the search button at the right.
    private func buildToolbar() {
        // The segmented control sits where the title would be (no "Medya" title shown): the
        // picture viewer's name pill grows out of it and folds back into it.
        let holder = UIView()
        holder.translatesAutoresizingMaskIntoConstraints = false
        segmented.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(segmented)
        segmented.pin(to: holder)
        NSLayoutConstraint.activate([
            holder.widthAnchor.constraint(equalToConstant: 180),
            holder.heightAnchor.constraint(equalToConstant: 44),
        ])
        segmented.setTitleTextAttributes([.font: UIFont.systemFont(ofSize: 15, weight: .semibold)], for: .normal)
        segmented.setTitleTextAttributes([.font: UIFont.systemFont(ofSize: 15, weight: .semibold)], for: .selected)
        navigationItem.titleView = holder
        filterItem.image = UIImage(systemName: "tag")
        filterItem.accessibilityLabel = "Etiketle filtrele"
        filterItem.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.filterMenuElements() ?? [])
        }])

        // Toolbar: the tag filter at the left, search at the right. Search is the system's
        // toolbar search: a round button that grows into a field above the keyboard.
        searchController.obscuresBackgroundDuringPresentation = false
        searchController.searchBar.placeholder = "Medyada ara"
        searchController.searchResultsUpdater = self
        navigationItem.searchController = searchController
        navigationItem.preferredSearchBarPlacement = .integratedButton
        navigationItem.searchBarPlacementAllowsToolbarIntegration = true
        let searchItem = navigationItem.searchBarPlacementBarButtonItem
        setToolbarItems([filterItem, .flexibleSpace(), searchItem], animated: false)
    }

    private func filterMenuElements() -> [UIMenuElement] {
        let tags = model.tagCounts
        guard !tags.isEmpty else {
            return [UIAction(title: "Henüz etiket yok", attributes: .disabled) { _ in }]
        }
        var items: [UIMenuElement] = tags.prefix(40).map { tag in
            UIAction(title: "\(tag.label) (\(tag.count))", state: model.selectedTags.contains(tag.label) ? .on : .off) { [weak self] _ in
                guard let self else { return }
                if self.model.selectedTags.contains(tag.label) { self.model.selectedTags.remove(tag.label) } else { self.model.selectedTags.insert(tag.label) }
            }
        }
        if !model.selectedTags.isEmpty {
            items.insert(UIAction(title: "Filtreyi temizle", image: UIImage(systemName: "xmark.circle"), attributes: .destructive) { [weak self] _ in
                self?.model.selectedTags = []
            }, at: 0)
        }
        return items
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(false, animated: animated)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // A pushed picture viewer has its own toolbar: keep the bar, it only changes items.
        if navigationController?.topViewController?.toolbarItems?.isEmpty ?? true {
            navigationController?.setToolbarHidden(true, animated: animated)
        }
    }

    private static func layout() -> UICollectionViewLayout {
        let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .fractionalWidth(1 / 3), heightDimension: .fractionalWidth(1 / 3)))
        item.contentInsets = NSDirectionalEdgeInsets(top: 1, leading: 1, bottom: 1, trailing: 1)
        let group = NSCollectionLayoutGroup.horizontal(layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .fractionalWidth(1 / 3)), subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 1, bottom: 24, trailing: 1)
        return UICollectionViewCompositionalLayout(section: section)
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }
        filterItem.image = UIImage(systemName: model.selectedTags.isEmpty ? "tag" : "tag.fill")
        let visible = model.visible
        assetsById = Dictionary(visible.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var snapshot = NSDiffableDataSourceSnapshot<Int, EntityID>()
        snapshot.appendSections([0])
        snapshot.appendItems(visible.map(\.id))
        snapshot.reconfigureItems(visible.map(\.id).filter { dataSource.snapshot().itemIdentifiers.contains($0) })
        dataSource.apply(snapshot, animatingDifferences: view.window != nil && !isPaging)

        uploadsStack.removeAllArranged()
        for upload in model.uploads { uploadsStack.addArrangedSubview(uploadRow(upload)) }
        if let error = model.error {
            let label = UILabel.studio(error, size: 13, color: IOSTheme.accent, lines: 0, style: .footnote)
            uploadsStack.addArrangedSubview(label)
        }

        let brandName = app.currentBrand?.name
        emptyView.isHidden = !visible.isEmpty || !model.hasLoaded
        if app.currentBrandId == nil {
            emptyView.configure(icon: "photo.on.rectangle", title: "Marka seçilmedi", message: "Medya markaya göre tutulur; önce bir marka seç.")
        } else if !model.query.isEmpty {
            emptyView.configure(icon: "magnifyingglass", title: "Sonuç yok", message: "“\(model.query)” için eşleşen bir fotoğraf ya da video bulunamadı.")
        } else {
            let what = switch model.filter {
            case .all: "Henüz fotoğraf ya da video yok"
            case .images: "Fotoğraf yok"
            case .videos: "Video yok"
            }
            emptyView.configure(
                icon: model.filter == .videos ? "video" : "photo.on.rectangle", title: what,
                message: "\(brandName.map { "\($0) için " } ?? "")Fotoğraflar'dan, kameradan ya da Dosyalar'dan ekleyebilirsin. Diğer uygulamalardan “Studio'ya gönder” ile de gelir.",
                actions: [UIButton.studioPill(title: "Ekle", kind: .primary, image: "plus") { [weak self] in self?.pickFromLibrary() }])
        }
    }

    private func uploadRow(_ upload: IOSMediaModel.Upload) -> UIView {
        let icon = UIImageView(image: UIImage(systemName: upload.isVideo ? "video" : "photo"))
        icon.tintColor = IOSTheme.textSecondary
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 22).isActive = true
        let text: String
        var color = IOSTheme.textSecondary
        switch upload.stage {
        case .preparing(let p): text = "Video hazırlanıyor · %\(Int((p * 100).rounded()))"
        case .uploading(let p): text = "Yükleniyor · %\(Int((p * 100).rounded()))"
        case .failed(let message):
            text = message
            color = IOSTheme.accent
        }
        let name = UILabel.studio(upload.name, size: 14, weight: .medium, style: .subheadline)
        name.lineBreakMode = .byTruncatingMiddle
        let status = UILabel.studio(text, size: 12, color: color, lines: 2, style: .caption1)
        var views: [UIView] = [icon, UIStackView.v([name, status], spacing: 1)]
        if case .failed = upload.stage {
            let close = UIButton(type: .system)
            close.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
            close.tintColor = IOSTheme.textTertiary
            close.accessibilityLabel = "Kapat"
            close.addAction(UIAction { [weak self] _ in self?.model.dismissUpload(upload.id) }, for: .touchUpInside)
            views.append(close)
        }
        let row = UIStackView.h(views, spacing: 10)
        row.isAccessibilityElement = true
        row.accessibilityLabel = "\(upload.name), \(text)"
        return row
    }

    private func addMenu() -> UIMenu {
        var items: [UIMenuElement] = [
            UIAction(title: "Fotoğraflar ve videolar", image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in self?.pickFromLibrary() },
        ]
        if ImagePicking.cameraAvailable {
            items.append(UIAction(title: "Kamera", image: UIImage(systemName: "camera")) { [weak self] _ in
                guard let self else { return }
                MediaPicking.camera(from: self) { self.model.add($0) }
            })
        }
        items.append(UIAction(title: "Dosyalar", image: UIImage(systemName: "folder")) { [weak self] _ in
            guard let self else { return }
            MediaPicking.files(from: self) { self.model.add($0) }
        })
        return UIMenu(children: items)
    }

    private func pickFromLibrary() {
        MediaPicking.library(from: self, limit: 10) { [weak self] in self?.model.add($0) }
    }

    // MARK: Selection

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        guard let id = dataSource.itemIdentifier(for: indexPath), let asset = assetsById[id] else { return }
        if asset.kind == .video {
            showVideo(asset, source: collectionView.cellForItem(at: indexPath)?.contentView)
        } else {
            showPhoto(asset, source: collectionView.cellForItem(at: indexPath)?.contentView)
        }
    }

    /// Opens the picture in the viewer with the library's other pictures to page through.
    private func showPhoto(_ asset: Asset, source: UIView?) {
        let photos = model.visible.filter { $0.kind != .video }
        let items = photos.map { photo -> PhotoViewerItem in
            var aspect: CGFloat?
            if let w = photo.width, let h = photo.height, h > 0 { aspect = CGFloat(w) / CGFloat(h) }
            return PhotoViewerItem(assetId: photo.id, title: photo.originalFilename ?? "Fotoğraf", subtitle: PhotoViewerItem.addedText(photo.createdAt), aspect: aspect)
        }
        let start = photos.firstIndex { $0.id == asset.id } ?? 0
        let viewer = PhotoViewerViewController(images: app.images, items: items, index: start, sourceFor: { [weak self] index in
            guard let self else { return source }
            guard photos.indices.contains(index),
                  let path = self.dataSource.indexPath(for: photos[index].id),
                  let cell = self.collection.cellForItem(at: path) else { return source ?? self.collection }
            return cell.contentView
        }, actionsFor: { [weak self] item in
            PhotoViewerBar(trailing: PhotoViewerAction(label: "Ürün olarak ekle", symbol: "shippingbox") { viewer, item in
                guard let self else { return }
                let editor = ProductEditorViewController(app: self.app, product: nil, photoAssetIds: [item.assetId], analyzeAssetId: item.assetId)
                viewer.presentSheet(editor, detents: [.large()])
            })
        })
        viewer.open(from: self)
    }

    /// Opens the video in the same viewer as pictures, with the library's other videos to page
    /// through; it plays in place.
    private func showVideo(_ asset: Asset, source: UIView?) {
        let videos = model.visible.filter { $0.kind == .video }
        let items = videos.map { video -> PhotoViewerItem in
            var aspect: CGFloat?
            if let w = video.width, let h = video.height, h > 0 { aspect = CGFloat(w) / CGFloat(h) }
            return PhotoViewerItem(assetId: video.id, title: video.originalFilename ?? "Video", subtitle: PhotoViewerItem.addedText(video.createdAt), aspect: aspect, isVideo: true)
        }
        let start = videos.firstIndex { $0.id == asset.id } ?? 0
        let viewer = PhotoViewerViewController(images: app.images, items: items, index: start, sourceFor: { [weak self] index in
            guard let self else { return source }
            guard videos.indices.contains(index),
                  let path = self.dataSource.indexPath(for: videos[index].id),
                  let cell = self.collection.cellForItem(at: path) else { return source ?? self.collection }
            return cell.contentView
        }, actionsFor: { [weak self] item in
            PhotoViewerBar(trailing: PhotoViewerAction(label: "Bu çekimden Reels yap", symbol: "film") { viewer, item in
                guard let self, let video = self.assetsById[item.assetId] else { return }
                self.askForReel(video, from: viewer)
            })
        })
        viewer.openOnPoster(from: self)
    }

    func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint) -> UIContextMenuConfiguration? {
        guard let indexPath = indexPaths.first, let id = dataSource.itemIdentifier(for: indexPath), let asset = assetsById[id] else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            if asset.kind == .video {
                return UIMenu(children: [
                    UIAction(title: "Oynat", image: UIImage(systemName: "play")) { _ in self.showVideo(asset, source: nil) },
                    UIAction(title: "Bu çekimden Reels yap", image: UIImage(systemName: "film")) { _ in self.askForReel(asset) },
                ])
            }
            return UIMenu(children: [
                UIAction(title: "Göster", image: UIImage(systemName: "eye")) { _ in
                    self.showPhoto(asset, source: nil)
                },
                UIAction(title: "Ürün olarak ekle", image: UIImage(systemName: "shippingbox")) { _ in
                    let editor = ProductEditorViewController(app: self.app, product: nil, photoAssetIds: [asset.id], analyzeAssetId: asset.id)
                    self.presentSheet(editor, detents: [.large()])
                },
            ])
        }
    }

    /// `presenter`: the screen on top (the viewer, when asked from there).
    private func askForReel(_ asset: Asset, from presenter: UIViewController? = nil) {
        let presenter = presenter ?? self
        presenter.prompt("Bu çekimden Reels", message: "Ne anlatsın? Boş bırakırsan Studio kısa bir kurgu yapar.", text: nil,
               placeholder: "Örn. Hasat gününden 20 saniyelik bir özet", action: "Üret") { [weak self, weak presenter] brief in
            guard let self else { return }
            Task {
                do {
                    let content = try await self.model.makeReel(from: asset, brief: brief)
                    Haptics.success()
                    Toast.show("Reels üretime alındı", in: (presenter ?? self).view)
                    await self.app.posts.load()
                    self.app.open(.post(content.id))
                } catch {
                    (presenter ?? self).presentError(IOSAppModel.describe(error))
                }
            }
        }
    }
}

/// One tile: the picture's thumbnail, or a dark tile with the video's length.
final class MediaCell: UICollectionViewCell {
    private var imageView: IOSAssetImageView?
    private let videoBadge = UIStackView.h([], spacing: 3)
    private let durationLabel = UILabel.studio("", size: 11, weight: .semibold, color: .white, style: .caption2)
    private let videoIcon = UIImageView(image: UIImage(systemName: "play.fill"))
    private let placeholder = UIImageView(image: UIImage(systemName: "video"))

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = IOSTheme.fill
        contentView.clipsToBounds = true
        placeholder.tintColor = IOSTheme.textTertiary
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholder.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 26)
        contentView.addSubview(placeholder)
        videoIcon.tintColor = .white
        videoIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 10, weight: .bold)
        videoBadge.addArrangedSubview(videoIcon)
        videoBadge.addArrangedSubview(durationLabel)
        videoBadge.isLayoutMarginsRelativeArrangement = true
        videoBadge.layoutMargins = UIEdgeInsets(top: 2, left: 5, bottom: 2, right: 5)
        videoBadge.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        videoBadge.layer.cornerRadius = 5
        contentView.addSubview(videoBadge)
        NSLayoutConstraint.activate([
            placeholder.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            videoBadge.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -5),
            videoBadge.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -5),
        ])
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ asset: Asset, store: IOSImageStore) {
        let isVideo = asset.kind == .video
        placeholder.isHidden = !isVideo
        videoBadge.isHidden = !isVideo
        durationLabel.text = VideoThumbnail.duration(asset.durationMs) ?? "Video"
        if isVideo {
            imageView?.removeFromSuperview()
            imageView = nil
        } else if let imageView {
            imageView.assetId = asset.id
        } else {
            let view = IOSAssetImageView(store: store, assetId: asset.id, displayWidth: 130)
            contentView.insertSubview(view, at: 0)
            view.pin(to: contentView)
            imageView = view
        }
        accessibilityLabel = isVideo ? "Video, \(durationLabel.text ?? "")" : (asset.originalFilename ?? "Fotoğraf")
        accessibilityTraits = .button
    }
}
