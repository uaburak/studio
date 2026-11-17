import AppKit
import StudioKit

/// Right panel in the Claude Code layout, pure AppKit (a plain, flush `NSSplitViewItem`, no glass).
/// Its title and actions sit in the top bar (`TopBarView`); the panel shows one pane:
/// - Ayrıntılar (Claude Code's Environment / Context / Connectors): small grey section headers,
///   compact label-left / value-right rows, hairlines between sections:
///   - Ortam: this Mac's server (API, worker, LAN address, Cloudflare remote access) and the brand
///   - Kullanım: Claude subscription windows as thin meters with reset times, Claude + Gemini status
///   - Bağlam (conversation only): messages, image aliases, plans, posts, model and the run
///   - Hesaplar: the brand's Instagram / Facebook / LinkedIn connections ("Bağla" opens the sheet)
/// - Arka plan işleri (Claude Code's Background tasks): "Çalışıyor 1" with rounded job cards
///   (elapsed time, stop), "Sırada", and a collapsible "› Bitti 12" list.
/// - Takvim, Medya, Marka, iPhone: panes that keep their own views (`PanelPaneViews.swift`).
/// Texts come from `InspectorContent`; nothing is shown that the server does not report.
final class InfoPanelViewController: NSViewController {
    private unowned let app: AppModel
    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let stack = NSStackView()
    /// The Takvim / Medya / Marka / iPhone pane on screen (nil for Ayrıntılar and the jobs).
    private(set) var paneView: PanelPaneView?
    private var paneViewKind: RightPanelPane?

    private var showFinishedJobs = false
    /// "Gelişmiş" under Ortam: technical rows, folded by default.
    private(set) var showAdvancedEnvironment = false
    /// The plain Ortam state built last (tests).
    private(set) var shownEnvironment: EnvironmentSummary?
    private var now = Date()
    private var tickTask: Task<Void, Never>?
    private var observation: ObservationToken?
    /// The conversation whose posts were last requested (the posts board loads once per visit).
    private var postsRequestedFor: EntityID?

    /// Section titles shown now, in order (tests).
    private(set) var sectionTitles: [String] = []
    /// The pane built last (tests).
    private(set) var shownPane: RightPanelPane?

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

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        documentView.addSubview(stack)

        root.addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            documentView.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            documentView.topAnchor.constraint(equalTo: clip.topAnchor),

            stack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor, constant: Theme.Panel.horizontalPadding),
            stack.trailingAnchor.constraint(equalTo: documentView.trailingAnchor, constant: -Theme.Panel.horizontalPadding),
            stack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -16),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.rebuild()
        }
        // Elapsed job times and "sıfırlanma: 2 saat sonra" stay current.
        tickTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled else { return }
                self.now = Date()
                self.rebuild()
            }
        }
    }

    deinit {
        tickTask?.cancel()
    }

    private func rebuild() {
        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        sectionTitles = []

        let pane = app.inspectorPane
        shownPane = pane
        switch pane {
        case .details:
            showPaneView(nil)
            let brandId = app.routeBrandId
            addSection(buildEnvironmentSection(brandId: brandId))
            addSection(buildUsageSection())
            if case .conversation(let id) = app.route {
                addSection(buildContextSection(conversationId: id))
            }
            addSection(buildAccountsSection(brandId: brandId))
        case .jobs:
            showPaneView(nil)
            buildJobsPane()
        case .calendar, .media, .brand, .phone:
            // Only the pane is read here: the pane view observes its own data.
            showPaneView(pane)
        }
    }

    /// Swaps the persistent pane in (or out, for Ayrıntılar and the jobs list).
    private func showPaneView(_ pane: RightPanelPane?) {
        guard pane != paneViewKind else { return }
        paneView?.removeFromSuperview()
        paneView = nil
        paneViewKind = pane
        scrollView.isHidden = pane != nil
        guard let pane else { return }
        let next: PanelPaneView = switch pane {
        case .calendar: CalendarPaneView(app: app)
        case .media: MediaPaneView(app: app)
        case .brand: BrandPaneView(app: app)
        case .phone: PhonePaneView(app: app)
        case .details, .jobs: preconditionFailure("not a pane view")
        }
        view.addSubview(next)
        NSLayoutConstraint.activate([
            next.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            next.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            next.topAnchor.constraint(equalTo: view.topAnchor),
            next.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        paneView = next
    }

    private func addSection(_ section: PanelSectionView) {
        if !stack.arrangedSubviews.isEmpty {
            let divider = SectionDividerView()
            stack.addArrangedSubview(divider)
            divider.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        stack.addArrangedSubview(section)
        section.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        sectionTitles.append(section.title)
    }

    // MARK: Ortam

    private func buildEnvironmentSection(brandId: EntityID?) -> PanelSectionView {
        let settings = app.settings
        let section = PanelSectionView(title: "Ortam", linkTitle: "Ayarlar") { [weak app] in app?.openSettings(.macServer) }
        let host = app.host.map(HostSnapshot.init)
        let issue = app.connectionIssue

        // Plain state first: Hazır / Hazırlanıyor / Sorun var, and one action for a problem.
        let summary = InspectorContent.environmentSummary(
            isSample: app.isSample, host: host, hostEnabled: settings.hostEnabled, issue: issue, presence: app.presence
        )
        shownEnvironment = summary
        section.addRow(summary.row) { [weak self] _ in
            guard let self else { return }
            if let action = summary.action { self.app.perform(action) } else { self.toggleAdvancedEnvironment() }
        }
        if summary.state == .problem {
            if let detail = summary.detail { section.addNote(detail) }
            if let action = summary.action, let title = summary.actionTitle {
                let button = PillButton(title: title, kind: .secondary, height: 24) { [weak app] in app?.perform(action) }
                button.setAccessibilityLabel("\(title): \(summary.detail ?? "")")
                section.add(button, spacingAfter: 8, fullWidth: false)
            }
        }

        if let brand = app.brand(brandId) {
            section.addRow(PanelRow(label: "Marka", value: brand.name, help: "Marka ayarları, kit, profil ve AI analizi")) { [weak self] anchor in
                self?.showBrandMenu(brand.id, from: anchor)
            }
        } else {
            section.addRow(PanelRow(label: "Marka", value: "Yok", tone: .muted, help: "Bu sohbetin markası yok."))
        }

        // Technical details (API, worker, addresses, tunnel) stay folded under "Gelişmiş".
        section.addSpacing(4)
        let toggle = JobsDisclosureRowView(title: "Gelişmiş", count: nil, expanded: showAdvancedEnvironment) { [weak self] in
            self?.toggleAdvancedEnvironment()
        }
        section.add(toggle)
        if showAdvancedEnvironment {
            let rows = InspectorContent.advancedEnvironment(
                isSample: app.isSample,
                host: host,
                hostEnabled: settings.hostEnabled,
                serverURL: settings.serverURL,
                lanEnabled: settings.lanEnabled,
                remoteEnabled: settings.remoteControlEnabled,
                remoteHostname: settings.remoteHostname,
                issue: issue,
                presence: app.presence
            )
            for row in rows {
                section.addRow(row) { [weak app] _ in app?.openSettings(.macServer) }
            }
        }
        return section
    }

    private func toggleAdvancedEnvironment() {
        showAdvancedEnvironment.toggle()
        rebuild()
    }

    private func showBrandMenu(_ brandId: EntityID, from anchor: NSView) {
        let menu = NSMenu()
        menu.addItem(ClosureMenuItem(title: "Marka ayarları…") { [weak app] in app?.openBrandSettings(brandId) })
        menu.addItem(ClosureMenuItem(title: "Marka profili…") { [weak app] in app?.brandProfileTarget = BrandProfileTarget(brandId: brandId) })
        menu.addItem(ClosureMenuItem(title: "Marka kiti…") { [weak app] in app?.openBrandSettings(brandId, tab: .kit) })
        menu.addItem(ClosureMenuItem(title: "AI ile analiz et") { [weak app] in
            app?.brandProfileTarget = BrandProfileTarget(brandId: brandId, startAnalysis: true)
        })
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -2), in: anchor)
    }

    // MARK: Kullanım

    private func buildUsageSection() -> PanelSectionView {
        let presence = app.presence
        let section = PanelSectionView(title: "Kullanım", linkTitle: "Ayarlar") { [weak app] in app?.openSettings(.usage) }

        let meters = InspectorContent.usageMeters(presence?.usage, now: now)
        for meter in meters {
            section.add(UsageMeterView(meter: meter), spacingAfter: 10)
        }
        if let note = InspectorContent.usageNote(presence) {
            section.addNote(note)
        }

        for row in InspectorContent.providers(presence) {
            section.addRow(row) { [weak app] _ in
                guard let app else { return }
                if row.tone == .action, row.label == "Claude" {
                    app.perform(.signInClaude)
                } else {
                    app.openSettings(.ai)
                }
            }
        }
        if let updated = InspectorContent.usageUpdated(presence?.usage, now: now) {
            section.addFootnote(updated)
        }
        return section
    }

    // MARK: Bağlam

    private func buildContextSection(conversationId: EntityID) -> PanelSectionView {
        let model = app.conversationModel(conversationId)
        let section = PanelSectionView(title: "Bağlam")
        guard let state = model.state else {
            section.addNote("Yükleniyor…")
            return section
        }
        for row in InspectorContent.context(state: state, choice: model.agentChoice) {
            section.addRow(row)
        }
        if let aliases = InspectorContent.aliasLine(state) {
            section.addFootnote(aliases)
        }

        let contentIds = model.contentIds
        guard !contentIds.isEmpty else { return section }
        if app.posts.board.cards.isEmpty, postsRequestedFor != conversationId {
            postsRequestedFor = conversationId
            Task { await app.posts.load() }
        }
        let cards = contentIds.compactMap { app.posts.card($0) }
        if cards.isEmpty {
            // Only while the board is still loading; posts of another month stay in Postlar.
            if app.posts.isLoading || app.posts.board.cards.isEmpty { section.addNote("Postlar yükleniyor…") }
            return section
        }
        section.addSpacing(6)
        for card in cards.prefix(3) {
            let row = PostMiniRowView(imageStore: app.images, card: card) { [weak app] in
                guard let app else { return }
                app.detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
            }
            section.add(row)
        }
        let showAll = PanelLinkView(title: cards.count > 3 ? "Tümünü göster (\(cards.count))" : "Postlarda aç") { [weak app] in
            app?.navigate(to: .posts)
        }
        section.add(showAll, fullWidth: false)
        return section
    }

    // MARK: Hesaplar

    private func buildAccountsSection(brandId: EntityID?) -> PanelSectionView {
        let section = PanelSectionView(title: "Hesaplar", linkTitle: "Ayarlar") { [weak app] in app?.openSettings(.accounts) }
        guard let brandId, app.brand(brandId) != nil else {
            section.addNote("Bu sohbetin markası yok.")
            return section
        }
        let accounts = app.accounts(of: brandId)
        for platform in Platform.knownCases {
            let row = InspectorContent.account(platform: platform, account: accounts.first { $0.platform == platform })
            section.addRow(row) { [weak app] _ in
                app?.accountConnectTarget = AccountConnectTarget(brandId: brandId, platform: platform)
            }
        }
        return section
    }

    // MARK: Arka plan işleri

    private func buildJobsPane() {
        let content = app.panelJobs(now: now)

        if !app.jobBoard.state.isLive {
            let note = NSTextField.styledLabel(
                app.jobBoard.state == .polling ? "Canlı akış kopuk; liste aralıklarla yenileniyor." : "İş akışına bağlanılıyor…",
                font: Theme.Panel.footnoteFont, color: Theme.textTertiary, wraps: true
            )
            addJobsView(note, spacingAfter: 10)
        }

        if content.isEmpty {
            addJobsView(NSTextField.styledLabel("Arka planda iş yok.", font: Theme.captionFont, color: Theme.textSecondary), spacingAfter: 8)
            sectionTitles = []
            return
        }

        if !content.running.isEmpty {
            addJobsGroup(title: "Çalışıyor", jobs: content.running)
        }
        if !content.queued.isEmpty {
            addJobsGroup(title: "Sırada", jobs: content.queued)
        }
        if !content.finished.isEmpty {
            sectionTitles.append("Bitti")
            let toggle = JobsDisclosureRowView(title: "Bitti", count: content.finished.count, expanded: showFinishedJobs) { [weak self] in
                guard let self else { return }
                self.showFinishedJobs.toggle()
                self.rebuild()
            }
            addJobsView(toggle, spacingAfter: 4)
            if showFinishedJobs {
                for job in content.finished {
                    let row = PanelRowView(
                        row: PanelRow(label: job.displayTitle, value: JobsPaneContent.statusText(job.status), tone: job.status == .failed ? .attention : .muted, help: job.error ?? job.progressMessage),
                        onClick: nil
                    )
                    row.labelColor = Theme.textSecondary
                    addJobsView(row)
                }
            }
        }
    }

    /// "Çalışıyor 2" and the job cards under it.
    private func addJobsGroup(title: String, jobs: [Job]) {
        sectionTitles.append(title)
        addJobsView(JobsGroupLabel(title: title, count: jobs.count), spacingAfter: 8)
        for job in jobs {
            let value = job.status == .running ? TurkishFormat.elapsed(from: job.startedAt ?? job.updatedAt, to: now) : "sırada"
            let help = job.progressMessage ?? (job.status == .queued ? (app.isOnline ? "Sırada" : "Mac çevrimdışı; Mac açılınca çalışır.") : "Çalışıyor")
            let opensPost = job.contentId != nil && (job.brandId ?? app.currentBrandId) != nil
            let card = JobCardView(
                title: job.displayTitle,
                value: value,
                help: help,
                cancelling: job.cancelRequestedAt != nil,
                onOpen: opensPost ? { [weak app] in
                    guard let app, let contentId = job.contentId, let brandId = job.brandId ?? app.currentBrandId else { return }
                    Task { await app.openPost(contentId: contentId, brandId: brandId) }
                } : nil,
                onStop: { [weak app] in
                    guard let app else { return }
                    Task { _ = try? await app.dataService.cancelJob(job.id) }
                }
            )
            addJobsView(card, spacingAfter: 6)
        }
        if let last = stack.arrangedSubviews.last { stack.setCustomSpacing(18, after: last) }
    }

    private func addJobsView(_ view: NSView, spacingAfter: CGFloat? = nil) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        if let spacingAfter { stack.setCustomSpacing(spacingAfter, after: view) }
    }
}

// MARK: - Panel building blocks

/// A section: tiny grey header (optional link or note on the right), then its rows.
private final class PanelSectionView: NSStackView {
    let title: String
    var trailingNoteHelp: String? {
        didSet { trailingNoteLabel?.toolTip = trailingNoteHelp }
    }
    private var trailingNoteLabel: NSTextField?

    init(title: String, linkTitle: String? = nil, trailingNote: String? = nil, onLink: (() -> Void)? = nil) {
        self.title = title
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .leading
        spacing = 0
        translatesAutoresizingMaskIntoConstraints = false

        let header = NSTextField.styledLabel(title, font: Theme.Panel.headerFont, color: Theme.textSecondary)
        header.setAccessibilityRole(.staticText)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        var views: [NSView] = [header, spacer]
        if let trailingNote {
            let note = NSTextField.styledLabel(trailingNote, font: Theme.Panel.linkFont, color: Theme.textTertiary)
            trailingNoteLabel = note
            views.append(note)
        }
        if let linkTitle, let onLink {
            let link = PanelLinkView(title: linkTitle, action: onLink)
            link.toolTip = "\(title) ayarları"
            views.append(link)
        }
        let headerRow = NSStackView(views: views)
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 8
        headerRow.translatesAutoresizingMaskIntoConstraints = false
        headerRow.heightAnchor.constraint(equalToConstant: 20).isActive = true
        add(headerRow, spacingAfter: 6)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func add(_ view: NSView, spacingAfter: CGFloat? = nil, fullWidth: Bool = true) {
        addArrangedSubview(view)
        if fullWidth { view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true }
        if let spacingAfter { setCustomSpacing(spacingAfter, after: view) }
    }

    func addRow(_ row: PanelRow, onClick: ((NSView) -> Void)? = nil) {
        add(PanelRowView(row: row, onClick: onClick))
    }

    func addNote(_ text: String) {
        let label = NSTextField.styledLabel(text, font: Theme.captionFont, color: Theme.textSecondary, wraps: true)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        add(label, spacingAfter: 8)
    }

    func addFootnote(_ text: String) {
        if let last = arrangedSubviews.last { setCustomSpacing(4, after: last) }
        let label = NSTextField.styledLabel(text, font: Theme.Panel.footnoteFont, color: Theme.textTertiary)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        add(label)
    }

    func addSpacing(_ value: CGFloat) {
        if let last = arrangedSubviews.last { setCustomSpacing(value, after: last) }
    }
}

/// Hairline with breathing room between sections.
private final class SectionDividerView: NSView {
    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let line = HairlineView()
        addSubview(line)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Theme.Panel.sectionSpacing * 2 + 1),
            line.leadingAnchor.constraint(equalTo: leadingAnchor),
            line.trailingAnchor.constraint(equalTo: trailingAnchor),
            line.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Label left (grey), value right (by tone); clickable rows act like links.
final class PanelRowView: TapControl {
    private let onClick: ((NSView) -> Void)?
    private let labelField: NSTextField
    private let valueField: NSTextField

    var labelColor: NSColor {
        get { labelField.textColor ?? Theme.textSecondary }
        set { labelField.textColor = newValue }
    }

    /// Plain texts (tests).
    var labelText: String { labelField.stringValue }
    var valueText: String { valueField.stringValue }

    init(row: PanelRow, leadingDot: NSColor? = nil, onClick: ((NSView) -> Void)?) {
        self.onClick = onClick
        labelField = NSTextField.styledLabel(row.label, font: Theme.Panel.rowFont, color: Theme.textSecondary)
        valueField = NSTextField.styledLabel(row.value, font: Self.valueFont(row.tone), color: Self.valueColor(row.tone))
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = row.help
        setAccessibilityLabel("\(row.label): \(row.value)")
        if onClick == nil { setAccessibilityRole(.group) }

        labelField.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(740), for: .horizontal)
        labelField.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        valueField.alignment = .right
        valueField.lineBreakMode = .byTruncatingMiddle
        valueField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)

        var views: [NSView] = [labelField, spacer]
        if let leadingDot { views.append(StatusDotView(color: leadingDot)) }
        views.append(valueField)

        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Theme.Panel.rowHeight),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    static func valueColor(_ tone: PanelRow.Tone) -> NSColor {
        switch tone {
        case .normal: Theme.textPrimary
        case .muted: Theme.textTertiary
        case .attention, .action: Theme.accent
        }
    }

    private static func valueFont(_ tone: PanelRow.Tone) -> NSFont {
        tone == .action ? NSFont.systemFont(ofSize: 12, weight: .semibold) : Theme.Panel.rowFont
    }

    /// Only clickable rows join the key-view loop (Full Keyboard Access).
    override var acceptsFirstResponder: Bool { onClick != nil && super.acceptsFirstResponder }

    override func resetCursorRects() {
        if onClick != nil { addCursorRect(bounds, cursor: .pointingHand) }
    }

    override func mouseDown(with event: NSEvent) {
        if let onClick { onClick(self) } else { super.mouseDown(with: event) }
    }

    override func performTap() { onClick?(self) }
}

/// Small grey text link ("Ayarlar", "Tümünü göster").
private final class PanelLinkView: TapControl {
    private let onTap: () -> Void
    private let label: NSTextField

    init(title: String, action: @escaping () -> Void) {
        self.onTap = action
        label = NSTextField.styledLabel(title, font: Theme.Panel.linkFont, color: Theme.textTertiary)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(title)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(equalTo: trailingAnchor),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func mouseDown(with event: NSEvent) { onTap() }
    override func performTap() { onTap() }
}

/// "5 saatlik ……… %42 kullanıldı", a thin bar, "Sıfırlanma: 3 saat sonra".
final class UsageMeterView: NSView {
    let meter: UsageMeter

    init(meter: UsageMeter) {
        self.meter = meter
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityLabel("\(meter.title): \(meter.usedText)\(meter.resetText.map { ", \($0)" } ?? "")")

        let title = NSTextField.styledLabel(meter.title, font: Theme.Panel.rowFont, color: Theme.textPrimary)
        title.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(740), for: .horizontal)
        let used = NSTextField.styledLabel(
            meter.usedText,
            font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
            color: meter.warning ? Theme.accent : Theme.textSecondary
        )
        used.alignment = .right
        used.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let top = NSStackView(views: [title, spacer, used])
        top.orientation = .horizontal
        top.alignment = .firstBaseline
        top.spacing = 8

        let bar = UsageBarView(fraction: meter.fraction, warning: meter.warning)

        var views: [NSView] = [top, bar]
        if let reset = meter.resetText {
            views.append(NSTextField.styledLabel(reset, font: Theme.Panel.footnoteFont, color: Theme.textTertiary))
        }
        let column = NSStackView(views: views)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 5
        column.setCustomSpacing(6, after: top)
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)

        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            top.widthAnchor.constraint(equalTo: column.widthAnchor),
            bar.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// 4pt rounded track with the used part filled (ink, or the accent near the limit).
final class UsageBarView: ThemedView {
    let fraction: Double
    private let fill = ThemedView()

    init(fraction: Double, warning: Bool) {
        self.fraction = min(max(fraction, 0), 1)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.meterTrack
        cornerRadius = 2
        fill.backgroundColor = warning ? Theme.accent : Theme.ink
        fill.cornerRadius = 2
        addSubview(fill)
        heightAnchor.constraint(equalToConstant: 4).isActive = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Width of the filled part for a track `width` wide (a used window never draws as empty).
    static func fillWidth(fraction: Double, width: CGFloat) -> CGFloat {
        guard fraction > 0, width > 0 else { return 0 }
        return max(4, (width * CGFloat(min(fraction, 1))).rounded())
    }

    override func layout() {
        super.layout()
        fill.frame = NSRect(x: 0, y: 0, width: Self.fillWidth(fraction: fraction, width: bounds.width), height: bounds.height)
    }
}

private final class PostMiniRowView: NSControl {
    private let onClick: () -> Void

    init(imageStore: ImageStore?, card: PostCard, onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(card.title)

        let swatch = ThemedView()
        swatch.borderColor = Theme.border
        swatch.borderWidth = 1
        swatch.cornerRadius = 6
        swatch.layer?.masksToBounds = true
        swatch.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            swatch.widthAnchor.constraint(equalToConstant: 26),
            swatch.heightAnchor.constraint(equalToConstant: 32),
        ])

        if let rendered = card.renderedAssetIds.first, !card.needsImage {
            let img = AssetImageView(store: imageStore, assetId: rendered, contentMode: .fill, cornerRadius: 6)
            img.translatesAutoresizingMaskIntoConstraints = false
            swatch.addSubview(img)
            NSLayoutConstraint.activate([
                img.leadingAnchor.constraint(equalTo: swatch.leadingAnchor),
                img.trailingAnchor.constraint(equalTo: swatch.trailingAnchor),
                img.topAnchor.constraint(equalTo: swatch.topAnchor),
                img.bottomAnchor.constraint(equalTo: swatch.bottomAnchor),
            ])
        } else {
            switch card.placeholderTone {
            case .dark: swatch.backgroundColor = Theme.postDark
            case .light: swatch.backgroundColor = Theme.postLight
            case .muted:
                swatch.backgroundColor = Theme.postMuted
                let plus = NSImageView()
                plus.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)?
                    .withSymbolConfiguration(.init(pointSize: 9, weight: .regular))
                plus.contentTintColor = Theme.accent
                plus.translatesAutoresizingMaskIntoConstraints = false
                swatch.addSubview(plus)
                NSLayoutConstraint.activate([
                    plus.centerXAnchor.constraint(equalTo: swatch.centerXAnchor),
                    plus.centerYAnchor.constraint(equalTo: swatch.centerYAnchor),
                ])
            }
        }

        let title = NSTextField.styledLabel(card.title, font: Theme.Panel.rowFont, color: Theme.textPrimary)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [swatch, title, spacer])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
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

    override func mouseDown(with event: NSEvent) {
        onClick()
    }

    override func accessibilityPerformPress() -> Bool {
        onClick()
        return true
    }
}

// MARK: - Jobs pane building blocks (Claude Code's Background tasks)

/// "Çalışıyor 2": a small grey label with the count a step lighter.
final class JobsGroupLabel: NSView {
    let title: String
    let count: Int

    init(title: String, count: Int) {
        self.title = title
        self.count = count
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let text = NSMutableAttributedString(string: title, attributes: [.font: Theme.captionFont, .foregroundColor: Theme.textSecondary])
        text.append(NSAttributedString(string: "  \(count)", attributes: [.font: Theme.captionFont, .foregroundColor: Theme.textTertiary]))
        let label = NSTextField(labelWithAttributedString: text)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setAccessibilityLabel("\(title): \(count)")
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            label.topAnchor.constraint(equalTo: topAnchor),
            label.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// One job as a rounded card: title, elapsed time (or "sırada") and a stop button.
/// A job that made a post opens it on click.
final class JobCardView: TapControl {
    let titleText: String
    let valueText: String
    private let onOpen: (() -> Void)?
    private let card = ThemedView()

    init(title: String, value: String, help: String?, cancelling: Bool, onOpen: (() -> Void)?, onStop: @escaping () -> Void) {
        self.titleText = title
        self.valueText = value
        self.onOpen = onOpen
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = help
        setAccessibilityLabel("\(title), \(value)")
        if onOpen == nil { setAccessibilityRole(.group) }

        card.backgroundColor = Theme.panelCard
        card.cornerRadius = 10
        card.translatesAutoresizingMaskIntoConstraints = false
        addSubview(card)

        let titleLabel = NSTextField.styledLabel(title, font: Theme.Panel.rowFont, color: Theme.textPrimary)
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        var views: [NSView] = [titleLabel]
        if onOpen != nil {
            let chevron = NSImageView()
            chevron.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
            chevron.contentTintColor = Theme.textTertiary
            chevron.setContentCompressionResistancePriority(.required, for: .horizontal)
            views.append(chevron)
        }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        views.append(spacer)
        let valueLabel = NSTextField.styledLabel(
            cancelling ? "durduruluyor" : value,
            font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
            color: Theme.textSecondary
        )
        valueLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(760), for: .horizontal)
        views.append(valueLabel)

        let stop = JobStopButton(action: onStop)
        stop.isEnabled = !cancelling
        views.append(stop)

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.setCustomSpacing(10, after: valueLabel)
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)
        // Breakable, so a squeezed panel never reports conflicting constraints.
        let rowTrailing = row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -8)
        rowTrailing.priority = NSLayoutConstraint.Priority(999)

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 42),
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
            rowTrailing,
            row.centerYAnchor.constraint(equalTo: card.centerYAnchor),
        ])

        let menu = NSMenu()
        menu.addItem(ClosureMenuItem(title: "İşi durdur", action: onStop))
        self.menu = menu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var trackingArea: NSTrackingArea?

    override var acceptsFirstResponder: Bool { onOpen != nil && super.acceptsFirstResponder }
    override func mouseDown(with event: NSEvent) { onOpen?() }
    override func performTap() { onOpen?() }

    // A subtle hover fill instead of the pointing hand (the hand is for links only).
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        guard onOpen != nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { card.backgroundColor = Theme.fillStrong }
    override func mouseExited(with event: NSEvent) { card.backgroundColor = Theme.panelCard }
}

/// The small rounded square "■" that stops a job.
final class JobStopButton: NSControl {
    private let onStop: () -> Void
    private let icon = NSImageView()
    private var hovering = false { didSet { refresh() } }
    private var trackingArea: NSTrackingArea?

    override var isEnabled: Bool { didSet { refresh() } }

    init(action: @escaping () -> Void) {
        self.onStop = action
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.cornerCurve = .continuous
        toolTip = "İşi durdur"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("İşi durdur")
        icon.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 8, weight: .bold))
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 22),
            heightAnchor.constraint(equalToConstant: 22),
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func refresh() {
        layer?.backgroundColor = resolvedCGColor(hovering && isEnabled ? Theme.border : Theme.fillStrong)
        icon.contentTintColor = Theme.textPrimary
        alphaValue = isEnabled ? 1 : 0.4
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refresh()
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
    override func mouseDown(with event: NSEvent) { if isEnabled { onStop() } }
    override var acceptsFirstResponder: Bool { KeyboardFocus.accepts(isEnabled: isEnabled) }
    override func keyDown(with event: NSEvent) {
        if isEnabled, KeyboardFocus.isActivation(event) { onStop() } else { super.keyDown(with: event) }
    }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        onStop()
        return true
    }
}

/// "› Bitti 12": folds the finished jobs (and, without a count, "› Gelişmiş" under Ortam).
final class JobsDisclosureRowView: TapControl {
    private let onToggle: () -> Void
    let title: String
    let expanded: Bool

    init(title: String, count: Int?, expanded: Bool, onToggle: @escaping () -> Void) {
        self.onToggle = onToggle
        self.title = title
        self.expanded = expanded
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(count.map { "\(title) \($0)" } ?? title)
        setAccessibilityValue(expanded ? "Açık" : "Kapalı")
        setAccessibilityHelp(expanded ? "Gizlemek için bas" : "Göstermek için bas")

        let chevron = NSImageView()
        chevron.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        chevron.contentTintColor = Theme.textTertiary
        chevron.translatesAutoresizingMaskIntoConstraints = false
        chevron.widthAnchor.constraint(equalToConstant: 12).isActive = true

        let text = NSMutableAttributedString(string: title, attributes: [.font: Theme.Panel.rowFont, .foregroundColor: Theme.textSecondary])
        if let count {
            text.append(NSAttributedString(string: " \(count)", attributes: [.font: Theme.Panel.rowFont, .foregroundColor: Theme.textTertiary]))
        }
        let label = NSTextField(labelWithAttributedString: text)

        let row = NSStackView(views: [chevron, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func mouseDown(with event: NSEvent) { onToggle() }
    override func performTap() { onToggle() }
}
