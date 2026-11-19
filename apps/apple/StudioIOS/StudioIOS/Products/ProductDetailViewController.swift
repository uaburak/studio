import StudioKit
import UIKit

/// One product, opened from its Ürünler tile with the system's zoom, laid out like OXTV's content
/// page: the photo from the very top of the screen (under the bar) fading into the page at its
/// foot and stretching when pulled down; the name and the category centred under it, the name
/// moving up into the bar as it scrolls away; the description and the tags as on a Postlar post.
/// Only the product's information; the pencil opens the editor (which also deletes).
final class ProductDetailViewController: UIViewController, UIScrollViewDelegate {
    private unowned let app: IOSAppModel
    private let model: IOSProductsModel
    private let productId: EntityID
    /// The product as last shown (kept when it drops out of the model, until the page leaves).
    private var product: BrandProduct?
    private var observation: IOSObservationToken?
    private var isLeaving = false
    private var expanded = false

    private let scroll = UIScrollView()
    private let content = UIView()
    private let pager = ProductPhotoPager()
    /// The photo's foot fades into the page (OXTV's hero).
    private let fade = ProductFadeView()
    private let nameLabel = UILabel.studio("", size: 26, weight: .bold, lines: 0, style: .title1)
    private let categoryLabel = UILabel.studio("", size: 15, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
    private let captionLabel = UILabel.studio("", size: 14, lines: 0, style: .subheadline)
    private let tagsLabel = UILabel.studio("", size: 14, lines: 0, style: .subheadline)
    private let notesLabel = UILabel.studio("", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
    private let metaLabel = UILabel.studio("", size: 12, color: IOSTheme.textSecondary, style: .caption1)
    private let navTitle = UILabel.studio("", size: 17, weight: .semibold, style: .headline)
    private var truncated = false

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
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        let edit = UIBarButtonItem(image: UIImage(systemName: "pencil"), primaryAction: UIAction { [weak self] _ in self?.edit() })
        edit.accessibilityLabel = "Düzenle"
        navigationItem.rightBarButtonItem = edit
        // The name comes into the bar once the one on the page has scrolled under it.
        // Faded inside a holder: the bar sets its title view's own alpha back to 1 on a push.
        navTitle.alpha = 0
        navTitle.textAlignment = .center
        navTitle.translatesAutoresizingMaskIntoConstraints = false
        let holder = UIView()
        holder.isUserInteractionEnabled = false
        holder.addSubview(navTitle)
        navTitle.pin(to: holder)
        navigationItem.titleView = holder

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.alwaysBounceVertical = true
        scroll.showsVerticalScrollIndicator = false
        scroll.delegate = self
        view.addSubview(scroll)
        scroll.pin(to: view)
        setContentScrollView(scroll, for: .top)

        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)

        pager.images = app.images
        pager.onTap = { [weak self] index in self?.showPhoto(index) }
        content.addSubview(pager)
        fade.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(fade)

        nameLabel.textAlignment = .center
        categoryLabel.textAlignment = .center
        let titles = UIStackView.v([nameLabel, categoryLabel], spacing: 4, alignment: .fill)
        captionLabel.isUserInteractionEnabled = true
        captionLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(captionTapped)))
        let text = UIStackView.v([captionLabel, tagsLabel, notesLabel, metaLabel], spacing: 8, alignment: .fill)
        text.setCustomSpacing(10, after: notesLabel)
        let column = UIStackView.v([titles, text], spacing: 22, alignment: .fill)
        column.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(column)

        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),

            pager.topAnchor.constraint(equalTo: content.topAnchor),
            pager.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            pager.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            fade.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            fade.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            fade.bottomAnchor.constraint(equalTo: pager.bottomAnchor),
            fade.heightAnchor.constraint(equalToConstant: 140),

            // The titles sit on the fade, over the photo's foot.
            column.topAnchor.constraint(equalTo: pager.bottomAnchor, constant: -34),
            column.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            column.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -48),
        ])

        observation = observeIOS { [weak self] in self?.render() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The caption is cut to its width (three lines and "… devamı").
        renderCaption()
        scrolled()
    }

    // MARK: Render

    private func render() {
        let current = model.products.first { $0.id == productId }
        guard let current else {
            // Deleted (in the editor or on the Mac): the page goes back to the grid.
            if product != nil, !isLeaving, model.hasLoaded {
                isLeaving = true
                navigationController?.popViewController(animated: true)
            }
            return
        }
        product = current
        nameLabel.text = current.name
        navTitle.text = current.name
        categoryLabel.text = current.category
        categoryLabel.isHidden = current.category.isEmpty
        pager.configure(current)
        // Tags as a post's hashtags.
        tagsLabel.text = current.tags.map { "#" + $0.replacingOccurrences(of: " ", with: "") }.joined(separator: " ")
        tagsLabel.isHidden = current.tags.isEmpty
        notesLabel.text = current.notes
        notesLabel.isHidden = current.notes.isEmpty
        metaLabel.text = Self.metaLine(current)
        renderCaption()
    }

    /// "Name description…" cut to three lines with "… devamı", as on a Postlar post.
    private func renderCaption() {
        guard let product else { return }
        let width = view.bounds.width - 32
        guard width > 0 else { return }
        captionLabel.isHidden = product.description.isEmpty
        guard !product.description.isEmpty else { return }
        let (caption, cut) = PostFeedCell.caption(brand: product.name, text: product.description, width: width, expanded: expanded)
        if captionLabel.attributedText?.string != caption.string { captionLabel.attributedText = caption }
        truncated = cut
    }

    @objc private func captionTapped() {
        guard truncated else { return }
        expanded = true
        renderCaption()
    }

    /// "3 fotoğraf · 5 gün önce eklendi" (or updated), like a post's status line.
    private static func metaLine(_ product: BrandProduct, now: Date = Date()) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.unitsStyle = .full
        let updated = product.updatedAt.timeIntervalSince(product.createdAt) > 60
        let when = formatter.localizedString(for: updated ? product.updatedAt : product.createdAt, relativeTo: now)
        let photos = product.imageAssetIds.isEmpty ? "Fotoğraf yok" : "\(product.imageAssetIds.count) fotoğraf"
        return "\(photos) · \(when) \(updated ? "güncellendi" : "eklendi")"
    }

    // MARK: Scrolling (OXTV's hero)

    func scrollViewDidScroll(_ scrollView: UIScrollView) { scrolled() }

    private func scrolled() {
        let offset = scroll.contentOffset.y
        let height = pager.photoHeight
        guard height > 0 else { return }
        // Pulled down: the photo stretches upward from its foot.
        if offset < 0 {
            let scale = (height - offset) / height
            pager.transform = CGAffineTransform(translationX: 0, y: offset / 2).scaledBy(x: scale, y: scale)
        } else {
            pager.transform = .identity
        }
        // The bar's soft edge only once the photo has gone under it.
        let bar = view.safeAreaInsets.top
        scroll.topEdgeEffect.isHidden = offset < height - bar - 20
        // The name moves into the bar as the page's one passes under it.
        guard offset > 0 else {
            nameLabel.alpha = 1
            navTitle.alpha = 0
            return
        }
        let nameBottom = nameLabel.convert(nameLabel.bounds, to: view).maxY
        let progress = min(max(1 - (nameBottom - bar) / 80, 0), 1)
        let eased = progress * progress * (3 - 2 * progress)
        nameLabel.alpha = 1 - eased
        let staggered = min(max((progress - 0.3) / 0.7, 0), 1)
        navTitle.alpha = staggered * staggered * (3 - 2 * staggered)
    }

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
}

/// Clear at the top, the page's colour at the bottom.
final class ProductFadeView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        update()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.update() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func update() {
        let canvas = IOSTheme.canvas.resolvedColor(with: traitCollection)
        (layer as? CAGradientLayer)?.colors = [canvas.withAlphaComponent(0).cgColor, canvas.withAlphaComponent(0.55).cgColor, canvas.cgColor]
        (layer as? CAGradientLayer)?.locations = [0, 0.55, 1]
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
        dots.pageIndicatorTintColor = UIColor.white.withAlphaComponent(0.45)
        dots.currentPageIndicatorTintColor = .white
        dots.addAction(UIAction { [weak self] _ in self?.scroll(to: self?.dots.currentPage ?? 0, animated: true) }, for: .valueChanged)
        addSubview(dots)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.heightAnchor.constraint(equalTo: scrollView.widthAnchor),
            placeholder.topAnchor.constraint(equalTo: scrollView.topAnchor),
            placeholder.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor),
            placeholder.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor),
            placeholder.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor),
            // Over the photo, above the fade and the titles.
            dots.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor, constant: -64),
            dots.centerXAnchor.constraint(equalTo: centerXAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
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

    var photoHeight: CGFloat { scrollView.bounds.height }

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
