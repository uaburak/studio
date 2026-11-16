import AppKit
import Foundation
import Observation
import StudioKit

/// Model of the Takvim screen (`CalendarViewController`): month and week views, publish
/// state per schedule, drag to reschedule, schedule / retry / cancel, the publish log.
@MainActor
@Observable
final class CalendarModel {
    enum ViewMode: Int, CaseIterable {
        case month, week, log

        var label: String {
            switch self {
            case .month: "Ay"
            case .week: "Hafta"
            case .log: "Yayın günlüğü"
            }
        }
    }

    weak var app: AppModel?
    var month = MonthKey(Date())
    var selectedDay: CalendarDay? = CalendarDay(Date())
    var showEntireMonth = false
    var viewMode: ViewMode = .month
    /// Any day of the week shown in the week view.
    var weekAnchor = Date()
    /// Set by the view controller while the screen is on screen.
    var isVisible = false

    private(set) var schedules: [Schedule] = []
    private(set) var contents: [Content] = []
    private(set) var plans: [Plan] = []
    private(set) var isLoading = false
    private(set) var cancellingIds: Set<EntityID> = []
    private(set) var movingIds: Set<EntityID> = []
    var error: String?
    private var loadedBrandId: EntityID?
    private var lastLoad: Date?

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
        /// P3: what the schedule means now (nil for dated posts without a schedule).
        var state: ScheduleDisplayState? = nil
        var scheduledAt: Date? = nil
        var accountId: EntityID? = nil

        var canMove: Bool { state?.canMove ?? false }
        var canRetry: Bool { state?.canRetry ?? false }
        var detail: String? { state?.detail }

        enum DotKind: Hashable {
            case scheduled
            case published
            case approved
            case error
            case planned
        }
    }

    var brandId: EntityID? { app?.currentBrandId }
    private var api: (any PublishingAPI)? { app?.publishing.api }

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
            lastLoad = Date()
            if app.posts.loadedBrandId != brandId || app.posts.board.cards.isEmpty {
                await app.posts.load()
            }
            if loadedBrandId != brandId {
                loadedBrandId = brandId
                let activeMonths = Set(allEntries.map(\.day.monthKey))
                if !activeMonths.contains(month), let nearest = activeMonths.min(by: { abs(Self.monthIndex($0) - Self.monthIndex(month)) < abs(Self.monthIndex($1) - Self.monthIndex(month)) }) {
                    month = nearest
                    selectedDay = allEntries.filter { $0.day.monthKey == nearest }.map(\.day).min()
                }
            }
            if viewMode == .log { await app.publishing.refreshLogs(brandId: brandId) }
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// Publishing events and focus refresh the screen only while it is shown.
    func reloadIfVisible(force: Bool = false) async {
        guard isVisible || force else { return }
        if !force, let lastLoad, Date().timeIntervalSince(lastLoad) < 2 { return }
        await load()
    }

    private static func monthIndex(_ m: MonthKey) -> Int { m.year * 12 + m.month }

    func previous() {
        switch viewMode {
        case .week:
            weekAnchor = CalendarMath.calendar().date(byAdding: .day, value: -7, to: weekAnchor) ?? weekAnchor
            month = MonthKey(weekAnchor)
        default:
            previousMonth()
        }
    }

    func next() {
        switch viewMode {
        case .week:
            weekAnchor = CalendarMath.calendar().date(byAdding: .day, value: 7, to: weekAnchor) ?? weekAnchor
            month = MonthKey(weekAnchor)
        default:
            nextMonth()
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
        weekAnchor = Date()
    }

    var weekDays: [Date] { CalendarMath.weekDays(containing: weekAnchor) }

    var title: String {
        switch viewMode {
        case .week:
            let days = weekDays
            guard let first = days.first, let last = days.last else { return "" }
            return "\(TurkishFormat.shortDay(first)) – \(TurkishFormat.shortDay(last))"
        default:
            return "\(TurkishFormat.monthName(month)) \(month.year)"
        }
    }

    var allEntries: [CalendarEntry] {
        guard let app else { return [] }
        let contentById = Dictionary(contents.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let accountById = Dictionary(app.accounts(of: brandId).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let mode = app.publishing.mode

        var entries: [CalendarEntry] = []
        var scheduledContentDays = Set<String>()

        let timeFmt = DateFormatter()
        timeFmt.locale = TurkishFormat.locale
        timeFmt.dateFormat = "HH:mm"

        for sch in schedules where sch.status != .cancelled {
            let day = CalendarDay(sch.scheduledAt)
            let title = contentById[sch.contentId]?.title ?? "Post"
            let account = accountById[sch.socialAccountId]
            let handle = account.map { $0.handle.hasPrefix("@") || $0.platform != .instagram ? $0.handle : "@\($0.handle)" }
            let state = ScheduleDisplayState(sch, mode: mode)
            let dot: CalendarEntry.DotKind = switch state {
            case .published: .published
            case .failed: .error
            case .sendingToCloud(let error) where error != nil: .error
            case .cancelled: .planned
            default: .scheduled
            }
            scheduledContentDays.insert("\(sch.contentId):\(day.description)")
            entries.append(CalendarEntry(
                id: "sch-\(sch.id)",
                day: day,
                timeText: timeFmt.string(from: sch.scheduledAt),
                title: title,
                platformText: sch.platform.displayName,
                accountHandle: handle,
                statusLabel: state.label,
                dotKind: dot,
                permalink: sch.permalink,
                canCancel: state.canCancel,
                scheduleId: sch.id,
                contentId: sch.contentId,
                state: state,
                scheduledAt: sch.scheduledAt,
                accountId: sch.socialAccountId
            ))
        }

        // Dated posts from the board without a schedule on that day (plan dates).
        for card in app.posts.board.cards {
            guard let day = card.day else { continue }
            guard !scheduledContentDays.contains("\(card.id):\(day.description)") else { continue }
            let (statusLabel, dot): (String, CalendarEntry.DotKind) = switch card.state {
            case .published: ("Yayınlandı", .published)
            case .scheduled, .publishing: ("Zamanlandı", .scheduled)
            case .approved: ("Onaylandı · zamanlanmadı", .approved)
            case .failed: ("Hata", .error)
            default: (card.state.label, .planned)
            }
            entries.append(CalendarEntry(
                id: "card-\(card.id)",
                day: day,
                timeText: "—",
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
        allEntries.filter { $0.day == day }
    }

    var listedEntries: [CalendarEntry] {
        switch viewMode {
        case .week:
            let days = Set(weekDays.map { CalendarDay($0) })
            return allEntries.filter { days.contains($0.day) }
        default:
            if !showEntireMonth, let selectedDay, selectedDay.monthKey == month {
                return entries(on: selectedDay)
            }
            return monthEntries
        }
    }

    /// Schedules waiting on the owner (failed, refused by the cloud).
    var needsAttention: [CalendarEntry] { allEntries.filter { $0.state?.needsOwner == true } }

    // MARK: Actions

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

    /// Where a drop lands: same local time on `day` (month view) or `day` at `hour` (week view).
    func dropTarget(for entry: CalendarEntry, day: Date, hour: Int?) -> Date? {
        guard let original = entry.scheduledAt else { return nil }
        return hour.map { CalendarMath.move(original, toDay: day, hour: $0) } ?? CalendarMath.move(original, toDay: day)
    }

    /// Drag in the calendar: move a pending schedule. Returns false (with a Turkish error) when refused.
    @discardableResult
    func move(scheduleId: EntityID, toDay day: Date, hour: Int? = nil) async -> Bool {
        guard let api, let entry = allEntries.first(where: { $0.scheduleId == scheduleId }) else { return false }
        guard entry.canMove else {
            error = "Yalnızca bekleyen zamanlamalar taşınabilir."
            return false
        }
        guard let target = dropTarget(for: entry, day: day, hour: hour) else { return false }
        if let original = entry.scheduledAt, abs(original.timeIntervalSince(target)) < 30 { return true }
        guard target >= CalendarMath.earliestSchedule() else {
            error = "Geçmiş bir zamana taşınamaz."
            return false
        }
        movingIds.insert(scheduleId)
        defer { movingIds.remove(scheduleId) }
        do {
            let moved = try await api.reschedule(scheduleId, to: target)
            if let idx = schedules.firstIndex(where: { $0.id == scheduleId }) { schedules[idx] = moved }
            selectedDay = CalendarDay(target)
            error = nil
            return true
        } catch {
            self.error = AppModel.describe(error)
            return false
        }
    }

    /// The request the schedule sheet opens with ("+ Zamanla" on a day, or "Yeniden dene").
    func scheduleRequest(on day: CalendarDay? = nil, retry entry: CalendarEntry? = nil) -> ScheduleSheetRequest? {
        guard let brandId else { return nil }
        if let entry {
            return ScheduleSheetRequest(
                brandId: brandId, contentId: entry.contentId,
                date: CalendarMath.defaultTime(on: Date()), accountIds: entry.accountId.map { [$0] } ?? [])
        }
        let base = (day ?? selectedDay).map { $0.date() } ?? Date()
        let target = base < Calendar.current.startOfDay(for: Date()) ? Date() : base
        return ScheduleSheetRequest(brandId: brandId, contentId: nil, date: CalendarMath.defaultTime(on: target))
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

    /// 42 (or 35) grid cells starting Monday for `month`. `nil` = leading/trailing blank cell.
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

    /// Hours shown in the week view; schedules outside sit on the first/last row.
    static let weekHours = Array(6...23)

    static func weekRowHour(for date: Date) -> Int {
        let hour = CalendarMath.calendar().component(.hour, from: date)
        return min(max(hour, weekHours.first ?? 0), weekHours.last ?? 23)
    }
}

// MARK: - CalendarViewController (100% AppKit)

final class CalendarViewController: NSViewController {
    private unowned let app: AppModel
    private var model: CalendarModel { app.calendar }

    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let contentStack = NSStackView()

    private let titleLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private let modeBanner = NSTextField(wrappingLabelWithString: "")
    private let errorBanner = InlineErrorBannerView()
    private var viewSegment: NSSegmentedControl!
    private let gridCard = CardContainerView(padding: 16, spacing: 10)
    private let gridHost = NSStackView()
    private let weekdayRow = NSStackView()
    private let listHeaderLabel = NSTextField(labelWithString: "")
    private var scopeSegment: NSSegmentedControl!
    private let listStack = NSStackView()
    private var listTopRow: NSStackView!

    private var observation: ObservationToken?
    private var lastBrandId: EntityID?
    private var lastViewMode: CalendarModel.ViewMode?

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

        let prevBtn = GlyphButton(symbol: "chevron.left", size: 12, weight: .semibold, diameter: 28) { [weak self] in self?.model.previous() }
        prevBtn.toolTip = "Önceki dönem"
        let nextBtn = GlyphButton(symbol: "chevron.right", size: 12, weight: .semibold, diameter: 28) { [weak self] in self?.model.next() }
        nextBtn.toolTip = "Sonraki dönem"
        titleLabel.font = NSFont.systemFont(ofSize: 26, weight: .bold)
        titleLabel.textColor = Theme.textPrimary
        let todayBtn = PillButton(title: "Bugün", kind: .secondary, height: 26) { [weak self] in self?.model.goToday() }
        let navRow = NSStackView(views: [prevBtn, titleLabel, nextBtn, todayBtn])
        navRow.orientation = .horizontal
        navRow.alignment = .centerY
        navRow.spacing = 10

        subtitleLabel.font = Theme.captionFont
        subtitleLabel.textColor = Theme.textSecondary
        let titleCol = NSStackView(views: [navRow, subtitleLabel])
        titleCol.orientation = .vertical
        titleCol.alignment = .leading
        titleCol.spacing = 4

        viewSegment = NSSegmentedControl(labels: CalendarModel.ViewMode.allCases.map(\.label), trackingMode: .selectOne, target: self, action: #selector(viewModeChanged))
        viewSegment.segmentStyle = .rounded
        let scheduleBtn = PillButton(title: "Zamanla", kind: .primary, height: 28) { [weak self] in self?.openScheduleSheet(day: nil) }
        scheduleBtn.toolTip = "Onaylı bir postu seçili güne zamanla"
        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let headerRow = NSStackView(views: [titleCol, headerSpacer, viewSegment, scheduleBtn])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 12

        modeBanner.font = Theme.smallFont
        modeBanner.textColor = Theme.textSecondary

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.model.error = nil }
        errorBanner.onRetry = { [weak self] in
            guard let self else { return }
            self.model.error = nil
            Task { await self.model.load() }
        }

        weekdayRow.orientation = .horizontal
        weekdayRow.distribution = .fillEqually
        weekdayRow.spacing = 8
        gridCard.contentStack.addArrangedSubview(weekdayRow)
        weekdayRow.widthAnchor.constraint(equalTo: gridCard.contentStack.widthAnchor).isActive = true
        gridHost.orientation = .vertical
        gridHost.alignment = .leading
        gridHost.spacing = 8
        gridCard.contentStack.addArrangedSubview(gridHost)
        gridHost.widthAnchor.constraint(equalTo: gridCard.contentStack.widthAnchor).isActive = true

        listHeaderLabel.font = NSFont.systemFont(ofSize: 16, weight: .semibold)
        listHeaderLabel.textColor = Theme.textPrimary
        scopeSegment = NSSegmentedControl(labels: ["Seçili gün", "Tüm ay"], trackingMode: .selectOne, target: self, action: #selector(scopeChanged))
        scopeSegment.selectedSegment = 0
        let listSpacer = NSView()
        listSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        listTopRow = NSStackView(views: [listHeaderLabel, listSpacer, scopeSegment])
        listTopRow.orientation = .horizontal
        listTopRow.alignment = .centerY

        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 10

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 18
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        for v in [headerRow, modeBanner, errorBanner, gridCard, listTopRow!, listStack] { contentStack.addArrangedSubview(v) }
        documentView.addSubview(contentStack)
        root.addSubview(scrollView)

        let maxW = contentStack.widthAnchor.constraint(equalToConstant: 1040)
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
        ])
        for v in [headerRow, modeBanner, errorBanner, gridCard, listTopRow!, listStack] {
            v.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        }
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in self?.render() }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        model.isVisible = true
        Task { await model.load() }
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        model.isVisible = false
    }

    @objc private func scopeChanged() { model.showEntireMonth = scopeSegment.selectedSegment == 1 }

    @objc private func viewModeChanged() {
        model.viewMode = CalendarModel.ViewMode(rawValue: viewSegment.selectedSegment) ?? .month
        if model.viewMode == .week, let day = model.selectedDay { model.weekAnchor = day.date() }
        if model.viewMode == .log { Task { await app.publishing.refreshLogs(brandId: model.brandId) } }
    }

    func openScheduleSheet(day: CalendarDay?, retry: CalendarModel.CalendarEntry? = nil) {
        guard let request = model.scheduleRequest(on: day, retry: retry) else { return }
        ScheduleSheetController.present(from: self, app: app, request: request)
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }
        titleLabel.stringValue = model.title
        let brandName = app.brand(app.currentBrandId)?.name ?? "Marka seçilmedi"
        let listed = model.viewMode == .week ? model.listedEntries : model.monthEntries
        let scheduled = listed.filter { $0.scheduleId != nil }.count
        var subtitle = "\(brandName) · \(listed.count) içerik, \(scheduled) zamanlı yayın"
        let attention = model.needsAttention.count
        if attention > 0 { subtitle += " · \(attention) yayın ilgini bekliyor" }
        if model.isLoading { subtitle += " · Yükleniyor…" }
        subtitleLabel.stringValue = subtitle

        let publishing = app.publishing
        modeBanner.stringValue = publishing.modeSummary + (publishing.status.cloud.lastSyncOk == false ? " Son bulut eşitlemesi başarısız: \(publishing.status.cloud.lastSyncError ?? "")" : "")
        modeBanner.textColor = publishing.status.cloud.lastSyncOk == false ? Theme.accent : Theme.textSecondary

        if let err = model.error {
            errorBanner.message = err
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }
        viewSegment.selectedSegment = model.viewMode.rawValue
        scopeSegment.selectedSegment = model.showEntireMonth ? 1 : 0
        scopeSegment.isHidden = model.viewMode != .month

        gridCard.isHidden = model.viewMode == .log
        switch model.viewMode {
        case .month: rebuildMonthGrid()
        case .week: rebuildWeekGrid()
        case .log: break
        }
        if model.viewMode == .log { rebuildLog() } else { rebuildList() }
        lastViewMode = model.viewMode
    }

    private func clear(_ stack: NSStackView) {
        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
    }

    private func rebuildWeekdayHeader(withHourColumn: Bool, dates: [Date]? = nil) {
        clear(weekdayRow)
        if withHourColumn {
            let spacer = NSTextField.styledLabel("", font: Theme.smallFont)
            spacer.widthAnchor.constraint(equalToConstant: 40).isActive = true
            weekdayRow.distribution = .fill
            weekdayRow.addArrangedSubview(spacer)
        } else {
            weekdayRow.distribution = .fillEqually
        }
        var labels: [NSTextField] = []
        for (i, name) in Self.weekdayLabels.enumerated() {
            let text = dates.map { "\(name) \(Calendar.current.component(.day, from: $0[i]))" } ?? name
            let lbl = NSTextField.styledLabel(text, font: NSFont.systemFont(ofSize: 11, weight: .semibold), color: Theme.textSecondary)
            lbl.alignment = .center
            weekdayRow.addArrangedSubview(lbl)
            labels.append(lbl)
        }
        if withHourColumn, let first = labels.first {
            for lbl in labels.dropFirst() { lbl.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true }
        }
    }

    private func rebuildMonthGrid() {
        rebuildWeekdayHeader(withHourColumn: false)
        clear(gridHost)
        let cells = CalendarModel.monthGridDays(for: model.month)
        let today = CalendarDay(Date())
        for rowIdx in 0..<(cells.count / 7) {
            let weekRow = NSStackView()
            weekRow.orientation = .horizontal
            weekRow.distribution = .fillEqually
            weekRow.spacing = 8
            for colIdx in 0..<7 {
                let day = cells[rowIdx * 7 + colIdx]
                let cell = CalendarDayCellView(
                    day: day,
                    isToday: day == today,
                    isSelected: day != nil && day == model.selectedDay && !model.showEntireMonth,
                    entries: day.map { model.entries(on: $0) } ?? [],
                    moving: model.movingIds,
                    onSelectDay: { [weak self] picked in
                        self?.model.showEntireMonth = false
                        self?.model.selectedDay = picked
                    },
                    onOpenPost: { [weak self] contentId in
                        guard let self else { return }
                        Task { await self.model.openPost(contentId: contentId) }
                    },
                    onDrop: { [weak self] scheduleId, picked in
                        guard let self else { return false }
                        Task { await self.model.move(scheduleId: scheduleId, toDay: picked.date()) }
                        return true
                    },
                    onAdd: { [weak self] picked in self?.openScheduleSheet(day: picked) }
                )
                weekRow.addArrangedSubview(cell)
            }
            gridHost.addArrangedSubview(weekRow)
            weekRow.widthAnchor.constraint(equalTo: gridHost.widthAnchor).isActive = true
        }
    }

    private func rebuildWeekGrid() {
        let days = model.weekDays
        rebuildWeekdayHeader(withHourColumn: true, dates: days)
        clear(gridHost)
        let entries = model.listedEntries.filter { $0.scheduledAt != nil }
        let today = CalendarDay(Date())
        for hour in CalendarModel.weekHours {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 8
            row.distribution = .fill
            let hourLabel = NSTextField.styledLabel(String(format: "%02d:00", hour), font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium), color: Theme.textTertiary)
            hourLabel.alignment = .right
            hourLabel.widthAnchor.constraint(equalToConstant: 40).isActive = true
            row.addArrangedSubview(hourLabel)
            var cellViews: [NSView] = []
            for date in days {
                let day = CalendarDay(date)
                let slotEntries = entries.filter { $0.day == day && CalendarModel.weekRowHour(for: $0.scheduledAt ?? date) == hour }
                let cell = WeekHourCellView(
                    day: date, hour: hour, isToday: day == today, entries: slotEntries,
                    onOpenPost: { [weak self] contentId in
                        guard let self else { return }
                        Task { await self.model.openPost(contentId: contentId) }
                    },
                    onDrop: { [weak self] scheduleId, date, hour in
                        guard let self else { return false }
                        Task { await self.model.move(scheduleId: scheduleId, toDay: date, hour: hour) }
                        return true
                    }
                )
                row.addArrangedSubview(cell)
                cellViews.append(cell)
            }
            if let first = cellViews.first {
                for c in cellViews.dropFirst() { c.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true }
            }
            gridHost.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: gridHost.widthAnchor).isActive = true
        }
    }

    private func rebuildList() {
        clear(listStack)
        switch model.viewMode {
        case .week:
            listHeaderLabel.stringValue = "Bu haftanın programı"
        default:
            if !model.showEntireMonth, let day = model.selectedDay, day.monthKey == model.month {
                listHeaderLabel.stringValue = "\(TurkishFormat.longDay(day)) programı"
            } else {
                listHeaderLabel.stringValue = "\(TurkishFormat.monthName(model.month)) \(model.month.year) programı"
            }
        }
        let items = model.listedEntries
        if items.isEmpty {
            let empty = CardContainerView(padding: 18, spacing: 6)
            empty.contentStack.addArrangedSubview(NSTextField.styledLabel(
                "Bu aralıkta paylaşım yok. “Zamanla” ile onaylı bir postu takvime ekleyin.",
                font: Theme.rowFont, color: Theme.textSecondary))
            listStack.addArrangedSubview(empty)
            empty.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
            return
        }
        for entry in items {
            let row = CalendarScheduleRowView(
                entry: entry,
                busy: entry.scheduleId.map { model.cancellingIds.contains($0) || model.movingIds.contains($0) } ?? false,
                onOpenPost: { [weak self] in
                    guard let self, let cid = entry.contentId else { return }
                    Task { await self.model.openPost(contentId: cid) }
                },
                onCancel: { [weak self] in self?.confirmCancel(entry) },
                onRetry: { [weak self] in self?.openScheduleSheet(day: nil, retry: entry) },
                onOpenPermalink: {
                    guard let link = entry.permalink, let url = URL(string: link) else { return }
                    NSWorkspace.shared.open(url)
                }
            )
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
    }

    private func confirmCancel(_ entry: CalendarModel.CalendarEntry) {
        guard let sid = entry.scheduleId, let window = view.window else { return }
        let alert = NSAlert()
        alert.messageText = "Zamanlama iptal edilsin mi?"
        alert.informativeText = "“\(entry.title)” \(entry.platformText) için \(TurkishFormat.shortDay(entry.day)) \(entry.timeText) zamanlaması iptal edilecek. Post onaylı kalır, yeniden zamanlayabilirsiniz."
        alert.addButton(withTitle: "Zamanlamayı iptal et")
        alert.addButton(withTitle: "Vazgeç")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task { await self.model.cancelSchedule(sid) }
        }
    }

    private func rebuildLog() {
        clear(listStack)
        listHeaderLabel.stringValue = "Yayın günlüğü"
        let brandId = model.brandId
        let logs = app.publishing.recentLogs.filter { brandId == nil || $0.schedule.brandId == brandId }
        if logs.isEmpty {
            let empty = CardContainerView(padding: 18, spacing: 6)
            empty.contentStack.addArrangedSubview(NSTextField.styledLabel(
                "Henüz yayın denemesi yok. Zamanlanan postlar paylaşıldıkça burada bağlantılarıyla görünür.",
                font: Theme.rowFont, color: Theme.textSecondary, wraps: true))
            listStack.addArrangedSubview(empty)
            empty.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
            return
        }
        for item in logs {
            let row = PublishLogRowView(item: item)
            listStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
    }
}

// MARK: - Drag & drop

/// Pasteboard type carrying a schedule id inside the app.
extension NSPasteboard.PasteboardType {
    static let studioSchedule = NSPasteboard.PasteboardType("net.burakkoc.studio.schedule")
}

/// A small entry pill; pending schedules can be dragged to another day / hour.
private final class CalendarPostPillView: ThemedView, NSDraggingSource {
    private let entry: CalendarModel.CalendarEntry
    private let onClick: () -> Void
    private var mouseDownPoint: NSPoint?
    private var dragging = false

    init(entry: CalendarModel.CalendarEntry, showTime: Bool, moving: Bool, onClick: @escaping () -> Void) {
        self.entry = entry
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.canvas
        borderColor = entry.state?.needsOwner == true ? Theme.accent : Theme.border
        borderWidth = 1
        cornerRadius = 7
        alphaValue = moving ? 0.5 : 1
        var tip = "\(entry.title) · \(entry.statusLabel) (\(entry.timeText))"
        if let detail = entry.detail { tip += "\n\(detail)" }
        if entry.canMove { tip += "\nSürükleyerek başka güne / saate taşıyın." }
        toolTip = tip

        let dot = StatusDotView(color: entry.dotKind.color, size: 6)
        let text = showTime && entry.timeText != "—" ? "\(entry.timeText) \(entry.title)" : entry.title
        let title = NSTextField.styledLabel(text, font: NSFont.systemFont(ofSize: 10, weight: .medium), color: Theme.textPrimary)
        title.lineBreakMode = .byTruncatingTail
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
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        mouseDownPoint = convert(event.locationInWindow, from: nil)
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragging, entry.canMove, let scheduleId = entry.scheduleId, let start = mouseDownPoint else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - start.x, point.y - start.y) > 4 else { return }
        dragging = true
        let item = NSPasteboardItem()
        item.setString(scheduleId, forType: .studioSchedule)
        let dragItem = NSDraggingItem(pasteboardWriter: item)
        let image = NSImage(size: bounds.size, flipped: false) { [weak self] rect in
            guard let self else { return false }
            if let rep = self.bitmapImageRepForCachingDisplay(in: self.bounds) {
                self.cacheDisplay(in: self.bounds, to: rep)
                rep.draw(in: rect)
            }
            return true
        }
        dragItem.setDraggingFrame(bounds, contents: image)
        beginDraggingSession(with: [dragItem], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        if !dragging { onClick() }
        dragging = false
        mouseDownPoint = nil
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .withinApplication ? .move : []
    }
}

private extension CalendarModel.CalendarEntry.DotKind {
    var color: NSColor {
        switch self {
        case .scheduled: Theme.ink
        case .published: Theme.textTertiary
        case .approved: Theme.textTertiary
        case .error: Theme.accent
        case .planned: Theme.textSecondary
        }
    }
}

/// Accepts dropped schedule pills and highlights while hovered.
private class ScheduleDropView: ThemedView {
    var onDropSchedule: ((EntityID) -> Bool)?
    private var baseBorder: NSColor?

    func enableDrop() { registerForDraggedTypes([.studioSchedule]) }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard sender.draggingPasteboard.string(forType: .studioSchedule) != nil else { return [] }
        baseBorder = borderColor
        borderColor = Theme.ink
        borderWidth = 1.5
        return .move
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) {
        borderColor = baseBorder
        borderWidth = 1
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        borderColor = baseBorder
        borderWidth = 1
        guard let id = sender.draggingPasteboard.string(forType: .studioSchedule) else { return false }
        return onDropSchedule?(id) ?? false
    }
}

private final class CalendarDayCellView: ScheduleDropView {
    private let day: CalendarDay?
    private let onSelectDay: (CalendarDay) -> Void
    private let onAdd: (CalendarDay) -> Void

    init(
        day: CalendarDay?, isToday: Bool, isSelected: Bool, entries: [CalendarModel.CalendarEntry], moving: Set<EntityID>,
        onSelectDay: @escaping (CalendarDay) -> Void, onOpenPost: @escaping (EntityID) -> Void,
        onDrop: @escaping (EntityID, CalendarDay) -> Bool, onAdd: @escaping (CalendarDay) -> Void
    ) {
        self.day = day
        self.onSelectDay = onSelectDay
        self.onAdd = onAdd
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        cornerRadius = 12
        heightAnchor.constraint(equalToConstant: 96).isActive = true

        guard let day else {
            backgroundColor = Theme.fill.withAlphaComponent(0.35)
            borderWidth = 0
            return
        }
        enableDrop()
        onDropSchedule = { onDrop($0, day) }
        backgroundColor = isSelected ? Theme.fillStrong : Theme.fill
        borderColor = isSelected ? Theme.ink : (isToday ? Theme.textSecondary : Theme.hairline)
        borderWidth = 1

        let dayNumber = NSTextField.styledLabel(
            "\(day.day)",
            font: NSFont.systemFont(ofSize: 12, weight: isToday || isSelected ? .bold : .medium),
            color: Theme.textPrimary)
        let vStack = NSStackView()
        vStack.orientation = .vertical
        vStack.alignment = .leading
        vStack.spacing = 4
        vStack.translatesAutoresizingMaskIntoConstraints = false
        vStack.addArrangedSubview(dayNumber)
        for entry in entries.prefix(2) {
            let pill = CalendarPostPillView(entry: entry, showTime: true, moving: entry.scheduleId.map { moving.contains($0) } ?? false) {
                if let cid = entry.contentId { onOpenPost(cid) }
            }
            vStack.addArrangedSubview(pill)
            pill.widthAnchor.constraint(equalTo: vStack.widthAnchor).isActive = true
        }
        if entries.count > 2 {
            vStack.addArrangedSubview(NSTextField.styledLabel("+\(entries.count - 2) daha", font: NSFont.systemFont(ofSize: 10), color: Theme.textSecondary))
        }
        addSubview(vStack)
        NSLayoutConstraint.activate([
            vStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            vStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            vStack.topAnchor.constraint(equalTo: topAnchor, constant: 7),
        ])
        toolTip = "Çift tıklayın: bu güne zamanla"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        var spoken = [Self.spokenDate.string(from: day.date()), entries.isEmpty ? "içerik yok" : "\(entries.count) içerik"]
        if isToday { spoken.append("bugün") }
        if isSelected { spoken.append("seçili") }
        setAccessibilityLabel(spoken.joined(separator: ", "))
        setAccessibilityHelp("Seçmek için bas; bu güne zamanlamak için çift tıkla.")
    }

    private static let spokenDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.dateFormat = "d MMMM EEEE"
        return formatter
    }()

    override func accessibilityPerformPress() -> Bool {
        guard let day else { return false }
        onSelectDay(day)
        return true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        guard let day else { return }
        if event.clickCount == 2 { onAdd(day) } else { onSelectDay(day) }
    }
}

private final class WeekHourCellView: ScheduleDropView {
    init(
        day: Date, hour: Int, isToday: Bool, entries: [CalendarModel.CalendarEntry],
        onOpenPost: @escaping (EntityID) -> Void, onDrop: @escaping (EntityID, Date, Int) -> Bool
    ) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        cornerRadius = 6
        backgroundColor = isToday ? Theme.fillStrong.withAlphaComponent(0.6) : Theme.fill.withAlphaComponent(0.6)
        borderColor = Theme.hairline
        borderWidth = 1
        enableDrop()
        onDropSchedule = { onDrop($0, day, hour) }
        heightAnchor.constraint(greaterThanOrEqualToConstant: 26).isActive = true

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        for entry in entries {
            let pill = CalendarPostPillView(entry: entry, showTime: true, moving: false) {
                if let cid = entry.contentId { onOpenPost(cid) }
            }
            stack.addArrangedSubview(pill)
            pill.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -3),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

private final class CalendarScheduleRowView: ThemedView {
    private let onOpenPost: () -> Void

    init(
        entry: CalendarModel.CalendarEntry, busy: Bool,
        onOpenPost: @escaping () -> Void, onCancel: @escaping () -> Void, onRetry: @escaping () -> Void,
        onOpenPermalink: @escaping () -> Void
    ) {
        self.onOpenPost = onOpenPost
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.canvas
        borderColor = entry.state?.needsOwner == true ? Theme.accent : Theme.border
        borderWidth = 1
        cornerRadius = 14

        let dot = StatusDotView(color: entry.dotKind.color, size: 8)
        let dateTime = NSTextField.styledLabel(
            "\(TurkishFormat.shortDay(entry.day)) · \(entry.timeText)",
            font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold), color: Theme.textSecondary)
        let title = NSTextField.styledLabel(entry.title, font: NSFont.systemFont(ofSize: 13, weight: .semibold), color: Theme.textPrimary)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let metaParts = [entry.platformText, entry.accountHandle, entry.statusLabel].compactMap { $0 }
        let meta = NSTextField.styledLabel(metaParts.joined(separator: " · "), font: Theme.smallFont, color: Theme.textSecondary)
        let infoCol = NSStackView(views: [title, meta])
        infoCol.orientation = .vertical
        infoCol.alignment = .leading
        infoCol.spacing = 2
        if let detail = entry.detail {
            let detailLabel = NSTextField.styledLabel(detail, font: Theme.smallFont, color: entry.state?.needsOwner == true ? Theme.accent : Theme.textTertiary, wraps: true)
            detailLabel.preferredMaxLayoutWidth = 520
            infoCol.addArrangedSubview(detailLabel)
        }
        infoCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        var rowViews: [NSView] = [dot, dateTime, infoCol, spacer]
        if busy {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            rowViews.append(spinner)
        }
        if let permalink = entry.permalink, !permalink.isEmpty {
            let open = PillButton(title: "Yayını aç ↗", kind: .outline, height: 24, action: onOpenPermalink)
            open.toolTip = permalink
            rowViews.append(open)
        }
        if entry.canRetry {
            rowViews.append(PillButton(title: "Yeniden dene", kind: .primary, height: 24, action: onRetry))
        }
        if entry.canCancel {
            let cancel = PillButton(title: "İptal et", kind: .secondary, height: 24, action: onCancel)
            cancel.isEnabled = !busy
            rowViews.append(cancel)
        }
        rowViews.append(PillButton(title: "Postu aç", kind: .secondary, height: 24, action: onOpenPost))

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
        if event.clickCount == 2 { onOpenPost() } else { super.mouseDown(with: event) }
    }
}

/// One publish attempt in the log: time, post, account, result, permalink.
private final class PublishLogRowView: ThemedView {
    init(item: PublishLogFeedItem) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.canvas
        borderColor = item.log.status == .failed ? Theme.accent : Theme.border
        borderWidth = 1
        cornerRadius = 14

        let when = item.log.finishedAt ?? item.log.startedAt
        let time = NSTextField.styledLabel(TurkishFormat.dayAndTime(when), font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold), color: Theme.textSecondary)
        let status: String = switch item.log.status {
        case .succeeded: "Yayınlandı"
        case .failed: "Başarısız"
        case .started: "Yayınlanıyor"
        case .unknown: "—"
        }
        let title = NSTextField.styledLabel(item.contentTitle, font: NSFont.systemFont(ofSize: 13, weight: .semibold))
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let meta = NSTextField.styledLabel(
            "\(item.schedule.platform.displayName) · \(item.accountHandle) · \(status)\(item.log.attempt > 1 ? " · \(item.log.attempt). deneme" : "")",
            font: Theme.smallFont, color: Theme.textSecondary)
        let col = NSStackView(views: [title, meta])
        col.orientation = .vertical
        col.alignment = .leading
        col.spacing = 2
        if let error = item.log.error, item.log.status == .failed {
            let label = NSTextField.styledLabel(error, font: Theme.smallFont, color: Theme.accent, wraps: true)
            label.preferredMaxLayoutWidth = 560
            col.addArrangedSubview(label)
        }
        col.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        var views: [NSView] = [StatusDotView(color: item.log.status == .failed ? Theme.accent : Theme.ink, size: 8), time, col, spacer]
        if let link = item.log.permalink ?? item.schedule.permalink, let url = URL(string: link) {
            let open = PillButton(title: "Yayını aç ↗", kind: .outline, height: 24) { NSWorkspace.shared.open(url) }
            open.toolTip = link
            views.append(open)
        }
        let row = NSStackView(views: views)
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
}
