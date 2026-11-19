import UIKit

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
    private weak var viewer: PhotoViewerViewController?

    private var context: UIViewControllerContextTransitioning?
    private var flyer: UIImageView?
    private var backdrop: UIView?
    private var startFrame: CGRect = .zero
    private var hiddenSource: UIView?
    /// One glass capsule between the page's title (Medya's segmented control) and the viewer's
    /// name pill; the navigation bar itself only swaps them.
    private var titleMorph: TitleMorph?
    /// The capsule's progress, scrubbed by the pull.
    private var titleScrub: UIViewPropertyAnimator?

    init(operation: Operation, viewer: PhotoViewerViewController, interactive: Bool = false) {
        self.operation = operation
        self.viewer = viewer
        self.isInteractive = interactive
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval { 0.28 }

    // MARK: Animated (push, and pop from the back button)

    func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {
        context = transitionContext
        guard let viewer, let setup = prepare(in: transitionContext) else {
            fallback(transitionContext)
            return
        }
        let duration = transitionDuration(using: transitionContext)
        switch operation {
        case .push:
            let target = viewer.pictureRect(in: transitionContext.containerView)
            UIView.animate(springDuration: duration, bounce: 0.12) {
                setup.flyer.frame = target
                setup.flyer.layer.cornerRadius = viewer.restingRadius
                setup.backdrop.alpha = 1
                self.titleMorph?.apply(atPill: true)
            } completion: { _ in
                self.finish(true)
            }
        case .pop:
            UIView.animate(springDuration: duration, bounce: 0) {
                self.flyHome(setup.flyer)
                setup.backdrop.alpha = 0
                self.titleMorph?.apply(atPill: false)
            } completion: { _ in
                self.finish(true)
            }
        }
    }

    // MARK: Interactive (pop by pulling down)

    func startInteractiveTransition(_ transitionContext: UIViewControllerContextTransitioning) {
        context = transitionContext
        if prepare(in: transitionContext) == nil {
            fallback(transitionContext)
            return
        }
        if let titleMorph {
            let scrub = UIViewPropertyAnimator(duration: 1, curve: .linear) { titleMorph.apply(atPill: false) }
            scrub.pausesOnCompletion = true
            scrub.pauseAnimation()
            titleScrub = scrub
        }
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
        titleScrub?.fractionComplete = progress
        context.updateInteractiveTransition(progress)
    }

    /// The finger lifted: close (far enough, or a flick down) or spring back.
    func end(translation: CGPoint, velocity: CGPoint) {
        guard let flyer, let context else { return }
        let close = velocity.y > 500 || (translation.y > 90 && velocity.y > -200)
        if close {
            context.finishInteractiveTransition()
            titleScrub?.continueAnimation(withTimingParameters: UICubicTimingParameters(animationCurve: .easeOut), durationFactor: 0.26)
            UIView.animate(springDuration: 0.26, bounce: 0) {
                self.flyHome(flyer)
                self.backdrop?.alpha = 0
            } completion: { _ in
                self.finish(true)
            }
        } else {
            context.cancelInteractiveTransition()
            if let titleScrub {
                titleScrub.isReversed = true
                titleScrub.continueAnimation(withTimingParameters: UICubicTimingParameters(animationCurve: .easeOut), durationFactor: 0.24)
            }
            UIView.animate(springDuration: 0.24, bounce: 0.12) {
                flyer.frame = self.startFrame
                self.backdrop?.alpha = 1
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
            toView.alpha = 0
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
            fromView.alpha = 0
        }
        // The title capsule: from the page's title to the name pill (or the reverse).
        let page = operation == .push ? transitionContext.viewController(forKey: .from) : toController
        if let navigation = viewer.navigationController {
            titleMorph = TitleMorph(pageTitle: page?.navigationItem.titleView, pill: viewer.titlePill, navigation: navigation)
            titleMorph?.apply(atPill: operation == .pop)
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
            toView?.alpha = 1
        case .pop:
            fromView?.alpha = 1
            if cancelled { toView?.removeFromSuperview() }
        }
        hiddenSource?.alpha = 1
        titleScrub?.stopAnimation(true)
        titleScrub = nil
        titleMorph?.remove()
        titleMorph = nil
        flyer?.removeFromSuperview()
        backdrop?.removeFromSuperview()
        flyer = nil
        backdrop = nil
        self.context = nil
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
        if operation == .push, let viewer = toVC as? PhotoViewerViewController {
            return viewer.makeTransition(.push)
        }
        if operation == .pop, let viewer = fromVC as? PhotoViewerViewController {
            return viewer.makeTransition(.pop)
        }
        return nil
    }

    static func interaction(for animator: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        guard let transition = animator as? PhotoZoomTransition, transition.isInteractive else { return nil }
        return transition
    }
}

/// A glass capsule laid over the navigation bar for the length of a transition: it starts as the
/// page's title (a copy of Medya's segmented control) and stretches into the viewer's name pill,
/// the two contents cross-fading, or the reverse. Without a page title it simply materialises
/// into the pill. The real title views stay hidden meanwhile.
@MainActor
private final class TitleMorph {
    private let overlay = UIVisualEffectView(effect: nil)
    private let pageContent: UIView?
    private let pillContent: UIView
    private let pageFrame: CGRect
    private let pillFrame: CGRect
    private weak var pageTitle: UIView?
    private weak var pill: UIView?

    init?(pageTitle: UIView?, pill: GlassTitlePill, navigation: UINavigationController) {
        let host = navigation.view!
        let bar = navigation.navigationBar
        let barFrame = bar.convert(bar.bounds, to: host)
        guard barFrame.height > 0 else { return nil }
        let center = CGPoint(x: host.bounds.midX, y: barFrame.midY)
        var pillSize = pill.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
        if pillSize.width < 1 || pillSize.height < 1 { pillSize = CGSize(width: 180, height: 44) }
        pillFrame = CGRect(x: center.x - pillSize.width / 2, y: center.y - pillSize.height / 2, width: pillSize.width, height: pillSize.height)

        if let pageTitle, let copy = Self.copy(of: pageTitle) {
            var size = pageTitle.bounds.size
            if size.width < 1 { size = pageTitle.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize) }
            pageFrame = CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
            copy.frame = CGRect(origin: .zero, size: size)
            pageContent = copy
        } else {
            pageFrame = pillFrame
            pageContent = nil
        }
        pillContent = pill.contentCopy()
        pillContent.frame = CGRect(origin: .zero, size: pillSize)
        self.pageTitle = pageTitle
        self.pill = pill

        overlay.cornerConfiguration = .capsule()
        // The wider content (the segmented copy) is cut to the capsule as it narrows.
        overlay.clipsToBounds = true
        overlay.contentView.clipsToBounds = true
        overlay.isUserInteractionEnabled = false
        if let pageContent { overlay.contentView.addSubview(pageContent) }
        overlay.contentView.addSubview(pillContent)
        host.addSubview(overlay)
        pageTitle?.isHidden = true
        pill.isHidden = true
    }

    /// Call inside an animation: the capsule at the pill (true) or at the page's title (false).
    func apply(atPill: Bool) {
        let frame = atPill ? pillFrame : pageFrame
        overlay.frame = frame
        let middle = CGPoint(x: frame.width / 2, y: frame.height / 2)
        pageContent?.center = middle
        pillContent.center = middle
        pillContent.alpha = atPill ? 1 : 0
        pageContent?.alpha = atPill ? 0 : 1
        overlay.effect = atPill || pageContent != nil ? UIGlassEffect(style: .regular) : nil
    }

    func remove() {
        overlay.removeFromSuperview()
        pageTitle?.isHidden = false
        pill?.isHidden = false
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
