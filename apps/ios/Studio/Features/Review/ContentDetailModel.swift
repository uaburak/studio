import Observation
import Foundation

/// State for one content item: versions, the shown version, schedules, and
/// the approval flow.
///
/// Approval (README: "Onay hash'e bağlıdır"):
///
///     idle ──approve──► verifying ──► confirming(version, hash) ──confirm──► approving ──► idle
///                           │                                                      └──► failed(error)
///                           └──► outdated  (a newer version arrived, or the slides the
///                                          user saw do not hash to the server's hash)
///
/// The hash sent is recomputed on the phone from the slides being shown, so
/// the approval provably refers to what the user looked at.
@MainActor
@Observable
final class ContentDetailModel {
    enum Approval: Equatable {
        case idle
        case verifying
        case confirming(version: Int, hash: String)
        case approving
        case outdated(String)
        case failed(APIError)
    }

    let contentId: String
    var content = Loadable<Content>()
    var versions = Loadable<[ContentVersionSummary]>()
    /// Detail (with slides) of the version on screen.
    var shown = Loadable<ContentVersion>()
    var schedules = Loadable<[Schedule]>()
    private(set) var accounts: [SocialAccount] = []
    private(set) var approval: Approval = .idle
    /// Error of the last action (caption, transition, schedule cancel).
    var actionError: APIError?
    private(set) var isWorking = false

    init(contentId: String) {
        self.contentId = contentId
    }

    var isShowingCurrentVersion: Bool {
        guard let current = content.value?.currentVersion, let shown = shown.value else { return false }
        return current.id == shown.id
    }

    var canApprove: Bool {
        guard let content = content.value else { return false }
        return content.status.isApprovable && content.currentVersion != nil && isShowingCurrentVersion
    }

    /// Accounts this content can be scheduled to (brand accounts on its target platforms).
    var schedulableAccounts: [SocialAccount] {
        let targets = Set(content.value?.targetPlatforms ?? [])
        return accounts.filter { targets.contains($0.platform) && $0.status != .disabled }
    }

    var activeSchedules: [Schedule] { (schedules.value ?? []).filter { $0.status.isActive } }

    // MARK: Loading

    func load(api: APIClient) async {
        content.begin()
        do {
            let loaded = try await api.content(id: contentId)
            content.succeed(loaded)
            async let versionsTask: Void = loadVersions(api: api)
            async let schedulesTask: Void = loadSchedules(api: api)
            async let accountsTask = try? api.socialAccounts(brandId: loaded.brandId)
            _ = await (versionsTask, schedulesTask)
            accounts = await accountsTask?.items ?? accounts
            if let current = loaded.currentVersion,
               shown.value == nil || shown.value?.version == versions.value?.dropFirst().first?.version {
                await show(version: current.version, api: api)
            } else if let number = shown.value?.version {
                await show(version: number, api: api)
            }
        } catch {
            content.fail(error)
        }
    }

    func loadVersions(api: APIClient) async {
        versions.begin()
        do { versions.succeed(try await api.versions(contentId: contentId).items) } catch { versions.fail(error) }
    }

    func loadSchedules(api: APIClient) async {
        schedules.begin()
        do {
            schedules.succeed(try await api.schedules(brandId: nil, contentId: contentId).items)
        } catch {
            schedules.fail(error)
        }
    }

    func show(version number: Int, api: APIClient) async {
        if shown.value?.version != number { shown = Loadable() }
        shown.begin()
        do { shown.succeed(try await api.version(contentId: contentId, number: number)) } catch { shown.fail(error) }
        if approval != .approving { approval = .idle }
    }

    // MARK: Approval

    func beginApproval(api: APIClient) async {
        guard let viewed = shown.value else { return }
        approval = .verifying
        do {
            // Re-read the content: has a newer version arrived while the user was looking?
            let fresh = try await api.content(id: contentId)
            content.succeed(fresh)
            guard let current = fresh.currentVersion, current.id == viewed.id else {
                approval = .outdated("Siz bakarken yeni bir sürüm geldi. Yeni sürümü inceleyip onaylayın.")
                await loadVersions(api: api)
                if let current = fresh.currentVersion { await show(version: current.version, api: api) }
                return
            }
            guard fresh.status.isApprovable else {
                approval = .outdated("Bu içerik şu an onaylanamaz (durum: \(fresh.status.label)).")
                return
            }
            let local = ContentHash.compute(viewed.slides)
            guard local == viewed.contentHash, local == current.contentHash else {
                approval = .outdated("Gösterilen slaytlar sunucudaki sürümle eşleşmiyor. Sayfayı yenileyin.")
                return
            }
            approval = .confirming(version: viewed.version, hash: local)
        } catch {
            approval = .failed(error)
        }
    }

    func confirmApproval(api: APIClient) async {
        guard case .confirming(_, let hash) = approval else { return }
        approval = .approving
        do {
            content.succeed(try await api.approveContent(id: contentId, hash: hash))
            approval = .idle
        } catch {
            if error.code == .hashMismatch {
                approval = .outdated(error.localizedDescription)
                await load(api: api)
            } else {
                approval = .failed(error)
            }
        }
    }

    func dismissApproval() {
        approval = .idle
    }

    // MARK: Other actions

    func transition(to target: ContentTransition.Target, api: APIClient) async {
        await perform { [contentId] in
            self.content.succeed(try await api.transitionContent(id: contentId, to: target))
        }
    }

    /// Returns true when saved.
    func saveCaption(_ caption: String, api: APIClient) async -> Bool {
        var saved = false
        await perform { [contentId] in
            self.content.succeed(try await api.updateContent(id: contentId, ContentUpdate(caption: caption)))
            saved = true
        }
        if saved { await loadSchedules(api: api) }
        return saved
    }

    func cancelSchedule(_ schedule: Schedule, api: APIClient) async {
        await perform {
            _ = try await api.cancelSchedule(id: schedule.id)
        }
        await loadSchedules(api: api)
        if let fresh = try? await api.content(id: contentId) { content.succeed(fresh) }
    }

    /// Creates one schedule per account. Returns the errors, by account handle.
    func schedule(at date: Date, accounts selected: [SocialAccount], api: APIClient) async -> [String: APIError] {
        isWorking = true
        defer { isWorking = false }
        var failures: [String: APIError] = [:]
        for account in selected {
            do {
                _ = try await api.createSchedule(ScheduleCreate(
                    contentId: contentId, socialAccountId: account.id, platform: account.platform, scheduledAt: date))
            } catch {
                failures[account.handle] = error
            }
        }
        await loadSchedules(api: api)
        if let fresh = try? await api.content(id: contentId) { content.succeed(fresh) }
        return failures
    }

    private func perform(_ action: () async throws -> Void) async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await action()
        } catch {
            actionError = APIError.from(error)
        }
    }
}
