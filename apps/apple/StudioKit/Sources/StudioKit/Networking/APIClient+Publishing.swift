import Foundation

/// P3: accounts (OAuth connect, health, disconnect), schedules (preflight, publish now,
/// reschedule), the publishing path (cloud publisher) and the publish log feed.
extension APIClient {
    // MARK: Accounts

    public func exchangeMeta(_ input: MetaExchangeInput) async throws(StudioAPIError) -> MetaExchangeResult {
        try await send(MetaExchangeResult.self, .post, "/api/social-accounts/meta/exchange", body: input)
    }

    public func linkedInOAuth(_ input: LinkedInOAuthInput) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .post, "/api/social-accounts/linkedin/oauth", body: input)
    }

    public func checkSocialAccount(id: EntityID, _ input: SocialAccountCheckInput) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .post, "/api/social-accounts/\(Self.enc(id))/check", body: input)
    }

    public func disconnectSocialAccount(id: EntityID) async throws(StudioAPIError) -> SocialAccount {
        try await send(SocialAccount.self, .post, "/api/social-accounts/\(Self.enc(id))/disconnect")
    }

    // MARK: Schedules

    public func preflight(_ input: SchedulePreflightInput) async throws(StudioAPIError) -> SchedulePreflight {
        try await send(SchedulePreflight.self, .post, "/api/schedules/preflight", body: input)
    }

    public func publishNow(_ input: PublishNowInput) async throws(StudioAPIError) -> PublishNowResult {
        try await send(PublishNowResult.self, .post, "/api/schedules/publish-now", body: input)
    }

    public func reschedule(_ id: EntityID, to date: Date) async throws(StudioAPIError) -> Schedule {
        try await send(Schedule.self, .patch, "/api/schedules/\(Self.enc(id))", body: ScheduleUpdate(scheduledAt: date))
    }

    // MARK: Publishing path

    public func publishingStatus() async throws(StudioAPIError) -> PublishingStatus {
        try await get(PublishingStatus.self, "/api/publishing/status")
    }

    public func setCloudPublisher(_ input: PublishingCloudPut) async throws(StudioAPIError) -> PublishingStatus {
        try await send(PublishingStatus.self, .put, "/api/publishing/cloud", body: input)
    }

    public func clearCloudPublisher() async throws(StudioAPIError) -> PublishingStatus {
        try await send(PublishingStatus.self, .delete, "/api/publishing/cloud")
    }

    public func requestPublishingSync() async throws(StudioAPIError) -> PublishingStatus {
        try await send(PublishingStatus.self, .post, "/api/publishing/sync")
    }

    /// Newest first; with `finishedAfter` only finished attempts after it, oldest first.
    public func publishLogs(brandId: EntityID? = nil, finishedAfter: Date? = nil, limit: Int = 50) async throws(StudioAPIError) -> [PublishLogFeedItem] {
        try await get(PublishLogFeed.self, "/api/publish-logs", query: [
            "brandId": brandId,
            "finishedAfter": finishedAfter.map { Timestamp.format($0) },
            "limit": String(limit),
        ]).items
    }
}
