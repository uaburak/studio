import Foundation
import Observation
import StudioKit
import UIKit

/// The posts screen: one brand's month of posts (same board and filters as the Mac).
@MainActor
@Observable
final class IOSPostsModel {
    weak var app: IOSAppModel?
    var month = MonthKey(Date())
    var filter: PostListFilter = .all
    private(set) var board = PostBoard(cards: [])
    private(set) var loadedBrandId: EntityID?
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var isApproving = false
    /// Slot uploads started from the grid, by content id (0...1).
    private(set) var slotUploads: [EntityID: Double] = [:]
    var error: String?
    @ObservationIgnored private var versions: [EntityID: ContentVersion] = [:]
    @ObservationIgnored private var jobs: [Job] = []
    @ObservationIgnored private var plans: [Plan] = []
    @ObservationIgnored private var schedules: [Schedule] = []
    @ObservationIgnored private var loadGeneration = 0
    /// Open post screens, so board changes reach them.
    @ObservationIgnored private var sessions: [EntityID: WeakSession] = [:]

    private struct WeakSession { weak var session: PostEditSession? }

    var brandId: EntityID? { app?.currentBrandId }

    func reset() {
        board = PostBoard(cards: [])
        versions = [:]
        jobs = []
        plans = []
        schedules = []
        loadedBrandId = nil
        hasLoaded = false
        error = nil
    }

    func load() async {
        guard let app, let brandId else { return }
        loadGeneration += 1
        let generation = loadGeneration
        if loadedBrandId != brandId { hasLoaded = false }
        isLoading = true
        defer { if generation == loadGeneration { isLoading = false } }
        let service = app.dataService
        do {
            async let contents = service.contents(brandId: brandId)
            async let plans = service.plans(brandId: brandId)
            async let schedules = service.schedules(brandId: brandId)
            async let jobs = service.jobs(brandId: brandId)
            let loaded = try await contents
            let loadedPlans = (try? await plans) ?? []
            let loadedSchedules = (try? await schedules) ?? []
            let loadedJobs = (try? await jobs) ?? []
            guard generation == loadGeneration, brandId == self.brandId else { return }
            self.plans = loadedPlans
            self.schedules = loadedSchedules
            self.jobs = loadedJobs
            await loadVersions(for: loaded)
            guard generation == loadGeneration else { return }
            rebuild(contents: loaded)
            if loadedBrandId != brandId {
                loadedBrandId = brandId
                let months = board.months()
                if !months.contains(month), let nearest = months.min(by: { abs($0.distance(to: month)) < abs($1.distance(to: month)) }) {
                    month = nearest
                }
            }
            error = nil
        } catch {
            guard generation == loadGeneration else { return }
            self.error = IOSAppModel.describe(error)
        }
        hasLoaded = true
    }

    private func loadVersions(for contents: [Content]) async {
        guard let service = app?.dataService else { return }
        let needed = contents.compactMap { content -> (EntityID, Int)? in
            guard let ref = content.currentVersion else { return nil }
            if let cached = versions[content.id], cached.id == ref.id, cached.slides.allSatisfy({ $0.renderedAssetId != nil }) { return nil }
            return (content.id, ref.version)
        }
        await withTaskGroup(of: ContentVersion?.self) { group in
            for (contentId, version) in needed {
                group.addTask { try? await service.version(contentId: contentId, version: version) }
            }
            for await version in group {
                if let version { versions[version.contentId] = version }
            }
        }
    }

    private func rebuild(contents: [Content]) {
        board = PostBoard(contents: contents, versions: versions, plans: plans, schedules: schedules, jobs: jobs)
        for card in board.cards {
            sessions[card.id]?.session?.replaceCard(card)
        }
        sessions = sessions.filter { $0.value.session != nil }
    }

    // MARK: Derived

    var monthCards: [PostCard] { board.cards(in: month) }
    var visibleCards: [PostCard] { monthCards.filter { filter.matches($0.state) } }
    var counts: [PostListFilter: Int] { PostBoard.listCounts(monthCards) }
    var approvable: [PostCard] { PostBoard.approvable(monthCards) }
    var months: [MonthKey] { board.months() }

    /// Posts of this month that wait on the user (approve or add an image): the tab badge.
    var attentionCount: Int {
        monthCards.filter { $0.state == .ready || $0.state == .imageNeeded }.count
    }

    func card(_ id: EntityID) -> PostCard? { board.cards.first { $0.id == id } }

    /// The running render / generation of a post (the card's badge).
    func activeJob(for contentId: EntityID) -> Job? {
        jobs.filter { $0.contentId == contentId && $0.status.isActive && ($0.type == .contentRender || $0.type == .contentGenerate) }
            .max { $0.createdAt < $1.createdAt }
    }

    // MARK: Updates

    func jobChanged(_ job: Job) {
        guard job.brandId == loadedBrandId || job.contentId.map({ card($0) != nil }) == true else { return }
        if let index = jobs.firstIndex(where: { $0.id == job.id }) { jobs[index] = job } else { jobs.append(job) }
        if let contentId = job.contentId { sessions[contentId]?.session?.noteJob(job) }
        rebuild(contents: board.cards.map(\.content))
        // M6: a finished job refreshes only the post it touched (debounced); a chat answer or a
        // brand job refreshes nothing here (the posts screen reloads when it appears).
        if job.status.isTerminal, let contentId = PostRefreshPlanner.affectedContent(of: job) {
            scheduleRefresh(contentId, schedules: job.type == .schedulePublish)
        }
    }

    /// Posts waiting for a refresh, gathered for `refreshDelay` so a burst of jobs costs one round.
    @ObservationIgnored private var pendingRefresh: Set<EntityID> = []
    @ObservationIgnored private var pendingSchedules = false
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored var refreshDelay: Duration = .milliseconds(700)

    private func scheduleRefresh(_ contentId: EntityID, schedules: Bool) {
        pendingRefresh.insert(contentId)
        pendingSchedules = pendingSchedules || schedules
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.refreshDelay)
            let ids = self.pendingRefresh
            let withSchedules = self.pendingSchedules
            self.pendingRefresh = []
            self.pendingSchedules = false
            self.refreshTask = nil
            await self.refresh(contentIds: ids, schedules: withSchedules)
        }
    }

    /// Reload one post (content, its current version) and the open post screen.
    func refresh(contentId: EntityID) async {
        await refresh(contentIds: [contentId], schedules: false)
    }

    private func refresh(contentIds: Set<EntityID>, schedules withSchedules: Bool) async {
        guard let app, let brandId = loadedBrandId, !contentIds.isEmpty else { return }
        let service = app.dataService
        var fresh: [EntityID: Content] = [:]
        var gone: Set<EntityID> = []
        await withTaskGroup(of: (EntityID, Content?, Bool).self) { group in
            for id in contentIds {
                group.addTask {
                    do { return (id, try await service.content(id), false) } catch {
                        let missing = (error as? StudioAPIError)?.code == .notFound
                        return (id, nil, missing)
                    }
                }
            }
            for await (id, content, missing) in group {
                if let content { fresh[id] = content } else if missing { gone.insert(id) }
            }
        }
        if withSchedules, let loaded = try? await service.schedules(brandId: brandId) { schedules = loaded }
        guard brandId == loadedBrandId else { return }
        await loadVersions(for: Array(fresh.values))
        var contents = board.cards.map(\.content).filter { !gone.contains($0.id) }
        for content in fresh.values {
            contents.removeAll { $0.id == content.id }
            if content.deletedAt == nil, content.brandId == brandId { contents.append(content) }
        }
        rebuild(contents: contents)
        for id in fresh.keys {
            if let session = sessions[id]?.session { await session.reloadContent() }
        }
    }

    /// A post screen changed its card (edit, approve, caption, schedule).
    func cardChanged(_ card: PostCard) {
        if let version = card.version { versions[card.id] = version }
        var contents = board.cards.map(\.content)
        // Moved to the trash elsewhere (the Mac): it leaves the board.
        if card.content.deletedAt != nil {
            rebuild(contents: contents.filter { $0.id != card.id })
            return
        }
        if let index = contents.firstIndex(where: { $0.id == card.id }) { contents[index] = card.content } else if card.content.brandId == loadedBrandId { contents.append(card.content) }
        rebuild(contents: contents)
    }

    func schedulesCreated(_ created: [Schedule]) {
        schedules += created
        rebuild(contents: board.cards.map(\.content))
    }

    /// The editing session for a post screen, wired to the board and the image cache.
    func session(for card: PostCard) -> PostEditSession {
        let session = PostEditSession(service: app!.dataService, card: card)
        session.onCardChange = { [weak self] card in self?.cardChanged(card) }
        session.onSchedulesCreated = { [weak self] created in
            self?.schedulesCreated(created)
            Task { await self?.app?.calendar.load() }
        }
        session.onAssetUploaded = { [weak self] asset, file in
            if let image = UIImage(data: file.data) { self?.app?.images.seed(IOSImageImport.thumbnail(image, side: 600), for: asset.id) }
        }
        session.workerOnline = { [weak self] in self?.app?.isOnline ?? false || self?.app?.isSample == true }
        // A canvas post's AI request goes to the post's conversation, as on the Mac (S1).
        session.chat = app?.conversationService
        // Checks (or the generation that stores them) may already be running.
        for job in jobs where job.contentId == card.id && job.status.isActive { session.noteJob(job) }
        sessions[card.id] = WeakSession(session: session)
        return session
    }

    // MARK: Actions

    /// What the checks say about approving each card (problems, running, never checked).
    func approvalGates(_ cards: [PostCard]) async -> [EntityID: ContentChecks.ApprovalGate] {
        guard let app else { return [:] }
        let service = app.dataService
        let running = Set(jobs.filter { $0.status.isActive && $0.type == .contentCheck }.compactMap(\.contentId))
        var gates: [EntityID: ContentChecks.ApprovalGate] = [:]
        await withTaskGroup(of: (EntityID, ContentChecks.ApprovalGate).self) { group in
            for card in cards {
                guard let version = card.content.currentVersion?.version else { continue }
                let id = card.id
                let isRunning = running.contains(id)
                group.addTask {
                    do {
                        let run = try await service.latestCheckRun(contentId: id, version: version)
                        return (id, ContentChecks.gate(run: run, version: version, running: isRunning))
                    } catch {
                        return (id, .unavailable((error as? StudioAPIError)?.errorDescription ?? error.localizedDescription))
                    }
                }
            }
            for await (id, gate) in group { gates[id] = gate }
        }
        return gates
    }

    /// Approve every ready post of the month (`only`: just these ids). `acknowledged`: posts the
    /// user chose to approve although their checks hold them back (E7; told to the API).
    func approveReady(only: Set<EntityID>? = nil, acknowledged: Set<EntityID> = []) async {
        guard let app, !isApproving else { return }
        isApproving = true
        defer { isApproving = false }
        var failures: [String] = []
        var contents = board.cards.map(\.content)
        for card in approvable where only?.contains(card.id) ?? true {
            guard let hash = card.approvableHash else { continue }
            do {
                let updated = try await app.dataService.approve(
                    contentId: card.content.id, hash: hash, acknowledgeChecks: acknowledged.contains(card.id))
                if let index = contents.firstIndex(where: { $0.id == updated.id }) { contents[index] = updated }
            } catch {
                failures.append("\(card.title): \(ContentChecks.approvalRefusal(error) ?? IOSAppModel.describe(error))")
            }
        }
        rebuild(contents: contents)
        error = failures.isEmpty ? nil : failures.joined(separator: "\n")
    }

    /// `acknowledgingChecks`: the user confirmed approving although its checks hold it back (E7).
    func approve(_ card: PostCard, acknowledgingChecks: Bool = false) async -> Bool {
        guard let app, let hash = card.approvableHash else { return false }
        do {
            let updated = try await app.dataService.approve(contentId: card.id, hash: hash, acknowledgeChecks: acknowledgingChecks)
            var contents = board.cards.map(\.content)
            if let index = contents.firstIndex(where: { $0.id == updated.id }) { contents[index] = updated }
            rebuild(contents: contents)
            return true
        } catch {
            self.error = "\(card.title): \(ContentChecks.approvalRefusal(error) ?? IOSAppModel.describe(error))"
            return false
        }
    }

    /// The slot a picture goes into: the first empty one, else the first slot.
    static func targetSlot(_ slots: [ImageSlot]) -> ImageSlot? {
        slots.first { $0.isEmpty && $0.layerId != nil } ?? slots.first { $0.layerId != nil }
    }

    /// Fill a card's slot from the grid (Photos / camera on the card's menu).
    func fillSlot(of card: PostCard, with image: UIImage) {
        guard let app else { return }
        guard !card.isCanvasVersion else {
            error = "\(card.title): \(CanvasOrigin.editNote)"
            return
        }
        guard let ref = card.content.currentVersion else {
            error = "\(card.title): bu postun henüz bir tasarımı yok."
            return
        }
        guard let slot = Self.targetSlot(card.slots), let layerId = slot.layerId else {
            error = "\(card.title): bu tasarımda görsel yuvası yok."
            return
        }
        let imported: IOSImageImport.Imported
        do { imported = try IOSImageImport.from(image: image, filename: "yuva.jpg") } catch {
            self.error = IOSAppModel.describe(error)
            return
        }
        let id = card.id
        slotUploads[id] = 0
        Task {
            do {
                let asset = try await app.dataService.uploadImage(imported.file, brandId: card.content.brandId) { progress in
                    Task { @MainActor in if self.slotUploads[id] != nil { self.slotUploads[id] = progress } }
                }
                app.images.seed(imported.thumbnail, for: asset.id)
                let src = DesignPatch.mediaSource(assetId: asset.id, mimeType: asset.mimeType)
                let job = try await app.dataService.render(contentId: id, ContentRenderRequest(
                    version: ref.version, patches: [DesignPatch(slide: slot.slideIndex, .fillSlot(layer: layerId, src: src))]))
                slotUploads[id] = 1
                _ = try await app.dataService.waitForJob(job.id, timeout: .seconds(180))
                slotUploads[id] = nil
                await load()
                Haptics.success()
            } catch {
                slotUploads[id] = nil
                self.error = "\(card.title): \(IOSAppModel.describe(error))"
            }
        }
    }

    static let deleteMessage = "Post Silinenler'e taşınır; 30 gün içinde geri alınabilir."

    /// "Silindi · Geri al" after a delete.
    static func showUndo(for card: PostCard, model: IOSPostsModel, in view: UIView?) {
        Toast.show("“\(card.title)” silindi", in: view, action: "Geri al") { [weak model] in
            guard let model else { return }
            Task {
                if await model.restore(card.id) {
                    Haptics.success()
                    Toast.show("Post geri alındı", in: view)
                } else if let error = model.error {
                    Toast.show(error, in: view, isError: true)
                }
            }
        }
    }

    static func deletionBlocker(_ card: PostCard) -> String? {
        switch card.content.status {
        case .scheduled: "Zamanlanmış post silinemez; önce Takvim'den zamanlamayı iptal et."
        case .publishing: "Yayınlanmakta olan post silinemez."
        case .published: "Yayınlanmış post silinemez."
        default: nil
        }
    }

    func delete(_ card: PostCard) async -> Bool {
        guard let app else { return false }
        if let blocker = Self.deletionBlocker(card) {
            error = blocker
            return false
        }
        do {
            try await app.dataService.deleteContent(card.id)
            versions[card.id] = nil
            rebuild(contents: board.cards.map(\.content).filter { $0.id != card.id })
            error = nil
            return true
        } catch {
            self.error = "\(card.title): \(IOSAppModel.describe(error))"
            return false
        }
    }

    /// "Geri al" after a delete: the post comes back out of the trash.
    func restore(_ contentId: EntityID) async -> Bool {
        guard let app else { return false }
        do {
            let content = try await app.dataService.restoreContent(contentId)
            var contents = board.cards.map(\.content).filter { $0.id != content.id }
            if content.brandId == loadedBrandId { contents.append(content) }
            rebuild(contents: contents)
            await refresh(contentId: contentId)
            error = nil
            return true
        } catch {
            self.error = IOSAppModel.describe(error)
            return false
        }
    }

    /// "Yeniden dene" on a post that could not be generated: the failed job is queued again.
    func retryGeneration(_ card: PostCard) async -> Bool {
        guard let app, let failure = card.generationFailure else { return false }
        do {
            let job = try await app.dataService.retryJob(failure.jobId)
            jobs.removeAll { $0.id == job.id }
            jobs.append(job)
            rebuild(contents: board.cards.map(\.content))
            error = nil
            return true
        } catch {
            self.error = "\(card.title): \(IOSAppModel.describe(error))"
            return false
        }
    }

    @discardableResult
    func duplicate(_ card: PostCard) async -> PostCard? {
        guard let app else { return nil }
        do {
            let copy = try await app.dataService.duplicateContent(card.id)
            if let ref = copy.currentVersion, let version = try? await app.dataService.version(contentId: copy.id, version: ref.version) {
                versions[copy.id] = version
            }
            await load()
            error = nil
            return self.card(copy.id)
        } catch {
            self.error = "\(card.title): \(IOSAppModel.describe(error))"
            return nil
        }
    }
}

extension MonthKey {
    func distance(to other: MonthKey) -> Int { (other.year - year) * 12 + (other.month - month) }
}
