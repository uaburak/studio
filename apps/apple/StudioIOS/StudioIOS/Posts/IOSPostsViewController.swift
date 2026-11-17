import StudioKit
import UIKit

/// Postlar: a month of the brand's posts in a two-column 4:5 grid, with status filters,
/// rendered images, a floating "approve all ready" bar and a menu on every card.
final class IOSPostsViewController: UIViewController, UICollectionViewDelegate {
    private unowned let app: IOSAppModel
    private var model: IOSPostsModel { app.posts }

    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, EntityID>!
    private let header = PostsHeaderView()
    private let approveBar = UIView()
    private let approveLabel = UILabel.studio("", size: 15, weight: .semibold, style: .subheadline)
    private var approveButton: UIButton!
    private let emptyView = EmptyStateView()
    private var navToken: IOSObservationToken?
    private var observation: IOSObservationToken?
    private var lastBrandId: EntityID?
    private var signatures: [EntityID: Int] = [:]

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        title = "Postlar"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navToken = StudioNavBarItems.install(on: self, app: app)

        collectionView = UICollectionView(frame: .zero, collectionViewLayout: Self.layout())
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = IOSTheme.canvas
        collectionView.delegate = self
        collectionView.alwaysBounceVertical = true
        collectionView.contentInset.bottom = 90
        view.addSubview(collectionView)
        collectionView.pin(to: view)

        let cellRegistration = UICollectionView.CellRegistration<PostGridCell, EntityID> { [weak self] cell, _, id in
            guard let self, let card = self.model.card(id) else { return }
            cell.configure(card: card, images: self.app.images, job: self.model.activeJob(for: id), upload: self.model.slotUploads[id])
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { collectionView, indexPath, id in
            collectionView.dequeueConfiguredReusableCell(using: cellRegistration, for: indexPath, item: id)
        }
        let headerRegistration = UICollectionView.SupplementaryRegistration<UICollectionReusableView>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] supplementary, _, _ in
            guard let self else { return }
            if self.header.superview !== supplementary {
                supplementary.subviews.forEach { $0.removeFromSuperview() }
                supplementary.addSubview(self.header)
                self.header.pin(to: supplementary)
            }
        }
        dataSource.supplementaryViewProvider = { collectionView, kind, indexPath in
            collectionView.dequeueConfiguredReusableSupplementary(using: headerRegistration, for: indexPath)
        }

        header.onPrevious = { [weak self] in
            self?.model.month = self?.model.month.previous ?? MonthKey(Date())
            Haptics.selection()
        }
        header.onNext = { [weak self] in
            self?.model.month = self?.model.month.next ?? MonthKey(Date())
            Haptics.selection()
        }
        header.onFilter = { [weak self] filter in
            self?.model.filter = filter
            Haptics.selection()
        }

        emptyView.isUserInteractionEnabled = true
        view.addSubview(emptyView)
        NSLayoutConstraint.activate([
            emptyView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            emptyView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            emptyView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 120),
            emptyView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
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

    private static func layout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { _, environment in
            let width = environment.container.effectiveContentSize.width
            let columns = width > 700 ? 3 : 2
            let spacing: CGFloat = 12
            let itemWidth = (width - 2 * IOSTheme.gutter - CGFloat(columns - 1) * spacing) / CGFloat(columns)
            let metaHeight = UIFontMetrics(forTextStyle: .footnote).scaledValue(for: 30)
            let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1 / CGFloat(columns)), heightDimension: .fractionalHeight(1)))
            let group = NSCollectionLayoutGroup.horizontal(
                layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .absolute(itemWidth * 5 / 4 + metaHeight)),
                repeatingSubitem: item, count: columns)
            group.interItemSpacing = .fixed(spacing)
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = 18
            section.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: IOSTheme.gutter, bottom: 16, trailing: IOSTheme.gutter)
            let header = NSCollectionLayoutBoundarySupplementaryItem(
                layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(96)),
                elementKind: UICollectionView.elementKindSectionHeader, alignment: .top)
            section.boundarySupplementaryItems = [header]
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
            guard let self else { return }
            let count = self.model.approvable.count
            self.confirm("\(count) post onaylansın mı?", message: "Her post gördüğün sürümün özetiyle (hash) onaylanır.", action: "Onayla", destructive: false) {
                Task {
                    await self.model.approveReady()
                    if let error = self.model.error { self.presentError(error) } else {
                        Haptics.success()
                        Toast.show("\(count) post onaylandı", in: self.view)
                    }
                }
            }
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

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }
        header.configure(month: model.month, filter: model.filter, counts: model.counts, loading: model.isLoading)

        let cards = model.visibleCards
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
        snapshot.appendSections([0])
        snapshot.appendItems(cards.map(\.id))
        snapshot.reconfigureItems(changed)
        dataSource.apply(snapshot, animatingDifferences: view.window != nil)

        // Empty / error / loading states
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
            let others = model.months.filter { $0 != model.month }
            var actions: [UIButton] = []
            if model.filter != .all {
                actions.append(UIButton.studioPill(title: "Tümünü göster", kind: .secondary) { [weak self] in self?.model.filter = .all })
            } else if let nearest = others.min(by: { abs($0.distance(to: model.month)) < abs($1.distance(to: model.month)) }) {
                actions.append(UIButton.studioPill(title: "\(TurkishFormat.monthName(nearest)) \(nearest.year)", kind: .secondary) { [weak self] in self?.model.month = nearest })
            }
            actions.append(UIButton.studioPill(title: "Sohbette üret", kind: .primary) { [weak self] in self?.app.open(.newConversation) })
            emptyView.configure(icon: "square.grid.2x2", title: model.filter == .all ? "Bu ayda post yok" : "Bu filtrede post yok",
                                message: "Sohbette “bu ayın postlarını üret” de; plan onaylanınca postlar burada belirir.", actions: actions)
        } else {
            emptyView.isHidden = true
        }

        let ready = model.approvable.count
        approveBar.isHidden = ready == 0
        approveLabel.text = "\(ready) post onaya hazır"
        approveButton.setPill(title: "Tümünü onayla", kind: .primary, busy: model.isApproving)
        approveButton.isEnabled = !model.isApproving
    }

    // MARK: UICollectionViewDelegate

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard let id = dataSource.itemIdentifier(for: indexPath), let card = model.card(id) else { return }
        open(card)
    }

    private func open(_ card: PostCard) {
        let vc = IOSPostDetailViewController(app: app, card: card)
        navigationController?.pushViewController(vc, animated: true)
    }

    func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath], point: CGPoint) -> UIContextMenuConfiguration? {
        guard let indexPath = indexPaths.first, let id = dataSource.itemIdentifier(for: indexPath), let card = model.card(id) else { return nil }
        let source = collectionView.cellForItem(at: indexPath)
        return UIContextMenuConfiguration(identifier: id as NSString, previewProvider: { [weak self] in
            guard let self, let rendered = card.renderedAssetIds.first, let image = self.app.images.image(rendered) else { return nil }
            let preview = UIViewController()
            let imageView = UIImageView(image: image)
            imageView.contentMode = .scaleAspectFit
            preview.view = imageView
            preview.preferredContentSize = CGSize(width: 340, height: 340 * image.size.height / max(image.size.width, 1))
            return preview
        }) { [weak self] _ in
            guard let self else { return nil }
            return self.menu(for: card, source: source)
        }
    }

    func collectionView(_ collectionView: UICollectionView, willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration, animator: any UIContextMenuInteractionCommitAnimating) {
        guard let id = configuration.identifier as? String, let card = model.card(id) else { return }
        animator.addCompletion { [weak self] in self?.open(card) }
    }

    private func menu(for card: PostCard, source: UIView?) -> UIMenu {
        var primary: [UIMenuElement] = [UIAction(title: "Aç", image: UIImage(systemName: "arrow.up.left.and.arrow.down.right")) { [weak self] _ in self?.open(card) }]
        if card.state == .ready, card.approvableHash != nil {
            primary.append(UIAction(title: "Onayla", image: UIImage(systemName: "checkmark.circle")) { [weak self] _ in
                guard let self else { return }
                Task {
                    if await self.model.approve(card) { Haptics.success() } else if let error = self.model.error { self.presentError(error) }
                }
            })
        }
        if !card.slots.isEmpty {
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
                self.confirm("“\(card.title)” silinsin mi?", message: "Post ve tüm sürümleri silinir. Bu geri alınamaz.", action: "Sil") {
                    Task {
                        if await self.model.delete(card) { Haptics.success() } else if let error = self.model.error { self.presentError(error) }
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

// MARK: - Header (month + filters)

final class PostsHeaderView: UIView {
    var onPrevious: (() -> Void)?
    var onNext: (() -> Void)?
    var onFilter: ((PostListFilter) -> Void)?

    private let monthLabel = UILabel.studio("", size: 22, weight: .bold, style: .title2)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let filterStack = UIStackView()
    private var rendered: (PostListFilter, [PostListFilter: Int])?

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        let previous = UIButton.studioIcon("chevron.left", label: "Önceki ay") { [weak self] in self?.onPrevious?() }
        let next = UIButton.studioIcon("chevron.right", label: "Sonraki ay") { [weak self] in self?.onNext?() }
        spinner.hidesWhenStopped = true
        let monthRow = UIStackView.h([monthLabel, spinner, UIView.spacer(), previous, next], spacing: 4)
        monthLabel.accessibilityTraits = .header

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        filterStack.axis = .horizontal
        filterStack.spacing = 8
        filterStack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(filterStack)
        NSLayoutConstraint.activate([
            filterStack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            filterStack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            filterStack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            filterStack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            filterStack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 38),
        ])
        let stack = UIStackView.v([monthRow, scroll], spacing: 8)
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 0, left: 0, bottom: 4, right: 0))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(month: MonthKey, filter: PostListFilter, counts: [PostListFilter: Int], loading: Bool) {
        let currentYear = CalendarDay(Date()).year
        monthLabel.text = TurkishFormat.monthTitle(month, currentYear: currentYear)
        loading ? spinner.startAnimating() : spinner.stopAnimating()
        if let rendered, rendered.0 == filter, rendered.1 == counts { return }
        rendered = (filter, counts)
        filterStack.removeAllArranged()
        for option in PostListFilter.allCases {
            let count = counts[option] ?? 0
            guard option == .all || count > 0 || option == filter else { continue }
            let button = UIButton.studioPill(title: "\(option.label) \(count)", kind: option == filter ? .ink : .secondary) { [weak self] in self?.onFilter?(option) }
            button.accessibilityLabel = "\(option.label), \(count) post"
            button.accessibilityTraits.insert(option == filter ? .selected : [])
            filterStack.addArrangedSubview(button)
        }
    }
}

// MARK: - Card

final class PostGridCell: UICollectionViewCell {
    private let artboard = UIView()
    private let imageView = IOSAssetImageView(store: nil, cornerRadius: 0)
    private let placeholder = UIStackView()
    private let eyebrow = UILabel.studio("", size: 10, weight: .bold, color: IOSTheme.accent, style: .caption2)
    private let titleLabel = UILabel.studio("", size: 16, weight: .heavy, lines: 4, style: .headline)
    private let slotHint = UILabel.studio("+ Görsel ekle", size: 12, weight: .semibold, color: IOSTheme.accent, style: .caption1)
    private let badge = UIView()
    private let badgeSpinner = UIActivityIndicatorView(style: .medium)
    private let badgeLabel = UILabel.studio("", size: 11, weight: .semibold, color: .white, style: .caption2)
    private let dateLabel = UILabel.studio("", size: 13, weight: .medium, style: .footnote)
    private let dot = IOSStatusDotView(size: 6)
    private let stateLabel = UILabel.studio("", size: 12, color: IOSTheme.textSecondary, style: .caption1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        artboard.translatesAutoresizingMaskIntoConstraints = false
        artboard.layer.cornerRadius = 16
        artboard.layer.cornerCurve = .continuous
        artboard.clipsToBounds = true
        artboard.addSubview(imageView)
        imageView.pin(to: artboard)

        placeholder.axis = .vertical
        placeholder.alignment = .leading
        placeholder.spacing = 6
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholder.addArrangedSubview(eyebrow)
        placeholder.addArrangedSubview(titleLabel)
        placeholder.addArrangedSubview(UIView.spacer())
        placeholder.addArrangedSubview(slotHint)
        artboard.addSubview(placeholder)
        placeholder.pin(to: artboard, insets: UIEdgeInsets(top: 14, left: 12, bottom: 14, right: 12))

        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        badge.layer.cornerRadius = 12
        badgeSpinner.color = .white
        badgeSpinner.transform = CGAffineTransform(scaleX: 0.65, y: 0.65)
        let badgeRow = UIStackView.h([badgeSpinner, badgeLabel], spacing: 2)
        badge.addSubview(badgeRow)
        badgeRow.pin(to: badge, insets: UIEdgeInsets(top: 3, left: 4, bottom: 3, right: 9))
        artboard.addSubview(badge)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: artboard.leadingAnchor, constant: 8),
            badge.bottomAnchor.constraint(equalTo: artboard.bottomAnchor, constant: -8),
            badge.trailingAnchor.constraint(lessThanOrEqualTo: artboard.trailingAnchor, constant: -8),
        ])

        stateLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let meta = UIStackView.h([dateLabel, UIView.spacer(), dot, stateLabel], spacing: 5)
        let stack = UIStackView.v([artboard, meta], spacing: 7)
        contentView.addSubview(stack)
        stack.pin(to: contentView)
        artboard.heightAnchor.constraint(equalTo: artboard.widthAnchor, multiplier: 5.0 / 4.0).isActive = true

        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(card: PostCard, images: IOSImageStore, job: Job?, upload: Double?) {
        imageView.store = images
        let rendered = card.renderedAssetIds.first
        let showImage = rendered != nil && !card.needsImage
        if showImage { imageView.assetId = rendered }
        imageView.isHidden = !showImage
        placeholder.isHidden = showImage
        artboard.layer.borderWidth = showImage ? 0 : 1
        artboard.layer.borderColor = IOSTheme.border.cgColor
        switch card.placeholderTone {
        case .light: artboard.backgroundColor = IOSTheme.postLight
        case .dark: artboard.backgroundColor = IOSTheme.postDark
        case .muted: artboard.backgroundColor = IOSTheme.postMuted
        }
        let ink: UIColor = card.placeholderTone == .dark ? .white : (card.placeholderTone == .light ? .black : IOSTheme.textPrimary)
        eyebrow.text = card.eyebrow
        eyebrow.isHidden = card.eyebrow == nil
        titleLabel.text = TurkishFormat.upper(card.title)
        titleLabel.textColor = ink
        slotHint.isHidden = !card.needsImage

        var badgeText: String?
        if let upload {
            badgeText = upload >= 1 ? "Yerleştiriliyor" : "Yükleniyor %\(Int(upload * 100))"
        } else if let job {
            badgeText = job.type == .contentRender ? "Render ediliyor" : (job.status == .queued ? "Sırada" : "Üretiliyor")
        } else if card.state == .generating {
            badgeText = "Üretiliyor"
        }
        badge.isHidden = badgeText == nil
        badgeLabel.text = badgeText
        badgeText == nil ? badgeSpinner.stopAnimating() : badgeSpinner.startAnimating()

        dateLabel.text = card.day.map(TurkishFormat.shortDay) ?? "Tarih yok"
        dot.dotColor = card.state.tone.uiColor
        stateLabel.text = card.state.label
        accessibilityLabel = "\(card.title), \(card.day.map(TurkishFormat.longDay) ?? "tarih yok"), \(card.state.label)\(badgeText.map { ", \($0)" } ?? "")"
        accessibilityHint = "Postu açar. Daha fazla işlem için basılı tut."
    }
}
