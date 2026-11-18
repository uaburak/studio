import Foundation
import StudioKit

/// Uploads (photos for posts and the chat, files) go through a system background session, so
/// they keep going when the user leaves the app, and are tried again after a dropped
/// connection (Faz 6). `APIClient.uploadAsset` is unchanged for the callers.
enum IOSUploads {
    static let identifier = "net.burakkoc.studio.ios.uploads"

    /// One per process (a background session identifier may be used once).
    static let transport = BackgroundUploadTransport(identifier: identifier)

    static func configure(_ client: APIClient) {
        // Tests talk to in-memory backends and URLProtocol fakes: keep the in-process session.
        guard !AppDelegate.isUnderTest else { return }
        client.useUploads(transport: transport, retry: UploadRetryPolicy(maxAttempts: 3, initialDelay: .seconds(2)))
    }

    /// UIKit's completion handler, called once on the main thread.
    final class CompletionBox: @unchecked Sendable {
        private let handler: () -> Void
        init(_ handler: @escaping () -> Void) { self.handler = handler }
        func call() { handler() }
    }
}
