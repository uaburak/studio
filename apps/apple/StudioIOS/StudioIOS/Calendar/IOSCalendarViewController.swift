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

    /// Special days by date (as the Mac's month grid shows them), loaded per month.
    private(set) var specialDays: [CalendarDay: [String]] = [:]
    @ObservationIgnored private var specialMonths: Set<MonthKey> = []

    func loadSpecialDays(_ month: MonthKey) async {
        guard let app, !specialMonths.contains(month) else { return }
        specialMonths.insert(month)
        let first = CalendarDay(year: month.year, month: month.month, day: 1)
        let next = month.next
        let last = CalendarDay(Calendar(identifier: .gregorian).date(byAdding: .day, value: -1, to: CalendarDay(year: next.year, month: next.month, day: 1).date()) ?? Date())
        do {
            let days = try await app.dataService.specialDays(from: first.description, to: last.description)
            var found = specialDays
            for special in days {
                guard let start = CalendarDay(special.date) else { continue }
                for offset in 0..<max(special.days, 1) {
                    let date = Calendar(identifier: .gregorian).date(byAdding: .day, value: offset, to: start.date()) ?? start.date()
                    let day = CalendarDay(date)
                    if !(found[day]?.contains(special.name) ?? false) { found[day, default: []].append(special.name) }
                }
            }
            specialDays = found
        } catch {
            specialMonths.remove(month)
        }
    }

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

/// Month grid (or list) with the day's schedules; reschedule, cancel, open the post. The month
/// is the page's title (centred in the bar); the grid runs edge to edge in square days, as on the
/// Mac; the bottom toolbar moves between months and back to today.
final class IOSCalendarViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private unowned let app: IOSAppModel
    private var model: IOSCalendarModel { app.calendar }
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let grid = MonthGridView()
    private let modeItem = UIBarButtonItem()
    private let headerContainer = UIView()
    private var sections: [(day: CalendarDay, entries: [CalendarEntry])] = []
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
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never

        // Top right: month grid or the month's list.
        modeItem.primaryAction = UIAction { [weak self] _ in
            guard let self else { return }
            self.model.mode = self.model.mode == .month ? .list : .month
            Haptics.selection()
        }
        navigationItem.rightBarButtonItem = modeItem

        // Bottom toolbar: the months either side, today in the middle.
        let previous = UIBarButtonItem(image: UIImage(systemName: "chevron.left"), primaryAction: UIAction { [weak self] _ in self?.step(-1) })
        previous.accessibilityLabel = "Önceki ay"
        let next = UIBarButtonItem(image: UIImage(systemName: "chevron.right"), primaryAction: UIAction { [weak self] _ in self?.step(1) })
        next.accessibilityLabel = "Sonraki ay"
        let today = UIBarButtonItem(title: "Bugün", primaryAction: UIAction { [weak self] _ in
            self?.model.goToday()
            Haptics.selection()
        })
        setToolbarItems([previous, .flexibleSpace(), today, .flexibleSpace(), next], animated: false)

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = IOSTheme.canvas
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "entry")
        view.addSubview(tableView)
        tableView.pin(to: view)
        // The bar's soft edge at the top and the toolbar's at the bottom.
        setContentScrollView(tableView, for: [.top, .bottom])
        tableView.bottomEdgeEffect.style = .soft

        grid.onSelect = { [weak self] day in
            self?.model.selectedDay = day
            Haptics.selection()
        }
        grid.onSwipe = { [weak self] direction in self?.step(direction) }
        headerContainer.addSubview(grid)
        grid.pin(to: headerContainer, insets: UIEdgeInsets(top: 4, left: 0, bottom: 8, right: 0))

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

    private func step(_ direction: Int) {
        direction < 0 ? model.showPrevious() : model.showNext()
        Haptics.selection()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(false, animated: animated)
        Task { await model.load() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if navigationController?.topViewController?.toolbarItems?.isEmpty ?? true {
            navigationController?.setToolbarHidden(true, animated: animated)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        sizeHeader()
    }

    private func sizeHeader() {
        let width = tableView.bounds.width
        guard width > 0 else { return }
        guard model.mode == .month else {
            if tableView.tableHeaderView != nil { tableView.tableHeaderView = nil }
            return
        }
        let size = headerContainer.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        if headerContainer.frame.size != CGSize(width: width, height: size.height) || tableView.tableHeaderView == nil {
            headerContainer.frame = CGRect(x: 0, y: 0, width: width, height: size.height)
            tableView.tableHeaderView = headerContainer
        }
    }

    private var shownMonth: MonthKey?

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }
        title = TurkishFormat.monthTitle(model.month, currentYear: CalendarDay(Date()).year)
        if shownMonth != model.month {
            shownMonth = model.month
            let month = model.month
            Task { await model.loadSpecialDays(month) }
        }
        let isMonth = model.mode == .month
        modeItem.image = UIImage(systemName: isMonth ? "list.bullet" : "calendar")
        modeItem.accessibilityLabel = isMonth ? "Liste olarak göster" : "Ay olarak göster"
        let entries = model.monthEntries
        var lines: [CalendarDay: [MonthGridView.Line]] = [:]
        for (day, names) in model.specialDays where day.monthKey == model.month {
            lines[day, default: []] += names.map { MonthGridView.Line(text: $0, color: IOSTheme.textTertiary) }
        }
        for entry in entries.sorted(by: { $0.date < $1.date }) {
            lines[entry.day, default: []].append(MonthGridView.Line(text: entry.title, color: IOSTheme.textSecondary, dot: Self.color(entry.kind)))
        }
        grid.configure(month: model.month, selected: isMonth ? model.selectedDay : nil, lines: lines)
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
        _ = model.isLoading
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
            content.text = app.connection == .notPaired ? "iPhone bir Mac'e bağlı değil." : (model.mode == .month ? "Bu gün boş." : "Bu ayda zamanlanmış post yok.")
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

/// Monday-first month grid, edge to edge in square days with hairlines between them (as the
/// Mac's): the number at the top left (today in an orange circle), then the day's special days
/// and posts in small type. Swipe sideways for the next or previous month.
final class MonthGridView: UIView {
    struct Line: Equatable {
        var text: String
        var color: UIColor
        var dot: UIColor?
    }

    var onSelect: ((CalendarDay) -> Void)?
    /// -1: the previous month, 1: the next.
    var onSwipe: ((Int) -> Void)?
    private let weekdays = UIStackView()
    private let rows = UIStackView.v([], spacing: 0.5)
    private var rendered: (MonthKey, CalendarDay?, [CalendarDay: [Line]])?

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        weekdays.axis = .horizontal
        weekdays.distribution = .fillEqually
        for symbol in CalendarAgenda.weekdaySymbols {
            let label = UILabel.studio(symbol, size: 12, weight: .medium, color: IOSTheme.textTertiary, style: .caption1)
            label.textAlignment = .center
            weekdays.addArrangedSubview(label)
        }
        weekdays.heightAnchor.constraint(equalToConstant: 24).isActive = true
        // The hairlines are the background showing between the days.
        rows.backgroundColor = IOSTheme.border
        rows.isLayoutMarginsRelativeArrangement = true
        rows.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0.5, leading: 0, bottom: 0.5, trailing: 0)
        let stack = UIStackView.v([weekdays, rows], spacing: 4)
        addSubview(stack)
        stack.pin(to: self)
        for (direction, value) in [(UISwipeGestureRecognizer.Direction.left, 1), (.right, -1)] {
            let swipe = UISwipeGestureRecognizer(target: self, action: #selector(swiped(_:)))
            swipe.direction = direction
            swipe.name = "\(value)"
            addGestureRecognizer(swipe)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func swiped(_ swipe: UISwipeGestureRecognizer) {
        onSwipe?(swipe.direction == .left ? 1 : -1)
    }

    func configure(month: MonthKey, selected: CalendarDay?, lines: [CalendarDay: [Line]]) {
        if let rendered, rendered.0 == month, rendered.1 == selected, rendered.2 == lines { return }
        rendered = (month, selected, lines)
        rows.removeAllArranged()
        let cells = CalendarAgenda.monthGrid(month)
        let today = CalendarDay(Date())
        for week in stride(from: 0, to: cells.count, by: 7) {
            let row = UIStackView.h(cells[week..<min(week + 7, cells.count)].map {
                dayCell($0, selected: selected, today: today, lines: $0.flatMap { lines[$0] } ?? [])
            }, spacing: 0.5)
            row.distribution = .fillEqually
            rows.addArrangedSubview(row)
        }
    }

    private func dayCell(_ day: CalendarDay?, selected: CalendarDay?, today: CalendarDay, lines: [Line]) -> UIView {
        let control = UIControl()
        control.translatesAutoresizingMaskIntoConstraints = false
        control.backgroundColor = IOSTheme.canvas
        // Square: as tall as a seventh of the width.
        control.heightAnchor.constraint(equalTo: control.widthAnchor).isActive = true
        guard let day else { return control }
        let isSelected = day == selected
        let isToday = day == today
        if isSelected { control.backgroundColor = IOSTheme.elevated }

        let number = UILabel.studio("\(day.day)", size: 13, weight: isToday ? .semibold : .regular, color: isToday ? .white : IOSTheme.textPrimary, style: .footnote)
        number.textAlignment = .center
        let badge = UIView()
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.backgroundColor = isToday ? IOSTheme.accent : .clear
        badge.layer.cornerRadius = 11
        badge.isUserInteractionEnabled = false
        badge.addSubview(number)
        number.pin(to: badge)

        let shown = lines.count > 2 ? Array(lines.prefix(1)) : lines
        var labels: [UIView] = shown.map { line in
            let label = UILabel()
            label.font = IOSTheme.font(9, .medium)
            label.lineBreakMode = .byTruncatingTail
            let text = NSMutableAttributedString()
            if let dot = line.dot {
                text.append(NSAttributedString(string: "● ", attributes: [.foregroundColor: dot, .font: IOSTheme.font(6)]))
            }
            text.append(NSAttributedString(string: line.text, attributes: [.foregroundColor: line.color]))
            label.attributedText = text
            return label
        }
        if lines.count > 2 {
            labels.append(UILabel.studio("+\(lines.count - 1)", size: 9, weight: .semibold, color: IOSTheme.textTertiary, style: .caption2))
        }
        let column = UIStackView.v(labels, spacing: 1)
        column.isUserInteractionEnabled = false
        control.addSubview(badge)
        control.addSubview(column)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: control.leadingAnchor, constant: 4),
            badge.topAnchor.constraint(equalTo: control.topAnchor, constant: 4),
            badge.widthAnchor.constraint(equalToConstant: 22),
            badge.heightAnchor.constraint(equalToConstant: 22),
            column.topAnchor.constraint(equalTo: badge.bottomAnchor, constant: 2),
            column.leadingAnchor.constraint(equalTo: control.leadingAnchor, constant: 4),
            column.trailingAnchor.constraint(equalTo: control.trailingAnchor, constant: -3),
            column.bottomAnchor.constraint(lessThanOrEqualTo: control.bottomAnchor, constant: -2),
        ])
        control.clipsToBounds = true
        control.addAction(UIAction { [weak self] _ in self?.onSelect?(day) }, for: .touchUpInside)
        control.isAccessibilityElement = true
        let detail = lines.map(\.text).joined(separator: ", ")
        control.accessibilityLabel = "\(TurkishFormat.longDay(day))\(detail.isEmpty ? "" : ", \(detail)")"
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
