import AppKit
import StudioKit

/// Pure AppKit right inspector panel (`NSSplitViewItem(inspectorWithViewController:)`):
/// - Marka + Instagram / Facebook / LinkedIn account rows ("Bağla" popover)
/// - Bu sohbetin postları (thumbnails clicking into `PostDetailModel`, "Tümünü göster")
/// - Arka plan işleri (live elapsed timer, right-click "İşi iptal et", collapsible "N iş bitti").
final class InfoPanelViewController: NSViewController {
    private unowned let app: AppModel
    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let stack = NSStackView()

    private var showFinishedJobs = false
    private var now = Date()
    private var tickTask: Task<Void, Never>?
    private var observation: ObservationToken?
    private var activePopover: NSPopover?

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

            stack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: documentView.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -14),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.rebuild()
        }
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

        let brandId = app.routeBrandId
        let brandSection = buildBrandSection(brandId: brandId)
        addFullWidth(brandSection)

        if case .conversation(let convId) = app.route {
            addDivider()
            let convModel = app.conversationModel(convId)
            if app.posts.board.cards.isEmpty {
                Task { await app.posts.load() }
            }
            addFullWidth(buildConversationPostsSection(model: convModel))
        }

        addDivider()
        addFullWidth(buildJobsSection(brandId: brandId))
    }

    private func addFullWidth(_ view: NSView) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func addDivider() {
        let wrapper = NSView()
        wrapper.translatesAutoresizingMaskIntoConstraints = false
        let line = HairlineView()
        wrapper.addSubview(line)
        NSLayoutConstraint.activate([
            wrapper.heightAnchor.constraint(equalToConstant: 25),
            line.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor),
            line.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor),
            line.centerYAnchor.constraint(equalTo: wrapper.centerYAnchor),
        ])
        addFullWidth(wrapper)
    }

    // MARK: Brand Section

    private func buildBrandSection(brandId: EntityID?) -> NSView {
        let section = NSStackView()
        section.orientation = .vertical
        section.alignment = .leading
        section.spacing = 0
        section.translatesAutoresizingMaskIntoConstraints = false

        let header = NSTextField.sectionTitle("Marka")
        section.addArrangedSubview(header)
        section.setCustomSpacing(8, after: header)

        if let brand = app.brand(brandId) {
            let profileBtn = AccentTextButton(title: "Marka Profili…") { [weak app] _ in
                app?.brandProfileTarget = BrandProfileTarget(brandId: brand.id)
            }
            let brandRow = InfoRowView(symbol: "circle.fill", symbolColor: Theme.textSecondary, title: brand.name, trailing: profileBtn)
            section.addArrangedSubview(brandRow)
            brandRow.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true

            let analyzeAction = PlainTextActionView(title: "AI ile Analiz Et", font: Theme.smallFont, color: Theme.textSecondary) { [weak app] in
                app?.brandProfileTarget = BrandProfileTarget(brandId: brand.id, startAnalysis: true)
            }
            section.addArrangedSubview(analyzeAction)
            section.setCustomSpacing(8, after: analyzeAction)

            let accounts = app.accounts(of: brand.id)
            for platform in Platform.knownCases {
                let account = accounts.first { $0.platform == platform }
                let trailing: NSView
                if let account, account.status == .connected {
                    let health = account.tokenHealth
                    let badgeText = (health == .expiringSoon || health == .invalid || health == .missingScopes)
                        ? (health?.label ?? "Kontrol et")
                        : "Bağlı"
                    let btn = PlainTextActionView(
                        title: badgeText,
                        font: Theme.smallFont,
                        color: (health == .expiringSoon || health == .invalid) ? Theme.accent : Theme.textSecondary
                    ) { [weak app] in
                        app?.accountConnectTarget = AccountConnectTarget(brandId: brand.id, platform: platform)
                    }
                    btn.toolTip = "\(account.handle) · Bağlantı detayları ve anahtar denetimi"
                    trailing = btn
                } else {
                    let title = account?.status == .needsReauth ? "Yeniden bağla" : "Bağla"
                    let btn = AccentTextButton(title: title) { [weak app] _ in
                        app?.accountConnectTarget = AccountConnectTarget(brandId: brand.id, platform: platform)
                    }
                    trailing = btn
                }
                let row = InfoRowView(symbol: "circle.dotted.circle", symbolColor: Theme.textTertiary, title: platform.displayName, trailing: trailing)
                section.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
            }
        } else {
            section.addArrangedSubview(NSTextField.styledLabel("Bu sohbetin markası yok.", font: Theme.captionFont, color: Theme.textSecondary))
        }
        return section
    }

    // MARK: Conversation Posts Section

    private func buildConversationPostsSection(model: ConversationModel) -> NSView {
        let cards = model.contentIds.compactMap { app.posts.card($0) }
        let section = NSStackView()
        section.orientation = .vertical
        section.alignment = .leading
        section.spacing = 0
        section.translatesAutoresizingMaskIntoConstraints = false

        let header = NSTextField.sectionTitle("Bu sohbetin postları")
        section.addArrangedSubview(header)
        section.setCustomSpacing(8, after: header)

        if cards.isEmpty {
            let emptyText = model.contentIds.isEmpty ? "Plan onaylanınca postlar burada görünür." : "Postlar yükleniyor…"
            let lbl = NSTextField.styledLabel(emptyText, font: Theme.captionFont, color: Theme.textSecondary, wraps: true)
            section.addArrangedSubview(lbl)
            lbl.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
        } else {
            for card in cards.prefix(3) {
                let row = PostMiniRowView(imageStore: app.images, card: card) { [weak app] in
                    guard let app else { return }
                    app.detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
                }
                section.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
            }
            let showAll = PlainTextActionView(title: "Tümünü göster", font: Theme.smallFont, color: Theme.textSecondary) { [weak app] in
                app?.navigate(to: .posts)
            }
            section.addArrangedSubview(showAll)
        }
        return section
    }

    // MARK: Jobs Section

    private func buildJobsSection(brandId: EntityID?) -> NSView {
        let jobs = app.jobBoard.jobs.filter { brandId == nil || $0.brandId == brandId || $0.brandId == nil }
        let active = jobs.filter { $0.status.isActive }
        let finished = jobs.filter { $0.status.isTerminal && ($0.finishedAt ?? $0.updatedAt) > now.addingTimeInterval(-86_400) }

        let section = NSStackView()
        section.orientation = .vertical
        section.alignment = .leading
        section.spacing = 0
        section.translatesAutoresizingMaskIntoConstraints = false

        let headerRow = NSStackView()
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.addArrangedSubview(NSTextField.sectionTitle("Arka plan işleri"))
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        headerRow.addArrangedSubview(spacer)
        if !app.jobBoard.state.isLive {
            let st = NSTextField.styledLabel(app.jobBoard.state == .polling ? "yenileniyor" : "bağlanıyor", font: Theme.smallFont, color: Theme.textTertiary)
            st.toolTip = "Canlı akış kopuk; iş listesi aralıklarla yenileniyor."
            headerRow.addArrangedSubview(st)
        }
        section.addArrangedSubview(headerRow)
        headerRow.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
        section.setCustomSpacing(8, after: headerRow)

        if active.isEmpty && finished.isEmpty {
            section.addArrangedSubview(NSTextField.styledLabel("Şu an iş yok.", font: Theme.captionFont, color: Theme.textSecondary))
        }

        for job in active {
            let elapsedText = job.status == .running
                ? TurkishFormat.elapsed(from: job.startedAt ?? job.updatedAt, to: now)
                : "sırada"
            let trailing = NSStackView(views: [
                NSTextField.styledLabel(elapsedText, font: Theme.smallFont, color: Theme.textSecondary),
                StatusDotView(color: Theme.accent),
            ])
            trailing.orientation = .horizontal
            trailing.alignment = .centerY
            trailing.spacing = 8

            let row = ActiveJobRowView(
                job: job,
                trailing: trailing,
                helpText: job.progressMessage ?? (job.status == .queued ? (app.isOnline ? "Sırada" : "Mac çevrimdışı; Mac açılınca çalışır.") : "Çalışıyor")
            ) { [weak app] in
                guard let app else { return }
                Task { _ = try? await app.dataService.cancelJob(job.id) }
            }
            section.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
        }

        if !finished.isEmpty {
            let chevron = NSImageView()
            chevron.image = NSImage(systemSymbolName: showFinishedJobs ? "chevron.down" : "chevron.right", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 8, weight: .semibold))
            chevron.contentTintColor = Theme.textTertiary

            let toggle = ClickableContainerView { [weak self] in
                guard let self else { return }
                self.showFinishedJobs.toggle()
                self.rebuild()
            }
            let toggleRow = InfoRowView(symbol: "diamond", symbolColor: Theme.textSecondary, title: "\(finished.count) iş bitti", trailing: chevron)
            toggle.setChild(toggleRow)
            section.addArrangedSubview(toggle)
            toggle.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true

            if showFinishedJobs {
                for job in finished {
                    let statusLabel: String = switch job.status {
                    case .succeeded: "bitti"
                    case .failed: "hata"
                    case .cancelled: "iptal"
                    default: ""
                    }
                    let line = NSStackView()
                    line.orientation = .horizontal
                    line.alignment = .centerY
                    let title = NSTextField.styledLabel(job.displayTitle, font: Theme.captionFont, color: Theme.textSecondary)
                    title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                    let sp = NSView()
                    sp.setContentHuggingPriority(.defaultLow, for: .horizontal)
                    line.addArrangedSubview(title)
                    line.addArrangedSubview(sp)
                    line.addArrangedSubview(NSTextField.styledLabel(statusLabel, font: Theme.smallFont, color: Theme.textTertiary))
                    line.edgeInsets = NSEdgeInsets(top: 4, left: 26, bottom: 4, right: 0)
                    section.addArrangedSubview(line)
                    line.widthAnchor.constraint(equalTo: section.widthAnchor).isActive = true
                }
            }
        }
        return section
    }
}

// MARK: - Inspector Helper Views

private final class InfoRowView: NSView {
    init(symbol: String, symbolColor: NSColor, title: String, trailing: NSView? = nil) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: symbol == "circle.fill" ? 9 : 11, weight: .regular))
        icon.contentTintColor = symbolColor
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 16).isActive = true

        let titleLabel = NSTextField.styledLabel(title, font: Theme.rowFont, color: Theme.textPrimary)
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [icon, titleLabel, spacer]
        if let trailing { views.append(trailing) }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 31),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

private final class ActiveJobRowView: NSView {
    private let onCancel: () -> Void

    init(job: Job, trailing: NSView, helpText: String, onCancel: @escaping () -> Void) {
        self.onCancel = onCancel
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = helpText

        let inner = InfoRowView(symbol: "diamond", symbolColor: Theme.textSecondary, title: job.displayTitle, trailing: trailing)
        addSubview(inner)
        NSLayoutConstraint.activate([
            inner.leadingAnchor.constraint(equalTo: leadingAnchor),
            inner.trailingAnchor.constraint(equalTo: trailingAnchor),
            inner.topAnchor.constraint(equalTo: topAnchor),
            inner.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let menu = NSMenu()
        let cancelItem = NSMenuItem(title: "İşi iptal et", action: #selector(cancelJob), keyEquivalent: "")
        cancelItem.target = self
        menu.addItem(cancelItem)
        self.menu = menu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func cancelJob() {
        onCancel()
    }
}

private final class AccentTextButton: NSControl {
    private let onClick: (NSView) -> Void

    init(title: String, onClick: @escaping (NSView) -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let lbl = NSTextField.styledLabel(title, font: NSFont.systemFont(ofSize: 11, weight: .semibold), color: Theme.accent)
        lbl.translatesAutoresizingMaskIntoConstraints = false
        addSubview(lbl)
        NSLayoutConstraint.activate([
            lbl.leadingAnchor.constraint(equalTo: leadingAnchor),
            lbl.trailingAnchor.constraint(equalTo: trailingAnchor),
            lbl.topAnchor.constraint(equalTo: topAnchor),
            lbl.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onClick(self)
    }
}

private final class PlainTextActionView: NSControl {
    private let onClick: () -> Void

    init(title: String, font: NSFont, color: NSColor, onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let lbl = NSTextField.styledLabel(title, font: font, color: color)
        lbl.translatesAutoresizingMaskIntoConstraints = false
        addSubview(lbl)
        NSLayoutConstraint.activate([
            lbl.leadingAnchor.constraint(equalTo: leadingAnchor),
            lbl.trailingAnchor.constraint(equalTo: trailingAnchor),
            lbl.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            lbl.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onClick()
    }
}

private final class ClickableContainerView: NSControl {
    private let onClick: () -> Void

    init(onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setChild(_ child: NSView) {
        addSubview(child)
        NSLayoutConstraint.activate([
            child.leadingAnchor.constraint(equalTo: leadingAnchor),
            child.trailingAnchor.constraint(equalTo: trailingAnchor),
            child.topAnchor.constraint(equalTo: topAnchor),
            child.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    override func mouseDown(with event: NSEvent) {
        onClick()
    }
}

private final class PostMiniRowView: NSControl {
    private let onClick: () -> Void

    init(imageStore: ImageStore?, card: PostCard, onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let swatch = ThemedView()
        swatch.borderColor = Theme.border
        swatch.borderWidth = 1
        swatch.cornerRadius = 7
        swatch.layer?.masksToBounds = true
        swatch.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            swatch.widthAnchor.constraint(equalToConstant: 30),
            swatch.heightAnchor.constraint(equalToConstant: 38),
        ])

        if let rendered = card.renderedAssetIds.first, !card.needsImage {
            let img = AssetImageView(store: imageStore, assetId: rendered, contentMode: .fill, cornerRadius: 7)
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

        let title = NSTextField.styledLabel(card.title, font: Theme.rowFont, color: Theme.textPrimary)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [swatch, title, spacer])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 7),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -7),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onClick()
    }
}
