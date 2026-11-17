import AppKit
import StudioKit

// MARK: - Chat card

/// Claude Code's chat card: 1 pt hairline border, radius 12, no fill.
final class ChatCardView: ThemedView {
    let contentStack = NSStackView()

    init(padding: NSEdgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16), spacing: CGFloat = 10) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        borderColor = Theme.border
        borderWidth = 1
        cornerRadius = ChatStyle.cardRadius
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = spacing
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(contentStack)
        NSLayoutConstraint.activate([
            contentStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: padding.left),
            contentStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -padding.right),
            contentStack.topAnchor.constraint(equalTo: topAnchor, constant: padding.top),
            contentStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -padding.bottom),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - ToolStepRowView (one step of an expanded step group)

final class ToolStepRowView: NSView {
    let step: ToolStepPart

    init(step: ToolStepPart) {
        self.step = step
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let iconContainer = NSView()
        iconContainer.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconContainer.widthAnchor.constraint(equalToConstant: 14),
            iconContainer.heightAnchor.constraint(equalToConstant: 14),
        ])
        let icon: NSView
        switch step.state {
        case .running:
            icon = WorkingDotsView(style: .grid, size: 12)
        case .done:
            icon = Self.symbol("checkmark", tint: Theme.textTertiary)
        case .error:
            icon = Self.symbol("exclamationmark.triangle", tint: Theme.accent)
        case .unknown:
            icon = Self.symbol("diamond", tint: Theme.textTertiary)
        }
        icon.translatesAutoresizingMaskIntoConstraints = false
        iconContainer.addSubview(icon)
        NSLayoutConstraint.activate([
            icon.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
        ])

        let labelColor = (step.state == .running || step.state == .error) ? Theme.textPrimary : Theme.textSecondary
        let labelField = NSTextField.styledLabel(step.label, font: ChatStyle.eventFont, color: labelColor)
        labelField.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        var views: [NSView] = [iconContainer, labelField]
        if let summary = step.summary, !summary.isEmpty {
            let summaryField = NSTextField.styledLabel(summary, font: ChatStyle.eventFont, color: Theme.textTertiary)
            summaryField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            summaryField.toolTip = summary
            views.append(summaryField)
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
            row.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private static func symbol(_ name: String, tint: NSColor) -> NSImageView {
        let img = NSImageView()
        img.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
        img.contentTintColor = tint
        return img
    }
}

// MARK: - ConsentCardView (Wecra-style Allow Once / Deny card)

final class ConsentCardView: NSView {
    init(model: ConversationModel, message: Message, consent: ConsentPart) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let busy = model.busyConsents.contains(message.id + consent.consentId)
        let card = ChatCardView()
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

/// The plan as Claude Code's task card: hairline card, "Plan · title" header, one row per post
/// with a circle status (✓ done, ⋯ in progress, dashed pending), then the decision or outcome.
final class PlanBlockView: NSView {
    static let collapsedCount = 4

    init(model: ConversationModel, plan: Plan) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let expanded = model.expandedPlans.contains(plan.id)
        let items = plan.items.sorted { $0.position < $1.position }
        let shown = expanded ? items : Array(items.prefix(Self.collapsedCount))

        let card = ChatCardView(padding: NSEdgeInsets(top: 12, left: 16, bottom: 10, right: 16), spacing: 0)
        addSubview(card)
        let stack = card.contentStack

        let title = plan.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let header = NSTextField.styledLabel(title.isEmpty ? "Plan" : "Plan · \(title)", font: Theme.captionFont, color: Theme.textSecondary)
        stack.addArrangedSubview(header)
        stack.setCustomSpacing(6, after: header)

        for item in shown {
            let row = PlanItemRowView(item: item)
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
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
            stack.addArrangedSubview(toggleRow)
            toggleRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        var footer: NSView?
        switch plan.status {
        case .proposed, .draft:
            footer = PlanDecisionCardView(model: model, plan: plan)
        case .accepted:
            let acceptedCount = plan.items.filter { $0.status == .accepted }.count
            let detail = Self.generationSummary(items: items, isOnline: model.app.isOnline)
            // Accepted but generation never started (the generate call failed): offer it again.
            let notStarted = items.allSatisfy { $0.generation == nil }
            let busy = model.busyPlans.contains(plan.id)
            let retry: PlanOutcomeRowView.Action? = notStarted
                ? PlanOutcomeRowView.Action(title: busy ? "Başlatılıyor…" : "Üretimi başlat", enabled: !busy) { [weak model] in
                    guard let model else { return }
                    Task { await model.generate(plan) }
                }
                : nil
            footer = PlanOutcomeRowView(text: "Plan onaylandı · \(acceptedCount) post", detail: detail, action: retry)
        case .rejected:
            footer = PlanOutcomeRowView(text: "Plan reddedildi", detail: plan.rejectionReason)
        case .superseded:
            footer = PlanOutcomeRowView(text: "Bu planın yerine yenisi önerildi", detail: nil)
        case .unknown:
            footer = nil
        }
        if let footer {
            if let last = stack.arrangedSubviews.last { stack.setCustomSpacing(10, after: last) }
            let line = HairlineView()
            stack.addArrangedSubview(line)
            line.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            stack.setCustomSpacing(12, after: line)
            stack.addArrangedSubview(footer)
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    static func generationSummary(items: [PlanItem], isOnline: Bool) -> String? {
        let generations = items.compactMap(\.generation)
        guard !generations.isEmpty else { return "Üretim henüz başlatılmadı." }
        let active = generations.filter { $0.status.isActive }.count
        let done = generations.filter { $0.status == .succeeded }.count
        if active > 0 { return isOnline ? "\(active) post üretiliyor" : "\(active) post Mac'i bekliyor" }
        return "\(done) post üretildi"
    }

    /// The circle a plan item shows.
    static func statusKind(_ item: PlanItem) -> PlanStatusIconView.Kind {
        if item.status == .skipped { return .skipped }
        guard let generation = item.generation else { return .pending }
        switch generation.status {
        case .succeeded: return .done
        case .queued, .running: return .running
        case .failed, .cancelled: return .failed
        case .unknown: return .pending
        }
    }
}

/// Claude Code's task circles: filled ✓ (done), ⋯ ring (in progress), dashed ring (pending).
final class PlanStatusIconView: NSView {
    enum Kind: Equatable { case done, running, pending, failed, skipped }

    var kind: Kind { didSet { needsDisplay = true } }

    init(kind: Kind) {
        self.kind = kind
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 15),
            heightAnchor.constraint(equalToConstant: 15),
        ])
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 1.5, dy: 1.5)
        let ring = NSBezierPath(ovalIn: rect)
        ring.lineWidth = 1.3
        switch kind {
        case .done:
            Theme.textSecondary.setFill()
            NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1)).fill()
            let check = NSBezierPath()
            check.move(to: NSPoint(x: rect.minX + rect.width * 0.27, y: rect.midY))
            check.line(to: NSPoint(x: rect.minX + rect.width * 0.44, y: rect.minY + rect.height * 0.31))
            check.line(to: NSPoint(x: rect.minX + rect.width * 0.75, y: rect.minY + rect.height * 0.68))
            check.lineWidth = 1.6
            check.lineCapStyle = .round
            check.lineJoinStyle = .round
            Theme.canvas.setStroke()
            check.stroke()
        case .running:
            Theme.textPrimary.setStroke()
            ring.stroke()
            Theme.textPrimary.setFill()
            for dx in [-3.0, 0.0, 3.0] {
                NSBezierPath(ovalIn: NSRect(x: rect.midX + dx - 0.9, y: rect.midY - 0.9, width: 1.8, height: 1.8)).fill()
            }
        case .pending, .skipped:
            ring.setLineDash([1.8, 1.8], count: 2, phase: 0)
            Theme.textTertiary.setStroke()
            ring.stroke()
        case .failed:
            Theme.accent.setStroke()
            ring.stroke()
            let bar = NSBezierPath()
            bar.move(to: NSPoint(x: rect.midX, y: rect.midY + 3))
            bar.line(to: NSPoint(x: rect.midX, y: rect.midY - 0.5))
            bar.lineWidth = 1.4
            bar.lineCapStyle = .round
            bar.stroke()
            Theme.accent.setFill()
            NSBezierPath(ovalIn: NSRect(x: rect.midX - 0.8, y: rect.midY - 3.2, width: 1.6, height: 1.6)).fill()
        }
    }
}

private final class PlanItemRowView: NSView {
    init(item: PlanItem) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let kind = PlanBlockView.statusKind(item)
        let icon = PlanStatusIconView(kind: kind)
        let titleColor = (kind == .done || kind == .skipped) ? Theme.textSecondary : Theme.textPrimary
        let titleLabel = NSTextField.styledLabel(item.title, font: Theme.rowFont, color: titleColor)
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [icon, titleLabel, spacer]
        if let generation = item.generation {
            let statusText: String = switch generation.status {
            case .queued: "sırada"
            case .running: "üretiliyor"
            case .succeeded: "hazır"
            case .failed: "hata"
            case .cancelled: "iptal"
            case .unknown: ""
            }
            views.append(NSTextField.styledLabel(statusText, font: Theme.smallFont, color: Theme.textSecondary))
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
        let dateLabel = NSTextField.styledLabel(item.date.map(TurkishFormat.shortDay) ?? "", font: Theme.smallFont, color: Theme.textTertiary)
        dateLabel.alignment = .right
        dateLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        views.append(dateLabel)

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.setCustomSpacing(9, after: icon)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        setAccessibilityElement(true)
        setAccessibilityRole(.row)
        setAccessibilityLabel([item.title, item.date.map(TurkishFormat.shortDay)].compactMap { $0 }.joined(separator: ", "))

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

private final class PlanExpandButtonView: TapControl {
    private let onTap: () -> Void

    init(title: String, onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityLabel(title)
        let label = NSTextField.styledLabel(title, font: Theme.captionFont, color: Theme.textSecondary)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 26),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func mouseDown(with event: NSEvent) {
        onTap()
    }

    override func performTap() { onTap() }
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
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

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

        stack.addArrangedSubview(summaryLabel)
        stack.addArrangedSubview(promptLabel)
        stack.addArrangedSubview(actions)
        summaryLabel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
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
    struct Action {
        var title: String
        var enabled: Bool
        var handler: () -> Void
    }

    init(text: String, detail: String?, action: Action? = nil) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        var views: [NSView] = [
            NSTextField.styledLabel(text, font: Theme.captionFont, color: Theme.textPrimary),
        ]
        if let detail, !detail.isEmpty {
            views.append(NSTextField.styledLabel("· " + detail, font: Theme.captionFont, color: Theme.textSecondary))
        }
        if let action {
            let button = PillButton(title: action.title, kind: .secondary, height: 24, action: action.handler)
            button.isEnabled = action.enabled
            views.append(button)
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
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - QuestionCardView

/// A question from the agent. Kept alive across transcript updates (typed text and picked
/// options survive streaming); `setBusy` only toggles the controls.
final class QuestionCardView: NSView, NSTextFieldDelegate {
    private let model: ConversationModel
    private let message: Message
    let question: QuestionPart
    private(set) var isBusy = false

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
        isBusy = busy
        let card = ChatCardView(spacing: 12)
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

    /// The free-text field (its text survives transcript updates).
    var answerField: NSTextField { textField }

    func setBusy(_ busy: Bool) {
        guard busy != isBusy else { return }
        isBusy = busy
        for button in optionButtons.values { button.isEnabled = !busy }
        submitButton?.showsSpinner = busy
        refreshQuestionControls(busy: busy)
    }

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
        refreshQuestionControls(busy: isBusy)
    }

    func controlTextDidChange(_ obj: Notification) {
        refreshQuestionControls(busy: isBusy)
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
