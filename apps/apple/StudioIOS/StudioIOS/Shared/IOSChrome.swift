import StudioKit
import UIKit

// MARK: - Liquid Glass controls

extension UIButton {
    /// A round Liquid Glass button (drawer search, avatar, scroll to bottom).
    static func glassCircle(_ systemName: String?, label: String, side: CGFloat = 48, pointSize: CGFloat = 18, action: (() -> Void)? = nil) -> UIButton {
        var config = UIButton.Configuration.glass()
        config.cornerStyle = .capsule
        config.baseForegroundColor = IOSTheme.textPrimary
        if let systemName {
            config.image = UIImage(systemName: systemName, withConfiguration: UIImage.SymbolConfiguration(pointSize: pointSize, weight: .regular))
        }
        config.contentInsets = .zero
        let button = action.map { handler in UIButton(configuration: config, primaryAction: UIAction { _ in handler() }) } ?? UIButton(configuration: config)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.accessibilityLabel = label
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: side),
            button.heightAnchor.constraint(equalToConstant: side),
        ])
        return button
    }
}

/// Studio's mark: the orange dot of the app icon.
final class StudioMarkView: UIView {
    init(size: CGFloat = 16) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = IOSTheme.accent
        layer.cornerRadius = size / 2
        isAccessibilityElement = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: size), heightAnchor.constraint(equalToConstant: size)])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - Menus shared by the chat, the drawer and pushed pages

@MainActor
enum StudioMenus {
    /// One action per brand (checkmark on the current one).
    static func brandActions(_ app: IOSAppModel, onPick: @escaping (EntityID) -> Void) -> [UIMenuElement] {
        guard !app.brands.isEmpty else {
            return [UIAction(title: "Marka yok", subtitle: "Mac'te yeni marka oluştur (⇧⌘N)", attributes: .disabled) { _ in }]
        }
        return app.brands.map { brand in
            UIAction(title: brand.name, subtitle: brand.slug, state: brand.id == app.currentBrandId ? .on : .off) { _ in
                onPick(brand.id)
                Haptics.selection()
            }
        }
    }

    /// Brand list (inline, titled) plus "Marka profili" for the current brand.
    static func brandSection(_ app: IOSAppModel, onPick: @escaping (EntityID) -> Void, onProfile: @escaping (EntityID) -> Void) -> [UIMenuElement] {
        var elements: [UIMenuElement] = [UIMenu(title: "Marka", options: .displayInline, children: brandActions(app, onPick: onPick))]
        if let brandId = app.currentBrandId {
            elements.append(UIAction(title: "Marka profili", image: UIImage(systemName: "person.crop.square")) { _ in onProfile(brandId) })
        }
        return elements
    }

    static func modelMenu(_ selection: AgentSelection, presence: WorkerPresence?, onPick: @escaping (AgentModel) -> Void) -> UIMenu {
        func action(_ candidate: AgentModel) -> UIAction {
            let available = AssistantStatus.isAvailable(candidate, presence: presence)
            let subtitle: String? = available ? nil : (presence?.online == true ? (candidate.isGemini ? "Gemini Mac'te hazır değil" : "Claude girişi gerekli") : "Mac çevrimdışı")
            return UIAction(title: candidate.displayName, subtitle: subtitle, state: candidate == selection.model ? .on : .off) { _ in
                onPick(candidate)
                Haptics.selection()
            }
        }
        return UIMenu(title: "Model", subtitle: selection.model.displayName, image: UIImage(systemName: "cpu"), children: [
            UIMenu(title: "Gemini", options: .displayInline, children: AgentModel.geminiCases.map(action)),
            UIMenu(title: "Claude", options: .displayInline, children: AgentModel.claudeCases.map(action)),
        ])
    }

    static func effortMenu(_ selection: AgentSelection, onPick: @escaping (AgentEffort) -> Void) -> UIMenu {
        UIMenu(title: "Düşünme", subtitle: selection.effort.displayName, image: UIImage(systemName: "brain"), children: AgentEffort.allCases.filter { $0 != .unknown }.map { effort in
            UIAction(title: effort.displayName, state: effort == selection.effort ? .on : .off) { _ in
                onPick(effort)
                Haptics.selection()
            }
        })
    }

    /// "Kullanım ve durum" with the busiest usage window in the subtitle.
    static func usageAction(_ presence: WorkerPresence?, action: @escaping () -> Void) -> UIAction {
        let subtitle = presence?.usage?.mostUsed.map { AssistantStatus.percentText($0.effectivePercent) + " kullanıldı" } ?? AssistantStatus.macLine(presence)
        return UIAction(title: "Kullanım ve durum", subtitle: subtitle, image: UIImage(systemName: "gauge.with.dots.needle.33percent")) { _ in action() }
    }
}

/// The brand switcher on pushed pages (Postlar, Takvim): the current brand's name with a menu.
@MainActor
enum StudioNavBarItems {
    static func install(on viewController: UIViewController, app: IOSAppModel, extraRight: [UIBarButtonItem] = []) -> IOSObservationToken {
        let brandItem = UIBarButtonItem(title: "Marka", menu: nil)
        brandItem.accessibilityHint = "Markayı değiştirir"
        brandItem.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak app, weak viewController] completion in
            guard let app else { return completion([]) }
            completion(StudioMenus.brandSection(app, onPick: { app.selectBrand($0) }, onProfile: { brandId in
                viewController?.navigationController?.pushViewController(BrandProfileViewController(app: app, brandId: brandId), animated: true)
            }))
        }])
        // Right to left: the brand first, then the screen's own items.
        viewController.navigationItem.rightBarButtonItems = [brandItem] + extraRight
        return observeIOS { [weak brandItem, weak app] in
            guard let brandItem, let app else { return }
            let name = app.currentBrand?.name ?? (app.brands.isEmpty ? "Marka yok" : "Marka seç")
            brandItem.title = name.count > 18 ? String(name.prefix(17)) + "…" : name
            brandItem.accessibilityLabel = "Marka: \(app.currentBrand?.name ?? "seçilmedi")"
        }
    }
}
