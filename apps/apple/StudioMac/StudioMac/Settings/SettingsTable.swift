import AppKit
import StudioKit

// Claude's "Customize" settings variant: segmented tabs, a search field and an add button on
// top, then a table (header row, hairlines, rounded hover rows). Used by Hesaplar and Markalar.

// MARK: - Tag pill

/// "Bu Mac", "Seçili", "Arşiv": a tiny grey pill next to a title.
final class SettingsTagView: ThemedView {
    let text: String

    init(_ text: String) {
        self.text = text
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.Settings.tagFill
        cornerRadius = 4
        let label = NSTextField.styledLabel(text, font: Theme.Settings.tagFont, color: Theme.textSecondary)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(text)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - Tabs

/// "Hesaplar | Uygulamalar": text tabs, the selected one on a rounded fill.
final class SettingsTabsView: NSView {
    let titles: [String]
    var selectedIndex: Int {
        didSet { buttons.enumerated().forEach { $0.element.isSelected = $0.offset == selectedIndex } }
    }
    var onSelect: ((Int) -> Void)?
    private(set) var buttons: [SettingsTabButton] = []

    init(titles: [String], selectedIndex: Int = 0) {
        self.titles = titles
        self.selectedIndex = selectedIndex
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 2
        row.translatesAutoresizingMaskIntoConstraints = false
        for (index, title) in titles.enumerated() {
            let button = SettingsTabButton(title: title)
            button.isSelected = index == selectedIndex
            button.onPress = { [weak self] in
                guard let self else { return }
                self.selectedIndex = index
                self.onSelect?(index)
            }
            row.addArrangedSubview(button)
            buttons.append(button)
        }
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Selects a tab as if clicked (keyboard, tests).
    func select(_ index: Int) {
        guard titles.indices.contains(index) else { return }
        selectedIndex = index
        onSelect?(index)
    }
}

final class SettingsTabButton: TapControl {
    var onPress: (() -> Void)?
    var isSelected = false {
        didSet {
            refresh()
            setAccessibilitySelected(isSelected)
        }
    }
    private let label: NSTextField
    private var hovering = false { didSet { refresh() } }
    private var trackingArea: NSTrackingArea?

    init(title: String) {
        label = NSTextField.styledLabel(title, font: Theme.Settings.rowDetailFont, color: Theme.textPrimary)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.cornerCurve = .continuous
        setAccessibilityRole(.radioButton)
        setAccessibilityLabel(title)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func refresh() {
        let fill: NSColor? = isSelected ? Theme.Settings.selectionFill : (hovering ? Theme.Settings.hoverFill : nil)
        layer?.backgroundColor = fill.map { resolvedCGColor($0) }
        label.textColor = isSelected ? Theme.textPrimary : Theme.textSecondary
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refresh()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseDown(with event: NSEvent) { performTap() }
    override func performTap() { onPress?() }
}

// MARK: - Toolbar

/// Tabs on the left; a search field and the add button on the right.
final class SettingsTableToolbar: NSView {
    let tabs: SettingsTabsView
    let searchField = NSSearchField()

    init(tabs: SettingsTabsView, searchPlaceholder: String, trailing: [NSView]) {
        self.tabs = tabs
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        searchField.placeholderString = searchPlaceholder
        searchField.sendsSearchStringImmediately = true
        searchField.focusRingType = .none
        searchField.controlSize = .regular
        searchField.setAccessibilityLabel(searchPlaceholder)
        searchField.translatesAutoresizingMaskIntoConstraints = false
        let preferred = searchField.widthAnchor.constraint(equalToConstant: 190)
        preferred.priority = .defaultLow
        NSLayoutConstraint.activate([
            preferred,
            searchField.widthAnchor.constraint(greaterThanOrEqualToConstant: 110),
        ])
        searchField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        spacer.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let row = NSStackView(views: [tabs, spacer, searchField] + trailing)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - Table

/// A table inside a settings pane: column titles, rows with hairlines between them and a rounded
/// hover fill. Rows filter by the toolbar's search and by the settings search. Laid out by frames
/// (one flexible first column; the others shrink together when the panel is narrow).
final class SettingsTableBlock: SettingsBlock {
    struct Column: Equatable {
        var title: String
        /// nil: the flexible column.
        var width: CGFloat?
    }

    struct Row {
        var id: String
        var searchText: String
        var cells: [NSView]
        /// Archived / disconnected rows read a step lighter.
        var dimmed = false
        var menu: NSMenu?
    }

    static let headerHeight: CGFloat = 32
    static let rowHeight: CGFloat = 46
    static let gap: CGFloat = 12
    static let horizontalPadding: CGFloat = 12
    static let minFlexibleWidth: CGFloat = 150

    let columns: [Column]
    private var headerLabels: [NSTextField] = []
    private let headerLine = ThemedView()
    private let emptyLabel = NSTextField.styledLabel("", font: Theme.Settings.rowDetailFont, color: Theme.textSecondary)
    private var allRows: [Row] = []
    private(set) var rowViews: [SettingsTableRowView] = []
    private var separators: [ThemedView] = []
    var emptyText = "Henüz bir şey yok." {
        didSet { emptyLabel.stringValue = emptyText }
    }
    /// The toolbar's search field.
    var localQuery = "" {
        didSet { if localQuery != oldValue { applyFilter() } }
    }
    private var paneQuery = ""

    override var isFlipped: Bool { true }

    init(columns: [Column]) {
        self.columns = columns
        super.init(frame: .zero)
        headerLabels = columns.map { column in
            let label = NSTextField.styledLabel(column.title, font: Theme.Settings.tableHeaderFont, color: Theme.textSecondary)
            label.translatesAutoresizingMaskIntoConstraints = true
            label.lineBreakMode = .byTruncatingTail
            addSubview(label)
            return label
        }
        headerLine.backgroundColor = Theme.hairline
        addSubview(headerLine)
        emptyLabel.translatesAutoresizingMaskIntoConstraints = true
        emptyLabel.stringValue = emptyText
        addSubview(emptyLabel)
        setAccessibilityElement(true)
        setAccessibilityRole(.table)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setRows(_ rows: [Row]) {
        allRows = rows
        searchText = rows.map(\.searchText).joined(separator: " ")
        applyFilter()
    }

    /// The settings search: returns how many rows match (the pane hides the table at zero).
    @discardableResult
    func filter(paneQuery query: String) -> Int {
        if query != paneQuery {
            paneQuery = query
            applyFilter()
        }
        return rowViews.count
    }

    /// Ids of the rows on screen (tests).
    var shownRowIDs: [String] { rowViews.map(\.rowID) }

    private func applyFilter() {
        let shown = allRows.filter { SettingsSearch.matches(localQuery, in: $0.searchText) && SettingsSearch.matches(paneQuery, in: $0.searchText) }
        rowViews.forEach { $0.removeFromSuperview() }
        separators.forEach { $0.removeFromSuperview() }
        rowViews = shown.map { row in
            let view = SettingsTableRowView(row: row, columns: columns)
            addSubview(view)
            return view
        }
        separators = shown.dropLast().map { _ in
            let line = ThemedView()
            line.backgroundColor = Theme.hairline
            addSubview(line)
            return line
        }
        emptyLabel.isHidden = !shown.isEmpty
        if shown.isEmpty, !allRows.isEmpty { emptyLabel.stringValue = "Eşleşen sonuç yok." } else { emptyLabel.stringValue = emptyText }
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    override var intrinsicContentSize: NSSize {
        let rows = max(rowViews.count, 1)
        return NSSize(width: NSView.noIntrinsicMetric, height: Self.headerHeight + CGFloat(rows) * Self.rowHeight)
    }

    /// Column widths for a table `total` wide: fixed columns at their width (shrunk together when
    /// the flexible one would get less than `minFlexibleWidth`), the flexible one takes the rest.
    static func columnWidths(_ columns: [Column], total: CGFloat) -> [CGFloat] {
        let available = max(0, total - 2 * horizontalPadding - CGFloat(max(0, columns.count - 1)) * gap)
        let fixed = columns.compactMap(\.width).reduce(0, +)
        let flexibleCount = CGFloat(columns.filter { $0.width == nil }.count)
        var scale: CGFloat = 1
        if flexibleCount > 0, fixed > 0, available - fixed < minFlexibleWidth * flexibleCount {
            scale = max(0.4, (available - minFlexibleWidth * flexibleCount) / fixed)
        }
        let flexible = flexibleCount > 0 ? max(0, (available - fixed * scale) / flexibleCount) : 0
        return columns.map { $0.width.map { floor($0 * scale) } ?? floor(flexible) }
    }

    override func layout() {
        super.layout()
        let widths = Self.columnWidths(columns, total: bounds.width)
        var x = Self.horizontalPadding
        for (index, label) in headerLabels.enumerated() {
            let height = label.fittingSize.height
            label.frame = NSRect(x: x, y: (Self.headerHeight - height) / 2, width: widths[index], height: height)
            x += widths[index] + Self.gap
        }
        headerLine.frame = NSRect(x: 0, y: Self.headerHeight - 1, width: bounds.width, height: 1)
        for (index, view) in rowViews.enumerated() {
            view.columnWidths = widths
            view.frame = NSRect(x: 0, y: Self.headerHeight + CGFloat(index) * Self.rowHeight, width: bounds.width, height: Self.rowHeight)
        }
        for (index, line) in separators.enumerated() {
            line.frame = NSRect(x: Self.horizontalPadding, y: Self.headerHeight + CGFloat(index + 1) * Self.rowHeight, width: bounds.width - 2 * Self.horizontalPadding, height: 1)
        }
        let emptyHeight = emptyLabel.fittingSize.height
        emptyLabel.frame = NSRect(x: Self.horizontalPadding, y: Self.headerHeight + (Self.rowHeight - emptyHeight) / 2, width: max(0, bounds.width - 2 * Self.horizontalPadding), height: emptyHeight)
    }
}

/// One table row: its cells placed in the columns, vertically centred; a rounded fill on hover.
final class SettingsTableRowView: NSView {
    let rowID: String
    let cells: [NSView]
    var columnWidths: [CGFloat] = [] {
        didSet { if columnWidths != oldValue { needsLayout = true } }
    }
    private var hovering = false { didSet { refresh() } }
    private var trackingArea: NSTrackingArea?

    override var isFlipped: Bool { true }

    init(row: SettingsTableBlock.Row, columns: [SettingsTableBlock.Column]) {
        rowID = row.id
        cells = row.cells
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous
        for cell in cells {
            cell.translatesAutoresizingMaskIntoConstraints = true
            addSubview(cell)
        }
        alphaValue = row.dimmed ? 0.6 : 1
        menu = row.menu
        setAccessibilityElement(true)
        setAccessibilityRole(.row)
        setAccessibilityLabel(row.searchText)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func refresh() {
        layer?.backgroundColor = hovering ? resolvedCGColor(Theme.Settings.hoverFill) : nil
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refresh()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func layout() {
        super.layout()
        var x = SettingsTableBlock.horizontalPadding
        for (index, cell) in cells.enumerated() {
            let width = columnWidths.indices.contains(index) ? columnWidths[index] : 0
            let fitting = cell.fittingSize
            // Buttons keep their own width (never squeezed); text fills the column and truncates.
            let fixed = (cell is NSControl && !(cell is NSTextField)) || cell.identifier == SettingsTableCells.fixedWidth
            let cellWidth = fixed ? fitting.width : width
            let height = min(bounds.height, max(fitting.height, 16))
            cell.frame = NSRect(x: x, y: ((bounds.height - height) / 2).rounded(), width: max(0, cellWidth), height: height)
            x += width + SettingsTableBlock.gap
        }
    }
}

// MARK: - Cell helpers

@MainActor
enum SettingsTableCells {
    /// Icon + title (+ a grey line under it) (+ a tag pill).
    static func title(_ text: String, symbol: String? = nil, subtitle: String? = nil, tag: String? = nil, initials: String? = nil, color: NSColor = Theme.textPrimary) -> NSView {
        var views: [NSView] = []
        if let initials {
            let avatar = ThemedView()
            avatar.backgroundColor = Theme.fillStrong
            avatar.cornerRadius = 6
            avatar.translatesAutoresizingMaskIntoConstraints = false
            let label = NSTextField.styledLabel(initials, font: NSFont.systemFont(ofSize: 10, weight: .semibold), color: Theme.textSecondary)
            label.translatesAutoresizingMaskIntoConstraints = false
            avatar.addSubview(label)
            NSLayoutConstraint.activate([
                avatar.widthAnchor.constraint(equalToConstant: 22),
                avatar.heightAnchor.constraint(equalToConstant: 22),
                label.centerXAnchor.constraint(equalTo: avatar.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: avatar.centerYAnchor),
            ])
            views.append(avatar)
        } else if let symbol {
            let icon = NSImageView()
            icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
            icon.contentTintColor = Theme.textSecondary
            icon.translatesAutoresizingMaskIntoConstraints = false
            icon.widthAnchor.constraint(equalToConstant: 22).isActive = true
            views.append(icon)
        }
        let titleLabel = NSTextField.styledLabel(text, font: Theme.Settings.rowTitleFont, color: color)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        var titleLine: [NSView] = [titleLabel]
        if let tag { titleLine.append(SettingsTagView(tag)) }
        let titleRow = NSStackView(views: titleLine)
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 6
        titleRow.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        var column: [NSView] = [titleRow]
        if let subtitle, !subtitle.isEmpty {
            let sub = NSTextField.styledLabel(subtitle, font: Theme.smallFont, color: Theme.textSecondary)
            sub.lineBreakMode = .byTruncatingTail
            sub.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            column.append(sub)
        }
        let text = NSStackView(views: column)
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        views.append(text)
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return row
    }

    static func text(_ text: String, color: NSColor = Theme.textSecondary, tag: String? = nil) -> NSView {
        let label = NSTextField.styledLabel(text, font: Theme.Settings.rowDetailFont, color: color)
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        guard let tag else { return label }
        let row = NSStackView(views: [label, SettingsTagView(tag)])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        return row
    }

    static func check(_ help: String) -> NSView {
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: help)?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
        icon.contentTintColor = Theme.textSecondary
        icon.toolTip = help
        return icon
    }

    static func symbols(_ names: [String], help: String) -> NSView {
        guard !names.isEmpty else { return text("—", color: Theme.textTertiary) }
        let row = NSStackView(views: names.map { name in
            let icon = NSImageView()
            icon.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
            icon.contentTintColor = Theme.textSecondary
            return icon
        })
        row.orientation = .horizontal
        row.spacing = 6
        row.toolTip = help
        return row
    }

    /// Cells laid out at their own width (buttons), not stretched to the column.
    static let fixedWidth = NSUserInterfaceItemIdentifier("settings.table.fixedWidth")

    /// Several controls in one cell (a button and the "…" menu).
    static func controls(_ views: [NSView]) -> NSView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.identifier = fixedWidth
        return row
    }

    /// The "…" button of a row: its menu pops up under it (native menu).
    static func moreButton(_ menu: NSMenu, help: String) -> NSView {
        let button = GlyphButton(symbol: "ellipsis", size: 12, weight: .regular, diameter: 24)
        button.toolTip = help
        button.setAccessibilityLabel(help)
        button.onAction = { [weak button] in
            guard let button else { return }
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.isFlipped ? button.bounds.height + 4 : -4), in: button)
        }
        return button
    }
}
