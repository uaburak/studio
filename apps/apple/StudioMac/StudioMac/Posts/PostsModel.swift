import AppKit
import Foundation
import Observation
import StudioKit

/// The posts screen: one brand's month of posts from the contents API.
@MainActor
@Observable
final class PostsModel {
    weak var app: AppModel?
    var month = MonthKey(Date())
    var filter: PostListFilter = .all
    private(set) var board = PostBoard(cards: [])
    private(set) var loadedBrandId: EntityID?
    private(set) var isLoading = false
    /// The first load of the current brand finished (success or error).
    private(set) var hasLoaded = false
    var error: String?
    var isApproving = false
    /// Keyboard / click selection in the grid.
    var selectedId: EntityID?
    /// A post asked to be deleted; the screen shows the confirmation.
    var pendingDeletion: PostCard?
    private var versions: [EntityID: ContentVersion] = [:]
    private var jobs: [Job] = []
    private var plans: [Plan] = []
    private var schedules: [Schedule] = []
    private var loadGeneration = 0

    var brandId: EntityID? { app?.currentBrandId }

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
            let loadedPlans = try await plans
            let loadedSchedules = try await schedules
            let loadedJobs = (try? await jobs) ?? []
            // A newer load (another brand, a job event) superseded this one.
            guard generation == loadGeneration, brandId == self.brandId else { return }
            self.plans = loadedPlans
            self.schedules = loadedSchedules
            self.jobs = loadedJobs
            await loadVersions(for: loaded)
            guard generation == loadGeneration else { return }
            rebuild(contents: loaded)
            if loadedBrandId != brandId {
                loadedBrandId = brandId
                selectedId = nil
                // Show the month with the nearest posts when the current one is empty.
                let months = board.months()
                if !months.contains(month), let nearest = months.min(by: { abs($0.distance(to: month)) < abs($1.distance(to: month)) }) {
                    month = nearest
                }
            }
            if let selectedId, card(selectedId) == nil { self.selectedId = nil }
            error = nil
        } catch {
            guard generation == loadGeneration else { return }
            self.error = AppModel.describe(error)
        }
        hasLoaded = true
    }

    /// Loads and waits for the newest load to finish: a brand switch or the posts screen may
    /// start one that supersedes this one (whose result is then dropped).
    func loadLatest(timeout: Duration = .seconds(20)) async {
        await load()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while isLoading, clock.now < deadline, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(30))
        }
    }

    /// Fetch the current version of each content (cached by version id; versions are immutable
    /// except for renders, which a reload after a render job refreshes through `refreshVersion`).
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
        board = PostBoard(
            contents: contents, versions: versions, plans: plans, schedules: schedules, jobs: jobs,
            pendingImages: app?.pendingImages.all() ?? [:])
    }

    /// Replace one content after an action (approve, caption edit) without a full reload.
    func update(_ content: Content) {
        var contents = board.cards.map(\.content)
        if let index = contents.firstIndex(where: { $0.id == content.id }) {
            contents[index] = content
        } else if content.brandId == loadedBrandId {
            contents.append(content)
        } else {
            // Another brand's post (approved or edited across a brand switch) stays off this board.
            return
        }
        rebuild(contents: contents)
    }

    /// Store a freshly loaded version (after an edit or a render) for its card.
    func store(_ version: ContentVersion, content: Content? = nil) {
        versions[version.contentId] = version
        var contents = board.cards.map(\.content)
        if let content {
            if let index = contents.firstIndex(where: { $0.id == content.id }) {
                contents[index] = content
            } else if content.brandId == loadedBrandId {
                contents.append(content)
            }
        }
        rebuild(contents: contents)
    }

    func removeCard(_ id: EntityID) {
        versions[id] = nil
        rebuild(contents: board.cards.map(\.content).filter { $0.id != id })
        if selectedId == id { selectedId = nil }
    }

    /// A new schedule, or a failed one scheduled again (a retry keeps its id): replaced, not doubled.
    func scheduleCreated(_ schedule: Schedule) {
        if let index = schedules.firstIndex(where: { $0.id == schedule.id }) {
            schedules[index] = schedule
        } else {
            schedules.append(schedule)
        }
        rebuild(contents: board.cards.map(\.content))
    }

    func jobChanged(_ job: Job) {
        guard job.brandId == loadedBrandId else { return }
        if let index = jobs.firstIndex(where: { $0.id == job.id }) { jobs[index] = job } else { jobs.append(job) }
        if job.status.isTerminal {
            Task { await load() }
        } else {
            rebuild(contents: board.cards.map(\.content))
        }
    }

    // MARK: Derived

    var monthCards: [PostCard] { board.cards(in: month) }
    var visibleCards: [PostCard] { monthCards.filter { filter.matches($0.state) } }
    var counts: [PostListFilter: Int] { PostBoard.listCounts(monthCards) }
    var approvable: [PostCard] { PostBoard.approvable(monthCards) }
    var months: [MonthKey] { board.months() }

    func card(_ id: EntityID) -> PostCard? { board.cards.first { $0.id == id } }

    var selectedCard: PostCard? { selectedId.flatMap { id in visibleCards.first { $0.id == id } } }

    /// The running render / generation of a post, for the card's "render ediliyor" badge.
    func activeJob(for contentId: EntityID) -> Job? {
        jobs.filter { $0.contentId == contentId && $0.status.isActive && ($0.type == .contentRender || $0.type == .contentGenerate) }
            .max { $0.createdAt < $1.createdAt }
    }

    // MARK: Month & selection

    var canGoToPreviousMonth: Bool { true }
    var canGoToNextMonth: Bool { true }

    func showPreviousMonth() {
        month = month.previous
        selectedId = nil
    }

    func showNextMonth() {
        month = month.next
        selectedId = nil
    }

    /// Jump to the nearest month that has posts in `direction` (-1 / +1), if any.
    func showAdjacentMonthWithPosts(_ direction: Int) {
        let candidates = months.filter { direction < 0 ? $0 < month : $0 > month }
        if let target = direction < 0 ? candidates.last : candidates.first {
            month = target
            selectedId = nil
        }
    }

    /// Move the selection by `offset` cards in the visible order (arrow keys); `columns`
    /// turns up/down into whole rows.
    func moveSelection(by offset: Int) {
        let cards = visibleCards
        guard !cards.isEmpty else { return }
        guard let current = selectedId, let index = cards.firstIndex(where: { $0.id == current }) else {
            selectedId = offset < 0 ? cards.last?.id : cards.first?.id
            return
        }
        selectedId = cards[max(0, min(cards.count - 1, index + offset))].id
    }

    // MARK: Actions

    /// Upload progress of slot images dropped on grid cards, by content id.
    private(set) var slotUploads: [EntityID: Double] = [:]

    /// Upload an image for a card's empty slot and fill it through a `content.render` edit.
    func uploadSlotImage(card: PostCard, url: URL) {
        guard let app else { return }
        let image: ImportedImage
        do { image = try ImageImport.from(url: url) } catch {
            self.error = error.localizedDescription
            return
        }
        let id = card.id
        guard let ref = card.content.currentVersion else {
            error = "\(card.title): bu postun henüz bir tasarımı yok."
            return
        }
        guard let slot = Self.targetSlot(card.slots), let layerId = slot.layerId else {
            error = "\(card.title): bu tasarımda görsel yuvası yok."
            return
        }
        let slide = slot.slideIndex
        slotUploads[id] = 0
        Task {
            do {
                let asset = try await app.dataService.uploadImage(image.file, brandId: card.content.brandId) { progress in
                    Task { @MainActor in if self.slotUploads[id] != nil { self.slotUploads[id] = progress } }
                }
                app.images.seed(image.thumbnail, for: asset.id)
                app.pendingImages.save(PendingSlotImage(contentId: id, assetId: asset.id, forVersion: ref.version, uploadedAt: .now))
                let src = DesignPatch.mediaSource(assetId: asset.id, mimeType: asset.mimeType)
                let job = try await app.dataService.render(contentId: id, ContentRenderRequest(
                    version: ref.version, patches: [DesignPatch(slide: slide, .fillSlot(layer: layerId, src: src))]))
                slotUploads[id] = nil
                _ = try await app.dataService.waitForJob(job.id)
                await load()
            } catch {
                slotUploads[id] = nil
                self.error = "\(card.title): \(AppModel.describe(error))"
            }
        }
    }

    /// The slot a dropped picture goes into: the first empty one, else the first slot.
    static func targetSlot(_ slots: [ImageSlot]) -> ImageSlot? {
        slots.first { $0.isEmpty && $0.layerId != nil } ?? slots.first { $0.layerId != nil }
    }

    /// Approve every ready post of the month by its verified hash.
    func approveReady() async {
        guard let app, !isApproving else { return }
        isApproving = true
        defer { isApproving = false }
        var failures: [String] = []
        for card in approvable {
            guard let hash = card.approvableHash else { continue }
            do {
                update(try await app.dataService.approve(contentId: card.content.id, hash: hash))
            } catch {
                failures.append("\(card.title): \(AppModel.describe(error))")
            }
        }
        error = failures.isEmpty ? nil : failures.joined(separator: "\n")
    }

    /// Why a post cannot be deleted (nil = it can).
    static func deletionBlocker(_ card: PostCard) -> String? {
        switch card.content.status {
        case .scheduled: "Zamanlanmış post silinemez; önce Takvim'den zamanlamayı iptal et."
        case .publishing: "Yayınlanmakta olan post silinemez."
        case .published: "Yayınlanmış post silinemez."
        default: nil
        }
    }

    /// Delete after the user confirmed.
    func delete(_ card: PostCard) async {
        guard let app else { return }
        if let blocker = Self.deletionBlocker(card) {
            error = blocker
            return
        }
        do {
            try await app.dataService.deleteContent(card.id)
            if app.detail?.content.id == card.id { app.detail = nil }
            removeCard(card.id)
            error = nil
        } catch {
            self.error = "\(card.title): \(AppModel.describe(error))"
        }
    }

    /// Duplicate a post as a new draft; returns the copy and selects it.
    @discardableResult
    func duplicate(_ card: PostCard) async -> Content? {
        guard let app else { return nil }
        do {
            let copy = try await app.dataService.duplicateContent(card.id)
            if let ref = copy.currentVersion, let version = try? await app.dataService.version(contentId: copy.id, version: ref.version) {
                store(version, content: copy)
            } else {
                update(copy)
            }
            await load()
            selectedId = copy.id
            error = nil
            return copy
        } catch {
            self.error = "\(card.title): \(AppModel.describe(error))"
            return nil
        }
    }
}

extension MonthKey {
    func distance(to other: MonthKey) -> Int { (other.year - year) * 12 + (other.month - month) }
}
