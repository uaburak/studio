import AppKit
import Foundation
import Observation
import StudioKit

/// Pure AppKit model for the Takvim screen (`CalendarViewController`).
@MainActor
@Observable
final class CalendarModel {
    weak var app: AppModel?
    var month = MonthKey(Date())
    var selectedDay: CalendarDay? = CalendarDay(Date())
    var showEntireMonth = false

    private(set) var schedules: [Schedule] = []
    private(set) var contents: [Content] = []
    private(set) var plans: [Plan] = []
    private(set) var isLoading = false
    private(set) var cancellingIds: Set<EntityID> = []
    var error: String?
    private var loadedBrandId: EntityID?

    struct CalendarEntry: Identifiable, Hashable {
        enum Source: Hashable {
            case schedule(Schedule)
            case planned(PostCard)
        }

        var id: String
        var day: CalendarDay
        var timeText: String
        var title: String
        var platformText: String
        var accountHandle: String?
        var statusLabel: String
        var dotKind: DotKind
        var permalink: String?
        var canCancel: Bool
        var scheduleId: EntityID?
        var contentId: EntityID?

        enum DotKind: Hashable {
            case scheduled
            case published
            case approved
            case error
            case planned
        }
    }

    var brandId: EntityID? { app?.currentBrandId }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let loadedSchedules = app.dataService.schedules(brandId: brandId)
            async let loadedContents = app.dataService.contents(brandId: brandId)
            async let loadedPlans = app.dataService.plans(brandId: brandId)
            self.schedules = try await loadedSchedules
            self.contents = try await loadedContents
            self.plans = try await loadedPlans
            if app.posts.loadedBrandId != brandId || app.posts.board.cards.isEmpty {
                await app.posts.load()
            }
            if loadedBrandId != brandId {
                loadedBrandId = brandId
                let activeMonths = Set(allEntries.map(\.day.monthKey))
                if !activeMonths.contains(month),
                   let nearest = activeMonths.sorted().min(by: { abs($0.distance(to: month)) < abs($1.distance(to: month)) }) {
                    month = nearest
                    selectedDay = allEntries.filter { $0.day.monthKey == nearest }.map(\.day).min()
                }
            }
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func previousMonth() {
        month = month.previous
        selectedDay = CalendarDay(year: month.year, month: month.month, day: 1)
    }

    func nextMonth() {
        month = month.next
        selectedDay = CalendarDay(year: month.year, month: month.month, day: 1)
    }

    func goToday() {
        let today = CalendarDay(Date())
        month = today.monthKey
        selectedDay = today
    }

    var allEntries: [CalendarEntry] {
        guard let app else { return [] }
        let contentById = Dictionary(uniqueKeysWithValues: contents.map { ($0.id, $0) })
        let accountById = Dictionary(uniqueKeysWithValues: app.accounts(of: brandId).map { ($0.id, $0) })

        var entries: [CalendarEntry] = []
        var scheduledContentDays = Set<String>()

        let timeFmt = DateFormatter()
        timeFmt.locale = TurkishFormat.locale
        timeFmt.dateFormat = "HH:mm"

        for sch in schedules where sch.status != .cancelled {
            let day = CalendarDay(sch.scheduledAt)
            let title = contentById[sch.contentId]?.title ?? "Post"
            let account = accountById[sch.socialAccountId]
            let handle = account.map { $0.handle.hasPrefix("@") ? $0.handle : "@\($0.handle)" }
            let (statusLabel, dot): (String, CalendarEntry.DotKind) = switch sch.status {
            case .pending: ("Zamanlandı", .scheduled)
            case .publishing: ("Yayınlanıyor", .scheduled)
            case .published: ("Yayınlandı", .published)
            case .failed: ("Hata", .error)
            case .cancelled, .unknown: ("İptal", .planned)
            }
            scheduledContentDays.insert("\(sch.contentId):\(day.description)")
            entries.append(CalendarEntry(
                id: "sch-\(sch.id)",
                day: day,
                timeText: timeFmt.string(from: sch.scheduledAt),
                title: title,
                platformText: sch.platform.displayName,
                accountHandle: handle,
                statusLabel: statusLabel,
                dotKind: dot,
                permalink: sch.permalink,
                canCancel: sch.status == .pending,
                scheduleId: sch.id,
                contentId: sch.contentId
            ))
        }

        // Also surface dated posts from the board that do not yet have an active/published schedule row on that day
        for card in app.posts.board.cards {
            guard let day = card.day else { continue }
            guard !scheduledContentDays.contains("\(card.id):\(day.description)") else { continue }
            let (statusLabel, dot): (String, CalendarEntry.DotKind) = switch card.state {
            case .published: ("Yayınlandı", .published)
            case .scheduled, .publishing: ("Zamanlandı", .scheduled)
            case .approved: ("Onaylandı", .approved)
            case .failed: ("Hata", .error)
            default: (card.state.label, .planned)
            }
            entries.append(CalendarEntry(
                id: "card-\(card.id)",
                day: day,
                timeText: "09:00",
                title: card.title,
                platformText: TurkishFormat.platforms(card.content.targetPlatforms),
                accountHandle: nil,
                statusLabel: statusLabel,
                dotKind: dot,
                permalink: nil,
                canCancel: false,
                scheduleId: nil,
                contentId: card.id
            ))
        }

        return entries.sorted { a, b in
            if a.day != b.day { return a.day < b.day }
            if a.timeText != b.timeText { return a.timeText < b.timeText }
            return a.title < b.title
        }
    }

    var monthEntries: [CalendarEntry] {
        allEntries.filter { $0.day.monthKey == month }
    }

    func entries(on day: CalendarDay) -> [CalendarEntry] {
        monthEntries.filter { $0.day == day }
    }

    var listedEntries: [CalendarEntry] {
        if !showEntireMonth, let selectedDay, selectedDay.monthKey == month {
            return entries(on: selectedDay)
        }
        return monthEntries
    }

    func cancelSchedule(_ scheduleId: EntityID) async {
        guard let app, !cancellingIds.contains(scheduleId) else { return }
        cancellingIds.insert(scheduleId)
        defer { cancellingIds.remove(scheduleId) }
        do {
            let updated = try await app.dataService.cancelSchedule(scheduleId)
            if let idx = schedules.firstIndex(where: { $0.id == scheduleId }) {
                schedules[idx] = updated
            }
            await app.posts.load()
            await load()
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func openPost(contentId: EntityID) async {
        guard let app else { return }
        if app.posts.card(contentId) == nil {
            await app.posts.load()
        }
        if let card = app.posts.card(contentId) {
            app.detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        }
    }

    /// 42 (or 35) grid cells starting Monday for `month`. `nil` = leading/trailing blank cell, or adjacent day.
    static func monthGridDays(for month: MonthKey) -> [CalendarDay?] {
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2 // Monday
        let firstDate = CalendarDay(year: month.year, month: month.month, day: 1).date()
        let weekday = cal.component(.weekday, from: firstDate) // 1=Sun, 2=Mon...7=Sat
        let mondayOffset = (weekday + 5) % 7
        let range = cal.range(of: .day, in: .month, for: firstDate) ?? 1..<31
        let daysInMonth = range.count

        var cells: [CalendarDay?] = Array(repeating: nil, count: mondayOffset)
        for d in 1...daysInMonth {
            cells.append(CalendarDay(year: month.year, month: month.month, day: d))
        }
        while cells.count % 7 != 0 {
            cells.append(nil)
        }
        return cells
    }
}

// MARK: - CalendarViewController (100% Pure AppKit)

final class CalendarViewController: NSViewController {
    private unowned let app: AppModel
    private var model: CalendarModel { app.calendar }

    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let contentStack = NSStackView()

    private let monthTitleLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private let errorBanner = InlineErrorBannerView()
    private let gridHost = NSStackView()
    private let listHeaderLabel = NSTextField(labelWithString: "")
    private var scopeSegment: NSSegmentedControl!
    private let scheduleListStack = NSStackView()

    private var observation: ObservationToken?
    private var lastBrandId: EntityID?

    private static let weekdayLabels = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"]

    init(app: AppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas

        let clip = FlippedClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.automaticallyAdjustsContentInsets = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView
        scrollView.applyMinimalScroller()

        // Header: < Kasım 2026 > + Bugün + Legend
        let prevBtn = GlyphButton(symbol: "chevron.left", size: 12, weight: .semibold, diameter: 28) { [weak self] in
            self?.model.previousMonth()
        }
        prevBtn.toolTip = "Önceki ay"
        let nextBtn = GlyphButton(symbol: "chevron.right", size: 12, weight: .semibold, diameter: 28) { [weak self] in
            self?.model.nextMonth()
        }
        nextBtn.toolTip = "Sonraki ay"

        monthTitleLabel.font = NSFont.systemFont(ofSize: 26, weight: .bold)
        monthTitleLabel.textColor = Theme.textPrimary

        let todayBtn = PillButton(title: "Bugün", kind: .secondary, height: 26) { [weak self] in
            self?.model.goToday()
        }

        let monthNavRow = NSStackView(views: [prevBtn, monthTitleLabel, nextBtn, todayBtn])
        monthNavRow.orientation = .horizontal
        monthNavRow.alignment = .centerY
        monthNavRow.spacing = 10

        subtitleLabel.font = Theme.captionFont
        subtitleLabel.textColor = Theme.textSecondary

        let titleCol = NSStackView(views: [monthNavRow, subtitleLabel])
        titleCol.orientation = .vertical
        titleCol.alignment = .leading
        titleCol.spacing = 4

        let legendRow = NSStackView(views: [
            makeLegendItem(color: Theme.accent, text: "Zamanlandı"),
            makeLegendItem(color: Theme.ink, text: "Yayınlandı"),
            makeLegendItem(color: Theme.textTertiary, text: "Onaylandı"),
            makeLegendItem(color: .systemRed, text: "Hata"),
        ])
        legendRow.orientation = .horizontal
        legendRow.alignment = .centerY
        legendRow.spacing = 14

        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let headerRow = NSStackView(views: [titleCol, headerSpacer, legendRow])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 16
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.model.error = nil }

        // Calendar card container
        let calendarCard = CardContainerView(padding: 16, spacing: 10)
        let weekdayRow = NSStackView()
        weekdayRow.orientation = .horizontal
        weekdayRow.distribution = .fillEqually
        weekdayRow.spacing = 8
        for dayName in Self.weekdayLabels {
            let lbl = NSTextField.styledLabel(dayName, font: NSFont.systemFont(ofSize: 11, weight: .semibold), color: Theme.textSecondary)
            lbl.alignment = .center
            weekdayRow.addArrangedSubview(lbl)
        }
        calendarCard.contentStack.addArrangedSubview(weekdayRow)
        weekdayRow.widthAnchor.constraint(equalTo: calendarCard.contentStack.widthAnchor).isActive = true

        gridHost.orientation = .vertical
        gridHost.alignment = .leading
        gridHost.spacing = 8
        calendarCard.contentStack.addArrangedSubview(gridHost)
        gridHost.widthAnchor.constraint(equalTo: calendarCard.contentStack.widthAnchor).isActive = true

        // Bottom schedule list section
        listHeaderLabel.font = NSFont.systemFont(ofSize: 16, weight: .semibold)
        listHeaderLabel.textColor = Theme.textPrimary

        scopeSegment = NSSegmentedControl(labels: ["Seçili gün", "Tüm ay"], trackingMode: .selectOne, target: self, action: #selector(scopeChanged))
        scopeSegment.selectedSegment = 0

        let listSpacer = NSView()
        listSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let listTopRow = NSStackView(views: [listHeaderLabel, listSpacer, scopeSegment])
        listTopRow.orientation = .horizontal
        listTopRow.alignment = .centerY

        scheduleListStack.orientation = .vertical
        scheduleListStack.alignment = .leading
        scheduleListStack.spacing = 10

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 22
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.addArrangedSubview(headerRow)
        contentStack.addArrangedSubview(errorBanner)
        contentStack.addArrangedSubview(calendarCard)
        contentStack.addArrangedSubview(listTopRow)
        contentStack.addArrangedSubview(scheduleListStack)
        documentView.addSubview(contentStack)

        root.addSubview(scrollView)

        let maxW = contentStack.widthAnchor.constraint(equalToConstant: 980)
        maxW.priority = .defaultHigh

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            documentView.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            documentView.topAnchor.constraint(equalTo: clip.topAnchor),

            contentStack.centerXAnchor.constraint(equalTo: documentView.centerXAnchor),
            contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: documentView.leadingAnchor, constant: 48),
            contentStack.trailingAnchor.constraint(lessThanOrEqualTo: documentView.trailingAnchor, constant: -48),
            maxW,
            contentStack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 28),
            contentStack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -48),

            headerRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            errorBanner.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            calendarCard.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            listTopRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            scheduleListStack.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.render()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        Task { await model.load() }
    }

    @objc private func scopeChanged() {
        model.showEntireMonth = scopeSegment.selectedSegment == 1
    }

    private func makeLegendItem(color: NSColor, text: String) -> NSView {
        let dot = StatusDotView(color: color, size: 7)
        let lbl = NSTextField.styledLabel(text, font: Theme.smallFont, color: Theme.textSecondary)
        let row = NSStackView(views: [dot, lbl])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        return row
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }

        monthTitleLabel.stringValue = "\(TurkishFormat.monthName(model.month)) \(model.month.year)"
        let brandName = app.brand(app.currentBrandId)?.name ?? "Marka seçilmedi"
        let monthEntries = model.monthEntries
        let scheduledCount = monthEntries.filter { $0.dotKind == .scheduled || $0.dotKind == .published }.count
        subtitleLabel.stringValue = "\(brandName) · \(monthEntries.count) içerik, \(scheduledCount) zamanlı yayın"

        if let err = model.error {
            errorBanner.message = err
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }

        scopeSegment.selectedSegment = model.showEntireMonth ? 1 : 0
        rebuildGrid()
        rebuildScheduleList()
    }

    private func rebuildGrid() {
        gridHost.arrangedSubviews.forEach {
            gridHost.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        let cells = CalendarModel.monthGridDays(for: model.month)
        let today = CalendarDay(Date())
        let rowsCount = cells.count / 7

        for rowIdx in 0..<rowsCount {
            let weekRow = NSStackView()
            weekRow.orientation = .horizontal
            weekRow.distribution = .fillEqually
            weekRow.spacing = 8

            for colIdx in 0..<7 {
                let day = cells[rowIdx * 7 + colIdx]
                let cellView = CalendarDayCellView(
                    day: day,
                    isToday: day == today,
                    isSelected: day != nil && day == model.selectedDay && !model.showEntireMonth,
                    entries: day.map { model.entries(on: $0) } ?? [],
                    onSelectDay: { [weak self] picked in
                        self?.model.showEntireMonth = false
                        self?.model.selectedDay = picked
                    },
                    onOpenPost: { [weak self] contentId in
                        guard let self else { return }
                        Task { await self.model.openPost(contentId: contentId) }
                    }
                )
                weekRow.addArrangedSubview(cellView)
            }
            gridHost.addArrangedSubview(weekRow)
            weekRow.widthAnchor.constraint(equalTo: gridHost.widthAnchor).isActive = true
        }
    }

    private func rebuildScheduleList() {
        scheduleListStack.arrangedSubviews.forEach {
            scheduleListStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        if !model.showEntireMonth, let day = model.selectedDay, day.monthKey == model.month {
            listHeaderLabel.stringValue = "\(TurkishFormat.longDay(day)) Programı"
        } else {
            listHeaderLabel.stringValue = "\(TurkishFormat.monthName(model.month)) \(model.month.year) Tüm Program"
        }

        let items = model.listedEntries
        if items.isEmpty {
            let emptyCard = CardContainerView(padding: 18, spacing: 6)
            emptyCard.contentStack.addArrangedSubview(
                NSTextField.styledLabel(
                    model.showEntireMonth ? "Bu ayda zamanlanmış ya da planlanmış paylaşım yok." : "Seçili günde paylaşım yok.",
                    font: Theme.rowFont,
                    color: Theme.textSecondary
                )
            )
            scheduleListStack.addArrangedSubview(emptyCard)
            emptyCard.widthAnchor.constraint(equalTo: scheduleListStack.widthAnchor).isActive = true
            return
        }

        for entry in items {
            let row = CalendarScheduleRowView(
                entry: entry,
                cancelling: entry.scheduleId.map { model.cancellingIds.contains($0) } ?? false,
                onOpenPost: { [weak self] in
                    guard let self, let cid = entry.contentId else { return }
                    Task { await self.model.openPost(contentId: cid) }
                },
                onCancel: { [weak self] in
                    guard let self, let sid = entry.scheduleId else { return }
                    Task { await self.model.cancelSchedule(sid) }
                },
                onOpenPermalink: {
                    guard let link = entry.permalink, let url = URL(string: link) else { return }
                    NSWorkspace.shared.open(url)
                }
            )
            scheduleListStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: scheduleListStack.widthAnchor).isActive = true
        }
    }
}

// MARK: - Day Cell & Schedule Row Views

private final class CalendarDayCellView: ThemedView {
    private let day: CalendarDay?
    private let onSelectDay: (CalendarDay) -> Void

    init(
        day: CalendarDay?,
        isToday: Bool,
        isSelected: Bool,
        entries: [CalendarModel.CalendarEntry],
        onSelectDay: @escaping (CalendarDay) -> Void,
        onOpenPost: @escaping (EntityID) -> Void
    ) {
        self.day = day
        self.onSelectDay = onSelectDay
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        cornerRadius = 12
        heightAnchor.constraint(equalToConstant: 96).isActive = true

        guard let day else {
            backgroundColor = Theme.fill.withAlphaComponent(0.35)
            borderWidth = 0
            return
        }

        backgroundColor = isSelected ? Theme.fillStrong : Theme.fill
        borderColor = isSelected ? Theme.accent : (isToday ? Theme.ink : Theme.hairline)
        borderWidth = isSelected ? 1.5 : 1

        let dayNumber = NSTextField.styledLabel(
            "\(day.day)",
            font: NSFont.systemFont(ofSize: 12, weight: isToday || isSelected ? .bold : .medium),
            color: isToday ? Theme.accent : Theme.textPrimary
        )

        let vStack = NSStackView()
        vStack.orientation = .vertical
        vStack.alignment = .leading
        vStack.spacing = 4
        vStack.translatesAutoresizingMaskIntoConstraints = false
        vStack.addArrangedSubview(dayNumber)

        for entry in entries.prefix(2) {
            let pill = CalendarPostPillView(entry: entry) {
                if let cid = entry.contentId { onOpenPost(cid) }
            }
            vStack.addArrangedSubview(pill)
            pill.widthAnchor.constraint(equalTo: vStack.widthAnchor).isActive = true
        }

        if entries.count > 2 {
            let more = NSTextField.styledLabel("+\(entries.count - 2) daha", font: NSFont.systemFont(ofSize: 10), color: Theme.textSecondary)
            vStack.addArrangedSubview(more)
        }

        addSubview(vStack)
        NSLayoutConstraint.activate([
            vStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            vStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            vStack.topAnchor.constraint(equalTo: topAnchor, constant: 7),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        if let day { onSelectDay(day) }
    }
}

private final class CalendarPostPillView: ThemedView {
    private let onClick: () -> Void

    init(entry: CalendarModel.CalendarEntry, onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.canvas
        borderColor = Theme.border
        borderWidth = 1
        cornerRadius = 7
        toolTip = "\(entry.title) · \(entry.statusLabel) (\(entry.timeText))"

        let dotColor: NSColor = switch entry.dotKind {
        case .scheduled: Theme.accent
        case .published: Theme.ink
        case .approved: Theme.textTertiary
        case .error: .systemRed
        case .planned: Theme.textSecondary
        }

        let dot = StatusDotView(color: dotColor, size: 6)
        let title = NSTextField.styledLabel(entry.title, font: NSFont.systemFont(ofSize: 10, weight: .medium), color: Theme.textPrimary)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [dot, title])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 20),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onClick()
    }
}

private final class CalendarScheduleRowView: ThemedView {
    private let onOpenPost: () -> Void

    init(
        entry: CalendarModel.CalendarEntry,
        cancelling: Bool,
        onOpenPost: @escaping () -> Void,
        onCancel: @escaping () -> Void,
        onOpenPermalink: @escaping () -> Void
    ) {
        self.onOpenPost = onOpenPost
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.canvas
        borderColor = Theme.border
        borderWidth = 1
        cornerRadius = 14

        let dotColor: NSColor = switch entry.dotKind {
        case .scheduled: Theme.accent
        case .published: Theme.ink
        case .approved: Theme.textTertiary
        case .error: .systemRed
        case .planned: Theme.textSecondary
        }
        let dot = StatusDotView(color: dotColor, size: 8)

        let dateTime = NSTextField.styledLabel(
            "\(TurkishFormat.shortDay(entry.day)) · \(entry.timeText)",
            font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
            color: Theme.textSecondary
        )

        let title = NSTextField.styledLabel(entry.title, font: NSFont.systemFont(ofSize: 13, weight: .semibold), color: Theme.textPrimary)
        let metaParts = [entry.platformText, entry.accountHandle, entry.statusLabel].compactMap { $0 }
        let meta = NSTextField.styledLabel(metaParts.joined(separator: " · "), font: Theme.smallFont, color: Theme.textSecondary)

        let infoCol = NSStackView(views: [title, meta])
        infoCol.orientation = .vertical
        infoCol.alignment = .leading
        infoCol.spacing = 2

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var rowViews: [NSView] = [dot, dateTime, infoCol, spacer]

        if let permalink = entry.permalink, !permalink.isEmpty {
            let openLinkBtn = PillButton(title: "Yayını Aç ↗", kind: .outline, height: 24, action: onOpenPermalink)
            openLinkBtn.toolTip = permalink
            rowViews.append(openLinkBtn)
        }

        if entry.canCancel {
            let cancelBtn = PillButton(title: "Zamanlamayı iptal et", kind: .secondary, height: 24, action: onCancel)
            cancelBtn.showsSpinner = cancelling
            cancelBtn.isEnabled = !cancelling
            rowViews.append(cancelBtn)
        }

        let openPostBtn = PillButton(title: "Postu Aç", kind: .secondary, height: 24, action: onOpenPost)
        rowViews.append(openPostBtn)

        let row = NSStackView(views: rowViews)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onOpenPost()
        } else {
            super.mouseDown(with: event)
        }
    }
}
