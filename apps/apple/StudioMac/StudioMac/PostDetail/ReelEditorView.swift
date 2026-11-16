import AppKit
import StudioKit

/// Düzenle tab of a reel: hook, scenes (motion graphics), timed text overlays (footage),
/// voice-over text (narration), closing line, captions, durations. "Videoyu yeniden oluştur"
/// sends the changes as a `content.render` job (no AI); the result is a new version.
final class ReelEditorView: NSView, NSTextFieldDelegate, NSTextViewDelegate {
    private let model: PostDetailModel
    private let blockerLabel = NSTextField.styledLabel("", font: Theme.captionFont, color: Theme.textSecondary, wraps: true)
    private let titleLabel = NSTextField(labelWithString: "")
    private let issuesLabel = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textPrimary, wraps: true)
    private let form = NSStackView()
    private let problemsLabel = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
    private var discardButton: PillButton!
    private var renderButton: PillButton!
    private let hint = NSTextField.styledLabel(
        "Değişiklikler AI kullanılmadan yeni bir video sürümü olarak kaydedilir; ⌘Z geri alır. Daha büyük değişiklikler için aşağıya \"Neyi değiştireyim?\" yaz.",
        font: Theme.smallFont, color: Theme.textTertiary, wraps: true)
    private var builtKey: String?
    private var scriptView: NSTextView?
    private var observation: ObservationToken?

    init(model: PostDetailModel) {
        self.model = model
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        build()
        observation = observe { [weak self] in self?.sync() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        titleLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        titleLabel.textColor = Theme.textPrimary
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 12
        form.detachesHiddenViews = true

        discardButton = PillButton(title: "Vazgeç", kind: .secondary, height: 28) { [weak self] in
            self?.model.discardReelDraft()
            self?.builtKey = nil
        }
        renderButton = PillButton(title: "Videoyu yeniden oluştur", kind: .primary, height: 28) { [weak self] in
            guard let self else { return }
            self.window?.makeFirstResponder(nil)
            Task { await self.model.rerenderReel() }
        }
        renderButton.toolTip = "Yeni video sürümü üret (AI kullanılmaz)"
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [spacer, discardButton, renderButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [blockerLabel, titleLabel, issuesLabel, form, problemsLabel, buttons, hint])
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
    }

    private func sync() {
        let blocker = model.reelEditBlocker
        let draft = model.reelDraft
        blockerLabel.stringValue = blocker ?? ""
        blockerLabel.isHidden = blocker == nil
        if model.isReel, model.reelInfo?.hasVideo != true, model.activeVersion == nil {
            blockerLabel.stringValue = "Video üretilince metinleri ve süreleri buradan değiştirebilirsin."
            blockerLabel.isHidden = false
        }

        guard let draft else {
            titleLabel.isHidden = true
            issuesLabel.isHidden = true
            form.isHidden = true
            problemsLabel.isHidden = true
            discardButton.superview?.isHidden = true
            hint.isHidden = true
            builtKey = nil
            return
        }
        titleLabel.isHidden = false
        form.isHidden = false
        hint.isHidden = false
        discardButton.superview?.isHidden = false
        titleLabel.stringValue = "\(draft.base.recipe.label) · \(TurkishFormat.clock(ms: draft.totalMs))"
        let issues = ReelLimits.issues(durationMs: draft.totalMs, platforms: model.content.targetPlatforms)
        issuesLabel.stringValue = issues.map { "⚠︎ \($0)" }.joined(separator: "\n")
        issuesLabel.isHidden = issues.isEmpty

        let editable = blocker == nil
        let key = "\(model.activeVersion?.id ?? "")|\(draft.scenes.count)|\(draft.overlays.count)|\(editable)"
        if key != builtKey {
            builtKey = key
            rebuildForm(draft, editable: editable)
        }
        let problems = draft.problems
        problemsLabel.stringValue = problems.joined(separator: "\n")
        problemsLabel.isHidden = problems.isEmpty
        let rendering: Bool = if case .rendering = model.activity { true } else { false }
        renderButton.isEnabled = editable && draft.isDirty && problems.isEmpty
        renderButton.showsSpinner = rendering
        discardButton.isEnabled = draft.isDirty && !rendering
    }

    // MARK: Form

    private func rebuildForm(_ draft: ReelDraft, editable: Bool) {
        form.arrangedSubviews.forEach { $0.removeFromSuperview() }
        scriptView = nil
        add(section("Kanca", field(draft.hook, placeholder: "İlk 2 saniyedeki cümle", editable: editable) { [weak self] v in
            self?.model.updateReelDraft { $0.hook = v }
        }))

        switch draft.base.recipe {
        case .motionGraphics:
            let rows = NSStackView()
            rows.orientation = .vertical
            rows.alignment = .leading
            rows.spacing = 6
            for (i, scene) in draft.scenes.enumerated() {
                let headline = field(scene.headline, placeholder: "Sahne \(i + 1)", editable: editable) { [weak self] v in
                    self?.model.updateReelDraft { if $0.scenes.indices.contains(i) { $0.scenes[i].headline = v } }
                }
                let seconds = numberField(scene.durationMs, editable: editable) { [weak self] ms in
                    self?.model.updateReelDraft { if $0.scenes.indices.contains(i) { $0.scenes[i].durationMs = ms } }
                }
                let remove = removeButton(enabled: editable && draft.scenes.count > 1, help: "Sahneyi kaldır") { [weak self] in
                    self?.model.updateReelDraft { if $0.scenes.indices.contains(i) { $0.scenes.remove(at: i) } }
                }
                rows.addArrangedSubview(row([headline, seconds, unit("sn"), remove], stretch: headline))
            }
            let addScene = PillButton(title: "Sahne ekle", kind: .secondary, height: 24) { [weak self] in
                self?.model.updateReelDraft { $0.addScene() }
            }
            addScene.isEnabled = editable && draft.scenes.count < 8
            rows.addArrangedSubview(addScene)
            add(section("Sahneler", rows))
        case .footageEdit:
            add(section("Video süresi", row([numberField(draft.durationMs, editable: editable) { [weak self] ms in
                self?.model.updateReelDraft { $0.durationMs = ms }
            }, unit("sn"), NSView()], stretch: nil)))
            add(overlayRows(draft, editable: editable))
        case .narration:
            add(section("Seslendirme metni", scriptBox(draft.narrationScript, editable: editable)))
            let note = NSTextField.styledLabel("Metin değişirse ses yeniden üretilir; video süresi sese göre ayarlanır.", font: Theme.smallFont, color: Theme.textTertiary, wraps: true)
            add(note)
            if !draft.overlays.isEmpty { add(overlayRows(draft, editable: editable)) }
        }

        add(section("Kapanış", field(draft.cta, placeholder: "Kapanış cümlesi ya da marka imzası", editable: editable) { [weak self] v in
            self?.model.updateReelDraft { $0.cta = v }
        }))

        if draft.base.recipe != .motionGraphics || !draft.base.words.isEmpty {
            let box = NSButton(checkboxWithTitle: "Konuşmayı altyazı olarak videoya yaz", target: self, action: #selector(toggleCaptions(_:)))
            box.state = draft.captions ? .on : .off
            box.isEnabled = editable
            box.font = Theme.captionFont
            add(box)
        }
    }

    private func overlayRows(_ draft: ReelDraft, editable: Bool) -> NSView {
        let rows = NSStackView()
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 6
        for (i, overlay) in draft.overlays.enumerated() {
            let text = field(overlay.text, placeholder: "Metin", editable: editable) { [weak self] v in
                self?.model.updateReelDraft { if $0.overlays.indices.contains(i) { $0.overlays[i].text = v } }
            }
            let start = numberField(overlay.startMs, editable: editable) { [weak self] ms in
                self?.model.updateReelDraft { if $0.overlays.indices.contains(i) { $0.overlays[i].startMs = ms } }
            }
            let end = numberField(overlay.endMs, editable: editable) { [weak self] ms in
                self?.model.updateReelDraft { if $0.overlays.indices.contains(i) { $0.overlays[i].endMs = ms } }
            }
            let remove = removeButton(enabled: editable, help: "Metni kaldır") { [weak self] in
                self?.model.updateReelDraft { if $0.overlays.indices.contains(i) { $0.overlays.remove(at: i) } }
            }
            start.toolTip = "Başlangıç (sn)"
            end.toolTip = "Bitiş (sn)"
            rows.addArrangedSubview(row([text, start, unit("–"), end, unit("sn"), remove], stretch: text))
        }
        let addOverlay = PillButton(title: "Metin ekle", kind: .secondary, height: 24) { [weak self] in
            self?.model.updateReelDraft { $0.addOverlay() }
        }
        addOverlay.isEnabled = editable && draft.overlays.count < 40
        rows.addArrangedSubview(addOverlay)
        return section("Metin katmanları", rows)
    }

    @objc private func toggleCaptions(_ sender: NSButton) {
        let on = sender.state == .on
        model.updateReelDraft { $0.captions = on }
    }

    // MARK: Pieces

    private func add(_ view: NSView) {
        form.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
    }

    private func section(_ title: String, _ content: NSView) -> NSView {
        let label = NSTextField.styledLabel(title, font: Theme.smallFont, color: Theme.textSecondary)
        let stack = NSStackView(views: [label, content])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        content.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    private func row(_ views: [NSView], stretch: NSView?) -> NSView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 5
        for view in views where view !== stretch { view.setContentHuggingPriority(.required, for: .horizontal) }
        stretch?.setContentHuggingPriority(.defaultLow, for: .horizontal)
        stretch?.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return stack
    }

    private func field(_ value: String, placeholder: String, editable: Bool, onChange: @escaping (String) -> Void) -> NSTextField {
        let field = BoundField(onChange: onChange)
        field.stringValue = value
        field.placeholderString = placeholder
        field.font = NSFont.systemFont(ofSize: 12)
        field.bezelStyle = .roundedBezel
        field.controlSize = .small
        field.lineBreakMode = .byTruncatingTail
        field.isEditable = editable
        field.isEnabled = editable
        field.delegate = self
        field.setAccessibilityLabel(placeholder)
        return field
    }

    /// Seconds with a decimal comma ("2,5"); reports milliseconds.
    private func numberField(_ ms: Int, editable: Bool, onChange: @escaping (Int) -> Void) -> NSTextField {
        let field = BoundField { text in
            let value = Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")) ?? -1
            if value >= 0 { onChange(Int((value * 1000).rounded())) }
        }
        let seconds = Double(ms) / 1000
        field.stringValue = seconds == seconds.rounded() ? String(Int(seconds)) : String(format: "%.1f", seconds).replacingOccurrences(of: ".", with: ",")
        field.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        field.alignment = .right
        field.bezelStyle = .roundedBezel
        field.controlSize = .small
        field.isEditable = editable
        field.isEnabled = editable
        field.delegate = self
        field.widthAnchor.constraint(equalToConstant: 46).isActive = true
        field.setAccessibilityLabel("Saniye")
        return field
    }

    private func unit(_ text: String) -> NSTextField {
        NSTextField.styledLabel(text, font: Theme.smallFont, color: Theme.textSecondary)
    }

    private func removeButton(enabled: Bool, help: String, action: @escaping () -> Void) -> NSView {
        let button = GlyphButton(symbol: "minus", size: 10, weight: .semibold, diameter: 22, action: action)
        button.isEnabled = enabled
        button.toolTip = help
        button.setAccessibilityLabel(help)
        return button
    }

    private func scriptBox(_ text: String, editable: Bool) -> NSView {
        let box = ThemedView()
        box.borderColor = Theme.border
        box.borderWidth = 1
        box.cornerRadius = 12
        box.translatesAutoresizingMaskIntoConstraints = false
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let view = NSTextView()
        view.isRichText = false
        view.allowsUndo = true
        view.drawsBackground = false
        view.font = NSFont.systemFont(ofSize: 12)
        view.textColor = Theme.textPrimary
        view.isVerticallyResizable = true
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainerInset = NSSize(width: 2, height: 4)
        view.string = text
        view.isEditable = editable
        view.delegate = self
        view.setAccessibilityLabel("Seslendirme metni")
        scroll.documentView = view
        box.addSubview(scroll)
        NSLayoutConstraint.activate([
            box.heightAnchor.constraint(equalToConstant: 110),
            scroll.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 6),
            scroll.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -6),
            scroll.topAnchor.constraint(equalTo: box.topAnchor, constant: 6),
            scroll.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -6),
        ])
        scriptView = view
        return box
    }

    // MARK: Delegates

    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? BoundField else { return }
        field.onChange(field.stringValue)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            window?.makeFirstResponder(nil)
            return true
        }
        return false
    }

    func textDidChange(_ notification: Notification) {
        guard let view = notification.object as? NSTextView, view === scriptView else { return }
        let text = view.string
        model.updateReelDraft { $0.narrationScript = text }
    }
}

/// A text field that reports every change through a closure.
private final class BoundField: NSTextField {
    let onChange: (String) -> Void

    init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
