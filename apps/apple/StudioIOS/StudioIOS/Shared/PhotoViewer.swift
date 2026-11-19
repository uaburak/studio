import AVFoundation
import StudioKit
import UIKit

/// One picture (or video) of a viewer group.
struct PhotoViewerItem {
    var assetId: EntityID
    var title: String
    /// Second line of the title pill (a date, a file name).
    var subtitle: String?
    var aspect: CGFloat?
    /// A video: its page shows the poster frame, then plays inline with the playback capsule.
    var isVideo = false
}

extension PhotoViewerItem {
    /// When a picture was added, under its name: "Bugün 14:50", "Dün 09:12", "19 Kas 2026 14:50".
    static func addedText(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let locale = Locale(identifier: "tr_TR")
        let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(locale))
        if calendar.isDateInToday(date) { return "Bugün \(time)" }
        if calendar.isDateInYesterday(date) { return "Dün \(time)" }
        let day = date.formatted(.dateTime.day().month(.abbreviated).year().locale(locale))
        return "\(day) \(time)"
    }
}

/// One round button of the viewer's bottom toolbar.
struct PhotoViewerAction {
    var label: String
    var symbol: String
    var handler: @MainActor (PhotoViewerViewController, PhotoViewerItem) -> Void
}

/// The buttons the toolbar shows for one picture: the share button is always at the left.
struct PhotoViewerBar {
    /// Only in the "…" menu at the top right.
    var menu: [PhotoViewerAction] = []
    var middle: [PhotoViewerAction] = []
    var trailing: PhotoViewerAction?
}

/// Full-screen picture viewer used everywhere a picture opens, like Photos: the picture zooms out
/// of its thumbnail (iOS zoom transition), swipe pages through the group, a strip of the group's
/// pictures sits above the toolbar (share at the left, the picture's own action at the right),
/// pinch / double-tap zooms, a drag down closes it, a tap hides the controls. A video opens the
/// same way on its poster frame and plays in place, with Photos' playback capsule above the strip.
final class PhotoViewerViewController: UIViewController, UICollectionViewDelegate, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, UIGestureRecognizerDelegate {
    let images: IOSImageStore
    private(set) var items: [PhotoViewerItem]
    private(set) var index: Int
    private let sourceFor: (Int) -> UIView?
    private let actionsFor: (PhotoViewerItem) -> PhotoViewerBar

    private let pagerLayout = UICollectionViewFlowLayout()
    private lazy var pager = UICollectionView(frame: .zero, collectionViewLayout: pagerLayout)
    private let stripLayout = UICollectionViewFlowLayout()
    private lazy var strip = UICollectionView(frame: .zero, collectionViewLayout: stripLayout)
    /// The name (and when it was added) in a glass pill in the navigation bar.
    let titlePill = GlassTitlePill()
    /// Holds the strip between the toolbar buttons; its mask fades the strip's two ends.
    private let stripHolder = FadingEdgesView()
    private var stripWidth: NSLayoutConstraint?
    // The bars are the navigation controller's own (like OXTV's detail screen): they stay where
    // they are while the picture zooms in and out, only the picture moves.
    private lazy var moreItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: nil)
    private lazy var shareItem = UIBarButtonItem(image: UIImage(systemName: "square.and.arrow.up"), primaryAction: UIAction { [weak self] _ in self?.share() })
    private lazy var trailingItem = UIBarButtonItem(image: nil, primaryAction: UIAction { [weak self] _ in
        guard let self, let action = self.trailingAction, self.items.indices.contains(self.index) else { return }
        action.handler(self, self.items[self.index])
    })
    private lazy var stripItem: UIBarButtonItem = {
        let item = UIBarButtonItem(customView: stripHolder)
        item.hidesSharedBackground = true
        return item
    }()
    private var trailingAction: PhotoViewerAction?
    private var hasTrailing: Bool?
    /// The edge-swipe back gestures, switched off while the viewer is shown (it closes only with a
    /// downward drag) and restored when it leaves.
    private var pausedPopGestures: [UIGestureRecognizer] = []
    /// The pull-down close in progress (its transition follows the finger).
    private var interactivePop: PhotoZoomTransition?
    private lazy var backCatcher: UIView = {
        let catcher = UIView()
        catcher.backgroundColor = .clear
        catcher.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(backCaught)))
        return catcher
    }()

    @objc private func backCaught() { close() }

    /// The opening is still running (a pop is not accepted yet).
    private var isOpening = false
    /// Back or a pull came during the opening: close as soon as it ends.
    private var closeWhenOpen = false
    /// The push still running (it can be turned around).
    private var opening: PhotoZoomTransition?
    /// Where the finger was when the pull-down close started (a pull begun during the opening).
    private var pullOrigin: CGPoint = .zero
    private lazy var dismissPan: UIPanGestureRecognizer = {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pulled(_:)))
        pan.delegate = self
        return pan
    }()
    private var chromeHidden = false
    /// Zoomed in: the controls step aside (they come back at rest).
    private var zoomHidden = false
    private let singleTap = UITapGestureRecognizer()
    private var laidOutWidth: CGFloat = 0

    /// The video playing on the shown page (nil on a picture).
    private var playback: VideoPlayback?
    /// Sound off, kept from one video to the next (as in Photos).
    private var muted = false
    /// Play / pause, scrubber and sound above the strip; only on a video page.
    private let videoControls = VideoControlsView()
    private var videoControlsBottom: NSLayoutConstraint?
    /// The scrubber took the video while it was playing (it plays on when let go).
    private var playingBeforeScrub = false
    /// It was playing when the viewer went out of sight (it plays on when back).
    private var playingBeforeDisappear = true
    /// Videos whose poster frame has been asked for.
    private var postersAsked: Set<EntityID> = []
    /// Where the strip stands, in pictures (2.4 = 40 % from the third to the fourth). While a
    /// page is dragged it follows the finger, so the squares grow and shrink with it.
    private var stripPosition: CGFloat = 0

    /// Only here: pure black in dark mode, pure white in light mode (like Photos).
    private static let backdrop = UIColor { $0.userInterfaceStyle == .dark ? .black : .white }
    private static let activeWidth: CGFloat = 34
    private static let restWidth: CGFloat = 22
    private static let stripHeight: CGFloat = 34
    /// Corner radius of the picture in the viewer: none (square corners, like the picture itself).
    private static let pictureRadius: CGFloat = 0

    /// `sourceFor(index)`: the thumbnail picture `index` grows out of / returns to.
    init(images: IOSImageStore, items: [PhotoViewerItem], index: Int, sourceFor: @escaping (Int) -> UIView?, actionsFor: @escaping (PhotoViewerItem) -> PhotoViewerBar = { _ in PhotoViewerBar() }) {
        self.images = images
        self.items = items
        self.index = min(max(index, 0), max(items.count - 1, 0))
        self.stripPosition = CGFloat(self.index)
        self.sourceFor = sourceFor
        self.actionsFor = actionsFor
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var prefersStatusBarHidden: Bool { chromeHidden || zoomHidden }

    /// Renames the shown picture (the title above it).
    func updateTitle(_ title: String) {
        guard items.indices.contains(index) else { return }
        items[index].title = title
        refreshChrome()
    }

    /// Shows the viewer: pushed on the presenter's navigation stack (so the system bars stay put
    /// during the zoom, as in OXTV), or presented in its own navigation controller.
    func open(from presenter: UIViewController) {
        if let navigation = presenter.navigationController {
            if navigation.delegate == nil { navigation.delegate = PhotoViewerNavigationDelegate.shared }
            navigation.pushViewController(self, animated: true)
        } else {
            let navigation = UINavigationController(rootViewController: self)
            navigation.modalPresentationStyle = .fullScreen
            presenter.present(navigation, animated: true)
        }
    }

    /// Closes the viewer the way it was opened.
    func close() {
        // Still flying in: the navigation controller would ignore a pop now, so it waits for the
        // end of the opening (going straight back out must work).
        if isOpening {
            // Turn the opening around right away (no waiting for it to end).
            if let opening { opening.reverseOpening() } else { closeWhenOpen = true }
            return
        }
        if let navigation = navigationController, navigation.viewControllers.first !== self {
            navigation.popViewController(animated: true)
        } else {
            dismiss(animated: true)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.backdrop
        view.addGestureRecognizer(dismissPan)
        // A video's picture is its poster frame, made here (never the Mac's thumbnail route).
        for item in items where item.isVideo { images.expectPhoneMade(item.assetId) }

        pagerLayout.scrollDirection = .horizontal
        pagerLayout.minimumLineSpacing = 0
        pagerLayout.minimumInteritemSpacing = 0
        pager.translatesAutoresizingMaskIntoConstraints = false
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.backgroundColor = .clear
        pager.contentInsetAdjustmentBehavior = .never
        pager.dataSource = self
        pager.delegate = self
        pager.register(PhotoPageCell.self, forCellWithReuseIdentifier: "page")
        view.addSubview(pager)
        pager.pin(to: view)

        singleTap.addTarget(self, action: #selector(toggleChrome))
        pager.addGestureRecognizer(singleTap)

        // Top bar: back at the left, the picture's name in a glass pill, "…" at the right.
        navigationItem.largeTitleDisplayMode = .never
        // The name pill is the bar's own title view, like Medya's segmented control: the
        // navigation bar carries both through the push and pop itself, as it does the corner
        // buttons (nothing is moved or faded by hand).
        navigationItem.titleView = titlePill
        let back = UIBarButtonItem(image: UIImage(systemName: "chevron.left"), primaryAction: UIAction { [weak self] _ in self?.close() })
        back.accessibilityLabel = "Kapat"
        navigationItem.leftBarButtonItem = back
        moreItem.accessibilityLabel = "Diğer"
        navigationItem.rightBarButtonItem = moreItem
        // The picture is not softened under the bars.
        pager.topEdgeEffect.isHidden = true
        pager.bottomEdgeEffect.isHidden = true

        // Toolbar: share at the left, the main action at the right, and the group's pictures
        // between them (their ends fade out).
        stripLayout.scrollDirection = .horizontal
        stripLayout.minimumLineSpacing = 2
        strip.translatesAutoresizingMaskIntoConstraints = false
        strip.backgroundColor = .clear
        strip.showsHorizontalScrollIndicator = false
        strip.dataSource = self
        strip.delegate = self
        strip.register(PhotoStripCell.self, forCellWithReuseIdentifier: "strip")
        strip.isHidden = items.count < 2
        stripHolder.translatesAutoresizingMaskIntoConstraints = false
        stripHolder.addSubview(strip)
        shareItem.accessibilityLabel = "Paylaş"
        let width = stripHolder.widthAnchor.constraint(equalToConstant: Self.stripWidth(for: view.bounds.width))
        stripWidth = width
        NSLayoutConstraint.activate([
            width,
            stripHolder.heightAnchor.constraint(equalToConstant: Self.stripHeight),
            strip.leadingAnchor.constraint(equalTo: stripHolder.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: stripHolder.trailingAnchor),
            strip.topAnchor.constraint(equalTo: stripHolder.topAnchor),
            strip.bottomAnchor.constraint(equalTo: stripHolder.bottomAnchor),
        ])
        setUpVideoControls()
        refreshChrome()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(false, animated: animated)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        openingDidFinish()
        updatePlayback(resume: playingBeforeDisappear)

        // Closing is only the downward drag: no edge or full-width swipe back.
        guard let navigation = navigationController, pausedPopGestures.isEmpty else { return }
        for gesture in [navigation.interactivePopGestureRecognizer, navigation.interactiveContentPopGestureRecognizer].compactMap({ $0 }) where gesture.isEnabled {
            gesture.isEnabled = false
            pausedPopGestures.append(gesture)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)

        playingBeforeDisappear = playback?.isPlaying ?? false
        playback?.pause()
        for gesture in pausedPopGestures { gesture.isEnabled = true }
        pausedPopGestures = []
        if chromeHidden { navigationController?.setNavigationBarHidden(false, animated: animated) }
        // The page underneath may have its own toolbar (Medya); otherwise the toolbar goes.
        if navigationController?.topViewController?.toolbarItems?.isEmpty ?? true {
            navigationController?.setToolbarHidden(true, animated: animated)
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Gone for good (not just covered): the video and its stream go too.
        if isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true {
            stopPlayback()
        }
    }

    /// The toolbar holds share, the strip and one button: the strip takes what is left with room
    /// to spare (wider, and the toolbar moved it into its "…" overflow menu).
    private static func stripWidth(for width: CGFloat) -> CGFloat {
        max(60, width - 200)
    }

    // MARK: Transition

    /// The picture's corner radius at rest (square while the controls are hidden).
    var restingRadius: CGFloat { chromeHidden ? 0 : Self.pictureRadius }

    /// The shown picture as loaded (the flying copy in the transition).
    var shownImage: UIImage? {
        // A video flies home as the frame on screen.
        if let playback, items.indices.contains(index), playback.assetId == items[index].assetId, let frame = playback.currentFrame() {
            return frame
        }
        if let cell = pager.cellForItem(at: IndexPath(item: index, section: 0)) as? PhotoPageCell, let image = cell.image {
            return image
        }
        guard items.indices.contains(index) else { return nil }
        return images.anyCached(items[index].assetId)
    }

    /// The thumbnail the shown picture flies to (nil: gone or scrolled away, it fades instead).
    func currentSource() -> UIView? {
        guard let source = sourceFor(index), source.window != nil else { return nil }
        return source
    }

    func pictureRect(in container: UIView) -> CGRect {
        view.convert(pictureRect(), to: container)
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

    /// While opening, the navigation bar does not pass taps to its back button; a clear catcher over
    /// the button takes them instead (the close then runs as soon as the opening has finished).
    func catchBackTapsWhileOpening(_ on: Bool) {
        backCatcher.removeFromSuperview()
        guard on, let navigation = navigationController else { return }
        let bar = navigation.navigationBar
        let barFrame = bar.convert(bar.bounds, to: navigation.view)
        backCatcher.frame = CGRect(x: 0, y: barFrame.minY, width: 80, height: barFrame.height)
        navigation.view.addSubview(backCatcher)
    }

    /// The picture and the backdrop out of sight (the transition draws its own), the view still
    /// taking touches.
    func setContentHidden(_ hidden: Bool) {
        pager.alpha = hidden ? 0 : 1
        if hidden {
            videoControls.alpha = 0
        } else {
            UIView.animate(withDuration: 0.2) { self.videoControls.alpha = self.chromeHidden ? 0 : 1 }
        }
        view.backgroundColor = hidden ? .clear : (chromeHidden || zoomHidden ? .black : Self.backdrop)
    }

    func transitionEnded() {
        interactivePop = nil
        opening = nil
    }

    /// The opening is over for the navigation controller too (a pop is accepted only from here;
    /// one asked for at the end of the flight was ignored). A pull that started during the opening
    /// takes over now; a back or a pull let go meanwhile closes.
    private func openingDidFinish() {
        catchBackTapsWhileOpening(false)
        guard isOpening else { return }
        isOpening = false
        if dismissPan.state == .began || dismissPan.state == .changed {
            startPull(at: dismissPan.translation(in: view))
        } else if closeWhenOpen {
            closeWhenOpen = false
            // Next turn: viewDidAppear runs inside the navigation controller's own completion,
            // where a pop is still ignored.
            DispatchQueue.main.async { [weak self] in self?.close() }
        }
    }

    /// Starts the pull-down close; `origin` is how far the finger has already moved (the picture
    /// follows from there, no jump).
    private func startPull(at origin: CGPoint) {
        let transition = PhotoZoomTransition(operation: .pop, viewer: self, interactive: true)
        interactivePop = transition
        pullOrigin = origin
        if navigationController?.popViewController(animated: true) == nil {
            interactivePop = nil
        }
    }

    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        let raw = pan.translation(in: view)
        let translation = CGPoint(x: raw.x - pullOrigin.x, y: raw.y - pullOrigin.y)
        switch pan.state {
        case .began:
            pullOrigin = .zero
            if isOpening {
                // Pulled while still flying in: it goes back at once.
                opening?.reverseOpening()
            } else {
                startPull(at: .zero)
            }
        case .changed:
            interactivePop?.update(translation: translation)
        case .ended:
            if let interactivePop {
                interactivePop.end(translation: translation, velocity: pan.velocity(in: view))
            } else if isOpening, raw.y > 60 || pan.velocity(in: view).y > 500 {
                // Pulled and let go while still opening: close once it has opened.
                closeWhenOpen = true
            }
        case .cancelled, .failed:
            interactivePop?.end(translation: .zero, velocity: .zero)
        default:
            break
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === dismissPan else { return true }
        // Only a downward, mostly vertical pull closes it: sideways swipes page instead.
        let velocity = dismissPan.velocity(in: view)
        guard velocity.y > 0, abs(velocity.y) > abs(velocity.x) * 1.5, navigationController != nil else { return false }
        guard let cell = pager.cellForItem(at: IndexPath(item: index, section: 0)) as? PhotoPageCell else { return true }
        return cell.zoom.zoomScale <= 1.01
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Dragging the scrubber is not a pull to close.
        guard gestureRecognizer === dismissPan, let touched = touch.view else { return true }
        return !touched.isDescendant(of: videoControls)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        gestureRecognizer === dismissPan
    }

    /// Where the shown picture is on screen (the transition flies the thumbnail to and from it).
    private func pictureRect() -> CGRect {
        if let cell = pager.cellForItem(at: IndexPath(item: index, section: 0)) as? PhotoPageCell,
           cell.window != nil, cell.zoom.content.bounds.width > 0 {
            return cell.zoom.content.convert(cell.zoom.content.bounds, to: view)
        }
        // Not laid out yet (the opening): the same fit the page will use.
        let bounds = view.window?.bounds ?? navigationController?.view.bounds ?? view.bounds
        let area = bounds.inset(by: pageInsets())
        guard items.indices.contains(index), area.width > 0, area.height > 0 else { return bounds }
        var aspect = Self.aspect(of: items[index], images: images) ?? 0
        if aspect <= 0 { aspect = 4.0 / 5.0 }
        let width = min(area.width, area.height * aspect)
        let height = width / aspect
        return CGRect(x: area.midX - width / 2, y: area.midY - height / 2, width: width, height: height)
    }

    /// The shape a page fits: a video's own poster frame first (it is the right way up, the
    /// stored size may not be), else the given aspect, else the cached picture's.
    fileprivate static func aspect(of item: PhotoViewerItem, images: IOSImageStore) -> CGFloat? {
        let cached = images.anyCached(item.assetId)
        let cachedAspect = cached.flatMap { $0.size.height > 0 ? $0.size.width / $0.size.height : nil }
        if item.isVideo, let cachedAspect { return cachedAspect }
        return item.aspect ?? cachedAspect
    }

    /// The screen's safe area, read once and then kept. The zoom transition changes the view's
    /// safe area while it opens and closes; following it re-laid the picture out in the middle of
    /// the close and made it hitch (OXTV's detail screen lays nothing out during the transition).
    private var fixedSafeArea: UIEdgeInsets?

    private var screenSafeArea: UIEdgeInsets {
        if let fixedSafeArea { return fixedSafeArea }
        let insets = view.window?.safeAreaInsets ?? navigationController?.view.window?.safeAreaInsets ?? presentingViewController?.view.window?.safeAreaInsets ?? view.safeAreaInsets
        if insets.top > 0 { fixedSafeArea = insets }
        return insets
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        // Only until the safe area is known (the first pass); never during a transition.
        guard fixedSafeArea == nil, !isBeingDismissed else { return }
        let insets = pageInsets()
        guard fixedSafeArea != nil else { return }
        for case let cell as PhotoPageCell in pager.visibleCells {
            cell.setFit(insets: insets, radius: chromeHidden ? 0 : Self.pictureRadius)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = pager.bounds.width
        guard width > 0, width != laidOutWidth else { return }
        laidOutWidth = width
        // The strip's first and last picture can sit in the middle.
        let stripWidth = Self.stripWidth(for: view.bounds.width)
        self.stripWidth?.constant = stripWidth
        videoControlsBottom?.constant = -Self.videoControlsLift(screenSafeArea)
        let side = max(0, (stripWidth - Self.activeWidth) / 2)
        stripLayout.sectionInset = UIEdgeInsets(top: 0, left: side, bottom: 0, right: side)
        pagerLayout.itemSize = pager.bounds.size
        pagerLayout.invalidateLayout()
        pager.layoutIfNeeded()
        pager.contentOffset = CGPoint(x: CGFloat(index) * width, y: 0)
        centerStrip(animated: false)
    }

    // MARK: Chrome

    private func refreshChrome() {
        guard items.indices.contains(index) else { return }
        let item = items[index]
        titlePill.set(title: item.title, subtitle: item.subtitle)

        let bar = actionsFor(item)
        let all = bar.menu + bar.middle + (bar.trailing.map { [$0] } ?? [])
        var menuItems: [UIMenuElement] = all.map { action in
            UIAction(title: action.label, image: UIImage(systemName: action.symbol)) { [weak self] _ in
                guard let self, self.items.indices.contains(self.index) else { return }
                action.handler(self, self.items[self.index])
            }
        }
        menuItems.append(UIAction(title: "Paylaş", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in self?.share() })
        moreItem.menu = UIMenu(children: menuItems)

        // The right button is the picture's main action (an empty slot keeps the strip centred).
        // Other actions live in the "…" menu.
        trailingAction = bar.trailing
        if let trailing = bar.trailing {
            trailingItem.image = UIImage(systemName: trailing.symbol)
            trailingItem.accessibilityLabel = trailing.label
        }
        if hasTrailing != (bar.trailing != nil) {
            hasTrailing = bar.trailing != nil
            // Without a main action an empty slot of the same width keeps the strip centred.
            let right: UIBarButtonItem = bar.trailing != nil ? trailingItem : .fixedSpace(44)
            setToolbarItems([shareItem, .flexibleSpace(), stripItem, .flexibleSpace(), right], animated: false)
        }
        for case let cell as PhotoStripCell in strip.visibleCells {
            if let path = strip.indexPath(for: cell) { cell.setSelected(path.item == index) }
        }
    }

    @objc private func toggleChrome() {
        chromeHidden.toggle()
        applyChrome()
    }

    private func zoomChanged(_ scale: CGFloat) {
        let hidden = scale > 1.01
        guard hidden != zoomHidden else { return }
        zoomHidden = hidden
        applyChrome()
    }

    /// Space the picture keeps clear at rest: clear of the navigation bar and the toolbar, and the
    /// same above and below so the picture stays in the exact middle of the screen (it does not
    /// move up or down when the controls hide). With the controls hidden it fills the width.
    private func pageInsets() -> UIEdgeInsets {
        if chromeHidden { return .zero }
        let safe = screenSafeArea
        let top = safe.top + 54 + 8
        let bottom = safe.bottom + 50 + 12
        let clear = max(top, bottom)
        return UIEdgeInsets(top: clear, left: 0, bottom: clear, right: 0)
    }

    private func applyChrome() {
        let hidden = chromeHidden
        // The picture grows to the screen's full width (keeping its shape) as the bars go, and
        // back between them when they return.
        let insets = pageInsets()
        let radius = hidden ? 0 : Self.pictureRadius
        navigationController?.setNavigationBarHidden(hidden, animated: true)
        navigationController?.setToolbarHidden(hidden, animated: true)
        UIView.animate(springDuration: 0.35, bounce: 0) {
            for case let cell as PhotoPageCell in self.pager.visibleCells {
                cell.setFit(insets: insets, radius: radius)
            }
        }
        UIView.animate(withDuration: 0.2) {
            // Zoomed in, only the picture strip steps aside; the other buttons stay.
            self.stripHolder.alpha = self.zoomHidden ? 0 : 1
            self.videoControls.alpha = hidden ? 0 : 1
            self.view.backgroundColor = hidden || self.zoomHidden ? .black : Self.backdrop
            self.setNeedsStatusBarAppearanceUpdate()
        }
    }

    private func centerStrip(animated: Bool) {
        guard !strip.isHidden, items.indices.contains(index) else { return }
        strip.scrollToItem(at: IndexPath(item: index, section: 0), at: .centeredHorizontally, animated: animated)
    }

    private func show(_ newIndex: Int) {
        guard newIndex != index, items.indices.contains(newIndex) else { return }
        index = newIndex
        zoomChanged(1)
        refreshChrome()
        updatePlayback()
        setStripPosition(CGFloat(newIndex), animated: true)
        centerStrip(animated: true)
        Haptics.selection()
    }

    private func share() {
        guard items.indices.contains(index) else { return }
        let assetId = items[index].assetId
        if items[index].isVideo {
            shareVideo(items[index])
            return
        }
        Task {
            guard let data = await images.data(assetId), let image = UIImage(data: data) else {
                presentError("Görsel indirilemedi.")
                return
            }
            FileSharing.share([image], from: self)
        }
    }

    // MARK: Video

    /// The capsule sits just above the toolbar (and its strip), clear of it by the same gap the
    /// toolbar keeps from the picture.
    private static func videoControlsLift(_ safe: UIEdgeInsets) -> CGFloat {
        safe.bottom + 50 + 10
    }

    private func setUpVideoControls() {
        videoControls.translatesAutoresizingMaskIntoConstraints = false
        videoControls.isHidden = true
        view.addSubview(videoControls)
        let bottom = videoControls.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -Self.videoControlsLift(screenSafeArea))
        videoControlsBottom = bottom
        NSLayoutConstraint.activate([
            bottom,
            videoControls.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            videoControls.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
        videoControls.onPlay = { [weak self] in
            self?.playback?.togglePlay()
            self?.refreshVideoControls()
        }
        videoControls.onMute = { [weak self] in
            guard let self else { return }
            self.muted.toggle()
            self.playback?.player.isMuted = self.muted
            self.refreshVideoControls()
        }
        videoControls.onScrubBegan = { [weak self] in
            guard let self, let playback = self.playback else { return }
            self.playingBeforeScrub = playback.isPlaying
            playback.pause()
        }
        videoControls.onScrub = { [weak self] fraction in self?.playback?.scrub(to: fraction) }
        videoControls.onScrubEnded = { [weak self] in
            guard let self else { return }
            if self.playingBeforeScrub { self.playback?.play() }
            self.playingBeforeScrub = false
            self.refreshVideoControls()
        }
    }

    private func refreshVideoControls() {
        videoControls.set(playing: playback?.isPlaying ?? false, muted: muted, progress: playback?.progress ?? 0)
    }

    /// The shown page plays if it is a video (autoplay, as in Photos) and any other video stops.
    /// Waits for the opening flight to land; `resume` plays on a video that was only paused.
    private func updatePlayback(resume: Bool = true) {
        let item = items.indices.contains(index) ? items[index] : nil
        videoControls.isHidden = !(item?.isVideo ?? false)
        guard let item, item.isVideo, view.window != nil, !isOpening, let app = images.app else {
            stopPlayback()
            return
        }
        if let playback, playback.assetId == item.assetId {
            if resume { playback.play() }
            refreshVideoControls()
            return
        }
        stopPlayback()
        let playback = VideoPlayback(assetId: item.assetId)
        playback.player.isMuted = muted
        playback.onChange = { [weak self] in self?.refreshVideoControls() }
        self.playback = playback
        attachPlayer()
        refreshVideoControls()
        Task { [weak self] in
            do {
                try await playback.start(app: app)
            } catch {
                guard let self, self.playback === playback else { return }
                self.presentError(IOSAppModel.describe(error))
                return
            }
            guard let self, self.playback === playback, self.view.window != nil else {
                playback.stop()
                return
            }
            playback.play()
            self.refreshVideoControls()
        }
    }

    private func stopPlayback() {
        playback?.stop()
        playback = nil
        attachPlayer()
        refreshVideoControls()
    }

    /// The player goes on the shown page only (the others show their poster).
    private func attachPlayer() {
        for case let cell as PhotoPageCell in pager.visibleCells {
            let shown = pager.indexPath(for: cell)?.item == index
            cell.attach(shown ? playback?.player : nil)
        }
    }

    /// Makes a video's poster frame once (the Mac has no thumbnail of a video); a page that had
    /// no shape yet takes the poster's.
    private func askPoster(_ item: PhotoViewerItem) {
        guard images.anyCached(item.assetId) == nil, postersAsked.insert(item.assetId).inserted else { return }
        Task { [weak self] in
            guard let images = self?.images, let poster = await VideoPosters.load(item.assetId, images: images),
                  let self, poster.size.height > 0 else { return }
            for case let cell as PhotoPageCell in self.pager.visibleCells {
                guard let path = self.pager.indexPath(for: cell), self.items[path.item].assetId == item.assetId else { continue }
                cell.zoom.aspect = poster.size.width / poster.size.height
            }
        }
    }

    /// A video is shared as its file (written to a temporary folder for the share sheet).
    private func shareVideo(_ item: PhotoViewerItem) {
        Task {
            guard let data = await images.data(item.assetId) else {
                presentError("Video indirilemedi.")
                return
            }
            var name = item.title.replacingOccurrences(of: "/", with: "-")
            if (name as NSString).pathExtension.isEmpty { name += ".mp4" }
            do {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("studio-share-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let url = folder.appendingPathComponent(name)
                try data.write(to: url, options: .atomic)
                FileSharing.share([url], from: self)
            } catch {
                presentError(IOSAppModel.describe(error))
            }
        }
    }

    // MARK: Collections

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { items.count }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let item = items[indexPath.item]
        if collectionView === pager {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "page", for: indexPath) as! PhotoPageCell
            singleTap.require(toFail: cell.zoom.doubleTapGesture)
            cell.configure(item, images: images, insets: pageInsets(), radius: chromeHidden ? 0 : Self.pictureRadius)
            if item.isVideo {
                askPoster(item)
                if let playback, playback.assetId == item.assetId, indexPath.item == index { cell.attach(playback.player) }
            }
            cell.zoom.onZoomChange = { [weak self, weak cell] scale in
                guard let self, let cell, self.pager.indexPath(for: cell)?.item == self.index else { return }
                self.zoomChanged(scale)
            }
            return cell
        }
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "strip", for: indexPath) as! PhotoStripCell
        if item.isVideo { askPoster(item) }
        cell.configure(item, images: images, selected: indexPath.item == index)
        return cell
    }

    /// The shown picture is square in the strip; the others are narrow.
    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
        guard collectionView === strip else { return pager.bounds.size }
        let nearness = max(0, 1 - abs(stripPosition - CGFloat(indexPath.item)))
        return CGSize(width: Self.restWidth + (Self.activeWidth - Self.restWidth) * nearness, height: Self.stripHeight)
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard collectionView === strip else { return }
        show(indexPath.item)
        pager.scrollToItem(at: indexPath, at: .centeredHorizontally, animated: false)
    }

    // MARK: Pager and strip move together

    /// Makes `newIndex` the shown picture while a finger is still moving (no animation).
    private func follow(_ newIndex: Int) {
        guard newIndex != index, items.indices.contains(newIndex) else { return }
        index = newIndex
        zoomChanged(1)
        refreshChrome()
        updatePlayback()
        Haptics.selection()
    }

    /// Moves the strip's square to `position`; `animated` for jumps (scrubbing, tapping), not
    /// while following a finger on the page.
    private func setStripPosition(_ position: CGFloat, animated: Bool) {
        stripPosition = position
        let apply = {
            self.stripLayout.invalidateLayout()
            self.strip.layoutIfNeeded()
        }
        if animated {
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: apply)
        } else {
            UIView.performWithoutAnimation(apply)
        }
    }

    private func stripCenter(_ item: Int) -> CGFloat? {
        stripLayout.layoutAttributesForItem(at: IndexPath(item: item, section: 0))?.center.x
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let moving = scrollView.isDragging || scrollView.isDecelerating
        if scrollView === pager, moving, pager.bounds.width > 0, !items.isEmpty {
            // The strip follows the page exactly: its centre slides from one picture to the next.
            let position = min(max(pager.contentOffset.x / pager.bounds.width, 0), CGFloat(items.count - 1))
            follow(Int(position.rounded()))
            setStripPosition(position, animated: false)
            let lower = Int(position.rounded(.down))
            let upper = min(lower + 1, items.count - 1)
            guard !strip.isHidden, let from = stripCenter(lower), let to = stripCenter(upper) else { return }
            let center = from + (to - from) * (position - CGFloat(lower))
            strip.contentOffset.x = center - strip.bounds.width / 2
        } else if scrollView === strip, moving, !items.isEmpty {
            // Touching and sliding along the strip scrubs through the pictures.
            let center = strip.contentOffset.x + strip.bounds.width / 2
            var nearest = index
            var best = CGFloat.greatestFiniteMagnitude
            for item in 0..<items.count {
                guard let x = stripCenter(item) else { continue }
                let distance = abs(x - center)
                if distance < best { best = distance; nearest = item }
            }
            if nearest != index, pager.bounds.width > 0 {
                follow(nearest)
                setStripPosition(CGFloat(nearest), animated: true)
                pager.contentOffset = CGPoint(x: CGFloat(nearest) * pager.bounds.width, y: 0)
            }
        }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        settle(scrollView)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settle(scrollView) }
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        settle(scrollView)
    }

    private func settle(_ scrollView: UIScrollView) {
        if scrollView === pager, pager.bounds.width > 0 {
            show(Int((pager.contentOffset.x / pager.bounds.width).rounded()))
            if stripPosition != CGFloat(index) {
                setStripPosition(CGFloat(index), animated: true)
                centerStrip(animated: true)
            }
        } else if scrollView === strip {
            // The strip rests on the shown picture.
            centerStrip(animated: true)
        }
    }
}

/// One page of the viewer: a zoomable picture that opens on what is already loaded.
private final class PhotoPageCell: UICollectionViewCell {
    let zoom = ZoomableView()
    private var imageView: IOSAssetImageView?
    /// A video page's picture: over the poster, clear until its first frame.
    private let playerView = PlayerLayerView()
    override init(frame: CGRect) {
        super.init(frame: frame)
        zoom.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(zoom)
        zoom.pin(to: contentView)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func prepareForReuse() {
        super.prepareForReuse()
        zoom.setZoomScale(1, animated: false)
        playerView.player = nil
    }

    /// Shows `player` on this page (nil: only the poster).
    func attach(_ player: AVPlayer?) {
        playerView.player = player
    }

    var image: UIImage? { imageView?.image }

    func setFit(insets: UIEdgeInsets, radius: CGFloat) {
        zoom.content.layer.cornerRadius = radius
        guard zoom.zoomScale <= 1.01 else { return }
        zoom.fitInsets = insets
        zoom.layoutIfNeeded()
    }

    func configure(_ item: PhotoViewerItem, images: IOSImageStore, insets: UIEdgeInsets, radius: CGFloat) {
        zoom.fitInsets = insets
        zoom.content.layer.cornerRadius = radius
        zoom.content.layer.cornerCurve = .continuous
        zoom.content.clipsToBounds = true
        imageView?.removeFromSuperview()
        let view = IOSAssetImageView(store: images, assetId: item.assetId, contentMode: .scaleAspectFit)
        view.backgroundColor = .clear
        let cached = images.anyCached(item.assetId)
        if view.image == nil { view.image = cached }
        zoom.content.addSubview(view)
        view.pin(to: zoom.content)
        imageView = view
        playerView.player = nil
        playerView.removeFromSuperview()
        if item.isVideo {
            zoom.content.addSubview(playerView)
            playerView.pin(to: zoom.content)
        }
        if let aspect = PhotoViewerViewController.aspect(of: item, images: images) {
            zoom.aspect = aspect
        }
    }
}

/// A small picture of the strip above the toolbar.
private final class PhotoStripCell: UICollectionViewCell {
    private var image: IOSAssetImageView?

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.layer.cornerRadius = 6
        contentView.layer.cornerCurve = .continuous
        contentView.clipsToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ item: PhotoViewerItem, images: IOSImageStore, selected: Bool) {
        if let image {
            image.assetId = item.assetId
        } else {
            let view = IOSAssetImageView(store: images, assetId: item.assetId, displayWidth: 60)
            contentView.addSubview(view)
            view.pin(to: contentView)
            image = view
        }
        setSelected(selected)
    }

    func setSelected(_ selected: Bool) {
        contentView.layer.borderWidth = 0
        contentView.alpha = selected ? 1 : 0.75
    }
}

/// The strip's holder: fades the strip out at its two ends. The mask follows the holder's own
/// size (the toolbar lays it out, not the viewer).
private final class FadingEdgesView: UIView {
    private let fade = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        fade.startPoint = CGPoint(x: 0, y: 0.5)
        fade.endPoint = CGPoint(x: 1, y: 0.5)
        fade.colors = [UIColor.clear.cgColor, UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
        fade.locations = [0, 0.14, 0.86, 1]
        layer.mask = fade
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.frame = bounds
        CATransaction.commit()
    }
}

/// The viewer's name pill (the navigation bar's title view): Liquid Glass with the name and,
/// under it, when the picture was added.
final class GlassTitlePill: UIView {
    private let glass = UIVisualEffectView(effect: nil)
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        glass.effect = UIGlassEffect(style: .regular)
        glass.translatesAutoresizingMaskIntoConstraints = false
        glass.cornerConfiguration = .capsule()
        addSubview(glass)
        glass.pin(to: self)
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = IOSTheme.textPrimary
        titleLabel.textAlignment = .center
        titleLabel.lineBreakMode = .byTruncatingMiddle
        subtitleLabel.font = .systemFont(ofSize: 13, weight: .regular)
        subtitleLabel.textColor = IOSTheme.textSecondary
        subtitleLabel.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -22),
            stack.centerYAnchor.constraint(equalTo: glass.contentView.centerYAnchor),
            heightAnchor.constraint(equalToConstant: 44),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
            widthAnchor.constraint(lessThanOrEqualToConstant: 240),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The name and date as a still copy (the transition's capsule carries it).
    func contentCopy() -> UIView {
        let title = UILabel()
        title.font = titleLabel.font
        title.textColor = titleLabel.textColor
        title.text = titleLabel.text
        title.textAlignment = .center
        title.lineBreakMode = .byTruncatingMiddle
        let subtitle = UILabel()
        subtitle.font = subtitleLabel.font
        subtitle.textColor = subtitleLabel.textColor
        subtitle.text = subtitleLabel.text
        subtitle.textAlignment = .center
        subtitle.isHidden = subtitleLabel.isHidden
        let stack = UIStackView(arrangedSubviews: [title, subtitle])
        stack.axis = .vertical
        stack.alignment = .center
        let holder = UIView()
        holder.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: holder.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: holder.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: holder.widthAnchor, constant: -44),
        ])
        return holder
    }

    func set(title: String, subtitle: String?) {
        titleLabel.text = title
        subtitleLabel.text = subtitle
        subtitleLabel.isHidden = subtitle?.isEmpty ?? true
        invalidateIntrinsicContentSize()
    }
}
