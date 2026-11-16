import Foundation
import Testing
@testable import Studio

@Suite("API client (URLProtocol stubs)")
struct APIClientTests {
    @Test func buildsListRequestsWithQueryAndDecodes() async throws {
        let (client, host) = StubProtocol.client(handler: route([
            "GET /api/contents": .fixture(200, "content-list"),
        ]))
        let page = try await client.contents(brandId: "b1", status: .inReview, cursor: "abc", limit: 5)
        #expect(page.items.count == 1)
        let request = try #require(StubProtocol.requests(for: host).first)
        #expect(request.method == "GET")
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(Set(query.map { "\($0.name)=\($0.value ?? "")" }) == ["brandId=b1", "status=in_review", "cursor=abc", "limit=5"])
    }

    @Test func omitsNilQueryItems() async throws {
        let (client, host) = StubProtocol.client(handler: route(["GET /api/jobs": .fixture(200, "job-list")]))
        _ = try await client.jobs(brandId: nil)
        #expect(StubProtocol.requests(for: host).first?.url.query() == "limit=50")
    }

    @Test func sendsJSONBodies() async throws {
        let (client, host) = StubProtocol.client(handler: route([
            "POST /api/contents/c1/approve": .fixture(200, "content-approved"),
        ]))
        let content = try await client.approveContent(id: "c1", hash: "abc123")
        #expect(content.status == .approved)
        let request = try #require(StubProtocol.requests(for: host).first)
        #expect(request.method == "POST")
        #expect(request.headers["Content-Type"] == "application/json")
        #expect(request.body.map { String(decoding: $0, as: UTF8.self) } == #"{"hash":"abc123"}"#)
    }

    @Test func addsAccessHeadersWhenCredentialsAreSaved() async throws {
        let credentials = AccessCredentials(clientId: "id.access", clientSecret: "s3cret")
        let (client, host) = StubProtocol.client(credentials: credentials, handler: route([
            "GET /api/health": .fixture(200, "health"),
        ]))
        _ = try await client.health()
        let headers = try #require(StubProtocol.requests(for: host).first?.headers)
        #expect(headers["CF-Access-Client-Id"] == "id.access")
        #expect(headers["CF-Access-Client-Secret"] == "s3cret")
    }

    @Test func noAccessHeadersWithoutCredentials() async throws {
        let (client, host) = StubProtocol.client(handler: route(["GET /api/health": .fixture(200, "health")]))
        _ = try await client.health()
        #expect(StubProtocol.requests(for: host).first?.headers["CF-Access-Client-Id"] == nil)
    }

    @Test func mapsTheAPIErrorShape() async {
        let (client, _) = StubProtocol.client(handler: route([
            "POST /api/contents/c1/approve": .fixture(409, "error-hash-mismatch"),
        ]))
        await #expect {
            _ = try await client.approveContent(id: "c1", hash: "x")
        } throws: { error in
            (error as? APIError)?.code == .hashMismatch
        }
    }

    @Test(arguments: [URLError.Code.cannotConnectToHost, .notConnectedToInternet, .networkConnectionLost])
    func connectionFailuresAreOffline(code: URLError.Code) async {
        let (client, _) = StubProtocol.client { _ in .fail(code) }
        do {
            _ = try await client.health()
            Issue.record("expected an error")
        } catch {
            #expect(error == .offline)
            #expect(error.isOffline)
        }
    }

    @Test func timeoutIsItsOwnCase() async {
        let (client, _) = StubProtocol.client { _ in .fail(.timedOut) }
        await #expect(throws: APIError.timedOut) { _ = try await client.health() }
    }

    @Test func accessRefusalWithoutErrorShapeIsUnauthorized() async {
        let (client, _) = StubProtocol.client { _ in
            .respond(.init(status: 403, body: Data("Forbidden".utf8), headers: ["Content-Type": "text/plain"]))
        }
        await #expect(throws: APIError.unauthorized(status: 403)) { _ = try await client.health() }
    }

    @Test func htmlInsteadOfJSONIsUnexpectedResponse() async {
        let (client, _) = StubProtocol.client { _ in
            .respond(.init(status: 200, body: Data("<!doctype html><title>Sign in</title>".utf8),
                           headers: ["Content-Type": "text/html"]))
        }
        await #expect(throws: APIError.unexpectedResponse("HTML instead of JSON")) { _ = try await client.health() }
    }

    @Test func gatewayErrorWithoutBodyIsHTTP() async {
        let (client, _) = StubProtocol.client { _ in .respond(.init(status: 502, body: Data())) }
        await #expect(throws: APIError.http(status: 502)) { _ = try await client.brands() }
    }

    @Test func malformedJSONIsADecodingError() async {
        let (client, _) = StubProtocol.client { _ in .respond(.json(200, #"{"items":"nope"}"#)) }
        do {
            _ = try await client.brands()
            Issue.record("expected an error")
        } catch {
            guard case .decoding = error else { Issue.record("got \(error)"); return }
        }
    }

    @Test func uploadReturnsTheAsset() async throws {
        let (client, host) = StubProtocol.client(handler: route(["POST /api/assets": .fixture(201, "asset")]))
        let file = UploadFile(filename: "a.png", mimeType: "image/png", data: Data([1, 2, 3]), width: 1, height: 1)
        let progress = Locked<[Double]>([])
        let asset = try await client.uploadAsset(file, brandId: "b1") { value in progress.withLock { $0.append(value) } }
        #expect(asset.mimeType == "image/png")
        #expect(progress.value.last == 1)
        let request = try #require(StubProtocol.requests(for: host).first)
        #expect(request.headers["Content-Type"]?.hasPrefix("multipart/form-data; boundary=") == true)
    }

    @Test func cancelJobPostsToTheJobsCancelPath() async throws {
        let (client, host) = StubProtocol.client(handler: route([
            "POST /api/jobs/j%201/cancel": .fixture(200, "job-cancelled"),
        ]))
        let job = try await client.cancelJob(id: "j 1")
        #expect(job.status == .cancelled)
        #expect(StubProtocol.requests(for: host).first?.url.path(percentEncoded: true) == "/api/jobs/j%201/cancel")
    }

    @Test func multipartBodyHasFieldsAndFile() {
        var form = MultipartForm(boundary: "B")
        form.addField("brandId", "b1")
        form.addFile("file", filename: "x\".jpg", mimeType: "image/jpeg", data: Data("JPEG".utf8))
        let text = String(decoding: form.finalize(), as: UTF8.self)
        #expect(text == """
        --B\r
        Content-Disposition: form-data; name="brandId"\r
        \r
        b1\r
        --B\r
        Content-Disposition: form-data; name="file"; filename="x%22.jpg"\r
        Content-Type: image/jpeg\r
        \r
        JPEG\r
        --B--\r

        """)
    }

    @Test func streamURLUsesWebSocketScheme() {
        let local = APIClient(configuration: ServerConfiguration(baseURL: URL(string: "http://127.0.0.1:8787")!))
        #expect(local.jobStreamURL(brandId: "b1").absoluteString == "ws://127.0.0.1:8787/api/jobs/stream?brandId=b1")
        let remote = APIClient(configuration: ServerConfiguration(baseURL: URL(string: "https://social.example.com")!))
        #expect(remote.jobStreamURL(brandId: nil).absoluteString == "wss://social.example.com/api/jobs/stream")
    }

    @Test(arguments: [
        ("http://127.0.0.1:8787", "http://127.0.0.1:8787"),
        ("  https://social.burakkoc.net/ ", "https://social.burakkoc.net"),
        ("HTTP://192.168.1.20:8787//", "http://192.168.1.20:8787"),
    ])
    func parsesBaseURLs(input: String, expected: String) throws {
        #expect(try ServerConfiguration.parseBaseURL(input).get().absoluteString == expected)
    }

    @Test(arguments: ["", "127.0.0.1:8787", "ftp://x", "http://x?y=1", "https://"])
    func rejectsBadBaseURLs(input: String) {
        #expect(throws: APIError.self) { try ServerConfiguration.parseBaseURL(input).get() }
    }
}
