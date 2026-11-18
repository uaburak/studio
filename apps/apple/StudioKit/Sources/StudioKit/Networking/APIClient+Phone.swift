import Foundation

// Thumbnails, the trash, job retry and the paid-AI endpoints the phone uses (Faz 6).

extension APIClient {
    // MARK: Thumbnails

    /// `GET /api/assets/{id}/thumbnail?w=` (WebP; `w` rounded up to `AssetThumbnail.widths`).
    public func assetThumbnailURL(_ id: EntityID, width: Int) throws(StudioAPIError) -> URL {
        try url("/api/assets/\(Self.enc(id))/thumbnail", query: ["w": String(AssetThumbnail.width(for: Double(width)))])
    }

    /// A resized copy of an image. Falls back to the original bytes when the file cannot be
    /// resized (415) or the Mac's API is older and has no thumbnails (404 on the route).
    public func assetThumbnailData(_ id: EntityID, width: Int) async throws(StudioAPIError) -> Data {
        var request = URLRequest(url: try assetThumbnailURL(id, width: width))
        for (name, value) in try await authHeaders() { request.setValue(value, forHTTPHeaderField: name) }
        do {
            return try await data(for: request)
        } catch {
            if Self.shouldFallBackToOriginal(error) { return try await assetData(id) }
            throw error
        }
    }

    static func shouldFallBackToOriginal(_ error: StudioAPIError) -> Bool {
        switch error {
        case .server(let status, _, _, _), .http(let status): status == 415 || status == 404 || status == 501
        default: false
        }
    }

    // MARK: Trash

    /// `POST /api/contents/{id}/restore`: the post comes back out of the trash.
    public func restoreContent(_ id: EntityID) async throws(StudioAPIError) -> Content {
        try await send(Content.self, .post, "/api/contents/\(Self.enc(id))/restore")
    }

    /// `POST /api/assets/{id}/restore`.
    public func restoreAsset(_ id: EntityID) async throws(StudioAPIError) -> Asset {
        try await send(Asset.self, .post, "/api/assets/\(Self.enc(id))/restore")
    }

    // MARK: Jobs

    /// `POST /api/jobs/{id}/retry`: a failed or cancelled job queued again (a plan item's
    /// generation goes through its plan on the server). Returns the new job.
    public func retryJob(_ id: EntityID) async throws(StudioAPIError) -> Job {
        try await send(Job.self, .post, "/api/jobs/\(Self.enc(id))/retry")
    }

    // MARK: Paid AI (S7)

    /// `GET /api/ai/spend` in the phone's time zone.
    public func aiSpend(timeZone: TimeZone = .current, now: Date = Date()) async throws(StudioAPIError) -> AISpendSummary {
        try await get(AISpendSummary.self, "/api/ai/spend", query: ["tzOffset": String(Self.tzOffset(timeZone, at: now))])
    }

    /// `GET /api/ai/preferences`.
    public func aiPreferences() async throws(StudioAPIError) -> AIPreferences {
        try await get(AIPreferences.self, "/api/ai/preferences")
    }

    /// `POST /api/ai/claude-limit/decision`. The API takes it from the Mac only today (403
    /// `forbidden` for a phone); callers say so in plain words.
    public func decideClaudeLimit(_ input: ClaudeLimitDecisionCreate) async throws(StudioAPIError) -> AIPreferences {
        try await send(AIPreferences.self, .post, "/api/ai/claude-limit/decision", body: input)
    }

    /// JavaScript's `Date#getTimezoneOffset()`: minutes to add to local time to get UTC (Istanbul: -180).
    public static func tzOffset(_ zone: TimeZone, at date: Date = Date()) -> Int {
        -zone.secondsFromGMT(for: date) / 60
    }
}
