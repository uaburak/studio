import StudioKit
import UIKit

/// 4-tab `UITabBarController` for Studio iOS:
/// 1. Sohbet (`bubble.left.and.bubble.right`)
/// 2. Postlar (`square.grid.2x2`)
/// 3. Takvim (`calendar`)
/// 4. Ayarlar (`gearshape`)
final class RootTabBarController: UITabBarController, UITabBarControllerDelegate {
    let app: IOSAppModel
    private var observation: IOSObservationToken?

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self
        tabBar.tintColor = IOSTheme.accent

        let chatNav = UINavigationController(rootViewController: ChatListViewController(app: app))
        chatNav.tabBarItem = UITabBarItem(
            title: "Sohbet",
            image: UIImage(systemName: "bubble.left.and.bubble.right"),
            selectedImage: UIImage(systemName: "bubble.left.and.bubble.right.fill")
        )

        let postsNav = UINavigationController(rootViewController: IOSPostsViewController(app: app))
        postsNav.tabBarItem = UITabBarItem(
            title: "Postlar",
            image: UIImage(systemName: "square.grid.2x2"),
            selectedImage: UIImage(systemName: "square.grid.2x2.fill")
        )

        let calNav = UINavigationController(rootViewController: IOSCalendarViewController(app: app))
        calNav.tabBarItem = UITabBarItem(
            title: "Takvim",
            image: UIImage(systemName: "calendar"),
            selectedImage: UIImage(systemName: "calendar")
        )

        let settingsNav = UINavigationController(rootViewController: IOSSettingsViewController(app: app))
        settingsNav.tabBarItem = UITabBarItem(
            title: "Ayarlar",
            image: UIImage(systemName: "gearshape"),
            selectedImage: UIImage(systemName: "gearshape.fill")
        )

        viewControllers = [chatNav, postsNav, calNav, settingsNav]

        observation = observeIOS { [weak self] in
            guard let self else { return }
            let targetIndex = self.app.selectedTab.rawValue
            if self.selectedIndex != targetIndex {
                self.selectedIndex = targetIndex
            }
        }
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        if let tab = IOSAppModel.Tab(rawValue: selectedIndex) {
            app.selectedTab = tab
        }
    }
}

/// Top navigation bar helper adding Brand Selector Pill (`UIMenu`) + Mac Online Status Dot.
@MainActor
enum StudioNavBarItems {
    static func install(on viewController: UIViewController, app: IOSAppModel) -> IOSObservationToken {
        let brandButton = UIButton(type: .system)
        brandButton.showsMenuAsPrimaryAction = true

        let statusContainer = UIView()
        let dot = IOSStatusDotView(size: 8)
        let statusLabel = UILabel.studio("", size: 12, weight: .medium, color: IOSTheme.textSecondary)
        let statusRow = UIStackView(arrangedSubviews: [dot, statusLabel])
        statusRow.axis = .horizontal
        statusRow.alignment = .center
        statusRow.spacing = 5
        statusRow.translatesAutoresizingMaskIntoConstraints = false
        statusContainer.addSubview(statusRow)
        NSLayoutConstraint.activate([
            statusRow.leadingAnchor.constraint(equalTo: statusContainer.leadingAnchor),
            statusRow.trailingAnchor.constraint(equalTo: statusContainer.trailingAnchor),
            statusRow.topAnchor.constraint(equalTo: statusContainer.topAnchor, constant: 4),
            statusRow.bottomAnchor.constraint(equalTo: statusContainer.bottomAnchor, constant: -4),
        ])

        viewController.navigationItem.leftBarButtonItem = UIBarButtonItem(customView: brandButton)
        let statusItem = UIBarButtonItem(customView: statusContainer)
        if let existingRight = viewController.navigationItem.rightBarButtonItems, !existingRight.isEmpty {
            viewController.navigationItem.rightBarButtonItems = existingRight + [statusItem]
        } else {
            viewController.navigationItem.rightBarButtonItem = statusItem
        }

        return observeIOS { [weak brandButton, weak dot, weak statusLabel, weak app] in
            guard let brandButton, let dot, let statusLabel, let app else { return }
            let title = app.currentBrand?.name ?? "Marka Seç"
            var cfg = UIButton.Configuration.tinted()
            cfg.title = "\(title) ▾"
            cfg.cornerStyle = .capsule
            cfg.baseBackgroundColor = IOSTheme.fill
            cfg.baseForegroundColor = IOSTheme.textPrimary
            cfg.contentInsets = NSDirectionalEdgeInsets(top: 5, leading: 11, bottom: 5, trailing: 11)
            cfg.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var out = incoming
                out.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
                return out
            }
            brandButton.configuration = cfg

            let actions = app.brands.map { brand in
                UIAction(
                    title: brand.name,
                    state: brand.id == app.currentBrandId ? .on : .off
                ) { [weak app] _ in
                    app?.selectBrand(brand.id)
                }
            }
            brandButton.menu = UIMenu(title: "Marka", children: actions)

            dot.dotColor = app.isOnline ? IOSTheme.accent : IOSTheme.textTertiary
            statusLabel.text = app.isOnline ? "Mac hazır" : "Çevrimdışı"
        }
    }
}
