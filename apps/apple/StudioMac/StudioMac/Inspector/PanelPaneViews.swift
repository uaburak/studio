import AppKit
import StudioKit

// The right panel's Takvim, Medya, Marka and iPhone panes (Claude Code: every top bar icon
// swaps the panel; the centre keeps the conversation). Each pane keeps its own views and
// observes its own data, so a search field keeps its focus while the data changes.

// MARK: - Pane base

/// A scrolling column with the panel's padding; `InfoPanelViewController` swaps it in.
class PanelPaneView: NSView {
    unowned let app: AppModel
    let scrollView = NSScrollView()
    let stack = NSStackView()
    private let documentView = FlippedDocumentView()

    init(app: AppModel) {
        self.app = app
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let clip = FlippedClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView
        scrollView.applyMinimalScroller()

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        documentView.addSubview(stack)
        addSubview(scrollView)

        let padding = Theme.Panel.horizontalPadding
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            documentView.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            documentView.topAnchor.constraint(equalTo: clip.topAnchor),
            stack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor, constant: padding),
            stack.trailingAnchor.constraint(equalTo: documentView.trailingAnchor, constant: -padding),
            stack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -16),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func add(_ view: NSView, spacingAfter: CGFloat? = nil, fullWidth: Bool = true) {
        stack.addArrangedSubview(view)
        if fullWidth { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        if let spacingAfter { stack.setCustomSpacing(spacingAfter, after: view) }
    }

    /// Removes the rows after the first `keeping` views.
    func removeArranged(after keeping: Int = 0) {
        for view in stack.arrangedSubviews.dropFirst(keeping) {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }
}

// MARK: - Small building blocks

/// Small grey section header ("Renkler", "Bağlı iPhone'lar").
final class PaneHeaderLabel: NSTextField {
    convenience init(_ text: String) {
        self.init(labelWithString: text)
        font = Theme.Panel.headerFont
        textColor = Theme.textSecondary
        setAccessibilityRole(.staticText)
    }
}

/// "Takvimi aç ›": a small grey text link (pointing hand: it is a link).
final class PaneLinkView: TapControl {
    private let onTap: () -> Void
    let title: String

    init(title: String, action: @escaping () -> Void) {
        self.title = title
        self.onTap = action
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(title)
        let label = NSTextField.styledLabel(title, font: Theme.captionFont, color: Theme.textSecondary)
        let chevron = NSImageView()
        chevron.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        chevron.contentTintColor = Theme.textTertiary
        let row = NSStackView(views: [label, chevron])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func mouseDown(with event: NSEvent) { onTap() }
    override func performTap() { onTap() }
}

/// A clickable row with Claude's subtle rounded hover fill (no pointing hand: not a link).
class PaneHoverControl: TapControl {
    private var trackingArea: NSTrackingArea?
    var hovering = false {
        didSet { if hovering != oldValue { refreshFill() } }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.cornerCurve = .continuous
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func refreshFill() {
        layer?.backgroundColor = hovering ? resolvedCGColor(Theme.barButtonHover) : nil
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshFill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
}

@MainActor
private func paneDivider() -> NSView {
    let holder = NSView()
    holder.translatesAutoresizingMaskIntoConstraints = false
    let line = HairlineView()
    holder.addSubview(line)
    NSLayoutConstraint.activate([
        holder.heightAnchor.constraint(equalToConstant: Theme.Panel.sectionSpacing * 2 + 1),
        line.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
        line.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
        line.centerYAnchor.constraint(equalTo: holder.centerYAnchor),
    ])
    return holder
}

@MainActor
private func paneNote(_ text: String, color: NSColor = Theme.textSecondary) -> NSTextField {
    let label = NSTextField.styledLabel(text, font: Theme.captionFont, color: color, wraps: true)
    label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return label
}

extension MiniCalendar.DotKind {
    var paneColor: NSColor {
        switch self {
        case .scheduled: Theme.ink
        case .published: Theme.textTertiary
        case .approved: Theme.textSecondary
        case .error: Theme.accent
        case .planned: Theme.textSecondary
        }
    }
}

// MARK: - Takvim

/// Compact month with dots, the selected day's agenda, "Takvimi aç". Clicking a post opens it
/// over the centre (the conversation stays); a pending schedule can be dragged onto another day.
final class CalendarPaneView: PanelPaneView {
    private(set) var month: MonthKey
    private(set) var selectedDay: CalendarDay
    /// What the pane shows now (tests).
    private(set) var content: MiniCalendar?
    private let titleLabel = NSTextField.styledLabel("", font: Theme.titleFont, color: Theme.textPrimary)
    let grid = MiniMonthGridView()
    private let agendaTitle = PaneHeaderLabel("")
    private let agendaList = NSStackView()
    private let statusNote = paneNote("")
    private var requestedBrand: EntityID?
    private var observation: ObservationToken?

    init(app: AppModel, today: CalendarDay = CalendarDay(Date())) {
        self.month = today.monthKey
        self.selectedDay = today
        super.init(app: app)
        build()
        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        let previous = GlyphButton(symbol: "chevron.left", size: 11, weight: .semibold, diameter: 24) { [weak self] in self?.showMonth(self?.month.previous) }
        previous.toolTip = "Önceki ay"
        let next = GlyphButton(symbol: "chevron.right", size: 11, weight: .semibold, diameter: 24) { [weak self] in self?.showMonth(self?.month.next) }
        next.toolTip = "Sonraki ay"
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let today = PaneLinkView(title: "Bugün") { [weak self] in self?.goToday() }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let navigation = NSStackView(views: [titleLabel, spacer, today, previous, next])
        navigation.orientation = .horizontal
        navigation.alignment = .centerY
        navigation.spacing = 4
        navigation.setCustomSpacing(10, after: today)
        add(navigation, spacingAfter: 8)

        grid.onSelect = { [weak self] day in self?.select(day) }
        grid.onDropSchedule = { [weak self] scheduleId, day in self?.move(scheduleId, to: day) ?? false }
        add(grid, spacingAfter: 0)
        add(paneDivider())

        add(agendaTitle, spacingAfter: 6)
        agendaList.orientation = .vertical
        agendaList.alignment = .leading
        agendaList.spacing = 2
        add(agendaList, spacingAfter: 6)
        add(statusNote, spacingAfter: 8)
        let open = PaneLinkView(title: "Takvimi aç") { [weak self] in self?.openFullCalendar() }
        open.toolTip = "Tam takvim ekranı (⇧⌘K)"
        add(open, fullWidth: false)
    }

    // MARK: Actions

    private func showMonth(_ next: MonthKey?) {
        guard let next else { return }
        month = next
        selectedDay = MiniCalendar.defaultDay(in: next, entries: app.calendar.allEntries, today: CalendarDay(Date()))
        render()
    }

    func goToday() {
        let today = CalendarDay(Date())
        month = today.monthKey
        selectedDay = today
        render()
    }

    func select(_ day: CalendarDay) {
        selectedDay = day
        if day.monthKey != month { month = day.monthKey }
        render()
    }

    private func move(_ scheduleId: EntityID, to day: CalendarDay) -> Bool {
        guard app.calendar.allEntries.contains(where: { $0.scheduleId == scheduleId && $0.canMove }) else { return false }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if await self.app.calendar.move(scheduleId: scheduleId, toDay: day.date()) { self.select(day) }
        }
        return true
    }

    func openPost(_ item: MiniCalendar.AgendaItem) {
        guard let contentId = item.contentId else { return }
        Task { await app.calendar.openPost(contentId: contentId) }
    }

    /// The full Takvim screen, on the month and day the pane shows.
    func openFullCalendar() {
        app.calendar.month = month
        app.calendar.selectedDay = selectedDay
        app.calendar.weekAnchor = selectedDay.date()
        app.navigate(to: .calendar)
    }

    // MARK: Render

    private func render() {
        let calendar = app.calendar
        let brandId = app.currentBrandId
        if let brandId, calendar.loadedBrand != brandId, requestedBrand != brandId, !calendar.isLoading {
            requestedBrand = brandId
            Task { await calendar.load() }
        }
        let entries = calendar.allEntries
        let moving = calendar.movingIds
        let next = MiniCalendar.make(month: month, selected: selectedDay, entries: entries, today: CalendarDay(Date()))
        content = next
        titleLabel.stringValue = next.title
        grid.setCells(next.cells)

        agendaTitle.stringValue = next.agendaTitle.map { next.agenda.isEmpty ? $0 : "\($0) · \(next.agenda.count)" } ?? ""
        agendaList.arrangedSubviews.forEach {
            agendaList.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for item in next.agenda {
            let row = AgendaRowView(item: item, moving: item.scheduleId.map(moving.contains) ?? false) { [weak self] in self?.openPost(item) }
            agendaList.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: agendaList.widthAnchor).isActive = true
        }

        var notes: [String] = []
        if brandId == nil {
            notes.append("Marka seçilmedi.")
        } else if let error = calendar.error {
            notes.append(error)
        } else if calendar.isLoading && entries.isEmpty {
            notes.append("Yükleniyor…")
        } else if next.agenda.isEmpty {
            notes.append("Bu gün için post yok.")
        }
        statusNote.stringValue = notes.joined(separator: "\n")
        statusNote.textColor = calendar.error != nil ? Theme.accent : Theme.textSecondary
        statusNote.isHidden = notes.isEmpty
    }
}

/// Weekday initials and the month's day cells, laid out by frames in seven equal columns.
final class MiniMonthGridView: NSView {
    static let headerHeight: CGFloat = 22
    static let rowHeight: CGFloat = 34

    var onSelect: ((CalendarDay) -> Void)?
    var onDropSchedule: ((EntityID, CalendarDay) -> Bool)?
    private var headerLabels: [NSTextField] = []
    private(set) var cellViews: [MiniDayCellView] = []
    private var cells: [MiniCalendar.Cell] = []

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Ay görünümü")
        headerLabels = MiniCalendar.weekdayLabels.map { text in
            let label = NSTextField.styledLabel(text, font: Theme.smallFont, color: Theme.textTertiary)
            label.alignment = .center
            addSubview(label)
            return label
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setCells(_ next: [MiniCalendar.Cell]) {
        guard next != cells else { return }
        let rowsChanged = (next.count + 6) / 7 != (cells.count + 6) / 7
        cells = next
        if cellViews.count != next.count {
            cellViews.forEach { $0.removeFromSuperview() }
            cellViews = next.map { _ in
                let view = MiniDayCellView()
                view.onSelect = { [weak self] day in self?.onSelect?(day) }
                view.onDropSchedule = { [weak self] id, day in self?.onDropSchedule?(id, day) ?? false }
                addSubview(view)
                return view
            }
        }
        for (view, cell) in zip(cellViews, next) { view.info = cell }
        if rowsChanged { invalidateIntrinsicContentSize() }
        needsLayout = true
    }

    var rowCount: Int { (cells.count + 6) / 7 }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: Self.headerHeight + CGFloat(rowCount) * Self.rowHeight)
    }

    override func layout() {
        super.layout()
        let column = bounds.width / 7
        for (index, label) in headerLabels.enumerated() {
            let size = label.fittingSize
            label.frame = NSRect(x: CGFloat(index) * column, y: (Self.headerHeight - size.height) / 2, width: column, height: size.height)
        }
        for (index, view) in cellViews.enumerated() {
            let row = CGFloat(index / 7)
            let col = CGFloat(index % 7)
            view.frame = NSRect(x: col * column, y: Self.headerHeight + row * Self.rowHeight, width: column, height: Self.rowHeight)
        }
    }
}

/// One day: its number (today in the accent, the selected day on a round fill) and up to three
/// dots for the kinds of posts that day. Pending schedules can be dropped on it.
final class MiniDayCellView: TapControl {
    var info = MiniCalendar.Cell(day: nil, isToday: false, isSelected: false, dots: [], count: 0) {
        didSet {
            guard info != oldValue else { return }
            needsDisplay = true
            updateAccessibility()
        }
    }
    var onSelect: ((CalendarDay) -> Void)?
    var onDropSchedule: ((EntityID, CalendarDay) -> Bool)?
    private var hovering = false { didSet { needsDisplay = true } }
    private var dropTargeted = false { didSet { needsDisplay = true } }
    private var trackingArea: NSTrackingArea?

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.studioSchedule])
        updateAccessibility()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func updateAccessibility() {
        guard let day = info.day else {
            setAccessibilityElement(false)
            return
        }
        setAccessibilityElement(true)
        var label = TurkishFormat.longDay(day)
        if info.count > 0 { label += ", \(info.count) post" }
        if info.isToday { label += ", bugün" }
        setAccessibilityLabel(label)
        setAccessibilitySelected(info.isSelected)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let day = info.day else { return }
        let circle = NSRect(x: bounds.midX - 12, y: 2, width: 24, height: 24)
        if dropTargeted {
            Theme.ink.setStroke()
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 1), xRadius: 6, yRadius: 6)
            path.lineWidth = 1.5
            path.stroke()
        }
        if info.isSelected {
            (info.isToday ? Theme.accent : Theme.fillStrong).setFill()
            NSBezierPath(ovalIn: circle).fill()
        } else if hovering {
            Theme.barButtonHover.setFill()
            NSBezierPath(ovalIn: circle).fill()
        }
        let color: NSColor = info.isSelected && info.isToday ? Theme.onAccent : (info.isToday ? Theme.accent : Theme.textPrimary)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: info.isToday || info.isSelected ? .semibold : .regular)
        let text = NSAttributedString(string: "\(day.day)", attributes: [.font: font, .foregroundColor: color])
        let size = text.size()
        text.draw(at: NSPoint(x: circle.midX - size.width / 2, y: circle.midY - size.height / 2))

        let dot: CGFloat = 4
        let gap: CGFloat = 3
        let total = CGFloat(info.dots.count) * dot + CGFloat(max(0, info.dots.count - 1)) * gap
        var x = bounds.midX - total / 2
        for kind in info.dots {
            kind.paneColor.setFill()
            NSBezierPath(ovalIn: NSRect(x: x, y: circle.maxY + 2, width: dot, height: dot)).fill()
            x += dot + gap
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = info.day != nil }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { performTap() }

    override func performTap() {
        guard let day = info.day else { return }
        onSelect?(day)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard info.day != nil, sender.draggingPasteboard.string(forType: .studioSchedule) != nil else { return [] }
        dropTargeted = true
        return .move
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) { dropTargeted = false }
    override func draggingEnded(_ sender: any NSDraggingInfo) { dropTargeted = false }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        dropTargeted = false
        guard let day = info.day, let id = sender.draggingPasteboard.string(forType: .studioSchedule) else { return false }
        return onDropSchedule?(id, day) ?? false
    }
}

/// "09:30  ◎  Kasım kampanyası …… Zamanlandı": click opens the post; a pending schedule drags.
final class AgendaRowView: PaneHoverControl, NSDraggingSource {
    let item: MiniCalendar.AgendaItem
    private let onOpen: () -> Void
    private var mouseDownPoint: NSPoint?
    private var dragging = false

    init(item: MiniCalendar.AgendaItem, moving: Bool, onOpen: @escaping () -> Void) {
        self.item = item
        self.onOpen = onOpen
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        alphaValue = moving ? 0.5 : 1
        setAccessibilityLabel("\(item.time == "—" ? "" : item.time + ", ")\(item.title), \(item.platformText), \(item.status)")
        var tip = "\(item.title) · \(item.platformText) · \(item.status)"
        if item.canMove { tip += "\nSürükleyip başka bir güne bırakarak taşıyın." }
        toolTip = tip

        let time = NSTextField.styledLabel(item.time, font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular), color: Theme.textSecondary)
        time.widthAnchor.constraint(equalToConstant: 38).isActive = true
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: item.platform?.panelSymbol ?? "square.stack", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        icon.contentTintColor = Theme.textSecondary
        icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
        let title = NSTextField.styledLabel(item.title, font: Theme.Panel.rowFont, color: Theme.textPrimary)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let status = NSTextField.styledLabel(item.status, font: Theme.smallFont, color: item.needsOwner ? Theme.accent : Theme.textTertiary)
        status.lineBreakMode = .byTruncatingTail
        status.setContentCompressionResistancePriority(.init(745), for: .horizontal)
        let row = NSStackView(views: [time, icon, title, spacer, status])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        let trailing = row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6)
        trailing.priority = .init(999)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 30),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            trailing,
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        let menu = NSMenu()
        menu.addItem(ClosureMenuItem(title: "Postu aç", action: onOpen))
        self.menu = menu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func performTap() { onOpen() }

    override func mouseDown(with event: NSEvent) {
        mouseDownPoint = convert(event.locationInWindow, from: nil)
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragging, item.canMove, let scheduleId = item.scheduleId, let start = mouseDownPoint else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - start.x, point.y - start.y) > 4 else { return }
        dragging = true
        let pasteboardItem = NSPasteboardItem()
        pasteboardItem.setString(scheduleId, forType: .studioSchedule)
        let dragItem = NSDraggingItem(pasteboardWriter: pasteboardItem)
        dragItem.setDraggingFrame(bounds, contents: snapshot())
        beginDraggingSession(with: [dragItem], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        if !dragging, mouseDownPoint != nil, bounds.contains(convert(event.locationInWindow, from: nil)) { onOpen() }
        dragging = false
        mouseDownPoint = nil
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .withinApplication ? .move : []
    }

    private func snapshot() -> NSImage {
        let image = NSImage(size: bounds.size)
        if let rep = bitmapImageRepForCachingDisplay(in: bounds) {
            cacheDisplay(in: bounds, to: rep)
            image.addRepresentation(rep)
        }
        return image
    }
}

// MARK: - Medya

extension NSPasteboard.PasteboardType {
    /// An asset id dragged inside the app (the composer can attach it without a new upload later).
    static let studioAsset = NSPasteboard.PasteboardType("net.burakkoc.studio.asset")
}

/// What a media tile does: preview (the existing Quick Look preview until the shared lightbox
/// lands), files for dragging, "Sohbete ekle".
@MainActor
enum MediaPanelActions {
    /// Folder of the files a dragged tile hands over (the composer imports them like any file).
    static var dragFolder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Studio/Sürükle", isDirectory: true)
    }

    /// A click on a picture: the shared lightbox over the window, browsing the pane's pictures
    /// (it zooms from and back to the tiles); the Quick Look preview when there is no window.
    static func preview(_ asset: Asset, from tile: MediaTileView? = nil, app: AppModel) {
        guard MediaPaneContent.isImage(asset) else {
            NSSound.beep()
            return
        }
        let tiles = ((tile?.superview as? MediaTilesGridView)?.tiles ?? []).filter { MediaPaneContent.isImage($0.asset) }
        let pictures = tiles.isEmpty ? [asset] : tiles.map(\.asset)
        let start = pictures.firstIndex { $0.id == asset.id } ?? 0
        let items = pictures.map { ImageLightbox.Item(assetId: $0.id, caption: $0.originalFilename) }
        let shown = ImageLightbox.present(
            items: items, startIndex: start, from: tile, in: tile?.window, imageStore: app.images,
            sourceView: { [weak tile] index in tiles.indices.contains(index) ? tiles[index] : tile }
        )
        if shown == nil {
            PostQuickLook.shared.toggle(assetIds: [asset.id], service: app.dataService)
        }
    }

    /// "Kasım afişi.png" → a file named like the asset with the cached picture (PNG stays PNG).
    static func dragFile(for asset: Asset, image: NSImage) -> URL? {
        let folder = dragFolder.appendingPathComponent(asset.id, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let png = asset.mimeType == "image/png"
        let url = folder.appendingPathComponent(fileBaseName(asset) + (png ? ".png" : ".jpg"))
        if FileManager.default.fileExists(atPath: url.path) { return url }
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        let data = png
            ? bitmap.representation(using: .png, properties: [:])
            : bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.92])
        guard let data, (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url
    }

    static func fileBaseName(_ asset: Asset) -> String {
        let raw = ((asset.originalFilename ?? "") as NSString).deletingPathExtension
        let cleaned = raw.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-").trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty ? "gorsel-\(asset.id)" : cleaned
    }

    /// The composer on screen: the new chat's or the open conversation's (nil elsewhere).
    static func activeComposer(_ app: AppModel) -> ComposerModel? {
        switch app.route {
        case .newChat: app.newChat.composer
        case .conversation(let id): app.conversationModel(id).composer
        case .posts, .calendar, .media: nil
        }
    }

    /// "Sohbete ekle": the picture joins the composer's attachments like a dropped file.
    @discardableResult
    static func attachToChat(_ asset: Asset, app: AppModel) -> Bool {
        guard let composer = activeComposer(app), let image = app.images.image(asset.id),
              let url = dragFile(for: asset, image: image), let imported = try? ImageImport.from(url: url) else {
            NSSound.beep()
            return false
        }
        composer.add([imported])
        return true
    }
}

/// Search, a 3-column grid of square thumbnails, "Tümü". Click previews; drag a picture into
/// the composer to attach it.
final class MediaPaneView: PanelPaneView {
    let searchField = NSSearchField()
    let grid = MediaTilesGridView()
    private let statusNote = paneNote("")
    private let uploadButton: PillButton
    private var allLink: PaneLinkView!
    private var requestedBrand: EntityID?
    private var observation: ObservationToken?
    /// Assets on screen after the search (tests).
    private(set) var shownAssets: [Asset] = []

    override init(app: AppModel) {
        uploadButton = PillButton(title: "Yükle", kind: .secondary, height: 24) { [weak app] in app?.media.pickAndUploadFiles() }
        super.init(app: app)
        searchField.placeholderString = "Medyada ara"
        searchField.sendsSearchStringImmediately = true
        searchField.focusRingType = .none
        searchField.target = self
        searchField.action = #selector(searchChanged)
        searchField.setAccessibilityLabel("Medyada ara")
        add(searchField, spacingAfter: 10)
        grid.app = app
        add(grid, spacingAfter: 10)
        add(statusNote, spacingAfter: 8)
        add(uploadButton, spacingAfter: 8, fullWidth: false)
        allLink = PaneLinkView(title: "Tümü") { [weak app] in app?.navigate(to: .media) }
        allLink.toolTip = "Medya kütüphanesi (⇧⌘M)"
        add(allLink, fullWidth: false)
        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func searchChanged() { render() }

    func search(_ text: String) {
        searchField.stringValue = text
        render()
    }

    private func render() {
        let media = app.media
        let brandId = app.currentBrandId
        if let brandId, media.loadedBrand != brandId, requestedBrand != brandId, !media.isLoading {
            requestedBrand = brandId
            Task { await media.load() }
        }
        let assets = media.loadedBrand == brandId ? media.assets : []
        let query = searchField.stringValue
        shownAssets = MediaPaneContent.filter(assets, query: query)
        grid.setAssets(shownAssets)
        grid.isHidden = shownAssets.isEmpty

        var note: String?
        var color = Theme.textSecondary
        if brandId == nil {
            note = "Marka seçilmedi."
        } else if let error = media.error {
            note = error
            color = Theme.accent
        } else if let progress = media.uploadProgress {
            note = "Yükleniyor… %\(Int(progress * 100))"
        } else if media.isLoading && assets.isEmpty {
            note = "Yükleniyor…"
        } else if assets.isEmpty {
            note = "Bu markada henüz medya yok."
        } else if shownAssets.isEmpty {
            note = "“\(query)” ile eşleşen medya yok."
        } else if shownAssets.contains(where: MediaPaneContent.isImage) {
            note = "Bir görseli sohbete sürükleyerek ekleyebilirsin."
            color = Theme.textTertiary
        }
        statusNote.stringValue = note ?? ""
        statusNote.textColor = color
        statusNote.isHidden = note == nil
        uploadButton.isHidden = brandId == nil || !assets.isEmpty
        allLink.setAccessibilityLabel(assets.isEmpty ? "Tümü" : "Tümü, \(assets.count)")
        allLink.isHidden = brandId == nil
    }
}

/// Square tiles in `MediaPaneContent.columns` columns, laid out by frames; tiles are reused by id.
final class MediaTilesGridView: NSView {
    weak var app: AppModel?
    private(set) var tiles: [MediaTileView] = []
    private var lastWidth: CGFloat = 0

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setAssets(_ assets: [Asset]) {
        guard assets.map(\.id) != tiles.map(\.asset.id) || zip(assets, tiles).contains(where: { $0 != $1.asset }) else { return }
        guard let app else { return }
        var reusable = Dictionary(tiles.map { ($0.asset.id, $0) }, uniquingKeysWith: { a, _ in a })
        var next: [MediaTileView] = []
        for asset in assets {
            if let tile = reusable.removeValue(forKey: asset.id), tile.asset == asset {
                next.append(tile)
            } else {
                let tile = MediaTileView(app: app, asset: asset)
                addSubview(tile)
                next.append(tile)
            }
        }
        reusable.values.forEach { $0.removeFromSuperview() }
        tiles = next
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    override var intrinsicContentSize: NSSize {
        let width = bounds.width > 10 ? bounds.width : Theme.inspectorWidth - 2 * Theme.Panel.horizontalPadding
        return NSSize(width: NSView.noIntrinsicMetric, height: MediaPaneContent.gridHeight(count: tiles.count, width: width))
    }

    override func layout() {
        super.layout()
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
        let side = MediaPaneContent.tileSide(width: bounds.width)
        let gap = MediaPaneContent.spacing
        for (index, tile) in tiles.enumerated() {
            let column = CGFloat(index % MediaPaneContent.columns)
            let row = CGFloat(index / MediaPaneContent.columns)
            tile.frame = NSRect(x: column * (side + gap), y: row * (side + gap), width: side, height: side)
        }
    }
}

/// One square thumbnail: rounded, a subtle dim on hover, "AI" on generated pictures.
final class MediaTileView: NSView, NSDraggingSource {
    unowned let app: AppModel
    let asset: Asset
    private let dim = ThemedView()
    private var trackingArea: NSTrackingArea?
    private var mouseDownPoint: NSPoint?
    private var dragging = false

    override var isFlipped: Bool { true }

    init(app: AppModel, asset: Asset) {
        self.app = app
        self.asset = asset
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true

        let base = ThemedView()
        base.backgroundColor = Theme.fill
        base.frame = bounds
        base.autoresizingMask = [.width, .height]
        addSubview(base)
        if MediaPaneContent.isImage(asset) {
            let image = AssetImageView(store: app.images, assetId: asset.id, contentMode: .fill, cornerRadius: 8)
            image.frame = bounds
            image.autoresizingMask = [.width, .height]
            addSubview(image)
        } else {
            let symbol = switch asset.kind {
            case .video: "play.rectangle"
            case .document: "doc.richtext"
            case .audio: "waveform"
            case .font: "textformat"
            default: "doc"
            }
            let icon = NSImageView()
            icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 20, weight: .regular))
            icon.contentTintColor = Theme.textSecondary
            icon.imageAlignment = .alignCenter
            icon.frame = bounds
            icon.autoresizingMask = [.width, .height]
            addSubview(icon)
        }
        if asset.source == .generated {
            let badge = NSTextField.styledLabel("AI", font: NSFont.systemFont(ofSize: 9, weight: .bold), color: .white)
            badge.wantsLayer = true
            badge.drawsBackground = true
            badge.backgroundColor = NSColor.black.withAlphaComponent(0.6)
            badge.layer?.cornerRadius = 4
            badge.alignment = .center
            badge.frame = NSRect(x: 4, y: 4, width: 18, height: 13)
            addSubview(badge)
        }
        dim.backgroundColor = NSColor.black.withAlphaComponent(0.16)
        dim.frame = bounds
        dim.autoresizingMask = [.width, .height]
        dim.isHidden = true
        addSubview(dim)

        let name = asset.originalFilename ?? asset.kind.label
        let size = (asset.width != nil && asset.height != nil) ? " · \(asset.width!)×\(asset.height!)" : ""
        toolTip = MediaPaneContent.isImage(asset) ? "\(name)\(size)\nTıkla: önizle · Sürükle: sohbete ekle" : "\(name) · \(asset.kind.label)"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("\(name), \(asset.kind.label)")

        let menu = NSMenu()
        if MediaPaneContent.isImage(asset) {
            menu.addItem(ClosureMenuItem(title: "Önizle") { [weak self] in self?.preview() })
            menu.addItem(ClosureMenuItem(title: "Sohbete ekle") { [weak self] in
                guard let self else { return }
                MediaPanelActions.attachToChat(self.asset, app: self.app)
            })
        }
        menu.addItem(ClosureMenuItem(title: "Farklı Kaydet…") { [weak self] in
            guard let self else { return }
            self.app.media.saveAssetToDisk(self.asset)
        })
        self.menu = menu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Every click lands on the tile itself (its image and badge are decoration).
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview.map { convert(point, from: $0) } ?? point
        return bounds.contains(local) ? self : nil
    }

    func preview() { MediaPanelActions.preview(asset, from: self, app: app) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { dim.isHidden = false }
    override func mouseExited(with event: NSEvent) { dim.isHidden = true }

    override func mouseDown(with event: NSEvent) {
        mouseDownPoint = convert(event.locationInWindow, from: nil)
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragging, let start = mouseDownPoint else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - start.x, point.y - start.y) > 4 else { return }
        guard MediaPaneContent.isImage(asset), let image = app.images.image(asset.id), let url = MediaPanelActions.dragFile(for: asset, image: image) else { return }
        dragging = true
        let item = NSPasteboardItem()
        item.setString(url.absoluteString, forType: .fileURL)
        item.setString(asset.id, forType: .studioAsset)
        let dragItem = NSDraggingItem(pasteboardWriter: item)
        dragItem.setDraggingFrame(bounds, contents: image)
        beginDraggingSession(with: [dragItem], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        if !dragging, mouseDownPoint != nil, bounds.contains(convert(event.locationInWindow, from: nil)) { preview() }
        dragging = false
        mouseDownPoint = nil
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }

    override func accessibilityPerformPress() -> Bool {
        preview()
        return true
    }
}

// MARK: - Marka

/// The working brand: logo, name, colours, fonts, voice, platforms; "Marka profili" and
/// "AI ile analiz et" open the brand settings like the menus do.
final class BrandPaneView: PanelPaneView {
    /// The card shown now (tests).
    private(set) var content: BrandCardContent?
    private var loaded: (brandId: EntityID, kit: BrandKit?, profile: BrandProfile?)?
    private var loadingBrand: EntityID?
    private var settingsWereOpen = false
    private var observation: ObservationToken?

    override init(app: AppModel) {
        super.init(app: app)
        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Reloads the kit and the profile (after the brand settings closed, or another brand).
    func reload() {
        guard let brandId = app.currentBrandId else { return }
        loadingBrand = brandId
        let service = app.dataService
        Task { @MainActor [weak self] in
            async let kit = try? service.brandKit(brandId: brandId)
            async let profile = try? service.currentBrandProfile(brandId: brandId)
            let result = (brandId: brandId, kit: await kit, profile: await profile)
            guard let self, self.app.currentBrandId == brandId else { return }
            self.loaded = result
            self.loadingBrand = nil
            self.render()
        }
    }

    private func render() {
        let brandId = app.currentBrandId
        let sheetOpen = app.brandSettingsTarget != nil
        if settingsWereOpen && !sheetOpen { loaded = nil }
        settingsWereOpen = sheetOpen
        let accounts = app.accounts(of: brandId)

        removeArranged()
        guard let brandId, let brand = app.brand(brandId) else {
            content = nil
            add(paneNote("Marka seçilmedi."), spacingAfter: 10)
            add(PillButton(title: "Yeni marka", kind: .secondary, height: 26) { [weak app] in app?.newBrandPresented = true }, fullWidth: false)
            return
        }
        if loaded?.brandId != brandId, loadingBrand != brandId { reload() }
        let fresh = loaded?.brandId == brandId ? loaded : nil
        let card = BrandCardContent.make(brand: brand, kit: fresh?.kit, profile: fresh?.profile, accounts: accounts)
        content = card

        add(header(card), spacingAfter: 16)
        if fresh == nil {
            add(paneNote("Marka kiti okunuyor…"), spacingAfter: 12)
        }

        add(PaneHeaderLabel("Renkler"), spacingAfter: 6)
        if card.swatches.isEmpty {
            add(paneNote("Henüz renk yok; marka kitine ekle.", color: Theme.textTertiary), spacingAfter: 14)
        } else {
            let swatches = FlowLayoutView()
            swatches.translatesAutoresizingMaskIntoConstraints = false
            swatches.spacing = 6
            swatches.setItems(card.swatches.map(SwatchView.init))
            add(swatches, spacingAfter: 14)
        }

        add(PaneHeaderLabel("Yazı tipleri"), spacingAfter: 4)
        add(paneNote(card.fonts.isEmpty ? "Henüz yazı tipi yok." : card.fonts.joined(separator: " · "), color: card.fonts.isEmpty ? Theme.textTertiary : Theme.textPrimary), spacingAfter: 14)

        add(PaneHeaderLabel("Ses tonu"), spacingAfter: 4)
        add(paneNote(card.voice ?? "Profil çıkarılınca ses tonu burada özetlenir.", color: card.voice == nil ? Theme.textTertiary : Theme.textPrimary), spacingAfter: 14)

        add(PaneHeaderLabel("Platformlar"), spacingAfter: 2)
        for line in card.platforms {
            let row = PlatformLineView(line: line) { [weak app] in
                app?.accountConnectTarget = AccountConnectTarget(brandId: brandId, platform: line.platform)
            }
            add(row)
        }
        add(paneDivider())

        let profile = PillButton(title: "Marka profili", kind: .secondary, height: 26) { [weak app] in
            app?.openBrandSettings(brandId, tab: .profile)
        }
        let analyze = PillButton(title: "AI ile analiz et", kind: .secondary, height: 26) { [weak app] in
            app?.brandProfileTarget = BrandProfileTarget(brandId: brandId, startAnalysis: true)
        }
        analyze.toolTip = "Marka kitinden profil çıkarır (en az \(BrandKit.minSamples) örnek post görseli gerekir)."
        let buttons = NSStackView(views: [profile, analyze])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        add(buttons, spacingAfter: 8, fullWidth: false)
        add(PaneLinkView(title: "Marka ayarları") { [weak app] in app?.openBrandSettings(brandId) }, fullWidth: false)
    }

    private func header(_ card: BrandCardContent) -> NSView {
        let logo = ThemedView()
        logo.backgroundColor = Theme.fillStrong
        logo.cornerRadius = 10
        logo.layer?.masksToBounds = true
        logo.translatesAutoresizingMaskIntoConstraints = false
        let initials = NSTextField.styledLabel(card.initials, font: NSFont.systemFont(ofSize: 16, weight: .semibold), color: Theme.textSecondary)
        initials.translatesAutoresizingMaskIntoConstraints = false
        logo.addSubview(initials)
        NSLayoutConstraint.activate([
            logo.widthAnchor.constraint(equalToConstant: 48),
            logo.heightAnchor.constraint(equalToConstant: 48),
            initials.centerXAnchor.constraint(equalTo: logo.centerXAnchor),
            initials.centerYAnchor.constraint(equalTo: logo.centerYAnchor),
        ])
        if let logoId = card.logoAssetId {
            let image = AssetImageView(store: app.images, assetId: logoId, contentMode: .fit, cornerRadius: 10)
            image.translatesAutoresizingMaskIntoConstraints = false
            logo.addSubview(image)
            NSLayoutConstraint.activate([
                image.leadingAnchor.constraint(equalTo: logo.leadingAnchor, constant: 4),
                image.trailingAnchor.constraint(equalTo: logo.trailingAnchor, constant: -4),
                image.topAnchor.constraint(equalTo: logo.topAnchor, constant: 4),
                image.bottomAnchor.constraint(equalTo: logo.bottomAnchor, constant: -4),
            ])
        }
        let name = NSTextField.styledLabel(card.name, font: NSFont.systemFont(ofSize: 15, weight: .semibold), color: Theme.textPrimary)
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let subtitle = NSTextField.styledLabel(card.subtitle, font: Theme.captionFont, color: Theme.textSecondary)
        subtitle.lineBreakMode = .byTruncatingTail
        subtitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let profile = NSTextField.styledLabel(card.profileLine, font: Theme.smallFont, color: Theme.textTertiary)
        let text = NSStackView(views: [name, subtitle, profile])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [logo, text])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        return row
    }
}

/// A colour of the brand: a rounded square with a hairline edge; the name and hex as tooltip.
private final class SwatchView: ThemedView {
    init(_ swatch: BrandCardContent.Swatch) {
        super.init(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
        backgroundColor = BrandUI.color(hex: swatch.hex) ?? Theme.fill
        borderColor = Theme.border
        borderWidth = 1
        cornerRadius = 7
        toolTip = "\(swatch.name) · \(swatch.hex)"
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("\(swatch.name), \(swatch.hex)")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var intrinsicContentSize: NSSize { NSSize(width: 26, height: 26) }
    override var fittingSize: NSSize { NSSize(width: 26, height: 26) }
}

/// "◎ Instagram ……… @mtmagro": a click opens the account sheet ("Bağla" when not connected).
private final class PlatformLineView: PaneHoverControl {
    private let onTap: () -> Void

    init(line: BrandCardContent.PlatformLine, onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel("\(line.platform.displayName): \(line.value)")
        toolTip = line.connected ? "\(line.platform.displayName) hesabı" : "\(line.platform.displayName) hesabını bağla"
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: line.platform.panelSymbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        icon.contentTintColor = Theme.textSecondary
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        let name = NSTextField.styledLabel(line.platform.displayName, font: Theme.Panel.rowFont, color: Theme.textPrimary)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let valueColor: NSColor = line.needsOwner ? Theme.accent : (line.connected ? Theme.textSecondary : Theme.accent)
        let value = NSTextField.styledLabel(line.connected || line.needsOwner ? line.value : "Bağla", font: Theme.Panel.rowFont, color: valueColor)
        value.lineBreakMode = .byTruncatingMiddle
        value.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [icon, name, spacer, value])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) { onTap() }
    override func performTap() { onTap() }
}

// MARK: - iPhone

/// The pairing QR card (stacked for the narrow panel) and the paired iPhones.
final class PhonePaneView: PanelPaneView {
    let card: PhonePairingCardView
    private let deviceList = NSStackView()
    private let messageNote = paneNote("")
    private var observation: ObservationToken?
    /// Device names listed now (tests).
    private(set) var listedDevices: [String] = []

    override init(app: AppModel) {
        card = PhonePairingCardView(model: app.phonePairing, qrSize: 156, vertical: true)
        super.init(app: app)
        add(card, spacingAfter: 0)
        add(paneDivider())
        add(PaneHeaderLabel("Bağlı iPhone'lar"), spacingAfter: 4)
        deviceList.orientation = .vertical
        deviceList.alignment = .leading
        deviceList.spacing = 0
        add(deviceList, spacingAfter: 6)
        add(messageNote, spacingAfter: 8)
        add(PaneLinkView(title: "Ayarlar") { [weak app] in app?.openSettings(.devices) }, fullWidth: false)
        observation = observe { [weak self] in self?.render() }
        Task { [weak app] in await app?.phonePairing.loadDevices() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func render() {
        // A closed panel stops asking for fresh QR offers (the card counts as a viewer while shown).
        let presented = app.inspectorPresented
        if card.isHidden == presented { card.isHidden = !presented }
        let model = app.phonePairing
        let devices = model.activeDevices
        listedDevices = devices.map(\.name)
        deviceList.arrangedSubviews.forEach {
            deviceList.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        if devices.isEmpty {
            let note = paneNote(model.hasLoadedDevices ? "Henüz bağlı iPhone yok." : "Yükleniyor…")
            deviceList.addArrangedSubview(note)
            note.widthAnchor.constraint(equalTo: deviceList.widthAnchor).isActive = true
        }
        for device in devices {
            let seen = device.lastSeenAt.map { "son görülme \($0.formatted(.relative(presentation: .named)))" } ?? "henüz görülmedi"
            let row = DeviceRowView(name: device.name, detail: seen) { [weak model] in
                guard let model else { return }
                Task { await model.remove(device) }
            }
            deviceList.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: deviceList.widthAnchor).isActive = true
        }
        if let message = model.message, !message.isEmpty {
            messageNote.stringValue = message
            messageNote.isHidden = false
        } else {
            messageNote.isHidden = true
        }
    }
}

/// "Burak'ın iPhone'u · son görülme 2 dk önce   [Kaldır]".
private final class DeviceRowView: NSView {
    init(name: String, detail: String, onRemove: @escaping () -> Void) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "iphone", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        icon.contentTintColor = Theme.textSecondary
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        let title = NSTextField.styledLabel(name, font: Theme.Panel.rowFont, color: Theme.textPrimary)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let sub = NSTextField.styledLabel(detail, font: Theme.smallFont, color: Theme.textTertiary)
        sub.lineBreakMode = .byTruncatingTail
        sub.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let text = NSStackView(views: [title, sub])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let remove = PillButton(title: "Kaldır", kind: .outline, height: 22, action: onRemove)
        remove.setAccessibilityLabel("\(name): kaldır")
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let row = NSStackView(views: [icon, text, spacer, remove])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
