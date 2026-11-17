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

    /// One menu, Claude Code style: the models (Gemini, Claude), then the thinking effort.
    private func makeAgentMenu() -> NSMenu {
        let menu = NSMenu(title: "Model ve düşünme düzeyi")
        let current = getChoice()

        menu.addItem(.sectionHeader(title: "Gemini (API / CLI)"))
        for candidate in AgentModel.geminiCases {
            menu.addItem(modelItem(candidate, current: current.model))
        }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Claude"))
        for candidate in AgentModel.claudeCases {
            menu.addItem(modelItem(candidate, current: current.model))
        }
        menu.addItem(.separator())
        menu.addItem(.sectionHeader(title: "Düşünme düzeyi"))
        for candidate in AgentEffort.knownCases {
            let item = NSMenuItem(title: candidate.displayName, action: #selector(pickEffort(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = candidate.rawValue
            item.state = candidate == current.effort ? .on : .off
            menu.addItem(item)
        }
        return menu
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
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

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

    private func showMenu() {
        guard let menu = buildMenu?() else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 4), in: self)
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
    private var activePopover: NSPopover?

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
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

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
        if let popover = activePopover, popover.isShown {
            popover.close()
            activePopover = nil
            return
        }
        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = UsagePopoverViewController(app: app, presence: getPresence()) { [weak popover, weak self] section in
            popover?.close()
            self?.app.openSettings(section)
        }
        popover.show(relativeTo: bounds, of: self, preferredEdge: .minY)
        activePopover = popover
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
