import AppKit
import QuartzCore
import StudioKit
import UniformTypeIdentifiers

/// Pure AppKit floating Liquid Glass composer (Claude Code's input: a 44 pt rounded field,
/// `Theme.composerRadius`, raised grey glass with a 1 pt edge):
/// - `@` mention autocomplete glass popup above the field
/// - horizontal attachment chip strip (upload progress, double-click rename, retry, remove)
/// - `+` attach, auto-growing `ComposerEditor`, send (orange ↑) / stop (■), mic dictation
/// - drag-and-drop image/file support.
final class ComposerControlView: NSView {
    let model: ComposerModel
    weak var imageStore: ImageStore?
    let editor: ComposerEditor

    var isBusy: Bool = false { didSet { refreshControls() } }
    var onStop: (() -> Void)? { didSet { refreshControls() } }
    var onSend: () -> Void

    private let mergeContainer = GlassMergeContainerView(spacing: 10)
    private let suggestionGlass = GlassContainerView(cornerRadius: Theme.composerRadius)
    private let suggestionStack = NSStackView()

    private let composerGlass = GlassContainerView(cornerRadius: Theme.composerRadius, interactive: true, tint: Theme.composerGlassTint)
    private let borderOverlay = ComposerBorderOverlayView()
    private let fieldStack = NSStackView()
    private let draftsScroll = NSScrollView()
    private let draftsDocument = NSView()
    private let draftsRow = NSStackView()
    private let errorsStack = NSStackView()

    private let attachButton = GlyphButton(symbol: "plus", size: 15)
    private let dictateButton = GlyphButton(symbol: "mic", size: 14)
    /// Send (↑ in an orange circle while there is something to send) or stop (■ while a reply runs).
    private let actionButton = GlyphButton(symbol: "arrow.up.circle.fill", size: 19)

    private var observation: ObservationToken?
    private var renderedDrafts: [ComposerModel.Draft] = []
    private var renderedSuggestions: [MentionSuggestion] = []
    private var renderedSuggestionIndex: Int = -1

    init(
        model: ComposerModel,
        imageStore: ImageStore?,
        onStop: (() -> Void)? = nil,
        onSend: @escaping () -> Void
    ) {
        self.model = model
        self.imageStore = imageStore
        self.onStop = onStop
        self.onSend = onSend
        self.editor = ComposerEditor(model: model)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        editor.onSubmit = { [weak self] in self?.submit() }
        editor.onImages = { [weak model] images, errors in
            model?.errors = errors
            model?.add(images)
        }

        buildUI()
        registerForDraggedTypes([.fileURL, .png, .tiff, NSPasteboard.PasteboardType(UTType.jpeg.identifier)])

        observation = observe { [weak self] in
            self?.syncFromModel()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildUI() {
        // Suggestion popup (above composer)
        suggestionStack.orientation = .vertical
        suggestionStack.alignment = .leading
        suggestionStack.spacing = 2
        suggestionStack.translatesAutoresizingMaskIntoConstraints = false
        suggestionGlass.contentContainer.addSubview(suggestionStack)
        suggestionGlass.isHidden = true
        NSLayoutConstraint.activate([
            suggestionGlass.widthAnchor.constraint(equalToConstant: 300),
            suggestionStack.leadingAnchor.constraint(equalTo: suggestionGlass.contentContainer.leadingAnchor, constant: 6),
            suggestionStack.trailingAnchor.constraint(equalTo: suggestionGlass.contentContainer.trailingAnchor, constant: -6),
            suggestionStack.topAnchor.constraint(equalTo: suggestionGlass.contentContainer.topAnchor, constant: 6),
            suggestionStack.bottomAnchor.constraint(equalTo: suggestionGlass.contentContainer.bottomAnchor, constant: -6),
        ])

        // Drafts horizontal strip
        draftsRow.orientation = .horizontal
        draftsRow.alignment = .centerY
        draftsRow.spacing = 8
        draftsRow.translatesAutoresizingMaskIntoConstraints = false

        draftsDocument.translatesAutoresizingMaskIntoConstraints = false
        draftsDocument.addSubview(draftsRow)

        draftsScroll.translatesAutoresizingMaskIntoConstraints = false
        draftsScroll.drawsBackground = false
        draftsScroll.borderType = .noBorder
        draftsScroll.hasHorizontalScroller = false
        draftsScroll.hasVerticalScroller = false
        draftsScroll.documentView = draftsDocument
        draftsScroll.isHidden = true
        NSLayoutConstraint.activate([
            draftsScroll.heightAnchor.constraint(equalToConstant: 42),
            draftsRow.leadingAnchor.constraint(equalTo: draftsDocument.leadingAnchor, constant: 2),
            draftsRow.trailingAnchor.constraint(equalTo: draftsDocument.trailingAnchor, constant: -2),
            draftsRow.topAnchor.constraint(equalTo: draftsDocument.topAnchor),
            draftsRow.bottomAnchor.constraint(equalTo: draftsDocument.bottomAnchor),
            draftsDocument.heightAnchor.constraint(equalTo: draftsScroll.heightAnchor),
        ])

        // Errors stack
        errorsStack.orientation = .vertical
        errorsStack.alignment = .leading
        errorsStack.spacing = 2
        errorsStack.isHidden = true

        // Input bar
        attachButton.onAction = { [weak self] in self?.pickImages() }
        attachButton.setAccessibilityLabel("Görsel ekle")

        dictateButton.onAction = { [weak self] in self?.dictate() }
        dictateButton.toolTip = "Dikte et (sistem dikte özelliği)"
        dictateButton.setAccessibilityLabel("Dikte et")

        actionButton.onAction = { [weak self] in self?.performPrimaryAction() }

        // Claude Code: "+" · text · send/stop · mic.
        let inputRow = NSStackView(views: [attachButton, editor.scrollView, actionButton, dictateButton])
        inputRow.orientation = .horizontal
        inputRow.alignment = .bottom
        inputRow.spacing = 8
        inputRow.setCustomSpacing(6, after: actionButton)
        inputRow.translatesAutoresizingMaskIntoConstraints = false

        fieldStack.orientation = .vertical
        fieldStack.alignment = .leading
        fieldStack.spacing = 8
        fieldStack.translatesAutoresizingMaskIntoConstraints = false
        fieldStack.addArrangedSubview(draftsScroll)
        fieldStack.addArrangedSubview(errorsStack)
        fieldStack.addArrangedSubview(inputRow)

        composerGlass.contentContainer.addSubview(fieldStack)
        borderOverlay.translatesAutoresizingMaskIntoConstraints = false
        composerGlass.addSubview(borderOverlay)

        NSLayoutConstraint.activate([
            composerGlass.heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.composerHeight),
            fieldStack.leadingAnchor.constraint(equalTo: composerGlass.contentContainer.leadingAnchor, constant: 9),
            fieldStack.trailingAnchor.constraint(equalTo: composerGlass.contentContainer.trailingAnchor, constant: -9),
            fieldStack.topAnchor.constraint(equalTo: composerGlass.contentContainer.topAnchor, constant: 8.5),
            fieldStack.bottomAnchor.constraint(equalTo: composerGlass.contentContainer.bottomAnchor, constant: -8.5),
            inputRow.widthAnchor.constraint(equalTo: fieldStack.widthAnchor),
            draftsScroll.widthAnchor.constraint(equalTo: fieldStack.widthAnchor),
            borderOverlay.leadingAnchor.constraint(equalTo: composerGlass.leadingAnchor),
            borderOverlay.trailingAnchor.constraint(equalTo: composerGlass.trailingAnchor),
            borderOverlay.topAnchor.constraint(equalTo: composerGlass.topAnchor),
            borderOverlay.bottomAnchor.constraint(equalTo: composerGlass.bottomAnchor),
        ])

        let outerStack = NSStackView(views: [suggestionGlass, composerGlass])
        outerStack.orientation = .vertical
        outerStack.alignment = .leading
        outerStack.spacing = 8
        outerStack.translatesAutoresizingMaskIntoConstraints = false

        mergeContainer.contentContainer.addSubview(outerStack)
        addSubview(mergeContainer)

        NSLayoutConstraint.activate([
            mergeContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            mergeContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            mergeContainer.topAnchor.constraint(equalTo: topAnchor),
            mergeContainer.bottomAnchor.constraint(equalTo: bottomAnchor),
            outerStack.leadingAnchor.constraint(equalTo: mergeContainer.contentContainer.leadingAnchor),
            outerStack.trailingAnchor.constraint(equalTo: mergeContainer.contentContainer.trailingAnchor),
            outerStack.topAnchor.constraint(equalTo: mergeContainer.contentContainer.topAnchor),
            outerStack.bottomAnchor.constraint(equalTo: mergeContainer.contentContainer.bottomAnchor),
            composerGlass.widthAnchor.constraint(equalTo: outerStack.widthAnchor),
        ])
    }

    private func syncFromModel() {
        // Drafts
        let drafts = model.drafts
        if drafts != renderedDrafts {
            renderedDrafts = drafts
            draftsRow.arrangedSubviews.forEach {
                draftsRow.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            for draft in drafts {
                let chip = AttachmentChipView(model: model, draft: draft)
                draftsRow.addArrangedSubview(chip)
            }
            draftsScroll.isHidden = drafts.isEmpty
        }

        // Errors
        let errors = model.errors
        errorsStack.arrangedSubviews.forEach {
            errorsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for err in errors {
            errorsStack.addArrangedSubview(NSTextField.styledLabel(err, font: Theme.smallFont, color: Theme.textSecondary, wraps: true))
        }
        errorsStack.isHidden = errors.isEmpty

        // Suggestions
        let suggestions = model.suggestions
        let idx = model.suggestionIndex
        let suggesting = model.isSuggesting
        suggestionGlass.isHidden = !suggesting
        if suggesting && (suggestions != renderedSuggestions || idx != renderedSuggestionIndex) {
            renderedSuggestions = suggestions
            renderedSuggestionIndex = idx
            rebuildSuggestions(suggestions, selectedIndex: idx)
        } else if !suggesting {
            renderedSuggestions = []
            renderedSuggestionIndex = -1
        }

        refreshControls()
    }

    private func rebuildSuggestions(_ suggestions: [MentionSuggestion], selectedIndex: Int) {
        suggestionStack.arrangedSubviews.forEach {
            suggestionStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for (index, suggestion) in suggestions.enumerated() {
            let row = MentionSuggestionRowView(
                suggestion: suggestion,
                selected: index == selectedIndex,
                imageStore: imageStore
            ) { [weak model] in
                model?.choose(suggestion)
            }
            suggestionStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: suggestionStack.widthAnchor).isActive = true
        }
    }

    private func refreshControls() {
        attachButton.isEnabled = model.canAttach
        attachButton.toolTip = model.attachDisabledReason ?? "Görsel ekle (yapıştır ya da sürükle de olur)"

        let style = ComposerActionStyle.make(running: onStop != nil, busy: isBusy, canSend: model.canSend)
        actionButton.showsSpinner = style.spinner
        actionButton.symbolName = style.symbol
        actionButton.pointSize = style.pointSize
        actionButton.symbolTint = style.tint
        actionButton.isEnabled = style.enabled
        if onStop != nil {
            actionButton.toolTip = "Yanıtı durdur"
            actionButton.setAccessibilityLabel("Yanıtı durdur")
        } else {
            actionButton.toolTip = model.sendBlockedReason ?? "Gönder (↩), yeni satır (⇧↩)"
            actionButton.setAccessibilityLabel("Gönder")
        }
    }

    private func performPrimaryAction() {
        if let onStop {
            onStop()
        } else {
            submit()
        }
    }

    private func submit() {
        guard model.canSend, !isBusy else { return }
        onSend()
    }

    private func pickImages() {
        let urls = ImageImport.pick()
        if !urls.isEmpty { model.addFiles(urls) }
    }

    private func dictate() {
        model.bridge?.focus()
        NSApp.sendAction(Selector(("startDictation:")), to: nil, from: nil)
    }

    // MARK: Drag & Drop

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard ImageImport.pasteboardHasImages(sender.draggingPasteboard) else { return [] }
        borderOverlay.isDropTargeted = true
        return .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) {
        borderOverlay.isDropTargeted = false
    }

    override func draggingEnded(_ sender: any NSDraggingInfo) {
        borderOverlay.isDropTargeted = false
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        borderOverlay.isDropTargeted = false
        let (images, errors) = ImageImport.images(from: sender.draggingPasteboard)
        guard !images.isEmpty || !errors.isEmpty else { return false }
        model.errors = errors
        model.add(images)
        return true
    }
}

// MARK: - Send / stop button

/// How the composer's send / stop button looks (tested without views).
struct ComposerActionStyle: Equatable {
    var symbol: String
    var pointSize: CGFloat
    var tint: NSColor
    var enabled: Bool
    var spinner: Bool

    /// Running reply: a small ■ in the primary colour (Claude Code). Otherwise ↑ in an orange
    /// circle when there is something to send, grey when not; a spinner while sending.
    static func make(running: Bool, busy: Bool, canSend: Bool) -> ComposerActionStyle {
        if running {
            return ComposerActionStyle(symbol: "stop.fill", pointSize: 11, tint: Theme.textPrimary, enabled: true, spinner: false)
        }
        let ready = canSend && !busy
        return ComposerActionStyle(
            symbol: "arrow.up.circle.fill",
            pointSize: 19,
            tint: ready ? Theme.accent : Theme.textTertiary,
            enabled: ready,
            spinner: busy
        )
    }
}

// MARK: - Composer Border Overlay

private final class ComposerBorderOverlayView: NSView {
    private let shapeLayer = CAShapeLayer()

    var isDropTargeted = false {
        didSet { updateBorder() }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.addSublayer(shapeLayer)
        shapeLayer.fillColor = nil
        shapeLayer.lineWidth = 1
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        updateBorder()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateBorder()
    }

    private func updateBorder() {
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        guard inset.width > 0, inset.height > 0 else { return }
        let radius = min(Theme.composerRadius, inset.height / 2)
        shapeLayer.frame = bounds
        shapeLayer.path = CGPath(roundedRect: inset, cornerWidth: radius, cornerHeight: radius, transform: nil)
        shapeLayer.strokeColor = resolvedCGColor(isDropTargeted ? Theme.textSecondary : Theme.composerBorder)
        shapeLayer.lineDashPattern = isDropTargeted ? [4, 3] : nil
    }
}

// MARK: - AttachmentChipView

private final class AttachmentChipView: ThemedView, NSTextFieldDelegate {
    private let model: ComposerModel
    private let draft: ComposerModel.Draft

    private let aliasLabel = NSTextField(labelWithString: "")
    private let editField = NSTextField()
    private let statusLabel = NSTextField(labelWithString: "")
    private var editing = false
    private var problem: String?

    init(model: ComposerModel, draft: ComposerModel.Draft) {
        self.model = model
        self.draft = draft
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = Theme.fill

        // Thumbnail
        let thumbContainer = NSView()
        thumbContainer.translatesAutoresizingMaskIntoConstraints = false
        thumbContainer.wantsLayer = true
        thumbContainer.layer?.cornerRadius = 8
        thumbContainer.layer?.cornerCurve = .continuous
        thumbContainer.layer?.masksToBounds = true

        let thumbView = AssetImageView(store: nil, contentMode: .fill, cornerRadius: 8)
        thumbView.localImage = draft.thumbnail
        thumbView.translatesAutoresizingMaskIntoConstraints = false
        thumbContainer.addSubview(thumbView)
        NSLayoutConstraint.activate([
            thumbContainer.widthAnchor.constraint(equalToConstant: 30),
            thumbContainer.heightAnchor.constraint(equalToConstant: 30),
            thumbView.leadingAnchor.constraint(equalTo: thumbContainer.leadingAnchor),
            thumbView.trailingAnchor.constraint(equalTo: thumbContainer.trailingAnchor),
            thumbView.topAnchor.constraint(equalTo: thumbContainer.topAnchor),
            thumbView.bottomAnchor.constraint(equalTo: thumbContainer.bottomAnchor),
        ])

        switch draft.state {
        case .uploading:
            let dim = ThemedView()
            dim.backgroundColor = NSColor.black.withAlphaComponent(0.35)
            dim.translatesAutoresizingMaskIntoConstraints = false
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .mini
            spinner.appearance = NSAppearance(named: .darkAqua)
            spinner.startAnimation(nil)
            spinner.translatesAutoresizingMaskIntoConstraints = false
            thumbContainer.addSubview(dim)
            thumbContainer.addSubview(spinner)
            NSLayoutConstraint.activate([
                dim.leadingAnchor.constraint(equalTo: thumbContainer.leadingAnchor),
                dim.trailingAnchor.constraint(equalTo: thumbContainer.trailingAnchor),
                dim.topAnchor.constraint(equalTo: thumbContainer.topAnchor),
                dim.bottomAnchor.constraint(equalTo: thumbContainer.bottomAnchor),
                spinner.centerXAnchor.constraint(equalTo: thumbContainer.centerXAnchor),
                spinner.centerYAnchor.constraint(equalTo: thumbContainer.centerYAnchor),
            ])
        case .failed:
            let dim = ThemedView()
            dim.backgroundColor = NSColor.black.withAlphaComponent(0.45)
            dim.translatesAutoresizingMaskIntoConstraints = false
            let icon = NSImageView()
            icon.image = NSImage(systemSymbolName: "exclamationmark", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 11, weight: .bold))
            icon.contentTintColor = .white
            icon.translatesAutoresizingMaskIntoConstraints = false
            thumbContainer.addSubview(dim)
            thumbContainer.addSubview(icon)
            NSLayoutConstraint.activate([
                dim.leadingAnchor.constraint(equalTo: thumbContainer.leadingAnchor),
                dim.trailingAnchor.constraint(equalTo: thumbContainer.trailingAnchor),
                dim.topAnchor.constraint(equalTo: thumbContainer.topAnchor),
                dim.bottomAnchor.constraint(equalTo: thumbContainer.bottomAnchor),
                icon.centerXAnchor.constraint(equalTo: thumbContainer.centerXAnchor),
                icon.centerYAnchor.constraint(equalTo: thumbContainer.centerYAnchor),
            ])
        case .uploaded:
            break
        }

        // Alias + status stack
        aliasLabel.stringValue = "@" + draft.alias
        aliasLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        aliasLabel.textColor = Theme.textPrimary
        aliasLabel.toolTip = "Adını değiştirmek için çift tıkla"
        let doubleClick = NSClickGestureRecognizer(target: self, action: #selector(handleDoubleClick))
        doubleClick.numberOfClicksRequired = 2
        aliasLabel.addGestureRecognizer(doubleClick)

        editField.isBordered = false
        editField.drawsBackground = false
        editField.focusRingType = .none
        editField.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        editField.textColor = Theme.textPrimary
        editField.placeholderString = "ad"
        editField.delegate = self
        editField.isHidden = true
        editField.translatesAutoresizingMaskIntoConstraints = false
        editField.widthAnchor.constraint(equalToConstant: 96).isActive = true

        statusLabel.font = NSFont.systemFont(ofSize: 10)
        statusLabel.textColor = Theme.textSecondary
        statusLabel.lineBreakMode = .byTruncatingTail
        updateStatusLabel()

        let textStack = NSStackView(views: [aliasLabel, editField, statusLabel])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 1

        var rowViews: [NSView] = [thumbContainer, textStack]
        if case .failed = draft.state {
            let retryBtn = GlyphButton(symbol: "arrow.clockwise", size: 10, weight: .semibold, diameter: 22) { [weak model] in
                model?.retry(draft.id)
            }
            retryBtn.toolTip = "Yeniden dene"
            retryBtn.setAccessibilityLabel("Yüklemeyi yeniden dene")
            rowViews.append(retryBtn)
        }
        let removeBtn = GlyphButton(symbol: "xmark", size: 9, weight: .semibold, diameter: 22) { [weak model] in
            model?.remove(draft.id)
        }
        removeBtn.toolTip = "Kaldır"
        removeBtn.setAccessibilityLabel("@\(draft.alias) görselini kaldır")
        rowViews.append(removeBtn)

        let row = NSStackView(views: rowViews)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 38),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        let menu = NSMenu()
        let renameItem = NSMenuItem(title: "Yeniden adlandır", action: #selector(handleDoubleClick), keyEquivalent: "")
        renameItem.target = self
        let removeItem = NSMenuItem(title: "Kaldır", action: #selector(removeDraft), keyEquivalent: "")
        removeItem.target = self
        menu.addItem(renameItem)
        menu.addItem(removeItem)
        self.menu = menu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        cornerRadius = bounds.height / 2
    }

    private func updateStatusLabel() {
        if let problem {
            statusLabel.stringValue = problem
            return
        }
        switch draft.state {
        case .uploading(let progress):
            statusLabel.stringValue = "Yükleniyor %\(Int(progress * 100))"
        case .uploaded:
            statusLabel.stringValue = "Hazır"
        case .failed(let message):
            statusLabel.stringValue = message
            statusLabel.toolTip = message
        }
    }

    @objc private func handleDoubleClick() {
        editing = true
        problem = nil
        editField.stringValue = draft.alias
        aliasLabel.isHidden = true
        editField.isHidden = false
        window?.makeFirstResponder(editField)
    }

    @objc private func removeDraft() {
        model.remove(draft.id)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            commitRename()
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            editing = false
            problem = nil
            editField.isHidden = true
            aliasLabel.isHidden = false
            updateStatusLabel()
            return true
        }
        return false
    }

    private func commitRename() {
        if let err = model.rename(draft.id, to: editField.stringValue) {
            problem = err
            updateStatusLabel()
        } else {
            editing = false
            problem = nil
            editField.isHidden = true
            aliasLabel.isHidden = false
            updateStatusLabel()
        }
    }
}

// MARK: - MentionSuggestionRowView

private final class MentionSuggestionRowView: ThemedView {
    private let onPick: () -> Void

    init(suggestion: MentionSuggestion, selected: Bool, imageStore: ImageStore?, onPick: @escaping () -> Void) {
        self.onPick = onPick
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = selected ? Theme.fillStrong : nil

        let thumb = AssetImageView(store: imageStore, contentMode: .fill, cornerRadius: 7)
        switch suggestion.thumbnail {
        case .local(let img): thumb.localImage = img
        case .asset(let id): thumb.assetId = id
        }
        thumb.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            thumb.widthAnchor.constraint(equalToConstant: 26),
            thumb.heightAnchor.constraint(equalToConstant: 26),
        ])

        let nameLabel = NSTextField.styledLabel("@" + suggestion.alias, font: NSFont.systemFont(ofSize: 13, weight: .medium), color: Theme.textPrimary)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [thumb, nameLabel, spacer]
        if suggestion.isDraft {
            views.append(NSTextField.styledLabel("bu mesajda", font: Theme.smallFont, color: Theme.textSecondary))
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 36),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        // Nested in the popup's `Theme.composerRadius` corners with a 6 pt inset.
        cornerRadius = 8
    }

    override func mouseDown(with event: NSEvent) {
        onPick()
    }
}
