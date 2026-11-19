#if DEBUG
import UIKit

/// Debug-only test page (`-StudioTransitionLab YES`): two pages whose right bar items differ in
/// label and icon, to record how the navigation bar changes them during a push and a pop.
enum TransitionLab {
    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.drop { $0 != "-StudioTransitionLab" }.dropFirst().first?.uppercased() == "YES"
    }

    static func makeRoot() -> UIViewController {
        let navigation = UINavigationController(rootViewController: LabPage(step: 0))
        navigation.navigationBar.prefersLargeTitles = false
        return navigation
    }
}

private final class LabPage: UIViewController {
    private let step: Int

    init(step: Int) {
        self.step = step
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let first = step == 0
        // Right side: a label and an icon sharing one glass capsule, both different on the next page.
        // A text item and an image item get separate capsules, so one item carries both: a plain
        // button (icon + label) as the item's view, on the bar's own shared glass.
        var config = UIButton.Configuration.plain()
        config.title = first ? "Resim" : "Paylaşılan"
        config.image = UIImage(systemName: first ? "plus" : "square.and.arrow.up")
        config.imagePadding = 6
        config.baseForegroundColor = .label
        let button = UIButton(configuration: config)
        navigationItem.rightBarButtonItem = UIBarButtonItem(customView: button)
        navigationItem.title = first ? "Sayfa A" : "Sayfa B"
        navigationItem.largeTitleDisplayMode = .never

        let push = UIButton(configuration: .filled(), primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            if first {
                self.navigationController?.pushViewController(LabPage(step: 1), animated: true)
            } else {
                self.navigationController?.popViewController(animated: true)
            }
        })
        push.configuration?.title = first ? "İleri" : "Geri"
        push.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(push)
        NSLayoutConstraint.activate([
            push.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            push.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }
}
#endif
