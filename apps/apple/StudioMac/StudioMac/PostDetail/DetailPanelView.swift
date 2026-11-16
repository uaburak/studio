import AppKit
import StudioKit

/// Right side of the opened post: header, Post / Düzenle / Sürümler, "Neyi değiştireyim?",
/// Zamanla and Onayla.
final class DetailPanelView: ThemedView, NSTextFieldDelegate {
    struct Actions {
        var close: () -> Void
        var export: (NSView) -> Void
        var share: (NSView) -> Void
        var delete: () -> Void
        var duplicate: () -> Void
        var pickImage: (String) -> Void
        var editTextInline: (String) -> Void
    }

    private let model: PostDetailModel
    private let actions: Actions

    private let handleLabel = NSTextField(labelWithString: "")
    private var exportButton: GlyphButton!
    private var moreButton: GlyphButton!
    private let tabs: TabPillsView
    private let postTab: PostTabView
    private let editTab: EditTabView
    private let versionsTab: VersionsTabView
    private let statusLine = StatusLineView()
    private let errorBanner = InlineErrorBannerView()
    private let instructionField = NSTextField()
    private let sendInstructionButton = GlyphButton(symbol: "return", size: 11)
    private var scheduleButton: PillButton!
    private var approveButton: PillButton!
    private var activeSchedulePopover: NSPopover?
    private var observation: ObservationToken?

    init(model: PostDetailModel, actions: Actions) {
        self.model = model
        self.actions = actions
        self.tabs = TabPillsView(titles: PostDetailModel.Tab.allCases.map(\.label))
        self.postTab = PostTabView(model: model)
        self.editTab = EditTabView(model: model, pickImage: actions.pickImage, editTextInline: actions.editTextInline)
        self.versionsTab = VersionsTabView(model: model)
        super.init(frame: .zero)
        backgroundColor = Theme.canvas
        build()
        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        // Header
        let avatar = StatusDotView(color: Theme.ink, size: 24)
        handleLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        handleLabel.textColor = Theme.textPrimary
        handleLabel.lineBreakMode = .byTruncatingTail
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        exportButton = GlyphButton(symbol: "square.and.arrow.up", size: 12, weight: .regular) { [weak self] in
            guard let self else { return }
            self.actions.export(self.exportButton)
        }
        exportButton.toolTip = "Dışa aktar (⌘E)"
        exportButton.setAccessibilityLabel("Dışa aktar")
        moreButton = GlyphButton(symbol: "ellipsis", size: 12, weight: .regular) { [weak self] in self?.showMoreMenu() }
        moreButton.toolTip = "Diğer işlemler"
        moreButton.setAccessibilityLabel("Diğer işlemler")
        let close = GlyphButton(symbol: "xmark", size: 10, weight: .semibold, action: actions.close)
        close.toolTip = "Kapat (esc)"
        close.setAccessibilityLabel("Kapat")
        let header = NSStackView(views: [avatar, handleLabel, spacer, exportButton, moreButton, close])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 6
        header.setCustomSpacing(10, after: avatar)

        tabs.onSelect = { [weak self] index in
            self?.model.tab = PostDetailModel.Tab(rawValue: index) ?? .post
        }

        // Scrollable body with the three tabs.
        let scroll = NSScrollView()
        let clip = FlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.applyMinimalScroller()
        let doc = FlippedDocumentView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = doc
        let body = NSStackView(views: [postTab, editTab, versionsTab])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 0
        body.detachesHiddenViews = true
        body.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(body)
        for view in [postTab, editTab, versionsTab] {
            view.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
        NSLayoutConstraint.activate([
            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),
            body.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: doc.trailingAnchor),
            body.topAnchor.constraint(equalTo: doc.topAnchor, constant: 14),
            body.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -10),
        ])

        statusLine.onReveal = { [weak self] in self?.model.revealLastExport() }
        statusLine.onDismiss = { [weak self] in
            self?.model.notice = nil
        }
        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.model.error = nil }

        // "Neyi değiştireyim?"
        let instructionWrapper = ThemedView()
        instructionWrapper.borderColor = Theme.border
        instructionWrapper.borderWidth = 1
        instructionWrapper.cornerRadius = 17
        instructionWrapper.translatesAutoresizingMaskIntoConstraints = false
        instructionField.isBordered = false
        instructionField.drawsBackground = false
        instructionField.focusRingType = .none
        instructionField.font = NSFont.systemFont(ofSize: 12)
        instructionField.textColor = Theme.textPrimary
        instructionField.placeholderString = "Neyi değiştireyim?"
        instructionField.delegate = self
        instructionField.setAccessibilityLabel("AI'dan değişiklik iste")
        instructionField.cell?.usesSingleLineMode = true
        instructionField.lineBreakMode = .byTruncatingTail
        sendInstructionButton.toolTip = "AI bu sürümü talimatınla düzenlesin; yeni sürüm olarak kaydedilir"
        sendInstructionButton.setAccessibilityLabel("Gönder")
        sendInstructionButton.onAction = { [weak self] in
            guard let self else { return }
            Task { await self.model.sendInstruction() }
        }
        let instructionRow = NSStackView(views: [instructionField, sendInstructionButton])
        instructionRow.orientation = .horizontal
        instructionRow.alignment = .centerY
        instructionRow.spacing = 8
        instructionRow.translatesAutoresizingMaskIntoConstraints = false
        instructionWrapper.addSubview(instructionRow)
        NSLayoutConstraint.activate([
            instructionWrapper.heightAnchor.constraint(equalToConstant: 34),
            instructionRow.leadingAnchor.constraint(equalTo: instructionWrapper.leadingAnchor, constant: 14),
            instructionRow.trailingAnchor.constraint(equalTo: instructionWrapper.trailingAnchor, constant: -4),
            instructionRow.centerYAnchor.constraint(equalTo: instructionWrapper.centerYAnchor),
        ])

        scheduleButton = PillButton(title: "Zamanla", kind: .secondary, height: 28) { [weak self] in self?.toggleSchedulePopover() }
        approveButton = PillButton(title: "Onayla", kind: .primary, height: 28) { [weak self] in
            guard let self else { return }
            Task { await self.model.approve() }
        }
        let actionsSpacer = NSView()
        actionsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let actionsRow = NSStackView(views: [actionsSpacer, scheduleButton, approveButton])
        actionsRow.orientation = .horizontal
        actionsRow.alignment = .centerY
        actionsRow.spacing = 8

        let main = NSStackView(views: [header, tabs, HairlineView(), scroll, statusLine, errorBanner, instructionWrapper, actionsRow])
        main.orientation = .vertical
        main.alignment = .leading
        main.spacing = 10
        main.detachesHiddenViews = true
        main.translatesAutoresizingMaskIntoConstraints = false
        addSubview(main)
        for view in main.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: main.widthAnchor).isActive = true
        }
        if let hairline = main.arrangedSubviews[2] as NSView? { main.setCustomSpacing(0, after: hairline) }
        NSLayoutConstraint.activate([
            main.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            main.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            main.topAnchor.constraint(equalTo: topAnchor, constant: 18),
            main.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -18),
        ])
    }

    private func sync() {
        handleLabel.stringValue = model.handle.isEmpty ? (model.app.brand(model.content.brandId)?.name ?? "") : model.handle
        tabs.select(model.tab.rawValue)
        postTab.isHidden = model.tab != .post
        editTab.isHidden = model.tab != .edit
        versionsTab.isHidden = model.tab != .versions
        exportButton.isEnabled = model.activeVersion != nil && !model.isExporting
        exportButton.showsSpinner = model.isExporting

        if let message = model.error {
            errorBanner.message = message
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }
        if let notice = model.notice {
            statusLine.show(notice, revealable: false, busy: false)
        } else if let message = model.exportMessage {
            statusLine.show(message, revealable: !model.lastExportURLs.isEmpty && !model.isExporting, busy: model.isExporting)
        } else {
            statusLine.hide()
        }

        if instructionField.stringValue != model.instruction, window?.firstResponder !== instructionField.currentEditor() {
            instructionField.stringValue = model.instruction
        }
        let revising: Bool = if case .revising = model.activity { true } else { false }
        instructionField.isEnabled = !revising && model.content.type != .reel
        instructionField.placeholderString = revising ? "AI düzenliyor…" : (model.isViewingCurrentVersion ? "Neyi değiştireyim?" : "Eski sürüm: önce geri yükle")
        sendInstructionButton.showsSpinner = revising
        sendInstructionButton.isEnabled = !model.instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.activity.changesVersion && model.isViewingCurrentVersion

        let status = model.content.status
        scheduleButton.isEnabled = !model.schedulableAccounts.isEmpty && status != .published && status != .publishing && !model.activity.changesVersion
        scheduleButton.toolTip = model.schedulableAccounts.isEmpty
            ? "Bu postun platformlarında bağlı hesap yok; Ayarlar'dan hesap bağla."
            : (status == .scheduled ? "Zamanlamayı değiştir ya da başka hesap ekle" : "Yayın zamanı seç")
        scheduleButton.title = status == .scheduled ? "Zamanlandı" : "Zamanla"
        approveButton.title = status.hasApproval ? "Onaylandı" : "Onayla"
        approveButton.showsSpinner = model.isApproving
        approveButton.isEnabled = model.canApprove
        approveButton.toolTip = model.approveHelp

        if !model.schedulePresented, let pop = activeSchedulePopover, pop.isShown { pop.close() }
    }

    // MARK: Menus

    private func showMoreMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(ClosureMenuItem(title: "Paylaş…") { [weak self] in
            guard let self else { return }
            self.actions.share(self.moreButton)
        })
        menu.addItem(ClosureMenuItem(title: "Açıklamayı kopyala") { [weak self] in self?.model.copyCaption() })
        menu.addItem(ClosureMenuItem(title: "Hızlı bakış") { [weak self] in
            guard let self else { return }
            PostQuickLook.shared.toggle(assetIds: self.model.slides.compactMap(\.renderedAssetId), service: self.model.app.dataService)
        })
        let reveal = ClosureMenuItem(title: "Son dışa aktarımı Finder'da göster") { [weak self] in self?.model.revealLastExport() }
        reveal.isEnabled = !model.lastExportURLs.isEmpty
        menu.addItem(reveal)
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "Çoğalt", action: actions.duplicate))
        let delete = ClosureMenuItem(title: "Sil…", action: actions.delete)
        if let blocker = model.deletionBlocker {
            delete.isEnabled = false
            delete.toolTip = blocker
        }
        menu.addItem(delete)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: moreButton.bounds.height + 4), in: moreButton)
    }

    private func toggleSchedulePopover() {
        if let pop = activeSchedulePopover, pop.isShown {
            pop.close()
            model.schedulePresented = false
            return
        }
        model.schedulePresented = true
        let pop = NSPopover()
        pop.behavior = .transient
        pop.contentViewController = SchedulePopoverViewController(model: model) { [weak pop, weak self] in
            pop?.close()
            self?.model.schedulePresented = false
        }
        pop.show(relativeTo: scheduleButton.bounds, of: scheduleButton, preferredEdge: .minY)
        activeSchedulePopover = pop
    }

    // MARK: Instruction field

    func controlTextDidChange(_ obj: Notification) {
        if (obj.object as? NSTextField) === instructionField { model.instruction = instructionField.stringValue }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if control === instructionField, commandSelector == #selector(NSResponder.insertNewline(_:)) {
            Task { await model.sendInstruction() }
            return true
        }
        if control === instructionField, commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            // esc leaves the field; the next esc closes the post.
            var view: NSView? = superview
            while let current = view, !(current is PostDetailOverlayView) { view = current.superview }
            window?.makeFirstResponder(view)
            return true
        }
        return false
    }

    func focusInstruction() {
        window?.makeFirstResponder(instructionField)
    }
}

// MARK: - Tabs

/// Small segmented pills (Post / Düzenle / Sürümler).
final class TabPillsView: ThemedView {
    var onSelect: ((Int) -> Void)?
    private var pills: [PillLabel] = []

    init(titles: [String]) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.fill
        cornerRadius = 14
        setAccessibilityRole(.tabGroup)
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 2
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false
        for (index, title) in titles.enumerated() {
            let pill = PillLabel(title: title) { [weak self] in self?.onSelect?(index) }
            pills.append(pill)
            row.addArrangedSubview(pill)
        }
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func select(_ index: Int) {
        for (i, pill) in pills.enumerated() { pill.isSelected = i == index }
    }

    private final class PillLabel: ThemedView {
        private let label: NSTextField
        private let action: () -> Void
        var isSelected = false {
            didSet {
                backgroundColor = isSelected ? Theme.canvas : nil
                label.font = NSFont.systemFont(ofSize: 12, weight: isSelected ? .semibold : .regular)
                label.textColor = isSelected ? Theme.textPrimary : Theme.textSecondary
                setAccessibilityValue(isSelected)
            }
        }

        init(title: String, action: @escaping () -> Void) {
            self.label = NSTextField(labelWithString: title)
            self.action = action
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            cornerRadius = 12
            label.alignment = .center
            label.translatesAutoresizingMaskIntoConstraints = false
            addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: centerXAnchor),
                label.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(title)
            isSelected = false
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        override func mouseDown(with event: NSEvent) { action() }
    }
}

// MARK: - Status line ("3 dosya kaydedildi · Finder'da göster")

private final class StatusLineView: NSView {
    var onReveal: (() -> Void)?
    var onDismiss: (() -> Void)?
    private let spinner = NSProgressIndicator()
    private let label = NSTextField(labelWithString: "")
    private var revealButton: PillButton!

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        spinner.style = .spinning
        spinner.controlSize = .mini
        spinner.isDisplayedWhenStopped = false
        label.font = Theme.smallFont
        label.textColor = Theme.textSecondary
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        revealButton = PillButton(title: "Finder'da göster", kind: .outline, height: 22) { [weak self] in self?.onReveal?() }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [spinner, label, spacer, revealButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 22),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ text: String, revealable: Bool, busy: Bool) {
        isHidden = false
        label.stringValue = text
        revealButton.isHidden = !revealable
        spinner.isHidden = !busy
        if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    }

    func hide() { isHidden = true }

    override func mouseDown(with event: NSEvent) { onDismiss?() }
}

// MARK: - Post tab: status, caption (with platform counters), facts

private final class PostTabView: NSView, NSTextViewDelegate, NSTextFieldDelegate {
    private let model: PostDetailModel
    private let stateLabel: PostStateLabelView
    private let versionLabel = NSTextField(labelWithString: "")
    private let captionRead = ClickableStack()
    private let captionBody = NSTextField(wrappingLabelWithString: "")
    private let hashtagsRead = NSTextField(wrappingLabelWithString: "")
    private let captionEdit = NSStackView()
    private let captionTextView = NSTextView()
    private let hashtagsField = NSTextField()
    private let counters = NSStackView()
    private let approvalWarning = NSTextField.styledLabel("Kaydedince onay kalkar; yeniden onaylaman gerekir.", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
    private var saveButton: PillButton!
    private let dateValue = NSTextField(labelWithString: "")
    private let platformValue = NSTextField(labelWithString: "")
    private let typeValue = NSTextField(labelWithString: "")
    private var wasEditing = false
    private var observation: ObservationToken?

    init(model: PostDetailModel) {
        self.model = model
        self.stateLabel = PostStateLabelView(state: model.card.state)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        build()
        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        versionLabel.font = Theme.smallFont
        versionLabel.textColor = Theme.textTertiary
        let topSpacer = NSView()
        topSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let statusRow = NSStackView(views: [stateLabel, topSpacer, versionLabel])
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY

        captionBody.font = NSFont.systemFont(ofSize: 13)
        captionBody.isSelectable = false
        hashtagsRead.font = NSFont.systemFont(ofSize: 12)
        hashtagsRead.textColor = Theme.textSecondary
        hashtagsRead.isSelectable = false
        captionRead.setup([captionBody, hashtagsRead], spacing: 12)
        captionRead.onClick = { [weak self] in
            guard let self, !self.model.content.status.isLocked else { return }
            self.model.isEditingCaption = true
        }
        captionRead.setAccessibilityLabel("Açıklama; düzenlemek için tıkla")

        let editorBox = ThemedView()
        editorBox.borderColor = Theme.border
        editorBox.borderWidth = 1
        editorBox.cornerRadius = 12
        editorBox.translatesAutoresizingMaskIntoConstraints = false
        let editorScroll = NSScrollView()
        editorScroll.drawsBackground = false
        editorScroll.borderType = .noBorder
        editorScroll.hasVerticalScroller = true
        editorScroll.autohidesScrollers = true
        editorScroll.translatesAutoresizingMaskIntoConstraints = false
        captionTextView.isRichText = false
        captionTextView.allowsUndo = true
        captionTextView.drawsBackground = false
        captionTextView.font = NSFont.systemFont(ofSize: 13)
        captionTextView.textColor = Theme.textPrimary
        captionTextView.delegate = self
        captionTextView.isVerticallyResizable = true
        captionTextView.autoresizingMask = [.width]
        captionTextView.textContainer?.widthTracksTextView = true
        captionTextView.textContainerInset = NSSize(width: 2, height: 4)
        captionTextView.setAccessibilityLabel("Açıklama")
        editorScroll.documentView = captionTextView
        editorBox.addSubview(editorScroll)
        NSLayoutConstraint.activate([
            editorBox.heightAnchor.constraint(equalToConstant: 120),
            editorScroll.leadingAnchor.constraint(equalTo: editorBox.leadingAnchor, constant: 6),
            editorScroll.trailingAnchor.constraint(equalTo: editorBox.trailingAnchor, constant: -6),
            editorScroll.topAnchor.constraint(equalTo: editorBox.topAnchor, constant: 6),
            editorScroll.bottomAnchor.constraint(equalTo: editorBox.bottomAnchor, constant: -6),
        ])

        let tagsBox = ThemedView()
        tagsBox.borderColor = Theme.border
        tagsBox.borderWidth = 1
        tagsBox.cornerRadius = 14
        tagsBox.translatesAutoresizingMaskIntoConstraints = false
        hashtagsField.isBordered = false
        hashtagsField.drawsBackground = false
        hashtagsField.focusRingType = .none
        hashtagsField.font = NSFont.systemFont(ofSize: 12)
        hashtagsField.textColor = Theme.textSecondary
        hashtagsField.placeholderString = "#etiketler"
        hashtagsField.delegate = self
        hashtagsField.translatesAutoresizingMaskIntoConstraints = false
        hashtagsField.setAccessibilityLabel("Etiketler")
        tagsBox.addSubview(hashtagsField)
        NSLayoutConstraint.activate([
            tagsBox.heightAnchor.constraint(equalToConstant: 28),
            hashtagsField.leadingAnchor.constraint(equalTo: tagsBox.leadingAnchor, constant: 10),
            hashtagsField.trailingAnchor.constraint(equalTo: tagsBox.trailingAnchor, constant: -10),
            hashtagsField.centerYAnchor.constraint(equalTo: tagsBox.centerYAnchor),
        ])

        counters.orientation = .horizontal
        counters.spacing = 12
        counters.alignment = .centerY

        let cancel = PillButton(title: "Vazgeç", kind: .secondary) { [weak self] in self?.model.cancelCaptionEdit() }
        saveButton = PillButton(title: "Kaydet", kind: .ink) { [weak self] in
            guard let self else { return }
            Task { await self.model.saveCaption() }
        }
        let buttons = NSStackView(views: [cancel, saveButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        captionEdit.orientation = .vertical
        captionEdit.alignment = .leading
        captionEdit.spacing = 8
        for view in [editorBox, tagsBox, counters, approvalWarning, buttons] as [NSView] { captionEdit.addArrangedSubview(view) }
        for view in [editorBox, tagsBox, approvalWarning] as [NSView] { view.widthAnchor.constraint(equalTo: captionEdit.widthAnchor).isActive = true }

        let facts = NSStackView(views: [factRow("Tarih", dateValue), factRow("Platform", platformValue), factRow("Tür", typeValue)])
        facts.orientation = .vertical
        facts.alignment = .leading
        facts.spacing = 12
        for row in facts.arrangedSubviews { row.widthAnchor.constraint(equalTo: facts.widthAnchor).isActive = true }

        let stack = NSStackView(views: [statusRow, captionRead, captionEdit, HairlineView(), facts])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        for view in stack.arrangedSubviews { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func factRow(_ title: String, _ value: NSTextField) -> NSView {
        let label = NSTextField.styledLabel(title, font: Theme.smallFont, color: Theme.textSecondary)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        value.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        value.textColor = Theme.textPrimary
        value.alignment = .right
        let row = NSStackView(views: [label, spacer, value])
        row.orientation = .horizontal
        row.alignment = .centerY
        return row
    }

    private func sync() {
        stateLabel.state = model.card.state
        if let version = model.activeVersion {
            let origin = VersionsTabView.originLabel(version.origin)
            versionLabel.stringValue = model.isViewingCurrentVersion ? "v\(version.version) · \(origin)" : "v\(version.version) görüntüleniyor"
        } else {
            versionLabel.stringValue = ""
        }

        let editing = model.isEditingCaption
        captionRead.isHidden = editing
        captionEdit.isHidden = !editing
        captionRead.toolTip = model.content.status.isLocked ? "Yayındaki postun açıklaması değişmez." : "Düzenlemek için tıkla"
        if editing {
            if !wasEditing {
                captionTextView.string = model.captionDraft
                hashtagsField.stringValue = model.hashtagsDraft
                window?.makeFirstResponder(captionTextView)
            }
            approvalWarning.isHidden = !model.content.status.hasApproval
            saveButton.showsSpinner = model.isSavingCaption
            let over = model.captionUsage.contains(where: \.isOverLimit)
            saveButton.isEnabled = !model.isSavingCaption && !over
            saveButton.toolTip = over ? "Açıklama bir platformun sınırını aşıyor." : "Açıklamayı kaydet"
            rebuildCounters()
        } else {
            captionBody.stringValue = model.captionDraft.isEmpty ? "Açıklama yok. Eklemek için tıkla." : model.captionDraft
            captionBody.textColor = model.captionDraft.isEmpty ? Theme.textTertiary : Theme.textPrimary
            hashtagsRead.stringValue = model.hashtagsDraft
            hashtagsRead.isHidden = model.hashtagsDraft.isEmpty
        }
        wasEditing = editing

        dateValue.stringValue = model.dateText
        platformValue.stringValue = TurkishFormat.platforms(model.content.targetPlatforms)
        typeValue.stringValue = model.typeText
    }

    private func rebuildCounters() {
        counters.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for usage in model.captionUsage {
            var text = "\(usage.platform.displayName) \(usage.label)"
            if let limit = usage.hashtagLimit { text += " · #\(usage.hashtags)/\(limit)" }
            let label = NSTextField.styledLabel(text, font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: usage.isOverLimit ? .semibold : .regular), color: usage.isOverLimit ? Theme.accent : Theme.textTertiary)
            label.toolTip = usage.isOverLimit ? "\(usage.platform.displayName) sınırını aşıyor" : "\(usage.platform.displayName) karakter sınırı"
            counters.addArrangedSubview(label)
        }
    }

    func textDidChange(_ notification: Notification) {
        model.captionDraft = captionTextView.string
    }

    func controlTextDidChange(_ obj: Notification) {
        if (obj.object as? NSTextField) === hashtagsField { model.hashtagsDraft = hashtagsField.stringValue }
    }

    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            model.cancelCaptionEdit()
            return true
        }
        return false
    }
}

// MARK: - Edit tab: selected layer inspector + layer list

private final class EditTabView: NSView, NSTextViewDelegate, NSTextFieldDelegate {
    private let model: PostDetailModel
    private let pickImage: (String) -> Void
    private let editTextInline: (String) -> Void
    private let blockerLabel = NSTextField.styledLabel("", font: Theme.captionFont, color: Theme.textSecondary, wraps: true)
    private let inspector = NSStackView()
    private let inspectorTitle = NSTextField(labelWithString: "")
    private let textBox = ThemedView()
    private let textView = NSTextView()
    private var applyTextButton: PillButton!
    private let xField = NSTextField()
    private let yField = NSTextField()
    private let scaleField = NSTextField()
    private var resetButton: PillButton!
    private let imageButtons = NSStackView()
    private var visibilityButton: PillButton!
    private let listHeader = NSTextField.styledLabel("Katmanlar", font: Theme.smallFont, color: Theme.textSecondary)
    private let list = NSStackView()
    private let hint = NSTextField.styledLabel(
        "Tuvalde bir katmana tıkla: sürükleyerek taşı, köşeden boyutlandır, çift tıklayıp metni düzenle, görseli yuvaya bırak. Oklar 1 px (⇧ 10 px) kaydırır; ⌘Z geri alır.",
        font: Theme.smallFont, color: Theme.textTertiary, wraps: true)
    private var renderedListKey: [String] = []
    private var shownLayerKey: String?
    private var observation: ObservationToken?

    init(model: PostDetailModel, pickImage: @escaping (String) -> Void, editTextInline: @escaping (String) -> Void) {
        self.model = model
        self.pickImage = pickImage
        self.editTextInline = editTextInline
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        build()
        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        inspectorTitle.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        inspectorTitle.textColor = Theme.textPrimary
        inspectorTitle.lineBreakMode = .byTruncatingTail

        textBox.borderColor = Theme.border
        textBox.borderWidth = 1
        textBox.cornerRadius = 12
        textBox.translatesAutoresizingMaskIntoConstraints = false
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = NSFont.systemFont(ofSize: 13)
        textView.textColor = Theme.textPrimary
        textView.delegate = self
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainerInset = NSSize(width: 2, height: 4)
        textView.setAccessibilityLabel("Katman metni")
        scroll.documentView = textView
        textBox.addSubview(scroll)
        NSLayoutConstraint.activate([
            textBox.heightAnchor.constraint(equalToConstant: 84),
            scroll.leadingAnchor.constraint(equalTo: textBox.leadingAnchor, constant: 6),
            scroll.trailingAnchor.constraint(equalTo: textBox.trailingAnchor, constant: -6),
            scroll.topAnchor.constraint(equalTo: textBox.topAnchor, constant: 6),
            scroll.bottomAnchor.constraint(equalTo: textBox.bottomAnchor, constant: -6),
        ])
        applyTextButton = PillButton(title: "Metni uygula", kind: .ink, height: 24) { [weak self] in self?.applyText() }
        applyTextButton.toolTip = "Yeni sürüm olarak kaydet ve render et (⌘↩)"

        for (field, label) in [(xField, "X"), (yField, "Y"), (scaleField, "Ölçek %")] {
            field.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            field.alignment = .right
            field.bezelStyle = .roundedBezel
            field.controlSize = .small
            field.delegate = self
            field.setAccessibilityLabel(label)
            field.widthAnchor.constraint(equalToConstant: 58).isActive = true
        }
        resetButton = PillButton(title: "Sıfırla", kind: .secondary, height: 22) { [weak self] in
            guard let self, let id = self.model.selectedLayerId else { return }
            self.model.resetTransform(id)
        }
        resetButton.toolTip = "Taşıma ve ölçeği kaldır"
        let geometryRow = NSStackView(views: [
            NSTextField.styledLabel("X", font: Theme.smallFont, color: Theme.textSecondary), xField,
            NSTextField.styledLabel("Y", font: Theme.smallFont, color: Theme.textSecondary), yField,
            NSTextField.styledLabel("%", font: Theme.smallFont, color: Theme.textSecondary), scaleField,
            resetButton,
        ])
        geometryRow.orientation = .horizontal
        geometryRow.alignment = .centerY
        geometryRow.spacing = 5

        imageButtons.orientation = .horizontal
        imageButtons.spacing = 6
        visibilityButton = PillButton(title: "Gizle", kind: .secondary, height: 24) { [weak self] in
            guard let self, let layer = self.model.selectedLayer else { return }
            self.model.setHidden(layer.layerId, !layer.isHidden)
        }

        inspector.orientation = .vertical
        inspector.alignment = .leading
        inspector.spacing = 10
        inspector.detachesHiddenViews = true
        for view in [inspectorTitle, textBox, applyTextButton, geometryRow, imageButtons, visibilityButton] as [NSView] {
            inspector.addArrangedSubview(view)
        }
        inspectorTitle.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true
        textBox.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true

        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 2

        let stack = NSStackView(views: [blockerLabel, inspector, HairlineView(), listHeader, list, hint])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.setCustomSpacing(6, after: listHeader)
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        for view in stack.arrangedSubviews { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func sync() {
        let layers = model.layers
        let blocker = model.editBlocker
        blockerLabel.stringValue = blocker ?? ""
        blockerLabel.isHidden = blocker == nil
        if model.layerBoxes == nil, blocker == nil {
            blockerLabel.stringValue = model.activity == .measuring ? "Katman kutuları ölçülüyor; birazdan tuvalde seçebilirsin." : "Bu sürümün katman kutuları henüz ölçülmedi; listeden düzenleyebilirsin."
            blockerLabel.isHidden = false
        }

        // Layer list
        let key = layers.map { "\($0.layerId)|\($0.isHidden)|\($0.text.prefix(30))|\($0.slotState?.rawValue ?? "")" } + [model.selectedLayerId ?? "-", blocker ?? ""]
        if key != renderedListKey {
            renderedListKey = key
            rebuildList(layers)
        }
        listHeader.stringValue = layers.isEmpty ? "Bu slaytta düzenlenebilir katman yok." : "Katmanlar (\(layers.count))"

        // Inspector
        guard let layer = model.selectedLayer else {
            inspector.isHidden = true
            shownLayerKey = nil
            return
        }
        inspector.isHidden = false
        let editable = blocker == nil
        inspectorTitle.stringValue = "\(layer.kind.label) · \(layer.role.map(Self.roleLabel) ?? layer.layerId)"
        let layerKey = "\(model.activeVersion?.id ?? "")|\(layer.id)"
        if layerKey != shownLayerKey {
            shownLayerKey = layerKey
            textView.string = layer.text
        }
        textBox.isHidden = layer.kind != .text
        applyTextButton.isHidden = layer.kind != .text
        applyTextButton.isEnabled = editable && textView.string != layer.text
        textView.isEditable = editable

        let t = model.transform(of: layer.layerId)
        if window?.firstResponder !== xField.currentEditor() { xField.stringValue = Self.number(t.translate.x) }
        if window?.firstResponder !== yField.currentEditor() { yField.stringValue = Self.number(t.translate.y) }
        if window?.firstResponder !== scaleField.currentEditor() { scaleField.stringValue = Self.number(t.scale * 100) }
        for field in [xField, yField, scaleField] { field.isEnabled = editable }
        resetButton.isEnabled = editable && t != .identity

        imageButtons.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if layer.kind == .slot || layer.kind == .image {
            let filled = layer.kind == .image || layer.slotState == .filled
            let pick = PillButton(title: filled ? "Görseli değiştir…" : "Görsel ekle…", kind: filled ? .secondary : .primary, height: 24) { [weak self] in
                self?.pickImage(layer.layerId)
            }
            pick.isEnabled = editable
            imageButtons.addArrangedSubview(pick)
            if layer.kind == .slot {
                let ai = PillButton(title: "AI ile doldur…", kind: .outline, height: 24) { [weak self] in
                    self?.model.openAISlotGenerator(slotId: layer.layerId)
                }
                ai.isEnabled = editable
                imageButtons.addArrangedSubview(ai)
                if layer.slotState == .filled {
                    let clear = PillButton(title: "Boşalt", kind: .secondary, height: 24) { [weak self] in self?.model.clearSlot(layer.layerId) }
                    clear.isEnabled = editable
                    imageButtons.addArrangedSubview(clear)
                }
            }
        } else if layer.kind == .logo {
            let note = NSTextField.styledLabel("Logo marka kitinden gelir.", font: Theme.smallFont, color: Theme.textTertiary)
            imageButtons.addArrangedSubview(note)
        }
        imageButtons.isHidden = imageButtons.arrangedSubviews.isEmpty
        visibilityButton.title = layer.isHidden ? "Göster" : "Gizle"
        visibilityButton.isEnabled = editable
    }

    private func rebuildList(_ layers: [SlideLayer]) {
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let parents = Dictionary(uniqueKeysWithValues: (model.layerBoxes ?? []).map { ($0.id, $0.parent) })
        func depth(_ id: String) -> Int {
            var d = 0
            var current = parents[id] ?? nil
            while let p = current, d < 6 {
                d += 1
                current = parents[p] ?? nil
            }
            return d
        }
        for layer in layers {
            let row = LayerRowView(
                layer: layer, depth: depth(layer.layerId), selected: layer.layerId == model.selectedLayerId, editable: model.canEdit,
                onSelect: { [weak self] in self?.model.select(layer: layer.layerId) },
                onToggle: { [weak self] in self?.model.setHidden(layer.layerId, !layer.isHidden) },
                menu: { [weak self] in
                    guard let self else { return nil }
                    return LayerMenu.make(for: layer, model: self.model, onEditText: { self.editTextInline(layer.layerId) }, onPickImage: { self.pickImage(layer.layerId) })
                })
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
    }

    private func applyText() {
        guard let layer = model.selectedLayer else { return }
        model.setText(layer.layerId, textView.string)
    }

    func textDidChange(_ notification: Notification) {
        if let layer = model.selectedLayer { applyTextButton.isEnabled = model.canEdit && textView.string != layer.text }
    }

    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)), NSApp.currentEvent?.modifierFlags.contains(.command) == true {
            applyText()
            return true
        }
        return false
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.insertNewline(_:)), let id = model.selectedLayerId else { return false }
        let value = Double(control.stringValue.replacingOccurrences(of: ",", with: ".")) ?? 0
        let t = model.transform(of: id)
        if control === xField {
            model.setTransform(id, translate: CGPoint(x: value, y: t.translate.y))
        } else if control === yField {
            model.setTransform(id, translate: CGPoint(x: t.translate.x, y: value))
        } else if control === scaleField {
            model.setTransform(id, scale: max(5, min(2000, value)) / 100)
        }
        window?.makeFirstResponder(nil)
        return true
    }

    static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }

    static func number(_ value: CGFloat) -> String { number(Double(value)) }

    static func roleLabel(_ role: String) -> String {
        switch role {
        case "eyebrow": "Üst başlık"
        case "headline": "Başlık"
        case "subhead": "Alt başlık"
        case "body": "Metin"
        case "cta": "Çağrı"
        case "caption": "Not"
        case "legal": "Yasal not"
        case "badge": "Rozet"
        case "decoration": "Süsleme"
        case "counter": "Sayaç"
        case "background": "Arka plan"
        case "sign-off": "İmza"
        default: role
        }
    }
}

private final class LayerRowView: ThemedView {
    private let onSelect: () -> Void
    private let menuProvider: () -> NSMenu?

    init(layer: SlideLayer, depth: Int, selected: Bool, editable: Bool, onSelect: @escaping () -> Void, onToggle: @escaping () -> Void, menu: @escaping () -> NSMenu?) {
        self.onSelect = onSelect
        self.menuProvider = menu
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        cornerRadius = 8
        backgroundColor = selected ? Theme.fill : nil

        let eye = GlyphButton(symbol: layer.isHidden ? "eye.slash" : "eye", size: 10, weight: .regular, diameter: 22, action: onToggle)
        eye.toolTip = layer.isHidden ? "Göster" : "Gizle"
        eye.isEnabled = editable
        eye.setAccessibilityLabel(layer.isHidden ? "\(layer.layerId) göster" : "\(layer.layerId) gizle")
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: Self.symbol(layer), accessibilityDescription: layer.kind.label)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        icon.contentTintColor = layer.kind == .slot && layer.slotState != .filled ? Theme.accent : Theme.textSecondary
        let titleText = layer.role.map(EditTabView.roleLabelPublic) ?? layer.layerId
        let title = NSTextField.styledLabel(titleText, font: NSFont.systemFont(ofSize: 12, weight: selected ? .semibold : .regular), color: layer.isHidden ? Theme.textTertiary : Theme.textPrimary)
        let detailText: String = switch layer.kind {
        case .text: layer.text.replacingOccurrences(of: "\n", with: " ")
        case .slot: layer.slotState == .filled ? "Dolu" : "Görsel bekliyor"
        default: layer.kind.label
        }
        let detail = NSTextField.styledLabel(detailText, font: Theme.smallFont, color: Theme.textTertiary)
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        let row = NSStackView(views: [eye, icon, title, detail])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2 + CGFloat(depth) * 14),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityRole(.row)
        setAccessibilityLabel("\(titleText), \(detailText)")
        setAccessibilitySelected(selected)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) { onSelect() }
    override func menu(for event: NSEvent) -> NSMenu? {
        onSelect()
        return menuProvider()
    }

    static func symbol(_ layer: SlideLayer) -> String {
        switch layer.kind {
        case .text: "textformat"
        case .image: "photo"
        case .slot: layer.slotState == .filled ? "photo" : "photo.badge.plus"
        case .logo: "seal"
        case .shape: "square"
        case .group: "square.stack"
        case .other: "square.dashed"
        }
    }
}

extension EditTabView {
    fileprivate static func roleLabelPublic(_ role: String) -> String { roleLabel(role) }
}

// MARK: - Versions tab

private final class VersionsTabView: NSView {
    private let model: PostDetailModel
    private let list = NSStackView()
    private let restoreBox = NSStackView()
    private var restoreButton: PillButton!
    private var renderedKey: [String] = []
    private var observation: ObservationToken?

    init(model: PostDetailModel) {
        self.model = model
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        restoreButton = PillButton(title: "Bu sürümü geri yükle", kind: .ink, height: 28) { [weak self] in
            guard let self else { return }
            Task { await self.model.restoreDisplayedVersion() }
        }
        let note = NSTextField.styledLabel("Geri yükleme bu sürümün kopyasını yeni sürüm olarak ekler; onay kalkar. ⌘Z geri alır.", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
        restoreBox.orientation = .vertical
        restoreBox.alignment = .leading
        restoreBox.spacing = 6
        restoreBox.addArrangedSubview(restoreButton)
        restoreBox.addArrangedSubview(note)
        note.widthAnchor.constraint(equalTo: restoreBox.widthAnchor).isActive = true

        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 4
        let stack = NSStackView(views: [restoreBox, list])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        for view in stack.arrangedSubviews { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    static func originLabel(_ origin: ContentVersionOrigin) -> String {
        switch origin {
        case .generated: "Üretildi"
        case .manualEdit: "Elle düzenlendi"
        case .aiEdit: "AI düzenlemesi"
        case .unknown: "Sürüm"
        }
    }

    private func sync() {
        let shown = model.activeVersion?.version
        let current = model.content.currentVersion?.version
        restoreBox.isHidden = model.isViewingCurrentVersion
        restoreButton.isEnabled = !model.activity.changesVersion && !model.content.status.isLocked
        restoreButton.showsSpinner = model.activity == .restoring
        restoreButton.title = shown.map { "v\($0) sürümünü geri yükle" } ?? "Bu sürümü geri yükle"

        let summaries = model.versionSummaries
        let key = summaries.map { "\($0.id)|\($0.note ?? "")" } + ["\(shown ?? 0)", "\(current ?? 0)"]
        guard key != renderedKey else { return }
        renderedKey = key
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if summaries.isEmpty {
            list.addArrangedSubview(NSTextField.styledLabel(model.content.currentVersion == nil ? "Henüz bir sürüm yok." : "Sürümler yükleniyor…", font: Theme.captionFont, color: Theme.textTertiary))
            return
        }
        for summary in summaries {
            let row = VersionRowView(summary: summary, isCurrent: summary.version == current, isShown: summary.version == shown) { [weak self] in
                guard let self else { return }
                Task { await self.model.selectVersion(summary.version) }
            }
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
    }
}

private final class VersionRowView: ThemedView {
    private let onSelect: () -> Void

    init(summary: ContentVersionSummary, isCurrent: Bool, isShown: Bool, onSelect: @escaping () -> Void) {
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        cornerRadius = 10
        backgroundColor = isShown ? Theme.fill : nil

        let number = NSTextField.styledLabel("v\(summary.version)", font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold), color: Theme.textPrimary)
        let origin = NSTextField.styledLabel(VersionsTabView.originLabel(summary.origin), font: Theme.captionFont, color: Theme.textPrimary)
        let date = NSTextField.styledLabel(TurkishFormat.dayAndTime(summary.createdAt), font: Theme.smallFont, color: Theme.textTertiary)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        var top: [NSView] = [number, origin, spacer]
        if isCurrent {
            let badge = NSTextField.styledLabel("Güncel", font: NSFont.systemFont(ofSize: 10, weight: .semibold), color: Theme.textSecondary)
            top.append(badge)
        }
        top.append(date)
        let topRow = NSStackView(views: top)
        topRow.orientation = .horizontal
        topRow.alignment = .firstBaseline
        topRow.spacing = 6
        let stack = NSStackView(views: [topRow])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 3
        stack.translatesAutoresizingMaskIntoConstraints = false
        topRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        if let note = summary.note, !note.isEmpty {
            let noteLabel = NSTextField.styledLabel(note, font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
            noteLabel.maximumNumberOfLines = 2
            stack.addArrangedSubview(noteLabel)
            noteLabel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
        setAccessibilityRole(.button)
        setAccessibilityLabel("Sürüm \(summary.version), \(VersionsTabView.originLabel(summary.origin))\(isCurrent ? ", güncel" : "")")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) { onSelect() }
}

/// A clickable vertical stack (the read-only caption).
private final class ClickableStack: NSControl {
    var onClick: (() -> Void)?

    func setup(_ views: [NSView], spacing: CGFloat) {
        translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = spacing
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        for view in views { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        setAccessibilityRole(.button)
    }

    override func mouseDown(with event: NSEvent) { onClick?() }
}

// MARK: - Schedule popover

final class SchedulePopoverViewController: NSViewController {
    private let model: PostDetailModel
    private let onDismiss: () -> Void
    private let datePicker = NSDatePicker()
    private var confirmButton: PillButton!
    private var observation: ObservationToken?

    init(model: PostDetailModel, onDismiss: @escaping () -> Void) {
        self.model = model
        self.onDismiss = onDismiss
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField.styledLabel("Zamanla", font: NSFont.systemFont(ofSize: 13, weight: .semibold), color: Theme.textPrimary)

        datePicker.datePickerStyle = .textFieldAndStepper
        datePicker.datePickerElements = [.yearMonthDay, .hourMinute]
        datePicker.locale = TurkishFormat.locale
        datePicker.minDate = Date()
        datePicker.dateValue = model.scheduleDate
        datePicker.target = self
        datePicker.action = #selector(dateChanged)

        let dateRow = NSStackView(views: [NSTextField.styledLabel("Yayın zamanı", font: Theme.captionFont, color: Theme.textSecondary), NSView(), datePicker])
        dateRow.orientation = .horizontal
        dateRow.alignment = .centerY

        let accounts = NSStackView()
        accounts.orientation = .vertical
        accounts.alignment = .leading
        accounts.spacing = 6
        for account in model.schedulableAccounts {
            let check = NSButton(checkboxWithTitle: "\(account.platform.displayName) · \(account.handle)", target: self, action: #selector(toggleAccount(_:)))
            check.identifier = NSUserInterfaceItemIdentifier(account.id)
            check.state = model.scheduleAccounts.contains(account.id) ? .on : .off
            accounts.addArrangedSubview(check)
        }

        let stack = NSStackView(views: [title, dateRow, accounts])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        dateRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        if !model.content.status.isSchedulable {
            let note = NSTextField.styledLabel("Önce bu sürüm onaylanacak, sonra zamanlanacak.", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
            stack.addArrangedSubview(note)
            note.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        let publishNote = NSTextField.styledLabel("Seçili hesaplarda yayın zamanı geldiğinde otomatik paylaşılır ve Takvim ekranından takip edilir.", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
        stack.addArrangedSubview(publishNote)
        publishNote.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let cancel = PillButton(title: "Vazgeç", kind: .secondary, action: onDismiss)
        confirmButton = PillButton(title: model.content.status.isSchedulable ? "Zamanla" : "Onayla ve zamanla", kind: .primary) { [weak self] in
            guard let self else { return }
            Task { await self.model.schedule() }
        }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let actions = NSStackView(views: [spacer, cancel, confirmButton])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8
        stack.addArrangedSubview(actions)
        actions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        root.addSubview(stack)
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 320),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])
        view = root
        observation = observe { [weak self] in
            guard let self else { return }
            self.confirmButton.showsSpinner = self.model.isScheduling
            self.confirmButton.isEnabled = !self.model.scheduleAccounts.isEmpty && !self.model.isScheduling
                && (self.model.content.status.isSchedulable || self.model.card.approvableHash != nil)
        }
    }

    @objc private func dateChanged() { model.scheduleDate = datePicker.dateValue }

    @objc private func toggleAccount(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if sender.state == .on { model.scheduleAccounts.insert(id) } else { model.scheduleAccounts.remove(id) }
    }
}
