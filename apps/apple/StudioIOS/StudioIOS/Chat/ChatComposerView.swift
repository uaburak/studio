import StudioKit
import UIKit

/// Text view that hands pasted images to the composer instead of inserting them.
final class ComposerTextView: UITextView {
    var onPasteImages: (([UIImage]) -> Void)?
    let placeholderLabel = UILabel.studio("", size: 17, color: IOSTheme.textSecondary, lines: 1)

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        addSubview(placeholderLabel)
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = true
        placeholderLabel.isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholderLabel.frame = CGRect(
            x: textContainerInset.left + textContainer.lineFragmentPadding, y: textContainerInset.top,
            width: max(0, bounds.width - textContainerInset.left - textContainerInset.right - 2 * textContainer.lineFragmentPadding),
            height: placeholderLabel.font.lineHeight + 2)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        let images = ImagePicking.pastedImages()
        if !images.isEmpty, let onPasteImages {
            onPasteImages(images)
            return
        }
        super.paste(sender)
    }
}

/// What the round primary button at the right end of the composer does right now.
enum ComposerPrimaryAction: Equatable {
    /// Text or images to send (disabled while images upload or one failed).
    case send(enabled: Bool)
    /// The agent is answering: stop it.
    case stop
    /// The message is on its way.
    case sending
    /// Nothing to send and nothing running: the button is hidden (the mic dictates).
    case idle

    static func resolve(hasContent: Bool, canSend: Bool, isSending: Bool, isRunning: Bool) -> Self {
        if isRunning { return .stop }
        if isSending { return .sending }
        if hasContent { return .send(enabled: canSend) }
        return .idle
    }

    var symbol: String {
        switch self {
        case .send, .sending, .idle: "arrow.up"
        case .stop: "stop.fill"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .send, .idle: "Gönder"
        case .stop: "Yanıtı durdur"
        case .sending: "Gönderiliyor"
        }
    }

    var accessibilityHint: String? {
        switch self {
        case .send(enabled: false): "Görseller yüklenince gönderilebilir"
        default: nil
        }
    }

    var isEnabled: Bool {
        switch self {
        case .send(let enabled): enabled
        case .sending, .idle: false
        case .stop: true
        }
    }

    var isVisible: Bool { self != .idle }
}

/// The floating chat composer: one glass pill. At rest it is one row: + (attach), the text,
/// the mic (dictation) and, while there is something to send or a reply runs, the round
/// send / stop button. While typing it opens into two rows: the text on top, then +, the
/// model pill (model and effort sheet), the mic and send. Above it: `@` mention suggestions,
/// starter prompts on an empty chat, and errors. Attachments sit inside the pill.
final class ChatComposerView: UIView, UITextViewDelegate {
    private unowned let model: IOSConversationModel
    weak var host: UIViewController?
    var onSendTapped: (() -> Void)?
    /// Starter prompts shown on an empty new chat.
    var starters: [String] = [] { didSet { renderedStarters = nil; render() } }
    var onStarter: ((String) -> Void)?

    let textView = ComposerTextView()
    let pill = UIVisualEffectView(effect: ChatComposerView.glass())
    let attachButton = UIButton(type: .system)
    let micButton = UIButton(type: .system)
    let primaryButton = UIButton(type: .system)
    let modelButton = UIButton(type: .system)
    let dictation = IOSDictation()
    private(set) var primaryAction: ComposerPrimaryAction = .idle
    /// Two rows (text, then controls) while typing; one row at rest.
    private(set) var isExpanded = false
    private let textRow = UIStackView()
    private let controlsRow = UIStackView()
    private let controlsSpacer = UIView()
    private let suggestionsScroll = UIScrollView()
    private let suggestionsStack = UIStackView()
    private let startersScroll = UIScrollView()
    private let startersStack = UIStackView()
    private let draftsScroll = UIScrollView()
    private let draftsStack = UIStackView()
    private let errorLabel = UILabel.studio("", size: 13, color: IOSTheme.accent, lines: 3, style: .footnote)
    private var textHeight: NSLayoutConstraint!
    private var observation: IOSObservationToken?
    private var renderedDrafts: [IOSComposerModel.Draft] = []
    private var renderedSuggestions: [MentionCandidate] = []
    private var renderedStarters: [String]?
    private var dictationBase = ""
    private var isPulsing = false
    private var dictationError: String?
    private static let maxTextHeight: CGFloat = 140
    private static let control: CGFloat = 40

    init(model: IOSConversationModel) {
        self.model = model
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = .clear
        build()
        dictation.onTranscript = { [weak self] text in self?.applyDictation(text) }
        observation = observeIOS { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private static func glass() -> UIVisualEffect {
        let glass = UIGlassEffect(style: .regular)
        glass.isInteractive = false
        return glass
    }

    private func build() {
        // `@` suggestions and starter prompts: horizontal strips above the pill.
        for (scroll, stack) in [(suggestionsScroll, suggestionsStack), (startersScroll, startersStack), (draftsScroll, draftsStack)] {
            scroll.translatesAutoresizingMaskIntoConstraints = false
            scroll.showsHorizontalScrollIndicator = false
            scroll.clipsToBounds = false
            stack.axis = .horizontal
            stack.spacing = 8
            stack.alignment = .center
            stack.translatesAutoresizingMaskIntoConstraints = false
            scroll.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 4),
                stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -4),
                stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
                stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
                stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            ])
            // An empty strip has no width of its own.
            let width = stack.widthAnchor.constraint(equalToConstant: 0)
            width.priority = .fittingSizeLevel
            width.isActive = true
        }
        draftsStack.spacing = 10
        draftsStack.alignment = .top

        textView.font = IOSTheme.font(17)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = IOSTheme.textPrimary
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: 10, left: 4, bottom: 10, right: 4)
        textView.isScrollEnabled = false
        textView.delegate = self
        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.accessibilityLabel = "Mesaj"
        textView.onPasteImages = { [weak self] images in self?.model.composer.add(images) }
        textHeight = textView.heightAnchor.constraint(equalToConstant: Self.control)
        textHeight.isActive = true

        Self.styleRound(attachButton, symbol: "plus", filled: false)
        attachButton.showsMenuAsPrimaryAction = true
        attachButton.accessibilityLabel = "Ekle"
        attachButton.accessibilityHint = "Fotoğraf, kamera, dosya ya da panodaki görseli ekler"

        Self.styleRound(micButton, symbol: "mic", filled: false)
        micButton.accessibilityLabel = "Dikte"
        micButton.accessibilityHint = "Söylediklerini mesaja yazar"
        micButton.addAction(UIAction { [weak self] _ in self?.toggleDictation() }, for: .touchUpInside)

        Self.styleRound(primaryButton, symbol: "arrow.up", filled: true)
        primaryButton.addAction(UIAction { [weak self] _ in self?.primaryTapped() }, for: .touchUpInside)
        primaryButton.isHidden = true

        modelButton.translatesAutoresizingMaskIntoConstraints = false
        modelButton.heightAnchor.constraint(equalToConstant: Self.control).isActive = true
        modelButton.accessibilityLabel = "Model ve çaba"
        modelButton.addAction(UIAction { [weak self] _ in self?.showModelSheet() }, for: .touchUpInside)
        modelButton.isHidden = true
        controlsSpacer.setContentHuggingPriority(.init(1), for: .horizontal)
        controlsSpacer.setContentCompressionResistancePriority(.init(1), for: .horizontal)

        for row in [textRow, controlsRow] {
            row.axis = .horizontal
            row.spacing = 6
            row.alignment = .bottom
        }
        controlsRow.alignment = .center
        controlsRow.isHidden = true
        // The text view never moves between rows (that would end editing); the buttons do.
        textRow.addArrangedSubview(attachButton)
        textRow.addArrangedSubview(textView)
        textRow.addArrangedSubview(micButton)
        textRow.addArrangedSubview(primaryButton)
        let pillStack = UIStackView.v([draftsScroll, textRow, controlsRow], spacing: 6)
        pill.translatesAutoresizingMaskIntoConstraints = false
        pill.cornerConfiguration = .corners(radius: .fixed(26))
        pill.contentView.addSubview(pillStack)
        pillStack.pin(to: pill.contentView, insets: UIEdgeInsets(top: 6, left: 6, bottom: 6, right: 6))

        errorLabel.isHidden = true
        errorLabel.textAlignment = .center
        let outer = UIStackView.v([suggestionsScroll, startersScroll, errorLabel, pill], spacing: 8)
        addSubview(outer)
        NSLayoutConstraint.activate([
            outer.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            outer.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            outer.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            outer.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            suggestionsScroll.heightAnchor.constraint(equalToConstant: 40),
            startersScroll.heightAnchor.constraint(equalToConstant: 40),
            draftsScroll.heightAnchor.constraint(equalToConstant: 80),
        ])
        suggestionsScroll.isHidden = true
        startersScroll.isHidden = true
        draftsScroll.isHidden = true
    }

    /// 40 pt round control: grey for + and the mic, ink (white on dark, black on light) for the primary.
    private static func styleRound(_ button: UIButton, symbol: String, filled: Bool) {
        button.translatesAutoresizingMaskIntoConstraints = false
        button.configuration = roundConfig(symbol: symbol, filled: filled, active: false)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: control),
            button.heightAnchor.constraint(equalToConstant: control),
        ])
    }

    private static func roundConfig(symbol: String, filled: Bool, active: Bool) -> UIButton.Configuration {
        var config = UIButton.Configuration.filled()
        config.cornerStyle = .capsule
        config.contentInsets = .zero
        config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: filled ? 16 : 17, weight: filled ? .semibold : .regular))
        config.baseBackgroundColor = filled || active ? IOSTheme.ink : IOSTheme.fill.withAlphaComponent(0.8)
        config.baseForegroundColor = filled || active ? IOSTheme.onInk : IOSTheme.textPrimary
        return config
    }

    // MARK: Render

    private func render() {
        let composer = model.composer
        if textView.text != composer.text {
            textView.text = composer.text
            let caret = min(composer.caret, (composer.text as NSString).length)
            textView.selectedRange = NSRange(location: caret, length: 0)
            updateTextHeight()
        }
        let listening = dictation.state != .idle
        textView.placeholderLabel.text = listening ? "Dinliyorum…" : composer.placeholder
        textView.placeholderLabel.isHidden = !composer.text.isEmpty

        let message = dictationError ?? model.error ?? composer.error ?? composer.sendBlockedReason.flatMap { composer.hasFailedUploads ? $0 : nil }
        errorLabel.text = message
        errorLabel.isHidden = message == nil

        attachButton.menu = attachMenu()
        attachButton.alpha = composer.canAttach ? 1 : 0.45

        var mic = Self.roundConfig(symbol: listening ? "mic.fill" : "mic", filled: false, active: listening)
        mic.showsActivityIndicator = dictation.state == .starting
        micButton.configuration = mic
        micButton.accessibilityValue = listening ? "Dinliyor" : nil

        renderPrimary()
        renderModelButton()
        updateExpansion()
        renderDrafts()
        renderSuggestions()
        renderStarters()
    }

    private func renderPrimary() {
        let action = ComposerPrimaryAction.resolve(
            hasContent: !model.composer.isEmpty, canSend: model.canSend, isSending: model.isSending,
            isRunning: model.activeRun != nil)
        primaryAction = action
        var config = Self.roundConfig(symbol: action.symbol, filled: true, active: false)
        config.showsActivityIndicator = action == .sending
        if action == .sending { config.image = nil }
        primaryButton.configuration = config
        primaryButton.isEnabled = action.isEnabled
        primaryButton.alpha = action.isEnabled || action == .sending ? 1 : 0.35
        primaryButton.accessibilityLabel = action.accessibilityLabel
        primaryButton.accessibilityHint = action.accessibilityHint
        if primaryButton.isHidden == action.isVisible { primaryButton.isHidden = !action.isVisible }
        // The mic pulses while it listens.
        let pulse = dictation.state == .listening
        if pulse != isPulsing {
            isPulsing = pulse
            if pulse {
                micButton.imageView?.addSymbolEffect(.variableColor.iterative, options: .repeating)
            } else {
                micButton.imageView?.removeAllSymbolEffects()
            }
        }
    }

    /// "Opus  Orta": the model in ink, the effort in grey, like a pill.
    private func renderModelButton() {
        let selection = model.selection
        var config = UIButton.Configuration.filled()
        config.cornerStyle = .capsule
        config.baseBackgroundColor = IOSTheme.fill.withAlphaComponent(0.8)
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
        var title = AttributedString(selection.model.displayName)
        title.font = IOSTheme.font(15, .medium, style: .subheadline)
        title.foregroundColor = IOSTheme.textPrimary
        var effort = AttributedString("  " + selection.effort.displayName)
        effort.font = IOSTheme.font(15, style: .subheadline)
        effort.foregroundColor = IOSTheme.textSecondary
        config.attributedTitle = title + effort
        modelButton.configuration = config
        modelButton.accessibilityValue = "\(selection.model.displayName), çaba \(selection.effort.displayName)"
    }

    /// Opens into two rows while the text is being edited (or holds text / images).
    private func updateExpansion() {
        let composer = model.composer
        let expand = textView.isFirstResponder || !composer.text.isEmpty || !composer.drafts.isEmpty
        guard expand != isExpanded else { return }
        isExpanded = expand
        if expand {
            for view in [attachButton, modelButton, controlsSpacer, micButton, primaryButton] {
                controlsRow.addArrangedSubview(view)
            }
            modelButton.isHidden = false
            controlsRow.isHidden = false
        } else {
            controlsRow.isHidden = true
            modelButton.isHidden = true
            textRow.insertArrangedSubview(attachButton, at: 0)
            textRow.addArrangedSubview(micButton)
            textRow.addArrangedSubview(primaryButton)
        }
        textView.textContainerInset.left = expand ? 10 : 4
        if window != nil {
            UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0) {
                self.superview?.layoutIfNeeded()
            }
        }
    }

    private func showModelSheet() {
        guard let host else { return }
        Haptics.selection()
        let sheet = ModelPickerViewController(model: model)
        let nav = UINavigationController(rootViewController: sheet)
        if let presentation = nav.sheetPresentationController {
            presentation.detents = [.medium(), .large()]
            presentation.prefersGrabberVisible = true
        }
        host.present(nav, animated: true)
    }

    private func renderDrafts() {
        let drafts = model.composer.drafts
        draftsScroll.isHidden = drafts.isEmpty
        guard drafts != renderedDrafts else { return }
        renderedDrafts = drafts
        draftsStack.removeAllArranged()
        for draft in drafts { draftsStack.addArrangedSubview(draftChip(draft)) }
    }

    private func draftChip(_ draft: IOSComposerModel.Draft) -> UIView {
        let image = UIImageView(image: draft.thumbnail)
        image.translatesAutoresizingMaskIntoConstraints = false
        image.contentMode = .scaleAspectFill
        image.clipsToBounds = true
        image.layer.cornerRadius = 14
        image.layer.cornerCurve = .continuous
        let box = UIButton(type: .custom)
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(image)
        image.pin(to: box)
        image.isUserInteractionEnabled = false
        NSLayoutConstraint.activate([box.widthAnchor.constraint(equalToConstant: 56), box.heightAnchor.constraint(equalToConstant: 56)])

        switch draft.state {
        case .uploading(let progress):
            let dim = UIView()
            dim.backgroundColor = UIColor.black.withAlphaComponent(0.35)
            dim.isUserInteractionEnabled = false
            box.addSubview(dim)
            dim.pin(to: box)
            dim.layer.cornerRadius = 14
            let ring = UsageRingView(size: 22)
            ring.ringColor = .white
            ring.fraction = max(0.05, progress)
            box.addSubview(ring)
            NSLayoutConstraint.activate([ring.centerXAnchor.constraint(equalTo: box.centerXAnchor), ring.centerYAnchor.constraint(equalTo: box.centerYAnchor)])
            box.accessibilityValue = "Yükleniyor yüzde \(Int(progress * 100))"
        case .failed(let message):
            let badge = ChatViews.icon("exclamationmark.circle.fill", IOSTheme.accent, size: 16)
            badge.backgroundColor = IOSTheme.elevated
            badge.layer.cornerRadius = 9
            box.addSubview(badge)
            NSLayoutConstraint.activate([badge.topAnchor.constraint(equalTo: box.topAnchor, constant: -4), badge.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: 4)])
            box.accessibilityValue = "Yüklenemedi: \(message)"
        case .uploaded:
            box.accessibilityValue = "Yüklendi"
        }
        box.isAccessibilityElement = true
        box.accessibilityLabel = "Ek @\(draft.alias)"
        box.showsMenuAsPrimaryAction = true
        box.menu = draftMenu(draft)

        let label = UILabel.studio("@\(draft.alias)", size: 11, weight: .medium, color: IOSTheme.textSecondary, style: .caption2)
        label.lineBreakMode = .byTruncatingMiddle
        label.widthAnchor.constraint(lessThanOrEqualToConstant: 64).isActive = true
        return UIStackView.v([box, label], spacing: 3, alignment: .center)
    }

    private func draftMenu(_ draft: IOSComposerModel.Draft) -> UIMenu {
        var actions: [UIMenuElement] = [
            UIAction(title: "Metne @\(draft.alias) ekle", image: UIImage(systemName: "at")) { [weak self] _ in
                self?.model.composer.appendMention(draft.alias)
                self?.textView.becomeFirstResponder()
            },
            UIAction(title: "Yeniden adlandır", image: UIImage(systemName: "pencil")) { [weak self] _ in
                self?.host?.prompt("Takma ad", message: "Metinde @ad ile bu görseli anarsın.", text: draft.alias, placeholder: "kapak") { name in
                    if let problem = self?.model.composer.rename(draft.id, to: name) { self?.host?.presentError(problem) }
                }
            },
        ]
        if case .failed = draft.state {
            actions.append(UIAction(title: "Tekrar yükle", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.model.composer.retry(draft.id) })
        }
        actions.append(UIAction(title: "Kaldır", image: UIImage(systemName: "xmark"), attributes: .destructive) { [weak self] _ in
            self?.model.composer.remove(draft.id)
        })
        return UIMenu(title: "@\(draft.alias)", children: actions)
    }

    private func renderSuggestions() {
        let composer = model.composer
        let suggestions = composer.isSuggesting && textView.isFirstResponder ? composer.suggestions : []
        suggestionsScroll.isHidden = suggestions.isEmpty
        guard suggestions != renderedSuggestions else { return }
        renderedSuggestions = suggestions
        suggestionsStack.removeAllArranged()
        for candidate in suggestions.prefix(12) {
            var config = UIButton.Configuration.glass()
            config.cornerStyle = .capsule
            config.baseForegroundColor = IOSTheme.textPrimary
            config.title = "@\(candidate.alias)"
            config.imagePadding = 6
            config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 12)
            if let draft = composer.draft(alias: candidate.alias) {
                config.image = Self.round(draft.thumbnail, side: 28)
            } else if let assetId = candidate.assetId, let image = model.app.images.image(assetId) {
                config.image = Self.round(image, side: 28)
            } else {
                config.image = UIImage(systemName: "photo")
                config.contentInsets.leading = 10
            }
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var out = incoming
                out.font = IOSTheme.font(14, .medium, style: .subheadline)
                return out
            }
            let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.choose(candidate) })
            button.accessibilityLabel = "@\(candidate.alias) an"
            if let assetId = candidate.assetId { model.app.images.load(assetId) }
            suggestionsStack.addArrangedSubview(button)
        }
    }

    /// Starter prompts while a new chat is empty (glass chips over the greeting).
    private func renderStarters() {
        let show = model.isNew && model.messages.isEmpty && model.composer.isEmpty && !model.composer.isSuggesting && !starters.isEmpty && dictation.state == .idle
        startersScroll.isHidden = !show
        guard show, renderedStarters != starters else { return }
        renderedStarters = starters
        startersStack.removeAllArranged()
        for starter in starters {
            var config = UIButton.Configuration.glass()
            config.cornerStyle = .capsule
            config.baseForegroundColor = IOSTheme.textPrimary
            config.title = starter
            config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var out = incoming
                out.font = IOSTheme.font(14, .medium, style: .subheadline)
                return out
            }
            let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.onStarter?(starter) })
            button.accessibilityHint = "Mesaj olarak yazar"
            startersStack.addArrangedSubview(button)
        }
    }

    private static func round(_ image: UIImage, side: CGFloat) -> UIImage {
        let size = CGSize(width: side, height: side)
        return UIGraphicsImageRenderer(size: size).image { _ in
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).addClip()
            let aspect = image.size.width / max(image.size.height, 1)
            let draw = aspect > 1 ? CGSize(width: side * aspect, height: side) : CGSize(width: side, height: side / max(aspect, 0.01))
            image.draw(in: CGRect(x: (side - draw.width) / 2, y: (side - draw.height) / 2, width: draw.width, height: draw.height))
        }.withRenderingMode(.alwaysOriginal)
    }

    private func choose(_ candidate: MentionCandidate) {
        let caret = model.composer.choose(candidate)
        textView.text = model.composer.text
        textView.selectedRange = NSRange(location: caret, length: 0)
        updateTextHeight()
        Haptics.selection()
    }

    /// Photos, camera, files, paste. Without a brand: why, and where to pick one.
    func attachMenu() -> UIMenu {
        let composer = model.composer
        guard composer.canAttach else {
            return UIMenu(title: composer.attachDisabledReason ?? "Görsel eklenemiyor", children: [
                UIAction(title: "Marka seç", image: UIImage(systemName: "building.2")) { [weak self] _ in self?.model.app.open(.brands) },
            ])
        }
        let remaining = max(1, 10 - composer.drafts.count)
        var items: [UIMenuElement] = [
            UIAction(title: "Fotoğraflar", image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in
                guard let self, let host = self.host else { return }
                ImagePicking.photos(from: host, limit: remaining) { self.model.composer.add($0) }
            },
        ]
        if ImagePicking.cameraAvailable {
            items.append(UIAction(title: "Kamera", image: UIImage(systemName: "camera")) { [weak self] _ in
                guard let self, let host = self.host else { return }
                ImagePicking.camera(from: host) { self.model.composer.add($0) }
            })
        }
        items.append(UIAction(title: "Dosyalar", image: UIImage(systemName: "folder")) { [weak self] _ in
            guard let self, let host = self.host else { return }
            ImagePicking.files(from: host, limit: remaining) { self.model.composer.add($0) }
        })
        items.append(UIAction(title: "Panodan yapıştır", image: UIImage(systemName: "doc.on.clipboard"), attributes: UIPasteboard.general.hasImages ? [] : .disabled) { [weak self] _ in
            self?.model.composer.add(ImagePicking.pastedImages())
        })
        return UIMenu(children: items)
    }

    // MARK: Actions

    private func primaryTapped() {
        switch primaryAction {
        case .stop:
            Task { await model.cancelRun() }
        case .send:
            if dictation.state != .idle { Task { await dictation.stop() } }
            onSendTapped?()
        case .sending, .idle:
            break
        }
    }

    func toggleDictation() {
        if dictation.state == .idle {
            startDictation()
        } else {
            Task { await dictation.stop() }
        }
    }

    private func startDictation() {
        dictationBase = model.composer.text
        dictationError = nil
        Haptics.selection()
        Task {
            if let problem = await dictation.start() {
                dictationError = problem
                render()
                Haptics.error()
            }
        }
    }

    private func applyDictation(_ transcript: String) {
        let base = dictationBase
        let separator = base.isEmpty || base.hasSuffix(" ") || base.hasSuffix("\n") ? "" : " "
        let text = base + separator + transcript
        model.composer.text = text
        model.composer.caret = (text as NSString).length
    }

    // MARK: UITextViewDelegate

    func textViewDidChange(_ textView: UITextView) {
        model.composer.text = textView.text
        model.composer.caret = textView.selectedRange.location
        updateTextHeight()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        model.composer.caret = textView.selectedRange.location
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
        if dictation.state != .idle { Task { await dictation.stop() } }
        renderSuggestions()
        updateExpansion()
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        renderSuggestions()
        updateExpansion()
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        // Return chooses the first suggestion while `@` suggestions are open.
        if text == "\n", model.composer.isSuggesting, let first = model.composer.suggestions.first {
            choose(first)
            return false
        }
        return true
    }

    private func updateTextHeight() {
        let width = textView.bounds.width > 0 ? textView.bounds.width : 220
        let fit = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let height = min(max(Self.control, fit), Self.maxTextHeight)
        textView.isScrollEnabled = fit > Self.maxTextHeight
        if textHeight.constant != height { textHeight.constant = height }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateTextHeight()
    }
}

/// "Model seçin": the models with a line on what each is for, then the effort. Picking
/// applies at once; the composer's pill follows.
final class ModelPickerViewController: UITableViewController {
    private unowned let model: IOSConversationModel
    private let efforts = AgentEffort.allCases.filter { $0 != .unknown }
    private var sections: [(title: String?, models: [AgentModel])] {
        [(nil, AgentModel.claudeCases), ("Gemini", AgentModel.geminiCases)]
    }

    init(model: IOSConversationModel) {
        self.model = model
        super.init(style: .insetGrouped)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    static func detail(_ candidate: AgentModel) -> String {
        switch candidate {
        case .opus: "Karmaşık işler ve günlük görevler için"
        case .sonnet: "Daha basit görevler için en verimli"
        case .haiku: "Hızlı yanıtlar için en hızlı"
        case .geminiPro: "Gemini'nin en güçlüsü"
        case .geminiFlash: "Hızlı ve dengeli"
        case .geminiFlashLite: "En hafif ve en hızlı"
        case .unknown: ""
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Model seçin"
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
    }

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count + 1 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section < sections.count ? sections[section].models.count : efforts.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        section < sections.count ? sections[section].title : "Çaba"
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell", for: indexPath)
        var content = UIListContentConfiguration.subtitleCell()
        content.textProperties.font = IOSTheme.font(17, style: .body)
        content.secondaryTextProperties.font = IOSTheme.font(14, style: .subheadline)
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        content.textToSecondaryTextVerticalPadding = 3
        content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0)
        let selection = model.selection
        let checked: Bool
        var enabled = true
        if indexPath.section < sections.count {
            let candidate = sections[indexPath.section].models[indexPath.row]
            content.text = candidate.displayName
            let available = AssistantStatus.isAvailable(candidate, presence: model.presence)
            if available {
                content.secondaryText = Self.detail(candidate)
            } else {
                content.secondaryText = model.presence?.online == true
                    ? (candidate.isGemini ? "Gemini Mac'te hazır değil" : "Claude girişi gerekli")
                    : "Mac çevrimdışı"
                enabled = model.presence == nil
            }
            checked = candidate == selection.model
        } else {
            let effort = efforts[indexPath.row]
            content.text = effort.displayName
            content.secondaryText = effort == .medium ? "Önerilen" : nil
            checked = effort == selection.effort
        }
        content.textProperties.color = enabled ? IOSTheme.textPrimary : IOSTheme.textSecondary
        cell.contentConfiguration = content
        cell.accessoryType = checked ? .checkmark : .none
        cell.tintColor = IOSTheme.accent
        cell.accessibilityTraits = checked ? [.button, .selected] : .button
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        Haptics.selection()
        if indexPath.section < sections.count {
            model.selection.model = sections[indexPath.section].models[indexPath.row]
            tableView.reloadData()
            dismiss(animated: true)
        } else {
            model.selection.effort = efforts[indexPath.row]
            tableView.reloadData()
        }
    }
}
