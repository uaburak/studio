import Foundation

/// Seam for push notifications (PLAN.md §9: "üretim hazır, paylaşıldı, hata,
/// yeniden yetkilendirme gerekli"). Deliberately not implemented yet:
///
/// APNs needs an Apple Developer Program membership (the `aps-environment`
/// entitlement only signs with a team) and a server side that does not exist
/// yet. To turn it on later:
///
/// 1. Set `DEVELOPMENT_TEAM` in Config/Base.xcconfig and add the Push
///    Notifications capability (an entitlements file with `aps-environment`).
/// 2. Add a `UIApplicationDelegateAdaptor` to `StudioApp` that implements
///    `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
/// 3. Replace `DisabledPushRegistration` with an implementation that asks
///    `UNUserNotificationCenter` for permission, calls
///    `UIApplication.shared.registerForRemoteNotifications()` and sends the
///    token to the API (proposed endpoint: `POST /api/devices`, not in the
///    contract yet).
/// 4. The API (or the Mac worker, see PLAN.md §14 T6) sends the pushes.
protocol PushRegistering: Sendable {
    /// Whether this build can receive pushes at all.
    var isAvailable: Bool { get }
    func registerIfAllowed() async
}

struct DisabledPushRegistration: PushRegistering {
    var isAvailable: Bool { false }
    func registerIfAllowed() async {}
}
