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

    var visible: [Asset] {
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

final class IOSMediaViewController: UIViewController, UICollectionViewDelegate, UISearchResultsUpdating {
    private unowned let app: IOSAppModel
    private let model: IOSMediaModel
    private var observation: IOSObservationToken?
    private let segmented = UISegmentedControl(items: IOSMediaModel.Filter.allCases.map(\.label))
    private let filterItem = UIBarButtonItem()
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

        segmented.selectedSegmentIndex = model.filter.rawValue
        segmented.translatesAutoresizingMaskIntoConstraints = false
        segmented.addAction(UIAction { [weak self] _ in
            guard let self, let filter = IOSMediaModel.Filter(rawValue: self.segmented.selectedSegmentIndex) else { return }
            self.model.filter = filter
        }, for: .valueChanged)

        collection = UICollectionView(frame: .zero, collectionViewLayout: Self.layout())
        collection.translatesAutoresizingMaskIntoConstraints = false
        collection.backgroundColor = .clear
        collection.delegate = self
        collection.alwaysBounceVertical = true
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
            holder.widthAnchor.constraint(equalToConstant: 220),
            holder.heightAnchor.constraint(equalToConstant: 40),
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
        dataSource.apply(snapshot, animatingDifferences: view.window != nil)

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
            ReelVideo.play(asset.id, app: app, from: self)
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

    func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint) -> UIContextMenuConfiguration? {
        guard let indexPath = indexPaths.first, let id = dataSource.itemIdentifier(for: indexPath), let asset = assetsById[id] else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            if asset.kind == .video {
                return UIMenu(children: [
                    UIAction(title: "Oynat", image: UIImage(systemName: "play")) { _ in ReelVideo.play(asset.id, app: self.app, from: self) },
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

    private func askForReel(_ asset: Asset) {
        prompt("Bu çekimden Reels", message: "Ne anlatsın? Boş bırakırsan Studio kısa bir kurgu yapar.", text: nil,
               placeholder: "Örn. Hasat gününden 20 saniyelik bir özet", action: "Üret") { [weak self] brief in
            guard let self else { return }
            Task {
                do {
                    let content = try await self.model.makeReel(from: asset, brief: brief)
                    Haptics.success()
                    Toast.show("Reels üretime alındı", in: self.view)
                    await self.app.posts.load()
                    self.app.open(.post(content.id))
                } catch {
                    self.presentError(IOSAppModel.describe(error))
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
