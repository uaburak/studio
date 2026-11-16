import AppKit
import StudioKit

/// "Profil": version history on the left; on the right the selected version's
/// tokens table, DESIGN.md, VOICE.md and facts. Drafts are editable; approving a
/// version makes it the brand's current profile (older approved versions can be
/// made current again).
final class BrandProfileTabView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private let model: BrandSettingsModel

    private let versionsTable = NSTableView()
    private var versionRows: [BrandProfile] = []
    private var syncingSelection = false

    private let editorScroll: NSScrollView
    private let editorStack: NSStackView
    private let emptyState: NSView
    private let headerLabel = BrandUI.title("", size: 14)
    private let headerNote = BrandUI.note()
    private let provisionalNote = BrandUI.note()
    private let tokensList = BrandUI.vstack(spacing: 6)
    private let designBox: NSView
    private let designView: NSTextView
    private let voiceBox: NSView
    private let voiceView: NSTextView
    private let numbersField = BrandUI.field("ör. 10, 6132, %20")
    private let statementsBox: NSView
    private let statementsView: NSTextView
    private let forbiddenBox: NSView
    private let forbiddenView: NSTextView
    private var textHandlers: [AnyObject] = []
    private var tokenHandlers: [AnyObject] = []
    private var tokenErrors: [String: NSTextField] = [:]

    // Footer
    private let footerMessage = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
    private let analysisLine = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textSecondary)
    private var secondaryButton: PillButton!
    private var primaryButton: PillButton!

    private var shownVersion: Int?
    private var tokenSignature = ""
    private var observation: ObservationToken?

    init(model: BrandSettingsModel) {
        self.model = model
        (editorScroll, editorStack) = BrandUI.scrollingStack(inset: 22, spacing: 16)
        (designBox, designView) = BrandUI.textEditor(height: 190)
        (voiceBox, voiceView) = BrandUI.textEditor(height: 150)
        (statementsBox, statementsView) = BrandUI.textEditor(height: 84)
        (forbiddenBox, forbiddenView) = BrandUI.textEditor(height: 64)
        emptyState = BrandProfileTabView.makeEmptyState(model: model)
        super.init(frame: .zero)

        // Versions
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("version"))
        versionsTable.addTableColumn(column)
        versionsTable.headerView = nil
        versionsTable.style = .sourceList
        versionsTable.backgroundColor = .clear
        versionsTable.rowSizeStyle = .custom
        versionsTable.rowHeight = 44
        versionsTable.dataSource = self
        versionsTable.delegate = self
        versionsTable.setAccessibilityLabel("Profil sürümleri")
        let versionsScroll = NSScrollView()
        versionsScroll.documentView = versionsTable
        versionsScroll.drawsBackground = false
        versionsScroll.hasVerticalScroller = true
        versionsScroll.borderType = .noBorder
        versionsScroll.translatesAutoresizingMaskIntoConstraints = false
        versionsScroll.applyMinimalScroller()
        let versionsTitle = BrandUI.caption("Sürümler")
        let side = ThemedView()
        side.backgroundColor = Theme.fill.withAlphaComponent(0.5)
        side.translatesAutoresizingMaskIntoConstraints = false
        side.addSubview(versionsTitle)
        side.addSubview(versionsScroll)
        versionsTitle.translatesAutoresizingMaskIntoConstraints = false

        // Editor
        wire(designView) { [weak model] in model?.draft.designRules = $0 }
        wire(voiceView) { [weak model] in model?.draft.voice = $0 }
        wire(statementsView) { [weak model] in model?.setStatements($0) }
        wire(forbiddenView) { [weak model] in model?.setForbidden($0) }
        let numbersHandler = FieldHandler(onChange: { [weak model] in model?.setAllowedNumbers($0) })
        textHandlers.append(numbersHandler)
        numbersField.delegate = numbersHandler

        BrandUI.addFull(BrandUI.vstack([headerLabel, headerNote], spacing: 3), to: editorStack)
        provisionalNote.textColor = Theme.accent
        BrandUI.addFull(provisionalNote, to: editorStack)
        BrandUI.addFull(BrandUI.sectionHeader("Tokenlar", detail: "brand.json"), to: editorStack)
        BrandUI.addFull(tokensList, to: editorStack)
        BrandUI.addFull(BrandUI.sectionHeader("Tasarım kuralları", detail: "DESIGN.md"), to: editorStack)
        BrandUI.addFull(designBox, to: editorStack)
        BrandUI.addFull(BrandUI.sectionHeader("Ses tonu", detail: "VOICE.md"), to: editorStack)
        BrandUI.addFull(voiceBox, to: editorStack)
        BrandUI.addFull(BrandUI.sectionHeader("Gerçekler"), to: editorStack)
        editorStack.addArrangedSubview(BrandUI.caption("İzinli sayılar"))
        BrandUI.addFull(numbersField, to: editorStack)
        BrandUI.addFull(BrandUI.note("Tasarımlarda ve açıklamalarda yalnızca bu sayılar kullanılabilir; virgülle ayır."), to: editorStack)
        editorStack.addArrangedSubview(BrandUI.caption("Doğru bilgiler (her satıra bir tane)"))
        BrandUI.addFull(statementsBox, to: editorStack)
        editorStack.addArrangedSubview(BrandUI.caption("Kaçınılacak iddialar (her satıra bir tane)"))
        BrandUI.addFull(forbiddenBox, to: editorStack)

        // Footer
        let footer = ThemedView()
        footer.backgroundColor = Theme.canvas
        footer.translatesAutoresizingMaskIntoConstraints = false
        let hairline = HairlineView()
        secondaryButton = PillButton(title: "", kind: .secondary, height: 30) { [weak self] in self?.secondaryTapped() }
        primaryButton = PillButton(title: "", kind: .primary, height: 30) { [weak self] in self?.primaryTapped() }
        footerMessage.maximumNumberOfLines = 2
        footerMessage.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let messages = BrandUI.vstack([analysisLine, footerMessage], spacing: 2)
        messages.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let footerRow = BrandUI.hstack([messages, BrandUI.spacer(), secondaryButton, primaryButton], spacing: 10)
        footer.addSubview(hairline)
        footer.addSubview(footerRow)

        let editorContainer = NSView()
        editorContainer.translatesAutoresizingMaskIntoConstraints = false
        editorContainer.addSubview(editorScroll)
        editorContainer.addSubview(emptyState)
        emptyState.translatesAutoresizingMaskIntoConstraints = false

        addSubview(side)
        addSubview(editorContainer)
        addSubview(footer)
        NSLayoutConstraint.activate([
            side.leadingAnchor.constraint(equalTo: leadingAnchor),
            side.topAnchor.constraint(equalTo: topAnchor),
            side.bottomAnchor.constraint(equalTo: footer.topAnchor),
            side.widthAnchor.constraint(equalToConstant: 196),
            versionsTitle.leadingAnchor.constraint(equalTo: side.leadingAnchor, constant: 16),
            versionsTitle.topAnchor.constraint(equalTo: side.topAnchor, constant: 16),
            versionsScroll.leadingAnchor.constraint(equalTo: side.leadingAnchor, constant: 6),
            versionsScroll.trailingAnchor.constraint(equalTo: side.trailingAnchor, constant: -6),
            versionsScroll.topAnchor.constraint(equalTo: versionsTitle.bottomAnchor, constant: 8),
            versionsScroll.bottomAnchor.constraint(equalTo: side.bottomAnchor, constant: -8),

            editorContainer.leadingAnchor.constraint(equalTo: side.trailingAnchor),
            editorContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            editorContainer.topAnchor.constraint(equalTo: topAnchor),
            editorContainer.bottomAnchor.constraint(equalTo: footer.topAnchor),
            editorScroll.leadingAnchor.constraint(equalTo: editorContainer.leadingAnchor),
            editorScroll.trailingAnchor.constraint(equalTo: editorContainer.trailingAnchor),
            editorScroll.topAnchor.constraint(equalTo: editorContainer.topAnchor),
            editorScroll.bottomAnchor.constraint(equalTo: editorContainer.bottomAnchor),
            emptyState.centerXAnchor.constraint(equalTo: editorContainer.centerXAnchor),
            emptyState.centerYAnchor.constraint(equalTo: editorContainer.centerYAnchor),
            emptyState.widthAnchor.constraint(lessThanOrEqualToConstant: 400),

            footer.leadingAnchor.constraint(equalTo: leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: bottomAnchor),
            hairline.leadingAnchor.constraint(equalTo: footer.leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: footer.trailingAnchor),
            hairline.topAnchor.constraint(equalTo: footer.topAnchor),
            footerRow.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 24),
            footerRow.trailingAnchor.constraint(equalTo: footer.trailingAnchor, constant: -20),
            footerRow.topAnchor.constraint(equalTo: hairline.bottomAnchor, constant: 12),
            footerRow.bottomAnchor.constraint(equalTo: footer.bottomAnchor, constant: -14),
        ])

        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func wire(_ textView: NSTextView, _ onChange: @escaping (String) -> Void) {
        let handler = TextViewHandler(onChange: onChange)
        textHandlers.append(handler)
        textView.delegate = handler
    }

    private static func makeEmptyState(model: BrandSettingsModel) -> NSView {
        let title = BrandUI.title("Henüz profil yok", size: 15)
        let text = BrandUI.note("Marka kitine en az 3 örnek post ekleyip \"Profili çıkar\" dediğinde Claude ilk taslağı hazırlar. Taslağı burada düzenleyip onaylarsın.")
        text.alignment = .center
        let toKit = PillButton(title: "Marka kitine git", kind: .primary, height: 30) { [weak model] in model?.tab = .kit }
        let blank = PillButton(title: "Boş taslak oluştur", kind: .secondary, height: 30) { [weak model] in
            guard let model else { return }
            Task { await model.newDraftFromSelected() }
        }
        let stack = BrandUI.vstack([title, text, BrandUI.hstack([blank, toKit], spacing: 8)], spacing: 10)
        stack.alignment = .centerX
        text.widthAnchor.constraint(equalToConstant: 360).isActive = true
        return stack
    }

    // MARK: Render

    private func render() {
        let profiles = model.profiles
        if profiles != versionRows {
            versionRows = profiles
            syncingSelection = true
            versionsTable.reloadData()
            syncingSelection = false
        }
        syncTableSelection()

        let hasProfile = model.selectedProfile != nil
        emptyState.isHidden = hasProfile || model.isLoading
        editorScroll.isHidden = !hasProfile

        if let profile = model.selectedProfile {
            renderEditor(profile)
        }
        renderFooter()
    }

    private func syncTableSelection() {
        guard let index = versionRows.firstIndex(where: { $0.version == model.selectedVersion }) else {
            versionsTable.deselectAll(nil)
            return
        }
        if versionsTable.selectedRow != index {
            syncingSelection = true
            versionsTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
            syncingSelection = false
        }
    }

    private func renderEditor(_ profile: BrandProfile) {
        let editable = model.isEditable
        let state = profile.isCurrent ? "Onaylı · Geçerli" : profile.status.label
        headerLabel.stringValue = "v\(profile.version) · \(state)"
        var notes = ["Oluşturuldu \(Self.date(profile.createdAt))"]
        if let approved = profile.approvedAt { notes.append("onaylandı \(Self.date(approved))") }
        notes.append(editable ? "Taslak düzenlenebilir." : "Onaylı sürümler değişmez; düzenlemek için yeni taslak oluştur.")
        headerNote.stringValue = notes.joined(separator: " · ")
        provisionalNote.stringValue = "Geçici profil: az örnekle çıkarıldı. Daha fazla örnek post ekleyip yeniden çıkarmak daha iyi sonuç verir."
        provisionalNote.isHidden = !model.draft.isProvisional

        let versionChanged = shownVersion != profile.version
        shownVersion = profile.version
        let rows = model.tokenRows
        let signature = "\(profile.version)|\(editable)|" + rows.map(\.id).joined(separator: ",")
        if signature != tokenSignature {
            tokenSignature = signature
            rebuildTokens(rows, editable: editable)
        }

        setText(designView, model.draft.designRules, force: versionChanged)
        setText(voiceView, model.draft.voice, force: versionChanged)
        let facts = model.draft.facts
        if numbersField.currentEditor() == nil || versionChanged {
            numbersField.stringValue = facts.allowedNumbers.joined(separator: ", ")
        }
        setText(statementsView, facts.statements.joined(separator: "\n"), force: versionChanged)
        setText(forbiddenView, facts.forbidden.joined(separator: "\n"), force: versionChanged)
        for view in [designView, voiceView, statementsView, forbiddenView] {
            view.isEditable = editable
            view.textColor = editable ? Theme.textPrimary : Theme.textSecondary
        }
        numbersField.isEditable = editable
        numbersField.isEnabled = editable
    }

    private func setText(_ view: NSTextView, _ text: String, force: Bool) {
        let editing = view.window?.firstResponder === view
        if (force || !editing), view.string != text { view.string = text }
    }

    private func rebuildTokens(_ rows: [ProfileTokens.Row], editable: Bool) {
        tokensList.arrangedSubviews.forEach { $0.removeFromSuperview() }
        tokenHandlers = []
        tokenErrors = [:]
        guard !rows.isEmpty else {
            BrandUI.addFull(BrandUI.note("Bu sürümde düzenlenebilir token yok."), to: tokensList)
            return
        }
        var group = ""
        for row in rows {
            if row.group != group {
                group = row.group
                let header = BrandUI.caption(group)
                tokensList.addArrangedSubview(header)
                tokensList.setCustomSpacing(4, after: header)
            }
            BrandUI.addFull(tokenRow(row, editable: editable), to: tokensList)
        }
    }

    private func tokenRow(_ row: ProfileTokens.Row, editable: Bool) -> NSView {
        let label = NSTextField.styledLabel(row.label, font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), color: Theme.textPrimary)
        label.widthAnchor.constraint(equalToConstant: 150).isActive = true
        let field = BrandUI.field("", text: row.value)
        field.font = row.kind == .text ? Theme.rowFont : NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        field.isEditable = editable
        field.isEnabled = editable
        field.widthAnchor.constraint(equalToConstant: row.kind == .text ? 240 : 110).isActive = true
        let error = NSTextField.styledLabel("", font: Theme.smallFont, color: .systemRed)
        error.isHidden = true
        tokenErrors[row.id] = error

        var views: [NSView] = [label]
        if row.kind == .color {
            let well = ClosureColorWell(color: BrandUI.color(hex: row.value) ?? .black) { [weak self, weak field] picked in
                let hex = BrandUI.hex(of: picked)
                field?.stringValue = hex
                self?.commitToken(row, hex, field: field)
            }
            well.isEnabled = editable
            views.append(well)
            let handler = FieldHandler(onChange: { [weak well] value in
                if let color = BrandUI.color(hex: value) { well?.color = color }
            }, onCommit: { [weak self, weak field] value in self?.commitToken(row, value, field: field) })
            tokenHandlers.append(handler)
            field.delegate = handler
        } else {
            let handler = FieldHandler(onCommit: { [weak self, weak field] value in self?.commitToken(row, value, field: field) })
            tokenHandlers.append(handler)
            field.delegate = handler
        }
        views.append(field)
        if let note = row.note {
            views.append(NSTextField.styledLabel(note, font: Theme.smallFont, color: Theme.textTertiary))
        }
        views.append(error)
        views.append(BrandUI.spacer())
        return BrandUI.hstack(views, spacing: 8)
    }

    private func commitToken(_ row: ProfileTokens.Row, _ value: String, field: NSTextField?) {
        guard model.isEditable else { return }
        let current = ProfileTokens.rows(model.draft.tokens).first { $0.id == row.id }?.value
        guard value != current else {
            tokenErrors[row.id]?.isHidden = true
            return
        }
        if let problem = model.setToken(row, to: value) {
            tokenErrors[row.id]?.stringValue = problem
            tokenErrors[row.id]?.isHidden = false
            if let current { field?.stringValue = current }
        } else {
            tokenErrors[row.id]?.isHidden = true
            if let normalized = ProfileTokens.rows(model.draft.tokens).first(where: { $0.id == row.id })?.value {
                field?.stringValue = normalized
            }
        }
    }

    private func renderFooter() {
        switch model.analysis {
        case .running(_, let progress, let message):
            let percent = progress.map { " %\(Int(($0 * 100).rounded()))" } ?? ""
            analysisLine.stringValue = "Profil çıkarılıyor\(percent): \(message ?? "")"
            analysisLine.isHidden = false
            analysisLine.textColor = Theme.textSecondary
        case .starting:
            analysisLine.stringValue = "Profil çıkarma başlatılıyor…"
            analysisLine.isHidden = false
            analysisLine.textColor = Theme.textSecondary
        case .failed(let message):
            analysisLine.stringValue = message
            analysisLine.isHidden = false
            analysisLine.textColor = .systemRed
        case .idle, .succeeded:
            analysisLine.isHidden = true
        }

        if let error = model.profileError {
            footerMessage.stringValue = error
            footerMessage.textColor = .systemRed
        } else if model.draftDirty {
            footerMessage.stringValue = "Kaydedilmemiş değişiklikler var."
            footerMessage.textColor = Theme.textSecondary
        } else {
            footerMessage.stringValue = model.profileMessage ?? ""
            footerMessage.textColor = Theme.textSecondary
        }

        let busy = model.isSavingProfile || model.isApproving
        guard let profile = model.selectedProfile else {
            secondaryButton.isHidden = true
            primaryButton.isHidden = true
            return
        }
        secondaryButton.isHidden = false
        primaryButton.isHidden = false
        if profile.status == .draft {
            secondaryButton.title = "Taslağı kaydet"
            secondaryButton.isEnabled = model.draftDirty && !busy
            secondaryButton.showsSpinner = model.isSavingProfile
            primaryButton.title = "Onayla ve geçerli yap"
            primaryButton.kind = .primary
            primaryButton.isEnabled = !busy && !model.isArchived
        } else {
            secondaryButton.title = "Bu sürümden taslak oluştur"
            secondaryButton.isEnabled = !busy && !model.isArchived
            secondaryButton.showsSpinner = model.isSavingProfile
            primaryButton.title = profile.isCurrent ? "Geçerli profil" : "Geçerli yap"
            primaryButton.kind = profile.isCurrent ? .secondary : .primary
            primaryButton.isEnabled = !profile.isCurrent && !busy && !model.isArchived
        }
        primaryButton.showsSpinner = model.isApproving
        primaryButton.toolTip = profile.status == .draft
            ? "Taslağı onaylar; içerik üretimi bundan sonra bu profili kullanır."
            : "Bu onaylı sürümü yeniden geçerli profil yapar."
    }

    private func primaryTapped() {
        window?.makeFirstResponder(nil)
        guard let profile = model.selectedProfile else { return }
        if profile.status == .draft {
            BrandUI.confirm(
                in: window, title: "v\(profile.version) onaylansın mı?",
                message: "Onaylanan sürüm değiştirilemez ve markanın geçerli profili olur; yeni postlar bu profille üretilir.",
                confirm: "Onayla"
            ) { [weak self] ok in
                guard ok, let self else { return }
                Task { await self.model.approveSelected() }
            }
        } else {
            Task { await model.approveSelected() }
        }
    }

    private func secondaryTapped() {
        window?.makeFirstResponder(nil)
        if model.selectedProfile?.status == .draft {
            Task { await model.saveDraft() }
        } else {
            Task { await model.newDraftFromSelected() }
        }
    }

    static func date(_ date: Date) -> String {
        date.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(Locale(identifier: "tr_TR")))
    }

    // MARK: Versions table

    func numberOfRows(in tableView: NSTableView) -> Int { versionRows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let profile = versionRows[row]
        let cell = NSTableCellView()
        let title = NSTextField.styledLabel("v\(profile.version)", font: Theme.titleFont, color: Theme.textPrimary)
        let status = profile.isCurrent ? "Geçerli" : profile.status.label
        let detail = NSTextField.styledLabel("\(status) · \(Self.date(profile.updatedAt))", font: Theme.smallFont, color: Theme.textSecondary)
        var titleViews: [NSView] = [title]
        if profile.isCurrent { titleViews.append(StatusDotView(color: .systemGreen, size: 6)) }
        if profile.status == .draft { titleViews.append(StatusDotView(color: Theme.accent, size: 6)) }
        let stack = BrandUI.vstack([BrandUI.hstack(titleViews, spacing: 6), detail], spacing: 2)
        cell.addSubview(stack)
        cell.textField = title
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -6),
            stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        cell.setAccessibilityLabel("Sürüm \(profile.version), \(status)")
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !syncingSelection else { return }
        let index = versionsTable.selectedRow
        guard versionRows.indices.contains(index) else { return }
        let target = versionRows[index].version
        guard target != model.selectedVersion else { return }
        guard model.draftDirty else {
            model.select(target)
            return
        }
        // Leaving a draft with edits: ask first.
        syncTableSelection()
        let alert = NSAlert()
        alert.messageText = "v\(model.selectedVersion ?? 0) taslağında kaydedilmemiş değişiklikler var"
        alert.informativeText = "Başka bir sürüme geçmeden önce kaydedilsin mi?"
        alert.addButton(withTitle: "Kaydet ve geç")
        alert.addButton(withTitle: "Kaydetmeden geç")
        alert.addButton(withTitle: "Vazgeç")
        guard let window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            switch response {
            case .alertFirstButtonReturn:
                Task { @MainActor in
                    await self.model.saveDraft()
                    if self.model.profileError == nil { self.model.select(target) }
                }
            case .alertSecondButtonReturn:
                self.model.select(target)
            default:
                break
            }
        }
    }
}
