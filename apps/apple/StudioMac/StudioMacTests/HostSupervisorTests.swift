import Foundation
import Testing
@testable import StudioMac

/// A process the test ends by hand.
private final class FakeProcess: RunningProcess, @unchecked Sendable {
    let pid: Int32
    private let lock = NSLock()
    private var status: Int32?
    private var waiters: [CheckedContinuation<Int32, Never>] = []
    private(set) var terminated = false

    init(pid: Int32) { self.pid = pid }

    func exit(_ code: Int32) {
        let resume = lock.withLock { () -> [CheckedContinuation<Int32, Never>] in
            guard status == nil else { return [] }
            status = code
            defer { waiters = [] }
            return waiters
        }
        resume.forEach { $0.resume(returning: code) }
    }

    func waitForExit() async -> Int32 {
        await withCheckedContinuation { continuation in
            let done: Int32? = lock.withLock {
                if let status { return status }
                waiters.append(continuation)
                return nil
            }
            if let done { continuation.resume(returning: done) }
        }
    }

    func terminate(grace: Duration) async {
        lock.withLock { terminated = true }
        exit(143)
    }
}

private final class FakeLauncher: ProcessLauncher, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var launched: [FakeProcess] = []
    private(set) var specs: [ProcessSpec] = []
    var failLaunch = false

    func launch(_ spec: ProcessSpec) throws -> any RunningProcess {
        try lock.withLock {
            if failLaunch { throw LaunchError(message: "yok") }
            let process = FakeProcess(pid: Int32(1000 + launched.count))
            launched.append(process)
            specs.append(spec)
            return process
        }
    }

    var count: Int { lock.withLock { launched.count } }
    var last: FakeProcess? { lock.withLock { launched.last } }
}

/// Records backoff delays instead of sleeping.
private final class Sleeps: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Duration] = []
    var recorded: [Duration] { lock.withLock { values } }
    var sleep: @Sendable (Duration) async throws -> Void {
        { [self] duration in
            lock.withLock { values.append(duration) }
            try Task.checkCancellation()
            await Task.yield()
        }
    }
}

@MainActor
private func until(_ condition: () -> Bool, timeout: Double = 2) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(2)) }
}

private let spec = ProcessSpec(
    name: "api", executable: URL(fileURLWithPath: "/usr/bin/true"), arguments: ["dev"],
    environment: ["PATH": "/usr/bin"], workingDirectory: URL(fileURLWithPath: "/tmp"),
    logFile: URL(fileURLWithPath: "/tmp/studio-test.log"))

@Suite("Host process supervision")
@MainActor
struct HostSupervisorTests {
    @Test func backoffDoublesUpToTheCap() {
        let policy = ServiceSupervisor.Policy(baseDelay: .seconds(1), maxDelay: .seconds(30))
        #expect((1...7).map { policy.delay(afterFailures: $0) } == [1, 2, 4, 8, 16, 30, 30].map { Duration.seconds($0) })
    }

    @Test func relaunchesCrashesWithBackoffAndPassesTheSpec() async {
        let launcher = FakeLauncher()
        let sleeps = Sleeps()
        var phases: [ServiceSupervisor.Phase] = []
        let supervisor = ServiceSupervisor(name: "API", spec: { spec }, launcher: launcher, sleep: sleeps.sleep)
        supervisor.onChange = { phases.append($0) }
        supervisor.start()

        for attempt in 1...3 {
            await until { launcher.count == attempt }
            #expect(supervisor.phase == .running(pid: Int32(999 + attempt)))
            launcher.last?.exit(1)
        }
        await until { launcher.count == 4 }
        #expect(sleeps.recorded == [.seconds(1), .seconds(2), .seconds(4)])
        #expect(phases.contains(.restarting(exitStatus: 1, delay: .seconds(2))))
        #expect(launcher.specs.allSatisfy { $0 == spec })

        await supervisor.stop()
        #expect(launcher.last?.terminated == true)
        #expect(supervisor.phase == .stopped)
        #expect(launcher.count == 4) // no relaunch after stop
    }

    @Test func aStableRunResetsTheCrashCounter() async {
        let launcher = FakeLauncher()
        let sleeps = Sleeps()
        var clock = ContinuousClock.now
        let supervisor = ServiceSupervisor(name: "Worker", spec: { spec }, launcher: launcher,
                                           policy: .init(stableAfter: .seconds(60)), sleep: sleeps.sleep, now: { clock })
        supervisor.start()
        await until { launcher.count == 1 }
        launcher.last?.exit(1)
        await until { launcher.count == 2 }
        launcher.last?.exit(1)
        await until { launcher.count == 3 }
        clock += .seconds(120) // the third run was long and healthy
        launcher.last?.exit(1)
        await until { launcher.count == 4 }
        #expect(sleeps.recorded == [.seconds(1), .seconds(2), .seconds(1)])
        await supervisor.stop()
    }

    @Test func givesUpAfterTooManyQuickCrashesAndCanStartAgain() async {
        let launcher = FakeLauncher()
        let supervisor = ServiceSupervisor(name: "API", spec: { spec }, launcher: launcher,
                                           policy: .init(maxQuickFailures: 3), sleep: Sleeps().sleep)
        supervisor.start()
        for attempt in 1...4 {
            await until { launcher.count == attempt }
            launcher.last?.exit(7)
        }
        await until { if case .failed = supervisor.phase { true } else { false } }
        guard case .failed(let message) = supervisor.phase else {
            Issue.record("expected failed, got \(supervisor.phase)")
            return
        }
        #expect(message.contains("çıkış kodu 7"))
        #expect(!supervisor.isActive)

        supervisor.start() // "Yeniden başlat"
        await until { launcher.count == 5 }
        #expect(supervisor.phase == .running(pid: 1004))
        await supervisor.stop()
    }

    @Test func aLaunchErrorFailsWithoutRetrying() async {
        let launcher = FakeLauncher()
        launcher.failLaunch = true
        let supervisor = ServiceSupervisor(name: "API", spec: { spec }, launcher: launcher, sleep: Sleeps().sleep)
        supervisor.start()
        await until { if case .failed = supervisor.phase { true } else { false } }
        #expect(supervisor.phase == .failed("yok"))
        #expect(launcher.count == 0)
    }

    @Test func stopDuringBackoffDoesNotRelaunch() async {
        let launcher = FakeLauncher()
        let gate = AsyncGate()
        let supervisor = ServiceSupervisor(name: "API", spec: { spec }, launcher: launcher,
                                           sleep: { _ in try await gate.wait() })
        supervisor.start()
        await until { launcher.count == 1 }
        launcher.last?.exit(1)
        await until { if case .restarting = supervisor.phase { true } else { false } }
        await supervisor.stop()
        #expect(supervisor.phase == .stopped)
        #expect(launcher.count == 1)
    }

    @Test func realLauncherCapturesOutputAndStopsTheGroup() async throws {
        let log = FileManager.default.temporaryDirectory.appending(path: "studio-host-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: log) }
        let launcher = PosixProcessLauncher()
        let echo = try launcher.launch(ProcessSpec(
            name: "echo", executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "echo merhaba $GREETING; exit 3"],
            environment: ["GREETING": "dünya"], workingDirectory: URL(fileURLWithPath: "/tmp"), logFile: log))
        #expect(await echo.waitForExit() == 3)
        #expect(try String(contentsOf: log, encoding: .utf8).contains("merhaba dünya"))

        // A child that ignores SIGTERM, with a grandchild: both end within the grace period.
        let stubborn = try launcher.launch(ProcessSpec(
            name: "stubborn", executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "trap '' TERM; sleep 30 & sleep 30"],
            environment: ["PATH": "/bin:/usr/bin"], workingDirectory: URL(fileURLWithPath: "/tmp"), logFile: log))
        try await Task.sleep(for: .milliseconds(200))
        #expect(kill(stubborn.pid, 0) == 0) // still running
        let started = ContinuousClock.now
        await stubborn.terminate(grace: .milliseconds(300))
        let took = ContinuousClock.now - started
        #expect(took >= .milliseconds(250)) // SIGTERM was ignored, SIGKILL after the grace period
        #expect(took < .seconds(5))
        #expect(kill(stubborn.pid, 0) != 0)
        #expect(killpg(stubborn.pid, 0) != 0) // group gone (no orphaned sleep)
    }
}

/// Blocks until cancelled.
private actor AsyncGate {
    func wait() async throws {
        while true {
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}
