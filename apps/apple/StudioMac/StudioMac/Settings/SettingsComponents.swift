import AppKit
import StudioKit

// MARK: - Blocks

/// Anything stacked in a settings pane: a row, a sub-heading, a note, a list.
/// `isAvailable` is the pane's own logic (e.g. "only while the host runs");
/// search never shows an unavailable block.
class SettingsBlock: NSView {
    var isAvailable = true {
        didSet { if oldValue != isAvailable { enclosingPane?.refresh() } }
    }

    /// Words search matches; nil = shown while searching only when the whole section matches.
    var searchText: String?

    /// Belongs to a tab of the pane that is not selected (Hesaplar | Uygulamalar): hidden, but
    /// still found by a settings search for its own words.
    var tabHidden = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var enclosingPane: SettingsPaneView? {
        var view = superview
        while let current = view {
            if let pane = current as? SettingsPaneView { return pane }
            view = current.superview
        }
        return nil
    }
}

/// One settings row: title + grey wrapping description on the left, the control on
/// the right, an optional full-width footer (fields, logs) below. A hairline above
/// separates it from the previous row.
final class SettingsRowView: SettingsBlock {
    let item: SettingsItem?
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let textColumn = NSStackView()
    private let topRow = NSStackView()
    private let body = NSStackView()
    private let separator = HairlineView()
    private var accessoryView: NSView?
    private var footerView: NSView?
    private var extraKeywords: String

    var title: String {
        didSet {
            titleLabel.stringValue = title
            updateSearchText()
        }
    }

    var detail: String? {
        didSet {
            detailLabel.stringValue = detail ?? ""
            detailLabel.isHidden = (detail ?? "").isEmpty
            updateSearchText()
        }
    }

    var detailColor: NSColor = Theme.textSecondary {
        didSet { detailLabel.textColor = detailColor }
    }

    var titleColor: NSColor = Theme.textPrimary {
        didSet { titleLabel.textColor = titleColor }
    }

    var showsSeparator = false {
        didSet { separator.isHidden = !showsSeparator }
    }

    /// A small pill after the title ("Bu Mac", like Claude's "Local only").
    var tagText: String? {
        didSet {
            guard tagText != oldValue else { return }
            tagView?.removeFromSuperview()
            tagView = tagText.map(SettingsTagView.init)
            if let tagView { titleRow.addArrangedSubview(tagView) }
        }
    }
    private var tagView: SettingsTagView?
    private let titleRow = NSStackView()

    var accessory: NSView? {
        get { accessoryView }
        set {
            accessoryView?.removeFromSuperview()
            accessoryView = newValue
            if let newValue {
                newValue.setContentHuggingPriority(.required, for: .horizontal)
                newValue.setContentCompressionResistancePriority(.required, for: .horizontal)
                topRow.addArrangedSubview(newValue)
            }
        }
    }

    var footer: NSView? {
        get { footerView }
        set {
            footerView?.removeFromSuperview()
            footerView = newValue
            if let newValue {
                body.addArrangedSubview(newValue)
                newValue.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
            }
        }
    }

    init(title: String, detail: String? = nil, accessory: NSView? = nil, footer: NSView? = nil, keywords: String = "", item: SettingsItem? = nil) {
        self.title = title
        self.detail = detail
        self.item = item
        self.extraKeywords = keywords
        super.init(frame: .zero)

        titleLabel.font = Theme.Settings.rowTitleFont
        titleLabel.textColor = Theme.textPrimary
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.stringValue = title
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        detailLabel.font = Theme.Settings.rowDetailFont
        detailLabel.textColor = Theme.textSecondary
        detailLabel.stringValue = detail ?? ""
        detailLabel.isHidden = (detail ?? "").isEmpty
        detailLabel.isSelectable = false
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 8
        titleRow.addArrangedSubview(titleLabel)
        titleRow.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        textColumn.orientation = .vertical
        textColumn.alignment = .leading
        textColumn.spacing = 3
        textColumn.addArrangedSubview(titleRow)
        textColumn.addArrangedSubview(detailLabel)
        textColumn.setContentHuggingPriority(.defaultLow, for: .horizontal)
        textColumn.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textColumn.setHuggingPriority(.defaultHigh, for: .vertical)

        topRow.orientation = .horizontal
        topRow.alignment = .centerY
        topRow.spacing = 16
        topRow.distribution = .fill
        topRow.addArrangedSubview(textColumn)

        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 10
        body.translatesAutoresizingMaskIntoConstraints = false
        body.addArrangedSubview(topRow)
        topRow.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true

        separator.isHidden = true
        addSubview(separator)
        addSubview(body)
        let pad = Theme.Settings.rowVerticalPadding
        NSLayoutConstraint.activate([
            separator.leadingAnchor.constraint(equalTo: leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.topAnchor.constraint(equalTo: topAnchor),
            body.leadingAnchor.constraint(equalTo: leadingAnchor),
            body.trailingAnchor.constraint(equalTo: trailingAnchor),
            body.topAnchor.constraint(equalTo: topAnchor, constant: pad),
            body.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -pad),
        ])
        self.accessory = accessory
        self.footer = footer
        updateSearchText()
        setAccessibilityElement(false)
    }

    convenience init(item: SettingsItem, detail: String? = nil, accessory: NSView? = nil, footer: NSView? = nil) {
        let text = detail ?? item.detail
        self.init(title: item.title, detail: text.isEmpty ? nil : text, accessory: accessory, footer: footer, keywords: item.keywords, item: item)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func updateSearchText() {
        searchText = [title, detail ?? "", extraKeywords, item?.detail ?? ""].joined(separator: " ")
    }

    override func layout() {
        super.layout()
        // Wrap the description at the width the column actually got.
        let width = textColumn.frame.width
        if width > 0, abs(detailLabel.preferredMaxLayoutWidth - width) > 0.5 {
            detailLabel.preferredMaxLayoutWidth = width
            needsLayout = true
        }
    }
}

/// Small grey heading inside a pane ("Uzaktan erişim", "Harici sunucu").
final class SettingsSubheaderView: SettingsBlock {
    private let label: NSTextField

    init(_ text: String) {
        label = NSTextField.styledLabel(text, font: Theme.Settings.subheaderFont, color: Theme.textSecondary)
        super.init(frame: .zero)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 22),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
        label.setAccessibilityRole(.staticText)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Explanatory text between rows (empty states, setup steps, results).
final class SettingsNoteView: SettingsBlock {
    private let label = NSTextField(wrappingLabelWithString: "")

    var text: String {
        didSet { label.stringValue = text }
    }

    var color: NSColor = Theme.textSecondary {
        didSet { label.textColor = color }
    }

    init(_ text: String, color: NSColor = Theme.textSecondary, searchable: Bool = false) {
        self.text = text
        super.init(frame: .zero)
        label.stringValue = text
        label.font = Theme.Settings.rowDetailFont
        label.textColor = color
        label.isSelectable = true
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(equalTo: trailingAnchor),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])
        if searchable { searchText = text }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        if bounds.width > 0, abs(label.preferredMaxLayoutWidth - bounds.width) > 0.5 {
            label.preferredMaxLayoutWidth = bounds.width
            needsLayout = true
        }
    }
}

/// Any view as a block (e.g. the account picker during a connect flow).
final class SettingsCustomBlock: SettingsBlock {
    let content: NSView

    init(_ content: NSView, searchText: String? = nil, verticalPadding: CGFloat = 10) {
        self.content = content
        super.init(frame: .zero)
        self.searchText = searchText
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor, constant: verticalPadding),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -verticalPadding),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// A list of blocks rebuilt as data changes (brands, accounts, devices).
final class SettingsGroupBlock: SettingsBlock {
    private let stack = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    convenience init() { self.init(frame: .zero) }

    required init?(coder: NSCoder) { fatalError("not used") }

    var blocks: [SettingsBlock] { stack.arrangedSubviews.compactMap { $0 as? SettingsBlock } }

    func setBlocks(_ blocks: [SettingsBlock]) {
        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for block in blocks {
            stack.addArrangedSubview(block)
            block.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        enclosingPane?.refresh()
    }
}

// MARK: - Pane

/// One section's content: semibold title, then blocks. Filters itself for search.
class SettingsPaneView: NSView {
    let section: SettingsSection?
    private let stack = NSStackView()
    private let titleLabel: NSTextField

    /// Search query; empty shows every available block.
    var query: String = "" {
        didSet { if oldValue != query { refresh() } }
    }

    /// Visible blocks after the last refresh (search hides panes with none).
    private(set) var visibleBlockCount = 0

    init(section: SettingsSection?, showsTitle: Bool = true) {
        self.section = section
        titleLabel = NSTextField.styledLabel(section?.title ?? "", font: Theme.Settings.titleFont, color: Theme.textPrimary)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        if showsTitle, section != nil {
            titleLabel.setAccessibilityRole(.staticText)
            stack.addArrangedSubview(titleLabel)
            stack.setCustomSpacing(10, after: titleLabel)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var blocks: [SettingsBlock] { stack.arrangedSubviews.compactMap { $0 as? SettingsBlock } }

    func add(_ block: SettingsBlock) {
        stack.addArrangedSubview(block)
        block.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    @discardableResult
    func addRow(_ item: SettingsItem, detail: String? = nil, accessory: NSView? = nil, footer: NSView? = nil) -> SettingsRowView {
        let row = SettingsRowView(item: item, detail: detail, accessory: accessory, footer: footer)
        add(row)
        return row
    }

    @discardableResult
    func addSubheader(_ text: String) -> SettingsSubheaderView {
        let header = SettingsSubheaderView(text)
        add(header)
        return header
    }

    @discardableResult
    func addNote(_ text: String, color: NSColor = Theme.textSecondary) -> SettingsNoteView {
        let note = SettingsNoteView(text, color: color)
        add(note)
        return note
    }

    /// Stop flows and polling before the sheet closes.
    func willClose() {}

    /// Applies availability and the search query, then redraws the hairlines.
    @discardableResult
    func refresh() -> Int {
        let searching = !SettingsSearch.tokens(query).isEmpty
        let sectionMatches = searching && section.map { SettingsSearch.matches(query, in: $0.searchText) } == true
        var previous: SettingsBlock?
        var count = 0

        func visit(_ blocks: [SettingsBlock]) -> Int {
            var shown = 0
            for block in blocks {
                if let group = block as? SettingsGroupBlock {
                    let inner = group.isAvailable ? visit(group.blocks) : 0
                    group.isHidden = !group.isAvailable || (searching && inner == 0)
                    shown += inner
                    continue
                }
                let visible: Bool
                if !block.isAvailable || (block.tabHidden && (!searching || sectionMatches)) {
                    visible = false
                } else if let table = block as? SettingsTableBlock {
                    // Rows filter themselves; the table stays while any row matches.
                    let hits = table.filter(paneQuery: searching && !sectionMatches ? query : "")
                    visible = !searching || sectionMatches || hits > 0
                } else if !searching || sectionMatches {
                    visible = true
                } else if let text = block.searchText {
                    visible = SettingsSearch.matches(query, in: text)
                } else {
                    visible = false
                }
                block.isHidden = !visible
                guard visible else { continue }
                if let row = block as? SettingsRowView {
                    row.showsSeparator = previous is SettingsRowView
                }
                previous = block
                shown += 1
            }
            return shown
        }

        count = visit(blocks)
        visibleBlockCount = count
        return count
    }

    /// Rows currently shown (tests and search results).
    var visibleRowTitles: [String] {
        func collect(_ blocks: [SettingsBlock]) -> [String] {
            blocks.flatMap { block -> [String] in
                if block.isHidden { return [] }
                if let group = block as? SettingsGroupBlock { return collect(group.blocks) }
                if let row = block as? SettingsRowView { return [row.title] }
                return []
            }
        }
        return collect(blocks)
    }
}

// MARK: - Small controls

@MainActor
enum SettingsControls {
    /// Text field sized for the right side of a row.
    static func field(_ placeholder: String, value: String = "", secure: Bool = false, width: CGFloat? = Theme.Settings.controlWidth) -> NSTextField {
        let field: NSTextField = secure ? NSSecureTextField() : NSTextField()
        field.placeholderString = placeholder
        field.stringValue = value
        field.bezelStyle = .roundedBezel
        field.controlSize = .regular
        field.font = Theme.Settings.rowTitleFont
        field.translatesAutoresizingMaskIntoConstraints = false
        if let width { field.widthAnchor.constraint(equalToConstant: width).isActive = true }
        return field
    }

    static func toggle(target: AnyObject, action: Selector) -> NSSwitch {
        let control = NSSwitch()
        control.controlSize = .regular
        control.target = target
        control.action = action
        return control
    }

    static func popup(_ titles: [String], target: AnyObject, action: Selector) -> NSPopUpButton {
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.addItems(withTitles: titles)
        popup.target = target
        popup.action = action
        popup.controlSize = .regular
        popup.translatesAutoresizingMaskIntoConstraints = false
        return popup
    }

    static func buttons(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = spacing
        return stack
    }

    /// Fields on the left, buttons on the right, under a row's text.
    static func formFooter(fields: [NSView], buttons: [NSView], message: NSView? = nil) -> NSStackView {
        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 8
        for field in fields {
            column.addArrangedSubview(field)
            field.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        if !buttons.isEmpty {
            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let row = Self.buttons([spacer] + buttons)
            column.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        if let message {
            column.addArrangedSubview(message)
            message.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        return column
    }

    static func message() -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: "")
        label.font = Theme.Settings.rowDetailFont
        label.textColor = Theme.textSecondary
        label.isHidden = true
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    /// Value text on the right of a row (version, percent, "Bu Mac").
    static func value(_ text: String, color: NSColor = Theme.textSecondary, monospacedDigits: Bool = false) -> NSTextField {
        let font = monospacedDigits ? NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular) : Theme.Settings.rowDetailFont
        let label = NSTextField.styledLabel(text, font: font, color: color)
        label.isSelectable = true
        return label
    }
}

// MARK: - Sidebar

/// Section row in the settings sidebar: line icon + label, grey fill when selected.
final class SettingsSidebarRow: TapControl {
    let section: SettingsSection
    private let icon = NSImageView()
    private let label: NSTextField
    private let background = ThemedView()
    private var trackingArea: NSTrackingArea?
    private var hovering = false { didSet { refreshStyle() } }
    var onSelect: ((SettingsSection) -> Void)?

    var isSelected = false {
        didSet {
            refreshStyle()
            setAccessibilitySelected(isSelected)
        }
    }

    init(section: SettingsSection) {
        self.section = section
        label = NSTextField.styledLabel(section.title, font: Theme.Settings.rowTitleFont, color: Theme.textPrimary)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        background.cornerRadius = Theme.Settings.sidebarRowRadius
        background.translatesAutoresizingMaskIntoConstraints = false
        addSubview(background)

        icon.image = NSImage(systemSymbolName: section.symbol, accessibilityDescription: nil)
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        icon.contentTintColor = Theme.textPrimary
        icon.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        addSubview(label)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Theme.Settings.sidebarRowHeight),
            background.leadingAnchor.constraint(equalTo: leadingAnchor),
            background.trailingAnchor.constraint(equalTo: trailingAnchor),
            background.topAnchor.constraint(equalTo: topAnchor),
            background.bottomAnchor.constraint(equalTo: bottomAnchor),
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 9),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityRole(.button)
        setAccessibilityLabel(section.title)
        refreshStyle()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func performTap() { onSelect?(section) }

    override func mouseDown(with event: NSEvent) { performTap() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    private func refreshStyle() {
        background.backgroundColor = isSelected ? Theme.Settings.selectionFill : (hovering ? Theme.Settings.hoverFill : nil)
    }
}

/// Search field + grouped section rows.
final class SettingsSidebarView: NSView {
    let searchField = NSSearchField()
    private(set) var rows: [SettingsSidebarRow] = []
    var onSelect: ((SettingsSection) -> Void)?

    /// nil while search results are shown.
    var selected: SettingsSection? {
        didSet { rows.forEach { $0.isSelected = $0.section == selected } }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false

        searchField.placeholderString = "Ara"
        searchField.sendsSearchStringImmediately = true
        searchField.sendsWholeSearchString = false
        searchField.focusRingType = .none
        searchField.translatesAutoresizingMaskIntoConstraints = false
        searchField.setAccessibilityLabel("Ayarlarda ara")

        let list = NSStackView()
        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 2
        list.translatesAutoresizingMaskIntoConstraints = false

        for (index, group) in SettingsSection.groups.enumerated() {
            if index > 0 {
                let line = HairlineView()
                let holder = NSView()
                holder.translatesAutoresizingMaskIntoConstraints = false
                holder.addSubview(line)
                NSLayoutConstraint.activate([
                    holder.heightAnchor.constraint(equalToConstant: 17),
                    line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 10),
                    line.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -10),
                    line.centerYAnchor.constraint(equalTo: holder.centerYAnchor),
                ])
                list.addArrangedSubview(holder)
                holder.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
            }
            for section in group {
                let row = SettingsSidebarRow(section: section)
                row.onSelect = { [weak self] in self?.onSelect?($0) }
                list.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
                rows.append(row)
            }
        }

        // Sections scroll when the window is short.
        let scroll = NSScrollView()
        let clip = FlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let doc = FlippedDocumentView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = doc
        scroll.applyMinimalScroller()
        doc.addSubview(list)

        addSubview(searchField)
        addSubview(scroll)
        NSLayoutConstraint.activate([
            searchField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            searchField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            searchField.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 10),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),
            list.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: 12),
            list.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -12),
            list.topAnchor.constraint(equalTo: doc.topAnchor, constant: 4),
            list.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -12),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
