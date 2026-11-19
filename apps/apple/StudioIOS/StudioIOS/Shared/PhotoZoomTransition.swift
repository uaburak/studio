import UIKit

/// A screen a picture flies into from its thumbnail and back (the picture viewer, the Postlar
/// feed, Reels and stories). The transition asks it where the picture sits and has it hide its own
/// copy while the flying one is on screen.
@MainActor
protocol ZoomTransitionDestination: UIViewController {
    /// The picture as loaded (the flying copy).
    var shownImage: UIImage? { get }
    /// The picture's corner radius at rest.
    var restingRadius: CGFloat { get }
    /// The thumbnail the shown picture flies to (nil: gone or scrolled away, it fades instead).
    func currentSource() -> UIView?
    /// Where the shown picture sits on screen, in `container`'s coordinates.
    func pictureRect(in container: UIView) -> CGRect
    /// Its own copy of the picture (and its backdrop) out of sight, the view still taking touches.
    func setContentHidden(_ hidden: Bool)
    /// Back taps while the picture is still flying in (the bar does not pass them on then).
    func catchBackTapsWhileOpening(_ on: Bool)
    func transitionEnded()
    func makeTransition(_ operation: PhotoZoomTransition.Operation) -> PhotoZoomTransition
    /// The name pill the page's title turns into (the viewer's); nil: no capsule.
    var zoomTitlePill: GlassTitlePill? { get }
    /// True: the whole screen goes the moment it closes (only the picture is on it). False: the
    /// rest of the screen (captions, buttons) stays and fades with `setZoomProgress`.
    var hidesViewWhileClosing: Bool { get }
    /// How far the screen is open (0: the picture is on its thumbnail, 1: at rest); called inside
    /// the flight's animations and while pulling.
    func setZoomProgress(_ progress: CGFloat)
}

extension PhotoViewerViewController: ZoomTransitionDestination {
    var zoomTitlePill: GlassTitlePill? { titlePill }
    var hidesViewWhileClosing: Bool { true }
    func setZoomProgress(_ progress: CGFloat) {}
}

/// The picture viewer's push and pop, like Photos: only the picture flies between its thumbnail
/// and its place on screen, the backdrop fades on its own layer, and the navigation bar and the
/// toolbar (their buttons and title views: Medya's segmented control, the viewer's name pill)
/// are carried through by the navigation controller itself, as in OXTV's detail screen. Pulled down, the picture follows the finger and shrinks; let go far enough (or flick)
/// and it flies home, else it springs back. Sideways swipes never close it.
@MainActor
final class PhotoZoomTransition: NSObject, UIViewControllerAnimatedTransitioning, UIViewControllerInteractiveTransitioning {
    enum Operation { case push, pop }

    let operation: Operation
    /// Driven by the viewer's downward pan (pop only).
    let isInteractive: Bool
    private weak var viewer: (any ZoomTransitionDestination)?

    private var context: UIViewControllerContextTransitioning?
    private var flyer: UIImageView?
    private var backdrop: UIView?
    private var startFrame: CGRect = .zero
    private var hiddenSource: UIView?
    /// The opening as one interruptible animator (UIKit runs the bars' change on it too).
    private var flight: UIViewPropertyAnimator?
    /// One glass capsule between the page's title (Medya's segmented control) and the viewer's
    /// name pill; the navigation bar itself only swaps them.
    private var titleMorph: TitleMorph?
    /// The capsule's progress, scrubbed by the pull.
    private var titleScrub: UIViewPropertyAnimator?

    init(operation: Operation, viewer: any ZoomTransitionDestination, interactive: Bool = false) {
        self.operation = operation
        self.viewer = viewer
        self.isInteractive = interactive
    }

    /// The push runs as an "interactive" transition that starts animating by itself: UIKit keeps
    /// delivering touches during it (a plain animated transition swallows them), so back or a pull
    /// right after opening is not lost.
    var wantsInteractiveStart: Bool { operation == .pop }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval { 0.3 }

    // MARK: Animated (push, and pop from the back button)

    func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {
        if let flight {
            if operation == .push { viewer?.catchBackTapsWhileOpening(true) }
            if flight.state == .inactive { flight.startAnimation() }
            return
        }
        context = transitionContext
        guard let viewer, let setup = prepare(in: transitionContext) else {
            fallback(transitionContext)
            return
        }
        let duration = transitionDuration(using: transitionContext)
        switch operation {
        case .push:
            viewer.catchBackTapsWhileOpening(true)
            pushAnimator(viewer: viewer, setup: setup, context: transitionContext).startAnimation()
        case .pop:
            popAnimator(setup: setup).startAnimation()
        }
    }

    // MARK: Interruptible opening

    /// UIKit's interruptible transition: the opening is one property animator (the picture, the
    /// backdrop and the title capsule) that UIKit also runs the bars' change on, so a back or a
    /// pull can turn the whole thing around at any moment, without waiting for it to end.
    func interruptibleAnimator(using transitionContext: UIViewControllerContextTransitioning) -> UIViewImplicitlyAnimating {
        if let flight { return flight }
        if let viewer, context == nil {
            context = transitionContext
            if let setup = prepare(in: transitionContext) {
                return operation == .push
                    ? pushAnimator(viewer: viewer, setup: setup, context: transitionContext)
                    : popAnimator(setup: setup)
            }
        }
        return UIViewPropertyAnimator(duration: transitionDuration(using: transitionContext), curve: .easeOut)
    }

    /// The close by the back button: the picture flies home, the backdrop and the title capsule
    /// go with it, and UIKit runs the bars' change on the same animator (so the corner buttons
    /// change together with the picture, as they do natively).
    private func popAnimator(setup: Setup) -> UIViewPropertyAnimator {
        if let flight { return flight }
        let back = UIViewPropertyAnimator(duration: transitionDuration(using: context), timingParameters: UICubicTimingParameters(
            controlPoint1: CGPoint(x: 0.2, y: 0.9), controlPoint2: CGPoint(x: 0.3, y: 1)))
        back.addAnimations {
            self.flyHome(setup.flyer)
            setup.backdrop.alpha = 0
            self.viewer?.setZoomProgress(0)
            if let morph = self.titleMorph {
                UIView.animateKeyframes(withDuration: 0, delay: 0, options: [.calculationModeCubic]) { morph.keyframes(toPill: false) }
            }
        }
        back.addCompletion { _ in
            self.flight = nil
            self.finish(true)
        }
        flight = back
        return back
    }

    private func pushAnimator(viewer: any ZoomTransitionDestination, setup: Setup, context: UIViewControllerContextTransitioning) -> UIViewPropertyAnimator {
        if let flight { return flight }
        let target = viewer.pictureRect(in: context.containerView)
        // A curve that ends exactly on time (a spring's completion waited for it to settle).
        let flight = UIViewPropertyAnimator(duration: transitionDuration(using: context), timingParameters: UICubicTimingParameters(
            controlPoint1: CGPoint(x: 0.2, y: 0.9), controlPoint2: CGPoint(x: 0.3, y: 1)))
        flight.addAnimations {
            setup.flyer.frame = target
            setup.flyer.layer.cornerRadius = viewer.restingRadius
            setup.backdrop.alpha = 1
            viewer.setZoomProgress(1)
            if let morph = self.titleMorph {
                UIView.animateKeyframes(withDuration: 0, delay: 0, options: [.calculationModeCubic]) { morph.keyframes(toPill: true) }
            }
        }
        flight.addCompletion { position in
            self.flight = nil
            self.finish(position == .end)
        }
        self.flight = flight
        return flight
    }

    /// Back or a pull while the picture is still flying in: the opening turns around from where
    /// it is (UIKit cancels the push), the bars and the title capsule going back with it.
    func reverseOpening() {
        guard operation == .push, let context, let flight else { return }
        viewer?.catchBackTapsWhileOpening(false)
        context.pauseInteractiveTransition()
        flight.pauseAnimation()
        flight.isReversed = true
        context.cancelInteractiveTransition()
        flight.continueAnimation(withTimingParameters: UICubicTimingParameters(animationCurve: .easeOut), durationFactor: 0.6)
    }

    // MARK: Interactive (pop by pulling down)

    func startInteractiveTransition(_ transitionContext: UIViewControllerContextTransitioning) {
        if operation == .push {
            animateTransition(using: transitionContext)
            return
        }
        context = transitionContext
        if prepare(in: transitionContext) == nil {
            fallback(transitionContext)
            return
        }
        // The title capsule stays as it is while pulling and changes on release, together with
        // the corner buttons (UIKit changes those only then).
    }

    /// The pan moved: the picture follows the finger and shrinks, the backdrop clears.
    func update(translation: CGPoint) {
        guard let flyer, let context else { return }
        let height = max(context.containerView.bounds.height, 1)
        let progress = min(max(translation.y / (height * 0.5), 0), 1)
        let scale = 1 - 0.4 * progress
        let width = startFrame.width * scale
        let tall = startFrame.height * scale
        flyer.frame = CGRect(x: startFrame.midX + translation.x - width / 2,
                             y: startFrame.midY + (translation.y >= 0 ? translation.y : translation.y * 0.3) - tall / 2,
                             width: width, height: tall)
        backdrop?.alpha = 1 - progress
        viewer?.setZoomProgress(1 - progress)
        titleScrub?.fractionComplete = progress
        context.updateInteractiveTransition(progress)
    }

    /// The finger lifted: close (far enough, or a flick down) or spring back.
    func end(translation: CGPoint, velocity: CGPoint) {
        guard let flyer, let context else { return }
        let close = velocity.y > 500 || (translation.y > 90 && velocity.y > -200)
        if close {
            context.finishInteractiveTransition()
            titleMorph?.animate(toPill: false)
            // Lasts as long as the capsule's change, so it is not cut short when the picture lands.
            let home = UIViewPropertyAnimator(duration: TitleMorph.duration, timingParameters: UICubicTimingParameters(
                controlPoint1: CGPoint(x: 0.2, y: 0.9), controlPoint2: CGPoint(x: 0.3, y: 1)))
            home.addAnimations {
                self.flyHome(flyer)
                self.backdrop?.alpha = 0
                self.viewer?.setZoomProgress(0)
            }
            home.addCompletion { _ in self.finish(true) }
            home.startAnimation()
        } else {
            context.cancelInteractiveTransition()
            UIView.animate(springDuration: 0.24, bounce: 0.12) {
                flyer.frame = self.startFrame
                self.backdrop?.alpha = 1
                self.viewer?.setZoomProgress(1)
            } completion: { _ in
                self.finish(false)
            }
        }
    }

    // MARK: Pieces

    private struct Setup {
        let flyer: UIImageView
        let backdrop: UIView
    }

    /// Puts the page underneath in place, the backdrop over it and the flying picture on top; the
    /// viewer's own view stays invisible until the flight ends.
    private func prepare(in transitionContext: UIViewControllerContextTransitioning) -> Setup? {
        guard let viewer,
              let fromView = transitionContext.view(forKey: .from),
              let toView = transitionContext.view(forKey: .to),
              let toController = transitionContext.viewController(forKey: .to) else { return nil }
        let container = transitionContext.containerView
        toView.frame = transitionContext.finalFrame(for: toController)
        let backdrop = UIView(frame: container.bounds)
        backdrop.backgroundColor = viewer.view.backgroundColor ?? .black
        let flyer = UIImageView()
        flyer.contentMode = .scaleAspectFill
        flyer.clipsToBounds = true
        flyer.layer.cornerCurve = .continuous
        flyer.image = viewer.shownImage
        let source: UIView?

        switch operation {
        case .push:
            source = viewer.currentSource()
            let sourceFrame = source.map { $0.convert($0.bounds, to: container) }
            container.addSubview(toView)
            toView.layoutIfNeeded()
            // Only the viewer's content is hidden while the picture flies in, not its view: a
            // hidden view takes no touches, and a pull or back during the opening must count.
            viewer.setContentHidden(true)
            viewer.setZoomProgress(0)
            backdrop.alpha = 0
            container.insertSubview(backdrop, belowSubview: toView)
            let start = sourceFrame ?? viewer.pictureRect(in: container).insetBy(dx: 40, dy: 40)
            flyer.frame = start
            flyer.layer.cornerRadius = source?.layer.cornerRadius ?? 0
            if sourceFrame == nil { flyer.alpha = 0 }
            container.addSubview(flyer)
            UIView.animate(withDuration: 0.14) { flyer.alpha = 1 }
        case .pop:
            // The page underneath goes back into the window first: only then is the thumbnail
            // on screen to fly home to (asked before, it was off screen and the picture faded).
            container.insertSubview(toView, belowSubview: fromView)
            toView.layoutIfNeeded()
            source = viewer.currentSource()
            backdrop.alpha = 1
            container.insertSubview(backdrop, belowSubview: fromView)
            startFrame = viewer.pictureRect(in: container)
            flyer.frame = startFrame
            flyer.layer.cornerRadius = viewer.restingRadius
            container.addSubview(flyer)
            if viewer.hidesViewWhileClosing {
                fromView.alpha = 0
            } else {
                // The rest of the screen stays and fades out; only its picture leaves at once.
                viewer.setContentHidden(true)
            }
        }
        // The title capsule: from the page's title to the name pill (or the reverse).
        let page = operation == .push ? transitionContext.viewController(forKey: .from) : toController
        if let navigation = viewer.navigationController, let pill = viewer.zoomTitlePill {
            titleMorph = TitleMorph(pageTitle: page?.navigationItem.titleView, pill: pill, navigation: navigation)
            titleMorph?.setState(atPill: operation == .pop)
        }
        // The thumbnail's spot stays empty while its picture is away (Photos does the same).
        source?.alpha = 0
        hiddenSource = source
        self.flyer = flyer
        self.backdrop = backdrop
        return Setup(flyer: flyer, backdrop: backdrop)
    }

    /// Into the thumbnail of the picture on screen; with none (scrolled away) it fades out.
    private func flyHome(_ flyer: UIImageView) {
        guard let context else { return }
        if let source = hiddenSource, source.window != nil {
            flyer.frame = source.convert(source.bounds, to: context.containerView)
            flyer.layer.cornerRadius = source.layer.cornerRadius
        } else {
            flyer.alpha = 0
            flyer.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
        }
    }

    private func finish(_ completed: Bool) {
        guard let context else { return }
        let cancelled = context.transitionWasCancelled || !completed
        let fromView = context.view(forKey: .from)
        let toView = context.view(forKey: .to)
        switch operation {
        case .push:
            viewer?.setContentHidden(false)
            viewer?.setZoomProgress(1)
            if cancelled { toView?.removeFromSuperview() }
        case .pop:
            fromView?.alpha = 1
            if viewer?.hidesViewWhileClosing == false {
                viewer?.setContentHidden(false)
                viewer?.setZoomProgress(1)
            }
            if cancelled { toView?.removeFromSuperview() }
        }
        hiddenSource?.alpha = 1
        flight = nil
        titleScrub?.stopAnimation(true)
        titleScrub = nil
        titleMorph?.remove()
        titleMorph = nil
        flyer?.removeFromSuperview()
        backdrop?.removeFromSuperview()
        flyer = nil
        backdrop = nil
        self.context = nil
        if operation == .push, context.isInteractive, !cancelled { context.finishInteractiveTransition() }
        context.completeTransition(!cancelled)
        viewer?.transitionEnded()
    }

    /// Something was missing (no views): a plain crossfade so navigation never gets stuck.
    private func fallback(_ transitionContext: UIViewControllerContextTransitioning) {
        let container = transitionContext.containerView
        guard let toView = transitionContext.view(forKey: .to),
              let toController = transitionContext.viewController(forKey: .to) else {
            transitionContext.completeTransition(true)
            return
        }
        toView.frame = transitionContext.finalFrame(for: toController)
        toView.alpha = 0
        container.addSubview(toView)
        UIView.animate(withDuration: 0.25) {
            toView.alpha = 1
        } completion: { _ in
            transitionContext.completeTransition(!transitionContext.transitionWasCancelled)
        }
    }
}

/// The pull-down close handed to UIKit without an interruptible animator: UIKit then drives the
/// bars (the corner buttons' change) by the pull's progress, as in the system's swipe back.
@MainActor
final class PhotoPullTransition: NSObject, UIViewControllerAnimatedTransitioning, UIViewControllerInteractiveTransitioning {
    let inner: PhotoZoomTransition

    init(_ inner: PhotoZoomTransition) {
        self.inner = inner
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval {
        inner.transitionDuration(using: transitionContext)
    }

    func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {
        inner.startInteractiveTransition(transitionContext)
    }

    func startInteractiveTransition(_ transitionContext: UIViewControllerContextTransitioning) {
        inner.startInteractiveTransition(transitionContext)
    }
}

/// Hands the viewer's transitions to a navigation controller (the root's delegate forwards here;
/// a navigation controller without a delegate, like a sheet's, gets this one).
@MainActor
final class PhotoViewerNavigationDelegate: NSObject, UINavigationControllerDelegate {
    static let shared = PhotoViewerNavigationDelegate()

    func navigationController(_ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation, from fromVC: UIViewController, to toVC: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        Self.animator(operation: operation, from: fromVC, to: toVC)
    }

    func navigationController(_ navigationController: UINavigationController, interactionControllerFor animationController: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        Self.interaction(for: animationController)
    }

    static func animator(operation: UINavigationController.Operation, from fromVC: UIViewController, to toVC: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        if operation == .push, let viewer = toVC as? any ZoomTransitionDestination {
            return viewer.makeTransition(.push)
        }
        if operation == .pop, let viewer = fromVC as? any ZoomTransitionDestination {
            // The system's swipe back (a screen that keeps it, like the Postlar feed) slides the
            // page as usual; the picture viewer switches those gestures off.
            if let navigation = fromVC.navigationController,
               [navigation.interactivePopGestureRecognizer, navigation.interactiveContentPopGestureRecognizer].contains(where: { $0?.state == .began || $0?.state == .changed }) {
                return nil
            }
            let transition = viewer.makeTransition(.pop)
            return transition.isInteractive ? PhotoPullTransition(transition) : transition
        }
        return nil
    }

    static func interaction(for animator: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        if let pull = animator as? PhotoPullTransition { return pull }
        guard let transition = animator as? PhotoZoomTransition,
              transition.isInteractive || transition.operation == .push else { return nil }
        return transition
    }
}

/// A glass capsule laid over the navigation bar for the length of a transition, doing what the
/// bar does to its own buttons (measured from a recording of a push in dark mode, 60 fps):
/// - the glass stretches to the new width on a spring and swells by about 10 % on the way;
/// - the old content blurs out (about 0.1 s) and the new one comes in blurred and sharpens
///   (about 0.17 s), the two overlapping briefly in the middle;
/// - about 0.33 s in all.
/// It starts as the page's title (a copy of Medya's segmented control) and ends as the viewer's
/// name pill, or the reverse. Without a page title it simply materialises into the pill. The real
/// title views stay hidden meanwhile.
@MainActor
private final class TitleMorph {
    static let duration: TimeInterval = 0.3
    /// The page title as last seen on screen (a pop starts while it is off screen).
    private static var lastTitleImage: (title: ObjectIdentifier, image: UIImage)?
    /// The middle of the bar's title area as last measured.
    private static var lastTitleCenter: CGPoint?
    private static let swell: CGFloat = 1.1
    private static let blurRadius: CGFloat = 7

    private let overlay = UIVisualEffectView(effect: nil)
    /// Holds the glass and clips it to a fully round capsule. Clipping the glass itself was lost
    /// while the pull-down scrubbed the animation (the corners went square).
    private let shell = UIView()
    private let page: (sharp: UIImageView, blurred: UIImageView)?
    private let pillContent: (sharp: UIImageView, blurred: UIImageView)
    private let pageFrame: CGRect
    private let pillFrame: CGRect
    private weak var pageTitle: UIView?
    private weak var pill: UIView?

    init?(pageTitle: UIView?, pill: GlassTitlePill, navigation: UINavigationController) {
        let host = navigation.view!
        let bar = navigation.navigationBar
        let barFrame = bar.convert(bar.bounds, to: host)
        guard barFrame.height > 0 else { return nil }
        let middle = CGPoint(x: host.bounds.midX, y: barFrame.midY)
        // Where the bar really puts the two title views (not exactly the bar's middle). The one on
        // screen is measured; the other one sits at the same height in the bar (both are its title
        // view), so it takes that centre. A guessed spot made the real pill jump a few points.
        bar.layoutIfNeeded()
        let measured: (UIView) -> CGRect? = { view in
            guard view.window != nil, view.bounds.width > 1 else { return nil }
            return view.convert(view.bounds, to: host)
        }
        var pillSize = pill.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
        if pillSize.width < 1 || pillSize.height < 1 { pillSize = CGSize(width: 180, height: 44) }
        var titleSize = CGSize.zero
        if let pageTitle {
            titleSize = pageTitle.bounds.size
            if titleSize.width < 1 { titleSize = pageTitle.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize) }
        }
        let pillOnScreen = measured(pill)
        let titleOnScreen = pageTitle.flatMap(measured)
        if let pillOnScreen { pillSize = pillOnScreen.size }
        let center: CGPoint = {
            if let frame = titleOnScreen ?? pillOnScreen { return CGPoint(x: frame.midX, y: frame.midY) }
            if let last = Self.lastTitleCenter { return last }
            return middle
        }()
        Self.lastTitleCenter = center
        let around: (CGSize) -> CGRect = { size in
            CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
        }
        pillFrame = pillOnScreen ?? around(pillSize)

        if let pageTitle {
            pageFrame = titleOnScreen ?? around(titleSize)
            page = Self.images(from: Self.picture(of: pageTitle, size: titleSize), size: titleSize)
        } else {
            pageFrame = pillFrame
            page = nil
        }
        let pillCopy = pill.contentCopy()
        pillCopy.frame = CGRect(origin: .zero, size: pillSize)
        pillCopy.layoutIfNeeded()
        let pillPicture = UIGraphicsImageRenderer(size: pillSize).image { pillCopy.layer.render(in: $0.cgContext) }
        pillContent = Self.images(from: pillPicture, size: pillSize)
        self.pageTitle = pageTitle
        self.pill = pill

        // Always fully round: half the (shared) height, fixed. `.capsule()` follows the bounds and
        // lagged behind the resizing, so the corners went almost square for a moment.
        let radius = min(pageFrame.height, pillFrame.height) / 2
        overlay.cornerConfiguration = .corners(radius: .fixed(radius))
        overlay.layer.cornerRadius = radius
        overlay.layer.cornerCurve = .continuous
        overlay.clipsToBounds = true
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        shell.layer.cornerRadius = radius
        shell.layer.cornerCurve = .continuous
        shell.clipsToBounds = true
        shell.isUserInteractionEnabled = false
        shell.addSubview(overlay)
        overlay.contentView.clipsToBounds = true
        overlay.isUserInteractionEnabled = false
        for view in [page?.sharp, page?.blurred, pillContent.blurred, pillContent.sharp].compactMap({ $0 }) {
            overlay.contentView.addSubview(view)
        }
        host.addSubview(shell)
        pageTitle?.isHidden = true
        pill.isHidden = true
    }

    /// Where the transition starts, without animation.
    func setState(atPill: Bool) {
        UIView.performWithoutAnimation {
            place(atPill ? pillFrame : pageFrame)
            shell.transform = .identity
            page?.sharp.alpha = atPill ? 0 : 1
            page?.blurred.alpha = 0
            pillContent.sharp.alpha = atPill ? 1 : 0
            pillContent.blurred.alpha = 0
            overlay.effect = atPill || page != nil ? UIGlassEffect(style: .regular) : nil
        }
    }

    /// The bar's own change, run on its own clock (push, pop by the back button).
    func animate(toPill: Bool) {
        UIView.animateKeyframes(withDuration: Self.duration, delay: 0, options: [.calculationModeCubic]) {
            self.keyframes(toPill: toPill)
        }
    }

    /// The keyframes of the change; also scrubbed by the pull-down close.
    func keyframes(toPill: Bool) {
        let from = toPill ? page : pillContent
        let to = toPill ? pillContent : page
        let target = toPill ? pillFrame : pageFrame
        // The glass: stretches to the new size, swelling on the way.
        UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 1) { self.place(target) }
        UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.45) {
            self.shell.transform = CGAffineTransform(scaleX: Self.swell, y: Self.swell)
        }
        UIView.addKeyframe(withRelativeStartTime: 0.45, relativeDuration: 0.55) { self.shell.transform = .identity }
        if page == nil {
            UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.6) {
                self.overlay.effect = toPill ? UIGlassEffect(style: .regular) : nil
            }
        }
        // The old content blurs out.
        UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.25) {
            from?.sharp.alpha = 0
            from?.blurred.alpha = 1
        }
        UIView.addKeyframe(withRelativeStartTime: 0.2, relativeDuration: 0.2) { from?.blurred.alpha = 0 }
        // The new one comes in blurred and sharpens.
        UIView.addKeyframe(withRelativeStartTime: 0.3, relativeDuration: 0.2) { to?.blurred.alpha = 1 }
        UIView.addKeyframe(withRelativeStartTime: 0.45, relativeDuration: 0.4) {
            to?.blurred.alpha = 0
            to?.sharp.alpha = 1
        }
    }

    func remove() {
        shell.removeFromSuperview()
        pageTitle?.isHidden = false
        pill?.isHidden = false
    }

    /// The capsule at `frame` (bounds and centre, so the swell transform stays separate); the
    /// content stays centred in it.
    private func place(_ frame: CGRect) {
        shell.bounds = CGRect(origin: .zero, size: frame.size)
        shell.center = CGPoint(x: frame.midX, y: frame.midY)
        overlay.frame = shell.bounds
        let middle = CGPoint(x: frame.width / 2, y: frame.height / 2)
        for view in [page?.sharp, page?.blurred, pillContent.sharp, pillContent.blurred].compactMap({ $0 }) {
            view.center = middle
        }
    }

    /// The page's title exactly as drawn on screen (Medya's segmented control in its real colours);
    /// remembered for the pop, which starts while it is off screen. A rebuilt copy is the fallback.
    private static func picture(of title: UIView, size: CGSize) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        if title.window != nil {
            let image = renderer.image { _ in title.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: false) }
            lastTitleImage = (ObjectIdentifier(title), image)
            return image
        }
        if let last = lastTitleImage, last.title == ObjectIdentifier(title) { return last.image }
        let copy = copy(of: title) ?? UIView()
        copy.frame = CGRect(origin: .zero, size: size)
        copy.layoutIfNeeded()
        return renderer.image { copy.layer.render(in: $0.cgContext) }
    }

    /// A content as two still images: sharp, and blurred with room for the blur to spread.
    private static func images(from sharp: UIImage, size: CGSize) -> (sharp: UIImageView, blurred: UIImageView) {
        let sharpView = UIImageView(image: sharp)
        sharpView.frame = CGRect(origin: .zero, size: size)
        let pad = blurRadius * 3
        let blurredView = UIImageView(image: blurred(sharp, pad: pad))
        blurredView.frame = CGRect(x: 0, y: 0, width: size.width + pad * 2, height: size.height + pad * 2)
        blurredView.alpha = 0
        return (sharpView, blurredView)
    }

    private static func blurred(_ image: UIImage, pad: CGFloat) -> UIImage? {
        let scale = image.scale
        let padded = UIGraphicsImageRenderer(size: CGSize(width: image.size.width + pad * 2, height: image.size.height + pad * 2)).image { _ in
            image.draw(at: CGPoint(x: pad, y: pad))
        }
        guard let input = CIImage(image: padded), let filter = CIFilter(name: "CIGaussianBlur") else { return nil }
        filter.setValue(input, forKey: kCIInputImageKey)
        filter.setValue(blurRadius * scale, forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage?.cropped(to: input.extent),
              let cg = CIContext().createCGImage(output, from: input.extent) else { return nil }
        return UIImage(cgImage: cg, scale: scale, orientation: .up)
    }

    /// A still copy of the page's title: its segmented control rebuilt (a snapshot of a view off
    /// screen comes out blank), or a snapshot of anything else.
    private static func copy(of title: UIView) -> UIView? {
        if let segmented = firstSegmented(in: title) {
            let titles = (0..<segmented.numberOfSegments).map { segmented.titleForSegment(at: $0) ?? "" }
            let copy = UISegmentedControl(items: titles)
            copy.selectedSegmentIndex = segmented.selectedSegmentIndex
            for state in [UIControl.State.normal, .selected] {
                if let attributes = segmented.titleTextAttributes(for: state) { copy.setTitleTextAttributes(attributes, for: state) }
            }
            copy.overrideUserInterfaceStyle = segmented.traitCollection.userInterfaceStyle
            copy.isUserInteractionEnabled = false
            return copy
        }
        return title.snapshotView(afterScreenUpdates: false)
    }

    private static func firstSegmented(in view: UIView) -> UISegmentedControl? {
        if let segmented = view as? UISegmentedControl { return segmented }
        for subview in view.subviews {
            if let found = firstSegmented(in: subview) { return found }
        }
        return nil
    }
}
