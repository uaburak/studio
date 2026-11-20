import UIKit

/// A page whose message field floats at the bottom (a post's page, a chat).
@MainActor
protocol FloatingComposerHost: UIViewController {
    var floatingComposer: UIView { get }
    /// The glass pill inside it (where the stand-in sits during the slide).
    var floatingComposerPill: UIView { get }
}

/// Between two pages that both float a message field (a post and its chat): the pages slide
/// sideways as in any push or pop, while the field stays where it is; the leaving page's field
/// turns into the arriving page's in place. Works for the swipe back too (driven by the finger).
final class ComposerSlideAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    private let operation: UINavigationController.Operation

    private init(_ operation: UINavigationController.Operation) {
        self.operation = operation
    }

    @MainActor
    static func make(_ operation: UINavigationController.Operation, from: UIViewController, to: UIViewController) -> ComposerSlideAnimator? {
        guard operation != .none, from is FloatingComposerHost, to is FloatingComposerHost else { return nil }
        return ComposerSlideAnimator(operation)
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval { 0.38 }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        MainActor.assumeIsolated { run(context) }
    }

    @MainActor
    private func run(_ context: UIViewControllerContextTransitioning) {
        guard let fromVC = context.viewController(forKey: .from) as? FloatingComposerHost,
              let toVC = context.viewController(forKey: .to) as? FloatingComposerHost,
              let from = context.view(forKey: .from), let to = context.view(forKey: .to)
        else {
            context.completeTransition(!context.transitionWasCancelled)
            return
        }
        let container = context.containerView
        let width = container.bounds.width
        let push = operation == .push
        to.frame = context.finalFrame(for: toVC)
        if push { container.addSubview(to) } else { container.insertSubview(to, belowSubview: from) }
        to.layoutIfNeeded()

        // A live glass pill over both pages, where the leaving page's field is (a snapshot of
        // glass does not draw); the real fields hide meanwhile and the arriving one takes over
        // at the end, as the stand-in fades.
        let fromField = fromVC.floatingComposer
        let toField = toVC.floatingComposer
        let pillSource = fromVC.floatingComposerPill
        let glass = UIGlassEffect(style: .regular)
        glass.isInteractive = false
        let standIn = UIVisualEffectView(effect: glass)
        standIn.cornerConfiguration = .corners(radius: .fixed(26))
        standIn.frame = pillSource.convert(pillSource.bounds, to: container)
        let hint = UILabel()
        hint.text = "Neyi değiştireyim?"
        hint.font = IOSTheme.font(17)
        hint.textColor = IOSTheme.textSecondary
        hint.frame = CGRect(x: 19, y: 0, width: standIn.bounds.width - 38, height: standIn.bounds.height)
        standIn.contentView.addSubview(hint)
        container.addSubview(standIn)
        fromField.alpha = 0
        toField.alpha = 0

        let shade = UIView(frame: container.bounds)
        shade.backgroundColor = UIColor.black.withAlphaComponent(0.12)
        shade.isUserInteractionEnabled = false
        let behind = push ? from : to
        container.insertSubview(shade, aboveSubview: behind)
        shade.alpha = push ? 0 : 1
        if push {
            to.transform = CGAffineTransform(translationX: width, y: 0)
        } else {
            to.transform = CGAffineTransform(translationX: -width * 0.3, y: 0)
        }

        let duration = transitionDuration(using: context)
        let options: UIView.KeyframeAnimationOptions = context.isInteractive ? [.calculationModeLinear] : [.calculationModeCubic]
        UIView.animateKeyframes(withDuration: duration, delay: 0, options: options) {
            UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 1) {
                if push {
                    from.transform = CGAffineTransform(translationX: -width * 0.3, y: 0)
                    to.transform = .identity
                    shade.alpha = 1
                } else {
                    from.transform = CGAffineTransform(translationX: width, y: 0)
                    to.transform = .identity
                    shade.alpha = 0
                }
            }
        } completion: { _ in
            let cancelled = context.transitionWasCancelled
            from.transform = .identity
            to.transform = .identity
            shade.removeFromSuperview()
            if cancelled { to.removeFromSuperview() }
            let shown = cancelled ? fromField : toField
            shown.alpha = 1
            fromField.alpha = cancelled ? 1 : fromField.alpha
            toField.alpha = cancelled ? 1 : toField.alpha
            // The stand-in fades into the real field (which already sits where it was).
            if let window = shown.window {
                standIn.frame = container.convert(standIn.frame, to: window)
                window.addSubview(standIn)
                UIView.animate(withDuration: 0.18, animations: { standIn.alpha = 0 }, completion: { _ in standIn.removeFromSuperview() })
            } else {
                standIn.removeFromSuperview()
            }
            context.completeTransition(!cancelled)
        }
    }
}
