import AppKit
import StudioKit

/// Pure AppKit Start screen (04):
/// - Centred `"Ne üretelim?"` (30pt bold)
/// - `ComposerControlView` (max width 566) + `ComposerFooterControlView` underneath (Mac status, usage ring, "Opus Orta" model + effort menu)
/// - Inline error banner
/// - Three suggestion pills (`"Bu ayın postlarını üret"`, `"Yeni ürün duyurusu"`, `"Bu haftayı planla"`).
final class StartViewController: NSViewController {
    private unowned let app: AppModel
    private var composerView: ComposerControlView!
    private var footerView: ComposerFooterControlView!
    private let errorBanner = InlineErrorBannerView()
    /// "iPhone'u bağla" with the QR code, while no iPhone is paired (first run).
    private(set) var pairingCard: PhonePairingCardView!
    private let pairingContainer = ThemedView()
    private var observation: ObservationToken?
    private var pairingObservation: ObservationToken?
    private var lastFocusRequest = 0

    init(app: AppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas

        let model = app.newChat

        let heading = NSTextField(labelWithString: "Ne üretelim?")
        heading.font = NSFont.systemFont(ofSize: 30, weight: .bold)
        heading.textColor = Theme.textPrimary

        composerView = ComposerControlView(
            model: model.composer,
            imageStore: app.images,
            onStop: nil,
            onSend: { [weak model] in
                guard let model else { return }
                Task { await model.send() }
            }
        )
        footerView = ComposerFooterControlView(newChat: model, app: app)

        let footerWrapper = NSView()
        footerWrapper.translatesAutoresizingMaskIntoConstraints = false
        footerWrapper.addSubview(footerView)
        NSLayoutConstraint.activate([
            footerView.leadingAnchor.constraint(equalTo: footerWrapper.leadingAnchor, constant: 10),
            footerView.trailingAnchor.constraint(equalTo: footerWrapper.trailingAnchor, constant: -10),
            footerView.topAnchor.constraint(equalTo: footerWrapper.topAnchor),
            footerView.bottomAnchor.constraint(equalTo: footerWrapper.bottomAnchor),
        ])

        let composerGroup = NSStackView(views: [composerView, footerWrapper])
        composerGroup.orientation = .vertical
        composerGroup.alignment = .trailing
        composerGroup.spacing = 8
        composerGroup.translatesAutoresizingMaskIntoConstraints = false

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak model] in model?.error = nil }

        let suggestionsRow = NSStackView(views: NewChatModel.suggestions.map { suggestion in
            PillButton(title: suggestion, kind: .outline, height: 28) { [weak self] in
                self?.prefill(suggestion)
            }
        })
        suggestionsRow.orientation = .horizontal
        suggestionsRow.alignment = .centerY
        suggestionsRow.spacing = 6

        pairingCard = PhonePairingCardView(model: app.phonePairing, qrSize: 120)
        pairingCard.onDismiss = { [weak app] in app?.phonePairingHintDismissed = true }
        pairingContainer.backgroundColor = Theme.fill
        pairingContainer.cornerRadius = Theme.cardRadius
        pairingContainer.translatesAutoresizingMaskIntoConstraints = false
        pairingContainer.addSubview(pairingCard)
        NSLayoutConstraint.activate([
            pairingCard.leadingAnchor.constraint(equalTo: pairingContainer.leadingAnchor, constant: 16),
            pairingCard.trailingAnchor.constraint(equalTo: pairingContainer.trailingAnchor, constant: -16),
            pairingCard.topAnchor.constraint(equalTo: pairingContainer.topAnchor, constant: 16),
            pairingCard.bottomAnchor.constraint(equalTo: pairingContainer.bottomAnchor, constant: -16),
        ])
        pairingContainer.isHidden = true
        pairingCard.isHidden = true

        let centerStack = NSStackView(views: [heading, composerGroup, errorBanner, suggestionsRow, pairingContainer])
        centerStack.orientation = .vertical
        centerStack.alignment = .centerX
        centerStack.spacing = 24
        centerStack.setCustomSpacing(12, after: composerGroup)
        centerStack.setCustomSpacing(28, after: errorBanner)
        centerStack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(centerStack)

        let widthPref = composerGroup.widthAnchor.constraint(equalToConstant: 566)
        widthPref.priority = .defaultHigh

        NSLayoutConstraint.activate([
            centerStack.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            centerStack.centerYAnchor.constraint(equalTo: root.centerYAnchor, constant: -24),
            centerStack.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: Theme.columnMinMargin),
            centerStack.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -Theme.columnMinMargin),

            widthPref,
            composerGroup.widthAnchor.constraint(lessThanOrEqualToConstant: 566),
            composerView.widthAnchor.constraint(equalTo: composerGroup.widthAnchor),
            footerWrapper.widthAnchor.constraint(equalTo: composerGroup.widthAnchor),
            errorBanner.widthAnchor.constraint(lessThanOrEqualToConstant: 566),
            pairingContainer.widthAnchor.constraint(equalTo: composerGroup.widthAnchor),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        app.newChat.updatePlaceholder()
        lastFocusRequest = app.newChat.focusRequest

        app.phonePairing.startWatching()
        pairingObservation = observe { [weak self] in self?.renderPairingCard() }
        observation = observe { [weak self] in
            guard let self else { return }
            _ = self.app.currentBrandId
            self.app.newChat.updatePlaceholder()
            self.composerView.isBusy = self.app.newChat.isCreating

            if let err = self.app.newChat.error {
                self.errorBanner.message = err
                self.errorBanner.isHidden = false
            } else {
                self.errorBanner.isHidden = true
            }

            let req = self.app.newChat.focusRequest
            if req != self.lastFocusRequest {
                self.lastFocusRequest = req
                DispatchQueue.main.async { [weak self] in
                    self?.app.newChat.composer.bridge?.focus()
                }
            }
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        app.newChat.updatePlaceholder()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.app.newChat.composer.bridge?.focus()
        }
    }

    /// Shown on the empty start screen until the first iPhone is paired (or "Sonra"); it stays
    /// for its "bağlandı" moment after the phone paired.
    private func renderPairingCard() {
        let pairing = app.phonePairing
        var justPaired = false
        if case .paired = pairing.phase { justPaired = !pairingCard.isHidden }
        let show = !app.isSample && !app.phonePairingHintDismissed && (pairing.needsFirstPhone || justPaired)
        pairingContainer.isHidden = !show
        pairingCard.isHidden = !show
    }

    private func prefill(_ suggestion: String) {
        let brand = app.brand(app.currentBrandId)?.name.split(separator: " ").first.map(String.init)
        let text = brand.map { "\($0) için \(suggestion.prefix(1).lowercased() + suggestion.dropFirst())" } ?? suggestion
        app.newChat.composer.text = text
        app.newChat.composer.bridge?.setText(text)
        app.newChat.composer.bridge?.focus()
    }
}
