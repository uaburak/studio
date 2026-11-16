import Foundation
@testable import Studio

private final class BundleToken {}

/// JSON captured from the running local API by scripts/capture-fixtures.sh.
enum Fixture {
    static func data(_ name: String) throws -> Data {
        let bundle = Bundle(for: BundleToken.self)
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            throw FixtureError.missing(name)
        }
        return try Data(contentsOf: url)
    }

    static func text(_ name: String) throws -> String {
        String(decoding: try data(name), as: UTF8.self)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try StudioJSON.decoder().decode(T.self, from: data(name))
    }

    enum FixtureError: Error { case missing(String) }
}

/// URLProtocol stub. Each test registers a handler under its own host, so
/// tests can run in parallel without sharing state.
final class StubProtocol: URLProtocol {
    struct Response: Sendable {
        var status: Int
        var body: Data
        var headers: [String: String] = ["Content-Type": "application/json"]

        static func json(_ status: Int, _ text: String) -> Response {
            Response(status: status, body: Data(text.utf8))
        }

        static func fixture(_ status: Int, _ name: String) -> Response {
            Response(status: status, body: (try? Fixture.data(name)) ?? Data())
        }
    }

    enum Outcome: Sendable {
        case respond(Response)
        case fail(URLError.Code)
    }

    struct Recorded: Sendable {
        var method: String
        var url: URL
        var headers: [String: String]
        var body: Data?
    }

    typealias Handler = @Sendable (URLRequest) -> Outcome

    private static let handlers = Locked<[String: Handler]>([:])
    private static let recorded = Locked<[String: [Recorded]]>([:])

    /// A client whose requests go to `handler`.
    static func client(
        credentials: AccessCredentials? = nil, handler: @escaping Handler
    ) -> (APIClient, host: String) {
        let host = "t\(UUID().uuidString.prefix(8).lowercased()).test"
        handlers.withLock { $0[host] = handler }
        let client = APIClient(
            configuration: ServerConfiguration(baseURL: URL(string: "http://\(host)")!),
            authorizer: AccessServiceTokenAuthorizer(credentials: credentials),
            session: APIClient.makeSession(protocolClasses: [StubProtocol.self]))
        return (client, host)
    }

    static func requests(for host: String) -> [Recorded] {
        recorded.value[host] ?? []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host() ?? ""
        let body = request.httpBody ?? request.httpBodyStream.map(StubURLProtocol.read)
        Self.recorded.withLock {
            $0[host, default: []].append(Recorded(
                method: request.httpMethod ?? "GET", url: request.url!,
                headers: request.allHTTPHeaderFields ?? [:], body: body))
        }
        guard let handler = Self.handlers.value[host] else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        switch handler(request) {
        case .fail(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .respond(let response):
            let http = HTTPURLResponse(url: request.url!, statusCode: response.status, httpVersion: "HTTP/1.1",
                                       headerFields: response.headers)!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: response.body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

/// Routes by "METHOD /path" (query ignored).
func route(_ table: [String: StubProtocol.Response]) -> StubProtocol.Handler {
    { request in
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path() ?? "")"
        if let response = table[key] { return .respond(response) }
        return .respond(.json(404, #"{"error":{"code":"not_found","message":"no stub for \#(key)"}}"#))
    }
}
