#if DEBUG
import UIKit

/// In-process fake of the Studio API for UI tests and previews (Debug builds
/// only). Launch with `-StudioUITest` to use it: HTTP goes through
/// `StubURLProtocol`, the job stream through `StubWebSocketConnector`, and
/// nothing leaves the app. The data is small but stateful enough to create
/// content, queue a job, approve and schedule.
enum StubBackend {
    static let launchArgument = "-StudioUITest"

    static func environment() -> AppEnvironment {
        let defaults = UserDefaults(suiteName: "studio.uitest")!
        defaults.removePersistentDomain(forName: "studio.uitest")
        StubServer.shared.reset()
        return AppEnvironment(
            preferences: Preferences(defaults: defaults),
            credentials: InMemoryCredentialStore(),
            makeSession: { APIClient.makeSession(protocolClasses: [StubURLProtocol.self]) },
            webSocketConnector: StubWebSocketConnector(),
            push: DisabledPushRegistration())
    }
}

final class StubServer: Sendable {
    static let shared = StubServer()

    struct State: Sendable {
        var brands: [Brand] = []
        var accounts: [SocialAccount] = []
        var contents: [Content] = []
        var versions: [String: [ContentVersion]] = [:]
        var jobs: [Job] = []
        var schedules: [Schedule] = []
        var presence = WorkerPresence(online: false, lastSeenAt: nil, workers: [], currentJobs: [], queueLength: 0)
        var counter = 0
    }

    let state = Locked(State())

    func reset() {
        state.value = Self.seed()
    }

    static func seed(now: Date = .now) -> State {
        var s = State()
        let brand = Brand(id: "brand-1", name: "Deneme Markası", slug: "deneme-markasi", defaultLanguage: "tr",
                          status: .active, createdAt: now, updatedAt: now)
        s.brands = [brand]
        s.accounts = [SocialAccount(id: "acc-1", brandId: brand.id, platform: .instagram, handle: "@denememarkasi",
                                    externalId: nil, status: .pending, createdAt: now, updatedAt: now)]
        let slides = [
            Slide(html: "<html><body><h1>Hasat zamanı</h1></body></html>", width: 1080, height: 1350, renderedAssetId: "asset-1"),
            Slide(html: "<html><body><p>Bayinize sorun.</p></body></html>", width: 1080, height: 1350, renderedAssetId: nil),
        ]
        let hash = ContentHash.compute(slides)
        let version = ContentVersion(id: "ver-1", contentId: "content-1", version: 1, origin: .generated,
                                     contentHash: hash, slideCount: 2, note: "İlk sürüm", jobId: nil,
                                     createdAt: now, updatedAt: now, slides: slides)
        s.versions["content-1"] = [version]
        s.contents = [Content(
            id: "content-1", brandId: brand.id, type: .carousel, title: "Hasat sezonu",
            brief: "İki slaytlık carousel: güçlü başlık, sonra bayilere çağrı.", status: .inReview,
            targetPlatforms: [.instagram], caption: "Hasat zamanı geldi. 🌾",
            currentVersion: ContentVersionRef(id: version.id, version: 1, contentHash: hash), approval: nil,
            createdAt: now.addingTimeInterval(-3600), updatedAt: now.addingTimeInterval(-3600))]
        return s
    }

    // MARK: Routing

    func handle(_ request: URLRequest, body: Data?) -> (Int, Data, String) {
        let url = request.url!
        let path = url.path()
        let method = request.httpMethod ?? "GET"
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func param(_ name: String) -> String? { query.first { $0.name == name }?.value }
        let parts = path.split(separator: "/").map(String.init) // ["api", "contents", id, ...]
        let now = Date.now

        func json(_ value: some Encodable, status: Int = 200) -> (Int, Data, String) {
            (status, (try? StudioJSON.encoder().encode(value)) ?? Data(), "application/json")
        }
        func page<T: Encodable>(_ items: [T]) -> (Int, Data, String) {
            json(StubPage(items: items, nextCursor: nil))
        }
        func error(_ status: Int, _ code: String, _ message: String) -> (Int, Data, String) {
            let text = "{\"error\":{\"code\":\"\(code)\",\"message\":\"\(message)\"}}"
            return (status, Data(text.utf8), "application/json")
        }
        func decode<T: Decodable>(_ type: T.Type) -> T? {
            body.flatMap { try? StudioJSON.decoder().decode(T.self, from: $0) }
        }
        func nextId(_ prefix: String) -> String {
            state.withLock { $0.counter += 1; return "\(prefix)-\($0.counter + 100)" }
        }

        switch (method, parts.dropFirst().first ?? "", parts.count) {
        case ("GET", "health", _):
            return json(HealthResponse(status: "ok", service: "studio-api", version: "stub", time: now, checks: .init(db: "ok")))
        case ("GET", "brands", 2):
            return page(state.value.brands)
        case ("GET", "social-accounts", 2):
            return page(state.value.accounts.filter { $0.brandId == param("brandId") || param("brandId") == nil })
        case ("GET", "workers", _):
            return json(state.value.presence)
        case ("GET", "contents", 2):
            let status = param("status")
            return page(state.value.contents
                .filter { status == nil || $0.status.rawValue == status }
                .sorted { $0.createdAt > $1.createdAt })
        case ("POST", "contents", 2):
            struct Create: Decodable { var brandId: String; var type: ContentType; var title: String; var brief: String?; var targetPlatforms: [Platform]? }
            guard let input = decode(Create.self) else { return error(400, "validation_error", "invalid") }
            let content = Content(id: nextId("content"), brandId: input.brandId, type: input.type, title: input.title,
                                  brief: input.brief ?? "", status: .draft, targetPlatforms: input.targetPlatforms ?? [],
                                  caption: "", currentVersion: nil, approval: nil, createdAt: now, updatedAt: now)
            state.withLock { $0.contents.append(content) }
            return json(content, status: 201)
        case (_, "contents", 3...):
            let id = parts[2]
            guard var content = state.value.contents.first(where: { $0.id == id }) else {
                return error(404, "not_found", "content not found")
            }
            let action = parts.count > 3 ? parts[3] : ""
            switch (method, action) {
            case ("GET", ""):
                return json(content)
            case ("PATCH", ""):
                struct Update: Decodable { var caption: String? }
                if let caption = decode(Update.self)?.caption {
                    content.caption = caption
                    if content.status.captionEditRevokesApproval {
                        content.status = .draft
                        content.approval = nil
                    }
                }
            case ("GET", "versions") where parts.count == 4:
                return page((state.value.versions[id] ?? []).map(\.summary).reversed())
            case ("GET", "versions"):
                guard let number = Int(parts[4]),
                      let version = state.value.versions[id]?.first(where: { $0.version == number })
                else { return error(404, "not_found", "version not found") }
                return json(version)
            case ("POST", "approve"):
                struct Approve: Decodable { var hash: String }
                guard let hash = decode(Approve.self)?.hash, let current = content.currentVersion else {
                    return error(400, "validation_error", "invalid")
                }
                guard hash == current.contentHash else { return error(409, "hash_mismatch", "hash does not match") }
                content.status = .approved
                content.approval = ContentApproval(versionId: current.id, contentHash: hash, approvedAt: now)
            case ("POST", "transition"):
                struct Transition: Decodable { var to: String }
                let target = decode(Transition.self)?.to ?? ""
                content.status = ContentStatus(rawValue: target) ?? content.status
                if content.status == .draft { content.approval = nil }
            default:
                return error(404, "not_found", "no route")
            }
            content.updatedAt = now
            let updated = content
            state.withLock { s in s.contents = s.contents.map { $0.id == updated.id ? updated : $0 } }
            return json(updated)
        case ("GET", "jobs", 2):
            return page(state.value.jobs.sorted { $0.createdAt > $1.createdAt })
        case ("POST", "jobs", 2):
            struct Create: Decodable { var type: JobType; var payload: [String: JSONValue]?; var contentId: String? }
            guard let input = decode(Create.self) else { return error(400, "validation_error", "invalid") }
            let brandId = state.value.contents.first { $0.id == input.contentId }?.brandId
            let job = Job(id: nextId("job"), type: input.type, status: .queued, payload: input.payload ?? [:],
                          brandId: brandId, contentId: input.contentId, createdAt: now, updatedAt: now,
                          priority: 0, attempts: 0, maxAttempts: 3)
            state.withLock { $0.jobs.append(job); $0.presence.queueLength += 1 }
            return json(job, status: 201)
        case ("POST", "jobs", 4):
            guard var job = state.value.jobs.first(where: { $0.id == parts[2] }) else {
                return error(404, "not_found", "job not found")
            }
            guard job.status.isActive else { return error(409, "invalid_transition", "job already finished") }
            job.status = .cancelled
            job.cancelRequestedAt = now
            job.finishedAt = now
            job.updatedAt = now
            let updated = job
            state.withLock { s in
                s.jobs = s.jobs.map { $0.id == updated.id ? updated : $0 }
                s.presence.queueLength = max(0, s.presence.queueLength - 1)
            }
            return json(updated)
        case ("GET", "schedules", 2):
            let contentId = param("contentId")
            return page(state.value.schedules
                .filter { contentId == nil || $0.contentId == contentId }
                .sorted { $0.scheduledAt < $1.scheduledAt })
        case ("POST", "schedules", 2):
            struct Create: Decodable { var contentId: String; var socialAccountId: String; var scheduledAt: Date }
            guard let input = decode(Create.self),
                  var content = state.value.contents.first(where: { $0.id == input.contentId }),
                  let approval = content.approval
            else { return error(409, "invalid_transition", "not approved") }
            let schedule = Schedule(id: nextId("schedule"), contentId: content.id, brandId: content.brandId,
                                    platform: .instagram, socialAccountId: input.socialAccountId,
                                    versionId: approval.versionId, contentHash: approval.contentHash,
                                    scheduledAt: input.scheduledAt, status: .pending, cancelledAt: nil,
                                    createdAt: now, updatedAt: now)
            content.status = .scheduled
            let updated = content
            state.withLock { s in
                s.schedules.append(schedule)
                s.contents = s.contents.map { $0.id == updated.id ? updated : $0 }
            }
            return json(schedule, status: 201)
        case ("POST", "schedules", 4):
            guard var schedule = state.value.schedules.first(where: { $0.id == parts[2] }) else {
                return error(404, "not_found", "schedule not found")
            }
            schedule.status = .cancelled
            schedule.cancelledAt = now
            let updated = schedule
            state.withLock { s in s.schedules = s.schedules.map { $0.id == updated.id ? updated : $0 } }
            return json(updated)
        case ("GET", "assets", 4):
            return (200, Self.slideImage(), "image/png")
        case ("POST", "assets", 2):
            let asset = Asset(id: nextId("asset"), brandId: "brand-1", kind: .image, source: .upload,
                              objectKey: "stub", mimeType: "image/jpeg", bytes: body?.count ?? 0, sha256: "",
                              width: nil, height: nil, durationMs: nil, originalFilename: "foto.jpg", createdAt: now)
            return json(asset, status: 201)
        default:
            return error(404, "not_found", "no stub for \(method) \(path)")
        }
    }

    /// A 4:5 placeholder "rendered slide".
    static func slideImage() -> Data {
        let size = CGSize(width: 432, height: 540)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.pngData { context in
            UIColor(red: 0.96, green: 0.55, blue: 0.24, alpha: 1).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            let text = NSAttributedString(string: "Hasat\nzamanı", attributes: [
                .font: UIFont.systemFont(ofSize: 64, weight: .heavy), .foregroundColor: UIColor.white,
            ])
            text.draw(in: CGRect(x: 32, y: 180, width: size.width - 64, height: 200))
        }
    }
}

private struct StubPage<Item: Encodable>: Encodable {
    var items: [Item]
    var nextCursor: String?
}

final class StubURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read)
        let (status, data, contentType) = StubServer.shared.handle(request, body: body)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// Sends one snapshot of the stub state, then stays open until closed.
struct StubWebSocketConnector: WebSocketConnecting {
    func connect(url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
        StubWebSocketConnection()
    }
}

final class StubWebSocketConnection: WebSocketConnection {
    private let sentSnapshot = Locked(false)
    private let closed = Locked(false)

    func receive() async throws -> String {
        if !sentSnapshot.withLock({ let was = $0; $0 = true; return was }) {
            let state = StubServer.shared.state.value
            struct Frame: Encodable { var type = "jobs.snapshot"; var jobs: [Job]; var presence: WorkerPresence }
            let data = try StudioJSON.encoder().encode(Frame(jobs: state.jobs, presence: state.presence))
            return String(decoding: data, as: UTF8.self)
        }
        while !closed.value {
            try await Task.sleep(for: .milliseconds(200))
        }
        throw URLError(.networkConnectionLost)
    }

    func send(_ text: String) async throws {}
    func close() { closed.value = true }
}
#endif
