import AppKit
import StudioKit

/// The "iPhone'u bağla" card: the QR code the iPhone scans, two short steps and, for typing by
/// hand, the 6-digit code with its countdown. Shared by Settings → Cihazlar and the start
/// screen. The offer stays fresh while the card is on screen (`PhonePairingModel.showQR`).
final class PhonePairingCardView: NSView {
    private let model: PhonePairingModel
    private let qrSize: CGFloat
    /// QR on top and the text under it (the narrow right panel); side by side otherwise.
    private let vertical: Bool

    private let qrBox = ThemedView()
    private let qrView = NSImageView()
    private let spinner = NSProgressIndicator()
    private let doneMark = NSImageView()
    private let titleLabel = NSTextField.styledLabel("iPhone'u bağla", font: NSFont.systemFont(ofSize: 15, weight: .semibold))
    private let stepsLabel = NSTextField.styledLabel("", font: NSFont.systemFont(ofSize: 13), color: Theme.textSecondary, wraps: true)
    private let codeLabel = NSTextField.styledLabel("", font: NSFont.systemFont(ofSize: 12), color: Theme.textSecondary, wraps: true)
    private var actionButton: PillButton!
    private var laterButton: PillButton?
    private var observation: ObservationToken?
    private var isShowingQR = false
    private var action: (() -> Void)?

    /// Shown as "Sonra" when set (start screen).
    var onDismiss: (() -> Void)? {
        didSet { laterButton?.isHidden = onDismiss == nil }
    }

    /// What the card says now (tests read it).
    var displayedTitle: String { titleLabel.stringValue }
    var displayedSteps: String { stepsLabel.stringValue }
    var displayedCode: String { codeLabel.isHidden ? "" : codeLabel.stringValue }
    var displaysQR: Bool { !qrBox.isHidden && qrView.image != nil }

    init(model: PhonePairingModel, qrSize: CGFloat = 168, vertical: Bool = false) {
        self.model = model
        self.qrSize = qrSize
        self.vertical = vertical
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        build()
        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        // The QR code stays black on white in dark mode too (cameras need the contrast).
        qrBox.backgroundColor = .white
        qrBox.cornerRadius = 14
        qrBox.translatesAutoresizingMaskIntoConstraints = false
        qrView.imageScaling = .scaleProportionallyUpOrDown
        qrView.wantsLayer = true
        qrView.layer?.magnificationFilter = .nearest
        qrView.translatesAutoresizingMaskIntoConstraints = false
        qrView.setAccessibilityLabel("iPhone'u bağlamak için QR kod")
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.translatesAutoresizingMaskIntoConstraints = false
        doneMark.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: "Bağlandı")?
            .withSymbolConfiguration(.init(pointSize: 44, weight: .regular))
        doneMark.contentTintColor = Theme.accent
        doneMark.translatesAutoresizingMaskIntoConstraints = false
        for view in [qrView, spinner, doneMark] { qrBox.addSubview(view) }
        let inset: CGFloat = 10
        NSLayoutConstraint.activate([
            qrBox.widthAnchor.constraint(equalToConstant: qrSize),
            qrBox.heightAnchor.constraint(equalToConstant: qrSize),
            qrView.leadingAnchor.constraint(equalTo: qrBox.leadingAnchor, constant: inset),
            qrView.trailingAnchor.constraint(equalTo: qrBox.trailingAnchor, constant: -inset),
            qrView.topAnchor.constraint(equalTo: qrBox.topAnchor, constant: inset),
            qrView.bottomAnchor.constraint(equalTo: qrBox.bottomAnchor, constant: -inset),
            spinner.centerXAnchor.constraint(equalTo: qrBox.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: qrBox.centerYAnchor),
            doneMark.centerXAnchor.constraint(equalTo: qrBox.centerXAnchor),
            doneMark.centerYAnchor.constraint(equalTo: qrBox.centerYAnchor),
        ])

        actionButton = PillButton(title: "Yeni kod", kind: .secondary, height: 26) { [weak self] in self?.action?() }
        var buttons: [NSView] = [actionButton]
        let later = PillButton(title: "Sonra", kind: .outline, height: 26) { [weak self] in self?.onDismiss?() }
        later.isHidden = true
        laterButton = later
        buttons.append(later)
        let buttonRow = NSStackView(views: buttons)
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8

        stepsLabel.preferredMaxLayoutWidth = 300
        codeLabel.preferredMaxLayoutWidth = 300
        codeLabel.isSelectable = true
        let textColumn = NSStackView(views: [titleLabel, stepsLabel, codeLabel, buttonRow])
        textColumn.orientation = .vertical
        textColumn.alignment = .leading
        textColumn.spacing = 8
        textColumn.setCustomSpacing(12, after: codeLabel)
        textColumn.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [qrBox, textColumn])
        row.orientation = vertical ? .vertical : .horizontal
        row.alignment = vertical ? .leading : .centerY
        row.spacing = vertical ? 14 : 20
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        if vertical {
            textColumn.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
    }

    override func layout() {
        super.layout()
        // In the narrow panel the steps wrap at the width the card got.
        guard vertical, bounds.width > 0 else { return }
        for label in [stepsLabel, codeLabel] where abs(label.preferredMaxLayoutWidth - bounds.width) > 0.5 {
            label.preferredMaxLayoutWidth = bounds.width
            needsLayout = true
        }
    }

    // MARK: Visibility drives the offer

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if let window {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: window)
            NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: window)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window {
            // A closed main window (Studio keeps running) or a dismissed Settings sheet keeps its
            // views: without these the QR offer was polled every second for good.
            NotificationCenter.default.addObserver(self, selector: #selector(windowVisibilityChanged(_:)), name: NSWindow.didChangeOcclusionStateNotification, object: window)
            NotificationCenter.default.addObserver(self, selector: #selector(windowWillClose(_:)), name: NSWindow.willCloseNotification, object: window)
        }
        updateShowing()
    }

    override var isHidden: Bool {
        didSet { updateShowing() }
    }

    @objc private func windowVisibilityChanged(_ note: Notification) { updateShowing() }

    @objc private func windowWillClose(_ note: Notification) { updateShowing(closing: true) }

    /// Shown while in a window that is on screen: not closed or ordered out, not minimized or fully
    /// covered (a window that has not reported its occlusion yet counts as shown).
    static func isOnScreen(inWindow: Bool, windowVisible: Bool, hidden: Bool, occlusion: NSWindow.OcclusionState, closing: Bool) -> Bool {
        guard inWindow, windowVisible, !hidden, !closing else { return false }
        return occlusion.isEmpty || occlusion.contains(.visible)
    }

    private func updateShowing(closing: Bool = false) {
        let visible = Self.isOnScreen(
            inWindow: window != nil, windowVisible: window?.isVisible ?? false, hidden: isHiddenOrHasHiddenAncestor,
            occlusion: window?.occlusionState ?? [], closing: closing)
        guard visible != isShowingQR else { return }
        isShowingQR = visible
        if visible { model.showQR() } else { model.hideQR() }
    }

    // MARK: Render

    private func render() {
        let phase = model.phase
        if case .paired = phase { laterButton?.isHidden = true } else { laterButton?.isHidden = onDismiss == nil }
        let seconds = model.codeSecondsLeft
        qrView.image = nil
        doneMark.isHidden = true
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        codeLabel.isHidden = true
        actionButton.isHidden = false
        qrBox.isHidden = false

        switch phase {
        case .unavailable(let message):
            titleLabel.stringValue = "iPhone'u bağla"
            stepsLabel.stringValue = message.isEmpty ? "Studio hazırlanıyor…" : message
            qrBox.isHidden = true
            actionButton.isHidden = true
        case .preparing:
            titleLabel.stringValue = "iPhone'u bağla"
            stepsLabel.stringValue = Self.steps
            spinner.isHidden = false
            spinner.startAnimation(nil)
            actionButton.isHidden = true
        case .ready:
            titleLabel.stringValue = "iPhone'u bağla"
            stepsLabel.stringValue = Self.steps
            qrView.image = model.qrImage
            if let code = model.formattedCode, seconds > 0 {
                codeLabel.stringValue = "Kodu elle girmek için: \(code) · \(Self.countdown(seconds))"
            } else {
                codeLabel.stringValue = "Elle girilecek kodun süresi doldu; QR kod hâlâ geçerli."
            }
            codeLabel.isHidden = false
            set(action: "Yeni kod") { [weak self] in Task { await self?.model.renewOffer() } }
        case .paired(let name):
            titleLabel.stringValue = "iPhone bağlandı"
            stepsLabel.stringValue = "\(name) artık bu Mac'e bağlı. Bundan sonra bağlantı kendiliğinden kurulur."
            doneMark.isHidden = false
            if let onDismiss {
                set(action: "Tamam", onDismiss)
            } else {
                set(action: "Başka bir iPhone bağla") { [weak self] in Task { await self?.model.renewOffer() } }
            }
        case .failed(let message):
            titleLabel.stringValue = "iPhone'u bağla"
            stepsLabel.stringValue = message
            qrBox.isHidden = true
            set(action: "Tekrar dene") { [weak self] in Task { await self?.model.renewOffer() } }
        }
    }

    private func set(action title: String, _ run: @escaping () -> Void) {
        actionButton.title = title
        action = run
    }

    static let steps = "iPhone'da Studio'yu aç, “iPhone'u bağla”ya dokun ve bu kodu okut. iPhone'un Kamera uygulamasıyla da okutabilirsin."

    /// "1:45".
    static func countdown(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

// MARK: - Settings → "Cihazlar"

/// The QR card and the paired iPhones (each with "Kaldır").
final class DevicesSectionView: SettingsPaneView {
    private let model: PhonePairingModel
    private let card: PhonePairingCardView
    private let deviceList = SettingsGroupBlock()
    private let messageNote = SettingsNoteView("")
    private var observation: ObservationToken?

    init(model: PhonePairingModel) {
        self.model = model
        self.card = PhonePairingCardView(model: model)
        super.init(section: .devices)
        add(SettingsCustomBlock(card, searchText: SettingsCatalog.pairPhone.searchText, verticalPadding: 14))
        addSubheader("Bağlı iPhone'lar")
        add(deviceList)
        add(messageNote)
        messageNote.isAvailable = false
        observation = observe { [weak self] in self?.render() }
        Task { await model.loadDevices() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Device names on screen (tests).
    private(set) var listedDevices: [String] = []

    private func render() {
        let devices = model.activeDevices
        let loaded = model.hasLoadedDevices
        listedDevices = devices.map(\.name)
        if devices.isEmpty {
            deviceList.setBlocks([SettingsNoteView(loaded ? "Henüz bağlı iPhone yok." : "Yükleniyor…")])
        } else {
            deviceList.setBlocks(devices.map { device in
                let seen = device.lastSeenAt.map { "son görülme \($0.formatted(.relative(presentation: .named)))" } ?? "henüz görülmedi"
                let detail = "Bağlandı \(device.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(seen)"
                let remove = PillButton(title: "Kaldır", kind: .outline, height: 26) { [weak self] in
                    guard let self else { return }
                    Task { await self.model.remove(device) }
                }
                return SettingsRowView(title: device.name, detail: detail, accessory: remove, keywords: "cihaz telefon iphone kaldır")
            })
        }
        if let message = model.message, !message.isEmpty {
            messageNote.text = message
            messageNote.isAvailable = true
        } else {
            messageNote.isAvailable = false
        }
        refresh()
    }
}
