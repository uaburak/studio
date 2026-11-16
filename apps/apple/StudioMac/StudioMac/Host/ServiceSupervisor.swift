import Foundation

/// Keeps one child process running: launches it, relaunches it with
/// exponential backoff when it exits, gives up after too many quick crashes,
/// and stops it on request. Time and processes are injected for tests.
@MainActor
final class ServiceSupervisor {
    enum Phase: Equatable, Sendable {
        case idle
        case running(pid: Int32)
        /// Exited with `exitStatus`; relaunching after `delay`.
        case restarting(exitStatus: Int32, delay: Duration)
        case failed(String)
        case stopped
    }

    struct Policy: Sendable {
        var baseDelay: Duration = .seconds(1)
        var maxDelay: Duration = .seconds(30)
        /// A run at least this long resets the crash counter.
        var stableAfter: Duration = .seconds(60)
        /// Consecutive quick crashes before giving up (until `start` again).
        var maxQuickFailures = 8
        var stopGrace: Duration = .seconds(8)

        /// Delay before relaunch number `failures` (1-based): base, 2x, 4x, … capped.
        func delay(afterFailures failures: Int) -> Duration {
            var delay = baseDelay
            for _ in 1..<max(failures, 1) {
                delay = delay * 2
                if delay >= maxDelay { return maxDelay }
            }
            return min(delay, maxDelay)
        }
    }

    let name: String
    private let makeSpec: @MainActor () -> ProcessSpec
    private let launcher: any ProcessLauncher
    let policy: Policy
    private let sleep: @Sendable (Duration) async throws -> Void
    private let now: @MainActor () -> ContinuousClock.Instant

    private(set) var phase: Phase = .idle {
        didSet { if phase != oldValue { onChange?(phase) } }
    }
    private(set) var launches = 0
    var onChange: ((Phase) -> Void)?

    private var loop: Task<Void, Never>?
    private var current: (any RunningProcess)?
    private var stopping = false

    init(
        name: String,
        spec: @escaping @MainActor () -> ProcessSpec,
        launcher: any ProcessLauncher,
        policy: Policy = Policy(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        now: @escaping @MainActor () -> ContinuousClock.Instant = { ContinuousClock.now }
    ) {
        self.name = name
        makeSpec = spec
        self.launcher = launcher
        self.policy = policy
        self.sleep = sleep
        self.now = now
    }

    var isActive: Bool { loop != nil }

    func start() {
        guard loop == nil else { return }
        stopping = false
        loop = Task { await run() }
    }

    /// Terminate the child (SIGTERM, then SIGKILL after the grace period) and
    /// do not relaunch it. Returns when it has exited.
    func stop() async {
        stopping = true
        let task = loop
        if let current { await current.terminate(grace: policy.stopGrace) }
        task?.cancel()
        await task?.value
        loop = nil
        phase = .stopped
    }

    private func run() async {
        var quickFailures = 0
        while !stopping && !Task.isCancelled {
            let started = now()
            let process: any RunningProcess
            do {
                process = try launcher.launch(makeSpec())
            } catch {
                phase = .failed(error.localizedDescription)
                break
            }
            current = process
            launches += 1
            phase = .running(pid: process.pid)
            let status = await process.waitForExit()
            current = nil
            if stopping || Task.isCancelled { break }

            if now() - started >= policy.stableAfter { quickFailures = 0 }
            quickFailures += 1
            if quickFailures > policy.maxQuickFailures {
                phase = .failed("\(name) art arda \(quickFailures - 1) kez kapandı (son çıkış kodu \(status)).")
                break
            }
            let delay = policy.delay(afterFailures: quickFailures)
            phase = .restarting(exitStatus: status, delay: delay)
            do { try await sleep(delay) } catch { break }
        }
        if case .failed = phase {} else if stopping { phase = .stopped }
        loop = nil
    }
}
