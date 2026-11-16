import AppKit
import StudioKit

/// Pure AppKit `"Ara"` (`⌘K`) command palette overlay:
/// - Dimmed backdrop (click or Esc dismisses)
/// - Liquid Glass panel (`width: 520`, `cornerRadius: 22`) with search field and keyboard-navigable results.
final class SearchPaletteOverlayView: ThemedView, NSTextFieldDelegate {
    private unowned let app: AppModel
    private let panelGlass = GlassContainerView(cornerRadius: 22)
    private let searchField = NSTextField()
    private let hairline = HairlineView()
    private let resultsStack = NSStackView()
    private let emptyLabel = NSTextField.styledLabel("Sonuç yok", font: Theme.captionFont, color: Theme.textSecondary)

    private var selectedIndex = 0
    private var currentResults: [ResultItem] = []
    private var observation: ObservationToken?

    private enum ResultItem {
        case conversation(Conversation)
        case post(PostCard)
    }

    init(app: AppModel) {
        self.app = app
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = NSColor.black.withAlphaComponent(0.08)

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .regular))
        icon.contentTintColor = Theme.textSecondary
        icon.translatesAutoresizingMaskIntoConstraints = false

        searchField.isBordered = false
        searchField.drawsBackground = false
        searchField.focusRingType = .none
        searchField.font = NSFont.systemFont(ofSize: 15)
        searchField.textColor = Theme.textPrimary
        searchField.placeholderString = "Sohbetlerde ve postlarda ara"
        searchField.delegate = self

        let headerRow = NSStackView(views: [icon, searchField])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 10
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        let headerWrapper = NSView()
        headerWrapper.translatesAutoresizingMaskIntoConstraints = false
        headerWrapper.addSubview(headerRow)
        NSLayoutConstraint.activate([
            headerWrapper.heightAnchor.constraint(equalToConstant: 44),
            headerRow.leadingAnchor.constraint(equalTo: headerWrapper.leadingAnchor, constant: 16),
            headerRow.trailingAnchor.constraint(equalTo: headerWrapper.trailingAnchor, constant: -16),
            headerRow.centerYAnchor.constraint(equalTo: headerWrapper.centerYAnchor),
        ])

        resultsStack.orientation = .vertical
        resultsStack.alignment = .leading
        resultsStack.spacing = 2
        resultsStack.edgeInsets = NSEdgeInsets(top: 6, left: 6, bottom: 6, right: 6)
        resultsStack.translatesAutoresizingMaskIntoConstraints = false

        let emptyWrapper = NSView()
        emptyWrapper.translatesAutoresizingMaskIntoConstraints = false
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        emptyWrapper.addSubview(emptyLabel)
        emptyWrapper.isHidden = true
        NSLayoutConstraint.activate([
            emptyLabel.leadingAnchor.constraint(equalTo: emptyWrapper.leadingAnchor, constant: 16),
            emptyLabel.topAnchor.constraint(equalTo: emptyWrapper.topAnchor, constant: 12),
            emptyLabel.bottomAnchor.constraint(equalTo: emptyWrapper.bottomAnchor, constant: -14),
        ])

        let panelStack = NSStackView(views: [headerWrapper, hairline, resultsStack, emptyWrapper])
        panelStack.orientation = .vertical
        panelStack.alignment = .leading
        panelStack.spacing = 0
        panelStack.translatesAutoresizingMaskIntoConstraints = false

        panelGlass.contentContainer.addSubview(panelStack)
        addSubview(panelGlass)

        NSLayoutConstraint.activate([
            panelGlass.widthAnchor.constraint(equalToConstant: 520),
            panelGlass.centerXAnchor.constraint(equalTo: centerXAnchor),
            panelGlass.topAnchor.constraint(equalTo: topAnchor, constant: 90),

            panelStack.leadingAnchor.constraint(equalTo: panelGlass.contentContainer.leadingAnchor),
            panelStack.trailingAnchor.constraint(equalTo: panelGlass.contentContainer.trailingAnchor),
            panelStack.topAnchor.constraint(equalTo: panelGlass.contentContainer.topAnchor),
            panelStack.bottomAnchor.constraint(equalTo: panelGlass.contentContainer.bottomAnchor),

            headerWrapper.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
            hairline.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
            resultsStack.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
            emptyWrapper.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
        ])

        observation = observe { [weak self] in
            _ = self?.app.conversations
            _ = self?.app.posts.board.cards
            self?.rebuildResults()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func focusSearch() {
        searchField.stringValue = ""
        selectedIndex = 0
        rebuildResults()
        window?.makeFirstResponder(searchField)
    }

    override func mouseDown(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        if !panelGlass.frame.contains(pt) {
            app.searchPresented = false
        }
    }

    func controlTextDidChange(_ obj: Notification) {
        selectedIndex = 0
        rebuildResults()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.moveDown(_:)):
            move(1)
            return true
        case #selector(NSResponder.moveUp(_:)):
            move(-1)
            return true
        case #selector(NSResponder.insertNewline(_:)):
            openSelected()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            app.searchPresented = false
            return true
        default:
            return false
        }
    }

    private func computeResults() -> [ResultItem] {
        let q = searchField.stringValue.trimmingCharacters(in: .whitespaces).lowercased(with: TurkishFormat.locale)
        let conversations = app.conversations
            .filter { q.isEmpty || $0.displayTitle.lowercased(with: TurkishFormat.locale).contains(q) }
            .prefix(q.isEmpty ? 6 : 12)
            .map(ResultItem.conversation)
        let posts = app.posts.board.cards
            .filter { !q.isEmpty && $0.title.lowercased(with: TurkishFormat.locale).contains(q) }
            .prefix(8)
            .map(ResultItem.post)
        return conversations + posts
    }

    private func rebuildResults() {
        currentResults = computeResults()
        selectedIndex = min(selectedIndex, max(0, currentResults.count - 1))

        resultsStack.arrangedSubviews.forEach {
            resultsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        let hasQuery = !searchField.stringValue.trimmingCharacters(in: .whitespaces).isEmpty
        hairline.isHidden = currentResults.isEmpty
        resultsStack.isHidden = currentResults.isEmpty
        emptyLabel.superview?.isHidden = !(currentResults.isEmpty && hasQuery)

        for (offset, item) in currentResults.enumerated() {
            let row = SearchResultRowView(app: app, item: item, selected: offset == selectedIndex) { [weak self] in
                self?.open(item)
            }
            resultsStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: resultsStack.widthAnchor, constant: -12).isActive = true
        }
    }

    private func move(_ delta: Int) {
        guard !currentResults.isEmpty else { return }
        selectedIndex = (selectedIndex + delta + currentResults.count) % currentResults.count
        rebuildResults()
    }

    private func openSelected() {
        guard let item = currentResults[safe: selectedIndex] else { return }
        open(item)
    }

    private func open(_ item: ResultItem) {
        app.searchPresented = false
        switch item {
        case .conversation(let conv):
            app.navigate(to: .conversation(conv.id))
        case .post(let card):
            app.navigate(to: .posts)
            app.detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        }
    }

    private final class SearchResultRowView: ThemedView {
        private let onClick: () -> Void

        init(app: AppModel, item: ResultItem, selected: Bool, onClick: @escaping () -> Void) {
            self.onClick = onClick
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            backgroundColor = selected ? Theme.fillStrong : nil
            cornerRadius = 16

            let icon = NSImageView()
            icon.translatesAutoresizingMaskIntoConstraints = false
            icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
            icon.contentTintColor = Theme.textSecondary

            let titleLabel: NSTextField
            let trailingView: NSView
            switch item {
            case .conversation(let conv):
                icon.image = NSImage(systemSymbolName: "bubble.left", accessibilityDescription: nil)?
                    .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
                titleLabel = NSTextField.styledLabel(conv.displayTitle, font: Theme.rowFont, color: Theme.textPrimary)
                trailingView = NSTextField.styledLabel(app.brand(conv.brandId)?.name ?? "", font: Theme.smallFont, color: Theme.textSecondary)
            case .post(let card):
                icon.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)?
                    .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
                titleLabel = NSTextField.styledLabel(card.title, font: Theme.rowFont, color: Theme.textPrimary)
                trailingView = PostStateLabelView(state: card.state)
            }
            titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

            let row = NSStackView(views: [icon, titleLabel, spacer, trailingView])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 10
            row.translatesAutoresizingMaskIntoConstraints = false
            addSubview(row)

            NSLayoutConstraint.activate([
                heightAnchor.constraint(equalToConstant: 32),
                row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
                row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                row.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        override func mouseDown(with event: NSEvent) {
            onClick()
        }
    }
}
