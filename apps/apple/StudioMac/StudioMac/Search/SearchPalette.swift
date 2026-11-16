import AppKit
import StudioKit

/// Pure AppKit "Ara" (`⌘F` / `⌘K`) command palette overlay:
/// - Dimmed backdrop (click or Esc dismisses)
/// - Liquid Glass panel with a search field and keyboard-navigable results
/// - Searches brands, conversations and every brand's posts (title, caption, brief)
///   client-side with `GlobalSearch` (the API has list endpoints, no search endpoint).
final class SearchPaletteOverlayView: ThemedView, NSTextFieldDelegate {
    private unowned let app: AppModel
    private let panelGlass = GlassContainerView(cornerRadius: 22)
    private let searchField = NSTextField()
    private let hairline = HairlineView()
    private let resultsScroll = NSScrollView()
    private let resultsStack = FlippedStackView()
    private let statusLabel = NSTextField.styledLabel("", font: Theme.captionFont, color: Theme.textSecondary, wraps: true)
    private let statusWrapper = NSView()
    private var resultsHeight: NSLayoutConstraint!
    private static let maxResultsHeight: CGFloat = 420

    private var selectedIndex = 0
    private(set) var currentResults: [SearchResult] = []
    private var rowViews: [SearchResultRowView] = []
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = NSColor.black.withAlphaComponent(0.08)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Ara")

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
        searchField.placeholderString = "Markalarda, sohbetlerde ve postlarda ara"
        searchField.setAccessibilityLabel("Ara")
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
        resultsStack.setAccessibilityRole(.list)
        resultsStack.setAccessibilityLabel("Sonuçlar")

        resultsScroll.drawsBackground = false
        resultsScroll.borderType = .noBorder
        resultsScroll.hasVerticalScroller = true
        resultsScroll.translatesAutoresizingMaskIntoConstraints = false
        resultsScroll.documentView = resultsStack
        resultsScroll.applyMinimalScroller()
        resultsHeight = resultsScroll.heightAnchor.constraint(equalToConstant: 0)

        statusWrapper.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusWrapper.addSubview(statusLabel)
        statusWrapper.isHidden = true
        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: statusWrapper.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: statusWrapper.trailingAnchor, constant: -16),
            statusLabel.topAnchor.constraint(equalTo: statusWrapper.topAnchor, constant: 10),
            statusLabel.bottomAnchor.constraint(equalTo: statusWrapper.bottomAnchor, constant: -12),
        ])

        let panelStack = NSStackView(views: [headerWrapper, hairline, resultsScroll, statusWrapper])
        panelStack.orientation = .vertical
        panelStack.alignment = .leading
        panelStack.spacing = 0
        panelStack.translatesAutoresizingMaskIntoConstraints = false

        panelGlass.contentContainer.addSubview(panelStack)
        addSubview(panelGlass)

        NSLayoutConstraint.activate([
            panelGlass.widthAnchor.constraint(equalToConstant: 560),
            panelGlass.centerXAnchor.constraint(equalTo: centerXAnchor),
            panelGlass.topAnchor.constraint(equalTo: topAnchor, constant: 90),
            panelGlass.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -40),

            panelStack.leadingAnchor.constraint(equalTo: panelGlass.contentContainer.leadingAnchor),
            panelStack.trailingAnchor.constraint(equalTo: panelGlass.contentContainer.trailingAnchor),
            panelStack.topAnchor.constraint(equalTo: panelGlass.contentContainer.topAnchor),
            panelStack.bottomAnchor.constraint(equalTo: panelGlass.contentContainer.bottomAnchor),

            headerWrapper.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
            hairline.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
            resultsScroll.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
            resultsStack.widthAnchor.constraint(equalTo: resultsScroll.widthAnchor),
            statusWrapper.widthAnchor.constraint(equalTo: panelStack.widthAnchor),
            resultsHeight,
        ])

        observation = observe { [weak self] in
            guard let self else { return }
            _ = self.app.conversations
            _ = self.app.brands
            _ = self.app.search.posts
            _ = self.app.search.isLoadingPosts
            _ = self.app.search.postsError
            self.rebuildResults()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func focusSearch() {
        searchField.stringValue = ""
        selectedIndex = 0
        app.search.refreshIfStale()
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

    private var query: String { searchField.stringValue }

    private func rebuildResults() {
        currentResults = GlobalSearch.results(
            query: query, brands: app.brands, conversations: app.conversations,
            posts: app.search.posts, currentBrandId: app.currentBrandId
        )
        selectedIndex = min(selectedIndex, max(0, currentResults.count - 1))

        resultsStack.arrangedSubviews.forEach {
            resultsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        rowViews = []

        var lastSection: String?
        let brandOrder = app.brandMenuOrder.map(\.id)
        for (offset, item) in currentResults.enumerated() {
            let section = Self.sectionTitle(item, queryIsEmpty: GlobalSearch.tokens(query).isEmpty)
            if section != lastSection {
                lastSection = section
                let header = NSTextField.sectionTitle(section)
                let holder = NSView()
                holder.translatesAutoresizingMaskIntoConstraints = false
                header.translatesAutoresizingMaskIntoConstraints = false
                holder.addSubview(header)
                NSLayoutConstraint.activate([
                    header.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 12),
                    header.topAnchor.constraint(equalTo: holder.topAnchor, constant: offset == 0 ? 2 : 8),
                    header.bottomAnchor.constraint(equalTo: holder.bottomAnchor, constant: -2),
                ])
                resultsStack.addArrangedSubview(holder)
                holder.widthAnchor.constraint(equalTo: resultsStack.widthAnchor, constant: -12).isActive = true
            }
            let shortcut: String? = {
                guard case .brand(let brand) = item, let index = brandOrder.firstIndex(of: brand.id), index < 9 else { return nil }
                return "⌘\(index + 1)"
            }()
            let row = SearchResultRowView(app: app, item: item, shortcut: shortcut, selected: offset == selectedIndex) { [weak self] in
                self?.open(item)
            }
            resultsStack.addArrangedSubview(row)
            rowViews.append(row)
            row.widthAnchor.constraint(equalTo: resultsStack.widthAnchor, constant: -12).isActive = true
        }

        let hasQuery = !GlobalSearch.tokens(query).isEmpty
        var status: String?
        if app.search.isLoadingPosts {
            status = "Postlar yükleniyor…"
        } else if let error = app.search.postsError, hasQuery {
            status = error
        } else if currentResults.isEmpty && hasQuery {
            status = "“\(query.trimmingCharacters(in: .whitespaces))” için sonuç yok."
        } else if currentResults.isEmpty {
            status = "Marka, sohbet ya da post (başlık veya açıklama metni) ara."
        }
        statusLabel.stringValue = status ?? ""
        statusWrapper.isHidden = status == nil
        hairline.isHidden = currentResults.isEmpty && status == nil

        resultsStack.layoutSubtreeIfNeeded()
        let height = currentResults.isEmpty ? 0 : resultsStack.fittingSize.height
        resultsHeight.constant = min(height, Self.maxResultsHeight)
        resultsScroll.isHidden = currentResults.isEmpty
        scrollSelectionIntoView()
    }

    static func sectionTitle(_ item: SearchResult, queryIsEmpty: Bool) -> String {
        switch item {
        case .brand: "Markalar"
        case .conversation: queryIsEmpty ? "Son sohbetler" : "Sohbetler"
        case .post: "Postlar"
        }
    }

    private func move(_ delta: Int) {
        guard !currentResults.isEmpty else { return }
        selectedIndex = (selectedIndex + delta + currentResults.count) % currentResults.count
        for (offset, row) in rowViews.enumerated() { row.isSelected = offset == selectedIndex }
        scrollSelectionIntoView()
        if let row = rowViews[safe: selectedIndex] {
            NSAccessibility.post(element: row, notification: .focusedUIElementChanged)
        }
    }

    private func scrollSelectionIntoView() {
        guard let row = rowViews[safe: selectedIndex] else { return }
        row.scrollToVisible(row.bounds)
    }

    private func openSelected() {
        guard let item = currentResults[safe: selectedIndex] else { return }
        open(item)
    }

    private func open(_ item: SearchResult) {
        app.searchPresented = false
        switch item {
        case .brand(let brand):
            if !app.switchToBrand(brand.id) {
                app.banner = "Eklenmiş görseller bu sohbetin markasına bağlı; markayı değiştirmek için önce onları kaldır."
            }
        case .conversation(let conversation):
            app.navigate(to: .conversation(conversation.id))
        case .post(let post, _):
            Task { await app.openPost(contentId: post.contentId, brandId: post.brandId) }
        }
    }

    private final class FlippedStackView: NSStackView {
        override var isFlipped: Bool { true }
    }

    private final class SearchResultRowView: ThemedView {
        private let onClick: () -> Void
        var isSelected: Bool {
            didSet { backgroundColor = isSelected ? Theme.fillStrong : nil }
        }

        init(app: AppModel, item: SearchResult, shortcut: String?, selected: Bool, onClick: @escaping () -> Void) {
            self.onClick = onClick
            self.isSelected = selected
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            backgroundColor = selected ? Theme.fillStrong : nil
            cornerRadius = Theme.rowRadius

            let icon = NSImageView()
            icon.translatesAutoresizingMaskIntoConstraints = false
            icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
            icon.contentTintColor = Theme.textSecondary

            let title: String
            var subtitle: String?
            let trailingView: NSView
            let symbol: String
            let kind: String
            switch item {
            case .brand(let brand):
                symbol = "briefcase"
                kind = "Marka"
                title = brand.name
                let current = brand.id == app.currentBrandId
                trailingView = NSTextField.styledLabel([current ? "Seçili" : nil, shortcut].compactMap { $0 }.joined(separator: "  "), font: Theme.smallFont, color: Theme.textTertiary)
            case .conversation(let conversation):
                symbol = "bubble.left"
                kind = "Sohbet"
                title = conversation.displayTitle
                trailingView = NSTextField.styledLabel(app.brand(conversation.brandId)?.name ?? "Markasız", font: Theme.smallFont, color: Theme.textSecondary)
            case .post(let post, let snippet):
                symbol = "square.grid.2x2"
                kind = "Post"
                title = post.title.isEmpty ? "Adsız post" : post.title
                subtitle = snippet
                if let card = app.posts.card(post.contentId) {
                    trailingView = PostStateLabelView(state: card.state)
                } else {
                    trailingView = NSTextField.styledLabel(app.brand(post.brandId)?.name ?? "", font: Theme.smallFont, color: Theme.textSecondary)
                }
            }
            icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))

            let titleLabel = NSTextField.styledLabel(title, font: Theme.rowFont, color: Theme.textPrimary)
            titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            var textViews: [NSView] = [titleLabel]
            if let subtitle {
                let sub = NSTextField.styledLabel(subtitle, font: Theme.smallFont, color: Theme.textSecondary)
                sub.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                textViews.append(sub)
            }
            let texts = NSStackView(views: textViews)
            texts.orientation = .vertical
            texts.alignment = .leading
            texts.spacing = 1
            texts.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            trailingView.setContentCompressionResistancePriority(.required, for: .horizontal)

            let row = NSStackView(views: [icon, texts, spacer, trailingView])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 10
            row.translatesAutoresizingMaskIntoConstraints = false
            addSubview(row)

            NSLayoutConstraint.activate([
                heightAnchor.constraint(equalToConstant: subtitle == nil ? 32 : 44),
                row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
                row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                row.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])

            setAccessibilityElement(true)
            setAccessibilityRole(.button)
            setAccessibilityLabel([kind, title, subtitle].compactMap { $0 }.joined(separator: ", "))
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        override func mouseDown(with event: NSEvent) {
            onClick()
        }

        override func accessibilityPerformPress() -> Bool {
            onClick()
            return true
        }
    }
}
