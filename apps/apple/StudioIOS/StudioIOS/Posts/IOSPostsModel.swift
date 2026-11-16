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
        if job.status.isTerminal {
            Task {
                await load()
                if let contentId = job.contentId, let session = sessions[contentId]?.session { await session.reloadContent() }
            }
        } else {
            rebuild(contents: board.cards.map(\.content))
        }
    }

    /// A post screen changed its card (edit, approve, caption, schedule).
    func cardChanged(_ card: PostCard) {
        if let version = card.version { versions[card.id] = version }
        var contents = board.cards.map(\.content)
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
        sessions[card.id] = WeakSession(session: session)
        return session
    }

    // MARK: Actions

    func approveReady() async {
        guard let app, !isApproving else { return }
        isApproving = true
        defer { isApproving = false }
        var failures: [String] = []
        var contents = board.cards.map(\.content)
        for card in approvable {
            guard let hash = card.approvableHash else { continue }
            do {
                let updated = try await app.dataService.approve(contentId: card.content.id, hash: hash)
                if let index = contents.firstIndex(where: { $0.id == updated.id }) { contents[index] = updated }
            } catch {
                failures.append("\(card.title): \(IOSAppModel.describe(error))")
            }
        }
        rebuild(contents: contents)
        error = failures.isEmpty ? nil : failures.joined(separator: "\n")
    }

    func approve(_ card: PostCard) async -> Bool {
        guard let app, let hash = card.approvableHash else { return false }
        do {
            let updated = try await app.dataService.approve(contentId: card.id, hash: hash)
            var contents = board.cards.map(\.content)
            if let index = contents.firstIndex(where: { $0.id == updated.id }) { contents[index] = updated }
            rebuild(contents: contents)
            return true
        } catch {
            self.error = "\(card.title): \(IOSAppModel.describe(error))"
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
