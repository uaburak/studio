import StudioKit
import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static var isUnderTest: Bool { ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil }

    /// One model for the app's lifetime; the scene shows it.
    private(set) lazy var model: IOSAppModel = IOSAppModel(settings: IOSAppSettings())

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if !Self.isUnderTest {
            UNUserNotificationCenter.current().delegate = self
            IOSNotifier.registerBackgroundRefresh()
            PushRegistration.registerIfEnabled()
        }
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    // MARK: Background uploads

    /// The system finished (or needs the app for) uploads it kept sending while the app was away.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        // The share extension's uploads that ended after its sheet closed (N20).
        if IOSShareInbox.handleEvents(identifier: identifier, app: model, completion: completionHandler) { return }
        guard identifier == IOSUploads.identifier else {
            completionHandler()
            return
        }
        let box = IOSUploads.CompletionBox(completionHandler)
        IOSUploads.transport.handleEvents { box.call() }
    }

    // MARK: Remote notifications (seam; see PushRegistration)

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistration.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {}

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let route = IOSNotifier.route(from: response.notification.request.content.userInfo) else { return }
        await MainActor.run { self.model.open(route) }
    }
}
