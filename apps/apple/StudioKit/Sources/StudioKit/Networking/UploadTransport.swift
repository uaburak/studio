import Foundation
import Synchronization

/// Sends an upload's body (`POST /api/assets`) and returns the raw answer. The default sends it
/// with the client's session while the app runs; `BackgroundUploadTransport` hands it to the
/// system so it goes on when the user leaves the app (Faz 6: "büyük yüklemeler kesiliyor").
public protocol UploadTransport: Sendable {
    func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse)
    /// Send a body that is already on disk (large files, videos). `tag` names the upload for a
    /// process that may finish it after this one is gone (the share extension's background
    /// session); the caller deletes the file.
    func upload(_ request: URLRequest, bodyFile: URL, tag: String?, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse)
}

extension UploadTransport {
    /// Transports that only know in-memory bodies read the file.
    public func upload(_ request: URLRequest, bodyFile: URL, tag: String?, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        try await upload(request, body: try Data(contentsOf: bodyFile, options: .mappedIfSafe), progress: progress)
    }
}

/// In-process upload with the client's `URLSession` (what every upload did before).
public struct ForegroundUploadTransport: UploadTransport {
    public let session: URLSession

    public init(session: URLSession) { self.session = session }

    public func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        let delegate = progress.map { UploadProgressDelegate(onProgress: $0) }
        return try await session.upload(for: request, from: body, delegate: delegate)
    }

    public func upload(_ request: URLRequest, bodyFile: URL, tag: String?, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        let delegate = progress.map { UploadProgressDelegate(onProgress: $0) }
        var request = request
        request.httpBody = nil
        return try await session.upload(for: request, fromFile: bodyFile, delegate: delegate)
    }
}

/// An upload that finished in this process although another one started it (the share
/// extension was closed while its video was still going): the tag it was started with and the
/// server's answer.
public struct FinishedBackgroundUpload: Sendable {
    public var tag: String
    public var status: Int?
    public var body: Data
    /// Transport error (nil when the server answered).
    public var error: String?

    public init(tag: String, status: Int?, body: Data, error: String?) {
        self.tag = tag
        self.status = status
        self.body = body
        self.error = error
    }

    /// The stored asset, when the server took the file.
    public var asset: Asset? {
        guard let status, (200..<300).contains(status) else { return nil }
        return try? StudioJSON.decoder().decode(Asset.self, from: body)
    }

    /// Why it failed, in Turkish (nil when it worked).
    public var failure: String? {
        if let error { return error }
        guard let status else { return "Yükleme tamamlanamadı." }
        if (200..<300).contains(status) { return asset == nil ? "Mac'in cevabı okunamadı." : nil }
        return StudioAPIError.from(status: status, body: body).localizedDescription
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
        /// A temporary body file this transport wrote (deleted when the task ends).
        var file: URL?
    }

    public let identifier: String
    /// The App Group, for a session an app extension starts (its files must live there).
    public let sharedContainerIdentifier: String?
    private let state = Mutex<[Int: Entry]>([:])
    /// Answers of tasks no caller waits for (started by a process that is gone).
    private let orphans = Mutex<[Int: Data]>([:])
    private let orphanHandler = Mutex<(@Sendable (FinishedBackgroundUpload) -> Void)?>(nil)
    private let finishEvents = Mutex<(@Sendable () -> Void)?>(nil)
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.timeoutIntervalForResource = 60 * 60
        if let sharedContainerIdentifier { config.sharedContainerIdentifier = sharedContainerIdentifier }
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private let sessionLock = NSLock()

    public init(identifier: String, sharedContainerIdentifier: String? = nil) {
        self.identifier = identifier
        self.sharedContainerIdentifier = sharedContainerIdentifier
        super.init()
    }

    /// Where uploads started by another process (and finished here) are reported.
    public func onFinishedElsewhere(_ handler: @escaping @Sendable (FinishedBackgroundUpload) -> Void) {
        orphanHandler.withLock { $0 = handler }
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
        let folder = sharedContainerIdentifier
            .flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }?
            .appendingPathComponent("Uploads", isDirectory: true) ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("studio-upload-\(UUID().uuidString)")
        try body.write(to: file, options: .atomic)
        return try await send(request, file: file, ownsFile: true, tag: nil, progress: progress)
    }

    public func upload(_ request: URLRequest, bodyFile: URL, tag: String?, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        try await send(request, file: bodyFile, ownsFile: false, tag: tag, progress: progress)
    }

    private func send(_ request: URLRequest, file: URL, ownsFile: Bool, tag: String?, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        var request = request
        request.httpBody = nil
        let task = activeSession.uploadTask(with: request, fromFile: file)
        // Survives this process: the app reads it when it finishes the upload instead.
        task.taskDescription = tag
        let id = task.taskIdentifier
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.withLock { $0[id] = Entry(continuation: continuation, progress: progress, file: ownsFile ? file : nil) }
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
        let known = state.withLock { entries -> Bool in
            guard entries[dataTask.taskIdentifier] != nil else { return false }
            entries[dataTask.taskIdentifier]?.data.append(data)
            return true
        }
        if !known { orphans.withLock { $0[dataTask.taskIdentifier, default: Data()].append(data) } }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let entry = state.withLock({ $0.removeValue(forKey: task.taskIdentifier) }) else {
            // Started by a process that is gone (the share extension): report it by its tag.
            let body = orphans.withLock { $0.removeValue(forKey: task.taskIdentifier) } ?? Data()
            guard let tag = task.taskDescription, !tag.isEmpty, let handler = orphanHandler.withLock({ $0 }) else { return }
            handler(FinishedBackgroundUpload(
                tag: tag, status: (task.response as? HTTPURLResponse)?.statusCode, body: body,
                error: error.map { StudioAPIError.from($0).localizedDescription }))
            return
        }
        if let file = entry.file { try? FileManager.default.removeItem(at: file) }
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
