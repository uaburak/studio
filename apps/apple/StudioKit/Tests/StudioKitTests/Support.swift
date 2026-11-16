import Foundation
import Synchronization
@testable import StudioKit

enum Fixture {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw FixtureError.missing(name)
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try StudioJSON.decoder().decode(T.self, from: data(name))
    }

    static func text(_ name: String) throws -> String {
        String(decoding: try data(name), as: UTF8.self)
    }

    enum FixtureError: Error { case missing(String) }
}

/// URLProtocol stub keyed by host, so parallel tests do not share handlers.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Response: Sendable {
        var status: Int
        var body: Data
        var headers: [String: String] = ["Content-Type": "application/json"]
    }

    typealias Handler = @Sendable (URLRequest, Data) throws -> Response

    private static let handlers = Mutex<[String: Handler]>([:])
    private static let requests = Mutex<[String: [(URLRequest, Data)]]>([:])

    /// A session whose requests to `host` go to `handler`.
    static func session(host: String, handler: @escaping Handler) -> URLSession {
        handlers.withLock { $0[host] = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    static func recorded(host: String) -> [(URLRequest, Data)] {
        requests.withLock { $0[host] ?? [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        let body = request.httpBody ?? Self.read(request.httpBodyStream)
        Self.requests.withLock { $0[host, default: []].append((request, body)) }
        guard let handler = Self.handlers.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        do {
            let response = try handler(request, body)
            let http = HTTPURLResponse(url: request.url!, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: response.headers)!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: response.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

func uniqueHost() -> String { "stub-\(UUID().uuidString.lowercased()).test" }

// MARK: - Fake WebSocket

/// Scripted connections: each `connect` takes the next script entry.
final class FakeConnector: WebSocketConnecting, @unchecked Sendable {
    enum Script: Sendable {
        /// `connect` throws.
        case refuse
        /// Delivers these frames, then fails (socket dropped).
        case frames([String])
        /// Delivers frames, then blocks until closed.
        case framesThenHang([String])
    }

    private let lock = NSLock()
    private var scripts: [Script]
    private(set) var urls: [URL] = []
    private(set) var sent: [String] = []

    init(_ scripts: [Script]) {
        self.scripts = scripts
    }

    func connect(url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
        let script: Script = lock.withLock {
            urls.append(url)
            return scripts.isEmpty ? .refuse : scripts.removeFirst()
        }
        switch script {
        case .refuse: throw URLError(.cannotConnectToHost)
        case .frames(let frames): return FakeConnection(frames: frames, hang: false, onSend: { [weak self] in self?.record($0) })
        case .framesThenHang(let frames): return FakeConnection(frames: frames, hang: true, onSend: { [weak self] in self?.record($0) })
        }
    }

    private func record(_ text: String) { lock.withLock { sent.append(text) } }

    var connectCount: Int { lock.withLock { urls.count } }
    var recordedURLs: [URL] { lock.withLock { urls } }
}

final class FakeConnection: WebSocketConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [String]
    private let hang: Bool
    private var closed = false
    private let onSend: @Sendable (String) -> Void

    init(frames: [String], hang: Bool, onSend: @escaping @Sendable (String) -> Void) {
        self.frames = frames
        self.hang = hang
        self.onSend = onSend
    }

    func receive() async throws -> String {
        while true {
            let next: String?? = lock.withLock {
                if closed { return .some(nil) }
                if !frames.isEmpty { return .some(frames.removeFirst()) }
                return hang ? nil : .some(nil)
            }
            switch next {
            case .some(.some(let frame)): return frame
            case .some(.none): throw URLError(.networkConnectionLost)
            case .none: try await Task.sleep(for: .milliseconds(5))
            }
        }
    }

    func send(_ text: String) async throws { onSend(text) }

    func close() { lock.withLock { closed = true } }
}

/// Records sleeps instead of sleeping (yields so other tasks run).
final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var durations: [Duration] = []

    var sleep: @Sendable (Duration) async throws -> Void {
        { [self] duration in
            lock.withLock { durations.append(duration) }
            try Task.checkCancellation()
            await Task.yield()
        }
    }

    var recorded: [Duration] { lock.withLock { durations } }
}

/// Collect events from a stream until `stop` says so (or `limit`).
func collect<E: Sendable>(_ stream: AsyncStream<E>, limit: Int = 200, until stop: (E, [E]) -> Bool) async -> [E] {
    var events: [E] = []
    for await event in stream {
        events.append(event)
        if stop(event, events) || events.count >= limit { break }
    }
    return events
}
