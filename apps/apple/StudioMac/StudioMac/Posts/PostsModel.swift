import AppKit
import StudioKit
import SwiftUI

/// The posts screen: one brand's month of posts from the contents API.
@MainActor
@Observable
final class PostsModel {
    weak var app: AppModel?
    var month = MonthKey(Date())
    var filter: PostFilter = .all
    private(set) var board = PostBoard(cards: [])
    private(set) var loadedBrandId: EntityID?
    private(set) var isLoading = false
    var error: String?
    var isApproving = false
    private var versions: [EntityID: ContentVersion] = [:]
    private var jobs: [Job] = []
    private var plans: [Plan] = []
    private var schedules: [Schedule] = []

    var brandId: EntityID? { app?.currentBrandId }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        let service = app.dataService
        do {
            async let contents = service.contents(brandId: brandId)
            async let plans = service.plans(brandId: brandId)
            async let schedules = service.schedules(brandId: brandId)
            async let jobs = service.jobs(brandId: brandId)
            let loaded = try await contents
            self.plans = try await plans
            self.schedules = try await schedules
            self.jobs = (try? await jobs) ?? []
            await loadVersions(for: loaded)
            rebuild(contents: loaded)
            if loadedBrandId != brandId {
                loadedBrandId = brandId
                // Show the month with the nearest posts when the current one is empty.
                let months = board.months()
                if !months.contains(month), let nearest = months.min(by: { abs($0.distance(to: month)) < abs($1.distance(to: month)) }) {
                    month = nearest
                }
            }
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// Fetch the current version of each content (cached by version id; versions are immutable).
    private func loadVersions(for contents: [Content]) async {
        guard let service = app?.dataService else { return }
        let needed = contents.compactMap { content -> (EntityID, Int)? in
            guard let ref = content.currentVersion, versions[content.id]?.id != ref.id else { return nil }
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
        if let index = contents.firstIndex(where: { $0.id == content.id }) { contents[index] = content } else { contents.append(content) }
        rebuild(contents: contents)
    }

    func scheduleCreated(_ schedule: Schedule) {
        schedules.append(schedule)
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
    var counts: [PostFilter: Int] { PostBoard.counts(monthCards) }
    var approvable: [PostCard] { PostBoard.approvable(monthCards) }
    var months: [MonthKey] { board.months() }

    func card(_ id: EntityID) -> PostCard? { board.cards.first { $0.id == id } }

    // MARK: Actions

    /// Upload progress of slot images dropped on grid cards, by content id.
    private(set) var slotUploads: [EntityID: Double] = [:]

    /// Upload an image for a card's empty slot. The slot-fill pipeline does not
    /// exist yet: the post shows "Görsel yüklendi" until a new version fills it.
    func uploadSlotImage(card: PostCard, url: URL) {
        guard let app else { return }
        let image: ImportedImage
        do { image = try ImageImport.from(url: url) } catch {
            self.error = error.localizedDescription
            return
        }
        let id = card.id
        let version = card.content.currentVersion?.version
        slotUploads[id] = 0
        Task {
            do {
                let asset = try await app.dataService.uploadImage(image.file, brandId: card.content.brandId) { progress in
                    Task { @MainActor in if self.slotUploads[id] != nil { self.slotUploads[id] = progress } }
                }
                slotUploads[id] = nil
                app.images.seed(image.thumbnail, for: asset.id)
                app.pendingImages.save(PendingSlotImage(contentId: id, assetId: asset.id, forVersion: version, uploadedAt: .now))
                rebuild(contents: board.cards.map(\.content))
            } catch {
                slotUploads[id] = nil
                self.error = "\(card.title): \(AppModel.describe(error))"
            }
        }
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
}

extension MonthKey {
    func distance(to other: MonthKey) -> Int { (other.year - year) * 12 + (other.month - month) }
}
