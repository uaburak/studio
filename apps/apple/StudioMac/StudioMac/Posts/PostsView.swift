import AppKit
import Quartz
import QuartzCore
import StudioKit
import UniformTypeIdentifiers

/// Pure AppKit Posts screen (05):
/// - Month title with ‹ › navigation, brand & count subtitle, status filter pills
/// - Responsive grid of 4:5 cards (rendered image or typographic placeholder + drag-and-drop slot),
///   date + status, keyboard selection, context menu, "render ediliyor" badge
/// - Loading, empty and error states; floating approve bar when posts are ready.
///
/// Keys: arrows move the selection, ↩ opens, space previews (Quick Look), ⌫ deletes (with
/// confirmation), ⌘D duplicates, ⌘E exports.
final class PostsViewController: NSViewController {
    private unowned let app: AppModel

    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let contentStack = NSStackView()

    private let monthLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private var previousMonthButton: GlyphButton!
    private var nextMonthButton: GlyphButton!
    private var headerRow: NSStackView!
    private var filterControl: FilterPillsControlView!
    private let errorBanner = InlineErrorBannerView()
    private let stateView = PostsStateView()
    private var gridView: PostGridContainerView!
    private var approveBar: ApproveBarView!

    private var observation: ObservationToken?
    private var lastLoadedBrandId: EntityID?
    private var renderedKey: GridRenderKey?
    private var detailWasOpen = false

    private struct GridRenderKey: Equatable {
        var cards: [PostCard]
        var slotUploads: [EntityID: Double]
        var openedCardId: EntityID?
        var selectedId: EntityID?
        var busy: Set<EntityID>
    }

    init(app: AppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = PostsKeyView()
        root.backgroundColor = Theme.canvas
        root.controller = self

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

        // Header: ‹ Kasım › + subtitle, filters on the right.
        monthLabel.font = NSFont.systemFont(ofSize: 28, weight: .bold)
        monthLabel.textColor = Theme.textPrimary
        monthLabel.setAccessibilityRole(.staticText)
        subtitleLabel.font = Theme.captionFont
        subtitleLabel.textColor = Theme.textSecondary

        previousMonthButton = GlyphButton(symbol: "chevron.left", size: 11, weight: .semibold, diameter: 26) { [weak self] in
            self?.app.posts.showPreviousMonth()
        }
        previousMonthButton.toolTip = "Önceki ay"
        previousMonthButton.setAccessibilityLabel("Önceki ay")
        nextMonthButton = GlyphButton(symbol: "chevron.right", size: 11, weight: .semibold, diameter: 26) { [weak self] in
            self?.app.posts.showNextMonth()
        }
        nextMonthButton.toolTip = "Sonraki ay"
        nextMonthButton.setAccessibilityLabel("Sonraki ay")

        let monthRow = NSStackView(views: [monthLabel, previousMonthButton, nextMonthButton])
        monthRow.orientation = .horizontal
        monthRow.alignment = .centerY
        monthRow.spacing = 4
        monthRow.setCustomSpacing(10, after: monthLabel)

        let titleStack = NSStackView(views: [monthRow, subtitleLabel])
        titleStack.orientation = .vertical
        titleStack.alignment = .leading
        titleStack.spacing = 4

        filterControl = FilterPillsControlView { [weak self] selected in
            self?.app.posts.filter = selected
            self?.app.posts.selectedId = nil
        }

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        headerRow = NSStackView(views: [titleStack, spacer, filterControl])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 20
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.app.posts.error = nil }
        errorBanner.onRetry = { [weak self] in Task { await self?.app.posts.load() } }

        stateView.isHidden = true
        stateView.onRetry = { [weak self] in
            guard let self else { return }
            Task { await self.app.posts.load() }
        }
        stateView.onShowAll = { [weak self] in self?.app.posts.filter = .all }
        stateView.onOpenChat = { [weak self] in self?.app.startNewChat() }
        stateView.onJumpToPosts = { [weak self] direction in self?.app.posts.showAdjacentMonthWithPosts(direction) }

        gridView = PostGridContainerView(app: app, controller: self)

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 28
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.addArrangedSubview(headerRow)
        contentStack.addArrangedSubview(errorBanner)
        contentStack.addArrangedSubview(stateView)
        contentStack.addArrangedSubview(gridView)

        documentView.addSubview(contentStack)

        approveBar = ApproveBarView { [weak self] in
            guard let self else { return }
            Task { await self.app.posts.approveReady() }
        }
        approveBar.isHidden = true

        root.addSubview(scrollView)
        root.addSubview(approveBar)

        let maxW = contentStack.widthAnchor.constraint(equalToConstant: 960)
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
            contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: documentView.leadingAnchor, constant: 40),
            contentStack.trailingAnchor.constraint(lessThanOrEqualTo: documentView.trailingAnchor, constant: -40),
            maxW,
            contentStack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 30),
            contentStack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -96),

            headerRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            errorBanner.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            stateView.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            gridView.widthAnchor.constraint(equalTo: contentStack.widthAnchor),

            approveBar.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            approveBar.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.syncState()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        Task { await app.posts.load() }
        // Keyboard navigation from the sidebar keeps its focus there.
        if app.detail == nil, !app.navigatedByKeyboard { view.window?.makeFirstResponder(view) }
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        // Narrow windows: the filter pills go under the title.
        let narrow = contentStack.frame.width > 0 && contentStack.frame.width < 760
        let wanted: NSUserInterfaceLayoutOrientation = narrow ? .vertical : .horizontal
        if headerRow.orientation != wanted {
            headerRow.orientation = wanted
            headerRow.alignment = narrow ? .leading : .centerY
            headerRow.spacing = narrow ? 14 : 20
        }
    }

    private func syncState() {
        let posts = app.posts
        if app.currentBrandId != lastLoadedBrandId {
            lastLoadedBrandId = app.currentBrandId
            Task { await posts.load() }
        }

        let counts = posts.counts
        monthLabel.stringValue = TurkishFormat.monthTitle(posts.month, currentYear: MonthKey(Date()).year)
        let brandName = app.brand(app.currentBrandId)?.name ?? "Marka seçilmedi"
        subtitleLabel.stringValue = posts.isLoading && !posts.hasLoaded ? "\(brandName) · yükleniyor" : "\(brandName) · \(counts[.all] ?? 0) post"
        filterControl.update(selection: posts.filter, counts: counts)

        if let err = posts.error, posts.hasLoaded, !posts.board.cards.isEmpty || posts.loadedBrandId != nil {
            errorBanner.message = err
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }

        let cards = posts.visibleCards
        let state: PostsStateView.State? = {
            if app.currentBrandId == nil { return .noBrand }
            if !posts.hasLoaded, posts.isLoading { return .loading }
            if let err = posts.error, posts.board.cards.isEmpty { return .error(err) }
            guard cards.isEmpty else { return nil }
            if posts.filter != .all { return .emptyFilter(posts.filter.label) }
            let months = posts.months
            return .emptyMonth(
                hasEarlier: months.contains { $0 < posts.month },
                hasLater: months.contains { $0 > posts.month })
        }()
        stateView.isHidden = state == nil
        if let state { stateView.show(state) }
        gridView.isHidden = state != nil

        let busy = Set(cards.compactMap { posts.activeJob(for: $0.id) != nil ? $0.id : nil })
        let key = GridRenderKey(cards: cards, slotUploads: posts.slotUploads, openedCardId: app.detail?.card.id, selectedId: posts.selectedId, busy: busy)
        if key != renderedKey {
            let selectionMoved = renderedKey?.selectedId != key.selectedId
            let onlySelectionChanged = renderedKey.map { $0.cards == key.cards && $0.slotUploads == key.slotUploads && $0.openedCardId == key.openedCardId && $0.busy == key.busy } ?? false
            renderedKey = key
            if onlySelectionChanged {
                gridView.updateSelection(key.selectedId)
            } else {
                gridView.setCards(cards, slotUploads: posts.slotUploads, openedCardId: app.detail?.card.id, selectedId: posts.selectedId, busy: busy)
            }
            if selectionMoved, let selected = key.selectedId { gridView.scrollToCard(selected) }
        }

        let approvableCount = posts.approvable.count
        approveBar.isHidden = approvableCount == 0
        if approvableCount > 0 {
            approveBar.update(count: approvableCount, isApproving: posts.isApproving)
        }

        if let card = posts.pendingDeletion {
            posts.pendingDeletion = nil
            confirmDelete(card)
        }

        // Back from the opened post: the grid takes the keyboard again.
        let detailOpen = app.detail != nil
        if detailWasOpen, !detailOpen {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.app.detail == nil, let window = self.view.window else { return }
                window.makeFirstResponder(self.view)
            }
        }
        detailWasOpen = detailOpen
    }

    // MARK: Actions (also used by the cards' context menus)

    func open(_ card: PostCard, from view: NSView?) {
        app.posts.selectedId = card.id
        let frame = view.map { $0.convert($0.bounds, to: nil) } ?? .zero
        app.detail = PostDetailModel(app: app, card: card, sourceFrame: frame)
    }

    func quickLook(_ card: PostCard) {
        app.posts.selectedId = card.id
        PostQuickLook.shared.toggle(assetIds: card.renderedAssetIds, service: app.dataService)
    }

    func confirmDelete(_ card: PostCard) {
        if let blocker = PostsModel.deletionBlocker(card) {
            app.posts.error = blocker
            NSSound.beep()
            return
        }
        Task {
            if await PostDeletion.confirm(title: card.title, window: view.window) {
                await app.posts.delete(card)
            }
        }
    }

    func duplicate(_ card: PostCard) {
        Task { await app.posts.duplicate(card) }
    }

    func copyCaption(_ card: PostCard) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(card.content.caption, forType: .string)
    }

    func exportMenu(for card: PostCard) -> NSMenu {
        if card.content.type == .reel { return reelExportMenu(for: card) }
        let reason: String? = card.version == nil ? "Bu postun henüz bir tasarımı yok." : nil
        let menu = PostFileExport.menu(target: self, action: #selector(exportChosen(_:)), slideCount: card.version?.slides.count ?? 1, currentSlide: nil, disabledReason: reason)
        for item in menu.items { item.representedObject = CardExportChoice(card: card, choice: item.representedObject as! ExportChoice) }
        return menu
    }

    /// Reels: the MP4 or the cover.
    private func reelExportMenu(for card: PostCard) -> NSMenu {
        let menu = NSMenu(title: "Dışa aktar")
        menu.autoenablesItems = false
        let info = card.version.map { ReelVersionInfo(version: $0) }
        for (title, cover) in [("MP4 video", false), ("Kapak görseli (JPEG)", true)] {
            let assetId = cover ? info?.coverAssetId : info?.videoAssetId
            let item = ClosureMenuItem(title: title) { [weak self] in
                guard let self, let assetId, let version = card.version else { return }
                self.saveReelFile(card: card, version: version, assetId: assetId, cover: cover)
            }
            item.isEnabled = assetId != nil
            if assetId == nil { item.toolTip = "Bu Reels'in henüz videosu yok." }
            menu.addItem(item)
        }
        return menu
    }

    private func saveReelFile(card: PostCard, version: ContentVersion, assetId: EntityID, cover: Bool) {
        let panel = NSSavePanel()
        let base = PostExporter.baseName(title: card.title, version: version.version)
        panel.nameFieldStringValue = cover ? "\(base)-kapak.jpg" : "\(base).mp4"
        panel.allowedContentTypes = cover ? [.jpeg] : [.mpeg4Movie]
        panel.canCreateDirectories = true
        Task {
            let response: NSApplication.ModalResponse = if let window = view.window { await panel.beginSheetModal(for: window) } else { panel.runModal() }
            guard response == .OK, let url = panel.url else { return }
            do {
                try await app.dataService.imageData(assetId: assetId).write(to: url, options: .atomic)
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } catch {
                app.posts.error = "Dışa aktarma: \(AppModel.describe(error))"
            }
        }
    }

    @objc private func exportChosen(_ sender: NSMenuItem) {
        guard let pick = sender.representedObject as? CardExportChoice, let version = pick.card.version else { return }
        let count = PostFileExport.fileCount(pick.choice, slideCount: version.slides.count)
        let base = PostExporter.baseName(title: pick.card.title, version: version.version)
        let name = count == 1 && pick.choice.format != .pdf && version.slides.count > 1 ? "\(base)-1.\(pick.choice.format.fileExtension)" : "\(base).\(pick.choice.format.fileExtension)"
        Task {
            guard let destination = await PostFileExport.chooseDestination(fileCount: count, suggestedName: name, format: pick.choice.format, window: view.window) else { return }
            do {
                let files = try await PostExporter(service: app.dataService).export(content: pick.card.content, version: version, format: pick.choice.format, slides: pick.choice.slides)
                var written: [URL] = []
                if count == 1, let file = files.first {
                    try file.data.write(to: destination, options: .atomic)
                    written = [destination]
                } else {
                    for file in files {
                        let url = PostDetailModel.uniqueURL(destination.appendingPathComponent(file.filename))
                        try file.data.write(to: url, options: .atomic)
                        written.append(url)
                    }
                }
                NSWorkspace.shared.activateFileViewerSelecting(written)
            } catch {
                app.posts.error = "Dışa aktarma: \(AppModel.describe(error))"
            }
        }
    }

    // MARK: Keyboard (PostsKeyView forwards here)

    func handleKey(_ event: NSEvent) -> Bool {
        let posts = app.posts
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let columns = gridView.columns
        switch event.keyCode {
        case 123 where flags.isDisjoint(with: [.command, .option, .control]): posts.moveSelection(by: -1); return true // ←
        case 124 where flags.isDisjoint(with: [.command, .option, .control]): posts.moveSelection(by: 1); return true // →
        case 126 where flags.isDisjoint(with: [.command, .option, .control]): posts.moveSelection(by: -columns); return true // ↑
        case 125 where flags.isDisjoint(with: [.command, .option, .control]): posts.moveSelection(by: columns); return true // ↓
        case 36, 76: // ↩, enter
            if let card = posts.selectedCard { open(card, from: gridView.itemView(card.id)) }
            return posts.selectedCard != nil
        case 49: // space
            if let card = posts.selectedCard { quickLook(card) } else { NSSound.beep() }
            return true
        case 51, 117: // ⌫, ⌦
            if let card = posts.selectedCard { confirmDelete(card) } else { NSSound.beep() }
            return true
        case 53: // esc
            if posts.selectedId != nil { posts.selectedId = nil; return true }
            return false
        default:
            break
        }
        if flags == .command, let chars = event.charactersIgnoringModifiers?.lowercased() {
            switch chars {
            case "d":
                if let card = posts.selectedCard { duplicate(card) } else { NSSound.beep() }
                return true
            case "e":
                if let card = posts.selectedCard, let itemView = gridView.itemView(card.id) {
                    exportMenu(for: card).popUp(positioning: nil, at: NSPoint(x: 0, y: itemView.bounds.height + 4), in: itemView)
                } else {
                    NSSound.beep()
                }
                return true
            default:
                break
            }
        }
        return false
    }

    // MARK: Quick Look panel control

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        MainActor.assumeIsolated {
            panel.dataSource = PostQuickLook.shared
            panel.delegate = PostQuickLook.shared
        }
    }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {}
}

private final class CardExportChoice: NSObject {
    let card: PostCard
    let choice: ExportChoice
    init(card: PostCard, choice: ExportChoice) {
        self.card = card
        self.choice = choice
    }
}

/// The posts screen's root view: first responder for the grid's keyboard shortcuts.
private final class PostsKeyView: ThemedView {
    weak var controller: PostsViewController?

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        if controller?.handleKey(event) != true { super.keyDown(with: event) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // ⌘D / ⌘E only while the grid has the focus (the opened post handles its own).
        guard window?.firstResponder === self, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              let chars = event.charactersIgnoringModifiers?.lowercased(), chars == "d" || chars == "e" else {
            return super.performKeyEquivalent(with: event)
        }
        return controller?.handleKey(event) ?? false
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        controller?.clearSelectionFromBackgroundClick()
        super.mouseDown(with: event)
    }
}

extension PostsViewController {
    fileprivate func clearSelectionFromBackgroundClick() {
        app.posts.selectedId = nil
    }
}

// MARK: - Empty / loading / error states

private final class PostsStateView: NSView {
    enum State: Equatable {
        case loading
        case noBrand
        case error(String)
        case emptyFilter(String)
        case emptyMonth(hasEarlier: Bool, hasLater: Bool)
    }

    var onRetry: (() -> Void)?
    var onShowAll: (() -> Void)?
    var onOpenChat: (() -> Void)?
    var onJumpToPosts: ((Int) -> Void)?

    private let spinner = NSProgressIndicator()
    private let primary = NSTextField(labelWithString: "")
    private let secondary = NSTextField(wrappingLabelWithString: "")
    private let buttons = NSStackView()
    private var current: State?

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        primary.font = Theme.chatFont
        primary.textColor = Theme.textSecondary
        primary.alignment = .center
        secondary.font = Theme.captionFont
        secondary.textColor = Theme.textTertiary
        secondary.alignment = .center
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [spinner, primary, secondary, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(18, after: secondary)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 90),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -40),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            secondary.widthAnchor.constraint(lessThanOrEqualToConstant: 380),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ state: State) {
        guard state != current else { return }
        current = state
        buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
        spinner.isHidden = state != .loading
        if state == .loading { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        switch state {
        case .loading:
            primary.stringValue = "Postlar yükleniyor"
            secondary.stringValue = ""
        case .noBrand:
            primary.stringValue = "Henüz bir marka yok."
            secondary.stringValue = "Kenar çubuğundan bir marka ekle; postlar onun planlarından gelir."
        case .error(let message):
            primary.stringValue = "Postlar yüklenemedi."
            secondary.stringValue = message
            buttons.addArrangedSubview(PillButton(title: "Yeniden dene", kind: .secondary, height: 28) { [weak self] in self?.onRetry?() })
        case .emptyFilter(let label):
            primary.stringValue = "“\(label)” durumunda post yok."
            secondary.stringValue = "Bu ayın diğer postlarını görmek için filtreyi kaldır."
            buttons.addArrangedSubview(PillButton(title: "Tümünü göster", kind: .secondary, height: 28) { [weak self] in self?.onShowAll?() })
        case .emptyMonth(let earlier, let later):
            primary.stringValue = "Bu ayda post yok."
            secondary.stringValue = "Postlar sohbette onaylanan planlardan gelir."
            if earlier {
                buttons.addArrangedSubview(PillButton(title: "Önceki postlar", kind: .secondary, height: 28) { [weak self] in self?.onJumpToPosts?(-1) })
            }
            if later {
                buttons.addArrangedSubview(PillButton(title: "Sonraki postlar", kind: .secondary, height: 28) { [weak self] in self?.onJumpToPosts?(1) })
            }
            buttons.addArrangedSubview(PillButton(title: "Sohbette plan iste", kind: .ink, height: 28) { [weak self] in self?.onOpenChat?() })
        }
        secondary.isHidden = secondary.stringValue.isEmpty
        buttons.isHidden = buttons.arrangedSubviews.isEmpty
    }
}

// MARK: - Responsive Multi-Column Grid

private final class PostGridContainerView: NSView {
    private unowned let app: AppModel
    private weak var controller: PostsViewController?
    private var itemViews: [PostCardItemView] = []
    private var lastWidth: CGFloat = 0
    private(set) var columns = 1

    override var isFlipped: Bool { true }

    init(app: AppModel, controller: PostsViewController) {
        self.app = app
        self.controller = controller
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setCards(_ cards: [PostCard], slotUploads: [EntityID: Double], openedCardId: EntityID?, selectedId: EntityID?, busy: Set<EntityID>) {
        itemViews.forEach { $0.removeFromSuperview() }
        itemViews = cards.map { card in
            let item = PostCardItemView(
                app: app,
                controller: controller,
                card: card,
                uploadProgress: slotUploads[card.id],
                dimmed: openedCardId == card.id,
                busy: busy.contains(card.id)
            )
            item.isSelected = card.id == selectedId
            // A provisional size so the card's constraints are never solved at zero width.
            item.frame = NSRect(x: 0, y: 0, width: 200, height: 276)
            item.layoutItem(visualHeight: 250)
            addSubview(item)
            return item
        }
        needsLayout = true
        invalidateIntrinsicContentSize()
    }

    func updateSelection(_ selectedId: EntityID?) {
        for item in itemViews { item.isSelected = item.cardId == selectedId }
    }

    func itemView(_ id: EntityID) -> NSView? { itemViews.first { $0.cardId == id } }

    func scrollToCard(_ id: EntityID) {
        guard let item = itemViews.first(where: { $0.cardId == id }) else { return }
        item.scrollToVisible(item.bounds.insetBy(dx: -10, dy: -30))
    }

    override func layout() {
        super.layout()
        _ = layoutGrid(in: bounds.width, place: true)
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        let width = bounds.width > 40 ? bounds.width : 880
        let height = layoutGrid(in: width, place: false)
        return NSSize(width: NSView.noIntrinsicMetric, height: height)
    }

    private func layoutGrid(in availableWidth: CGFloat, place: Bool) -> CGFloat {
        guard !itemViews.isEmpty else { return 0 }
        let width = max(200, availableWidth)
        let hSpacing: CGFloat = 20
        let vSpacing: CGFloat = 26
        let minColWidth: CGFloat = 180
        let maxColWidth: CGFloat = 260

        let cols = max(1, Int(floor((width + hSpacing) / (minColWidth + hSpacing))))
        if place { columns = cols }
        let rawColWidth = floor((width - CGFloat(cols - 1) * hSpacing) / CGFloat(cols))
        let colWidth = min(maxColWidth, max(minColWidth, rawColWidth))
        let cardVisualHeight = round(colWidth * 5.0 / 4.0)
        let footerHeight: CGFloat = 26
        let cellHeight = cardVisualHeight + footerHeight

        for (index, item) in itemViews.enumerated() {
            let col = index % cols
            let row = index / cols
            let x = CGFloat(col) * (colWidth + hSpacing)
            let y = CGFloat(row) * (cellHeight + vSpacing)
            if place {
                item.frame = NSRect(x: x, y: y, width: colWidth, height: cellHeight)
                item.layoutItem(visualHeight: cardVisualHeight)
            }
        }

        let totalRows = (itemViews.count + cols - 1) / cols
        return CGFloat(totalRows) * cellHeight + CGFloat(max(0, totalRows - 1)) * vSpacing
    }
}

private final class PostCardItemView: NSView {
    private unowned let app: AppModel
    private weak var controller: PostsViewController?
    private let card: PostCard
    private let placeholder: PostPlaceholderView
    private let footerRow = NSView()
    private let selectionRing = CAShapeLayer()
    private var badge: ThemedView?

    var cardId: EntityID { card.id }
    var isSelected = false {
        didSet { updateRing() }
    }

    override var isFlipped: Bool { true }

    init(app: AppModel, controller: PostsViewController?, card: PostCard, uploadProgress: Double?, dimmed: Bool, busy: Bool) {
        self.app = app
        self.controller = controller
        self.card = card
        self.placeholder = PostPlaceholderView(
            imageStore: app.images,
            card: card,
            scale: 1,
            uploadProgress: uploadProgress,
            onDropImage: { [weak app] url in app?.posts.uploadSlotImage(card: card, url: url) },
            onPickImage: { [weak app] in
                guard let url = ImageImport.pick(multiple: false).first else { return }
                app?.posts.uploadSlotImage(card: card, url: url)
            }
        )
        super.init(frame: .zero)
        wantsLayer = true
        alphaValue = dimmed ? 0 : 1

        placeholder.onTapCard = { [weak self] in
            guard let self else { return }
            self.controller?.open(self.card, from: self.placeholder)
        }
        addSubview(placeholder)

        selectionRing.fillColor = nil
        selectionRing.lineWidth = 2
        selectionRing.zPosition = 10
        layer?.addSublayer(selectionRing)

        if busy {
            let pill = ThemedView()
            pill.backgroundColor = NSColor.black.withAlphaComponent(0.62)
            pill.cornerRadius = 11
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .mini
            spinner.appearance = NSAppearance(named: .darkAqua)
            spinner.startAnimation(nil)
            let job = app.posts.activeJob(for: card.id)
            let text = job?.type == .contentGenerate ? (card.content.currentVersion == nil ? "Üretiliyor" : "AI düzenliyor") : "Render ediliyor"
            let label = NSTextField.styledLabel(text, font: NSFont.systemFont(ofSize: 10, weight: .medium), color: .white)
            let row = NSStackView(views: [spinner, label])
            row.orientation = .horizontal
            row.spacing = 5
            row.translatesAutoresizingMaskIntoConstraints = false
            pill.addSubview(row)
            pill.translatesAutoresizingMaskIntoConstraints = false
            addSubview(pill)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 8),
                row.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -9),
                row.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
                pill.heightAnchor.constraint(equalToConstant: 22),
                pill.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
                pill.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            ])
            badge = pill
        }

        let dateLabel = NSTextField.styledLabel(
            card.day.map(TurkishFormat.shortDay) ?? "Tarih yok",
            font: NSFont.systemFont(ofSize: 12, weight: .medium),
            color: Theme.textPrimary
        )
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let stateLabel = PostStateLabelView(state: card.state)

        let stack = NSStackView(views: [dateLabel, spacer, stateLabel])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        footerRow.addSubview(stack)
        addSubview(footerRow)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: footerRow.leadingAnchor, constant: 3),
            stack.trailingAnchor.constraint(equalTo: footerRow.trailingAnchor, constant: -3),
            stack.centerYAnchor.constraint(equalTo: footerRow.centerYAnchor),
        ])

        setAccessibilityRole(.button)
        setAccessibilityLabel("\(card.title), \(card.state.label)")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func layoutItem(visualHeight: CGFloat) {
        placeholder.frame = NSRect(x: 0, y: 0, width: bounds.width, height: visualHeight)
        footerRow.frame = NSRect(x: 0, y: visualHeight + 6, width: bounds.width, height: 20)
        updateRing()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateRing()
    }

    private func updateRing() {
        let rect = placeholder.frame.insetBy(dx: -4, dy: -4)
        selectionRing.frame = bounds
        selectionRing.path = CGPath(roundedRect: rect, cornerWidth: Theme.cardRadius + 4, cornerHeight: Theme.cardRadius + 4, transform: nil)
        selectionRing.strokeColor = resolvedCGColor(Theme.ink)
        selectionRing.isHidden = !isSelected
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        app.posts.selectedId = card.id
        let menu = NSMenu()
        menu.addItem(item("Aç", action: #selector(openItem)))
        let preview = item("Hızlı bakış", action: #selector(quickLookItem))
        preview.isEnabled = !card.renderedAssetIds.isEmpty
        menu.addItem(preview)
        menu.addItem(.separator())
        let export = NSMenuItem(title: "Dışa aktar", action: nil, keyEquivalent: "")
        export.submenu = controller?.exportMenu(for: card)
        menu.addItem(export)
        menu.addItem(item("Açıklamayı kopyala", action: #selector(copyCaptionItem)))
        menu.addItem(item("Çoğalt", action: #selector(duplicateItem)))
        menu.addItem(.separator())
        let delete = item("Sil…", action: #selector(deleteItem))
        if let blocker = PostsModel.deletionBlocker(card) {
            delete.isEnabled = false
            delete.toolTip = blocker
        }
        menu.addItem(delete)
        menu.autoenablesItems = false
        return menu
    }

    private func item(_ title: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func openItem() { controller?.open(card, from: placeholder) }
    @objc private func quickLookItem() { controller?.quickLook(card) }
    @objc private func copyCaptionItem() { controller?.copyCaption(card) }
    @objc private func duplicateItem() { controller?.duplicate(card) }
    @objc private func deleteItem() { controller?.confirmDelete(card) }
}

// MARK: - PostPlaceholderView (grid card; the opened post falls back to it without a render)

final class PostPlaceholderView: ThemedView {
    var onTapCard: (() -> Void)?

    private let card: PostCard
    private let scale: CGFloat
    private let onDropImage: ((URL) -> Void)?
    private let onPickImage: (() -> Void)?
    private var slotControl: NSView?

    init(
        imageStore: ImageStore?,
        card: PostCard,
        scale: CGFloat,
        slideIndex: Int = 0,
        overrideVersion: ContentVersion? = nil,
        uploadProgress: Double? = nil,
        onDropImage: ((URL) -> Void)? = nil,
        onPickImage: (() -> Void)? = nil
    ) {
        self.card = card
        self.scale = scale
        self.onDropImage = onDropImage
        self.onPickImage = onPickImage
        super.init(frame: .zero)

        let effectiveVersion = overrideVersion ?? card.version
        let slides = effectiveVersion?.slides ?? []
        let activeSlide = slides.indices.contains(slideIndex) ? slides[slideIndex] : slides.first
        let slideNeedsImage: Bool = {
            // A reel's picture is its video cover, never an image slot.
            if card.content.type == .reel { return false }
            if let activeSlide {
                let s = SlotScanner.slots(inHTML: activeSlide.html)
                if !s.isEmpty { return s.contains(where: \.isEmpty) }
            }
            return card.needsImage
        }()

        let tone = slideNeedsImage || card.state == .imageUploaded ? .muted : PlaceholderTone.stable(for: card.content.id)
        let radius = scale > 1 ? 0 : Theme.cardRadius
        cornerRadius = radius
        layer?.masksToBounds = true

        switch tone {
        case .light:
            backgroundColor = Theme.postLight
            borderColor = Theme.border
            borderWidth = 1
        case .dark:
            backgroundColor = Theme.postDark
            borderColor = Theme.border.withAlphaComponent(0.6)
            borderWidth = 1
        case .muted:
            backgroundColor = scale > 1 ? Theme.postDark : Theme.postMuted
            borderWidth = 0
        }

        let renderedId = activeSlide?.renderedAssetId ?? card.renderedAssetIds.first
        if let rendered = renderedId {
            borderColor = Theme.border
            borderWidth = scale > 1 ? 0 : 1
            let img = AssetImageView(store: imageStore, assetId: rendered, contentMode: .fill, cornerRadius: radius)
            img.translatesAutoresizingMaskIntoConstraints = false
            addSubview(img)
            NSLayoutConstraint.activate([
                img.leadingAnchor.constraint(equalTo: leadingAnchor),
                img.trailingAnchor.constraint(equalTo: trailingAnchor),
                img.topAnchor.constraint(equalTo: topAnchor),
                img.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
            if card.content.type == .reel, scale <= 1 {
                addReelBadges(durationMs: activeSlide.flatMap { ReelVersionInfo(html: $0.html).durationMs })
            }
            // The rendered image shows the brand's empty-slot placeholder; offer the slot on top.
            if slideNeedsImage, scale <= 1 {
                let smallSlot = SmallSlotDropView(card: card, uploadProgress: uploadProgress, onDropImage: onDropImage, onPickImage: onPickImage, onDark: true)
                addSubview(smallSlot)
                NSLayoutConstraint.activate([
                    smallSlot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
                    smallSlot.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
                ])
                slotControl = smallSlot
            }
        } else {
            let fgColor: NSColor = switch tone {
            case .light: Theme.postLightText
            case .dark: Theme.postDarkText
            case .muted: scale > 1 ? Theme.postDarkText : Theme.postMutedText
            }

            let hPad = 14 * min(scale, 1.7)
            let vPad = 16 * min(scale, 1.7)

            let vStack = NSStackView()
            vStack.orientation = .vertical
            vStack.alignment = .leading
            vStack.spacing = 6 * scale
            vStack.translatesAutoresizingMaskIntoConstraints = false
            addSubview(vStack)

            let scannedLayers = activeSlide.map { SlideLayerScanner.layers(inHTML: $0.html) } ?? []
            let eyebrowLayer = scannedLayers.first { $0.layerId == "eyebrow" || $0.role == "eyebrow" }
            let titleLayer = scannedLayers.first { $0.layerId == "title" || $0.layerId == "headline" || $0.role == "headline" }

            let eyebrowText: String? = if let eyebrowLayer {
                eyebrowLayer.isHidden ? nil : eyebrowLayer.text
            } else {
                card.eyebrow
            }

            if let eyebrow = eyebrowText, !eyebrow.isEmpty {
                let eyebrowLabel = NSTextField(labelWithString: TurkishFormat.upper(eyebrow))
                eyebrowLabel.font = NSFont.systemFont(ofSize: 8.5 * min(scale, 1.55), weight: .bold)
                eyebrowLabel.textColor = Theme.accent
                vStack.addArrangedSubview(eyebrowLabel)
            }

            let displayTitle: String = if let titleLayer, !titleLayer.text.isEmpty {
                titleLayer.isHidden ? "" : TurkishFormat.upper(titleLayer.text)
            } else {
                TurkishFormat.upper(card.title)
            }

            if !displayTitle.isEmpty {
                let titleLabel = NSTextField(wrappingLabelWithString: displayTitle)
                titleLabel.font = NSFont.systemFont(ofSize: 16 * scale, weight: .heavy)
                titleLabel.textColor = fgColor
                titleLabel.maximumNumberOfLines = 3
                vStack.addArrangedSubview(titleLabel)
                titleLabel.widthAnchor.constraint(equalTo: vStack.widthAnchor).isActive = true
            }

            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .vertical)
            vStack.addArrangedSubview(spacer)
            if slideNeedsImage || card.state == .imageUploaded {
                let smallSlot = SmallSlotDropView(card: card, uploadProgress: uploadProgress, onDropImage: onDropImage, onPickImage: onPickImage, onDark: false)
                vStack.addArrangedSubview(smallSlot)
                slotControl = smallSlot
            } else if card.state == .generating {
                vStack.addArrangedSubview(NSTextField.styledLabel("Tasarım hazırlanıyor…", font: NSFont.systemFont(ofSize: 10), color: fgColor.withAlphaComponent(0.6)))
            }

            NSLayoutConstraint.activate([
                vStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: hPad),
                vStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -hPad),
                vStack.topAnchor.constraint(equalTo: topAnchor, constant: vPad),
                vStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -vPad),
            ])
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Reels in the grid: a play glyph on the cover and the length ("0:12").
    private func addReelBadges(durationMs: Int?) {
        let play = NSImageView(image: NSImage(systemSymbolName: "play.fill", accessibilityDescription: "Video")?
            .withSymbolConfiguration(.init(pointSize: 15, weight: .bold)) ?? NSImage())
        play.contentTintColor = .white
        let circle = ThemedView()
        circle.backgroundColor = NSColor.black.withAlphaComponent(0.5)
        circle.cornerRadius = 20
        circle.translatesAutoresizingMaskIntoConstraints = false
        play.translatesAutoresizingMaskIntoConstraints = false
        circle.addSubview(play)
        addSubview(circle)
        NSLayoutConstraint.activate([
            circle.widthAnchor.constraint(equalToConstant: 40),
            circle.heightAnchor.constraint(equalToConstant: 40),
            circle.centerXAnchor.constraint(equalTo: centerXAnchor),
            circle.centerYAnchor.constraint(equalTo: centerYAnchor),
            play.centerXAnchor.constraint(equalTo: circle.centerXAnchor, constant: 1.5),
            play.centerYAnchor.constraint(equalTo: circle.centerYAnchor),
        ])
        guard let durationMs else { return }
        let pill = ThemedView()
        pill.backgroundColor = NSColor.black.withAlphaComponent(0.6)
        pill.cornerRadius = 9
        pill.translatesAutoresizingMaskIntoConstraints = false
        let label = NSTextField.styledLabel(TurkishFormat.clock(ms: durationMs), font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold), color: .white)
        label.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(label)
        addSubview(pill)
        NSLayoutConstraint.activate([
            pill.heightAnchor.constraint(equalToConstant: 18),
            pill.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            pill.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 7),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -7),
            label.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
        ])
        setAccessibilityLabel("Reels, \(TurkishFormat.duration(ms: durationMs))")
    }

    override func mouseDown(with event: NSEvent) {
        if let slotControl, !slotControl.isHidden {
            let pt = slotControl.convert(event.locationInWindow, from: nil)
            if slotControl.bounds.contains(pt) {
                slotControl.mouseDown(with: event)
                return
            }
        }
        if event.clickCount == 1 { onTapCard?() }
    }
}

// MARK: - Small image slot (grid cards)

private final class SmallSlotDropView: NSView {
    private let onDropImage: ((URL) -> Void)?
    private let onPickImage: (() -> Void)?
    private let circleLayer = CAShapeLayer()
    private var targeted = false { didSet { updateRing() } }
    private var showsDashedPlus = false

    init(card: PostCard, uploadProgress: Double?, onDropImage: ((URL) -> Void)?, onPickImage: (() -> Void)?, onDark: Bool) {
        self.onDropImage = onDropImage
        self.onPickImage = onPickImage
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        registerForDraggedTypes([.fileURL])

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        let captionColor = onDark ? NSColor.white.withAlphaComponent(0.85) : Theme.textSecondary

        if uploadProgress != nil {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            spinner.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                spinner.widthAnchor.constraint(equalToConstant: 36),
                spinner.heightAnchor.constraint(equalToConstant: 36),
            ])
            stack.addArrangedSubview(spinner)
            stack.addArrangedSubview(NSTextField.styledLabel("Yükleniyor", font: NSFont.systemFont(ofSize: 10), color: captionColor))
        } else if card.state == .imageUploaded {
            let badge = ThemedView()
            badge.backgroundColor = Theme.canvas
            badge.cornerRadius = 18
            badge.translatesAutoresizingMaskIntoConstraints = false
            let check = NSImageView()
            check.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 13, weight: .semibold))
            check.contentTintColor = Theme.textSecondary
            check.translatesAutoresizingMaskIntoConstraints = false
            badge.addSubview(check)
            NSLayoutConstraint.activate([
                badge.widthAnchor.constraint(equalToConstant: 36),
                badge.heightAnchor.constraint(equalToConstant: 36),
                check.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
                check.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            ])
            stack.addArrangedSubview(badge)
            stack.addArrangedSubview(NSTextField.styledLabel("Görsel yüklendi", font: NSFont.systemFont(ofSize: 10), color: captionColor))
        } else {
            showsDashedPlus = true
            let ringHolder = ThemedView(frame: NSRect(x: 0, y: 0, width: 36, height: 36))
            ringHolder.backgroundColor = onDark ? NSColor.black.withAlphaComponent(0.35) : nil
            ringHolder.cornerRadius = 18
            ringHolder.translatesAutoresizingMaskIntoConstraints = false
            ringHolder.layer?.addSublayer(circleLayer)
            let plus = NSImageView()
            plus.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
            plus.contentTintColor = Theme.accent
            plus.translatesAutoresizingMaskIntoConstraints = false
            ringHolder.addSubview(plus)
            NSLayoutConstraint.activate([
                ringHolder.widthAnchor.constraint(equalToConstant: 36),
                ringHolder.heightAnchor.constraint(equalToConstant: 36),
                plus.centerXAnchor.constraint(equalTo: ringHolder.centerXAnchor),
                plus.centerYAnchor.constraint(equalTo: ringHolder.centerYAnchor),
            ])
            toolTip = "Görsel ekle: tıkla ya da görseli buraya sürükle"
            setAccessibilityLabel("Görsel ekle")
            setAccessibilityRole(.button)
            stack.addArrangedSubview(ringHolder)
            stack.addArrangedSubview(NSTextField.styledLabel("Görsel ekle", font: NSFont.systemFont(ofSize: 10), color: captionColor))
            updateRing()
        }

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func updateRing() {
        guard showsDashedPlus else { return }
        let rect = CGRect(x: 0.5, y: 0.5, width: 35, height: 35)
        circleLayer.path = CGPath(ellipseIn: rect, transform: nil)
        circleLayer.strokeColor = resolvedCGColor(Theme.accent)
        circleLayer.fillColor = targeted ? resolvedCGColor(Theme.accent.withAlphaComponent(0.12)) : nil
        circleLayer.lineWidth = 1
        circleLayer.lineDashPattern = [3, 3]
    }

    override func mouseDown(with event: NSEvent) {
        onPickImage?()
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard ImageImport.pasteboardHasImages(sender.draggingPasteboard) else { return [] }
        targeted = true
        return .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) { targeted = false }
    override func draggingEnded(_ sender: any NSDraggingInfo) { targeted = false }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        targeted = false
        guard let url = ImageImport.imageURLs(from: sender.draggingPasteboard).first else { return false }
        onDropImage?(url)
        return true
    }
}

// MARK: - ApproveBarView & FilterPillsControlView

private final class ApproveBarView: NSView {
    private let glass = GlassContainerView(cornerRadius: 18)
    private let label = NSTextField.styledLabel("", font: NSFont.systemFont(ofSize: 13, weight: .medium), color: Theme.textPrimary)
    private let approveButton: PillButton

    init(onApprove: @escaping () -> Void) {
        self.approveButton = PillButton(title: "Onayla", kind: .primary, height: 28, action: onApprove)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        approveButton.toolTip = "Hazır postların hepsini gösterilen sürümleriyle onayla"

        let dot = StatusDotView(color: Theme.ink)
        let row = NSStackView(views: [dot, label, approveButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false

        glass.contentContainer.addSubview(row)
        addSubview(glass)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 36),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),

            row.leadingAnchor.constraint(equalTo: glass.contentContainer.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: glass.contentContainer.trailingAnchor, constant: -4),
            row.centerYAnchor.constraint(equalTo: glass.contentContainer.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(count: Int, isApproving: Bool) {
        label.stringValue = "\(count) post onaya hazır"
        approveButton.showsSpinner = isApproving
        approveButton.isEnabled = !isApproving
    }
}

private final class FilterPillsControlView: ThemedView {
    private let onSelect: (PostListFilter) -> Void
    private var segments: [PostListFilter: SegmentPillView] = [:]

    init(onSelect: @escaping (PostListFilter) -> Void) {
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.fill
        cornerRadius = 15
        setAccessibilityLabel("Durum filtresi")
        setAccessibilityRole(.radioGroup)

        var views: [NSView] = []
        for filter in PostListFilter.allCases {
            let pill = SegmentPillView(title: filter.label) { [weak self] in
                self?.onSelect(filter)
            }
            segments[filter] = pill
            views.append(pill)
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 2
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 30),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(selection: PostListFilter, counts: [PostListFilter: Int]) {
        for filter in PostListFilter.allCases {
            segments[filter]?.update(selected: filter == selection, count: counts[filter] ?? 0)
        }
    }

    private final class SegmentPillView: ThemedView {
        private let titleLabel: NSTextField
        private let countLabel = NSTextField(labelWithString: "0")
        private let onClick: () -> Void

        init(title: String, onClick: @escaping () -> Void) {
            self.titleLabel = NSTextField(labelWithString: title)
            self.onClick = onClick
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            cornerRadius = 13
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(title)

            countLabel.font = NSFont.systemFont(ofSize: 12)
            countLabel.textColor = Theme.textSecondary

            let row = NSStackView(views: [titleLabel, countLabel])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 6
            row.translatesAutoresizingMaskIntoConstraints = false
            addSubview(row)

            NSLayoutConstraint.activate([
                heightAnchor.constraint(equalToConstant: 26),
                row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 11),
                row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -11),
                row.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        func update(selected: Bool, count: Int) {
            backgroundColor = selected ? Theme.canvas : nil
            titleLabel.font = NSFont.systemFont(ofSize: 12, weight: selected ? .semibold : .regular)
            titleLabel.textColor = selected ? Theme.textPrimary : Theme.textSecondary
            countLabel.font = NSFont.systemFont(ofSize: 12, weight: selected ? .semibold : .regular)
            countLabel.stringValue = "\(count)"
            setAccessibilityValue(selected)
            if selected {
                layer?.shadowColor = NSColor.black.cgColor
                layer?.shadowOpacity = 0.08
                layer?.shadowRadius = 2
                layer?.shadowOffset = CGSize(width: 0, height: -1)
            } else {
                layer?.shadowOpacity = 0
            }
        }

        override func mouseDown(with event: NSEvent) {
            onClick()
        }
    }
}
