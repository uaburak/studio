import StudioKit
import UIKit

/// One product, opened from its Ürünler tile with the system's zoom: its photos full width at the
/// top (a pager with dots when there are several), its name and category, then its details in
/// grouped sections. Only the product's information; "Düzenle" opens the product editor.
final class ProductDetailViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private unowned let app: IOSAppModel
    private let model: IOSProductsModel
    private let productId: EntityID
    /// The product as last shown (kept when it drops out of the model, until the page leaves).
    private var product: BrandProduct?
    private var observation: IOSObservationToken?
    private var isLeaving = false

    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let header = UIView()
    private let pager = ProductPhotoPager()
    private let nameLabel = UILabel.studio("", size: 24, weight: .bold, lines: 0, style: .title2)
    private let categoryLabel = UILabel.studio("", size: 15, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
    private var sections: [Section] = []

    /// A grouped section of the page.
    private enum Row {
        case text(String)
        case value(String, String)
        case delete
    }

    private struct Section {
        var title: String?
        var rows: [Row]
    }

    init(app: IOSAppModel, model: IOSProductsModel, productId: EntityID) {
        self.app = app
        self.model = model
        self.productId = productId
        self.product = model.products.first { $0.id == productId }
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Düzenle", primaryAction: UIAction { [weak self] _ in self?.edit() })

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.dataSource = self
        tableView.delegate = self
        tableView.contentInset.bottom = 40
        tableView.topEdgeEffect.style = .soft
        view.addSubview(tableView)
        tableView.pin(to: view)
        setContentScrollView(tableView, for: .top)

        // The header: the photos edge to edge, then the name and category in the table's margins.
        pager.images = app.images
        pager.onTap = { [weak self] index in self?.showPhoto(index) }
        let titles = UIStackView.v([nameLabel, categoryLabel], spacing: 4)
        titles.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(pager)
        header.addSubview(titles)
        NSLayoutConstraint.activate([
            pager.topAnchor.constraint(equalTo: header.topAnchor),
            pager.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            pager.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            titles.topAnchor.constraint(equalTo: pager.bottomAnchor, constant: 14),
            titles.leadingAnchor.constraint(equalTo: header.layoutMarginsGuide.leadingAnchor),
            titles.trailingAnchor.constraint(equalTo: header.layoutMarginsGuide.trailingAnchor),
            titles.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -4),
        ])
        header.preservesSuperviewLayoutMargins = true
        tableView.tableHeaderView = header

        observation = observeIOS { [weak self] in self?.render() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        sizeHeader()
    }

    /// The table header has no auto sizing: it is measured at the table's width.
    private func sizeHeader() {
        let width = tableView.bounds.width
        guard width > 0 else { return }
        let size = header.systemLayoutSizeFitting(CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
                                                  withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        if header.frame.size != CGSize(width: width, height: size.height) {
            header.frame = CGRect(x: 0, y: 0, width: width, height: size.height)
            tableView.tableHeaderView = header
        }
    }

    // MARK: Render

    private func render() {
        let current = model.products.first { $0.id == productId }
        guard let current else {
            // Deleted (here, in the editor or on the Mac): the page goes back to the grid.
            if product != nil, !isLeaving, model.hasLoaded {
                isLeaving = true
                navigationController?.popViewController(animated: true)
            }
            return
        }
        product = current
        nameLabel.text = current.name
        categoryLabel.text = current.category
        categoryLabel.isHidden = current.category.isEmpty
        pager.configure(current)

        var sections: [Section] = []
        if !current.description.isEmpty { sections.append(Section(title: "Açıklama", rows: [.text(current.description)])) }
        if !current.tags.isEmpty { sections.append(Section(title: "Etiketler", rows: [.text(ProductTags.text(current.tags))])) }
        if !current.notes.isEmpty { sections.append(Section(title: "Notlar", rows: [.text(current.notes)])) }
        var info: [Row] = []
        info.append(.value("Fotoğraf", current.imageAssetIds.isEmpty ? "Yok" : "\(current.imageAssetIds.count)"))
        info.append(.value("Eklendi", Self.dateFormatter.string(from: current.createdAt)))
        if current.updatedAt.timeIntervalSince(current.createdAt) > 60 {
            info.append(.value("Güncellendi", Self.dateFormatter.string(from: current.updatedAt)))
        }
        sections.append(Section(title: "Bilgi", rows: info))
        sections.append(Section(title: nil, rows: [.delete]))
        self.sections = sections
        tableView.reloadData()
        view.setNeedsLayout()
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    // MARK: Zoom

    /// Where the photo sits on the page: the zoom lines the tile up with it.
    func pictureRect(in container: UIView) -> CGRect {
        view.layoutIfNeeded()
        return pager.photoFrame(in: container)
    }

    // MARK: Actions

    private func edit() {
        guard let product else { return }
        let editor = ProductEditorViewController(app: app, product: product)
        editor.onSaved = { [weak self] saved in self?.model.saved(saved) }
        editor.onDeleted = { [weak self] _ in Task { await self?.model.load() } }
        presentSheet(editor, detents: [.large()])
    }

    private func delete(source: UIView?) {
        guard let product else { return }
        confirm("“\(product.name)” silinsin mi?", message: "Ürün kalıcı olarak silinir; fotoğrafları medyada kalır.", action: "Sil", source: source) { [weak self] in
            guard let self else { return }
            Task {
                if let error = await self.model.delete(product) { self.presentError(error) } else { Haptics.success() }
            }
        }
    }

    /// The photos uncropped, in the app's viewer (the pager's square crops them).
    private func showPhoto(_ index: Int) {
        guard let product, !product.imageAssetIds.isEmpty else { return }
        let items = product.imageAssetIds.enumerated().map {
            PhotoViewerItem(assetId: $1, title: product.name, subtitle: product.imageAssetIds.count > 1 ? "\($0 + 1) / \(product.imageAssetIds.count)" : nil, aspect: nil)
        }
        PhotoViewerViewController(images: app.images, items: items, index: index, sourceFor: { [weak self] index in
            self?.pager.photoView(at: index)
        }).open(from: self)
    }

    // MARK: Table

    func numberOfSections(in tableView: UITableView) -> Int { sections.count }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].rows.count }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { sections[section].title }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        switch sections[indexPath.section].rows[indexPath.row] {
        case .text(let text):
            var content = UIListContentConfiguration.cell()
            content.text = text
            content.textProperties.numberOfLines = 0
            content.textProperties.font = IOSTheme.font(16)
            cell.contentConfiguration = content
            cell.selectionStyle = .none
        case .value(let title, let value):
            var content = UIListContentConfiguration.valueCell()
            content.text = title
            content.secondaryText = value
            cell.contentConfiguration = content
            cell.selectionStyle = .none
        case .delete:
            var content = UIListContentConfiguration.cell()
            content.text = "Ürünü sil"
            content.textProperties.color = .systemRed
            content.textProperties.alignment = .center
            cell.contentConfiguration = content
            cell.accessibilityTraits = .button
        }
        return cell
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        if case .delete = sections[indexPath.section].rows[indexPath.row] { return true }
        return false
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if case .delete = sections[indexPath.section].rows[indexPath.row] {
            delete(source: tableView.cellForRow(at: indexPath))
        }
    }

    // Long texts (notes, descriptions) can be copied.
    func tableView(_ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard case .text(let text) = sections[indexPath.section].rows[indexPath.row] else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
            UIMenu(children: [UIAction(title: "Kopyala", image: UIImage(systemName: "doc.on.doc")) { _ in UIPasteboard.general.string = text }])
        }
    }
}

// MARK: - Photos

/// The product's photos as a square, full-width horizontal pager with dots under it when there
/// are several; with none, its name large on its tone (like a Postlar post with no picture).
final class ProductPhotoPager: UIView, UIScrollViewDelegate {
    weak var images: IOSImageStore?
    var onTap: ((Int) -> Void)?

    private let scrollView = UIScrollView()
    private let dots = UIPageControl()
    private let placeholder = UIView()
    private let placeholderLabel = UILabel.studio("", size: 22, weight: .heavy, lines: 0, style: .title2)
    private var photoViews: [IOSAssetImageView] = []
    private var assetIds: [EntityID] = []
    private var dotsHeight: NSLayoutConstraint!

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.isPagingEnabled = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.delegate = self
        scrollView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        addSubview(scrollView)

        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholder.isUserInteractionEnabled = false
        placeholder.addSubview(placeholderLabel)
        placeholderLabel.pin(to: placeholder, insets: UIEdgeInsets(top: 24, left: 20, bottom: 24, right: 20))
        addSubview(placeholder)

        dots.translatesAutoresizingMaskIntoConstraints = false
        dots.hidesForSinglePage = true
        dots.pageIndicatorTintColor = IOSTheme.textTertiary
        dots.currentPageIndicatorTintColor = IOSTheme.textPrimary
        dots.addAction(UIAction { [weak self] _ in self?.scroll(to: self?.dots.currentPage ?? 0, animated: true) }, for: .valueChanged)
        addSubview(dots)
        dotsHeight = dots.heightAnchor.constraint(equalToConstant: 0)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.heightAnchor.constraint(equalTo: scrollView.widthAnchor),
            placeholder.topAnchor.constraint(equalTo: scrollView.topAnchor),
            placeholder.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor),
            placeholder.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor),
            placeholder.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor),
            dots.topAnchor.constraint(equalTo: scrollView.bottomAnchor),
            dots.centerXAnchor.constraint(equalTo: centerXAnchor),
            dots.bottomAnchor.constraint(equalTo: bottomAnchor),
            dotsHeight,
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ product: BrandProduct) {
        placeholderLabel.text = TurkishFormat.upper(product.name)
        let tone = ProductTone(product)
        placeholder.backgroundColor = tone.background
        placeholderLabel.textColor = tone.text
        placeholder.isHidden = !product.imageAssetIds.isEmpty
        placeholder.accessibilityLabel = product.name
        guard product.imageAssetIds != assetIds else { return }
        assetIds = product.imageAssetIds
        photoViews.forEach { $0.removeFromSuperview() }
        photoViews = assetIds.enumerated().map { index, id in
            let photo = IOSAssetImageView(store: images, assetId: id)
            photo.translatesAutoresizingMaskIntoConstraints = true
            photo.isAccessibilityElement = true
            photo.accessibilityLabel = "\(product.name), fotoğraf \(index + 1)"
            photo.accessibilityTraits = .image
            scrollView.addSubview(photo)
            return photo
        }
        dots.numberOfPages = assetIds.count
        dots.currentPage = min(dots.currentPage, max(assetIds.count - 1, 0))
        // Dots take room only with several photos.
        dotsHeight.constant = assetIds.count > 1 ? 30 : 0
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = scrollView.bounds.width
        for (index, photo) in photoViews.enumerated() {
            photo.frame = CGRect(x: CGFloat(index) * side, y: 0, width: side, height: side)
        }
        scrollView.contentSize = CGSize(width: side * CGFloat(photoViews.count), height: side)
        scrollView.contentOffset.x = CGFloat(dots.currentPage) * side
    }

    /// The square picture's frame (the zoom's target), in `container`'s coordinates.
    func photoFrame(in container: UIView) -> CGRect {
        scrollView.convert(scrollView.bounds, to: container)
    }

    /// The photo the viewer closes back into (the pager turns to it).
    func photoView(at index: Int) -> UIView? {
        guard photoViews.indices.contains(index) else { return nil }
        if index != dots.currentPage { scroll(to: index, animated: false) }
        return photoViews[index]
    }

    private func scroll(to page: Int, animated: Bool) {
        dots.currentPage = page
        scrollView.setContentOffset(CGPoint(x: CGFloat(page) * scrollView.bounds.width, y: 0), animated: animated)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView.bounds.width > 0, scrollView.isDragging || scrollView.isDecelerating else { return }
        dots.currentPage = Int((scrollView.contentOffset.x / scrollView.bounds.width).rounded())
    }

    @objc private func tapped() {
        guard !photoViews.isEmpty else { return }
        onTap?(dots.currentPage)
    }
}
