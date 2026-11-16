import Foundation
import Observation
import StudioKit
import UIKit

@MainActor
@Observable
final class IOSCalendarModel {
    struct DaySection: Equatable {
        var day: CalendarDay
        var items: [ScheduleItem]
    }

    struct ScheduleItem: Identifiable, Equatable {
        var id: EntityID
        var schedule: Schedule
        var title: String
        var accountHandle: String
    }

    weak var app: IOSAppModel?
    private(set) var schedules: [Schedule] = []
    private(set) var contents: [Content] = []
    private(set) var isLoading = false
    var error: String?

    var brandId: EntityID? { app?.currentBrandId }

    var groupedSchedules: [DaySection] {
        guard let app else { return [] }
        let contentById = Dictionary(uniqueKeysWithValues: contents.map { ($0.id, $0) })
        let accountById = Dictionary(uniqueKeysWithValues: app.accounts(of: brandId).map { ($0.id, $0) })

        let items: [ScheduleItem] = schedules
            .filter { $0.status != .cancelled }
            .sorted { $0.scheduledAt < $1.scheduledAt }
            .map { sch in
                ScheduleItem(
                    id: sch.id,
                    schedule: sch,
                    title: contentById[sch.contentId]?.title ?? "Post",
                    accountHandle: accountById[sch.socialAccountId]?.handle ?? sch.platform.displayName
                )
            }

        let grouped = Dictionary(grouping: items, by: { CalendarDay($0.schedule.scheduledAt) })
        return grouped.keys.sorted().map { day in
            DaySection(day: day, items: grouped[day] ?? [])
        }
    }

    var activeAndRecentJobs: [Job] {
        guard let app else { return [] }
        return app.jobBoard.jobs.filter { brandId == nil || $0.brandId == brandId || $0.brandId == nil }
    }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let sch = app.dataService.schedules(brandId: brandId)
            async let cnt = app.dataService.contents(brandId: brandId)
            schedules = try await sch
            contents = try await cnt
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func cancelSchedule(_ id: EntityID) async {
        guard let app else { return }
        do {
            _ = try await app.dataService.cancelSchedule(id)
            await load()
            await app.posts.load()
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func cancelJob(_ id: EntityID) async {
        guard let app else { return }
        _ = try? await app.dataService.cancelJob(id)
    }
}

/// Takvim ve Arka Plan İşleri (`100% Pure UIKit`).
final class IOSCalendarViewController: UIViewController {
    private unowned let app: IOSAppModel
    private var model: IOSCalendarModel { app.calendar }

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let schedulesStack = UIStackView()
    private let jobsStack = UIStackView()

    private var navToken: IOSObservationToken?
    private var observation: IOSObservationToken?
    private var lastBrandId: EntityID?

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        title = "Takvim"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navToken = StudioNavBarItems.install(on: self, app: app)

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.axis = .vertical
        contentStack.spacing = 18
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)
        view.addSubview(scrollView)

        schedulesStack.axis = .vertical
        schedulesStack.spacing = 12
        jobsStack.axis = .vertical
        jobsStack.spacing = 10

        contentStack.addArrangedSubview(UILabel.studio("Yayın Programı", size: 22, weight: .bold))
        contentStack.addArrangedSubview(schedulesStack)
        contentStack.addArrangedSubview(UILabel.studio("Arka Plan İşleri", size: 20, weight: .bold))
        contentStack.addArrangedSubview(jobsStack)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -16),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 14),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -32),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -32),
        ])

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            Task {
                await self.model.load()
                refresh.endRefreshing()
            }
        }, for: .valueChanged)
        scrollView.refreshControl = refresh

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

        schedulesStack.arrangedSubviews.forEach {
            schedulesStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        let sections = model.groupedSchedules
        if sections.isEmpty {
            let empty = IOSCardView(padding: 16, spacing: 6)
            empty.stack.addArrangedSubview(UILabel.studio("Henüz zamanlanmış paylaşım yok.", size: 14, color: IOSTheme.textSecondary))
            schedulesStack.addArrangedSubview(empty)
        } else {
            let timeFmt = DateFormatter()
            timeFmt.locale = TurkishFormat.locale
            timeFmt.dateFormat = "HH:mm"

            for section in sections {
                schedulesStack.addArrangedSubview(UILabel.studio(TurkishFormat.longDay(section.day), size: 14, weight: .semibold, color: IOSTheme.textSecondary))
                for item in section.items {
                    let card = IOSCardView(padding: 14, spacing: 8)
                    let dotColor: UIColor = switch item.schedule.status {
                    case .pending, .publishing: IOSTheme.accent
                    case .published: IOSTheme.ink
                    case .failed: .systemRed
                    default: IOSTheme.textTertiary
                    }
                    let statusText: String = switch item.schedule.status {
                    case .pending: "Zamanlandı"
                    case .publishing: "Yayınlanıyor"
                    case .published: "Yayınlandı"
                    case .failed: "Hata"
                    default: item.schedule.status.rawValue
                    }

                    let topRow = UIStackView(arrangedSubviews: [
                        IOSStatusDotView(color: dotColor, size: 8),
                        UILabel.studio(timeFmt.string(from: item.schedule.scheduledAt), size: 13, weight: .semibold, color: IOSTheme.textSecondary),
                        UILabel.studio(item.title, size: 15, weight: .semibold),
                        UIView(),
                    ])
                    topRow.axis = .horizontal
                    topRow.alignment = .center
                    topRow.spacing = 8

                    let sub = UILabel.studio(
                        "\(item.schedule.platform.displayName) · \(item.accountHandle) · \(statusText)",
                        size: 12,
                        color: IOSTheme.textSecondary
                    )
                    card.stack.addArrangedSubview(topRow)
                    card.stack.addArrangedSubview(sub)

                    var actions: [UIView] = []
                    if let link = item.schedule.permalink, let url = URL(string: link) {
                        actions.append(UIButton.studioPill(title: "Yayını Aç ↗") {
                            UIApplication.shared.open(url)
                        })
                    }
                    if item.schedule.status.isActive {
                        actions.append(UIButton.studioPill(title: "Zamanlamayı İptal Et") { [weak self] in
                            guard let self else { return }
                            Task { await self.model.cancelSchedule(item.id) }
                        })
                    }
                    if !actions.isEmpty {
                        actions.append(UIView())
                        let actionRow = UIStackView(arrangedSubviews: actions)
                        actionRow.axis = .horizontal
                        actionRow.spacing = 8
                        card.stack.addArrangedSubview(actionRow)
                    }
                    schedulesStack.addArrangedSubview(card)
                }
            }
        }

        // Background job queue
        jobsStack.arrangedSubviews.forEach {
            jobsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let jobs = model.activeAndRecentJobs.prefix(8)
        if jobs.isEmpty {
            let empty = IOSCardView(padding: 14, spacing: 6)
            empty.stack.addArrangedSubview(UILabel.studio("Şu an arka planda iş yok.", size: 14, color: IOSTheme.textSecondary))
            jobsStack.addArrangedSubview(empty)
        } else {
            for job in jobs {
                let card = IOSCardView(padding: 12, spacing: 6)
                let dotColor: UIColor = job.status.isActive ? IOSTheme.accent : (job.status == .failed ? .systemRed : IOSTheme.textTertiary)
                let statusWord: String = switch job.status {
                case .queued: "Sırada"
                case .running: job.progressMessage ?? "Çalışıyor"
                case .succeeded: "Bitti"
                case .failed: "Hata"
                case .cancelled: "İptal"
                case .unknown: job.status.rawValue
                }
                let row = UIStackView(arrangedSubviews: [
                    IOSStatusDotView(color: dotColor, size: 7),
                    UILabel.studio(job.displayTitle, size: 14, weight: .medium),
                    UIView(),
                    UILabel.studio(statusWord, size: 12, color: IOSTheme.textSecondary),
                ])
                row.axis = .horizontal
                row.alignment = .center
                row.spacing = 8
                card.stack.addArrangedSubview(row)

                if job.status.isActive {
                    let cancelBtn = UIButton.studioPill(title: "İşi İptal Et") { [weak self] in
                        guard let self else { return }
                        Task { await self.model.cancelJob(job.id) }
                    }
                    let btnRow = UIStackView(arrangedSubviews: [cancelBtn, UIView()])
                    btnRow.axis = .horizontal
                    card.stack.addArrangedSubview(btnRow)
                }
                jobsStack.addArrangedSubview(card)
            }
        }
    }
}
