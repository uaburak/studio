import Foundation

/// `GET /api/health`.
public struct HealthResponse: Codable, Sendable, Equatable {
    public struct Checks: Codable, Sendable, Equatable { public var db: String }
    public var status: String
    public var service: String
    public var version: String
    public var time: Date
    public var checks: Checks
    /// Id of the Mac host that started this API (absent when started by hand).
    public var instance: String?
}

/// Typed client for the Studio API (mirror of `createApiClient` in
/// packages/contract/src/client.ts). Every method throws `StudioAPIError`
/// only; responses are decoded strictly against the contract models.
public final class APIClient: Sendable {
    public let baseURL: URL
    public let session: URLSession
    public let auth: any AuthProvider

    /// `http://127.0.0.1:8787`: `pnpm --filter @studio/api dev`.
    public static let localDefaultURL = URL(string: "http://127.0.0.1:8787")!

    public init(baseURL: URL, auth: any AuthProvider = NoAuth(), session: URLSession = .shared) {
        self.baseURL = baseURL
        self.auth = auth
        self.session = session
    }

    // MARK: - Core

    public enum Method: String, Sendable { case get = "GET", post = "POST", patch = "PATCH", put = "PUT", delete = "DELETE" }

    /// `baseURL + path + ?query`; nil query values are dropped.
    public func url(_ path: String, query: [String: String?] = [:]) throws(StudioAPIError) -> URL {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard var components = URLComponents(string: base + path) else {
            throw .invalidConfiguration("Sunucu adresi geçersiz: \(baseURL.absoluteString)")
        }
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
            .sorted { $0.name < $1.name }
        if !items.isEmpty { components.queryItems = items }
        guard let url = components.url, url.scheme == "http" || url.scheme == "https" else {
            throw .invalidConfiguration("Sunucu adresi http ya da https olmalı: \(baseURL.absoluteString)")
        }
        return url
    }

    /// WebSocket URL for a stream path (http -> ws, https -> wss).
    public func webSocketURL(_ path: String, query: [String: String?] = [:]) throws(StudioAPIError) -> URL {
        let http = try url(path, query: query)
        var components = URLComponents(url: http, resolvingAgainstBaseURL: false)
        components?.scheme = http.scheme == "https" ? "wss" : "ws"
        guard let ws = components?.url else { throw .invalidConfiguration("WebSocket adresi kurulamadı.") }
        return ws
    }

    public func authHeaders() async throws(StudioAPIError) -> [String: String] {
        do {
            return try await auth.headers()
        } catch {
            throw .invalidConfiguration("Erişim anahtarı okunamadı: \(error.localizedDescription)")
        }
    }

    func makeRequest(_ method: Method, _ path: String, query: [String: String?] = [:], body: Data? = nil, contentType: String? = nil) async throws(StudioAPIError) -> URLRequest {
        var request = URLRequest(url: try url(path, query: query))
        request.httpMethod = method.rawValue
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in try await authHeaders() { request.setValue(value, forHTTPHeaderField: name) }
        if let body {
            request.httpBody = body
            request.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    func encode(_ value: some Encodable) throws(StudioAPIError) -> Data {
        do {
            return try StudioJSON.encoder().encode(value)
        } catch {
            throw .invalidConfiguration("İstek gövdesi kodlanamadı: \(error.localizedDescription)")
        }
    }

    /// Perform a request and return the raw 2xx body.
    public func data(for request: URLRequest) async throws(StudioAPIError) -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw StudioAPIError.from(error)
        }
        try Self.check(response, data)
        return data
    }

    static func check(_ response: URLResponse, _ data: Data) throws(StudioAPIError) {
        guard let http = response as? HTTPURLResponse else { throw .unexpectedResponse("yanıt HTTP değil") }
        guard (200..<300).contains(http.statusCode) else { throw StudioAPIError.from(status: http.statusCode, body: data) }
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws(StudioAPIError) -> T {
        do {
            return try StudioJSON.decoder().decode(T.self, from: data)
        } catch let error as DecodingError {
            if let first = data.first, first == UInt8(ascii: "<") {
                throw .unexpectedResponse("JSON yerine HTML geldi (erişim sayfası olabilir)")
            }
            throw .decoding(StudioAPIError.describe(error))
        } catch {
            throw .decoding(error.localizedDescription)
        }
    }

    public func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String?] = [:]) async throws(StudioAPIError) -> T {
        let request = try await makeRequest(.get, path, query: query)
        return try decode(T.self, from: try await data(for: request))
    }

    public func send<T: Decodable>(_ type: T.Type, _ method: Method, _ path: String, body: (some Encodable)?) async throws(StudioAPIError) -> T {
        let encoded = try body.map { value throws(StudioAPIError) in try encode(value) }
        let request = try await makeRequest(method, path, body: encoded ?? (method == .get ? nil : Data("{}".utf8)))
        return try decode(T.self, from: try await data(for: request))
    }

    public func send<T: Decodable>(_ type: T.Type, _ method: Method, _ path: String) async throws(StudioAPIError) -> T {
        try await send(T.self, method, path, body: Optional<EmptyBody>.none)
    }

    /// Follow `nextCursor` until the last page (or `maxPages`).
    public func all<T: Decodable & Sendable>(_ type: T.Type, _ path: String, query: [String: String?] = [:], maxPages: Int = 20) async throws(StudioAPIError) -> [T] {
        var items: [T] = []
        var cursor: String?
        for _ in 0..<maxPages {
            var q = query
            q["limit"] = "100"
            q["cursor"] = cursor
            let page = try await get(Page<T>.self, path, query: q)
            items += page.items
            guard let next = page.nextCursor else { break }
            cursor = next
        }
        return items
    }

    private struct EmptyBody: Encodable {}

    static func enc(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
    }

    // MARK: - System

    public func health() async throws(StudioAPIError) -> HealthResponse {
        try await get(HealthResponse.self, "/api/health")
    }

    // MARK: - Brands and accounts

    public func brands(status: BrandStatus? = .active) async throws(StudioAPIError) -> [Brand] {
        try await all(Brand.self, "/api/brands", query: ["status": status?.rawValue])
    }

    public func brand(_ id: EntityID) async throws(StudioAPIError) -> Brand {
        try await get(Brand.self, "/api/brands/\(Self.enc(id))")
    }

    public func createBrand(_ input: BrandCreate) async throws(StudioAPIError) -> Brand {
        try await send(Brand.self, .post, "/api/brands", body: input)
    }

    public func updateBrand(_ id: EntityID, _ input: BrandUpdate) async throws(StudioAPIError) -> Brand {
        try await send(Brand.self, .patch, "/api/brands/\(Self.enc(id))", body: input)
    }

    // MARK: - Brand profiles

    public func brandProfiles(brandId: EntityID, status: BrandProfileStatus? = nil) async throws(StudioAPIError) -> [BrandProfile] {
        try await all(BrandProfile.self, "/api/brands/\(Self.enc(brandId))/profiles", query: ["status": status?.sendable?.rawValue])
    }

    /// Returns `nil` when the brand has no approved profile yet (HTTP 404).
    public func currentBrandProfile(brandId: EntityID) async throws(StudioAPIError) -> BrandProfile? {
        do {
            return try await get(BrandProfile.self, "/api/brands/\(Self.enc(brandId))/profiles/current")
        } catch {
            if error.code == .notFound { return nil }
            if case .server(let status, _, _, _) = error, status == 404 { return nil }
            throw error
        }
    }

    public func brandProfile(brandId: EntityID, version: Int) async throws(StudioAPIError) -> BrandProfile {
        try await get(BrandProfile.self, "/api/brands/\(Self.enc(brandId))/profiles/\(version)")
    }

    public func createBrandProfile(brandId: EntityID, _ input: BrandProfileCreate = BrandProfileCreate()) async throws(StudioAPIError) -> BrandProfile {
        try await send(BrandProfile.self, .post, "/api/brands/\(Self.enc(brandId))/profiles", body: input)
    }

    public func updateBrandProfile(brandId: EntityID, version: Int, _ input: BrandProfileUpdate) async throws(StudioAPIError) -> BrandProfile {
        try await send(BrandProfile.self, .patch, "/api/brands/\(Self.enc(brandId))/profiles/\(version)", body: input)
    }

    public func approveBrandProfile(brandId: EntityID, version: Int) async throws(StudioAPIError) -> BrandProfile {
        try await send(BrandProfile.self, .post, "/api/brands/\(Self.enc(brandId))/profiles/\(version)/approve")
    }

    public func analyzeBrand(brandId: EntityID, notes: String? = nil) async throws(StudioAPIError) -> Job {
        var payload: JSONObject = [:]
        if let notes = notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
            payload["notes"] = .string(notes)
        }
        return try await createJob(JobCreate(type: .brandAnalyze, payload: payload, brandId: brandId))
    }

    // MARK: - Social accounts & OAuth / Token vault

    public func socialAccounts(brandId: EntityID? = nil) async throws(StudioAPIError) -> [SocialAccount] {
        try await all(SocialAccount.self, "/api/social-accounts", query: ["brandId": brandId])
    }

    public func createSocialAccount(_ input: SocialAccountCreate) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .post, "/api/social-accounts", body: input)
    }

    public func updateSocialAccount(_ id: EntityID, _ input: SocialAccountUpdate) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .patch, "/api/social-accounts/\(Self.enc(id))", body: input)
    }

    public func putSocialAccountToken(id: EntityID, _ input: SocialAccountTokenPut) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .put, "/api/social-accounts/\(Self.enc(id))/token", body: input)
    }

    public func checkSocialAccountToken(id: EntityID) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .post, "/api/social-accounts/\(Self.enc(id))/check")
    }

    public func discoverMetaAccounts(_ input: MetaDiscoverInput) async throws(StudioAPIError) -> MetaDiscoverResult {
        try await send(MetaDiscoverResult.self, .post, "/api/social-accounts/meta/discover", body: input)
    }

    public func connectLinkedInAccount(_ input: LinkedInConnectInput) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .post, "/api/social-accounts/linkedin/connect", body: input)
    }

    // MARK: - Contents

    public func contents(brandId: EntityID? = nil, status: ContentStatus? = nil) async throws(StudioAPIError) -> [Content] {
        try await all(Content.self, "/api/contents", query: ["brandId": brandId, "status": status?.rawValue])
    }

    public func content(_ id: EntityID) async throws(StudioAPIError) -> Content {
        try await get(Content.self, "/api/contents/\(Self.enc(id))")
    }

    public func updateContent(_ id: EntityID, _ update: ContentUpdate) async throws(StudioAPIError) -> Content {
        try await send(Content.self, .patch, "/api/contents/\(Self.enc(id))", body: update)
    }

    /// Approve the current version; `hash` must equal its `contentHash` (else 409 `hash_mismatch`).
    public func approveContent(_ id: EntityID, hash: String) async throws(StudioAPIError) -> Content {
        struct Body: Encodable { var hash: String }
        return try await send(Content.self, .post, "/api/contents/\(Self.enc(id))/approve", body: Body(hash: hash))
    }

    public func transitionContent(_ id: EntityID, to: ContentManualTransition) async throws(StudioAPIError) -> Content {
        struct Body: Encodable { var to: ContentManualTransition }
        return try await send(Content.self, .post, "/api/contents/\(Self.enc(id))/transition", body: Body(to: to))
    }

    public func contentVersion(contentId: EntityID, version: Int) async throws(StudioAPIError) -> ContentVersion {
        try await get(ContentVersion.self, "/api/contents/\(Self.enc(contentId))/versions/\(version)")
    }

    public func contentVersions(contentId: EntityID) async throws(StudioAPIError) -> [ContentVersionSummary] {
        try await all(ContentVersionSummary.self, "/api/contents/\(Self.enc(contentId))/versions")
    }

    public func versions(contentId: EntityID) async throws(StudioAPIError) -> [ContentVersionSummary] {
        try await contentVersions(contentId: contentId)
    }

    /// Queue `content.render` with `slotAssignments: [slotId: assetId]`.
    public func fillSlotAndRender(contentId: EntityID, slotId: String, assetId: EntityID) async throws(StudioAPIError) -> Job {
        let payload: JSONObject = [
            "format": .string("jpeg"),
            "slotAssignments": .object([slotId: .string(assetId)]),
        ]
        return try await createJob(JobCreate(type: .contentRender, payload: payload, contentId: contentId))
    }

    /// Queue `content.render` with `patches`.
    public func patchLayersAndRender(contentId: EntityID, patches: [SlideLayerPatch]) async throws(StudioAPIError) -> Job {
        let payload: JSONObject = [
            "format": .string("jpeg"),
            "patches": .array(patches.map { .object($0.toJSONObject()) }),
        ]
        return try await createJob(JobCreate(type: .contentRender, payload: payload, contentId: contentId))
    }

    /// Queue `content.render` export (`format: "jpeg" | "pdf" | "both"`).
    public func exportContent(contentId: EntityID, format: String) async throws(StudioAPIError) -> Job {
        let payload: JSONObject = ["format": .string(format)]
        return try await createJob(JobCreate(type: .contentRender, payload: payload, contentId: contentId))
    }

    // MARK: - Schedules

    public func schedules(brandId: EntityID? = nil, contentId: EntityID? = nil, status: ScheduleStatus? = nil, from: Date? = nil, to: Date? = nil) async throws(StudioAPIError) -> [Schedule] {
        try await all(Schedule.self, "/api/schedules", query: [
            "brandId": brandId, "contentId": contentId, "status": status?.rawValue,
            "from": from.map(Timestamp.format), "to": to.map(Timestamp.format),
        ])
    }

    public func createSchedule(_ input: ScheduleCreate) async throws(StudioAPIError) -> Schedule {
        try await send(Schedule.self, .post, "/api/schedules", body: input)
    }

    public func cancelSchedule(_ id: EntityID) async throws(StudioAPIError) -> Schedule {
        try await send(Schedule.self, .post, "/api/schedules/\(Self.enc(id))/cancel")
    }

    public func scheduleLogs(scheduleId: EntityID) async throws(StudioAPIError) -> [PublishLog] {
        try await all(PublishLog.self, "/api/schedules/\(Self.enc(scheduleId))/logs")
    }

    // MARK: - Jobs and presence

    public func jobs(brandId: EntityID? = nil, contentId: EntityID? = nil, status: JobStatus? = nil, limit: Int = 50) async throws(StudioAPIError) -> [Job] {
        try await get(Page<Job>.self, "/api/jobs", query: [
            "brandId": brandId, "contentId": contentId, "status": status?.rawValue, "limit": String(limit),
        ]).items
    }

    public func job(_ id: EntityID) async throws(StudioAPIError) -> Job {
        try await get(Job.self, "/api/jobs/\(Self.enc(id))")
    }

    public func createJob(_ input: JobCreate) async throws(StudioAPIError) -> Job {
        try await send(Job.self, .post, "/api/jobs", body: input)
    }

    public func cancelJob(_ id: EntityID) async throws(StudioAPIError) -> Job {
        try await send(Job.self, .post, "/api/jobs/\(Self.enc(id))/cancel")
    }

    public func presence() async throws(StudioAPIError) -> WorkerPresence {
        try await get(WorkerPresence.self, "/api/workers/presence")
    }

    public func claudeControl() async throws(StudioAPIError) -> ClaudeControl {
        try await get(ClaudeControl.self, "/api/workers/claude")
    }

    public func claudeLogin() async throws(StudioAPIError) -> ClaudeControl {
        try await send(ClaudeControl.self, .post, "/api/workers/claude/login")
    }

    public func claudeRefresh() async throws(StudioAPIError) -> ClaudeControl {
        try await send(ClaudeControl.self, .post, "/api/workers/claude/status")
    }

    public func geminiControl() async throws(StudioAPIError) -> GeminiControl {
        try await get(GeminiControl.self, "/api/workers/gemini")
    }

    public func geminiRefresh() async throws(StudioAPIError) -> GeminiControl {
        try await send(GeminiControl.self, .post, "/api/workers/gemini/status")
    }

    /// `GET /api/jobs/stream` (WebSocket): one job, one brand, or every job.
    public func jobStreamURL(jobId: EntityID? = nil, brandId: EntityID? = nil) throws(StudioAPIError) -> URL {
        try webSocketURL("/api/jobs/stream", query: ["jobId": jobId, "brandId": brandId])
    }

    // MARK: - Conversations

    /// Most recently active first.
    public func conversations(brandId: EntityID? = nil, status: ConversationStatus? = .active) async throws(StudioAPIError) -> [Conversation] {
        try await all(Conversation.self, "/api/conversations", query: ["brandId": brandId, "status": status?.rawValue])
    }

    public func conversation(_ id: EntityID) async throws(StudioAPIError) -> Conversation {
        try await get(Conversation.self, "/api/conversations/\(Self.enc(id))")
    }

    public func createConversation(_ input: ConversationCreate) async throws(StudioAPIError) -> Conversation {
        try await send(Conversation.self, .post, "/api/conversations", body: input)
    }

    public func updateConversation(_ id: EntityID, _ input: ConversationUpdate) async throws(StudioAPIError) -> Conversation {
        try await send(Conversation.self, .patch, "/api/conversations/\(Self.enc(id))", body: input)
    }

    /// Newest first; pass `cursor` for older ones.
    public func messages(conversationId: EntityID, cursor: String? = nil, limit: Int = 50) async throws(StudioAPIError) -> Page<Message> {
        try await get(Page<Message>.self, "/api/conversations/\(Self.enc(conversationId))/messages", query: ["cursor": cursor, "limit": String(limit)])
    }

    /// Send a user message; starts an agent run. 409 `conflict` while another run is active.
    public func sendMessage(conversationId: EntityID, _ input: some Encodable & Sendable) async throws(StudioAPIError) -> UserMessageResult {
        try await send(UserMessageResult.self, .post, "/api/conversations/\(Self.enc(conversationId))/messages", body: input)
    }

    public func answerQuestion(conversationId: EntityID, messageId: EntityID, _ input: QuestionAnswerCreate) async throws(StudioAPIError) -> QuestionAnswerResult {
        try await send(QuestionAnswerResult.self, .post, "/api/conversations/\(Self.enc(conversationId))/messages/\(Self.enc(messageId))/answer", body: input)
    }

    public func decideConsent(conversationId: EntityID, messageId: EntityID, _ decision: ConsentDecisionCreate) async throws(StudioAPIError) -> ConsentDecisionResult {
        try await send(ConsentDecisionResult.self, .post, "/api/conversations/\(Self.enc(conversationId))/messages/\(Self.enc(messageId))/consent", body: decision)
    }

    /// Every attachment alias of the conversation, oldest first (not paginated).
    public func aliases(conversationId: EntityID) async throws(StudioAPIError) -> [ConversationAlias] {
        struct List: Decodable { var items: [ConversationAlias] }
        return try await get(List.self, "/api/conversations/\(Self.enc(conversationId))/aliases").items
    }

    /// Rename an alias by its stable id. 409 `conflict` when the name is or was used by another alias.
    public func renameAlias(conversationId: EntityID, aliasId: EntityID, to name: String) async throws(StudioAPIError) -> ConversationAlias {
        struct Body: Encodable { var alias: String }
        return try await send(ConversationAlias.self, .patch, "/api/conversations/\(Self.enc(conversationId))/aliases/\(Self.enc(aliasId))", body: Body(alias: name))
    }

    public func runs(conversationId: EntityID) async throws(StudioAPIError) -> [AgentRun] {
        try await get(Page<AgentRun>.self, "/api/conversations/\(Self.enc(conversationId))/runs").items
    }

    public func cancelRun(_ id: EntityID) async throws(StudioAPIError) -> AgentRun {
        try await send(AgentRun.self, .post, "/api/agent-runs/\(Self.enc(id))/cancel")
    }

    /// `GET /api/conversations/{id}/stream` (WebSocket); `after` resumes from a seq.
    public func conversationStreamURL(_ id: EntityID, after: Int? = nil) throws(StudioAPIError) -> URL {
        try webSocketURL("/api/conversations/\(Self.enc(id))/stream", query: ["after": after.map(String.init)])
    }

    // MARK: - Plans

    public func plans(brandId: EntityID? = nil, conversationId: EntityID? = nil, status: PlanStatus? = nil) async throws(StudioAPIError) -> [Plan] {
        try await all(Plan.self, "/api/plans", query: ["brandId": brandId, "conversationId": conversationId, "status": status?.rawValue])
    }

    public func plan(_ id: EntityID) async throws(StudioAPIError) -> Plan {
        try await get(Plan.self, "/api/plans/\(Self.enc(id))")
    }

    public func acceptPlan(_ id: EntityID, _ input: PlanAccept) async throws(StudioAPIError) -> Plan {
        try await send(Plan.self, .post, "/api/plans/\(Self.enc(id))/accept", body: input)
    }

    public func rejectPlan(_ id: EntityID, _ input: PlanReject = PlanReject()) async throws(StudioAPIError) -> Plan {
        try await send(Plan.self, .post, "/api/plans/\(Self.enc(id))/reject", body: input)
    }

    public func generatePlan(_ id: EntityID, _ input: PlanGenerate = PlanGenerate()) async throws(StudioAPIError) -> PlanGenerateResult {
        try await send(PlanGenerateResult.self, .post, "/api/plans/\(Self.enc(id))/generate", body: input)
    }

    // MARK: - Assets & AI image generation

    public func assets(brandId: EntityID? = nil, kind: AssetKind? = nil) async throws(StudioAPIError) -> [Asset] {
        try await all(Asset.self, "/api/assets", query: ["brandId": brandId, "kind": kind?.sendable?.rawValue])
    }

    public func asset(_ id: EntityID) async throws(StudioAPIError) -> Asset {
        try await get(Asset.self, "/api/assets/\(Self.enc(id))")
    }

    public func generateAIImage(
        brandId: EntityID,
        prompt: String,
        aspectRatio: String = "4:5",
        imageSize: String = "2K",
        referenceAssetIds: [EntityID] = [],
        preserveProductLabel: Bool = false,
        targetContentId: EntityID? = nil,
        targetSlotId: String? = nil
    ) async throws(StudioAPIError) -> Job {
        var payload: JSONObject = [
            "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
            "aspectRatio": .string(aspectRatio),
            "imageSize": .string(imageSize),
            "referenceAssetIds": .array(referenceAssetIds.map { .string($0) }),
            "preserveProductLabel": .bool(preserveProductLabel),
        ]
        if let targetContentId { payload["targetContentId"] = .string(targetContentId) }
        if let targetSlotId { payload["targetSlotId"] = .string(targetSlotId) }
        return try await createJob(JobCreate(type: .imageGenerate, payload: payload, brandId: brandId))
    }

    /// URL that streams the stored bytes.
    public func assetContentURL(_ id: EntityID) throws(StudioAPIError) -> URL {
        try url("/api/assets/\(Self.enc(id))/content")
    }

    /// Download an asset's bytes (with auth headers).
    public func assetData(_ id: EntityID) async throws(StudioAPIError) -> Data {
        var request = URLRequest(url: try assetContentURL(id))
        for (name, value) in try await authHeaders() { request.setValue(value, forHTTPHeaderField: name) }
        return try await data(for: request)
    }

    /// `POST /api/assets` (multipart). `progress` gets 0...1 while the body is sent.
    public func uploadAsset(_ file: UploadFile, brandId: EntityID, kind: AssetKind? = .image, progress: (@Sendable (Double) -> Void)? = nil) async throws(StudioAPIError) -> Asset {
        var form = MultipartForm()
        form.addField("brandId", brandId)
        if let kind, kind != .unknown { form.addField("kind", kind.rawValue) }
        form.addField("source", "upload")
        if let width = file.width { form.addField("width", String(width)) }
        if let height = file.height { form.addField("height", String(height)) }
        form.addFile("file", filename: file.filename, mimeType: file.mimeType, data: file.data)
        let body = form.finalize()

        var request = try await makeRequest(.post, "/api/assets")
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        let delegate = progress.map { UploadProgressDelegate(onProgress: $0) }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.upload(for: request, from: body, delegate: delegate)
        } catch {
            throw StudioAPIError.from(error)
        }
        try Self.check(response, data)
        progress?(1)
        return try decode(Asset.self, from: data)
    }
}
