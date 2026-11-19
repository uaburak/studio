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
            } completion: { _ in
                self.finish(true)
            }
        case .pop:
            UIView.animate(springDuration: duration, bounce: 0) {
                self.flyHome(setup.flyer)
                setup.backdrop.alpha = 0
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
        context.updateInteractiveTransition(progress)
    }

    /// The finger lifted: close (far enough, or a flick down) or spring back.
    func end(translation: CGPoint, velocity: CGPoint) {
        guard let flyer, let context else { return }
        let close = velocity.y > 500 || (translation.y > 90 && velocity.y > -200)
        if close {
            context.finishInteractiveTransition()
            UIView.animate(springDuration: 0.26, bounce: 0) {
                self.flyHome(flyer)
                self.backdrop?.alpha = 0
            } completion: { _ in
                self.finish(true)
            }
        } else {
            context.cancelInteractiveTransition()
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
