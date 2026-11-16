import AppKit
import StudioKit

// MARK: - ToolStepRowView (Wecra-style compact tool step row)

final class ToolStepRowView: NSView {
    init(step: ToolStepPart) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let iconContainer = NSView()
        iconContainer.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconContainer.widthAnchor.constraint(equalToConstant: 14),
            iconContainer.heightAnchor.constraint(equalToConstant: 14),
        ])

        switch step.state {
        case .running:
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .mini
            spinner.startAnimation(nil)
            spinner.translatesAutoresizingMaskIntoConstraints = false
            iconContainer.addSubview(spinner)
            NSLayoutConstraint.activate([
                spinner.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
                spinner.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
            ])
        case .done:
            let img = NSImageView()
            img.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
            img.contentTintColor = Theme.textSecondary
            img.translatesAutoresizingMaskIntoConstraints = false
            iconContainer.addSubview(img)
            NSLayoutConstraint.activate([
                img.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
                img.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
            ])
        case .error:
            let img = NSImageView()
            img.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
            img.contentTintColor = Theme.accent
            img.translatesAutoresizingMaskIntoConstraints = false
            iconContainer.addSubview(img)
            NSLayoutConstraint.activate([
                img.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
                img.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
            ])
        case .unknown:
            let img = NSImageView()
            img.image = NSImage(systemSymbolName: "diamond", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 9, weight: .regular))
            img.contentTintColor = Theme.textTertiary
            img.translatesAutoresizingMaskIntoConstraints = false
            iconContainer.addSubview(img)
            NSLayoutConstraint.activate([
                img.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
                img.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
            ])
        }

        let labelColor = (step.state == .running || step.state == .error) ? Theme.textPrimary : Theme.textSecondary
        let labelField = NSTextField.styledLabel(step.label, font: Theme.captionFont, color: labelColor)
        labelField.setContentCompressionResistancePriority(.required, for: .horizontal)

        var views: [NSView] = [iconContainer, labelField]
        if let summary = step.summary, !summary.isEmpty {
            let summaryField = NSTextField.styledLabel("· \(summary)", font: Theme.captionFont, color: Theme.textTertiary)
            summaryField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            views.append(summaryField)
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 1),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - ConsentCardView (Wecra-style Allow Once / Deny card)

final class ConsentCardView: NSView {
    init(model: ConversationModel, message: Message, consent: ConsentPart) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let busy = model.busyConsents.contains(message.id + consent.consentId)
        let card = CardContainerView(padding: 18, spacing: 10)
        addSubview(card)

        let titleField = NSTextField.styledLabel(
            consent.title,
            font: NSFont.systemFont(ofSize: 14, weight: .medium),
            color: Theme.textPrimary,
            wraps: true
        )
        card.contentStack.addArrangedSubview(titleField)
        titleField.widthAnchor.constraint(equalTo: card.contentStack.widthAnchor).isActive = true

        if let detail = consent.detail, !detail.isEmpty {
            let detailField = NSTextField.styledLabel(detail, font: Theme.captionFont, color: Theme.textSecondary, wraps: true)
            card.contentStack.addArrangedSubview(detailField)
            detailField.widthAnchor.constraint(equalTo: card.contentStack.widthAnchor).isActive = true
        }

        switch consent.state {
        case .pending:
            let allowBtn = PillButton(title: "Bir kez izin ver", kind: .primary) { [weak model] in
                guard let model else { return }
                Task { await model.decideConsent(message: message, consent: consent, allow: true) }
            }
            allowBtn.showsSpinner = busy
            allowBtn.isEnabled = !busy

            let denyBtn = PillButton(title: "Reddet", kind: .secondary) { [weak model] in
                guard let model else { return }
                Task { await model.decideConsent(message: message, consent: consent, allow: false) }
            }
            denyBtn.isEnabled = !busy

            let actions = NSStackView(views: [allowBtn, denyBtn])
            actions.orientation = .horizontal
            actions.alignment = .centerY
            actions.spacing = 8
            card.contentStack.addArrangedSubview(actions)

        case .allowed:
            card.contentStack.addArrangedSubview(Self.outcomeRow(symbol: "checkmark", text: "İzin verildi"))

        case .denied:
            card.contentStack.addArrangedSubview(Self.outcomeRow(symbol: "xmark", text: "Reddedildi"))

        case .expired:
            card.contentStack.addArrangedSubview(Self.outcomeRow(symbol: "clock", text: "Yanıtlanmadığı için süresi doldu"))

        case .unknown:
            break
        }

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private static func outcomeRow(symbol: String, text: String) -> NSView {
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
        icon.contentTintColor = Theme.textSecondary
        let label = NSTextField.styledLabel(text, font: Theme.captionFont, color: Theme.textSecondary)
        let row = NSStackView(views: [icon, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        return row
    }
}

// MARK: - PlanBlockView

final class PlanBlockView: NSView {
    static let collapsedCount = 4

    init(model: ConversationModel, plan: Plan) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let expanded = model.expandedPlans.contains(plan.id)
        let items = plan.items.sorted { $0.position < $1.position }
        let shown = expanded ? items : Array(items.prefix(Self.collapsedCount))

        let outer = NSStackView()
        outer.orientation = .vertical
        outer.alignment = .leading
        outer.spacing = 20
        outer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(outer)

        let listStack = NSStackView()
        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 0
        listStack.translatesAutoresizingMaskIntoConstraints = false

        for item in shown {
            let row = PlanItemRowView(item: item)
            let hairline = HairlineView()
            listStack.addArrangedSubview(row)
            listStack.addArrangedSubview(hairline)
            row.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
            hairline.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }

        if items.count > Self.collapsedCount {
            let toggleRow = PlanExpandButtonView(
                title: expanded ? "Daha az göster" : "\(items.count - Self.collapsedCount) post daha"
            ) { [weak model] in
                guard let model else { return }
                if model.expandedPlans.contains(plan.id) {
                    model.expandedPlans.remove(plan.id)
                } else {
                    model.expandedPlans.insert(plan.id)
                }
            }
            listStack.addArrangedSubview(toggleRow)
            toggleRow.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }

        outer.addArrangedSubview(listStack)
        listStack.widthAnchor.constraint(equalTo: outer.widthAnchor).isActive = true

        switch plan.status {
        case .proposed, .draft:
            let decision = PlanDecisionCardView(model: model, plan: plan)
            outer.addArrangedSubview(decision)
            decision.widthAnchor.constraint(equalTo: outer.widthAnchor).isActive = true
        case .accepted:
            let acceptedCount = plan.items.filter { $0.status == .accepted }.count
            let detail = Self.generationSummary(items: items, isOnline: model.app.isOnline)
            outer.addArrangedSubview(PlanOutcomeRowView(text: "Plan onaylandı · \(acceptedCount) post", detail: detail))
        case .rejected:
            outer.addArrangedSubview(PlanOutcomeRowView(text: "Plan reddedildi", detail: plan.rejectionReason))
        case .superseded:
            outer.addArrangedSubview(PlanOutcomeRowView(text: "Bu planın yerine yenisi önerildi", detail: nil))
        case .unknown:
            break
        }

        NSLayoutConstraint.activate([
            outer.leadingAnchor.constraint(equalTo: leadingAnchor),
            outer.trailingAnchor.constraint(equalTo: trailingAnchor),
            outer.topAnchor.constraint(equalTo: topAnchor),
            outer.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private static func generationSummary(items: [PlanItem], isOnline: Bool) -> String? {
        let generations = items.compactMap(\.generation)
        guard !generations.isEmpty else { return "Üretim henüz başlatılmadı." }
        let active = generations.filter { $0.status.isActive }.count
        let done = generations.filter { $0.status == .succeeded }.count
        if active > 0 { return isOnline ? "\(active) post üretiliyor" : "\(active) post Mac'i bekliyor" }
        return "\(done) post üretildi"
    }
}

private final class PlanItemRowView: NSView {
    init(item: PlanItem) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let dateLabel = NSTextField.styledLabel(item.date.map(TurkishFormat.shortDay) ?? "—", font: Theme.smallFont, color: Theme.textSecondary)
        dateLabel.translatesAutoresizingMaskIntoConstraints = false
        dateLabel.widthAnchor.constraint(equalToConstant: 54).isActive = true

        let titleLabel = NSTextField.styledLabel(item.title, font: Theme.rowFont, color: Theme.textPrimary)
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [dateLabel, titleLabel, spacer]
        if let generation = item.generation {
            let dot = StatusDotView(color: generation.status.isActive ? Theme.accent : Theme.textTertiary, size: 5)
            let statusText: String = switch generation.status {
            case .queued: "sırada"
            case .running: "üretiliyor"
            case .succeeded: "hazır"
            case .failed: "hata"
            case .cancelled: "iptal"
            case .unknown: ""
            }
            let lbl = NSTextField.styledLabel(statusText, font: Theme.smallFont, color: Theme.textSecondary)
            let badge = NSStackView(views: [dot, lbl])
            badge.orientation = .horizontal
            badge.alignment = .centerY
            badge.spacing = 5
            views.append(badge)
        } else if item.imageSlot == .userUpload {
            let dot = StatusDotView(color: Theme.accent, size: 5)
            let lbl = NSTextField.styledLabel("görsel", font: Theme.smallFont, color: Theme.textSecondary)
            let badge = NSStackView(views: [dot, lbl])
            badge.orientation = .horizontal
            badge.alignment = .centerY
            badge.spacing = 5
            badge.toolTip = "Bu postun görselini sen yükleyeceksin"
            views.append(badge)
        } else if item.status == .skipped {
            views.append(NSTextField.styledLabel("atlandı", font: Theme.smallFont, color: Theme.textTertiary))
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 0
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 33),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

private final class PlanExpandButtonView: NSControl {
    private let onTap: () -> Void

    init(title: String, onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let label = NSTextField.styledLabel(title, font: Theme.captionFont, color: Theme.textSecondary)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 32),
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onTap()
    }
}

private final class PlanDecisionCardView: NSView {
    private let model: ConversationModel
    private let plan: Plan

    init(model: ConversationModel, plan: Plan) {
        self.model = model
        self.plan = plan
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let busy = model.busyPlans.contains(plan.id)
        let card = CardContainerView(padding: 18, spacing: 10)
        addSubview(card)

        let summaryText = plan.summary.isEmpty
            ? "\(plan.items.count) postluk plan hazır. Onaylarsan üretime başlarım."
            : plan.summary
        let summaryLabel = NSTextField.styledLabel(summaryText, font: Theme.captionFont, color: Theme.textSecondary, wraps: true)
        let promptLabel = NSTextField.styledLabel("Planı onaylıyor musun?", font: NSFont.systemFont(ofSize: 14, weight: .medium), color: Theme.textPrimary)

        let approveBtn = PillButton(title: "Onayla ve üret", kind: .primary) { [weak model] in
            guard let model else { return }
            Task { await model.acceptAndGenerate(plan) }
        }
        approveBtn.showsSpinner = busy
        approveBtn.isEnabled = !busy
        approveBtn.toolTip = "Planı bu haliyle (sürüm \(plan.revision)) onayla ve postların üretimini başlat"

        let editBtn = PillButton(title: "Düzenle", kind: .secondary) { [weak model] in
            model?.editPlan(plan)
        }
        editBtn.isEnabled = !busy
        editBtn.toolTip = "Ne değişsin, aşağıya yaz; ajan planı günceller"

        let actions = NSStackView(views: [approveBtn, editBtn])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8

        card.contentStack.addArrangedSubview(summaryLabel)
        card.contentStack.addArrangedSubview(promptLabel)
        card.contentStack.addArrangedSubview(actions)
        summaryLabel.widthAnchor.constraint(equalTo: card.contentStack.widthAnchor).isActive = true

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let contextMenu = NSMenu()
        let rejectItem = NSMenuItem(title: "Planı reddet", action: #selector(rejectPlan), keyEquivalent: "")
        rejectItem.target = self
        contextMenu.addItem(rejectItem)
        self.menu = contextMenu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func rejectPlan() {
        Task { await model.rejectPlan(plan) }
    }
}

private final class PlanOutcomeRowView: NSView {
    init(text: String, detail: String?) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
        icon.contentTintColor = Theme.textSecondary

        var views: [NSView] = [
            icon,
            NSTextField.styledLabel(text, font: Theme.captionFont, color: Theme.textPrimary),
        ]
        if let detail, !detail.isEmpty {
            views.append(NSTextField.styledLabel(detail, font: Theme.captionFont, color: Theme.textSecondary))
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - QuestionCardView

final class QuestionCardView: NSView, NSTextFieldDelegate {
    private let model: ConversationModel
    private let message: Message
    private let question: QuestionPart

    private var selected: Set<String> = []
    private var optionButtons: [String: PillButton] = [:]
    private let textField = NSTextField()
    private var submitButton: PillButton?

    init(model: ConversationModel, message: Message, question: QuestionPart) {
        self.model = model
        self.message = message
        self.question = question
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let busy = model.busyQuestions.contains(message.id + question.questionId)
        let card = CardContainerView(padding: 18, spacing: 12)
        addSubview(card)

        let promptLabel = NSTextField.styledLabel(
            question.prompt,
            font: NSFont.systemFont(ofSize: 14, weight: .medium),
            color: Theme.textPrimary,
            wraps: true
        )
        card.contentStack.addArrangedSubview(promptLabel)
        promptLabel.widthAnchor.constraint(equalTo: card.contentStack.widthAnchor).isActive = true

        if let answer = question.answer {
            let flow = FlowLayoutView()
            var chips: [NSView] = question.options.filter { answer.optionIds.contains($0.id) }.map { option in
                let pill = PillButton(title: option.label, kind: .ink)
                pill.isEnabled = true
                return pill
            }
            if let text = answer.text, !text.isEmpty {
                chips.append(NSTextField.styledLabel(text, font: Theme.rowFont, color: Theme.textPrimary))
            }
            flow.setItems(chips)
            card.contentStack.addArrangedSubview(flow)
            flow.widthAnchor.constraint(equalTo: card.contentStack.widthAnchor).isActive = true
            card.contentStack.addArrangedSubview(NSTextField.styledLabel("Yanıtlandı", font: Theme.smallFont, color: Theme.textSecondary))
        } else {
            if !question.options.isEmpty {
                let flow = FlowLayoutView()
                let buttons: [NSView] = question.options.map { option in
                    let btn = PillButton(title: option.label, kind: .secondary) { [weak self] in
                        self?.tapOption(option)
                    }
                    btn.isEnabled = !busy
                    btn.toolTip = option.description
                    optionButtons[option.id] = btn
                    return btn
                }
                flow.setItems(buttons)
                card.contentStack.addArrangedSubview(flow)
                flow.widthAnchor.constraint(equalTo: card.contentStack.widthAnchor).isActive = true
            }

            if question.mode == .text || question.allowText {
                let wrapper = ThemedView()
                wrapper.borderColor = Theme.border
                wrapper.borderWidth = 1
                wrapper.cornerRadius = 15
                wrapper.translatesAutoresizingMaskIntoConstraints = false

                textField.isBordered = false
                textField.drawsBackground = false
                textField.focusRingType = .none
                textField.font = Theme.rowFont
                textField.textColor = Theme.textPrimary
                textField.placeholderString = question.mode == .text ? "Yanıtın" : "Başka bir şey…"
                textField.delegate = self
                textField.translatesAutoresizingMaskIntoConstraints = false
                wrapper.addSubview(textField)

                NSLayoutConstraint.activate([
                    wrapper.heightAnchor.constraint(equalToConstant: 30),
                    textField.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 12),
                    textField.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -12),
                    textField.centerYAnchor.constraint(equalTo: wrapper.centerYAnchor),
                ])
                card.contentStack.addArrangedSubview(wrapper)
                wrapper.widthAnchor.constraint(equalTo: card.contentStack.widthAnchor).isActive = true
            }

            let submit = PillButton(title: "Gönder", kind: .primary) { [weak self] in
                self?.submitAnswer()
            }
            submit.showsSpinner = busy
            self.submitButton = submit
            card.contentStack.addArrangedSubview(submit)
            refreshQuestionControls(busy: busy)
        }

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func tapOption(_ option: QuestionOption) {
        if question.mode == .single {
            Task { await model.answer(message: message, question: question, optionIds: [option.id], text: nil) }
            return
        }
        if selected.contains(option.id) {
            selected.remove(option.id)
        } else {
            selected.insert(option.id)
        }
        for (id, btn) in optionButtons {
            btn.kind = selected.contains(id) ? .primary : .secondary
        }
        refreshQuestionControls(busy: false)
    }

    func controlTextDidChange(_ obj: Notification) {
        refreshQuestionControls(busy: false)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            submitAnswer()
            return true
        }
        return false
    }

    private func refreshQuestionControls(busy: Bool) {
        let trimmed = textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldShowSubmit = question.mode == .multiple || question.mode == .text || !trimmed.isEmpty
        submitButton?.isHidden = !shouldShowSubmit
        let valid = question.check(optionIds: Array(selected), text: trimmed.isEmpty ? nil : trimmed) == nil
        submitButton?.isEnabled = !busy && valid
    }

    private func submitAnswer() {
        let trimmed = textField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let ordered = question.options.map(\.id).filter(selected.contains)
        guard question.check(optionIds: ordered, text: trimmed.isEmpty ? nil : trimmed) == nil else { return }
        Task { await model.answer(message: message, question: question, optionIds: ordered, text: trimmed.isEmpty ? nil : trimmed) }
    }
}
