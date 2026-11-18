import Foundation
import StudioKit
import UIKit
import UserNotifications
import WidgetKit

/// The widget follows the app (N22): when posts, approvals or publishes change, its timeline is
/// asked again (from the app this does not count against the widget's refresh budget).
@MainActor
enum IOSWidgets {
    private static var lastReload: Date?
    private static var trailing: Task<Void, Never>?
    /// At most one reload in this window; the last change still reloads at its end.
    static let window: TimeInterval = 20

    static func reload(force: Bool = false) {
        guard !AppDelegate.isUnderTest else { return }
        let now = Date()
        if !force, let lastReload, now.timeIntervalSince(lastReload) < window {
            guard trailing == nil else { return }
            let wait = window - now.timeIntervalSince(lastReload)
            trailing = Task { @MainActor in
                try? await Task.sleep(for: .seconds(wait))
                trailing = nil
                reload(force: true)
            }
            return
        }
        trailing?.cancel()
        trailing = nil
        lastReload = now
        WidgetCenter.shared.reloadTimelines(ofKind: StudioWidgetKind.main)
    }
}

/// Shares the share extension could not finish itself (N20): its sheet closed while a video was
/// still uploading. The system finishes the upload and wakes the app with the extension's session;
/// the app records the asset and sends the chat message or fills the post's slot.
@MainActor
enum IOSShareInbox {
    static var container: StudioSharedContainer { .current }
    /// The extension's background session, made only when the system hands its events to the app
    /// (two processes may not hold the same session at once).
    private static var transport: BackgroundUploadTransport?

    /// `handleEventsForBackgroundURLSession` for the extension's session; false for other ids.
    static func handleEvents(identifier: String, app: IOSAppModel, completion: @escaping () -> Void) -> Bool {
        guard identifier == container.shareUploadSessionId, let inbox = ShareInbox.standard(container: container) else { return false }
        let transport = self.transport ?? {
            let made = BackgroundUploadTransport(identifier: identifier, sharedContainerIdentifier: container.appGroupId)
            made.onFinishedElsewhere { upload in
                let share = inbox.record(upload)
                guard let share, share.isUploaded, share.deliveredAt == nil else { return }
                Task { @MainActor in await deliver(share, app: app) }
            }
            return made
        }()
        self.transport = transport
        let box = IOSUploads.CompletionBox(completion)
        transport.handleEvents { box.call() }
        return true
    }

    /// Shares whose files arrived while the app was away: finish them (after connecting).
    static func deliverReady(app: IOSAppModel) async {
        guard !app.isSample, let inbox = ShareInbox.standard(container: container) else { return }
        for share in inbox.readyToDeliver() { await deliver(share, app: app) }
        inbox.prune()
    }

    static func deliver(_ share: PendingShare, app: IOSAppModel) async {
        guard let inbox = ShareInbox.standard(container: container), !app.isSample else { return }
        // A little time when this runs in the background (the system woke the app for it).
        let task = UIApplication.shared.beginBackgroundTask(withName: "studio.share")
        defer { if task != .invalid { UIApplication.shared.endBackgroundTask(task) } }
        var share = share
        do {
            let result = try await ShareDelivery.deliver(share, client: app.client)
            share.deliveredAt = Date()
            inbox.remove(share.id)
            notify(title: "Studio'ya gönderildi", body: summary(result, share: share, brand: app.brand(share.brandId)?.name), link: link(result))
            switch result {
            case .conversation(let id):
                if let conversation = try? await app.client.conversation(id) { app.conversationUpdated(conversation) }
            case .post:
                await app.posts.load()
            case .media:
                break
            }
        } catch {
            let apiError = StudioAPIError.from(error)
            // Not reached the Mac: try again on the next launch.
            if MacLinkState.failure(for: apiError) == .notFound { return }
            share.failure = apiError.localizedDescription
            share.deliveredAt = Date()
            try? inbox.save(share)
            notify(title: "Paylaşım tamamlanamadı", body: apiError.localizedDescription, link: nil)
        }
    }

    static func summary(_ result: ShareDelivery.Result, share: PendingShare, brand: String?) -> String {
        let count = share.uploadedAssetIds.count
        let what = count == 1 ? "Dosya" : "\(count) dosya"
        var text: String
        switch result {
        case .media: text = "\(what) \(brand.map { "\($0) medyasına" } ?? "medyaya") yüklendi."
        case .conversation: text = "\(what) sohbete gönderildi."
        case .post: text = "Görsel posta konuyor; Mac yeni sürümü hazırlıyor."
        }
        if share.failedCount > 0 { text += " \(share.failedCount) dosya yüklenemedi." }
        return text
    }

    static func link(_ result: ShareDelivery.Result) -> StudioLink? {
        switch result {
        case .media: .media(brandId: nil)
        case .conversation(let id): .conversation(id)
        case .post(let id, _): .post(id)
        }
    }

    private static func notify(title: String, body: String, link: StudioLink?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let link { content.userInfo = ["link": link.url.absoluteString] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "share-\(UUID().uuidString)", content: content, trigger: nil))
    }
}
