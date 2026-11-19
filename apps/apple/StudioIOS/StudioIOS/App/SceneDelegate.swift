import StudioKit
import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var appearanceToken: IOSObservationToken?

    private var model: IOSAppModel? { (UIApplication.shared.delegate as? AppDelegate)?.model }

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene, let model else { return }

        let win = UIWindow(windowScene: windowScene)
        #if DEBUG
        if TransitionLab.isRequested {
            win.rootViewController = TransitionLab.makeRoot()
            win.makeKeyAndVisible()
            window = win
            return
        }
        #endif
        win.tintColor = IOSTheme.ink
        win.overrideUserInterfaceStyle = model.settings.appearance.interfaceStyle
        win.rootViewController = StudioRootViewController(app: model)
        win.makeKeyAndVisible()
        window = win

        appearanceToken = observeIOS { [weak win, weak model] in
            guard let win, let model else { return }
            win.overrideUserInterfaceStyle = model.settings.appearance.interfaceStyle
        }

        if let response = connectionOptions.notificationResponse,
           let route = IOSNotifier.route(from: response.notification.request.content.userInfo) {
            model.open(route)
        }
        // Opened from a scanned `studio://pair` link (the system Camera app).
        if let url = connectionOptions.urlContexts.first?.url {
            model.openLink(url)
        }

        if !AppDelegate.isUnderTest {
            Task { @MainActor in await model.load() }
        }
    }

    /// `studio://pair?...` while running: pair with that Mac.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        model?.openLink(url)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        guard !AppDelegate.isUnderTest else { return }
        model?.sceneDidBecomeActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        guard !AppDelegate.isUnderTest, let model else { return }
        model.sceneDidEnterBackground()
        // Keep the live streams for the few seconds iOS allows, so a finishing job still notifies.
        let holder = BackgroundTaskHolder()
        holder.id = UIApplication.shared.beginBackgroundTask(withName: "studio.stream") { holder.end() }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(25))
            holder.end()
        }
    }
}

/// The background task id, ended once (expiry or after the grace period).
@MainActor
private final class BackgroundTaskHolder {
    var id: UIBackgroundTaskIdentifier = .invalid

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
