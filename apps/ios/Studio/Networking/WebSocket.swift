import Foundation

/// One open WebSocket (text frames only). Abstracted so the reconnect logic
/// can be tested without a server.
protocol WebSocketConnection: Sendable {
    /// Next text frame. Throws when the socket closes or fails.
    func receive() async throws -> String
    func send(_ text: String) async throws
    func close()
}

protocol WebSocketConnecting: Sendable {
    func connect(url: URL, headers: [String: String]) async throws -> any WebSocketConnection
}

// MARK: - URLSession implementation

struct URLSessionWebSocketConnector: WebSocketConnecting {
    var session: URLSession = .shared

    func connect(url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let task = session.webSocketTask(with: request)
        task.resume()
        return URLSessionWebSocketConnection(task: task)
    }
}

final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
    // URLSessionWebSocketTask is thread-safe; it is just not annotated Sendable.
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}
