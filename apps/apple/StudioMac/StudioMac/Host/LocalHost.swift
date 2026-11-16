import AppKit
import Foundation
import StudioKit

/// What the host needs from Settings.
struct HostConfiguration: Equatable, Sendable {
    var repoPath: String
    var lanEnabled: Bool
    var remoteControlEnabled: Bool = false
    var remoteHostname: String = AppSettings.defaultRemoteHostname
    var tunnelToken: String? = nil
    var preferredAPIPort = 8790
    var preferredLANPort = 8791
}

/// Runs the Studio back end on this Mac (task L1): the API (wrangler dev /
/// workerd, state under ~/Library/Application Support/Studio), the LAN
/// gateway and the worker, as supervised child processes. Applies D1
/// migrations first, restarts crashed children with backoff, keeps logs,
/// advertises the gateway with Bonjour and stops everything on quit.
///
/// If the API port already answers /api/health with this host's instance id
/// (another copy of the app, or children left by a crash), it attaches
/// instead of starting a second copy.
@MainActor
@Observable
final class LocalHost {
    enum Status: Equatable {
        case stopped
        case starting(String)
        case running
        /// Another instance of this app already serves the API.
        case attached
        case error(String)
    }

    enum Service: String, CaseIterable {
        case api, gateway, worker, tunnel
        var label: String {
            switch self {
            case .api: "API"
            case .gateway: "Yerel ağ geçidi"
            case .worker: "Worker"
            case .tunnel: "Uzaktan erişim tüneli"
            }
        }
    }

    private(set) var status: Status = .stopped
    private(set) var apiPort: Int?
    private(set) var lanPort: Int?
    private(set) var phases: [Service: ServiceSupervisor.Phase] = [:]
    /// Setup hint or active URL for the Cloudflare Remote Control tunnel (`L3`).
    private(set) var tunnelNote: String?
    /// Last lines of the log that explains the current error.
    private(set) var errorLog = ""
    /// Called when the API address changes (the app rebuilds its client).
    var onAPIURLChange: ((URL?) -> Void)?

    var apiURL: URL? { apiPort.map { URL(string: "http://127.0.0.1:\($0)")! } }
    var isUp: Bool { status == .running || status == .attached }
    /// Addresses phones use on this network (when the LAN gateway runs).
    var lanURLs: [String] {
        guard let lanPort, phases[.gateway].map({ if case .running = $0 { true } else { false } }) == true else { return [] }
        return HostEnvironment.lanAddresses().map { "http://\($0):\(lanPort)" }
    }

    let stateDirectory: URL
    private let configuration: @MainActor () -> HostConfiguration
    private let launcher: any ProcessLauncher
    private var supervisors: [Service: ServiceSupervisor] = [:]
    private let advertiser = BonjourAdvertiser()
    private var attachMonitor: Task<Void, Never>?
    private var startTask: Task<Void, Never>?

    init(stateDirectory: URL = HostEnvironment.stateDirectory,
         launcher: any ProcessLauncher = PosixProcessLauncher(),
         configuration: @escaping @MainActor () -> HostConfiguration) {
        self.stateDirectory = stateDirectory
        self.launcher = launcher
        self.configuration = configuration
    }

    // MARK: Paths

    var logsDirectory: URL { stateDirectory.appending(path: "logs", directoryHint: .isDirectory) }
    private var apiStateDirectory: URL { stateDirectory.appending(path: "api/state", directoryHint: .isDirectory) }
    private var workerStateDirectory: URL { stateDirectory.appending(path: "worker", directoryHint: .isDirectory) }
    private var emptyEnvFile: URL { stateDirectory.appending(path: "api/no-dev-vars.env") }
    private var instanceFile: URL { stateDirectory.appending(path: "instance-id") }
    private var hostFile: URL { stateDirectory.appending(path: "host.json") }
    func logFile(_ name: String) -> URL { logsDirectory.appending(path: "\(name).log") }

    // MARK: Lifecycle

    /// Start (or attach). Returns when the API answers, or with `.error`.
    func start() async {
        if let startTask { return await startTask.value }
        guard !isUp else { return }
        let task = Task { await performStart() }
        startTask = task
        await task.value
        startTask = nil
    }

    func restart() async {
        await stop()
        await start()
    }

    /// Stop the children: tunnel & worker first, then gateway and API.
    func stop() async {
        attachMonitor?.cancel()
        attachMonitor = nil
        advertiser.stop()
        for service in [Service.tunnel, .worker, .gateway, .api] {
            if let supervisor = supervisors[service] { await supervisor.stop() }
        }
        supervisors = [:]
        phases = [:]
        tunnelNote = nil
        if status != .stopped { status = .stopped }
    }

    /// Children are running under this app (so quitting must stop them).
    var ownsChildren: Bool { supervisors.values.contains { $0.isActive } }

    private func performStart() async {
        errorLog = ""
        status = .starting("Hazırlanıyor")
        let config = configuration()
        let fm = FileManager.default
        do {
            for dir in [logsDirectory, apiStateDirectory, workerStateDirectory] {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
            if !fm.fileExists(atPath: emptyEnvFile.path) {
                try Data("# Empty on purpose: the host passes secrets through the environment.\n".utf8).write(to: emptyEnvFile)
            }
        } catch {
            return fail("Durum klasörü oluşturulamadı: \(error.localizedDescription)")
        }
        let instance = instanceId()

        // 1. Attach to our own running copy (another app instance or crash leftovers).
        let lastPort = (try? JSONDecoder().decode(HostFile.self, from: Data(contentsOf: hostFile)))?.apiPort
        for port in Set([lastPort, config.preferredAPIPort].compactMap { $0 }) {
            if await health(port: port)?.instance == instance {
                apiPort = port
                status = .attached
                onAPIURLChange?(apiURL)
                monitorAttached(port: port, instance: instance)
                return
            }
        }

        // 2. Tools and sources.
        let path = await Task.detached { HostEnvironment.loginShellPath() }.value
        guard let node = HostEnvironment.which("node", path: path) else {
            return fail("node bulunamadı. PATH: \(path)")
        }
        let claude = HostEnvironment.which("claude", path: path)
        let gemini = HostEnvironment.which("gemini", path: path)
        let repo = URL(fileURLWithPath: NSString(string: config.repoPath).expandingTildeInPath, isDirectory: true)
        let apiDir = repo.appending(path: "apps/api", directoryHint: .isDirectory)
        let workerDir = repo.appending(path: "apps/worker", directoryHint: .isDirectory)
        let wrangler = apiDir.appending(path: "node_modules/wrangler/bin/wrangler.js")
        let gatewayScript = apiDir.appending(path: "scripts/lan-gateway.mjs")
        for required in [wrangler, gatewayScript, workerDir.appending(path: "node_modules/tsx"), workerDir.appending(path: "src/main.ts")]
        where !fm.fileExists(atPath: required.path) {
            return fail("Depo klasörü eksik ya da `pnpm install` yapılmamış: \(required.path) yok. Ayarlar → Mac sunucusu → Depo klasörü.")
        }

        // Off the main thread: after a rebuild (ad-hoc signature) macOS may ask for the login
        // keychain password before handing the item over; the UI must not freeze meanwhile.
        status = .starting("Anahtar Zinciri bekleniyor (izin penceresi açıldıysa onayla)")
        let loaded: (token: String?, error: String?) = await Task.detached {
            do { return (try WorkerTokenKeychain.loadOrCreate(), nil) } catch { return (nil, error.localizedDescription) }
        }.value
        guard let token = loaded.token else { return fail(loaded.error ?? "Anahtar Zinciri okunamadı.") }

        // 3. Ports: the preferred ones when free (a hand-started `wrangler dev` may hold them).
        guard let api = HostEnvironment.isPortFree(config.preferredAPIPort, address: "127.0.0.1") && HostEnvironment.isPortFree(config.preferredAPIPort, address: "0.0.0.0")
            ? config.preferredAPIPort : HostEnvironment.freePort(address: "127.0.0.1") else {
            return fail("Boş port bulunamadı.")
        }
        var lan: Int?
        if config.lanEnabled {
            lan = HostEnvironment.isPortFree(config.preferredLANPort, address: "0.0.0.0") && config.preferredLANPort != api
                ? config.preferredLANPort : HostEnvironment.freePort(address: "0.0.0.0")
        }
        // Remote Control must always go through the gateway: traffic sent straight to
        // workerd on 127.0.0.1 counts as the Mac itself and skips device authentication.
        // With LAN access off, run the gateway on loopback only, for the tunnel.
        var tunnelGateway: Int?
        if config.remoteControlEnabled, lan == nil {
            tunnelGateway = HostEnvironment.freePort(address: "127.0.0.1")
        }
        apiPort = api
        lanPort = lan
        try? JSONEncoder().encode(HostFile(apiPort: api, lanPort: lan, pid: getpid())).write(to: hostFile)

        let base = HostEnvironment.baseEnvironment(path: path)
        var wranglerEnv = base
        wranglerEnv["WORKER_TOKEN"] = token
        wranglerEnv["STUDIO_INSTANCE_ID"] = instance
        wranglerEnv["WRANGLER_SEND_METRICS"] = "false"
        wranglerEnv["NO_COLOR"] = "1"
        let persist = ["--persist-to", apiStateDirectory.path]

        // 4. Migrations (one shot).
        status = .starting("Veritabanı güncelleniyor")
        for name in ["migrate", "api", "gateway", "worker"] { HostEnvironment.rotate(logFile(name)) }
        let migrate = ProcessSpec(
            name: "migrate", executable: node,
            arguments: [wrangler.path, "d1", "migrations", "apply", "DB", "--local"] + persist,
            environment: wranglerEnv.merging(["CI": "1"]) { $1 }, workingDirectory: apiDir, logFile: logFile("migrate"))
        do {
            let process = try launcher.launch(migrate)
            // A hung migration must not block startup forever (seen once on a first run).
            let watchdog = Task {
                try await Task.sleep(for: .seconds(120))
                await process.terminate(grace: .seconds(3))
            }
            let code = await process.waitForExit()
            let timedOut = watchdog.isCancelled == false && code == 143
            watchdog.cancel()
            guard code == 0 else {
                return fail(timedOut ? "Migration 120 sn içinde bitmedi." : "Migration başarısız (çıkış kodu \(code)).", log: "migrate")
            }
        } catch {
            return fail(error.localizedDescription, log: "migrate")
        }

        // 5. API, then wait for it to answer.
        status = .starting("API başlatılıyor")
        let apiSpec = ProcessSpec(
            name: "api", executable: node,
            arguments: [wrangler.path, "dev", "--ip", "127.0.0.1", "--port", String(api), "--inspector-port", "0",
                        "--env-file", emptyEnvFile.path, "--show-interactive-dev-session=false"] + persist,
            environment: wranglerEnv, workingDirectory: apiDir, logFile: logFile("api"))
        supervise(.api, apiSpec)
        let deadline = ContinuousClock.now + .seconds(120)
        var ready = false
        while ContinuousClock.now < deadline {
            if case .failed(let message) = phases[.api] { return fail(message, log: "api") }
            if await health(port: api)?.instance == instance { ready = true; break }
            try? await Task.sleep(for: .milliseconds(500))
            if status == .stopped { return }
        }
        guard ready else { return fail("API 120 sn içinde yanıt vermedi.", log: "api") }

        // 6. LAN gateway + Bonjour.
        if let lan {
            var env = base
            env["STUDIO_GATEWAY_HOST"] = "0.0.0.0"
            env["STUDIO_GATEWAY_PORT"] = String(lan)
            env["STUDIO_API_PORT"] = String(api)
            supervise(.gateway, ProcessSpec(name: "gateway", executable: node, arguments: [gatewayScript.path],
                                            environment: env, workingDirectory: apiDir, logFile: logFile("gateway")))
            advertiser.start(name: BonjourAdvertiser.computerName, port: lan)
        } else if let tunnelGateway {
            var env = base
            env["STUDIO_GATEWAY_HOST"] = "127.0.0.1"
            env["STUDIO_GATEWAY_PORT"] = String(tunnelGateway)
            env["STUDIO_API_PORT"] = String(api)
            supervise(.gateway, ProcessSpec(name: "gateway", executable: node, arguments: [gatewayScript.path],
                                            environment: env, workingDirectory: apiDir, logFile: logFile("gateway")))
        }

        // 7. Worker.
        var workerEnv = base
        workerEnv["STUDIO_HUB_URL"] = "ws://127.0.0.1:\(api)/api/hub"
        workerEnv["STUDIO_WORKER_TOKEN"] = token
        workerEnv["STUDIO_STATE_DIR"] = workerStateDirectory.path
        workerEnv["STUDIO_SHUTDOWN_TIMEOUT_S"] = "5"
        if let claude { workerEnv["STUDIO_CLAUDE_BIN"] = claude.path }
        if let gemini { workerEnv["STUDIO_GEMINI_BIN"] = gemini.path }
        let repoEnvFile = repo.appending(path: ".env")
        var workerArgs = ["--env-file-if-exists=\(repoEnvFile.path)"]
        if fm.fileExists(atPath: repoEnvFile.path) {
            // `--env-file-if-exists` loads repo `.env` (e.g. GEMINI_API_KEY) directly in Node without reading `.env` in Swift.
        }
        workerArgs += ["--import", "tsx", "src/main.ts"]
        supervise(.worker, ProcessSpec(name: "worker", executable: node, arguments: workerArgs,
                                       environment: workerEnv, workingDirectory: workerDir, logFile: logFile("worker")))

        // 8. Remote Control Cloudflare Tunnel (L3).
        tunnelNote = nil
        if config.remoteControlEnabled {
            HostEnvironment.rotate(logFile("tunnel"))
            // Never the API port itself (see the gateway note above).
            guard let targetPort = lan ?? tunnelGateway else {
                tunnelNote = "Tünel için geçit başlatılamadı."
                status = .running
                onAPIURLChange?(apiURL)
                return
            }
            let localTargetURL = "http://127.0.0.1:\(targetPort)"
            if let cloudflared = HostEnvironment.which("cloudflared", path: path) {
                let trimmedToken = config.tunnelToken?.trimmingCharacters(in: .whitespacesAndNewlines)
                let cleanHost = Self.normalizedHostname(config.remoteHostname)
                if let token = trimmedToken, !token.isEmpty {
                    let args = Self.tunnelArguments(token: token, hostname: cleanHost, localTargetURL: localTargetURL)
                    var tunnelEnv = base
                    tunnelEnv["TUNNEL_TOKEN"] = token
                    supervise(.tunnel, ProcessSpec(
                        name: "tunnel", executable: cloudflared, arguments: args,
                        environment: tunnelEnv, workingDirectory: stateDirectory, logFile: logFile("tunnel")
                    ))
                    tunnelNote = "Aktif hedef: https://\(cleanHost) → \(localTargetURL)"
                } else {
                    let cfDir = URL(fileURLWithPath: NSHomeDirectory()).appending(path: ".cloudflared")
                    if FileManager.default.fileExists(atPath: cfDir.appending(path: "cert.pem").path), !cleanHost.isEmpty {
                        let args = Self.tunnelArguments(token: nil, hostname: cleanHost, localTargetURL: localTargetURL)
                        supervise(.tunnel, ProcessSpec(
                            name: "tunnel", executable: cloudflared, arguments: args,
                            environment: base, workingDirectory: stateDirectory, logFile: logFile("tunnel")
                        ))
                        tunnelNote = "Adlandırılmış tünel çalışıyor: https://\(cleanHost) → \(localTargetURL)"
                    } else {
                        tunnelNote = "CLOUDFLARE_TUNNEL_TOKEN girilmedi. Cloudflare Zero Trust panelinden tünel anahtarını yapıştırıp Kaydet'e tıkla."
                    }
                }
            } else {
                tunnelNote = "cloudflared bulunamadı (`brew install cloudflared` ile kurup Mac sunucusunu yeniden başlat)."
            }
        }

        status = .running
        onAPIURLChange?(apiURL)
    }

    static func normalizedHostname(_ raw: String) -> String {
        var clean = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.hasPrefix("https://") { clean = String(clean.dropFirst("https://".count)) }
        if clean.hasPrefix("http://") { clean = String(clean.dropFirst("http://".count)) }
        while clean.hasSuffix("/") { clean.removeLast() }
        return clean.isEmpty ? AppSettings.defaultRemoteHostname : clean
    }

    /// Command-line arguments passed to `cloudflared` (`L3`).
    static func tunnelArguments(token: String?, hostname: String, localTargetURL: String) -> [String] {
        if let token = token?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            return ["tunnel", "--no-autoupdate", "run", "--token", token, "--url", localTargetURL]
        }
        return ["tunnel", "--no-autoupdate", "run", "--url", localTargetURL, normalizedHostname(hostname)]
    }

    private func supervise(_ service: Service, _ spec: ProcessSpec) {
        let supervisor = ServiceSupervisor(name: service.label, spec: { spec }, launcher: launcher)
        supervisor.onChange = { [weak self] phase in self?.update(service, phase) }
        supervisors[service] = supervisor
        supervisor.start()
        phases[service] = supervisor.phase
    }

    private func update(_ service: Service, _ phase: ServiceSupervisor.Phase) {
        phases[service] = phase
        if case .failed(let message) = phase, status == .running {
            status = .error(message)
            errorLog = HostEnvironment.tail(logFile(service == .api ? "api" : service.rawValue))
        }
    }

    private func fail(_ message: String, log: String? = nil) {
        status = .error(message)
        errorLog = log.map { HostEnvironment.tail(logFile($0)) } ?? ""
        let owned = supervisors
        supervisors = [:]
        Task { for supervisor in owned.values { await supervisor.stop() } }
    }

    /// While attached, take over if the other instance goes away.
    private func monitorAttached(port: Int, instance: String) {
        attachMonitor?.cancel()
        attachMonitor = Task { [weak self] in
            var misses = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self, !Task.isCancelled else { return }
                if await self.health(port: port)?.instance == instance { misses = 0; continue }
                misses += 1
                if misses >= 3 {
                    self.status = .stopped
                    self.apiPort = nil
                    await self.start()
                    return
                }
            }
        }
    }

    // MARK: Helpers

    private func instanceId() -> String {
        if let saved = try? String(contentsOf: instanceFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !saved.isEmpty {
            return saved
        }
        let id = UUID().uuidString.lowercased()
        try? id.write(to: instanceFile, atomically: true, encoding: .utf8)
        return id
    }

    private func health(port: Int) async -> HealthResponse? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let client = APIClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, session: session)
        return try? await client.health()
    }

    /// Log tail for one service (Settings shows it on errors).
    func lastLines(_ service: Service, lines: Int = 12) -> String {
        HostEnvironment.tail(logFile(service.rawValue), lines: lines)
    }

    private struct HostFile: Codable {
        var apiPort: Int
        var lanPort: Int?
        var pid: Int32
    }
}

/// The host whose children must stop when the app quits.
@MainActor
enum ActiveHost {
    static weak var current: LocalHost?
}
