import Foundation

// Typed endpoints. Paths and query names follow `/api/openapi.json`.

extension APIClient {
    // MARK: Health

    func health() async throws(APIError) -> HealthResponse {
        try await send(.get("/api/health"))
    }

    // MARK: Brands

    func brands(status: BrandStatus? = .active, limit: Int = 100) async throws(APIError) -> Page<Brand> {
        try await send(.get("/api/brands", query: [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "status", value: status?.rawValue),
        ]))
    }

    // MARK: Social accounts

    func socialAccounts(brandId: String) async throws(APIError) -> Page<SocialAccount> {
        try await send(.get("/api/social-accounts", query: [
            URLQueryItem(name: "brandId", value: brandId),
            URLQueryItem(name: "limit", value: "100"),
        ]))
    }

    // MARK: Contents

    func contents(
        brandId: String?, status: ContentStatus? = nil, cursor: String? = nil, limit: Int = 20
    ) async throws(APIError) -> Page<Content> {
        try await send(.get("/api/contents", query: [
            URLQueryItem(name: "brandId", value: brandId),
            URLQueryItem(name: "status", value: status?.rawValue),
            URLQueryItem(name: "cursor", value: cursor),
            URLQueryItem(name: "limit", value: String(limit)),
        ]))
    }

    func content(id: String) async throws(APIError) -> Content {
        try await send(.get("/api/contents/\(id.pathSafe)"))
    }

    func createContent(_ body: ContentCreate) async throws(APIError) -> Content {
        try await send(try .send(.post, "/api/contents", json: body))
    }

    func updateContent(id: String, _ body: ContentUpdate) async throws(APIError) -> Content {
        try await send(try .send(.patch, "/api/contents/\(id.pathSafe)", json: body))
    }

    /// Approve the current version. `hash` must equal its `contentHash` (else 409 `hash_mismatch`).
    func approveContent(id: String, hash: String) async throws(APIError) -> Content {
        try await send(try .send(.post, "/api/contents/\(id.pathSafe)/approve", json: ContentApprove(hash: hash)))
    }

    func transitionContent(id: String, to target: ContentTransition.Target) async throws(APIError) -> Content {
        try await send(try .send(.post, "/api/contents/\(id.pathSafe)/transition", json: ContentTransition(to: target)))
    }

    // MARK: Versions

    func versions(contentId: String, limit: Int = 100) async throws(APIError) -> Page<ContentVersionSummary> {
        try await send(.get("/api/contents/\(contentId.pathSafe)/versions", query: [
            URLQueryItem(name: "limit", value: String(limit)),
        ]))
    }

    func version(contentId: String, number: Int) async throws(APIError) -> ContentVersion {
        try await send(.get("/api/contents/\(contentId.pathSafe)/versions/\(number)"))
    }

    // MARK: Assets

    func asset(id: String) async throws(APIError) -> Asset {
        try await send(.get("/api/assets/\(id.pathSafe)"))
    }

    /// Raw bytes of a stored asset (rendered slides, uploads).
    func assetContent(id: String) async throws(APIError) -> Data {
        var request = URLRequest(url: configuration.url(path: "/api/assets/\(id.pathSafe)/content"))
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        for (name, value) in await authorizer.authorizationHeaders() {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return try await perform(request).0
    }

    /// `POST /api/assets` (multipart) with upload progress (0...1).
    func uploadAsset(
        _ file: UploadFile, brandId: String, progress: @escaping @Sendable (Double) -> Void
    ) async throws(APIError) -> Asset {
        var form = MultipartForm()
        form.addField("brandId", brandId)
        form.addField("source", "upload")
        if let width = file.width { form.addField("width", String(width)) }
        if let height = file.height { form.addField("height", String(height)) }
        if let durationMs = file.durationMs { form.addField("durationMs", String(durationMs)) }
        form.addFile("file", filename: file.filename, mimeType: file.mimeType, data: file.data)
        let body = form.finalize()

        var request = URLRequest(url: configuration.url(path: "/api/assets"))
        request.httpMethod = "POST"
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 300
        for (name, value) in await authorizer.authorizationHeaders() {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let delegate = UploadProgressDelegate(onProgress: progress)
        let (data, _) = try await perform(request, uploading: body, delegate: delegate)
        progress(1)
        return try decode(Asset.self, from: data)
    }

    // MARK: Jobs

    func jobs(brandId: String?, limit: Int = 50) async throws(APIError) -> Page<Job> {
        try await send(.get("/api/jobs", query: [
            URLQueryItem(name: "brandId", value: brandId),
            URLQueryItem(name: "limit", value: String(limit)),
        ]))
    }

    func job(id: String) async throws(APIError) -> Job {
        try await send(.get("/api/jobs/\(id.pathSafe)"))
    }

    func createJob(_ body: JobCreate) async throws(APIError) -> Job {
        try await send(try .send(.post, "/api/jobs", json: body))
    }

    /// Queued: cancelled at once. Running: `cancelRequestedAt` set, worker confirms later.
    func cancelJob(id: String) async throws(APIError) -> Job {
        try await send(.post("/api/jobs/\(id.pathSafe)/cancel"))
    }

    func presence() async throws(APIError) -> WorkerPresence {
        try await send(.get("/api/workers/presence"))
    }

    /// `GET /api/jobs/stream` as a WebSocket URL.
    func jobStreamURL(brandId: String?) -> URL {
        configuration.webSocketURL(
            path: "/api/jobs/stream", query: [URLQueryItem(name: "brandId", value: brandId)])
    }

    // MARK: Schedules

    func schedules(
        brandId: String?, contentId: String? = nil, status: ScheduleStatus? = nil,
        from: Date? = nil, cursor: String? = nil, limit: Int = 100
    ) async throws(APIError) -> Page<Schedule> {
        try await send(.get("/api/schedules", query: [
            URLQueryItem(name: "brandId", value: brandId),
            URLQueryItem(name: "contentId", value: contentId),
            URLQueryItem(name: "status", value: status?.rawValue),
            URLQueryItem(name: "from", value: from.map(Timestamp.format)),
            URLQueryItem(name: "cursor", value: cursor),
            URLQueryItem(name: "limit", value: String(limit)),
        ]))
    }

    func createSchedule(_ body: ScheduleCreate) async throws(APIError) -> Schedule {
        try await send(try .send(.post, "/api/schedules", json: body))
    }

    func cancelSchedule(id: String) async throws(APIError) -> Schedule {
        try await send(.post("/api/schedules/\(id.pathSafe)/cancel"))
    }
}

extension String {
    /// Percent-encodes a single path segment (ids are opaque).
    var pathSafe: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? self
    }
}
