import BackgroundTasks
import Foundation
import Observation
import StudioKit
import UIKit
import UserNotifications

/// Local notifications for work the Mac finished and for the agent waiting on the user.
///
/// While the app runs (foreground, or the ~30 s iOS keeps it alive after backgrounding)
/// the app model feeds `ActivityNotice`s from the live job stream and the open
/// conversations. In the background, a `BGAppRefreshTask` polls `GET /api/jobs` when iOS
/// grants time and announces jobs that finished since the app was last active.
@MainActor
@Observable
final class IOSNotifier {
    enum Delivery { case system, silent }

    nonisolated static let refreshTaskId = "net.burakkoc.studio.ios.refresh"

    let delivery: Delivery
    /// Everything handed to `post` (tests read it; the silent mode only records).
    private(set) var posted: [ActivityNotice] = []
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @ObservationIgnored private var askedThisLaunch = false

    init(delivering delivery: Delivery) {
        self.delivery = delivery
        if delivery == .system { Task { await refreshAuthorization() } }
    }

    var isAuthorized: Bool { authorization == .authorized || authorization == .provisional || authorization == .ephemeral }

    func refreshAuthorization() async {
        guard delivery == .system else { return }
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Ask once, the first time the app connected to a Mac.
    func requestAuthorizationIfNeeded() {
        guard delivery == .system, !askedThisLaunch else { return }
        askedThisLaunch = true
        Task {
            await refreshAuthorization()
            if authorization == .notDetermined { _ = await requestAuthorization() }
        }
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        guard delivery == .system else { return false }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshAuthorization()
        return granted
    }

    func post(_ notice: ActivityNotice) {
        posted.append(notice)
        guard delivery == .system else { return }
        UNUserNotificationCenter.current().add(Self.request(for: notice))
    }

    /// The user came back: tidy delivered banners and the badge.
    func clearDelivered() {
        guard delivery == .system else { return }
        UNUserNotificationCenter.current().setBadgeCount(0)
    }

    nonisolated static func request(for notice: ActivityNotice) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        content.threadIdentifier = notice.conversationId ?? notice.contentId ?? notice.kind.rawValue
        content.interruptionLevel = notice.kind == .waitingOnYou ? .timeSensitive : .active
        var info: [String: String] = ["kind": notice.kind.rawValue]
        if let id = notice.conversationId { info["conversationId"] = id }
        if let id = notice.contentId { info["contentId"] = id }
        if let id = notice.brandId { info["brandId"] = id }
        if notice.id.hasPrefix(ActivityNoticeTracker.claudeLimitPrefix) { info["route"] = "usage" }
        content.userInfo = info
        return UNNotificationRequest(identifier: notice.id, content: content, trigger: nil)
    }

    /// Where a tapped notification leads.
    nonisolated static func route(from userInfo: [AnyHashable: Any]) -> IOSRoute? {
        if userInfo["route"] as? String == "usage" { return .usage }
        if let id = userInfo["conversationId"] as? String { return .conversation(id) }
        if let id = userInfo["contentId"] as? String { return .post(id) }
        if let kind = userInfo["kind"] as? String {
            if kind == ActivityNotice.Kind.published.rawValue || kind == ActivityNotice.Kind.publishFailed.rawValue { return .calendar }
            if kind == ActivityNotice.Kind.brandProfileReady.rawValue, let id = userInfo["brandId"] as? String { return .brand(id) }
        }
        return nil
    }

    // MARK: Background refresh

    func scheduleBackgroundRefresh() {
        guard delivery == .system else { return }
        Self.submitRefreshRequest()
    }

    nonisolated static func submitRefreshRequest() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Called once at launch (AppDelegate), before the app finishes launching.
    nonisolated static func registerBackgroundRefresh() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshTaskId, using: nil) { task in
            let box = BackgroundTaskBox(task)
            let work = Task.detached { await BackgroundJobCheck.run() }
            task.expirationHandler = { work.cancel() }
            Task.detached {
                let ok = await work.value
                box.complete(ok)
                submitRefreshRequest()
            }
        }
    }
}

/// `BGTask` is not Sendable; it is only completed once, from one place.
private final class BackgroundTaskBox: @unchecked Sendable {
    private let task: BGTask
    init(_ task: BGTask) { self.task = task }
    func complete(_ success: Bool) { task.setTaskCompleted(success: success) }
}

/// The background pass: jobs that finished since the app was last active.
enum BackgroundJobCheck {
    static func run(defaults: UserDefaults = .standard) async -> Bool {
        let pairing = PairingClient(store: KeychainDeviceTokenStore())
        guard let credential = pairing.credential() else { return true }
        var baseURL = credential.serverURL
        if defaults.bool(forKey: IOSAppSettings.remoteEnabledKey),
           let raw = defaults.string(forKey: IOSAppSettings.remoteURLKey), let url = URL(string: raw), url.host != nil {
            baseURL = url
        }
        let client = APIClient(baseURL: baseURL, auth: DeviceTokenAuth(store: KeychainDeviceTokenStore()))
        let since = defaults.object(forKey: IOSAppSettings.lastBackgroundKey) as? Date ?? Date().addingTimeInterval(-3600)
        do {
            let jobs = try await client.jobs(limit: 50)
            let notices = ActivityNoticeTracker.notices(for: jobs, finishedAfter: since).filter { notice in
                defaults.object(forKey: IOSAppSettings.noticePrefix + notice.kind.category.rawValue) as? Bool ?? true
            }
            for notice in notices {
                try? await UNUserNotificationCenter.current().add(IOSNotifier.request(for: notice))
            }
            defaults.set(Date(), forKey: IOSAppSettings.lastBackgroundKey)
            return true
        } catch {
            return false
        }
    }
}

/// Seam for remote (APNs) pushes, so notifications arrive while the app is not running.
///
/// Not active: push needs an Apple Developer Program team with the Push Notifications
/// capability (the `aps-environment` entitlement), and this app is signed with a wildcard
/// development profile that cannot carry it. To turn it on:
/// 1. Add the capability, then set `studio.ios.push.enabled` (UserDefaults) to true.
/// 2. `AppDelegate` already forwards the device token to `didRegister(deviceToken:)`.
/// 3. Add `POST /api/devices/push-token` on the API (device-scoped) and send the token
///    there; the worker / cloud publisher then sends the same `ActivityNotice`
///    title/body/userInfo through APNs, and `IOSNotifier.route(from:)` handles the tap.
enum PushRegistration {
    static let enabledKey = "studio.ios.push.enabled"
    static let tokenKey = "studio.ios.push.token"

    static var isEnabled: Bool { UserDefaults.standard.bool(forKey: enabledKey) }

    @MainActor
    static func registerIfEnabled() {
        guard isEnabled else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    static func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: tokenKey)
        // Next step (needs the API route above): send `hex` with the paired device token.
    }
}
