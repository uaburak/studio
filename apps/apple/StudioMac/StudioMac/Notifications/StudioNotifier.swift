import AppKit
import Foundation
import StudioKit
import UserNotifications

/// Where notices go. Production: `UNUserNotificationCenter`; tests: a recorder.
@MainActor
protocol NoticePoster: AnyObject {
    func authorizationGranted() async -> Bool?
    func requestAuthorization() async -> Bool
    func post(_ notice: StudioNotice) async
}

/// macOS notifications for publishing, long jobs and account health (P3).
///
/// - Off/on in Ayarlar → Bildirimler, default on.
/// - Permission is asked in context: the first time the owner schedules or publishes a
///   post (or turns the switch on), never at launch.
/// - Each notice has a stable id; the last 500 posted ids are remembered, so a restart
///   or a second poll never posts the same event twice.
@MainActor
@Observable
final class StudioNotifier {
    static let enabledKey = "studio.notifications.enabled"
    static let askedKey = "studio.notifications.asked"
    static let postedKey = "studio.notifications.posted"

    private let defaults: UserDefaults
    private let poster: NoticePoster
    /// Notices posted in this session (newest last); the Settings screen and tests read it.
    private(set) var posted: [StudioNotice] = []
    private(set) var authorized: Bool?

    init(defaults: UserDefaults = .standard, poster: NoticePoster? = nil) {
        self.defaults = defaults
        self.poster = poster ?? UserNotificationPoster()
    }

    var enabled: Bool {
        get { defaults.object(forKey: Self.enabledKey) as? Bool ?? true }
        set {
            defaults.set(newValue, forKey: Self.enabledKey)
            if newValue { Task { await requestPermissionInContext() } }
        }
    }

    /// Ask once, when the owner does something that will produce notifications.
    func requestPermissionInContext() async {
        guard enabled else { return }
        if let granted = await poster.authorizationGranted() {
            authorized = granted
            if granted || defaults.bool(forKey: Self.askedKey) { return }
        }
        defaults.set(true, forKey: Self.askedKey)
        authorized = await poster.requestAuthorization()
    }

    private var postedIds: [String] {
        get { defaults.stringArray(forKey: Self.postedKey) ?? [] }
        set { defaults.set(Array(newValue.suffix(500)), forKey: Self.postedKey) }
    }

    func alreadyPosted(_ id: String) -> Bool { postedIds.contains(id) }

    /// Post new notices; returns the ones actually emitted.
    @discardableResult
    func post(_ notices: [StudioNotice]) async -> [StudioNotice] {
        guard enabled else { return [] }
        var ids = postedIds
        var emitted: [StudioNotice] = []
        for notice in notices where !ids.contains(notice.id) {
            ids.append(notice.id)
            emitted.append(notice)
        }
        guard !emitted.isEmpty else { return [] }
        postedIds = ids
        posted.append(contentsOf: emitted)
        if posted.count > 100 { posted.removeFirst(posted.count - 100) }
        for notice in emitted { await poster.post(notice) }
        return emitted
    }
}

/// `UNUserNotificationCenter`; clicking a notice with a permalink opens it in the browser.
@MainActor
final class UserNotificationPoster: NSObject, NoticePoster, UNUserNotificationCenterDelegate {
    private var center: UNUserNotificationCenter? {
        // Unit tests run without a real app bundle identifier; never touch the center there.
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    override init() {
        super.init()
        center?.delegate = self
    }

    func authorizationGranted() async -> Bool? {
        guard let center else { return nil }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional: return true
        case .denied: return false
        default: return nil
        }
    }

    func requestAuthorization() async -> Bool {
        guard let center else { return false }
        return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    func post(_ notice: StudioNotice) async {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.threadIdentifier = notice.kind.rawValue
        if let url = notice.url { content.userInfo = ["url": url] }
        if notice.kind == .publishFailed || notice.kind == .tokenInvalid { content.sound = .default }
        try? await center.add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let raw = response.notification.request.content.userInfo["url"] as? String
        await MainActor.run {
            if let raw, let url = URL(string: raw) {
                NSWorkspace.shared.open(url)
            } else {
                NSApp.activate()
            }
        }
    }
}
