import StudioKit
import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var appModel: IOSAppModel?
    private var appearanceToken: IOSObservationToken?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let underTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        let settings = IOSAppSettings()
        let model = IOSAppModel(settings: settings)
        self.appModel = model

        let win = UIWindow(windowScene: windowScene)
        win.tintColor = IOSTheme.accent
        win.overrideUserInterfaceStyle = settings.appearance.interfaceStyle
        win.rootViewController = RootTabBarController(app: model)
        win.makeKeyAndVisible()
        self.window = win

        appearanceToken = observeIOS { [weak win, weak settings] in
            guard let win, let settings else { return }
            win.overrideUserInterfaceStyle = settings.appearance.interfaceStyle
        }

        if !underTest {
            Task { @MainActor in
                await model.load()
            }
        }
    }
}
