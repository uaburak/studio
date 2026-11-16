import Foundation
import Observation
import StudioKit
import UIKit

@MainActor
@Observable
final class IOSPostsModel {
    weak var app: IOSAppModel?
    var month = MonthKey(Date())
    var filter: PostFilter = .all
    private(set) var board = PostBoard(cards: [])
    private(set) var isLoading = false
    private(set) var isApproving = false
    var error: String?
    private var versions: [EntityID: ContentVersion] = [:]
    private var loadedBrandId: EntityID?

    var brandId: EntityID? { app?.currentBrandId }
    var monthCards: [PostCard] { board.cards(in: month) }
    var visibleCards: [PostCard] { monthCards.filter { filter.matches($0.state) } }
    var counts: [PostFilter: Int] { PostBoard.counts(monthCards) }
    var approvable: [PostCard] { PostBoard.approvable(monthCards) }

    func card(_ id: EntityID) -> PostCard? { board.cards.first { $0.id == id } }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let contents = app.dataService.contents(brandId: brandId)
            async let plans = app.dataService.plans(brandId: brandId)
            async let schedules = app.dataService.schedules(brandId: brandId)
            async let jobs = app.dataService.jobs(brandId: brandId)
            let loadedContents = try await contents
            let loadedPlans = try await plans
            let loadedSchedules = try await schedules
            let loadedJobs = (try? await jobs) ?? []

            await withTaskGroup(of: ContentVersion?.self) { group in
                for item in loadedContents {
                    guard let ref = item.currentVersion, versions[item.id]?.id != ref.id else { continue }
                    group.addTask { try? await app.dataService.version(contentId: item.id, version: ref.version) }
                }
                for await v in group {
                    if let v { versions[v.contentId] = v }
                }
            }

            board = PostBoard(
                contents: loadedContents,
                versions: versions,
                plans: loadedPlans,
                schedules: loadedSchedules,
                jobs: loadedJobs
            )

            if loadedBrandId != brandId {
                loadedBrandId = brandId
                let months = board.months()
                if !months.contains(month), let nearest = months.min(by: {
                    abs(($0.year - month.year) * 12 + ($0.month - month.month)) < abs(($1.year - month.year) * 12 + ($1.month - month.month))
                }) {
                    month = nearest
                }
            }
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func approveAllReady() async {
        guard let app, !isApproving else { return }
        isApproving = true
        defer { isApproving = false }
        for item in approvable {
            guard let hash = item.approvableHash else { continue }
            _ = try? await app.dataService.approve(contentId: item.id, hash: hash)
        }
        await load()
    }
}

/// 2-column 4:5 Postlar grid (`100% Pure UIKit`).
final class IOSPostsViewController: UIViewController {
    private unowned let app: IOSAppModel
    private var model: IOSPostsModel { app.posts }

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let monthLabel = UILabel.studio("", size: 24, weight: .bold)
    private let filterScroll = UIScrollView()
    private let filterStack = UIStackView()
    private let gridStack = UIStackView()
    private let approveBar = UIView()
    private let approveLabel = UILabel.studio("", size: 13, weight: .semibold)

    private var navToken: IOSObservationToken?
    private var observation: IOSObservationToken?
    private var lastBrandId: EntityID?

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

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.axis = .vertical
        contentStack.spacing = 16
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        // Month header with < >
        let prevBtn = UIButton(type: .system, primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            self.model.month = self.model.month.previous
        })
        prevBtn.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        let nextBtn = UIButton(type: .system, primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            self.model.month = self.model.month.next
        })
        nextBtn.setImage(UIImage(systemName: "chevron.right"), for: .normal)
        let monthRow = UIStackView(arrangedSubviews: [monthLabel, UIView(), prevBtn, nextBtn])
        monthRow.axis = .horizontal
        monthRow.alignment = .center
        monthRow.spacing = 12

        filterScroll.showsHorizontalScrollIndicator = false
        filterScroll.translatesAutoresizingMaskIntoConstraints = false
        filterScroll.heightAnchor.constraint(equalToConstant: 36).isActive = true
        filterStack.axis = .horizontal
        filterStack.spacing = 8
        filterStack.translatesAutoresizingMaskIntoConstraints = false
        filterScroll.addSubview(filterStack)
        NSLayoutConstraint.activate([
            filterStack.leadingAnchor.constraint(equalTo: filterScroll.contentLayoutGuide.leadingAnchor),
            filterStack.trailingAnchor.constraint(equalTo: filterScroll.contentLayoutGuide.trailingAnchor),
            filterStack.centerYAnchor.constraint(equalTo: filterScroll.frameLayoutGuide.centerYAnchor),
        ])

        gridStack.axis = .vertical
        gridStack.spacing = 14

        contentStack.addArrangedSubview(monthRow)
        contentStack.addArrangedSubview(filterScroll)
        contentStack.addArrangedSubview(gridStack)

        // Floating batch approve bar
        approveBar.translatesAutoresizingMaskIntoConstraints = false
        approveBar.backgroundColor = IOSTheme.fillStrong
        approveBar.layer.cornerRadius = 22
        approveBar.isHidden = true
        let approveAllBtn = UIButton.studioPill(title: "Tümünü Onayla", primary: true) { [weak self] in
            guard let self else { return }
            Task { await self.model.approveAllReady() }
        }
        let barRow = UIStackView(arrangedSubviews: [approveLabel, UIView(), approveAllBtn])
        barRow.axis = .horizontal
        barRow.alignment = .center
        barRow.spacing = 12
        barRow.translatesAutoresizingMaskIntoConstraints = false
        approveBar.addSubview(barRow)

        view.addSubview(scrollView)
        view.addSubview(approveBar)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -16),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 12),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -84),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -32),

            approveBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            approveBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            approveBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            barRow.leadingAnchor.constraint(equalTo: approveBar.leadingAnchor, constant: 16),
            barRow.trailingAnchor.constraint(equalTo: approveBar.trailingAnchor, constant: -8),
            barRow.topAnchor.constraint(equalTo: approveBar.topAnchor, constant: 8),
            barRow.bottomAnchor.constraint(equalTo: approveBar.bottomAnchor, constant: -8),
        ])

        observation = observeIOS { [weak self] in
            self?.render()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await model.load() }
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }

        monthLabel.text = "\(TurkishFormat.monthName(model.month)) \(model.month.year)"

        // Filter pills
        filterStack.arrangedSubviews.forEach {
            filterStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let counts = model.counts
        for f in PostFilter.allCases {
            let btn = UIButton.studioPill(
                title: "\(f.label) (\(counts[f] ?? 0))",
                primary: f == model.filter
            ) { [weak self] in
                self?.model.filter = f
            }
            filterStack.addArrangedSubview(btn)
        }

        // 2-column 4:5 grid
        gridStack.arrangedSubviews.forEach {
            gridStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let cards = model.visibleCards
        if cards.isEmpty && !model.isLoading {
            gridStack.addArrangedSubview(UILabel.studio("Bu filtrede post yok.", size: 14, color: IOSTheme.textSecondary))
        } else {
            var index = 0
            while index < cards.count {
                let row = UIStackView()
                row.axis = .horizontal
                row.distribution = .fillEqually
                row.spacing = 12
                row.addArrangedSubview(makePostGridCell(cards[index]))
                if index + 1 < cards.count {
                    row.addArrangedSubview(makePostGridCell(cards[index + 1]))
                } else {
                    row.addArrangedSubview(UIView())
                }
                gridStack.addArrangedSubview(row)
                index += 2
            }
        }

        let readyCount = model.approvable.count
        approveBar.isHidden = readyCount == 0
        approveLabel.text = "\(readyCount) post onaya hazır"
    }

    private func makePostGridCell(_ card: PostCard) -> UIView {
        let wrapper = UIStackView()
        wrapper.axis = .vertical
        wrapper.spacing = 6

        let artboard = UIControl()
        artboard.translatesAutoresizingMaskIntoConstraints = false
        artboard.layer.cornerRadius = 16
        artboard.layer.cornerCurve = .continuous
        artboard.clipsToBounds = true
        artboard.heightAnchor.constraint(equalTo: artboard.widthAnchor, multiplier: 5.0 / 4.0).isActive = true

        if let rendered = card.renderedAssetIds.first, !card.needsImage {
            let iv = IOSAssetImageView(store: app.images, assetId: rendered, cornerRadius: 16)
            iv.isUserInteractionEnabled = false
            artboard.addSubview(iv)
            NSLayoutConstraint.activate([
                iv.leadingAnchor.constraint(equalTo: artboard.leadingAnchor),
                iv.trailingAnchor.constraint(equalTo: artboard.trailingAnchor),
                iv.topAnchor.constraint(equalTo: artboard.topAnchor),
                iv.bottomAnchor.constraint(equalTo: artboard.bottomAnchor),
            ])
        } else {
            artboard.backgroundColor = card.placeholderTone == .light ? IOSTheme.postLight : (card.placeholderTone == .dark ? IOSTheme.postDark : IOSTheme.postMuted)
            artboard.layer.borderWidth = 1
            artboard.layer.borderColor = IOSTheme.border.cgColor
            let fg: UIColor = card.placeholderTone == .dark ? .white : (card.placeholderTone == .light ? .black : IOSTheme.textPrimary)

            let inner = UIStackView()
            inner.axis = .vertical
            inner.alignment = .leading
            inner.spacing = 6
            inner.isUserInteractionEnabled = false
            inner.translatesAutoresizingMaskIntoConstraints = false

            if let eyebrow = card.eyebrow {
                inner.addArrangedSubview(UILabel.studio(eyebrow, size: 10, weight: .bold, color: IOSTheme.accent))
            }
            inner.addArrangedSubview(UILabel.studio(TurkishFormat.upper(card.title), size: 16, weight: .heavy, color: fg, lines: 3))
            inner.addArrangedSubview(UIView())
            if card.needsImage {
                inner.addArrangedSubview(UILabel.studio("+ Fotoğraf ekle", size: 11, weight: .semibold, color: IOSTheme.accent))
            }
            artboard.addSubview(inner)
            NSLayoutConstraint.activate([
                inner.leadingAnchor.constraint(equalTo: artboard.leadingAnchor, constant: 12),
                inner.trailingAnchor.constraint(equalTo: artboard.trailingAnchor, constant: -12),
                inner.topAnchor.constraint(equalTo: artboard.topAnchor, constant: 14),
                inner.bottomAnchor.constraint(equalTo: artboard.bottomAnchor, constant: -14),
            ])
        }

        artboard.addAction(UIAction { [weak self] _ in
            self?.openDetail(for: card)
        }, for: .touchUpInside)

        let dateText = card.day.map(TurkishFormat.shortDay) ?? "Tarih yok"
        let dot = IOSStatusDotView(color: card.state.tone.uiColor, size: 6)
        let metaRow = UIStackView(arrangedSubviews: [
            UILabel.studio(dateText, size: 12, weight: .medium),
            UIView(),
            dot,
            UILabel.studio(card.state.label, size: 11, color: IOSTheme.textSecondary),
        ])
        metaRow.axis = .horizontal
        metaRow.alignment = .center
        metaRow.spacing = 5

        wrapper.addArrangedSubview(artboard)
        wrapper.addArrangedSubview(metaRow)
        return wrapper
    }

    private func openDetail(for card: PostCard) {
        let detailModel = IOSPostDetailModel(app: app, card: card)
        let vc = IOSPostDetailViewController(model: detailModel)
        vc.hidesBottomBarWhenPushed = true
        navigationController?.pushViewController(vc, animated: true)
    }
}
