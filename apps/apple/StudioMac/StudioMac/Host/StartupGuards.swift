import Darwin
import Foundation

/// Hands out one result to one waiter: whichever racer (the work, a timer,
/// cancellation) resolves first wins; later resolutions are ignored.
final class FirstOutcome<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Value?
    private var continuation: CheckedContinuation<Value, Never>?

    var isResolved: Bool { lock.withLock { result != nil } }

    func resolve(_ value: Value) {
        let waiting: CheckedContinuation<Value, Never>? = lock.withLock {
            guard result == nil else { return nil }
            result = value
            defer { continuation = nil }
            return continuation
        }
        waiting?.resume(returning: value)
    }

    func value() async -> Value {
        await withCheckedContinuation { continuation in
            let done: Value? = lock.withLock {
                if let result { return result }
                self.continuation = continuation
                return nil
            }
            if let done { continuation.resume(returning: done) }
        }
    }
}

/// A one-shot child (D1 migrations) with a hard time limit.
enum OneShotRun {
    enum Outcome: Equatable, Sendable {
        case exited(Int32)
        /// Did not finish in time; it was terminated (SIGTERM, then SIGKILL to its group).
        case timedOut
        /// The surrounding task was cancelled (host stopped); the child was terminated.
        case cancelled
    }

    /// Waits for `process` to exit, at most `timeout`. Returns `.timedOut` even if the
    /// child cannot be reaped afterwards (e.g. stuck in the kernel), so a caller never
    /// waits longer than `timeout + grace + 2 s`.
    static func wait(for process: any RunningProcess, timeout: Duration, grace: Duration = .seconds(3)) async -> Outcome {
        let outcome = FirstOutcome<Outcome>()
        let expired = FirstOutcome<Bool>()
        Task.detached {
            let code = await process.waitForExit()
            outcome.resolve(expired.isResolved ? .timedOut : .exited(code))
        }
        let watchdog = Task.detached {
            try await Task.sleep(for: timeout)
            expired.resolve(true)
            let killer = Task.detached { await process.terminate(grace: grace) }
            try await Task.sleep(for: grace + .seconds(2))
            killer.cancel()
            outcome.resolve(.timedOut)
        }
        let result = await withTaskCancellationHandler {
            await outcome.value()
        } onCancel: {
            outcome.resolve(.cancelled)
            Task.detached { await process.terminate(grace: grace) }
        }
        watchdog.cancel()
        return result
    }
}

/// macOS privacy protection (TCC) guards Desktop, Documents and Downloads. A child the
/// app spawns counts as the app itself, so when the repo lives in one of those folders
/// and the app has no grant (ad-hoc signed rebuilds lose it: the grant is tied to the
/// exact code signature), `open()` of any repo file blocks in the kernel while macOS
/// shows its consent prompt, and wrangler hangs before printing anything. The host
/// therefore reads one repo file itself first, on a thread of its own, and tells the
/// owner what to do while it waits.
enum RepoAccess {
    enum Outcome: Equatable, Sendable {
        case readable
        case denied(errno: Int32)
        /// Still blocked after `limit`.
        case stillWaiting
        case cancelled
    }

    /// Runs `read` (returns 0 or an errno) on its own thread. Calls `onWaiting` once if it
    /// has not finished after `noticeAfter`; gives up after `limit`.
    static func check(read: @escaping @Sendable () -> Int32,
                      noticeAfter: Duration, limit: Duration,
                      onWaiting: @escaping @MainActor @Sendable () -> Void) async -> Outcome {
        let outcome = FirstOutcome<Outcome>()
        let thread = Thread {
            let error = read()
            outcome.resolve(error == 0 ? .readable : .denied(errno: error))
        }
        thread.name = "studio.repo-access"
        thread.start()
        let notice = Task { @MainActor in
            try? await Task.sleep(for: noticeAfter)
            if !Task.isCancelled && !outcome.isResolved { onWaiting() }
        }
        let timer = Task.detached {
            try await Task.sleep(for: limit)
            outcome.resolve(.stillWaiting)
        }
        let result = await withTaskCancellationHandler {
            await outcome.value()
        } onCancel: {
            outcome.resolve(.cancelled)
        }
        notice.cancel()
        timer.cancel()
        return result
    }

    /// `open(2)` + `close(2)`: 0 when readable, else errno.
    static func openForReading(_ url: URL) -> @Sendable () -> Int32 {
        let path = url.path
        return {
            let fd = open(path, O_RDONLY | O_CLOEXEC)
            if fd < 0 { return errno }
            close(fd)
            return 0
        }
    }

    /// The protected folder (as named in System Settings) that contains `url`, if any.
    static func protectedFolder(containing url: URL, home: String = NSHomeDirectory()) -> String? {
        let path = url.standardizedFileURL.path
        for (folder, name) in [("Desktop", "Masaüstü Klasörü"), ("Documents", "Belgeler Klasörü"), ("Downloads", "İndirilenler Klasörü")] {
            let root = (home as NSString).appendingPathComponent(folder)
            if path == root || path.hasPrefix(root + "/") { return name }
        }
        return nil
    }

    /// Where the owner grants access, for messages.
    static func settingsHint(for repo: URL) -> String {
        let folder = protectedFolder(containing: repo).map { " → \($0)" } ?? ""
        return "Sistem Ayarları → Gizlilik ve Güvenlik → Dosyalar ve Klasörler → Studio\(folder)"
    }

    static func waitingMessage(repo: URL) -> String {
        "macOS, Studio'nun depo klasörüne erişim izni istiyor. Açılan pencerede “İzin Ver”e tıkla "
            + "(ya da \(settingsHint(for: repo)) iznini aç); izin gelince Studio kendiliğinden başlar."
    }

    static func failureMessage(_ outcome: Outcome, repo: URL, probe: URL) -> String {
        switch outcome {
        case .denied(let error) where error == EPERM || error == EACCES:
            return "macOS, Studio'nun depo klasörünü okumasına izin vermiyor (\(probe.path)). "
                + "\(settingsHint(for: repo)) iznini açıp Studio'yu yeniden başlat."
        case .denied(let error):
            return "Depo dosyası okunamadı (\(probe.path)): \(String(cString: strerror(error)))."
        case .stillWaiting:
            return "Depo klasörüne erişim izni yanıtsız kaldı (macOS izin penceresi onaylanmadı). "
                + "\(settingsHint(for: repo)) iznini açıp Studio'yu yeniden başlat."
        case .readable, .cancelled:
            return ""
        }
    }
}
