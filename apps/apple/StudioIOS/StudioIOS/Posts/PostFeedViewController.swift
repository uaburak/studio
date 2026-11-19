import StudioKit
import UIKit

/// Gönderiler opened from the grid, like Instagram's post feed: every post of the tab in grid
/// order, one under the other, starting at the tapped one (which zooms out of its tile). Each post
/// has the brand's row with its menu, the picture (a carousel pages sideways), the post's actions,
/// the caption ("… devamı" opens it in place) and where it stands. Back flies the topmost post's
/// picture into its tile.
final class PostFeedViewController: PostZoomPage, UITableViewDataSource, UITableViewDelegate {
    private let tableView = UITableView(frame: .zero, style: .plain)
    private var startId: EntityID?
    private var expanded: Set<EntityID> = []
    private var observation: IOSObservationToken?
    private var signature: Int?
    /// The post whose picture is out flying (its own copy is hidden meanwhile).
    private weak var hiddenMedia: UIView?
    private var placedStart = false

    init(app: IOSAppModel, ids: [EntityID], start: EntityID, sourceFor: @escaping (EntityID) -> UIView?) {
        self.startId = start
        self.flightId = start
        super.init(app: app, ids: ids, sourceFor: sourceFor)
        navigationItem.title = "Gönderiler"
        navigationItem.subtitle = PostPresentation.brandName(app)
        navigationItem.largeTitleDisplayMode = .never
        // The system back button (and its swipe), closing through the zoom.
        navigationItem.backAction = UIAction { [weak self] _ in self?.close() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = IOSTheme.canvas
        tableView.separatorStyle = .none
        tableView.dataSource = self
        tableView.delegate = self
        tableView.allowsSelection = false
        // Exact heights (see heightForRowAt): no estimates to fall back on mid-scroll.
        tableView.estimatedRowHeight = 0
        // Insets set by hand from the bar: the safe area is not known yet when the opening
        // measures where the tapped post lands, and following it later would make it jump.
        tableView.contentInsetAdjustmentBehavior = .never
        tableView.register(PostFeedCell.self, forCellReuseIdentifier: "post")
        tableView.topEdgeEffect.style = .soft
        view.addSubview(tableView)
        tableView.pin(to: view)
        setContentScrollView(tableView, for: .top)
        observation = observeIOS { [weak self] in self?.render() }
    }

    /// Board changes (approve, schedule, delete) reach the open feed.
    private func render() {
        pruneIds()
        var hasher = Hasher()
        for card in cards { hasher.combine(card) }
        hasher.combine(app.currentBrand?.name)
        let next = hasher.finalize()
        guard next != signature else { return }
        let first = signature == nil
        signature = next
        navigationItem.subtitle = PostPresentation.brandName(app)
        if !first, ids.isEmpty { return close() }
        guard !first else { return }
        // Same posts: the rows on screen take the new state in place (a full reload mid-scroll
        // remeasured rows from estimates and squeezed pictures and captions).
        if ids == shownIds {
            reconfigureVisibleRows()
        } else {
            reloadKeepingPosition()
        }
    }

    /// The posts the table shows (a reload brings it up to `ids`).
    private var shownIds: [EntityID] = []

    private func reconfigureVisibleRows() {
        let rows = tableView.indexPathsForVisibleRows ?? []
        UIView.performWithoutAnimation {
            tableView.beginUpdates()
            for path in rows {
                guard let cell = tableView.cellForRow(at: path) as? PostFeedCell else { continue }
                configure(cell, row: path.row)
            }
            tableView.endUpdates()
        }
    }

    /// Reloads without the list jumping: the topmost post stays where it is.
    private func reloadKeepingPosition() {
        let anchor = topmostRow()
        shownIds = ids
        let anchorId = anchor.flatMap { ids.indices.contains($0) ? ids[$0] : nil }
        let offsetInRow = anchor.map { tableView.contentOffset.y - tableView.rectForRow(at: IndexPath(row: $0, section: 0)).minY } ?? 0
        tableView.reloadData()
        tableView.layoutIfNeeded()
        if let anchorId, let row = ids.firstIndex(of: anchorId) {
            tableView.contentOffset.y = tableView.rectForRow(at: IndexPath(row: row, section: 0)).minY + offsetInRow
        }
    }

    // MARK: Opening at the tapped post

    /// The tapped post sits right under the bar (done before the opening measures its picture).
    private func placeStart() {
        guard !placedStart, view.bounds.width > 0 else { return }
        placedStart = true
        view.layoutIfNeeded()
        shownIds = ids
        tableView.reloadData()
        guard let startId, let row = ids.firstIndex(of: startId) else { return }
        let path = IndexPath(row: row, section: 0)
        // Twice: the first pass measures the rows above with their real heights.
        for _ in 0..<2 {
            tableView.scrollToRow(at: path, at: .top, animated: false)
            tableView.layoutIfNeeded()
        }
        self.startId = nil
        currentRow = row
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        let bar = navigationController.map { $0.navigationBar.convert($0.navigationBar.bounds, to: $0.view).maxY } ?? 0
        let top = max(bar, view.safeAreaInsets.top)
        let bottom = (view.window?.safeAreaInsets.bottom ?? view.safeAreaInsets.bottom) + 24
        if tableView.contentInset.top != top || tableView.contentInset.bottom != bottom {
            tableView.contentInset = UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
            tableView.verticalScrollIndicatorInsets = UIEdgeInsets(top: top, left: 0, bottom: bottom - 24, right: 0)
        }
        if view.superview != nil { placeStart() }
    }

    // MARK: The picture's flight

    /// The post the flight is about: the tapped one while opening, then the topmost one.
    private var currentRow: Int? {
        didSet { if let currentRow, ids.indices.contains(currentRow) { flightId = ids[currentRow] } }
    }
    private var flightId: EntityID?

    /// The post that fills the top of the screen (the one back returns to).
    private func topmostRow() -> Int? {
        let top = tableView.contentOffset.y + tableView.contentInset.top
        let visible = (tableView.indexPathsForVisibleRows ?? []).sorted()
        // The first post whose picture still shows at least half under the bar.
        for path in visible {
            guard let cell = tableView.cellForRow(at: path) as? PostFeedCell else { continue }
            let media = cell.mediaFrame(in: tableView)
            if media.midY >= top { return path.row }
        }
        return visible.first?.row
    }

    private func flightCell() -> PostFeedCell? {
        placeStart()
        if !isOpening, !isMovingToParent { currentRow = topmostRow() ?? currentRow }
        guard let row = currentRow, ids.indices.contains(row) else { return nil }
        tableView.layoutIfNeeded()
        return tableView.cellForRow(at: IndexPath(row: row, section: 0)) as? PostFeedCell
    }

    override var shownImage: UIImage? {
        if let image = flightCell()?.currentImage { return image }
        guard let row = currentRow, ids.indices.contains(row), let card = app.posts.card(ids[row]),
              let first = card.renderedAssetIds.first else { return nil }
        return app.images.anyCached(first)
    }

    override func currentSource() -> UIView? {
        if !isOpening, placedStart { currentRow = topmostRow() ?? currentRow }
        return tile(for: flightId)
    }

    override func pictureRect(in container: UIView) -> CGRect {
        guard let cell = flightCell() else {
            let width = container.bounds.width
            return CGRect(x: 0, y: container.bounds.midY - width * 0.625, width: width, height: width * 1.25)
        }
        return cell.mediaView.convert(cell.mediaView.bounds, to: container)
    }

    override func setContentHidden(_ hidden: Bool) {
        if hidden {
            hiddenMedia?.alpha = 1
            let media = flightCell()?.mediaView
            media?.alpha = 0
            hiddenMedia = media
        } else {
            hiddenMedia?.alpha = 1
            hiddenMedia = nil
        }
        view.backgroundColor = hidden ? .clear : IOSTheme.canvas
        tableView.backgroundColor = hidden ? .clear : IOSTheme.canvas
    }

    override func setZoomProgress(_ progress: CGFloat) {
        tableView.alpha = progress
    }

    // MARK: Table

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { ids.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "post", for: indexPath) as! PostFeedCell
        configure(cell, row: indexPath.row)
        // The cell being reused may still be hidden from a flight.
        if cell.mediaView !== hiddenMedia { cell.mediaView.alpha = 1 }
        return cell
    }

    private func configure(_ cell: PostFeedCell, row: Int) {
        guard ids.indices.contains(row), let card = app.posts.card(ids[row]) else { return }
        let actions = PostActions(app: app, host: self)
        let id = card.id
        cell.configure(card: card, brand: PostPresentation.brandName(app), images: app.images,
                       width: tableView.bounds.width, expanded: expanded.contains(id), actions: actions)
        cell.onExpand = { [weak self] in
            guard let self, let row = self.ids.firstIndex(of: id) else { return }
            self.expanded.insert(id)
            UIView.performWithoutAnimation {
                self.tableView.reloadRows(at: [IndexPath(row: row, section: 0)], with: .none)
            }
        }
    }

    /// The row's height comes from the same metrics the cell lays itself out by.
    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        guard ids.indices.contains(indexPath.row), let card = app.posts.card(ids[indexPath.row]) else { return 0 }
        return PostFeedCell.metrics(card: card, brand: PostPresentation.brandName(app), width: max(tableView.bounds.width, 1),
                                    expanded: expanded.contains(card.id)).height
    }
}

// MARK: - One post

/// One post of the feed (Instagram's layout): the brand row, the picture, the actions, the
/// caption and the status line.
final class PostFeedCell: UITableViewCell, UIScrollViewDelegate {
    var onExpand: (() -> Void)?

    private let avatar = PostAvatarView(side: 32)
    private let nameLabel = UILabel.studio("", size: 14, weight: .semibold, style: .subheadline)
    private let titleLabel = UILabel.studio("", size: 12, color: IOSTheme.textSecondary, style: .caption1)
    private let menuButton = UIButton.insta(.menu, label: "Diğer", size: 22)
    /// The picture (all slides, paging sideways); the flight lands on it. It lays its pages out
    /// itself: the cell's own layout runs before the picture takes a reused cell's new height,
    /// which left pages stretched or cut to the previous post's size.
    let mediaView = LayoutReportingView()
    private let pager = UIScrollView()
    private var pages: [IOSAssetImageView] = []
    private let placeholder = PostPlaceholderView()
    private let counter = UILabel.studio("", size: 12, weight: .semibold, color: .white, style: .caption1)
    private let dots = UIPageControl()
    // Instagram's row: like, comment, send … and download where the bookmark is (see `InstaIcon`).
    private let approveButton = UIButton.insta(.like, label: "Onayla", size: 24)
    private let editButton = UIButton.insta(.comment, label: "Düzenle", size: 24)
    private let shareButton = UIButton.insta(.send, label: "Paylaş", size: 24)
    private let downloadButton = UIButton.insta(.download, label: "Fotoğraflar'a kaydet", size: 24)
    /// The heart that pops over the picture on a double tap.
    private let bigHeart = UIImageView(image: InstaIcon.liked.image(96))
    private let captionLabel = UILabel.studio("", size: 14, lines: 0, style: .subheadline)
    private let metaLabel = UILabel.studio("", size: 12, color: IOSTheme.textSecondary, style: .caption1)
    private var card: PostCard?
    private var actions: PostActions?
    private var truncated = false
    /// Laid out by hand from `Metrics` (the row's height is worked out the same way, so the
    /// two always agree: Auto Layout here once stretched the brand row and squeezed the
    /// caption and the status line to nothing).
    private var header: UIStackView!
    private let actionsRow = UIView()
    private var metrics = Metrics(media: 400, caption: 0, meta: 0)

    /// The picture on screen (the flying copy).
    var currentImage: UIImage? {
        guard !pages.isEmpty, pager.bounds.width > 0 else { return pages.first?.image }
        let page = min(max(Int((pager.contentOffset.x / pager.bounds.width).rounded()), 0), pages.count - 1)
        return pages[page].image
    }

    func mediaFrame(in view: UIView) -> CGRect { mediaView.convert(mediaView.bounds, to: view) }

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        contentView.backgroundColor = .clear

        menuButton.showsMenuAsPrimaryAction = true
        let names = UIStackView.v([nameLabel, titleLabel], spacing: 0)
        header = UIStackView.h([avatar, names, UIView.spacer(), menuButton], spacing: 10)
        header.alignment = .center
        header.isLayoutMarginsRelativeArrangement = true
        header.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 4)

        mediaView.clipsToBounds = true
        mediaView.backgroundColor = IOSTheme.fill
        pager.translatesAutoresizingMaskIntoConstraints = false
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.delegate = self
        mediaView.addSubview(pager)
        pager.pin(to: mediaView)
        mediaView.onLayout = { [weak self] in self?.layoutPages() }
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        mediaView.addSubview(placeholder)
        placeholder.pin(to: mediaView)
        counter.textAlignment = .center
        counter.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        counter.layer.cornerRadius = 12
        counter.clipsToBounds = true
        mediaView.addSubview(counter)

        dots.translatesAutoresizingMaskIntoConstraints = false
        dots.hidesForSinglePage = true
        dots.isUserInteractionEnabled = false
        dots.currentPageIndicatorTintColor = IOSTheme.accent
        dots.pageIndicatorTintColor = IOSTheme.textTertiary
        dots.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)

        approveButton.addAction(UIAction { [weak self] _ in
            guard let self, let card = self.card else { return }
            self.actions?.toggleApproval(card)
        }, for: .touchUpInside)
        editButton.addAction(UIAction { [weak self] _ in
            guard let self, let card = self.card else { return }
            self.actions?.edit(card)
        }, for: .touchUpInside)
        shareButton.addAction(UIAction { [weak self] _ in
            guard let self, let card = self.card else { return }
            self.actions?.share(card, source: self.shareButton)
        }, for: .touchUpInside)
        downloadButton.addAction(UIAction { [weak self] _ in
            guard let self, let card = self.card else { return }
            self.actions?.saveToPhotos(card)
        }, for: .touchUpInside)
        let left = UIStackView.h([approveButton, editButton, shareButton], spacing: -4)
        left.translatesAutoresizingMaskIntoConstraints = false
        downloadButton.translatesAutoresizingMaskIntoConstraints = false
        actionsRow.addSubview(left)
        actionsRow.addSubview(dots)
        actionsRow.addSubview(downloadButton)

        // A double tap on the picture approves it, as a double tap likes on Instagram.
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        doubleTap.numberOfTapsRequired = 2
        mediaView.addGestureRecognizer(doubleTap)
        bigHeart.tintColor = .white
        bigHeart.alpha = 0
        bigHeart.layer.shadowColor = UIColor.black.cgColor
        bigHeart.layer.shadowOpacity = 0.25
        bigHeart.layer.shadowRadius = 8
        bigHeart.layer.shadowOffset = .zero
        mediaView.addSubview(bigHeart)
        NSLayoutConstraint.activate([
            left.leadingAnchor.constraint(equalTo: actionsRow.leadingAnchor, constant: 4),
            left.centerYAnchor.constraint(equalTo: actionsRow.centerYAnchor),
            dots.centerXAnchor.constraint(equalTo: actionsRow.centerXAnchor),
            dots.centerYAnchor.constraint(equalTo: actionsRow.centerYAnchor),
            downloadButton.trailingAnchor.constraint(equalTo: actionsRow.trailingAnchor, constant: -4),
            downloadButton.centerYAnchor.constraint(equalTo: actionsRow.centerYAnchor),
        ])

        captionLabel.isUserInteractionEnabled = true
        captionLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(captionTapped)))
        for view: UIView in [header, mediaView, actionsRow, captionLabel, metaLabel] {
            view.translatesAutoresizingMaskIntoConstraints = true
            contentView.addSubview(view)
        }
        NSLayoutConstraint.activate([
            counter.topAnchor.constraint(equalTo: mediaView.topAnchor, constant: 12),
            counter.trailingAnchor.constraint(equalTo: mediaView.trailingAnchor, constant: -12),
            counter.heightAnchor.constraint(equalToConstant: 24),
            counter.widthAnchor.constraint(greaterThanOrEqualToConstant: 38),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func prepareForReuse() {
        super.prepareForReuse()
        onExpand = nil
        pager.contentOffset = .zero
    }

    static let fallbackAspect: CGFloat = 4.0 / 5.0

    func configure(card: PostCard, brand: String, images: IOSImageStore, width: CGFloat, expanded: Bool, actions: PostActions) {
        let sameMedia = self.card?.id == card.id && self.card?.renderedAssetIds == card.renderedAssetIds
        self.card = card
        self.actions = actions
        avatar.set(name: brand)
        nameLabel.text = brand
        titleLabel.text = card.title
        menuButton.menu = actions.menu(for: card, source: menuButton)

        metrics = Self.metrics(card: card, brand: brand, width: width, expanded: expanded)
        setNeedsLayout()
        let assets = card.needsImage ? [] : card.renderedAssetIds
        if !sameMedia {
            pages.forEach { $0.removeFromSuperview() }
            pages = assets.map { id in
                let page = IOSAssetImageView(store: images, assetId: id, contentMode: .scaleAspectFill)
                page.translatesAutoresizingMaskIntoConstraints = true
                if page.image == nil { page.image = images.anyCached(id) }
                pager.addSubview(page)
                return page
            }
            pager.contentOffset = .zero
            mediaView.setNeedsLayout()
        }
        placeholder.isHidden = !assets.isEmpty
        if assets.isEmpty { placeholder.configure(card) }
        dots.numberOfPages = assets.count
        updatePage()

        let canApprove = PostActions.canApprove(card)
        approveButton.isEnabled = canApprove || card.state == .approved || card.state == .scheduled
        let approved = card.content.status.hasApproval
        approveButton.setInsta(approved ? .liked : .like, size: 24, tint: approved ? InstaIcon.likeRed : IOSTheme.textPrimary)
        approveButton.accessibilityLabel = approved ? "Onayı geri al" : "Onayla"
        approveButton.isUserInteractionEnabled = canApprove || approved
        shareButton.isEnabled = !card.renderedAssetIds.isEmpty
        downloadButton.isEnabled = !card.renderedAssetIds.isEmpty

        let textWidth = max(width - 28, 1)
        let (caption, isTruncated) = Self.caption(brand: brand, text: card.content.caption, width: textWidth, expanded: expanded)
        captionLabel.attributedText = caption
        captionLabel.isHidden = card.content.caption.isEmpty
        truncated = isTruncated
        metaLabel.text = PostPresentation.statusLine(card)
    }

    // MARK: Layout

    struct Metrics {
        var media: CGFloat
        var caption: CGFloat
        var meta: CGFloat

        /// Brand row 48, the picture, actions 46, the caption and 6 (when there is one), the
        /// status line, 18 below.
        var height: CGFloat { 48 + media + 46 + (caption > 0 ? caption + 6 : 0) + meta + 18 }
    }

    static func metrics(card: PostCard, brand: String, width: CGFloat, expanded: Bool) -> Metrics {
        let aspect = PostPresentation.aspect(card) ?? fallbackAspect
        let textWidth = max(width - 28, 1)
        var caption: CGFloat = 0
        if !card.content.caption.isEmpty {
            let (text, _) = Self.caption(brand: brand, text: card.content.caption, width: textWidth, expanded: expanded)
            caption = text.boundingRect(with: CGSize(width: textWidth, height: .greatestFiniteMagnitude),
                                        options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height.rounded(.up)
        }
        let meta = IOSTheme.font(12, style: .caption1).lineHeight.rounded(.up)
        return Metrics(media: (width / aspect).rounded(), caption: caption, meta: meta)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        header.frame = CGRect(x: 0, y: 0, width: width, height: 48)
        mediaView.frame = CGRect(x: 0, y: 48, width: width, height: metrics.media)
        actionsRow.frame = CGRect(x: 0, y: mediaView.frame.maxY, width: width, height: 46)
        var y = actionsRow.frame.maxY
        if metrics.caption > 0 {
            captionLabel.frame = CGRect(x: 14, y: y, width: width - 28, height: metrics.caption)
            y += metrics.caption + 6
        }
        metaLabel.frame = CGRect(x: 14, y: y, width: width - 28, height: metrics.meta)
    }

    private func layoutPages() {
        let size = mediaView.bounds.size
        guard size.width > 0 else { return }
        for (index, page) in pages.enumerated() {
            page.frame = CGRect(x: CGFloat(index) * size.width, y: 0, width: size.width, height: size.height)
        }
        pager.contentSize = CGSize(width: size.width * CGFloat(pages.count), height: size.height)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { updatePage() }

    private func updatePage() {
        let count = pages.count
        let page = pager.bounds.width > 0 ? min(max(Int((pager.contentOffset.x / pager.bounds.width).rounded()), 0), max(count - 1, 0)) : 0
        dots.currentPage = page
        counter.isHidden = count < 2
        counter.text = "\(page + 1)/\(count)"
    }

    @objc private func doubleTapped() {
        guard let card, let actions else { return }
        // The heart pops over the picture; an approved post stays approved (as a double tap
        // never unlikes).
        let side: CGFloat = 96
        bigHeart.frame = CGRect(x: (mediaView.bounds.width - side) / 2, y: (mediaView.bounds.height - side) / 2, width: side, height: side)
        bigHeart.transform = CGAffineTransform(scaleX: 0.2, y: 0.2)
        bigHeart.alpha = 1
        UIView.animate(springDuration: 0.35, bounce: 0.45) { self.bigHeart.transform = .identity } completion: { _ in
            UIView.animate(withDuration: 0.2, delay: 0.35, options: []) {
                self.bigHeart.alpha = 0
                self.bigHeart.transform = CGAffineTransform(scaleX: 0.85, y: 0.85)
            }
        }
        if !card.content.status.hasApproval, PostActions.canApprove(card) { actions.approve(card) }
    }

    @objc private func captionTapped() {
        guard truncated else { return }
        onExpand?()
    }

    // MARK: Caption

    private static let maxLines = 3

    /// "brand **name** caption…", cut to three lines with "… devamı" (unless opened).
    static func caption(brand: String, text: String, width: CGFloat, expanded: Bool) -> (NSAttributedString, Bool) {
        let font = IOSTheme.font(14, style: .subheadline)
        let bold = IOSTheme.font(14, .semibold, style: .subheadline)
        let build: (String, Bool) -> NSAttributedString = { body, more in
            let result = NSMutableAttributedString(string: brand + " ", attributes: [.font: bold, .foregroundColor: IOSTheme.textPrimary])
            result.append(NSAttributedString(string: body, attributes: [.font: font, .foregroundColor: IOSTheme.textPrimary]))
            if more {
                result.append(NSAttributedString(string: "… devamı", attributes: [.font: font, .foregroundColor: IOSTheme.textSecondary]))
            }
            return result
        }
        let full = build(text, false)
        guard !expanded else { return (full, false) }
        let limit = font.lineHeight * CGFloat(maxLines) + 1
        let fits: (NSAttributedString) -> Bool = { string in
            string.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height <= limit
        }
        if fits(full) { return (full, false) }
        // The longest start of the caption that fits with "… devamı" after it (on a word).
        let characters = Array(text)
        var low = 0
        var high = characters.count
        while low < high {
            let middle = (low + high + 1) / 2
            if fits(build(String(characters[0..<middle]), true)) { low = middle } else { high = middle - 1 }
        }
        var cut = String(characters[0..<low])
        if let space = cut.lastIndex(where: { $0 == " " || $0 == "\n" }), cut.distance(from: cut.startIndex, to: space) > low / 2 {
            cut = String(cut[..<space])
        }
        return (build(cut.trimmingCharacters(in: .whitespacesAndNewlines), true), true)
    }
}

/// A view that says when it has been laid out (its size is final then).
final class LayoutReportingView: UIView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}
