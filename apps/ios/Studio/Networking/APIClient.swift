import Foundation

enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", patch = "PATCH", delete = "DELETE"
}

/// One API call: method, path, query and an optional body.
struct APIRequest<Response: Decodable & Sendable>: Sendable {
    var method: HTTPMethod
    var path: String
    var query: [URLQueryItem] = []
    var body: Data?
    var contentType: String?

    static func get(_ path: String, query: [URLQueryItem] = []) -> Self {
        Self(method: .get, path: path, query: query)
    }

    static func post(_ path: String) -> Self {
        Self(method: .post, path: path)
    }

    static func send(_ method: HTTPMethod, _ path: String, json body: some Encodable) throws(APIError) -> Self {
        do {
            let data = try StudioJSON.encoder().encode(body)
            return Self(method: method, path: path, body: data, contentType: "application/json")
        } catch {
            throw APIError.decoding("request body: \(error)")
        }
    }
}

/// Response with no body we care about.
struct EmptyResponse: Decodable, Sendable {}

/// HTTP client for the Studio API. Immutable; the app builds a new one when
/// the base URL or credentials change in Settings.
final class APIClient: Sendable {
    let configuration: ServerConfiguration
    let session: URLSession
    let authorizer: any RequestAuthorizing

    init(
        configuration: ServerConfiguration,
        authorizer: any RequestAuthorizing = AccessServiceTokenAuthorizer(credentials: nil),
        session: URLSession = APIClient.makeSession()
    ) {
        self.configuration = configuration
        self.authorizer = authorizer
        self.session = session
    }

    static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = false
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        if let protocolClasses { config.protocolClasses = protocolClasses }
        return URLSession(configuration: config)
    }

    // MARK: Core

    func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
        let urlRequest = await makeURLRequest(request)
        let (data, _) = try await perform(urlRequest)
        return try decode(Response.self, from: data)
    }

    func makeURLRequest<Response>(_ request: APIRequest<Response>) async -> URLRequest {
        var urlRequest = URLRequest(url: configuration.url(path: request.path, query: request.query))
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.httpBody = request.body
        if let contentType = request.contentType {
            urlRequest.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        for (name, value) in await authorizer.authorizationHeaders() {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        return urlRequest
    }

    /// Runs a request and maps every failure to `APIError`. Returns the body
    /// of a 2xx response.
    func perform(
        _ request: URLRequest, uploading body: Data? = nil, delegate: (any URLSessionTaskDelegate)? = nil
    ) async throws(APIError) -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            if let body {
                (data, response) = try await session.upload(for: request, from: body, delegate: delegate)
            } else {
                (data, response) = try await session.data(for: request, delegate: delegate)
            }
        } catch {
            throw APIError.from(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unexpectedResponse("not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.from(status: http.statusCode, body: data)
        }
        return (data, http)
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws(APIError) -> T {
        if T.self == EmptyResponse.self, let empty = EmptyResponse() as? T { return empty }
        do {
            return try StudioJSON.decoder().decode(T.self, from: data)
        } catch {
            if let text = String(data: data.prefix(64), encoding: .utf8),
               text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("<") {
                throw APIError.unexpectedResponse("HTML instead of JSON")
            }
            throw APIError.decoding(String(describing: error))
        }
    }
}
