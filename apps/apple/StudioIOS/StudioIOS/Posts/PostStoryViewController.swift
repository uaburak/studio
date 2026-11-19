import StudioKit
import UIKit

/// Stories opened from the grid, like Instagram's story player: the story over black on a card
/// with round corners, one progress bar per story of the tab (starting at the tapped one), the
/// brand's header with the time, a menu and close. Each story stays about five seconds and then
/// the next comes; a tap on the right goes on, on the left third goes back, holding pauses and a
/// pull down closes it (flying it back into its tile). At the bottom, "Düzenle" and approve
/// instead of Instagram's message field.
final class PostStoryViewController: PostZoomPage, UIGestureRecognizerDelegate {
    static let storyDuration: TimeInterval = 5
    private static let cardRadius: CGFloat = 14
    private static let bottomBarHeight: CGFloat = 62

    private var index: Int
    private let card = UIView()
    private let media = IOSAssetImageView(store: nil, contentMode: .scaleAspectFill)
    private let placeholder = PostPlaceholderView()
    private let chrome = UIView()
    private let topShade = GradientView()
    private let segments = UIStackView()
    private let avatar = PostAvatarView(side: 32)
    private let nameLabel = UILabel.studio("", size: 14, weight: .semibold, color: .white, style: .subheadline)
    private let ageLabel = UILabel.studio("", size: 14, color: UIColor.white.withAlphaComponent(0.7), style: .subheadline)
    private let menuButton = StoryMenuButton(type: .system)
    private let closeButton = UIButton.studioIcon("xmark", label: "Kapat", size: 20, tint: .white)
    private let bottomBar = UIView()
    private var editButton: UIButton!
    private let approveButton = UIButton.glassCircle("checkmark", label: "Onayla", side: 44, pointSize: 18)
    private let shareButton = UIButton.glassCircle("paperplane", label: "Paylaş", side: 44, pointSize: 18)
    private lazy var pullPan: UIPanGestureRecognizer = {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pulled(_:)))
        pan.delegate = self
        return pan
    }()

    /// How far the current story has run (0...1).
    private var elapsed: TimeInterval = 0
    private var lastTick: CFTimeInterval?
    private var displayLink: CADisplayLink?
    private var holding = false
    private var menuOpen = false
    private var hasAppeared = false
    private var mediaHidden = false
    private var observation: IOSObservationToken?
    private var signature: Int?

    init(app: IOSAppModel, ids: [EntityID], start: EntityID, sourceFor: @escaping (EntityID) -> UIView?) {
        self.index = ids.firstIndex(of: start) ?? 0
        super.init(app: app, ids: ids, sourceFor: sourceFor)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var keepsSystemSwipeBack: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    private var currentCard: PostCard? { ids.indices.contains(index) ? app.posts.card(ids[index]) : nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = .black

        card.clipsToBounds = true
        card.layer.cornerRadius = Self.cardRadius
        card.layer.cornerCurve = .continuous
        card.backgroundColor = UIColor(white: 0.08, alpha: 1)
        view.addSubview(card)
        media.backgroundColor = .clear
        media.translatesAutoresizingMaskIntoConstraints = true
        media.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        card.addSubview(media)
        placeholder.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        card.addSubview(placeholder)

        // Everything over the picture fades with the flight.
        chrome.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        card.addSubview(chrome)
        topShade.flip()
        topShade.translatesAutoresizingMaskIntoConstraints = false
        topShade.isUserInteractionEnabled = false
        chrome.addSubview(topShade)
        segments.axis = .horizontal
        segments.spacing = 4
        segments.distribution = .fillEqually
        segments.translatesAutoresizingMaskIntoConstraints = false
        chrome.addSubview(segments)

        var menuConfig = UIButton.Configuration.plain()
        menuConfig.image = UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
        menuConfig.baseForegroundColor = .white
        menuButton.configuration = menuConfig
        menuButton.showsMenuAsPrimaryAction = true
        menuButton.accessibilityLabel = "Diğer"
        menuButton.onMenu = { [weak self] open in
            self?.menuOpen = open
            self?.updateRunning()
        }
        closeButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        let header = UIStackView.h([avatar, nameLabel, ageLabel, UIView.spacer(), menuButton, closeButton], spacing: 8)
        header.setCustomSpacing(10, after: avatar)
        header.translatesAutoresizingMaskIntoConstraints = false
        chrome.addSubview(header)
        NSLayoutConstraint.activate([
            topShade.leadingAnchor.constraint(equalTo: chrome.leadingAnchor),
            topShade.trailingAnchor.constraint(equalTo: chrome.trailingAnchor),
            topShade.topAnchor.constraint(equalTo: chrome.topAnchor),
            topShade.heightAnchor.constraint(equalToConstant: 110),
            segments.leadingAnchor.constraint(equalTo: chrome.leadingAnchor, constant: 8),
            segments.trailingAnchor.constraint(equalTo: chrome.trailingAnchor, constant: -8),
            segments.topAnchor.constraint(equalTo: chrome.topAnchor, constant: 8),
            segments.heightAnchor.constraint(equalToConstant: 2.5),
            header.leadingAnchor.constraint(equalTo: chrome.leadingAnchor, constant: 12),
            header.trailingAnchor.constraint(equalTo: chrome.trailingAnchor, constant: -4),
            header.topAnchor.constraint(equalTo: segments.bottomAnchor, constant: 8),
        ])

        // Taps go back and on, holding pauses; a pull down closes.
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.2
        tap.require(toFail: hold)
        for gesture in [tap, hold] {
            gesture.delegate = self
            card.addGestureRecognizer(gesture)
        }
        view.addGestureRecognizer(pullPan)

        // Instead of Instagram's message field: Düzenle, approve and share.
        var edit = UIButton.Configuration.glass()
        edit.title = "Düzenle"
        edit.image = UIImage(systemName: "pencil", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium))
        edit.imagePadding = 8
        edit.cornerStyle = .capsule
        edit.baseForegroundColor = .white
        edit.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { var a = $0; a.font = IOSTheme.font(15, .semibold, style: .callout); return a }
        editButton = UIButton(configuration: edit, primaryAction: UIAction { [weak self] _ in
            guard let self, let card = self.currentCard else { return }
            PostActions(app: self.app, host: self).edit(card)
        })
        editButton.translatesAutoresizingMaskIntoConstraints = false
        editButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
        approveButton.addAction(UIAction { [weak self] _ in
            guard let self, let card = self.currentCard else { return }
            PostActions(app: self.app, host: self).approve(card)
        }, for: .touchUpInside)
        shareButton.addAction(UIAction { [weak self] _ in
            guard let self, let card = self.currentCard else { return }
            PostActions(app: self.app, host: self).share(card, source: self.shareButton)
        }, for: .touchUpInside)
        let row = UIStackView.h([editButton, approveButton, shareButton], spacing: 10)
        row.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.addSubview(row)
        view.addSubview(bottomBar)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -12),
            row.centerYAnchor.constraint(equalTo: bottomBar.centerYAnchor),
        ])

        observation = observeIOS { [weak self] in self?.render() }
        show(index, restart: true)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hasAppeared = true
        updateRunning()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        hasAppeared = false
        updateRunning()
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        card.frame = cardFrame()
        media.frame = card.bounds
        placeholder.frame = card.bounds
        chrome.frame = card.bounds
        bottomBar.frame = CGRect(x: 0, y: card.frame.maxY, width: view.bounds.width, height: Self.bottomBarHeight)
    }

    /// The story's card: under the status bar, 9:16 as far as it fits above the bottom bar.
    private func cardFrame() -> CGRect {
        let bounds = view.bounds
        let safe = view.window?.safeAreaInsets ?? navigationController?.view.window?.safeAreaInsets ?? view.safeAreaInsets
        let top = safe.top
        let available = bounds.height - top - safe.bottom - Self.bottomBarHeight
        let height = max(min(bounds.width * 16 / 9, available), 0)
        return CGRect(x: 0, y: top, width: bounds.width, height: height)
    }

    /// Board changes (approve, delete) reach the open story.
    private func render() {
        let current = ids.indices.contains(index) ? ids[index] : nil
        pruneIds()
        var hasher = Hasher()
        for card in cards { hasher.combine(card) }
        let next = hasher.finalize()
        guard next != signature else { return }
        let first = signature == nil
        signature = next
        guard !first else { return }
        if ids.isEmpty { return close() }
        let newIndex = current.flatMap { ids.firstIndex(of: $0) } ?? min(index, ids.count - 1)
        show(newIndex, restart: newIndex != index || current.flatMap { ids.firstIndex(of: $0) } == nil)
    }

    // MARK: Showing a story

    private func show(_ newIndex: Int, restart: Bool) {
        guard ids.indices.contains(newIndex) else { return }
        index = newIndex
        if restart { elapsed = 0 }
        if segments.arrangedSubviews.count != ids.count {
            segments.removeAllArranged()
            for _ in ids { segments.addArrangedSubview(StorySegmentView()) }
        }
        guard let card = currentCard else { return }
        let brand = PostPresentation.brandName(app)
        media.store = app.images
        let asset = card.needsImage ? nil : card.renderedAssetIds.first
        media.assetId = asset
        if media.image == nil, let asset { media.image = app.images.anyCached(asset) }
        media.isHidden = asset == nil
        placeholder.isHidden = asset != nil
        if asset == nil { placeholder.configure(card) }
        avatar.set(name: brand)
        nameLabel.text = brand
        ageLabel.text = PostPresentation.age(card)
        menuButton.menu = PostActions(app: app, host: self).menu(for: card, source: menuButton)
        let approved = card.content.status.hasApproval
        var approve = approveButton.configuration
        approve?.image = UIImage(systemName: approved ? "checkmark.circle.fill" : "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))
        approve?.baseForegroundColor = approved ? IOSTheme.accent : .white
        approveButton.configuration = approve
        approveButton.isUserInteractionEnabled = PostActions.canApprove(card)
        approveButton.accessibilityLabel = approved ? "Onaylandı" : "Onayla"
        shareButton.configuration?.baseForegroundColor = .white
        shareButton.isEnabled = !card.renderedAssetIds.isEmpty
        view.accessibilityLabel = "\(card.title), \(PostPresentation.statusLine(card))"
        updateSegments()
    }

    private func next() {
        if index + 1 < ids.count {
            show(index + 1, restart: true)
        } else {
            close()
        }
    }

    private func previous() {
        show(max(index - 1, 0), restart: true)
    }

    private func updateSegments() {
        let progress = min(elapsed / Self.storyDuration, 1)
        for (position, view) in segments.arrangedSubviews.enumerated() {
            (view as? StorySegmentView)?.progress = position < index ? 1 : (position == index ? progress : 0)
        }
    }

    // MARK: The clock

    /// Runs only while the story is open and nothing covers it (a hold, the menu; a sheet is
    /// waited for in `tick`).
    private func updateRunning() {
        let running = hasAppeared && !holding && !menuOpen && !mediaHidden && !isClosing
        if running, displayLink == nil {
            lastTick = nil
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            displayLink = link
        } else if !running {
            displayLink?.invalidate()
            displayLink = nil
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        // A sheet came up (schedule, share): wait for it.
        if presentedViewController != nil {
            lastTick = nil
            return
        }
        if let lastTick { elapsed += link.timestamp - lastTick }
        lastTick = link.timestamp
        if elapsed >= Self.storyDuration {
            next()
        } else {
            updateSegments()
        }
    }

    // MARK: Gestures

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        guard !isOpening else { return }
        let x = tap.location(in: card).x
        if x < card.bounds.width / 3 { previous() } else { next() }
    }

    @objc private func held(_ hold: UILongPressGestureRecognizer) {
        switch hold.state {
        case .began:
            holding = true
            UIView.animate(withDuration: 0.2) { self.chrome.alpha = 0; self.bottomBar.alpha = 0 }
        case .ended, .cancelled, .failed:
            holding = false
            UIView.animate(withDuration: 0.2) { self.chrome.alpha = 1; self.bottomBar.alpha = 1 }
        default:
            break
        }
        updateRunning()
    }

    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        if pan.state == .began {
            displayLink?.invalidate()
            displayLink = nil
        }
        handlePull(pan)
        if pan.state == .ended || pan.state == .cancelled || pan.state == .failed {
            // Sprung back: the clock goes on.
            DispatchQueue.main.async { [weak self] in self?.updateRunning() }
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === pullPan {
            let velocity = pullPan.velocity(in: view)
            return velocity.y > 0 && abs(velocity.y) > abs(velocity.x) * 1.5
        }
        // Taps on the header's buttons are theirs.
        let point = gestureRecognizer.location(in: chrome)
        for button in [menuButton, closeButton] where button.bounds.insetBy(dx: -8, dy: -8).contains(button.convert(point, from: chrome)) {
            return false
        }
        return true
    }

    // MARK: The picture's flight

    override var shownImage: UIImage? {
        if let image = media.image { return image }
        guard let first = currentCard?.renderedAssetIds.first else { return nil }
        return app.images.anyCached(first)
    }

    override var restingRadius: CGFloat { Self.cardRadius }

    override func currentSource() -> UIView? {
        tile(for: ids.indices.contains(index) ? ids[index] : nil)
    }

    override func pictureRect(in container: UIView) -> CGRect {
        view.convert(cardFrame(), to: container)
    }

    override func setContentHidden(_ hidden: Bool) {
        mediaHidden = hidden
        media.alpha = hidden ? 0 : 1
        placeholder.alpha = hidden ? 0 : 1
        card.backgroundColor = hidden ? .clear : UIColor(white: 0.08, alpha: 1)
        view.backgroundColor = hidden ? .clear : .black
        updateRunning()
    }

    override func setZoomProgress(_ progress: CGFloat) {
        chrome.alpha = holding ? 0 : progress
        bottomBar.alpha = holding ? 0 : progress
    }
}

/// One story's bar at the top: a faint track that fills while the story runs.
final class StorySegmentView: UIView {
    private let fill = UIView()

    var progress: Double = 0 {
        didSet { setNeedsLayout() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor.white.withAlphaComponent(0.35)
        layer.cornerRadius = 1.25
        clipsToBounds = true
        fill.backgroundColor = .white
        addSubview(fill)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        fill.frame = CGRect(x: 0, y: 0, width: bounds.width * CGFloat(min(max(progress, 0), 1)), height: bounds.height)
    }
}

/// The story's "…": tells when its menu is open (the story waits meanwhile).
final class StoryMenuButton: UIButton {
    var onMenu: ((Bool) -> Void)?

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        onMenu?(true)
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        onMenu?(false)
    }
}
