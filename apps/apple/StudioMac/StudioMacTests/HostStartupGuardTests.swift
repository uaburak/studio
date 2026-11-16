import Darwin
import Foundation
import Testing
@testable import StudioMac

/// A process that only ends when the test says so (or never), and records terminate calls.
private final class ManualProcess: RunningProcess, @unchecked Sendable {
    let pid: Int32 = 4242
    /// When false, `terminate` does not end it (a child stuck in the kernel).
    let obeysTerminate: Bool
    private let lock = NSLock()
    private var status: Int32?
    private var waiters: [CheckedContinuation<Int32, Never>] = []
    private var terminateCalls = 0

    init(obeysTerminate: Bool) { self.obeysTerminate = obeysTerminate }

    var terminated: Int { lock.withLock { terminateCalls } }

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
        lock.withLock { terminateCalls += 1 }
        if obeysTerminate { exit(143) }
    }
}

private func tempLog() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "studio-guard-\(UUID().uuidString).log")
}

/// Unblocks a thread from the test.
private final class Gate: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    func wait() { semaphore.wait() }
    func open() { semaphore.signal() }
}

@MainActor
private final class Counter {
    var value = 0
}

@Suite("Host startup guards (H1)")
@MainActor
struct HostStartupGuardTests {
    // MARK: One-shot runs (migrations)

    @Test func aQuickCommandExitsAndLeavesOutputAndExitLineInTheLog() async throws {
        let log = tempLog()
        defer { try? FileManager.default.removeItem(at: log) }
        let process = try PosixProcessLauncher().launch(ProcessSpec(
            name: "migrate", executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "echo No migrations to apply; exit 0"],
            environment: ["PATH": "/bin:/usr/bin"], workingDirectory: URL(fileURLWithPath: "/tmp"), logFile: log))
        #expect(await OneShotRun.wait(for: process, timeout: .seconds(10)) == .exited(0))
        let text = try String(contentsOf: log, encoding: .utf8)
        #expect(text.contains("migrate: /bin/sh"))
        #expect(text.contains("No migrations to apply"))
        #expect(text.contains("migrate bitti (çıkış kodu 0)"))
    }

    @Test func aFailingCommandReportsItsExitCode() async throws {
        let log = tempLog()
        defer { try? FileManager.default.removeItem(at: log) }
        let process = try PosixProcessLauncher().launch(ProcessSpec(
            name: "migrate", executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "exit 7"],
            environment: [:], workingDirectory: URL(fileURLWithPath: "/tmp"), logFile: log))
        #expect(await OneShotRun.wait(for: process, timeout: .seconds(10)) == .exited(7))
        #expect(try String(contentsOf: log, encoding: .utf8).contains("bitti (çıkış kodu 7)"))
    }

    @Test func aHangingCommandTimesOutAndIsKilled() async throws {
        let log = tempLog()
        defer { try? FileManager.default.removeItem(at: log) }
        // Ignores SIGTERM like a child blocked before its handlers matter; has a grandchild.
        let process = try PosixProcessLauncher().launch(ProcessSpec(
            name: "migrate", executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "trap '' TERM; sleep 30 & sleep 30"],
            environment: ["PATH": "/bin:/usr/bin"], workingDirectory: URL(fileURLWithPath: "/tmp"), logFile: log))
        let started = ContinuousClock.now
        let outcome = await OneShotRun.wait(for: process, timeout: .milliseconds(300), grace: .milliseconds(200))
        #expect(outcome == .timedOut) // not "exit code 137"
        #expect(ContinuousClock.now - started < .seconds(3))
        try await Task.sleep(for: .milliseconds(100))
        #expect(kill(process.pid, 0) != 0)
        #expect(killpg(process.pid, 0) != 0)
    }

    @Test func aChildThatCannotBeReapedStillTimesOut() async {
        let process = ManualProcess(obeysTerminate: false)
        let started = ContinuousClock.now
        let outcome = await OneShotRun.wait(for: process, timeout: .milliseconds(100), grace: .milliseconds(100))
        #expect(outcome == .timedOut)
        #expect(ContinuousClock.now - started < .seconds(4))
        #expect(process.terminated == 1)
        process.exit(0) // release the waiter
    }

    @Test func aTimeoutThatEndsTheChildIsStillReportedAsTimeout() async {
        let process = ManualProcess(obeysTerminate: true) // exits 143 on SIGTERM
        #expect(await OneShotRun.wait(for: process, timeout: .milliseconds(50)) == .timedOut)
    }

    @Test func cancellingTheStartTerminatesTheChild() async {
        let process = ManualProcess(obeysTerminate: true)
        let task = Task { await OneShotRun.wait(for: process, timeout: .seconds(60)) }
        try? await Task.sleep(for: .milliseconds(50))
        task.cancel()
        #expect(await task.value == .cancelled)
        let deadline = ContinuousClock.now + .seconds(2)
        while process.terminated == 0 && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(process.terminated == 1)
    }

    // MARK: Repo access (macOS privacy prompt)

    @Test func aReadableRepoPassesWithoutAHint() async {
        let hints = Counter()
        let outcome = await RepoAccess.check(read: { 0 }, noticeAfter: .milliseconds(200), limit: .seconds(5),
                                             onWaiting: { hints.value += 1 })
        #expect(outcome == .readable)
        try? await Task.sleep(for: .milliseconds(300))
        #expect(hints.value == 0)
    }

    @Test func aBlockedReadShowsTheHintThenContinuesWhenGranted() async {
        let gate = Gate()
        let hints = Counter()
        let task = Task { @MainActor in
            await RepoAccess.check(read: { gate.wait(); return 0 }, noticeAfter: .milliseconds(50), limit: .seconds(10),
                                   onWaiting: { hints.value += 1 })
        }
        let deadline = ContinuousClock.now + .seconds(2)
        while hints.value == 0 && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(hints.value == 1)
        gate.open() // the owner clicked "Allow"
        #expect(await task.value == .readable)
    }

    @Test func aDeniedReadIsReported() async {
        let outcome = await RepoAccess.check(read: { EPERM }, noticeAfter: .seconds(1), limit: .seconds(5), onWaiting: {})
        #expect(outcome == .denied(errno: EPERM))
        let repo = URL(fileURLWithPath: NSHomeDirectory()).appending(path: "Desktop/Studio")
        let message = RepoAccess.failureMessage(outcome, repo: repo, probe: repo.appending(path: "apps/api/package.json"))
        #expect(message.contains("izin vermiyor"))
        #expect(message.contains("Dosyalar ve Klasörler → Studio → Masaüstü Klasörü"))
    }

    @Test func anUnansweredPromptGivesUpAtTheLimit() async {
        let gate = Gate()
        let outcome = await RepoAccess.check(read: { gate.wait(); return 0 }, noticeAfter: .milliseconds(10),
                                             limit: .milliseconds(100), onWaiting: {})
        #expect(outcome == .stillWaiting)
        gate.open()
    }

    @Test func theRealProbeReadsAFileAndReportsAMissingOne() async throws {
        let file = tempLog()
        try Data("{}".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(RepoAccess.openForReading(file)() == 0)
        #expect(RepoAccess.openForReading(file.appendingPathExtension("yok"))() == ENOENT)
    }

    @Test func protectedFoldersAndMessages() {
        let home = "/Users/test"
        #expect(RepoAccess.protectedFolder(containing: URL(fileURLWithPath: "/Users/test/Desktop/Burak/Code/Studio"), home: home) == "Masaüstü Klasörü")
        #expect(RepoAccess.protectedFolder(containing: URL(fileURLWithPath: "/Users/test/Documents/Studio"), home: home) == "Belgeler Klasörü")
        #expect(RepoAccess.protectedFolder(containing: URL(fileURLWithPath: "/Users/test/Desktopish/Studio"), home: home) == nil)
        #expect(RepoAccess.protectedFolder(containing: URL(fileURLWithPath: "/Users/test/Code/Studio"), home: home) == nil)

        let desktopRepo = URL(fileURLWithPath: NSHomeDirectory()).appending(path: "Desktop/Burak/Code/Studio")
        #expect(RepoAccess.waitingMessage(repo: desktopRepo).contains("İzin Ver"))
        let timeout = LocalHost.migrationTimeoutMessage(seconds: 120, repo: desktopRepo)
        #expect(timeout.contains("120 sn içinde bitmedi"))
        #expect(timeout.contains("Masaüstü Klasörü"))
        #expect(!LocalHost.migrationTimeoutMessage(seconds: 120, repo: URL(fileURLWithPath: "/opt/studio")).contains("korumalı"))
    }
}
