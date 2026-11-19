import StudioKit
import UIKit

/// What every Postlar screen a tile opens into (the feed, Reels, stories) shares: the zoom flight
/// out of the tile and back (`PhotoZoomTransition`), turned around by back or a pull while it is
/// still opening, and the pull-down close that follows the finger. Subclasses say where their
/// picture is and hide their copy of it during the flight.
class PostZoomPage: UIViewController, ZoomTransitionDestination {
    unowned let app: IOSAppModel
    /// The tab's posts in grid order (fixed when opened; deleted ones drop out).
    private(set) var ids: [EntityID]
    /// The grid tile of a post (the picture flies out of and back into it).
    let sourceFor: (EntityID) -> UIView?

    /// The opening is still running (a pop is not accepted yet).
    private(set) var isOpening = false
    /// Back or a pull came during the opening: close as soon as it ends.
    private var closeWhenOpen = false
    /// The push still running (it can be turned around).
    private var opening: PhotoZoomTransition?
    /// The pull-down close in progress (its transition follows the finger).
    private var interactivePop: PhotoZoomTransition?
    /// Where the finger was when the pull started (a pull begun during the opening).
    private var pullOrigin: CGPoint = .zero
    /// The edge-swipe back gestures, off while a full-screen page is shown (it closes with its
    /// own buttons or a pull) and restored when it leaves.
    private var pausedPopGestures: [UIGestureRecognizer] = []
    private lazy var backCatcher: UIView = {
        let catcher = UIView()
        catcher.backgroundColor = .clear
        catcher.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(backCaught)))
        return catcher
    }()

    init(app: IOSAppModel, ids: [EntityID], sourceFor: @escaping (EntityID) -> UIView?) {
        self.app = app
        self.ids = ids
        self.sourceFor = sourceFor
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The posts still on the board, in order.
    var cards: [PostCard] { ids.compactMap { app.posts.card($0) } }

    /// Drops posts that left the board (deleted here or on the Mac).
    func pruneIds() {
        ids = ids.filter { app.posts.card($0) != nil }
    }

    /// Full-screen pages (Reels, stories) take the edge swipe away; the feed keeps it.
    var keepsSystemSwipeBack: Bool { true }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        openingDidFinish()
        guard !keepsSystemSwipeBack, let navigation = navigationController, pausedPopGestures.isEmpty else { return }
        for gesture in [navigation.interactivePopGestureRecognizer, navigation.interactiveContentPopGestureRecognizer].compactMap({ $0 }) where gesture.isEnabled {
            gesture.isEnabled = false
            pausedPopGestures.append(gesture)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        for gesture in pausedPopGestures { gesture.isEnabled = true }
        pausedPopGestures = []
    }

    /// Closes the page; still flying in, the opening turns around from where it is.
    func close() {
        if isOpening {
            if let opening { opening.reverseOpening() } else { closeWhenOpen = true }
            return
        }
        navigationController?.popViewController(animated: true)
    }

    @objc private func backCaught() { close() }

    // MARK: ZoomTransitionDestination (subclasses override the picture's side)

    var shownImage: UIImage? { nil }
    var restingRadius: CGFloat { 0 }
    func currentSource() -> UIView? { nil }
    func pictureRect(in container: UIView) -> CGRect { container.bounds }
    func setContentHidden(_ hidden: Bool) {}
    func setZoomProgress(_ progress: CGFloat) {}
    var zoomTitlePill: GlassTitlePill? { nil }
    var hidesViewWhileClosing: Bool { false }

    /// The grid tile of `id`, when it is on screen.
    func tile(for id: EntityID?) -> UIView? {
        guard let id, let source = sourceFor(id), source.window != nil else { return nil }
        return source
    }

    func makeTransition(_ operation: PhotoZoomTransition.Operation) -> PhotoZoomTransition {
        if operation == .pop, let interactivePop { return interactivePop }
        let transition = PhotoZoomTransition(operation: operation, viewer: self)
        if operation == .push {
            isOpening = true
            opening = transition
        }
        return transition
    }

    /// While opening, the navigation bar does not pass taps to its back button; a clear catcher
    /// over it takes them instead (pages without a bar have their own buttons).
    func catchBackTapsWhileOpening(_ on: Bool) {
        backCatcher.removeFromSuperview()
        guard on, let navigation = navigationController, !navigation.isNavigationBarHidden else { return }
        let bar = navigation.navigationBar
        let barFrame = bar.convert(bar.bounds, to: navigation.view)
        backCatcher.frame = CGRect(x: 0, y: barFrame.minY, width: 80, height: barFrame.height)
        navigation.view.addSubview(backCatcher)
    }

    func transitionEnded() {
        interactivePop = nil
        opening = nil
    }

    /// The opening is over for the navigation controller too: a pull that started meanwhile takes
    /// over now, a back or a pull let go meanwhile closes.
    private func openingDidFinish() {
        catchBackTapsWhileOpening(false)
        guard isOpening else { return }
        isOpening = false
        if let pan = activePull, pan.state == .began || pan.state == .changed {
            startPull(at: pan.translation(in: view))
        } else if closeWhenOpen {
            closeWhenOpen = false
            // Next turn: viewDidAppear runs inside the navigation controller's completion, where
            // a pop is still ignored.
            DispatchQueue.main.async { [weak self] in self?.close() }
        }
    }

    // MARK: Pull down to close

    private weak var activePull: UIPanGestureRecognizer?

    private func startPull(at origin: CGPoint) {
        let transition = PhotoZoomTransition(operation: .pop, viewer: self, interactive: true)
        interactivePop = transition
        pullOrigin = origin
        if navigationController?.popViewController(animated: true) == nil {
            interactivePop = nil
        }
    }

    /// Drives the close from a downward pan (the subclass decides when such a pan may begin).
    func handlePull(_ pan: UIPanGestureRecognizer) {
        activePull = pan
        let raw = pan.translation(in: view)
        let translation = CGPoint(x: raw.x - pullOrigin.x, y: raw.y - pullOrigin.y)
        switch pan.state {
        case .began:
            pullOrigin = .zero
            if isOpening { opening?.reverseOpening() } else { startPull(at: .zero) }
        case .changed:
            interactivePop?.update(translation: translation)
        case .ended:
            if let interactivePop {
                interactivePop.end(translation: translation, velocity: pan.velocity(in: view))
            } else if isOpening, raw.y > 60 || pan.velocity(in: view).y > 500 {
                closeWhenOpen = true
            }
        case .cancelled, .failed:
            interactivePop?.end(translation: .zero, velocity: .zero)
        default:
            break
        }
    }

    /// The close is under way (the pull or the flight home): pages stop their timers and videos.
    var isClosing: Bool { interactivePop != nil || isMovingFromParent }
}

// MARK: - Actions

/// A post's actions on the feed, Reels and stories (the grid's tile menu does the same): edit,
/// approve (asking first when its checks hold it back), schedule, share, copy, duplicate, delete.
@MainActor
struct PostActions {
    unowned let app: IOSAppModel
    weak var host: UIViewController?

    private var model: IOSPostsModel { app.posts }

    static func canApprove(_ card: PostCard) -> Bool { card.state == .ready && card.approvableHash != nil }
    static func canSchedule(_ card: PostCard) -> Bool {
        !card.content.status.isLocked && (card.content.status.isSchedulable || card.approvableHash != nil)
    }

    func edit(_ card: PostCard) {
        host?.navigationController?.pushViewController(IOSPostDetailViewController(app: app, card: card), animated: true)
    }

    func approve(_ card: PostCard) {
        guard let host else { return }
        let model = model
        Task {
            let gate = await model.approvalGates([card])[card.id] ?? .clear
            let approve: (Bool) -> Void = { acknowledging in
                Task {
                    if await model.approve(card, acknowledgingChecks: acknowledging) {
                        Haptics.success()
                    } else if let error = model.error {
                        host.presentError(error)
                    }
                }
            }
            guard let question = gate.question else { return approve(false) }
            // "Yine de onayla": the approval tells the API the user saw the checks (E7).
            host.confirm(question.title, message: "\(card.title)\n\(question.message ?? "")", action: "Yine de onayla", destructive: false) { approve(true) }
        }
    }

    /// The schedule sheet; a post not approved yet is approved there, so its checks are asked
    /// about first.
    func schedule(_ card: PostCard) {
        guard let host, Self.canSchedule(card) else { return }
        // The same session the editor uses (it approves before scheduling, as there).
        let session = app.posts.session(for: card)
        let open = { [app] in
            host.presentSheet(ScheduleSheetViewController(app: app, session: session), detents: [.large()])
        }
        if card.content.status.isSchedulable { return open() }
        Task {
            let gate = await session.approvalGate()
            guard let question = gate.question else { return open() }
            // "Yine de onayla": the approval that follows tells the API so (E7).
            host.confirm(question.title, message: question.message, action: "Yine de onayla", destructive: false) {
                session.acknowledgeChecks()
                open()
            }
        }
    }

    func share(_ card: PostCard, source: UIView?) {
        guard let host else { return }
        let images = app.images
        Task {
            var pictures: [UIImage] = []
            for id in card.renderedAssetIds {
                if let data = await images.data(id), let image = UIImage(data: data) { pictures.append(image) }
            }
            guard !pictures.isEmpty else { return host.presentError("Görsel indirilemedi.") }
            FileSharing.share(pictures + [card.content.caption], from: host, source: source)
        }
    }

    /// The "…" menu: everything, grouped like the grid's tile menu.
    func menu(for card: PostCard, source: UIView?) -> UIMenu {
        var primary: [UIMenuElement] = [UIAction(title: "Düzenle", image: UIImage(systemName: "pencil")) { _ in edit(card) }]
        if Self.canApprove(card) {
            primary.append(UIAction(title: "Onayla", image: UIImage(systemName: "checkmark.circle")) { _ in approve(card) })
        }
        primary.append(UIAction(title: card.schedule != nil ? "Zamanı değiştir" : "Zamanla", image: UIImage(systemName: "calendar.badge.clock"),
                                attributes: Self.canSchedule(card) ? [] : .disabled) { _ in schedule(card) })
        let share: [UIMenuElement] = [
            UIAction(title: "Açıklamayı kopyala", image: UIImage(systemName: "doc.on.doc")) { [weak host] _ in
                UIPasteboard.general.string = card.content.caption
                Toast.show("Açıklama kopyalandı", in: host?.view)
            },
            UIAction(title: "Paylaş", image: UIImage(systemName: "square.and.arrow.up"), attributes: card.renderedAssetIds.isEmpty ? .disabled : []) { _ in
                self.share(card, source: source)
            },
        ]
        let model = model
        let manage: [UIMenuElement] = [
            UIAction(title: "Çoğalt", image: UIImage(systemName: "plus.square.on.square")) { [weak host] _ in
                Task {
                    if let copy = await model.duplicate(card) { Toast.show("“\(copy.title)” oluşturuldu", in: host?.view) } else if let error = model.error { host?.presentError(error) }
                }
            },
            UIAction(title: "Sil…", image: UIImage(systemName: "trash"), attributes: IOSPostsModel.deletionBlocker(card) == nil ? .destructive : [.destructive, .disabled]) { [weak host] _ in
                host?.confirm("“\(card.title)” silinsin mi?", message: IOSPostsModel.deleteMessage, action: "Sil") {
                    Task {
                        if await model.delete(card) {
                            Haptics.success()
                            IOSPostsModel.showUndo(for: card, model: model, in: host?.view)
                        } else if let error = model.error { host?.presentError(error) }
                    }
                }
            },
        ]
        return UIMenu(children: [
            UIMenu(options: .displayInline, children: primary),
            UIMenu(options: .displayInline, children: share),
            UIMenu(options: .displayInline, children: manage),
        ])
    }
}

// MARK: - Small pieces

@MainActor
enum PostPresentation {
    /// "Onay bekliyor · 4 gün önce": where the post stands and when it last changed (or, when it
    /// is scheduled, when it goes out).
    static func statusLine(_ card: PostCard, now: Date = Date()) -> String {
        let state = card.state == .ready ? "Onay bekliyor" : card.state.label
        return "\(state) · \(relative(card, now: now))"
    }

    static func relative(_ card: PostCard, now: Date = Date()) -> String {
        let date = card.schedule?.scheduledAt ?? card.content.updatedAt
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// Short age for the story header ("4 g", "3 sa"), like Instagram.
    static func age(_ card: PostCard, now: Date = Date()) -> String {
        let date = card.schedule?.scheduledAt ?? card.content.updatedAt
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// Width ÷ height of the post's first slide (nil: unknown).
    static func aspect(_ card: PostCard) -> CGFloat? {
        guard let slide = card.version?.slides.first, slide.width > 0, slide.height > 0 else { return nil }
        return CGFloat(slide.width) / CGFloat(slide.height)
    }

    /// The brand's display name.
    static func brandName(_ app: IOSAppModel) -> String { app.currentBrand?.name ?? "Marka" }
}

/// The brand's round avatar (its initial on the fill, as in the profile header), small.
final class PostAvatarView: UIView {
    private let label = UILabel()
    private let side: CGFloat

    init(side: CGFloat = 32, ring: Bool = false) {
        self.side = side
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = .systemFont(ofSize: side * 0.42, weight: .bold)
        label.textAlignment = .center
        label.textColor = IOSTheme.textPrimary
        label.backgroundColor = IOSTheme.fill
        label.layer.cornerRadius = side / 2
        label.clipsToBounds = true
        addSubview(label)
        label.pin(to: self)
        layer.cornerRadius = side / 2
        layer.borderWidth = ring ? 1.5 : 0.5
        layer.borderColor = (ring ? IOSTheme.accent : IOSTheme.border).cgColor
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: side),
            heightAnchor.constraint(equalToConstant: side),
        ])
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func set(name: String) {
        label.text = String(name.prefix(1)).uppercased(with: TurkishFormat.locale)
    }
}

/// The picture of a post with none yet: its title on its tone, as on the grid.
final class PostPlaceholderView: UIView {
    private let label = UILabel.studio("", size: 22, weight: .heavy, lines: 0, style: .title2)

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(label)
        label.pin(to: self, insets: UIEdgeInsets(top: 24, left: 20, bottom: 24, right: 20))
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ card: PostCard) {
        label.text = TurkishFormat.upper(card.title)
        switch card.placeholderTone {
        case .light: backgroundColor = IOSTheme.postLight
        case .dark: backgroundColor = IOSTheme.postDark
        case .muted: backgroundColor = IOSTheme.postMuted
        }
        label.textColor = card.placeholderTone == .dark ? .white : (card.placeholderTone == .light ? .black : IOSTheme.textPrimary)
    }
}
