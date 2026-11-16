import Foundation
import Observation
import StudioKit
import UIKit

/// Takvim: a brand's schedules and dated posts by month (shared logic: `CalendarAgenda`).
@MainActor
@Observable
final class IOSCalendarModel {
    enum Mode: Int { case month, list }

    weak var app: IOSAppModel?
    var month = MonthKey(Date())
    var selectedDay: CalendarDay? = CalendarDay(Date())
    var mode: Mode = .month
    private(set) var schedules: [Schedule] = []
    private(set) var contents: [Content] = []
    private(set) var isLoading = false
    private(set) var busyIds: Set<EntityID> = []
    var error: String?
    @ObservationIgnored private var loadedBrandId: EntityID?

    var brandId: EntityID? { app?.currentBrandId }

    func reset() {
        schedules = []
        contents = []
        loadedBrandId = nil
        error = nil
    }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let loadedSchedules = app.dataService.schedules(brandId: brandId)
            async let loadedContents = app.dataService.contents(brandId: brandId)
            let fetchedSchedules = try await loadedSchedules
            let fetchedContents = try await loadedContents
            guard brandId == self.brandId else { return }
            schedules = fetchedSchedules
            contents = fetchedContents
            if app.posts.loadedBrandId != brandId { await app.posts.load() }
            if loadedBrandId != brandId {
                loadedBrandId = brandId
                let months = CalendarAgenda.months(entries)
                if !months.contains(month), let nearest = months.min(by: { abs($0.distance(to: month)) < abs($1.distance(to: month)) }) {
                    month = nearest
                    selectedDay = entries.filter { $0.day.monthKey == nearest }.map(\.day).min()
                }
            }
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    var entries: [CalendarEntry] {
        guard let app else { return [] }
        return CalendarAgenda.entries(schedules: schedules, contents: contents, accounts: app.accounts(of: brandId), cards: app.posts.board.cards)
    }

    var monthEntries: [CalendarEntry] { entries.filter { $0.day.monthKey == month } }

    func entries(on day: CalendarDay) -> [CalendarEntry] { monthEntries.filter { $0.day == day } }

    /// Sections the list shows: the selected day in month mode, every day in list mode.
    var listedDays: [(day: CalendarDay, entries: [CalendarEntry])] {
        let source = mode == .month ? (selectedDay.map(entries(on:)) ?? []) : monthEntries
        let grouped = Dictionary(grouping: source, by: \.day)
        return grouped.keys.sorted().map { ($0, grouped[$0] ?? []) }
    }

    func showPrevious() {
        month = month.previous
        selectedDay = CalendarDay(year: month.year, month: month.month, day: 1)
    }

    func showNext() {
        month = month.next
        selectedDay = CalendarDay(year: month.year, month: month.month, day: 1)
    }

    func goToday() {
        let today = CalendarDay(Date())
        month = today.monthKey
        selectedDay = today
    }

    func cancel(_ entry: CalendarEntry) async {
        guard let app, let id = entry.scheduleId else { return }
        busyIds.insert(id)
        defer { busyIds.remove(id) }
        do {
            _ = try await app.dataService.cancelSchedule(id)
            await load()
            await app.posts.load()
            Haptics.success()
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func reschedule(_ entry: CalendarEntry, to date: Date) async {
        guard let app, let schedule = entry.schedule else { return }
        busyIds.insert(schedule.id)
        defer { busyIds.remove(schedule.id) }
        do {
            _ = try await app.dataService.moveSchedule(schedule, to: date)
            await load()
            await app.posts.load()
            selectedDay = CalendarDay(date)
            month = CalendarDay(date).monthKey
            Haptics.success()
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }
}

/// Month grid (or list) with the day's schedules; reschedule, cancel, open the post.
final class IOSCalendarViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private unowned let app: IOSAppModel
    private var model: IOSCalendarModel { app.calendar }
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let grid = MonthGridView()
    private let modeControl = UISegmentedControl(items: ["Ay", "Liste"])
    private let headerContainer = UIView()
    private var sections: [(day: CalendarDay, entries: [CalendarEntry])] = []
    private var navToken: IOSObservationToken?
    private var observation: IOSObservationToken?
    private var lastBrandId: EntityID?
    private var lastError: String?

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        title = "Takvim"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        let today = UIBarButtonItem(title: "Bugün", primaryAction: UIAction { [weak self] _ in self?.model.goToday() })
        navToken = StudioNavBarItems.install(on: self, app: app, extraRight: [today])

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "entry")
        view.addSubview(tableView)
        tableView.pin(to: view)

        modeControl.selectedSegmentIndex = 0
        modeControl.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.model.mode = IOSCalendarModel.Mode(rawValue: self.modeControl.selectedSegmentIndex) ?? .month
            Haptics.selection()
        }, for: .valueChanged)
        grid.onPrevious = { [weak self] in self?.model.showPrevious() }
        grid.onNext = { [weak self] in self?.model.showNext() }
        grid.onSelect = { [weak self] day in
            self?.model.selectedDay = day
            Haptics.selection()
        }

        let header = UIStackView.v([modeControl, grid], spacing: 12)
        headerContainer.addSubview(header)
        header.pin(to: headerContainer, insets: UIEdgeInsets(top: 8, left: IOSTheme.gutter, bottom: 4, right: IOSTheme.gutter))

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            guard let self else { return }
            Task {
                await self.model.load()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        tableView.refreshControl = refresh

        observation = observeIOS { [weak self] in self?.render() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await model.load() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        sizeHeader()
    }

    private func sizeHeader() {
        let width = tableView.bounds.width
        guard width > 0 else { return }
        let size = headerContainer.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        if headerContainer.frame.size != CGSize(width: width, height: size.height) || tableView.tableHeaderView == nil {
            headerContainer.frame = CGRect(x: 0, y: 0, width: width, height: size.height)
            tableView.tableHeaderView = headerContainer
        }
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }
        modeControl.selectedSegmentIndex = model.mode.rawValue
        let entries = model.monthEntries
        var dots: [CalendarDay: [CalendarEntry.Kind]] = [:]
        for entry in entries { dots[entry.day, default: []].append(entry.kind) }
        grid.configure(month: model.month, selected: model.mode == .month ? model.selectedDay : nil, dots: dots, loading: model.isLoading)
        sections = model.listedDays
        tableView.reloadData()
        sizeHeader()
        if let error = model.error, error != lastError {
            lastError = error
            Toast.show(error, in: view, isError: true)
        } else if model.error == nil {
            lastError = nil
        }
        _ = model.busyIds
    }

    // MARK: Table

    func numberOfSections(in tableView: UITableView) -> Int { max(1, sections.count) }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        sections.isEmpty ? 1 : sections[section].entries.count
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        guard !sections.isEmpty else { return model.mode == .month ? model.selectedDay.map(TurkishFormat.longDay) : nil }
        return TurkishFormat.longDay(sections[section].day)
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "entry", for: indexPath)
        cell.backgroundColor = IOSTheme.elevated
        guard !sections.isEmpty else {
            var content = UIListContentConfiguration.cell()
            content.text = app.connection == .notPaired ? "Mac'e bağlı değil." : (model.mode == .month ? "Bu gün boş." : "Bu ayda zamanlanmış post yok.")
            content.secondaryText = "Postu açıp Zamanla ile takvime ekle."
            content.textProperties.color = IOSTheme.textSecondary
            content.secondaryTextProperties.color = IOSTheme.textTertiary
            cell.contentConfiguration = content
            cell.accessoryType = .none
            cell.selectionStyle = .none
            return cell
        }
        let entry = sections[indexPath.section].entries[indexPath.row]
        var content = UIListContentConfiguration.subtitleCell()
        content.text = entry.title
        content.textProperties.font = IOSTheme.font(16, .medium)
        let account = entry.accountHandle.map { " · \($0)" } ?? ""
        content.secondaryText = "\(entry.timeText) · \(entry.platformText)\(account) · \(entry.statusLabel)"
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        content.secondaryTextProperties.font = IOSTheme.font(13, style: .footnote)
        content.image = UIImage(systemName: "circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9))
        content.imageProperties.tintColor = Self.color(entry.kind)
        content.imageProperties.reservedLayoutSize = CGSize(width: 18, height: 18)
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.selectionStyle = .default
        if let id = entry.scheduleId, model.busyIds.contains(id) {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            cell.accessoryView = spinner
        } else {
            cell.accessoryView = nil
        }
        cell.accessibilityLabel = "\(entry.title), \(entry.timeText), \(entry.platformText), \(entry.statusLabel)"
        return cell
    }

    static func color(_ kind: CalendarEntry.Kind) -> UIColor {
        switch kind {
        case .scheduled, .publishing: IOSTheme.accent
        case .published: IOSTheme.ink
        case .failed: IOSTheme.accent
        case .approved: IOSTheme.textSecondary
        case .planned: IOSTheme.textTertiary
        }
    }

    private func entry(at indexPath: IndexPath) -> CalendarEntry? {
        guard !sections.isEmpty, sections.indices.contains(indexPath.section), sections[indexPath.section].entries.indices.contains(indexPath.row) else { return nil }
        return sections[indexPath.section].entries[indexPath.row]
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let entry = entry(at: indexPath) else { return }
        openPost(entry.contentId)
    }

    private func openPost(_ contentId: EntityID) {
        Task {
            if app.posts.card(contentId) == nil { await app.posts.load() }
            guard let card = app.posts.card(contentId) else { return presentError("Post bulunamadı.") }
            navigationController?.pushViewController(IOSPostDetailViewController(app: app, card: card), animated: true)
        }
    }

    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let entry = entry(at: indexPath), entry.canCancel else { return nil }
        let cancel = UIContextualAction(style: .destructive, title: "İptal") { [weak self] _, _, done in
            self?.confirmCancel(entry)
            done(true)
        }
        let move = UIContextualAction(style: .normal, title: "Taşı") { [weak self] _, _, done in
            self?.presentReschedule(entry)
            done(true)
        }
        move.backgroundColor = IOSTheme.textSecondary
        return UISwipeActionsConfiguration(actions: [cancel, move])
    }

    func tableView(_ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard let entry = entry(at: indexPath) else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            var actions: [UIMenuElement] = [UIAction(title: "Postu aç", image: UIImage(systemName: "square.grid.2x2")) { _ in self.openPost(entry.contentId) }]
            if entry.canReschedule {
                actions.append(UIAction(title: "Zamanı değiştir", image: UIImage(systemName: "calendar.badge.clock")) { _ in self.presentReschedule(entry) })
            }
            if let link = entry.permalink, let url = URL(string: link) {
                actions.append(UIAction(title: "Yayını aç", image: UIImage(systemName: "arrow.up.right.square")) { _ in UIApplication.shared.open(url) })
            }
            if entry.canCancel {
                actions.append(UIAction(title: "Zamanlamayı iptal et", image: UIImage(systemName: "xmark.circle"), attributes: .destructive) { _ in self.confirmCancel(entry) })
            }
            return UIMenu(children: actions)
        }
    }

    private func confirmCancel(_ entry: CalendarEntry) {
        confirm("Zamanlama iptal edilsin mi?", message: "\(entry.title) · \(entry.timeText). Post onaylı kalır.", action: "İptal et") { [weak self] in
            guard let self else { return }
            Task { await self.model.cancel(entry) }
        }
    }

    private func presentReschedule(_ entry: CalendarEntry) {
        let picker = RescheduleViewController(entry: entry) { [weak self] date in
            guard let self else { return }
            Task { await self.model.reschedule(entry, to: date) }
        }
        presentSheet(picker, detents: [.large()])
    }
}

/// Monday-first month grid with status dots.
final class MonthGridView: UIView {
    var onPrevious: (() -> Void)?
    var onNext: (() -> Void)?
    var onSelect: ((CalendarDay) -> Void)?
    private let titleLabel = UILabel.studio("", size: 20, weight: .bold, style: .title3)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let rows = UIStackView.v([], spacing: 2)
    private var rendered: (MonthKey, CalendarDay?, [CalendarDay: [CalendarEntry.Kind]])?

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        titleLabel.accessibilityTraits = .header
        spinner.hidesWhenStopped = true
        let previous = UIButton.studioIcon("chevron.left", label: "Önceki ay") { [weak self] in self?.onPrevious?() }
        let next = UIButton.studioIcon("chevron.right", label: "Sonraki ay") { [weak self] in self?.onNext?() }
        let header = UIStackView.h([titleLabel, spinner, UIView.spacer(), previous, next], spacing: 4)
        let weekdays = UIStackView.h(CalendarAgenda.weekdaySymbols.map { symbol in
            let label = UILabel.studio(symbol, size: 12, weight: .medium, color: IOSTheme.textTertiary, style: .caption1)
            label.textAlignment = .center
            return label
        }, spacing: 0)
        weekdays.distribution = .fillEqually
        let card = IOSCardView(padding: 10, spacing: 6)
        card.stack.addArrangedSubview(weekdays)
        card.stack.addArrangedSubview(rows)
        let stack = UIStackView.v([header, card], spacing: 8)
        addSubview(stack)
        stack.pin(to: self)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(month: MonthKey, selected: CalendarDay?, dots: [CalendarDay: [CalendarEntry.Kind]], loading: Bool) {
        titleLabel.text = TurkishFormat.monthTitle(month, currentYear: CalendarDay(Date()).year)
        loading ? spinner.startAnimating() : spinner.stopAnimating()
        if let rendered, rendered.0 == month, rendered.1 == selected, rendered.2 == dots { return }
        rendered = (month, selected, dots)
        rows.removeAllArranged()
        let cells = CalendarAgenda.monthGrid(month)
        let today = CalendarDay(Date())
        for week in stride(from: 0, to: cells.count, by: 7) {
            let row = UIStackView.h(cells[week..<min(week + 7, cells.count)].map { dayCell($0, selected: selected, today: today, kinds: $0.flatMap { dots[$0] } ?? []) }, spacing: 2)
            row.distribution = .fillEqually
            rows.addArrangedSubview(row)
        }
    }

    private func dayCell(_ day: CalendarDay?, selected: CalendarDay?, today: CalendarDay, kinds: [CalendarEntry.Kind]) -> UIView {
        let control = UIControl()
        control.translatesAutoresizingMaskIntoConstraints = false
        control.heightAnchor.constraint(equalToConstant: 46).isActive = true
        guard let day else { return control }
        let isSelected = day == selected
        let isToday = day == today
        let number = UILabel.studio("\(day.day)", size: 15, weight: isToday || isSelected ? .bold : .regular, color: isSelected ? IOSTheme.onInk : (isToday ? IOSTheme.accent : IOSTheme.textPrimary), style: .subheadline)
        number.textAlignment = .center
        let circle = UIView()
        circle.translatesAutoresizingMaskIntoConstraints = false
        circle.backgroundColor = isSelected ? IOSTheme.ink : .clear
        circle.layer.cornerRadius = 15
        circle.isUserInteractionEnabled = false
        circle.addSubview(number)
        number.pin(to: circle)
        let dotRow = UIStackView.h(Array(kinds.prefix(3)).map { IOSStatusDotView(color: IOSCalendarViewController.color($0), size: 5) }, spacing: 3)
        dotRow.isUserInteractionEnabled = false
        control.addSubview(circle)
        control.addSubview(dotRow)
        NSLayoutConstraint.activate([
            circle.centerXAnchor.constraint(equalTo: control.centerXAnchor),
            circle.topAnchor.constraint(equalTo: control.topAnchor, constant: 2),
            circle.widthAnchor.constraint(equalToConstant: 30),
            circle.heightAnchor.constraint(equalToConstant: 30),
            dotRow.centerXAnchor.constraint(equalTo: control.centerXAnchor),
            dotRow.topAnchor.constraint(equalTo: circle.bottomAnchor, constant: 4),
            dotRow.heightAnchor.constraint(equalToConstant: 5),
        ])
        control.addAction(UIAction { [weak self] _ in self?.onSelect?(day) }, for: .touchUpInside)
        control.isAccessibilityElement = true
        control.accessibilityLabel = "\(TurkishFormat.longDay(day))\(kinds.isEmpty ? "" : ", \(kinds.count) gönderi")"
        control.accessibilityTraits = isSelected ? [.button, .selected] : .button
        return control
    }
}

/// Pick a new time for a pending schedule.
final class RescheduleViewController: UIViewController {
    private let entry: CalendarEntry
    private let onPick: (Date) -> Void
    private let picker = UIDatePicker()

    init(entry: CalendarEntry, onPick: @escaping (Date) -> Void) {
        self.entry = entry
        self.onPick = onPick
        super.init(nibName: nil, bundle: nil)
        title = "Zamanı değiştir"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        let save = UIBarButtonItem(title: "Taşı", primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            self.onPick(self.picker.date)
            self.dismiss(animated: true)
        })
        save.style = .prominent
        save.tintColor = IOSTheme.accent
        navigationItem.rightBarButtonItem = save
        picker.datePickerMode = .dateAndTime
        picker.preferredDatePickerStyle = .inline
        picker.locale = TurkishFormat.locale
        picker.minuteInterval = 5
        picker.minimumDate = Date().addingTimeInterval(5 * 60)
        picker.date = max(entry.date, Date().addingTimeInterval(10 * 60))
        picker.tintColor = IOSTheme.accent
        let title = UILabel.studio(entry.title, size: 17, weight: .semibold, lines: 2, style: .headline)
        let detail = UILabel.studio("\(entry.platformText)\(entry.accountHandle.map { " · \($0)" } ?? "") · şu an \(TurkishFormat.dayAndTime(entry.date))", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
        let stack = UIStackView.v([title, detail, picker], spacing: 8)
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -IOSTheme.gutter),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
        ])
    }
}
