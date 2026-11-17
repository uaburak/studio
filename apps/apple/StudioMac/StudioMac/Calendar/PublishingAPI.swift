import Foundation
import StudioKit

/// The P3 calls the publishing screens make (accounts, schedules, cloud publisher, logs).
/// Production forwards to the app's `StudioDataService`; tests inject a fake.
@MainActor
protocol PublishingAPI: AnyObject {
    func publishingStatus() async throws -> PublishingStatus
    func setCloudPublisher(url: String, token: String) async throws -> PublishingStatus
    func clearCloudPublisher() async throws -> PublishingStatus
    func requestPublishingSync() async throws -> PublishingStatus
    /// Platform rules for a publish at `scheduledAt` (nil = now; per-day limits count around it).
    func preflight(contentId: EntityID, accountIds: [EntityID]?, scheduledAt: Date?) async throws -> SchedulePreflight
    func createSchedule(_ input: ScheduleCreate) async throws -> Schedule
    func publishNow(contentId: EntityID, accountIds: [EntityID]) async throws -> PublishNowResult
    func reschedule(_ scheduleId: EntityID, to date: Date) async throws -> Schedule
    func cancelSchedule(_ id: EntityID) async throws -> Schedule
    func schedules(brandId: EntityID) async throws -> [Schedule]
    func publishLogs(brandId: EntityID?, finishedAfter: Date?) async throws -> [PublishLogFeedItem]
    func approve(contentId: EntityID, hash: String) async throws -> Content
    func exchangeMeta(_ input: MetaExchangeInput) async throws -> MetaExchangeResult
    func discoverMeta(_ input: MetaDiscoverInput) async throws -> MetaDiscoverResult
    func linkedInOAuth(_ input: LinkedInOAuthInput) async throws -> SocialAccount
    func checkAccount(id: EntityID, _ input: SocialAccountCheckInput) async throws -> SocialAccount
    func disconnectAccount(id: EntityID) async throws -> SocialAccount
    func socialAccounts() async throws -> [SocialAccount]
}

/// Forwards to whatever data service the app currently uses (it changes on reconnect).
@MainActor
final class DataServicePublishingAPI: PublishingAPI {
    private let service: () -> any StudioDataService

    init(service: @escaping () -> any StudioDataService) {
        self.service = service
    }

    func publishingStatus() async throws -> PublishingStatus { try await service().publishingStatus() }
    func setCloudPublisher(url: String, token: String) async throws -> PublishingStatus { try await service().setCloudPublisher(url: url, token: token) }
    func clearCloudPublisher() async throws -> PublishingStatus { try await service().clearCloudPublisher() }
    func requestPublishingSync() async throws -> PublishingStatus { try await service().requestPublishingSync() }
    func preflight(contentId: EntityID, accountIds: [EntityID]?, scheduledAt: Date?) async throws -> SchedulePreflight {
        try await service().preflight(contentId: contentId, accountIds: accountIds, scheduledAt: scheduledAt)
    }
    func createSchedule(_ input: ScheduleCreate) async throws -> Schedule { try await service().createSchedule(input) }
    func publishNow(contentId: EntityID, accountIds: [EntityID]) async throws -> PublishNowResult {
        try await service().publishNow(contentId: contentId, accountIds: accountIds)
    }
    func reschedule(_ scheduleId: EntityID, to date: Date) async throws -> Schedule { try await service().reschedule(scheduleId, to: date) }
    func cancelSchedule(_ id: EntityID) async throws -> Schedule { try await service().cancelSchedule(id) }
    func schedules(brandId: EntityID) async throws -> [Schedule] { try await service().schedules(brandId: brandId) }
    func publishLogs(brandId: EntityID?, finishedAfter: Date?) async throws -> [PublishLogFeedItem] {
        try await service().publishLogs(brandId: brandId, finishedAfter: finishedAfter)
    }
    func approve(contentId: EntityID, hash: String) async throws -> Content { try await service().approve(contentId: contentId, hash: hash) }
    func exchangeMeta(_ input: MetaExchangeInput) async throws -> MetaExchangeResult { try await service().exchangeMeta(input) }
    func discoverMeta(_ input: MetaDiscoverInput) async throws -> MetaDiscoverResult { try await service().discoverMetaAccounts(input) }
    func linkedInOAuth(_ input: LinkedInOAuthInput) async throws -> SocialAccount { try await service().linkedInOAuth(input) }
    func checkAccount(id: EntityID, _ input: SocialAccountCheckInput) async throws -> SocialAccount {
        try await service().checkSocialAccount(id: id, input)
    }
    func disconnectAccount(id: EntityID) async throws -> SocialAccount { try await service().disconnectSocialAccount(id: id) }
    func socialAccounts() async throws -> [SocialAccount] { try await service().socialAccounts(brandId: nil) }
}
