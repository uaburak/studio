import AppKit
import Foundation
import Observation
import StudioKit

/// App-wide publishing state (P3): the publishing path (cloud publisher or this Mac),
/// the publish log feed and the notifications it produces.
///
/// - On launch, every 30 s and whenever the app becomes active it reads the status and the
///   publish attempts finished since the last look; on focus it also asks the worker to
///   push/pull cloud orders right away (`POST /api/publishing/sync`).
/// - Finished attempts become "Yayınlandı / Yayınlanamadı" notices, long jobs that finish
///   become "… bitti / başarısız" notices, accounts about to expire become reminders.
@MainActor
@Observable
final class PublishingModel {
    weak var app: AppModel?
    /// Injected in tests; otherwise the app's data service.
    var apiOverride: (any PublishingAPI)?
    private(set) var notifier: StudioNotifier

    private(set) var status: PublishingStatus = .unknownLocal
    private(set) var statusError: String?
    /// Newest first (log screen).
    private(set) var recentLogs: [PublishLogFeedItem] = []
    private(set) var lastPolledAt: Date?

    private let defaults: UserDefaults
    private var timer: Timer?
    private var focusObserver: NSObjectProtocol?
    private var jobStatuses: [EntityID: JobStatus] = [:]
    private var lastTokenCheckDay: Int?
    static let feedCursorKey = "studio.publishing.feedCursor"

    init(defaults: UserDefaults = .standard, notifier: StudioNotifier? = nil) {
        self.defaults = defaults
        self.notifier = notifier ?? StudioNotifier(defaults: defaults)
    }

    var api: any PublishingAPI {
        if let apiOverride { return apiOverride }
        let app = self.app
        return DataServicePublishingAPI { app?.dataService ?? SampleBackend() }
    }

    var mode: PublishingMode { status.mode == .cloud ? .cloud : .local }

    /// "Mac açık olmalı" when this Mac publishes.
    var modeSummary: String {
        mode == .cloud
            ? "Bulut yayıncı açık: onaylanan zamanlamalar buluta gönderilir, Mac kapalıyken de paylaşılır."
            : "Yayını bu Mac yapar: zamanlanan saatte Mac açık ve Studio çalışıyor olmalı."
    }

    /// Tests: record notices instead of posting them to macOS.
    func notifierForTests(poster: NoticePoster, defaults: UserDefaults) {
        notifier = StudioNotifier(defaults: defaults, poster: poster)
    }

    // MARK: Lifecycle

    func start() {
        guard timer == nil, app?.isSample != true else { return }
        let timer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        focusObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.appBecameActive() }
        }
        Task { await poll() }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let focusObserver { NotificationCenter.default.removeObserver(focusObserver) }
        focusObserver = nil
    }

    func appBecameActive() async {
        if let synced = try? await api.requestPublishingSync() { status = synced }
        await poll()
        // Give the worker a moment to pull cloud status, then look again.
        try? await Task.sleep(for: .seconds(6))
        await pollFeed()
        await app?.calendar.reloadIfVisible()
    }

    func poll() async {
        await refreshStatus()
        await pollFeed()
        await checkTokens()
    }

    func refreshStatus() async {
        do {
            status = try await api.publishingStatus()
            statusError = nil
        } catch {
            statusError = AppModel.describe(error)
        }
    }

    // MARK: Feed → notices

    var feedCursor: Date? {
        get { defaults.object(forKey: Self.feedCursorKey) as? Date }
        set { defaults.set(newValue, forKey: Self.feedCursorKey) }
    }

    /// Finished attempts since the last look → notices. Returns the notices emitted.
    @discardableResult
    func pollFeed(now: Date = Date()) async -> [StudioNotice] {
        let cursor = feedCursor ?? now.addingTimeInterval(-15 * 60)
        guard let items = try? await api.publishLogs(brandId: nil, finishedAfter: cursor) else { return [] }
        lastPolledAt = now
        if let last = items.compactMap(\.log.finishedAt).max() { feedCursor = last } else if feedCursor == nil { feedCursor = cursor }
        guard !items.isEmpty else { return [] }
        let emitted = await notifier.post(NoticePlanner.notices(for: items))
        await refreshLogs()
        await app?.calendar.reloadIfVisible()
        return emitted
    }

    func refreshLogs(brandId: EntityID? = nil) async {
        if let logs = try? await api.publishLogs(brandId: brandId, finishedAfter: nil) { recentLogs = logs }
    }

    /// Job feed hook: notices for long jobs that just finished.
    func jobChanged(_ job: Job) {
        let previous = jobStatuses[job.id]
        jobStatuses[job.id] = job.status
        guard previous != nil || !job.status.isTerminal else { return } // ignore history from the snapshot
        if let notice = NoticePlanner.notice(for: job, previous: previous) {
            Task { await notifier.post([notice]) }
        }
    }

    /// Once a day: accounts about to expire or invalid.
    func checkTokens(now: Date = Date()) async {
        let day = Int(now.timeIntervalSince1970 / 86_400)
        guard lastTokenCheckDay != day, let app else { return }
        lastTokenCheckDay = day
        await notifier.post(NoticePlanner.tokenNotices(accounts: app.accounts, now: now))
    }

    // MARK: Cloud publisher settings

    func saveCloud(url: String, token: String, secrets: any SecretStore) async throws {
        status = try await api.setCloudPublisher(url: url, token: token)
        try? secrets.save(token, name: PublishingSecret.cloudPublisherToken)
    }

    func clearCloud(secrets: any SecretStore) async throws {
        status = try await api.clearCloudPublisher()
        try? secrets.delete(PublishingSecret.cloudPublisherToken)
    }
}
