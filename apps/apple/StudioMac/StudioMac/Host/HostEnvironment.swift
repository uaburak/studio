import Darwin
import Foundation
import Security
import Synchronization

/// Where the host keeps its state, and how it finds node / claude.
///
/// Finder-launched apps get a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
/// so the PATH is read once from the user's login shell. The repo path comes
/// from Settings: today the host runs the API and worker from the repo's
/// sources (`node_modules` must be installed). Packaging node, wrangler and the
/// worker into the app bundle is a later step.
enum HostEnvironment {
    /// `~/Library/Application Support/Studio`.
    static var stateDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appending(path: "Library/Application Support")
        return base.appending(path: "Studio", directoryHint: .isDirectory)
    }

    /// The repo this build came from (the app lives under `apps/apple/...`
    /// when built locally), else the developer's checkout.
    static var defaultRepoPath: String {
        var url = Bundle.main.bundleURL
        for _ in 0..<10 {
            url.deleteLastPathComponent()
            if FileManager.default.fileExists(atPath: url.appending(path: "pnpm-workspace.yaml").path),
               FileManager.default.fileExists(atPath: url.appending(path: "apps/api/wrangler.jsonc").path) {
                return url.path
            }
            if url.path == "/" { break }
        }
        return NSString(string: "~/Desktop/Burak/Code/Studio").expandingTildeInPath
    }

    /// PATH of the user's login shell (cached), with common tool folders appended.
    static func loginShellPath() -> String {
        if let cached = cache.withLock({ $0 }) { return cached }
        var path = readLoginShellPath() ?? ""
        let home = NSHomeDirectory()
        let extras = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var parts = path.split(separator: ":").map(String.init)
        for extra in extras where !parts.contains(extra) { parts.append(extra) }
        path = parts.joined(separator: ":")
        cache.withLock { $0 = path }
        return path
    }

    private static let cache = Mutex<String?>(nil)

    private static func readLoginShellPath() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        // -l and -i: PATH is often set in .zshrc (interactive) as well as .zprofile.
        process.arguments = ["-l", "-i", "-c", "printf '__STUDIO_PATH__%s__END__' \"$PATH\""]
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline { usleep(20_000) }
        if process.isRunning { process.terminate(); return nil }
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard let start = text.range(of: "__STUDIO_PATH__"), let end = text.range(of: "__END__", range: start.upperBound..<text.endIndex) else {
            return nil
        }
        return String(text[start.upperBound..<end.lowerBound])
    }

    /// First executable named `tool` on `path`.
    static func which(_ tool: String, path: String) -> URL? {
        for dir in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appending(path: tool)
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// Environment shared by every child: login PATH and the user's basics only.
    static func baseEnvironment(path: String) -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var env: [String: String] = ["PATH": path, "HOME": NSHomeDirectory(), "LANG": inherited["LANG"] ?? "en_US.UTF-8"]
        for key in ["USER", "LOGNAME", "TMPDIR", "SHELL"] { env[key] = inherited[key] }
        if env["USER"] == nil { env["USER"] = NSUserName() }
        return env
    }

    // MARK: Ports

    /// True when nothing listens on `port` at `address` (bind test).
    static func isPortFree(_ port: Int, address: String) -> Bool {
        bindTest(port: port, address: address) != nil
    }

    /// A port the kernel picks as free on `address`.
    static func freePort(address: String) -> Int? {
        bindTest(port: 0, address: address)
    }

    private static func bindTest(port: Int, address: String) -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        inet_pton(AF_INET, address, &addr.sin_addr)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { return nil }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    /// IPv4 addresses of active, non-loopback interfaces (for display).
    static func lanAddresses() -> [String] {
        var result: [String] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return [] }
        defer { freeifaddrs(list) }
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: host)
                if !ip.hasPrefix("169.254.") { result.append(ip) }
            }
        }
        return result
    }

    // MARK: Logs

    /// The last `lines` lines of a log file (reads at most the last 16 KB).
    static func tail(_ url: URL, lines: Int = 12) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 16_384 ? size - 16_384 : 0)
        let text = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
        // Strip ANSI colour codes wrangler prints.
        let plain = text.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        return plain.split(separator: "\n", omittingEmptySubsequences: true).suffix(lines).joined(separator: "\n")
    }

    /// Move a log aside when it grew past `limit` bytes (one generation kept).
    static func rotate(_ url: URL, limit: Int = 5_000_000) {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int, size > limit else { return }
        let old = url.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: url, to: old)
    }
}

/// The shared secret between the local API and worker (WORKER_TOKEN).
/// Generated once, kept in the Keychain, handed to both children through their
/// environment; never written to the repo or to disk by the app.
enum WorkerTokenKeychain {
    static let service = "net.burakkoc.studio"
    static let account = "local-worker-token"

    static func loadOrCreate() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8), !token.isEmpty {
            return token
        }
        guard status == errSecItemNotFound || status == errSecSuccess else { throw KeychainFailure(status: status) }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw KeychainFailure(status: errSecAllocate) }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: "Studio yerel worker anahtarı",
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainFailure(status: added) }
        return token
    }

    struct KeychainFailure: Error, LocalizedError {
        var status: OSStatus
        var errorDescription: String? {
            "Anahtar zinciri: \(SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)")"
        }
    }
}

/// Storage for `CLOUDFLARE_TUNNEL_TOKEN` used by Remote Control (`L3`).
protocol TunnelTokenStore: Sendable {
    func load() throws -> String?
    func save(_ token: String) throws
    func delete() throws
}

/// Keychain-backed `CLOUDFLARE_TUNNEL_TOKEN` store (`TunnelTokenKeychain`).
struct TunnelTokenKeychain: TunnelTokenStore {
    static let service = "net.burakkoc.studio"
    static let account = "cloudflare-tunnel-token"

    var serviceName: String = Self.service
    var accountName: String = Self.account

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: accountName,
        ]
    }

    func load() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw WorkerTokenKeychain.KeychainFailure(status: status)
        }
        let str = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (str?.isEmpty == false) ? str : nil
    }

    func save(_ token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let data = Data(trimmed.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add[kSecAttrLabel as String] = "Studio Cloudflare Tunnel anahtarı"
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw WorkerTokenKeychain.KeychainFailure(status: status)
        }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw WorkerTokenKeychain.KeychainFailure(status: status)
        }
    }
}

/// In-memory tunnel token store for unit tests.
final class InMemoryTunnelTokenStore: TunnelTokenStore {
    private let stored: Mutex<String?>

    init(_ initial: String? = nil) {
        stored = Mutex(initial)
    }

    func load() throws -> String? { stored.withLock { $0 } }
    func save(_ token: String) throws { stored.withLock { $0 = token.trimmingCharacters(in: .whitespacesAndNewlines) } }
    func delete() throws { stored.withLock { $0 = nil } }
}
