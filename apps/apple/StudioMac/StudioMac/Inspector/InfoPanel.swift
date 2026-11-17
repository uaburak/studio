import AppKit
import StudioKit

/// Right panel in the Claude Code layout (Environment / Context / Connectors), pure AppKit
/// (`NSSplitViewItem(inspectorWithViewController:)`). Small grey section headers, compact
/// label-left / value-right rows and hairlines between sections:
/// - Ortam: this Mac's server (API, worker, LAN address, Cloudflare remote access) and the brand
/// - Kullanım: Claude subscription windows as thin meters with reset times, Claude + Gemini status
/// - Bağlam (conversation only): messages, image aliases, plans, posts, model and the run
/// - Hesaplar: the brand's Instagram / Facebook / LinkedIn connections ("Bağla" opens the sheet)
/// - İşler: background jobs (live elapsed time, right-click cancel, collapsible finished list).
/// Texts come from `InspectorContent`; nothing is shown that the server does not report.
final class InfoPanelViewController: NSViewController {
    private unowned let app: AppModel
    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let stack = NSStackView()

    private var showFinishedJobs = false
    private var now = Date()
    private var tickTask: Task<Void, Never>?
    private var observation: ObservationToken?
    /// The conversation whose posts were last requested (the posts board loads once per visit).
    private var postsRequestedFor: EntityID?

    /// Section titles shown now, in order (tests).
    private(set) var sectionTitles: [String] = []

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

        let brandId = app.routeBrandId
        addSection(buildEnvironmentSection(brandId: brandId))
        addSection(buildUsageSection())
        if case .conversation(let id) = app.route {
            addSection(buildContextSection(conversationId: id))
        }
        addSection(buildAccountsSection(brandId: brandId))
        addSection(buildJobsSection(brandId: brandId))
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
        let rows = InspectorContent.environment(
            isSample: app.isSample,
            host: app.host.map(HostSnapshot.init),
            hostEnabled: settings.hostEnabled,
            serverURL: settings.serverURL,
            lanEnabled: settings.lanEnabled,
            remoteEnabled: settings.remoteControlEnabled,
            remoteHostname: settings.remoteHostname,
            issue: app.connectionIssue,
            presence: app.presence
        )
        for row in rows {
            section.addRow(row) { [weak app] _ in app?.openSettings(.macServer) }
        }
        if let brand = app.brand(brandId) {
            section.addRow(PanelRow(label: "Marka", value: brand.name, help: "Marka ayarları, kit, profil ve AI analizi")) { [weak self] anchor in
                self?.showBrandMenu(brand.id, from: anchor)
            }
        } else {
            section.addRow(PanelRow(label: "Marka", value: "Yok", tone: .muted, help: "Bu sohbetin markası yok."))
        }
        return section
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

    // MARK: İşler

    private func buildJobsSection(brandId: EntityID?) -> PanelSectionView {
        let jobs = app.jobBoard.jobs.filter { brandId == nil || $0.brandId == brandId || $0.brandId == nil }
        let active = jobs.filter { $0.status.isActive }
        let finished = jobs.filter { $0.status.isTerminal && ($0.finishedAt ?? $0.updatedAt) > now.addingTimeInterval(-86_400) }

        var stateText: String?
        if !app.jobBoard.state.isLive {
            stateText = app.jobBoard.state == .polling ? "yenileniyor" : "bağlanıyor"
        }
        let section = PanelSectionView(title: "İşler", trailingNote: stateText)
        section.trailingNoteHelp = "Canlı akış kopuk; iş listesi aralıklarla yenileniyor."

        if active.isEmpty && finished.isEmpty {
            section.addNote("Şu an iş yok.")
        }

        for job in active {
            let value = job.status == .running
                ? TurkishFormat.elapsed(from: job.startedAt ?? job.updatedAt, to: now)
                : "sırada"
            let help = job.progressMessage ?? (job.status == .queued ? (app.isOnline ? "Sırada" : "Mac çevrimdışı; Mac açılınca çalışır.") : "Çalışıyor")
            let row = PanelRowView(row: PanelRow(label: job.displayTitle, value: value, help: help), leadingDot: Theme.accent, onClick: nil)
            row.labelColor = Theme.textPrimary
            let menu = NSMenu()
            menu.addItem(ClosureMenuItem(title: "İşi iptal et") { [weak app] in
                guard let app else { return }
                Task { _ = try? await app.dataService.cancelJob(job.id) }
            })
            row.menu = menu
            section.add(row)
        }

        if !finished.isEmpty {
            let toggle = PanelRowView(
                row: PanelRow(label: "\(finished.count) iş bitti", value: showFinishedJobs ? "Gizle" : "Göster", tone: .muted),
                onClick: { [weak self] _ in
                    guard let self else { return }
                    self.showFinishedJobs.toggle()
                    self.rebuild()
                }
            )
            toggle.setAccessibilityLabel("\(finished.count) iş bitti, \(showFinishedJobs ? "gizle" : "göster")")
            section.add(toggle)

            if showFinishedJobs {
                for job in finished {
                    let status: String = switch job.status {
                    case .succeeded: "bitti"
                    case .failed: "hata"
                    case .cancelled: "iptal"
                    default: ""
                    }
                    let row = PanelRowView(row: PanelRow(label: job.displayTitle, value: status, tone: job.status == .failed ? .attention : .muted), onClick: nil)
                    row.labelColor = Theme.textSecondary
                    section.add(row)
                }
            }
        }
        return section
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
