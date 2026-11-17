import AppKit
import StudioKit

/// Pure AppKit status line under the chat composer (and Start composer), Claude Code style
/// ("Opus 5.5  Medium   ◌" on the right):
/// - Right: one "Opus Orta" control (model in the primary colour, effort in grey; model + effort
///   in one menu), then the usage ring (popover; the percent appears only near the limit).
/// - Left, only when something is wrong: `MacStatusControlView` (`● Mac çevrimdışı`, Claude sign-in…).
final class ComposerFooterControlView: NSView {
    private unowned let app: AppModel
    private let getChoice: @MainActor () -> AgentChoice
    private let setChoice: @MainActor (AgentChoice) -> Void
    private let getPresence: @MainActor () -> WorkerPresence?

    private let macStatus: MacStatusControlView
    private let agentButton: FooterMenuButton
    private let usageControl: UsageIndicatorControlView
    private var observation: ObservationToken?

    convenience init(model: ConversationModel) {
        self.init(
            app: model.app,
            getChoice: { model.agentChoice },
            setChoice: { model.agentChoice = $0 },
            getPresence: { model.state?.presence ?? model.app.presence }
        )
    }

    convenience init(newChat: NewChatModel, app: AppModel) {
        self.init(
            app: app,
            getChoice: { newChat.agentChoice },
            setChoice: { newChat.agentChoice = $0 },
            getPresence: { app.presence }
        )
    }

    init(
        app: AppModel,
        getChoice: @escaping @MainActor () -> AgentChoice,
        setChoice: @escaping @MainActor (AgentChoice) -> Void,
        getPresence: @escaping @MainActor () -> WorkerPresence?
    ) {
        self.app = app
        self.getChoice = getChoice
        self.setChoice = setChoice
        self.getPresence = getPresence
        self.macStatus = MacStatusControlView(app: app, selectedModel: { getChoice().model })
        self.agentButton = FooterMenuButton(help: "Model ve düşünme düzeyi")
        self.usageControl = UsageIndicatorControlView(app: app, getPresence: getPresence)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        agentButton.buildMenu = { [weak self] in self?.makeAgentMenu() ?? NSMenu() }
        macStatus.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        macStatus.isHidden = true
        macStatus.onChange = { [weak macStatus] in
            guard let macStatus else { return }
            macStatus.isHidden = !macStatus.needsAttention
        }

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [macStatus, spacer, agentButton, usageControl])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 14
        row.detachesHiddenViews = true
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 20),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        observation = observe { [weak self] in
            self?.refresh()
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func refresh() {
        let choice = getChoice()
        let presence = getPresence()
        agentButton.setTitle(model: choice.model.displayName, effort: choice.effort.displayName)
        macStatus.refresh(presenceOverride: presence)
        usageControl.refresh(presence: presence)
    }

    /// Texts of the line (tests): the model + effort, and the Mac status when it is shown.
    var agentTitle: String { agentButton.titleText }
    var macStatusShown: Bool { !macStatus.isHidden }

    /// Claude Code's model menu: the Claude models (1, 2, 3), "Çaba ›" with the current effort,
    /// then "Diğer modeller ›" (Gemini).
    private func makeAgentMenu() -> NSMenu {
        let menu = NSMenu(title: "Model")
        let current = getChoice()

        for (index, candidate) in AgentModel.claudeCases.enumerated() {
            let item = modelItem(candidate, current: current.model)
            item.keyEquivalent = "\(index + 1)"
            item.keyEquivalentModifierMask = []
            menu.addItem(item)
        }
        menu.addItem(.separator())

        let effortMenu = NSMenu(title: "Çaba")
        for candidate in AgentEffort.knownCases {
            let item = NSMenuItem(title: candidate.displayName, action: #selector(pickEffort(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = candidate.rawValue
            item.state = candidate == current.effort ? .on : .off
            effortMenu.addItem(item)
        }
        let effort = NSMenuItem(title: "Çaba", action: nil, keyEquivalent: "")
        effort.submenu = effortMenu
        effort.attributedTitle = Self.trailingDetail("Çaba", detail: current.effort.displayName)
        menu.addItem(effort)
        menu.addItem(.separator())

        let others = NSMenu(title: "Diğer modeller")
        for candidate in AgentModel.geminiCases {
            others.addItem(modelItem(candidate, current: current.model))
        }
        let othersItem = NSMenuItem(title: "Diğer modeller", action: nil, keyEquivalent: "")
        othersItem.submenu = others
        if current.model.isGemini {
            othersItem.attributedTitle = Self.trailingDetail("Diğer modeller", detail: current.model.displayName)
        }
        menu.addItem(othersItem)
        return menu
    }

    /// "Çaba        Orta": the title, then the current value in grey (as Claude Code shows it).
    private static func trailingDetail(_ title: String, detail: String) -> NSAttributedString {
        let text = NSMutableAttributedString(string: title, attributes: [.font: NSFont.menuFont(ofSize: 0)])
        let tab = NSMutableParagraphStyle()
        tab.tabStops = [NSTextTab(textAlignment: .right, location: 150)]
        text.append(NSAttributedString(string: "\t" + detail, attributes: [
            .font: NSFont.menuFont(ofSize: 0), .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        text.addAttribute(.paragraphStyle, value: tab, range: NSRange(location: 0, length: text.length))
        return text
    }

    private func modelItem(_ candidate: AgentModel, current: AgentModel) -> NSMenuItem {
        let item = NSMenuItem(title: candidate.displayName, action: #selector(pickModel(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = candidate.rawValue
        item.state = candidate == current ? .on : .off
        return item
    }

    @objc private func pickModel(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let picked = AgentModel(rawValue: raw), picked != .unknown else { return }
        var choice = getChoice()
        choice.model = picked
        setChoice(choice)
    }

    @objc private func pickEffort(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let picked = AgentEffort(rawValue: raw), picked != .unknown else { return }
        var choice = getChoice()
        choice.effort = picked
        setChoice(choice)
    }
}

/// "Opus Orta": the composer's model + effort line (Claude Code's "Opus 5.5 Medium").
enum ComposerStatusText {
    static func title(_ choice: AgentChoice) -> String {
        "\(choice.model.displayName) \(choice.effort.displayName)"
    }
}

// MARK: - FooterMenuButton

/// "Opus  Orta": the model in the primary colour, the effort in grey; pops its menu above itself.
private final class FooterMenuButton: NSControl {
    var buildMenu: (() -> NSMenu)?

    private let helpText: String
    private let label = NSTextField(labelWithString: "")

    init(help: String) {
        self.helpText = help
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = help
        setAccessibilityElement(true)
        setAccessibilityRole(.popUpButton)

        label.font = Theme.captionFont
        label.textColor = Theme.textPrimary
        label.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = NSStackView(views: [label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])
        hover.attach(to: self)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    private let hover = CapsuleHover()

    /// Model in the primary colour, effort in grey (Claude Code's "Opus 5.5  Medium").
    func setTitle(model: String, effort: String) {
        let text = NSMutableAttributedString(string: model, attributes: [
            .font: Theme.captionFont,
            .foregroundColor: Theme.textPrimary,
        ])
        text.append(NSAttributedString(string: "  " + effort, attributes: [
            .font: Theme.captionFont,
            .foregroundColor: Theme.textSecondary,
        ]))
        label.attributedStringValue = text
        setAccessibilityLabel("\(helpText): \(model) \(effort)")
        invalidateIntrinsicContentSize()
    }

    /// Plain text of the control (tests).
    var titleText: String { label.stringValue }

    override func mouseDown(with event: NSEvent) {
        showMenu()
    }

    override func accessibilityPerformPress() -> Bool {
        showMenu()
        return true
    }

    override func accessibilityPerformShowMenu() -> Bool { accessibilityPerformPress() }

    /// Opens above the control, its right edge over the control's right edge (Claude Code).
    private func showMenu() {
        guard let menu = buildMenu?() else { return }
        let size = menu.size
        let top = isFlipped ? -6 : bounds.height + 6 + size.height
        menu.popUp(positioning: nil, at: NSPoint(x: bounds.maxX - size.width + 14, y: top), in: self)
    }
}

// MARK: - Usage Formatting Helpers (tested by AppModelTests)

enum UsageIndicator {
    /// From here on the ring and percent turn orange ("near the limit").
    static let warnPercent: Double = 90

    static func color(_ percent: Double) -> NSColor {
        percent >= warnPercent ? Theme.accent : Theme.textSecondary
    }

    static func percentText(_ percent: Double) -> String {
        "%\(Int(percent.rounded()))"
    }
}

enum UsagePopover {
    static func title(_ kind: UsageWindow.Kind) -> String {
        switch kind {
        case .fiveHour: "5 saatlik"
        case .weekly: "Haftalık"
        case .other, .unknown: "Diğer"
        }
    }

    static func usedText(_ window: UsageWindow) -> String {
        if window.limited { return "Sınıra ulaşıldı" }
        guard window.usedPercent != nil else { return "—" }
        return "\(UsageIndicator.percentText(window.effectivePercent)) kullanıldı"
    }

    static func relative(_ date: Date) -> String {
        date.formatted(.relative(presentation: .named, unitsStyle: .wide).locale(Locale(identifier: "tr_TR")))
    }
}

// MARK: - UsageIndicatorControlView & UsagePopoverViewController

private final class UsageIndicatorControlView: NSControl {
    private unowned let app: AppModel
    private let getPresence: @MainActor () -> WorkerPresence?
    private let ring = UsageRingView()
    private let label = NSTextField(labelWithString: "—")

    init(app: AppModel, getPresence: @escaping @MainActor () -> WorkerPresence?) {
        self.app = app
        self.getPresence = getPresence
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityRole(.button)

        label.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        label.textColor = Theme.textSecondary

        let row = NSStackView(views: [label, ring])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        row.detachesHiddenViews = true
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
        hover.attach(to: self)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    private let hover = CapsuleHover()

    func refresh(presence: WorkerPresence?) {
        if let usage = presence?.usage, let top = usage.mostUsed {
            let percent = top.effectivePercent
            ring.fraction = percent / 100
            ring.strokeColor = UsageIndicator.color(percent)
            label.stringValue = UsageIndicator.percentText(percent)
            label.textColor = Theme.accent
            // Claude Code shows the ring alone; the percent appears near the limit.
            label.isHidden = percent < UsageIndicator.warnPercent
            toolTip = "Kullanım \(UsageIndicator.percentText(percent)) · yapay zekâ bağlantıları"
            setAccessibilityLabel("Abonelik kullanımı \(UsageIndicator.percentText(percent))")
        } else {
            ring.fraction = 0
            ring.strokeColor = Theme.textTertiary
            label.isHidden = true
            label.stringValue = "—"
            label.textColor = Theme.textSecondary
            toolTip = "Yapay zekâ bağlantıları ve kullanım durumu"
            setAccessibilityLabel("Kullanım ve yapay zekâ bağlantıları")
        }
    }

    override func mouseDown(with event: NSEvent) {
        if let card = UsageCard.current {
            card.close()
            return
        }
        guard let window else { return }
        let card = UsageCard(presence: getPresence()) { [weak self] section in
            UsageCard.current?.close()
            self?.app.openSettings(section)
        }
        card.show(above: self, in: window)
    }
}

/// Claude Code's usage card: a glass card that opens above the ring, its right edge on the
/// ring's: "Kullanım limitlerin · Plan", "Tümünü gör →", one row per limit with reset time,
/// percent and a bar (blue, yellow from 70 %, orange from 90 %). Click outside or Esc closes.
@MainActor
final class UsageCard {
    static weak var current: UsageCard?
    private let card = GlassContainerView(cornerRadius: 14)
    private var monitor: Any?
    private let onOpenSettings: (SettingsSection) -> Void

    init(presence: WorkerPresence?, onOpenSettings: @escaping (SettingsSection) -> Void) {
        self.onOpenSettings = onOpenSettings
        card.translatesAutoresizingMaskIntoConstraints = true
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.contentContainer.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.contentContainer.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: card.contentContainer.trailingAnchor),
            stack.topAnchor.constraint(equalTo: card.contentContainer.topAnchor),
            stack.bottomAnchor.constraint(equalTo: card.contentContainer.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: 360),
        ])

        // Header
        let plan = presence?.claude?.plan.map { " · \($0.capitalized)" } ?? ""
        let title = NSTextField.styledLabel("Kullanım limitlerin\(plan)", font: Theme.captionFont, color: Theme.textSecondary)
        let seeAll = PaneLinkView(title: "Tümünü gör") { [weak self] in self?.onOpenSettings(.usage) }
        let header = NSStackView(views: [title, NSView(), seeAll])
        header.orientation = .horizontal
        stack.addArrangedSubview(header)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32).isActive = true

        let windows = presence?.usage?.windows.filter { $0.kind == .fiveHour || $0.kind == .weekly } ?? []
        if windows.isEmpty {
            let note: String
            switch presence?.claude?.status {
            case .signedOut, .signingIn: note = "Claude'a giriş yapılmadı."
            default: note = presence?.online == true ? "Kullanım henüz bildirilmedi." : "Mac çevrimdışı."
            }
            stack.addArrangedSubview(NSTextField.styledLabel(note, font: Theme.captionFont, color: Theme.textSecondary))
        }
        for window in windows {
            let name = NSTextField.styledLabel(Self.title(window.kind), font: Theme.captionFont, color: Theme.textPrimary)
            var right = ""
            if let resets = window.resetsAt { right = "Sıfırlanma \(Self.resetText(resets))   " }
            right += window.limited ? "Sınırda" : UsageIndicator.percentText(window.effectivePercent)
            let value = NSTextField.styledLabel(right, font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular), color: Theme.textSecondary)
            let row = NSStackView(views: [name, NSView(), value])
            row.orientation = .horizontal
            let bar = UsageLimitBarView(fraction: window.limited ? 1 : window.effectivePercent / 100)
            let block = NSStackView(views: [row, bar])
            block.orientation = .vertical
            block.alignment = .leading
            block.spacing = 6
            stack.addArrangedSubview(block)
            block.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32).isActive = true
            row.widthAnchor.constraint(equalTo: block.widthAnchor).isActive = true
            bar.widthAnchor.constraint(equalTo: block.widthAnchor).isActive = true
        }
    }

    static func title(_ kind: UsageWindow.Kind) -> String {
        switch kind {
        case .fiveHour: "5 saatlik limit"
        case .weekly: "Haftalık · tüm modeller"
        case .other, .unknown: "Diğer"
        }
    }

    /// "22:30" today, "Çar 14:00" later in the week.
    static func resetText(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Locale(identifier: "tr_TR")))
        if calendar.isDate(date, inSameDayAs: now) { return time }
        let day = date.formatted(.dateTime.weekday(.abbreviated).locale(Locale(identifier: "tr_TR")))
        return "\(day) \(time)"
    }

    func show(above anchor: NSView, in window: NSWindow) {
        guard let content = window.contentView else { return }
        UsageCard.current?.close()
        content.addSubview(card, positioned: .above, relativeTo: nil)
        card.layoutSubtreeIfNeeded()
        let size = card.fittingSize
        let anchorFrame = anchor.convert(anchor.bounds, to: content)
        var origin = NSPoint(x: anchorFrame.maxX - size.width + 6, y: anchorFrame.maxY + 8)
        if content.isFlipped { origin.y = anchorFrame.minY - 8 - size.height }
        origin.x = max(8, origin.x)
        card.frame = NSRect(origin: origin, size: size)
        card.alphaValue = 0
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            card.animator().alphaValue = 1
        }
        UsageCard.current = self
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
            guard let self else { return event }
            if event.type == .keyDown {
                if event.keyCode == 53 { self.close(); return nil }
                return event
            }
            let point = self.card.convert(event.locationInWindow, from: nil)
            if event.window !== window || !self.card.bounds.contains(point) {
                // A click on the ring itself toggles: let the ring see "no card" and stop there.
                let onAnchor = anchor.bounds.contains(anchor.convert(event.locationInWindow, from: nil))
                self.close()
                return onAnchor && event.window === window ? nil : event
            }
            return event
        }
        objc_setAssociatedObject(card, &UsageCard.retainKey, self, .OBJC_ASSOCIATION_RETAIN)
    }

    private static var retainKey: UInt8 = 0

    func close() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if UsageCard.current === self { UsageCard.current = nil }
        let card = card
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            card.animator().alphaValue = 0
        } completionHandler: {
            MainActor.assumeIsolated {
                card.removeFromSuperview()
                objc_setAssociatedObject(card, &UsageCard.retainKey, nil, .OBJC_ASSOCIATION_RETAIN)
            }
        }
    }
}

/// A thin rounded usage bar.
final class UsageLimitBarView: NSView {
    let fraction: Double
    init(fraction: Double) {
        self.fraction = max(0, min(fraction, 1))
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 6).isActive = true
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    static func color(_ fraction: Double) -> NSColor {
        fraction >= 0.9 ? Theme.accent : fraction >= 0.7 ? NSColor.systemYellow : NSColor.systemBlue
    }

    override func draw(_ dirtyRect: NSRect) {
        let track = NSBezierPath(roundedRect: bounds, xRadius: 3, yRadius: 3)
        Theme.fillStrong.setFill()
        track.fill()
        guard fraction > 0.005 else { return }
        var fill = bounds
        fill.size.width = max(6, bounds.width * fraction)
        Self.color(fraction).setFill()
        NSBezierPath(roundedRect: fill, xRadius: 3, yRadius: 3).fill()
    }
}

private final class UsageRingView: NSView {
    var fraction: Double = 0 { didSet { needsDisplay = true } }
    var strokeColor: NSColor = Theme.textSecondary { didSet { needsDisplay = true } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 13),
            heightAnchor.constraint(equalToConstant: 13),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 1.5, dy: 1.5)
        guard rect.width > 0 else { return }

        let track = NSBezierPath(ovalIn: rect)
        track.lineWidth = 2
        Theme.fillStrong.setStroke()
        track.stroke()

        let clamped = max(0, min(fraction, 1))
        guard clamped > 0.005 else { return }
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        let radius = rect.width / 2
        let arc = NSBezierPath()
        arc.lineWidth = 2
        arc.lineCapStyle = .round
        // Start at 12 o'clock (90 deg in non-flipped coords) and sweep clockwise.
        arc.appendArc(withCenter: center, radius: radius, startAngle: 90, endAngle: 90 - CGFloat(clamped * 360), clockwise: true)
        strokeColor.setStroke()
        arc.stroke()
    }
}

private final class UsagePopoverViewController: NSViewController {
    private unowned let app: AppModel
    private let presence: WorkerPresence?
    private let onOpenSettings: (SettingsSection) -> Void

    init(app: AppModel, presence: WorkerPresence?, onOpenSettings: @escaping (SettingsSection) -> Void) {
        self.app = app
        self.presence = presence
        self.onOpenSettings = onOpenSettings
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)

        // Gemini section
        stack.addArrangedSubview(NSTextField.styledLabel("Gemini", font: Theme.titleFont, color: Theme.textPrimary))
        let geminiText: String
        if let gemini = presence?.gemini {
            switch gemini.status {
            case .ready:
                let modeLabel = switch gemini.mode {
                case .api: "GEMINI_API_KEY"
                case .cli: "Gemini CLI"
                case .both: "API + CLI"
                case .none, .unknown: "Hazır"
                }
                geminiText = "Hazır · \(gemini.detail ?? modeLabel)"
            case .notConfigured:
                geminiText = "Yapılandırılmadı (.env GEMINI_API_KEY veya CLI gerekli)"
            case .error, .unknown:
                geminiText = gemini.detail ?? "Durum okunamadı"
            }
        } else {
            geminiText = presence?.online == true ? "Durum bekleniyor…" : "Mac çevrimdışı"
        }
        stack.addArrangedSubview(NSTextField.styledLabel(geminiText, font: Theme.smallFont, color: Theme.textSecondary, wraps: true))

        stack.addArrangedSubview(HairlineView())

        // Claude section
        stack.addArrangedSubview(NSTextField.styledLabel("Claude", font: Theme.titleFont, color: Theme.textPrimary))
        let claudeText: String
        var needsSignIn = false
        if let claude = presence?.claude {
            switch claude.status {
            case .signedIn:
                let who = [claude.email, claude.plan].compactMap { $0 }.joined(separator: " · ")
                claudeText = who.isEmpty ? "Giriş yapıldı" : "Giriş yapıldı · \(who)"
            case .signedOut:
                claudeText = "Giriş yapılmadı"
                needsSignIn = true
            case .signingIn:
                claudeText = "Tarayıcıda giriş bekleniyor…"
                needsSignIn = true
            case .notInstalled:
                claudeText = "Claude CLI kurulu değil"
            case .error, .unknown:
                claudeText = claude.detail ?? "Durum okunamadı"
            }
        } else {
            claudeText = presence?.online == true ? "Henüz bildirilmedi" : "Mac çevrimdışı"
        }
        stack.addArrangedSubview(NSTextField.styledLabel(claudeText, font: Theme.smallFont, color: Theme.textSecondary, wraps: true))

        if let usage = presence?.usage {
            for window in usage.windows {
                let row = NSStackView()
                row.orientation = .horizontal
                row.alignment = .firstBaseline
                row.spacing = 12
                let titleLabel = NSTextField.styledLabel(UsagePopover.title(window.kind), font: Theme.captionFont, color: Theme.textPrimary)
                let spacer = NSView()
                spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
                let usedColor = window.effectivePercent >= UsageIndicator.warnPercent ? Theme.accent : Theme.textSecondary
                let usedLabel = NSTextField.styledLabel(
                    UsagePopover.usedText(window),
                    font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
                    color: usedColor
                )
                row.addArrangedSubview(titleLabel)
                row.addArrangedSubview(spacer)
                row.addArrangedSubview(usedLabel)
                stack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

                if let resetsAt = window.resetsAt {
                    stack.addArrangedSubview(NSTextField.styledLabel("sıfırlanma: \(UsagePopover.relative(resetsAt))", font: Theme.smallFont, color: Theme.textSecondary))
                }
            }
            stack.addArrangedSubview(NSTextField.styledLabel("Güncellendi: \(UsagePopover.relative(usage.observedAt))", font: Theme.smallFont, color: Theme.textTertiary))
        }

        let settingsBtnTitle = needsSignIn ? "Claude ile giriş yap (Ayarlar)…" : "Ayarları aç…"
        let settingsTarget: SettingsSection = needsSignIn ? .ai : .usage
        let settingsBtn = PillButton(title: settingsBtnTitle, kind: needsSignIn ? .primary : .secondary, height: 24) { [weak self] in
            self?.onOpenSettings(settingsTarget)
        }
        stack.addArrangedSubview(settingsBtn)

        for sub in stack.arrangedSubviews where sub is HairlineView {
            sub.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 268),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
        ])
        self.view = root
    }
}

/// A capsule hover fill for small text controls (Claude Code's footer buttons).
@MainActor
final class CapsuleHover: NSObject {
    private weak var view: NSView?
    private var area: NSTrackingArea?

    func attach(to view: NSView) {
        self.view = view
        view.wantsLayer = true
        view.layer?.cornerCurve = .continuous
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil)
        view.addTrackingArea(area)
        self.area = area
    }

    @objc func mouseEntered(with event: NSEvent) { set(true) }
    @objc func mouseExited(with event: NSEvent) { set(false) }

    private func set(_ on: Bool) {
        guard let view, let layer = view.layer else { return }
        layer.cornerRadius = view.bounds.height / 2
        var color: CGColor?
        view.effectiveAppearance.performAsCurrentDrawingAppearance { color = on ? Theme.barButtonHover.cgColor : nil }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            context.allowsImplicitAnimation = true
            layer.backgroundColor = color
        }
    }
}
