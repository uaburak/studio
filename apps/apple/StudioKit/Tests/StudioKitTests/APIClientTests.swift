import Foundation
import Testing
@testable import StudioKit

@Suite("API client")
struct APIClientTests {
    private func client(_ handler: @escaping StubURLProtocol.Handler, auth: any AuthProvider = NoAuth()) -> (APIClient, String) {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host, handler: handler)
        return (APIClient(baseURL: URL(string: "http://\(host):8787/")!, auth: auth, session: session), host)
    }

    @Test func buildsRequestsAndDecodes() async throws {
        let body = try Fixture.data("content-list")
        let (api, host) = client { _, _ in .init(status: 200, body: body) }
        let contents = try await api.contents(brandId: "b 1", status: .draft)
        #expect(contents.count == 12)
        let request = try #require(StubURLProtocol.recorded(host: host).first?.0)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.path == "/api/contents")
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.contains(URLQueryItem(name: "brandId", value: "b 1")))
        #expect(query.contains(URLQueryItem(name: "status", value: "draft")))
        #expect(query.contains(URLQueryItem(name: "limit", value: "100")))
    }

    @Test func followsCursors() async throws {
        let (api, host) = client { request, _ in
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
            let page = cursor == nil
                ? #"{"items":[{"id":"b1","name":"A","slug":"a","defaultLanguage":"tr","status":"active","createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00Z"}],"nextCursor":"next"}"#
                : #"{"items":[{"id":"b2","name":"B","slug":"b","defaultLanguage":"tr","status":"archived","createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}],"nextCursor":null}"#
            return .init(status: 200, body: Data(page.utf8))
        }
        let brands = try await api.brands(status: nil)
        #expect(brands.map(\.id) == ["b1", "b2"])
        #expect(StubURLProtocol.recorded(host: host).count == 2)
    }

    @Test func sendsTheAuthProvidersHeaders() async throws {
        struct HeaderAuth: AuthProvider {
            func headers() async throws -> [String: String] { ["Authorization": "Bearer s3cret"] }
        }
        let (api, host) = client({ _, _ in .init(status: 200, body: try Fixture.data("presence")) }, auth: HeaderAuth())
        _ = try await api.presence()
        let request = try #require(StubURLProtocol.recorded(host: host).first?.0)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")
    }

    @Test func approvePostsTheHash() async throws {
        let content = try Fixture.data("content")
        let (api, host) = client { _, _ in .init(status: 200, body: content) }
        _ = try await api.approveContent("c1", hash: "abc")
        let (request, body) = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/contents/c1/approve")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(try JSONSerialization.jsonObject(with: body) as? [String: String] == ["hash": "abc"])
    }

    @Test func approveSendsTheChecksAcknowledgementOnlyWhenAsked() async throws {
        let content = try Fixture.data("content")
        let (api, host) = client { _, _ in .init(status: 200, body: content) }
        _ = try await api.approveContent("c1", hash: "abc")
        _ = try await api.approveContent("c1", hash: "abc", acknowledgeChecks: true)
        let bodies = StubURLProtocol.recorded(host: host).map(\.1)
        #expect(bodies.count == 2)
        #expect(try JSONSerialization.jsonObject(with: bodies[0]) as? NSDictionary == ["hash": "abc"])
        #expect(try JSONSerialization.jsonObject(with: bodies[1]) as? NSDictionary == ["hash": "abc", "acknowledgeChecks": true])
    }

    @Test func mapsTheErrorShape() async throws {
        let mismatch = try Fixture.data("error-hash-mismatch")
        let (api, _) = client { _, _ in .init(status: 409, body: mismatch) }
        await #expect(throws: StudioAPIError.self) { _ = try await api.approveContent("c1", hash: "x") }
        do {
            _ = try await api.approveContent("c1", hash: "x")
        } catch {
            #expect(error.code == .hashMismatch)
            #expect(error.errorDescription?.contains("değişti") == true)
        }
    }

    @Test func mapsNonContractResponses() async throws {
        let (html, _) = client { _, _ in .init(status: 200, body: Data("<html>Access</html>".utf8), headers: ["Content-Type": "text/html"]) }
        do {
            _ = try await html.presence()
            Issue.record("expected a failure")
        } catch {
            guard case .unexpectedResponse = error else { Issue.record("got \(error)"); return }
        }

        let (forbidden, _) = client { _, _ in .init(status: 403, body: Data("denied".utf8), headers: [:]) }
        do {
            _ = try await forbidden.presence()
            Issue.record("expected a failure")
        } catch {
            #expect(error == .unauthorized(status: 403))
        }

        let (offline, _) = client { _, _ in throw URLError(.cannotConnectToHost) }
        do {
            _ = try await offline.presence()
            Issue.record("expected a failure")
        } catch {
            #expect(error == .offline)
            #expect(error.isConnectivity)
        }
    }

    @Test func rejectsBadBaseURLs() throws {
        let api = APIClient(baseURL: URL(string: "ftp://example.com")!)
        #expect(throws: StudioAPIError.self) { _ = try api.url("/api/health") }
        let ws = try APIClient(baseURL: URL(string: "https://studio.example.com")!).conversationStreamURL("c 1", after: 7)
        #expect(ws.absoluteString == "wss://studio.example.com/api/conversations/c%201/stream?after=7")
    }

    @Test func uploadsMultipartWithProgress() async throws {
        let asset = try Fixture.data("asset")
        let (api, host) = client { _, _ in .init(status: 201, body: asset) }
        let progress = ProgressBox()
        let file = UploadFile(filename: "tarla.png", mimeType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]), width: 540, height: 675)
        let uploaded = try await api.uploadAsset(file, brandId: "brand-1") { progress.add($0) }
        #expect(uploaded.kind == .image)
        #expect(progress.values.last == 1)
        let (request, body) = try #require(StubURLProtocol.recorded(host: host).first)
        #expect(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        let text = String(decoding: body, as: UTF8.self)
        #expect(text.contains("name=\"brandId\"\r\n\r\nbrand-1\r\n"))
        #expect(text.contains("name=\"kind\"\r\n\r\nimage\r\n"))
        #expect(text.contains("name=\"width\"\r\n\r\n540\r\n"))
        #expect(text.contains("filename=\"tarla.png\"\r\nContent-Type: image/png"))
    }

    @Test func messageWireUsesAttachmentsWithAliases() throws {
        let message = OutgoingMessage(
            text: "  @image tarladan  ", attachments: [OutgoingAttachment(assetId: "a1", alias: "image"), OutgoingAttachment(assetId: "a2", alias: nil)],
            clientMessageId: "k1")
        let json = try JSONSerialization.jsonObject(with: MessageWire.encode(message)) as! [String: Any]
        #expect(json["text"] as? String == "@image tarladan")
        #expect(json["attachmentAssetIds"] == nil)
        let attachments = json["attachments"] as! [[String: String]]
        #expect(attachments == [["assetId": "a1", "alias": "image"], ["assetId": "a2"]])
        #expect(json["clientMessageId"] as? String == "k1")

        let plain = try JSONSerialization.jsonObject(with: MessageWire.encode(OutgoingMessage(text: "merhaba", clientMessageId: "k2"))) as! [String: Any]
        #expect(plain["attachments"] == nil)
        #expect(plain["model"] == nil)
        #expect(plain["effort"] == nil)
    }

    @Test func messageWireCarriesModelAndEffort() throws {
        let chosen = OutgoingMessage(text: "selam", clientMessageId: "k3", model: .opus, effort: .xhigh)
        let json = try JSONSerialization.jsonObject(with: MessageWire.encode(chosen)) as! [String: Any]
        #expect(json["model"] as? String == "opus")
        #expect(json["effort"] as? String == "xhigh")
        // An unknown value is never sent (the server would refuse it).
        let odd = OutgoingMessage(text: "selam", clientMessageId: "k4", model: .unknown, effort: .unknown)
        let oddJSON = try JSONSerialization.jsonObject(with: MessageWire.encode(odd)) as! [String: Any]
        #expect(oddJSON["model"] == nil)
        #expect(oddJSON["effort"] == nil)

        let geminiChosen = OutgoingMessage(text: "plan", clientMessageId: "k5", model: .geminiFlashLite, effort: .medium)
        let geminiJSON = try JSONSerialization.jsonObject(with: MessageWire.encode(geminiChosen)) as! [String: Any]
        #expect(geminiJSON["model"] as? String == "gemini-flash-lite")
        #expect(geminiJSON["effort"] as? String == "medium")
    }

    @Test func decideConsentAndWorkerAICommands() async throws {
        let messageJSON = """
        {"message":{"id":"m1","conversationId":"c1","role":"assistant","status":"complete","runId":"r1","parts":[{"type":"consent","consentId":"con-1","tool":"schedule_post","title":"Postu zamanla","detail":null,"state":"allowed","decidedAt":"2026-11-16T14:00:00.000Z"}],"createdAt":"2026-11-16T14:00:00.000Z","updatedAt":"2026-11-16T14:00:00.000Z"}}
        """
        let claudeJSON = #"{"account":{"status":"signed_in","email":"deniz@ornek.com","plan":"Claude Max","cliVersion":"1.0.24","loginUrl":null,"detail":null,"checkedAt":"2026-11-16T14:00:00.000Z"},"online":true,"sent":1}"#
        let geminiJSON = #"{"account":{"status":"ready","mode":"api","apiKeyConfigured":true,"cliVersion":null,"defaultModel":"gemini-2.5-flash-lite","detail":"Hazır","checkedAt":"2026-11-16T14:00:00.000Z"},"online":true,"sent":0}"#

        let (api, host) = client { request, _ in
            let path = request.url!.path
            if path.hasSuffix("/consent") { return .init(status: 200, body: Data(messageJSON.utf8)) }
            if path.contains("/workers/claude") { return .init(status: 200, body: Data(claudeJSON.utf8)) }
            return .init(status: 200, body: Data(geminiJSON.utf8))
        }

        let consent = try await api.decideConsent(conversationId: "c1", messageId: "m1", ConsentDecisionCreate(consentId: "con-1", allow: true))
        guard case .consent(let part) = consent.message.parts.first else {
            Issue.record("expected consent part"); return
        }
        #expect(part.state == .allowed)

        let claude = try await api.claudeControl()
        #expect(claude.account?.status == .signedIn)
        _ = try await api.claudeLogin()
        _ = try await api.claudeRefresh()

        let gemini = try await api.geminiControl()
        #expect(gemini.account?.status == .ready)
        _ = try await api.geminiRefresh()

        let recorded = StubURLProtocol.recorded(host: host)
        #expect(recorded.map { "\($0.0.httpMethod!) \($0.0.url!.path)" } == [
            "POST /api/conversations/c1/messages/m1/consent",
            "GET /api/workers/claude",
            "POST /api/workers/claude/login",
            "POST /api/workers/claude/status",
            "GET /api/workers/gemini",
            "POST /api/workers/gemini/status",
        ])
        let consentBody = try JSONSerialization.jsonObject(with: recorded[0].1) as? [String: Any]
        #expect(consentBody?["consentId"] as? String == "con-1")
        #expect(consentBody?["allow"] as? Bool == true)
    }

    @Test func acceptAndGenerateSendsModelAndEffort() async throws {
        let plan = try #require(try Fixture.decode(Page<Plan>.self, "plan-list").items.first { $0.status == .accepted })
        let planJSON = try StudioJSON.encoder().encode(plan)
        let generated = Data(#"{"plan":"#.utf8) + planJSON + Data(#","jobs":[]}"#.utf8)
        let (api, host) = client { request, _ in
            .init(status: 200, body: request.url!.path.hasSuffix("/generate") ? generated : planJSON)
        }
        let service = RemoteConversationService(client: api)
        _ = try await service.acceptAndGenerate(plan, model: .sonnet, effort: .high)
        let recorded = StubURLProtocol.recorded(host: host)
        let generate = try #require(recorded.first { $0.0.url!.path.hasSuffix("/generate") })
        let body = try JSONSerialization.jsonObject(with: generate.1) as? [String: String]
        #expect(body == ["model": "sonnet", "effort": "high"])

        _ = try await service.acceptAndGenerate(plan)
        let plain = try #require(StubURLProtocol.recorded(host: host).last)
        #expect(try JSONSerialization.jsonObject(with: plain.1) as? [String: String] == [:])
    }
}

final class ProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Double] = []
    func add(_ value: Double) { lock.withLock { stored.append(value) } }
    var values: [Double] { lock.withLock { stored } }
}
