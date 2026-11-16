import Foundation
import Network
import StudioKit

/// One-shot HTTP listener on the loopback interface that catches an OAuth redirect
/// (`http://localhost:8793/meta/callback?code=…`). The browser shows a short Turkish page;
/// the app gets the full callback URL.
///
/// Facebook's token flow (no App Secret) puts the token in the URL fragment, which the
/// browser never sends; for a callback without a query the listener answers with a tiny
/// page that moves the fragment into the query and reloads, then catches that request.
final class OAuthLoopbackServer: @unchecked Sendable {
    enum Failure: Error, LocalizedError, Equatable {
        case portBusy(UInt16)
        case timedOut
        case cancelled

        var errorDescription: String? {
            switch self {
            case .portBusy(let port): "Giriş dönüşü için \(port) portu açılamadı (başka bir uygulama kullanıyor olabilir)."
            case .timedOut: "Tarayıcıdaki giriş 5 dakika içinde tamamlanmadı."
            case .cancelled: "Giriş iptal edildi."
            }
        }
    }

    let port: UInt16
    private let queue = DispatchQueue(label: "studio.oauth.loopback")
    private var listener: NWListener?
    private var continuation: CheckedContinuation<URL, any Error>?
    private var path = "/"
    private var timeoutItem: DispatchWorkItem?

    init(port: UInt16 = OAuthLoopback.port) {
        self.port = port
    }

    /// Start listening, then call `ready` (open the browser there); returns the callback URL.
    func waitForCallback(path: String, timeout: TimeInterval = 300, ready: @escaping @Sendable () -> Void) async throws -> URL {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, any Error>) in
                queue.async {
                    self.continuation = cont
                    self.path = path
                    do {
                        try self.startListener(ready: ready)
                    } catch {
                        self.finish(.failure(Failure.portBusy(self.port)))
                        return
                    }
                    let item = DispatchWorkItem { [weak self] in self?.finish(.failure(Failure.timedOut)) }
                    self.timeoutItem = item
                    self.queue.asyncAfter(deadline: .now() + timeout, execute: item)
                }
            }
        } onCancel: {
            queue.async { self.finish(.failure(Failure.cancelled)) }
        }
    }

    func cancel() {
        queue.async { self.finish(.failure(Failure.cancelled)) }
    }

    private func startListener(ready: @escaping @Sendable () -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw Failure.portBusy(port) }
        let listener = try NWListener(using: parameters, on: nwPort)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready: ready()
            case .failed: self.finish(.failure(Failure.portBusy(self.port)))
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.handle(connection) }
        listener.start(queue: queue)
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(connection, head: buffer[..<end.lowerBound])
            } else if isComplete || error != nil || buffer.count > 65_536 {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    private func respond(_ connection: NWConnection, head: Data) {
        let line = String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n").first ?? ""
        let parts = line.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" else {
            send(connection, status: "405 Method Not Allowed", body: "")
            return
        }
        let target = String(parts[1])
        let requestPath = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
        guard requestPath == path else {
            send(connection, status: "404 Not Found", body: "")
            return
        }
        guard target.contains("?") else {
            // Implicit flow: the token is in the fragment; move it into the query.
            send(connection, status: "200 OK", body: Self.page(
                title: "Studio",
                message: "Giriş tamamlanıyor…",
                script: "if(location.hash.length>1){location.replace(location.pathname+'?'+location.hash.substring(1));}else{document.body.innerHTML='<p>Giriş yanıtı boş geldi. Studio’ya dönüp yeniden deneyin.</p>';}"))
            return
        }
        send(connection, status: "200 OK", body: Self.page(
            title: "Studio",
            message: "Giriş Studio’ya iletildi. Bu sekmeyi kapatıp Studio’ya dönebilirsiniz.",
            script: nil))
        if let url = URL(string: "http://\(OAuthLoopback.host):\(port)\(target)") {
            finish(.success(url))
        }
    }

    private func send(_ connection: NWConnection, status: String, body: String) {
        let bytes = Data(body.utf8)
        let head = "HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(bytes.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + bytes, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func finish(_ result: Result<URL, any Error>) {
        timeoutItem?.cancel()
        timeoutItem = nil
        if let continuation {
            self.continuation = nil
            continuation.resume(with: result)
        }
        // Let the success page reach the browser before the socket goes away.
        let listener = self.listener
        self.listener = nil
        queue.asyncAfter(deadline: .now() + 0.5) { listener?.cancel() }
    }

    private static func page(title: String, message: String, script: String?) -> String {
        """
        <!doctype html><html lang="tr"><head><meta charset="utf-8"><title>\(title)</title>
        <style>body{font:15px -apple-system,system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#fff;color:#101010}
        @media(prefers-color-scheme:dark){body{background:#161617;color:#f2f2f3}}p{max-width:420px;text-align:center;line-height:1.5}</style>
        </head><body><p>\(message)</p>\(script.map { "<script>\($0)</script>" } ?? "")</body></html>
        """
    }
}
