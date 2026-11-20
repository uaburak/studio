import StudioKit
import UIKit

/// The app's root, like the Claude app: the chat fills the screen (no tab bar) and the
/// drawer slides in from the left, pushing the page aside (rounded, not dimmed). Postlar,
/// Takvim, Medya, Ürünler, Markalar, Mac durumu and Ayarlar are sections beside the chat
/// (each replaces the root and has the drawer button, no back button). Notifications and links arrive as `IOSRoute`s and land here.
/// A sideways scroller that, where it stands, leaves a rightward swipe to the screen's swipe
/// back (a brand's tab pager on its first tab).
@MainActor
protocol SwipeBackYielding: AnyObject {
    var yieldsSwipeBack: Bool { get }
}

/// A page that uses the rightward swipe itself at times (Medya's Video page swipes back to Resim).
@MainActor
protocol DrawerSwipeBlocking: AnyObject {
    var blocksDrawerSwipe: Bool { get }
}

final class StudioRootViewController: UIViewController, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
    let app: IOSAppModel
    let mainNav: UINavigationController
    let drawer: DrawerViewController
    private let mainContainer = UIView()
    private let scrim = UIControl()
    /// A rightward swipe anywhere on the chat opens the drawer (not only from the edge).
    private lazy var openPan = UIPanGestureRecognizer(target: self, action: #selector(openPanned(_:)))
    /// Vertical scrolls that started with the same touch; cancelled once the drawer takes it.
    private var simultaneousScrolls: [UIGestureRecognizer] = []
    private lazy var closePan = UIPanGestureRecognizer(target: self, action: #selector(closePanned(_:)))
    /// A leftward swipe on the drawer itself slides it shut (back to the page).
    private lazy var drawerClosePan = UIPanGestureRecognizer(target: self, action: #selector(closePanned(_:)))
    /// A rightward swipe anywhere on a pushed page goes back, following the finger (the
    /// navigation controller's own swipe never starts inside this container).
    private lazy var backPan = UIPanGestureRecognizer(target: self, action: #selector(backPanned(_:)))
    private var backInteraction: UIPercentDrivenInteractiveTransition?
    private var routeObservation: IOSObservationToken?
    private var staleObservation: IOSObservationToken?
    private(set) var isDrawerOpen = false
    /// 0 closed … 1 open (follows the finger while dragging).
    private(set) var drawerProgress: CGFloat = 0
    private var panStart: CGFloat = 0

    init(app: IOSAppModel) {
        self.app = app
        self.drawer = DrawerViewController(app: app)
        let chat = IOSChatViewController(model: app.newConversationModel())
        self.mainNav = UINavigationController(rootViewController: chat)
        super.init(nibName: nil, bundle: nil)
        chat.onOpenDrawer = { [weak self] in self?.setDrawer(open: true, animated: true) }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The conversation at the root of the navigation stack.
    var chat: IOSChatViewController? { mainNav.viewControllers.first as? IOSChatViewController }

    /// The section on screen when it is not a chat (Postlar, Takvim, Medya, …).
    var currentDestination: IOSDestination? {
        guard let first = mainNav.viewControllers.first else { return nil }
        return IOSDestination.allCases.first { $0.isShown(by: first) }
    }

    var drawerWidth: CGFloat { DrawerMath.width(for: view.bounds.width) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.drawer

        addChild(drawer)
        view.addSubview(drawer.view)
        drawer.didMove(toParent: self)
        drawer.onDestination = { [weak self] destination in self?.follow(destination.route) }
        drawer.onConversation = { [weak self] id in self?.follow(.conversation(id)) }
        drawer.onNewChat = { [weak self] in self?.follow(.newConversation) }
        drawer.currentConversationId = { [weak self] in self?.chat?.model.id }
        drawer.currentDestination = { [weak self] in self?.currentDestination }

        mainContainer.backgroundColor = IOSTheme.canvas
        mainContainer.layer.cornerCurve = .continuous
        view.addSubview(mainContainer)
        addChild(mainNav)
        mainContainer.addSubview(mainNav.view)
        mainNav.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        mainNav.didMove(toParent: self)
        mainNav.delegate = self
        mainNav.navigationBar.prefersLargeTitles = true

        // No dimming: the page slides aside as it is; the clear layer only takes the tap that closes.
        scrim.backgroundColor = .clear
        scrim.alpha = 0
        scrim.isHidden = true
        scrim.isAccessibilityElement = true
        scrim.accessibilityLabel = "Kenar çubuğunu kapat"
        scrim.accessibilityTraits = .button
        scrim.addAction(UIAction { [weak self] _ in self?.setDrawer(open: false, animated: true) }, for: .touchUpInside)
        mainContainer.addSubview(scrim)
        scrim.addGestureRecognizer(closePan)
        closePan.delegate = self
        drawer.view.addGestureRecognizer(drawerClosePan)
        drawerClosePan.delegate = self

        openPan.delegate = self
        mainContainer.addGestureRecognizer(openPan)
        backPan.delegate = self
        mainContainer.addGestureRecognizer(backPan)

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.mainContainer.layer.borderColor = IOSTheme.border.cgColor
        }
        mainContainer.layer.borderColor = IOSTheme.border.cgColor

        routeObservation = observeIOS { [weak self] in
            guard let self, let route = self.app.pendingRoute else { return }
            Task { @MainActor in self.follow(route) }
        }
        // Reconnecting (pairing, remote switch, a new Mac address) drops the conversation
        // models: give the chat on screen a live one again, without leaving the page on top.
        staleObservation = observeIOS { [weak self] in
            guard let self, let chat = self.chat, let id = chat.model.id else { return }
            let known = self.app.conversations.contains { $0.id == id }
            if known, self.app.conversationModels[id] !== chat.model {
                Task { @MainActor in self.refreshRootChat(id) }
            }
        }
        applyDrawer(progress: 0)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        drawer.view.bounds = CGRect(x: 0, y: 0, width: drawerWidth, height: bounds.height)
        drawer.view.center = CGPoint(x: drawerWidth / 2, y: bounds.midY)
        mainContainer.bounds = bounds
        mainContainer.center = CGPoint(x: bounds.midX, y: bounds.midY)
        mainNav.view.frame = mainContainer.bounds
        scrim.frame = mainContainer.bounds
        // A layout pass mid-slide (the status bar style changes as the drawer closes) must
        // not snap to the settled state: that hid the drawer and squared the card at once.
        if !isSliding { applyDrawer(progress: drawerProgress) }
    }

    /// True while the open/close animation or a drag is running.
    private var isSliding = false
    /// Stand-in for the drawer while it moves (scaled instead of the real view).
    private var drawerSnapshot: UIView?

    /// The display's corner radius (55 pt on current iPhones); the system does not publish it.
    static let screenCornerRadius: CGFloat = {
        if let radius = UIScreen.main.value(forKey: "_displayCornerRadius") as? CGFloat, radius > 0 { return radius }
        return 55
    }()
    private var slideGeneration = 0
    /// The running open / close slide (stopped where it is when caught).
    private var drawerAnimator: UIViewPropertyAnimator?

    /// Stops a running slide at what is on screen and returns that progress (0 closed … 1 open).
    private func interruptDrawerSlide() -> CGFloat {
        guard let slide = drawerAnimator else { return drawerProgress }
        drawerAnimator = nil
        slide.stopAnimation(false)
        slide.finishAnimation(at: .current)
        let progress = min(max(mainContainer.transform.tx / max(drawerWidth, 1), 0), 1)
        drawerProgress = progress
        return progress
    }

    /// True while the drawer is still sliding (a swipe either way may catch it).
    private var isDrawerSliding: Bool { drawerAnimator?.isRunning == true }

    override var childForStatusBarStyle: UIViewController? { isDrawerOpen ? drawer : mainNav }

    // MARK: Drawer

    private var canOpenDrawer: Bool {
        mainNav.viewControllers.count == 1 && mainNav.presentedViewController == nil && presentedViewController == nil
    }

    /// Lay the drawer and the chat out for `progress` (0 closed … 1 open). While a slide
    /// animates (`settled` false) the drawer, the dimming and the rounded edge stay on;
    /// the settled state switches them off once closed.
    private func applyDrawer(progress: CGFloat, settled: Bool = true) {
        drawerProgress = progress
        let width = drawerWidth
        mainContainer.transform = CGAffineTransform(translationX: progress * width, y: 0)
        let visible = progress > 0.001 || !settled
        // A fixed radius matching the phone's own screen corners (no growing while sliding).
        mainContainer.layer.cornerRadius = Self.screenCornerRadius
        mainContainer.layer.masksToBounds = visible
        mainContainer.layer.borderWidth = visible ? 1 : 0
        scrim.alpha = progress
        scrim.isHidden = !visible
        // Like the Claude app the drawer stays under the chat and grows slightly into place.
        // Scaling the drawer itself makes UIKit recompute its safe area every frame, so its
        // content jumped up and down. Instead a snapshot is scaled while the drawer moves
        // (the approach of common side-menu libraries); the real drawer never transforms.
        drawer.view.transform = .identity
        drawer.view.alpha = 1
        let moving = !settled || (progress > 0.001 && progress < 0.999)
        if moving, isOnScreen {
            if drawerSnapshot == nil {
                drawer.view.isHidden = false
                drawer.view.layoutIfNeeded()
                if let snapshot = drawer.view.snapshotView(afterScreenUpdates: true) {
                    snapshot.frame = drawer.view.frame
                    snapshot.isUserInteractionEnabled = false
                    view.insertSubview(snapshot, aboveSubview: drawer.view)
                    drawerSnapshot = snapshot
                }
            }
            if let snapshot = drawerSnapshot {
                let scale = 0.94 + 0.06 * progress
                snapshot.transform = CGAffineTransform(scaleX: scale, y: scale)
                drawer.view.isHidden = true
                return
            }
        }
        drawerSnapshot?.removeFromSuperview()
        drawerSnapshot = nil
        drawer.view.isHidden = !visible
    }

    func setDrawer(open: Bool, animated: Bool) {
        if open {
            guard canOpenDrawer || drawerProgress > 0 else { return }
            mainNav.view.endEditing(true)
            if !isDrawerOpen { drawer.willOpen() }
        } else {
            drawer.view.endEditing(true)
            if drawer.isSearching { drawer.setSearching(false) }
        }
        let changed = open != isDrawerOpen
        isDrawerOpen = open
        let target: CGFloat = open ? 1 : 0
        if animated && isOnScreen {
            // Catch a slide still running where it is, then go on from there: open and close can
            // turn around at any moment (a tap or a swipe midway does not wait for the end).
            let from = interruptDrawerSlide()
            isSliding = true
            slideGeneration += 1
            let generation = slideGeneration
            applyDrawer(progress: from, settled: false)
            let slide = UIViewPropertyAnimator(duration: 0.3, dampingRatio: 1) {
                self.applyDrawer(progress: target, settled: false)
            }
            slide.isUserInteractionEnabled = true
            slide.addCompletion { position in
                // A newer slide (reopened mid-close, a new drag) owns the state now.
                guard position == .end, generation == self.slideGeneration else { return }
                self.drawerAnimator = nil
                self.isSliding = false
                self.applyDrawer(progress: self.isDrawerOpen ? 1 : 0)
            }
            drawerAnimator = slide
            slide.startAnimation()
        } else {
            _ = interruptDrawerSlide()
            isSliding = false
            applyDrawer(progress: target)
        }
        if changed {
            Haptics.tap()
            setNeedsStatusBarAppearanceUpdate()
        }
        updateAccessibility()
    }

    private func updateAccessibility() {
        mainNav.view.accessibilityElementsHidden = isDrawerOpen
        drawer.view.accessibilityElementsHidden = !isDrawerOpen
        scrim.isAccessibilityElement = isDrawerOpen
        if isDrawerOpen {
            UIAccessibility.post(notification: .screenChanged, argument: drawer.firstAccessibilityElement)
        } else {
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        }
    }

    override func accessibilityPerformEscape() -> Bool {
        guard isDrawerOpen else { return false }
        setDrawer(open: false, animated: true)
        return true
    }

    @objc private func openPanned(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began {
            // The drawer owns this touch now: stop the chat from scrolling along with it.
            for other in simultaneousScrolls where other.isEnabled {
                other.isEnabled = false
                other.isEnabled = true
            }
            simultaneousScrolls.removeAll()
        }
        handlePan(translation: gesture.translation(in: view).x, velocity: gesture.velocity(in: view).x, state: gesture.state)
    }

    @objc private func closePanned(_ gesture: UIPanGestureRecognizer) {
        handlePan(translation: gesture.translation(in: view).x, velocity: gesture.velocity(in: view).x, state: gesture.state)
    }

    private func handlePan(translation: CGFloat, velocity: CGFloat, state: UIGestureRecognizer.State) {
        switch state {
        case .began:
            panStart = interruptDrawerSlide()
            isSliding = true
            slideGeneration += 1
            if !isDrawerOpen {
                mainNav.view.endEditing(true)
                drawer.willOpen()
            }
            applyDrawer(progress: drawerProgress, settled: false)
        case .changed:
            applyDrawer(progress: DrawerMath.progress(start: panStart, translation: translation, width: drawerWidth), settled: false)
        case .ended, .cancelled, .failed:
            let open = state == .ended && DrawerMath.settlesOpen(progress: drawerProgress, velocity: velocity)
            setDrawer(open: open, animated: true)
        default:
            break
        }
    }

    /// The open swipe runs alongside vertical scrolling until it decides it is horizontal.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        // The drawer's list keeps scrolling vertically; a sideways swipe closes the drawer.
        if gestureRecognizer === drawerClosePan { return otherGestureRecognizer.view is UITableView }
        guard gestureRecognizer === openPan, let scroll = otherGestureRecognizer.view as? UIScrollView,
              otherGestureRecognizer === scroll.panGestureRecognizer, !Self.scrollsHorizontally(scroll) else { return false }
        if !simultaneousScrolls.contains(where: { $0 === otherGestureRecognizer }) { simultaneousScrolls.append(otherGestureRecognizer) }
        return true
    }

    /// Touches in a strip that scrolls sideways (starters, attachments, slides) belong to it.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer === openPan || gestureRecognizer === backPan else { return true }
        if gestureRecognizer === openPan { simultaneousScrolls.removeAll() }
        var view = touch.view
        while let current = view, current !== mainContainer {
            if let scroll = current as? UIScrollView, Self.scrollsHorizontally(scroll),
               (scroll as? SwipeBackYielding)?.yieldsSwipeBack != true { return false }
            if current is UISlider || current is UISwitch { return false }
            view = current.superview
        }
        return true
    }

    private static func scrollsHorizontally(_ scroll: UIScrollView) -> Bool {
        scroll.isScrollEnabled && scroll.contentSize.width > scroll.bounds.width + 1
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        // A slide still running can be caught by a sideways swipe in either direction.
        if isDrawerSliding, gestureRecognizer === openPan || gestureRecognizer === closePan || gestureRecognizer === drawerClosePan {
            let velocity = (gestureRecognizer as? UIPanGestureRecognizer)?.velocity(in: view) ?? .zero
            return abs(velocity.x) > abs(velocity.y)
        }
        if gestureRecognizer === openPan {
            guard canOpenDrawer, !isDrawerOpen else { return false }
            if let page = mainNav.topViewController as? DrawerSwipeBlocking, page.blocksDrawerSwipe { return false }
            let velocity = openPan.velocity(in: view)
            return velocity.x > 0 && velocity.x > abs(velocity.y) * 1.2
        }
        if gestureRecognizer === backPan {
            guard canSwipeBack, !isDrawerOpen, mainNav.transitionCoordinator == nil else { return false }
            let velocity = backPan.velocity(in: view)
            return velocity.x > 0 && velocity.x > abs(velocity.y) * 1.2
        }
        if gestureRecognizer === drawerClosePan {
            guard isDrawerOpen, !drawer.isSearching else { return false }
            let velocity = drawerClosePan.velocity(in: view)
            return velocity.x < 0 && abs(velocity.x) > abs(velocity.y) * 1.2
        }
        if gestureRecognizer === closePan {
            guard isDrawerOpen else { return false }
            let velocity = closePan.velocity(in: view)
            return abs(velocity.x) > abs(velocity.y)
        }
        return true
    }

    // MARK: Navigation

    /// The picture viewer flies its picture in and out (see `PhotoZoomTransition`).
    func navigationController(_ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation, from fromVC: UIViewController, to toVC: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        // A post and its chat: the pages slide, their shared message field stays put.
        if let slide = ComposerSlideAnimator.make(operation, from: fromVC, to: toVC) { return slide }
        if operation == .pop, backInteraction != nil { return SwipeBackAnimator() }
        return PhotoViewerNavigationDelegate.animator(operation: operation, from: fromVC, to: toVC)
    }

    func navigationController(_ navigationController: UINavigationController, interactionControllerFor animationController: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        if animationController is SwipeBackAnimator || animationController is ComposerSlideAnimator { return backInteraction }
        return PhotoViewerNavigationDelegate.interaction(for: animationController)
    }

    // MARK: Swipe back

    /// Pages that close through their picture's flight (the picture viewer, Reels, stories)
    /// keep their own pull-down instead; the Postlar feed, a list like any page, swipes back.
    private var canSwipeBack: Bool {
        guard mainNav.viewControllers.count > 1, let top = mainNav.topViewController else { return false }
        // The system's zoom brings its own swipe and drag back.
        if top.preferredTransition != nil { return false }
        // A page that pages its own tabs with a rightward swipe (a brand's page past Genel).
        if let paging = top as? DrawerSwipeBlocking, paging.blocksDrawerSwipe { return false }
        return top is PostFeedViewController || !(top is any ZoomTransitionDestination)
    }

    @objc private func backPanned(_ pan: UIPanGestureRecognizer) {
        let width = max(mainContainer.bounds.width, 1)
        let progress = min(max(pan.translation(in: mainContainer).x / width, 0), 1)
        switch pan.state {
        case .began:
            backInteraction = UIPercentDrivenInteractiveTransition()
            backInteraction?.completionCurve = .easeOut
            mainNav.popViewController(animated: true)
        case .changed:
            backInteraction?.update(progress)
        case .ended, .cancelled, .failed:
            let velocity = pan.velocity(in: mainContainer).x
            let finish = pan.state == .ended && (velocity > 400 || (progress > 0.4 && velocity > -200))
            // The rest runs at the finger's pace, not the full duration.
            backInteraction?.completionSpeed = max(0.6, min(abs(velocity) / 900, 2.5))
            if finish { backInteraction?.finish() } else { backInteraction?.cancel() }
            backInteraction = nil
        default:
            break
        }
    }

    func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        openPan.isEnabled = navigationController.viewControllers.count == 1
    }

    /// Go where a route points (drawer rows, notifications, links in chat).
    func follow(_ route: IOSRoute) {
        if app.pendingRoute == route { app.pendingRoute = nil }
        if route == .pair {
            presentPairing()
            return
        }
        if route == .usage {
            setDrawer(open: false, animated: true)
            let present = { [weak self] in
                guard let self else { return }
                self.presentSheet(UsageSheetViewController(app: self.app, presence: { [weak app = self.app] in app?.presence }), detents: [.medium(), .large()])
            }
            if presentedViewController != nil { dismiss(animated: false, completion: present) } else { present() }
            return
        }
        if presentedViewController != nil { dismiss(animated: isOnScreen) }
        setDrawer(open: false, animated: true)
        switch route {
        case .conversation(let id):
            showConversation(id)
        case .newConversation:
            showNewConversation()
        case .post(let id):
            showPost(id)
        case .posts:
            show(.posts)
        case .postsFiltered(let filter):
            app.posts.focus(filter)
            show(.posts)
        case .media:
            show(.media)
        case .products:
            show(.products)
        case .calendar:
            show(.calendar)
        case .brands:
            show(.brands)
        case .jobs:
            show(.jobs)
        case .settings:
            show(.settings)
        case .pair, .usage:
            break
        case .approvals(let contentId):
            showApprovals(contentId: contentId)
        case .conversationMessage(let id, let messageId):
            showConversation(id)
            chat?.scrollToMessage(messageId)
        case .brand(let id):
            if let top = mainNav.topViewController as? BrandProfileViewController, top.brandId == id { return }
            replaceRoot(with: [sectionRoot(BrandsViewController(app: app)), BrandProfileViewController(app: app, brandId: id)])
        }
    }

    /// The QR scanner ("iPhone'u bağla", "Yeniden bağla", or an opened `studio://pair` link).
    private func presentPairing() {
        let invite = app.pendingInvite
        app.pendingInvite = nil
        let show = { [weak self] in
            guard let self else { return }
            self.setDrawer(open: false, animated: true)
            let scanner = PairingScannerViewController(app: self.app, invite: invite)
            let nav = UINavigationController(rootViewController: scanner)
            nav.modalPresentationStyle = .fullScreen
            self.present(nav, animated: self.isOnScreen)
        }
        if presentedViewController != nil {
            dismiss(animated: false, completion: show)
        } else {
            show()
        }
    }

    /// A section from the drawer (Postlar, Takvim, Medya, …). It sits beside the chat, not inside
    /// it: it replaces the root, has the menu button instead of a back button, and the drawer
    /// swipe works on it.
    func show(_ destination: IOSDestination) {
        if let first = mainNav.viewControllers.first, destination.isShown(by: first), mainNav.viewControllers.count == 1 { return }
        replaceRoot(with: [sectionRoot(destination.makeController(app))])
    }

    /// A section's first page: the drawer button at the left.
    private func sectionRoot(_ controller: UIViewController) -> UIViewController {
        let item = UIBarButtonItem(image: UIImage(systemName: "text.alignleft"), primaryAction: UIAction { [weak self] _ in
            controller.view.endEditing(true)
            self?.setDrawer(open: true, animated: true)
        })
        item.accessibilityLabel = "Kenar çubuğu"
        controller.navigationItem.leftBarButtonItem = item
        controller.navigationItem.backButtonDisplayMode = .minimal
        return controller
    }

    /// Replaces the navigation stack with a soft crossfade (no push or pop).
    private func replaceRoot(with controllers: [UIViewController]) {
        if isOnScreen {
            let transition = CATransition()
            transition.type = .fade
            transition.duration = 0.2
            mainNav.view.layer.add(transition, forKey: "root")
        }
        mainNav.setViewControllers(controllers, animated: false)
        drawer.reload()
    }

    /// Animate navigation only when the user can see it (off screen in tests, at launch).
    private var isOnScreen: Bool { view.window?.isHidden == false }

    private func makeChat(_ model: IOSConversationModel) -> IOSChatViewController {
        let chat = IOSChatViewController(model: model)
        chat.onOpenDrawer = { [weak self] in self?.setDrawer(open: true, animated: true) }
        return chat
    }

    /// Swap the chat at the root (a soft crossfade, no push).
    private func replaceChat(with chat: IOSChatViewController) {
        let transition = CATransition()
        transition.type = .fade
        transition.duration = 0.2
        mainNav.view.layer.add(transition, forKey: "chat")
        mainNav.setViewControllers([chat], animated: false)
        drawer.reload()
    }

    private func refreshRootChat(_ id: EntityID) {
        guard let chat, chat.model.id == id, app.conversationModels[id] !== chat.model,
              app.conversations.contains(where: { $0.id == id }) else { return }
        var stack = mainNav.viewControllers
        stack[0] = makeChat(app.conversationModel(id))
        mainNav.setViewControllers(stack, animated: false)
    }

    func showConversation(_ id: EntityID) {
        if let conversation = app.conversations.first(where: { $0.id == id }), let brandId = conversation.brandId, brandId != app.currentBrandId {
            app.selectBrand(brandId)
        }
        if let chat, chat.model.id == id {
            mainNav.popToRootViewController(animated: isOnScreen)
            return
        }
        replaceChat(with: makeChat(app.conversationModel(id)))
    }

    /// "Onay bekleyenler" pushed over the page on screen (the chat, a post), with a back button.
    private func showApprovals(contentId: EntityID?) {
        if let top = mainNav.topViewController as? IOSApprovalsViewController, top.contentId == contentId { return }
        mainNav.pushViewController(IOSApprovalsViewController(app: app, contentId: contentId), animated: isOnScreen)
    }

    /// The home: an empty new chat (kept if it is already on screen, with its draft).
    func showNewConversation() {
        if let chat, chat.model.isNew {
            mainNav.popToRootViewController(animated: isOnScreen)
            return
        }
        replaceChat(with: makeChat(app.newConversationModel()))
    }

    private func showPost(_ id: EntityID) {
        Task {
            if app.posts.card(id) == nil { await app.posts.load() }
            // A post of another brand (the widget lists every brand): switch to it first.
            if app.posts.card(id) == nil, let content = try? await app.dataService.content(id), content.brandId != app.currentBrandId {
                app.selectBrand(content.brandId)
                await app.posts.load()
            }
            guard let card = app.posts.card(id) else {
                Toast.show("Post bulunamadı", in: view, isError: true)
                return
            }
            if let top = mainNav.topViewController as? IOSPostDetailViewController, top.session.content.id == id { return }
            var stack = mainNav.viewControllers
            if let postsIndex = stack.firstIndex(where: { $0 is IOSPostsViewController }) {
                stack = Array(stack[...postsIndex])
            } else {
                stack = [sectionRoot(IOSPostsViewController(app: app))]
            }
            mainNav.setViewControllers(stack + [IOSPostDetailViewController(app: app, card: card)], animated: isOnScreen)
            drawer.reload()
        }
    }
}

/// The pop of the swipe back, like the system's: the page slides off to the right while the one
/// below comes in from a little to the left, darkened, brightening as it arrives.
final class SwipeBackAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval { 0.35 }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        guard let from = context.view(forKey: .from), let to = context.view(forKey: .to) else {
            context.completeTransition(!context.transitionWasCancelled)
            return
        }
        let container = context.containerView
        let width = container.bounds.width
        to.frame = context.finalFrame(for: context.viewController(forKey: .to)!)
        container.insertSubview(to, belowSubview: from)
        let shade = UIView(frame: container.bounds)
        shade.backgroundColor = UIColor.black.withAlphaComponent(0.12)
        container.insertSubview(shade, belowSubview: from)
        to.transform = CGAffineTransform(translationX: -width * 0.3, y: 0)
        from.layer.shadowColor = UIColor.black.cgColor
        from.layer.shadowOpacity = 0.15
        from.layer.shadowRadius = 10
        UIView.animate(withDuration: transitionDuration(using: context), delay: 0, options: [.curveLinear]) {
            from.transform = CGAffineTransform(translationX: width, y: 0)
            to.transform = .identity
            shade.alpha = 0
        } completion: { _ in
            let cancelled = context.transitionWasCancelled
            from.transform = .identity
            to.transform = .identity
            from.layer.shadowOpacity = 0
            shade.removeFromSuperview()
            if cancelled { to.removeFromSuperview() }
            context.completeTransition(!cancelled)
        }
    }
}
