import Foundation
import Synchronization

/// Sends an upload's body (`POST /api/assets`) and returns the raw answer. The default sends it
/// with the client's session while the app runs; `BackgroundUploadTransport` hands it to the
/// system so it goes on when the user leaves the app (Faz 6: "büyük yüklemeler kesiliyor").
public protocol UploadTransport: Sendable {
    func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse)
}

/// In-process upload with the client's `URLSession` (what every upload did before).
public struct ForegroundUploadTransport: UploadTransport {
    public let session: URLSession

    public init(session: URLSession) { self.session = session }

    public func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        let delegate = progress.map { UploadProgressDelegate(onProgress: $0) }
        return try await session.upload(for: request, from: body, delegate: delegate)
    }
}

/// When an upload is tried again (pure; tested).
public struct UploadRetryPolicy: Sendable, Equatable {
    public var maxAttempts: Int
    /// Wait before the 2nd attempt; doubles after each failure.
    public var initialDelay: Duration

    public init(maxAttempts: Int = 3, initialDelay: Duration = .seconds(2)) {
        self.maxAttempts = max(1, maxAttempts)
        self.initialDelay = initialDelay
    }

    public static let none = UploadRetryPolicy(maxAttempts: 1, initialDelay: .zero)

    /// Connection trouble and gateway errors are worth another try; refusals (4xx) are not.
    public static func isRetryable(_ error: StudioAPIError) -> Bool {
        switch error {
        case .offline, .timedOut, .transport: true
        case .http(let status), .server(let status, _, _, _): status == 502 || status == 503 || status == 504 || status == 429
        default: false
        }
    }

    public func delay(beforeAttempt attempt: Int) -> Duration {
        guard attempt > 1 else { return .zero }
        return initialDelay * (1 << min(attempt - 2, 6))
    }
}

/// A system background `URLSession` for uploads: the system keeps sending while the app is
/// suspended and wakes it when done (`handleEvents`). The body goes to a file first (background
/// sessions upload from files only); the file is deleted when the task ends.
///
/// When the app was terminated meanwhile, the upload still finishes on the Mac, but the waiting
/// caller is gone (a new launch does not resume it).
public final class BackgroundUploadTransport: NSObject, UploadTransport, URLSessionDataDelegate, @unchecked Sendable {
    private struct Entry {
        var continuation: CheckedContinuation<(Data, URLResponse), any Error>
        var progress: (@Sendable (Double) -> Void)?
        var data = Data()
        var file: URL
    }

    public let identifier: String
    private let state = Mutex<[Int: Entry]>([:])
    private let finishEvents = Mutex<(@Sendable () -> Void)?>(nil)
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.timeoutIntervalForResource = 60 * 60
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private let sessionLock = NSLock()

    public init(identifier: String) {
        self.identifier = identifier
        super.init()
    }

    private var activeSession: URLSession {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        return session
    }

    /// The app delegate's `handleEventsForBackgroundURLSession`: call `completion` once the
    /// session delivered everything.
    public func handleEvents(completion: @escaping @Sendable () -> Void) {
        finishEvents.withLock { $0 = completion }
        _ = activeSession
    }

    public func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("studio-upload-\(UUID().uuidString)")
        try body.write(to: file, options: .atomic)
        var request = request
        request.httpBody = nil
        let task = activeSession.uploadTask(with: request, fromFile: file)
        let id = task.taskIdentifier
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.withLock { $0[id] = Entry(continuation: continuation, progress: progress, file: file) }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0, let progress = state.withLock({ $0[task.taskIdentifier]?.progress }) else { return }
        progress(min(0.97, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        state.withLock { $0[dataTask.taskIdentifier]?.data.append(data) }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let entry = state.withLock({ $0.removeValue(forKey: task.taskIdentifier) }) else { return }
        try? FileManager.default.removeItem(at: entry.file)
        if let error {
            entry.continuation.resume(throwing: error)
        } else if let response = task.response {
            entry.continuation.resume(returning: (entry.data, response))
        } else {
            entry.continuation.resume(throwing: URLError(.badServerResponse))
        }
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = finishEvents.withLock { value -> (@Sendable () -> Void)? in
            defer { value = nil }
            return value
        }
        guard let completion else { return }
        DispatchQueue.main.async { completion() }
    }
}
