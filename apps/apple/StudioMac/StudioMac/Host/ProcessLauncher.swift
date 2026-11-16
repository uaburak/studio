import Darwin
import Foundation

/// One child process the host runs (API, LAN gateway, worker, migrations).
struct ProcessSpec: Sendable, Equatable {
    var name: String
    var executable: URL
    var arguments: [String]
    /// The complete environment (nothing is inherited from the app).
    var environment: [String: String]
    var workingDirectory: URL
    /// stdout and stderr are appended here.
    var logFile: URL
}

protocol RunningProcess: AnyObject, Sendable {
    var pid: Int32 { get }
    /// Exit code, or 128 + signal number when killed by a signal.
    func waitForExit() async -> Int32
    /// SIGTERM to the process; SIGKILL to its whole process group after `grace`.
    /// Returns once it has exited.
    func terminate(grace: Duration) async
}

protocol ProcessLauncher: Sendable {
    func launch(_ spec: ProcessSpec) throws -> any RunningProcess
}

struct LaunchError: Error, LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// `posix_spawn` in a new process group, stdin from /dev/null, stdout+stderr
/// appended to the spec's log file, no other descriptors inherited. Each child
/// is reaped by its own waiter thread; when it exits, whatever is left of its
/// process group (e.g. workerd under wrangler) is killed so nothing outlives it.
struct PosixProcessLauncher: ProcessLauncher {
    func launch(_ spec: ProcessSpec) throws -> any RunningProcess {
        guard FileManager.default.isExecutableFile(atPath: spec.executable.path) else {
            throw LaunchError(message: "\(spec.executable.path) çalıştırılamıyor")
        }
        try FileManager.default.createDirectory(at: spec.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let header = "\n=== \(Date().formatted(.iso8601)) \(spec.name): \(([spec.executable.path] + spec.arguments).joined(separator: " "))\n"
        if let handle = FileHandle(forWritingAtPath: spec.logFile.path) ?? {
            FileManager.default.createFile(atPath: spec.logFile.path, contents: nil)
            return FileHandle(forWritingAtPath: spec.logFile.path)
        }() {
            handle.seekToEndOfFile()
            handle.write(Data(header.utf8))
            try? handle.close()
        }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, spec.logFile.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)
        posix_spawn_file_actions_addchdir_np(&actions, spec.workingDirectory.path)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
        posix_spawnattr_setpgroup(&attributes, 0)
        var defaults = sigset_t()
        sigfillset(&defaults)
        posix_spawnattr_setsigdefault(&attributes, &defaults)
        var empty = sigset_t()
        sigemptyset(&empty)
        posix_spawnattr_setsigmask(&attributes, &empty)

        let argv = ([spec.executable.path] + spec.arguments).map { strdup($0) } + [nil]
        let envp = spec.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        let result = posix_spawn(&pid, spec.executable.path, &actions, &attributes, argv, envp)
        guard result == 0 else {
            throw LaunchError(message: "\(spec.name) başlatılamadı: \(String(cString: strerror(result)))")
        }
        return PosixProcess(pid: pid, name: spec.name, logFile: spec.logFile)
    }
}

final class PosixProcess: RunningProcess, @unchecked Sendable {
    let pid: Int32
    private let name: String
    /// Gets an `=== … exited` line, so a silent child still leaves a trace.
    private let logFile: URL?
    private let lock = NSLock()
    private var status: Int32?
    private var waiters: [CheckedContinuation<Int32, Never>] = []

    init(pid: Int32, name: String = "", logFile: URL? = nil) {
        self.pid = pid
        self.name = name
        self.logFile = logFile
        let thread = Thread { [self] in reap() }
        thread.name = "studio.reap.\(pid)"
        thread.start()
    }

    private func reap() {
        var raw: Int32 = 0
        var result: pid_t
        repeat { result = waitpid(pid, &raw, 0) } while result == -1 && errno == EINTR
        let code: Int32
        if result == -1 {
            code = -1
        } else if raw & 0x7f == 0 {
            code = (raw >> 8) & 0xff // WEXITSTATUS
        } else {
            code = 128 + (raw & 0x7f) // WTERMSIG
        }
        // Leftovers of the group (children of the child) must not outlive it.
        killpg(pid, SIGKILL)
        if let logFile, let handle = FileHandle(forWritingAtPath: logFile.path) {
            handle.seekToEndOfFile()
            handle.write(Data("=== \(Date().formatted(.iso8601)) \(name) bitti (çıkış kodu \(code))\n".utf8))
            try? handle.close()
        }
        let resume = lock.withLock {
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

    var hasExited: Bool { lock.withLock { status != nil } }

    func terminate(grace: Duration) async {
        if hasExited { return }
        kill(pid, SIGTERM)
        let pid = self.pid
        let killer = Task.detached {
            try await Task.sleep(for: grace)
            killpg(pid, SIGKILL)
        }
        _ = await waitForExit()
        killer.cancel()
    }
}
