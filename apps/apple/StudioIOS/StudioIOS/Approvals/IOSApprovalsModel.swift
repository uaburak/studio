import Foundation
import Observation
import StudioKit

/// Approval requests ("Onay bekleyenler", docs/URETIM-RESIM.md §11–12): the current brand's
/// pending list for the ⋯ menu and its screen, every request a chat card shows (any status), and
/// the three decisions. `approval.updated` on the job feed keeps it live.
@MainActor
@Observable
final class IOSApprovalsModel {
    @ObservationIgnored weak var app: IOSAppModel?

    /// Every request seen (pending list, chat cards, live updates), by id.
    private(set) var records: [EntityID: ApprovalRequest] = [:]
    /// The current brand's pending requests, newest first.
    private(set) var pendingIds: [EntityID] = []
    private(set) var loadedBrandId: EntityID?
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    var error: String?
    /// Requests whose decision is on its way.
    private(set) var busy: Set<EntityID> = []
    @ObservationIgnored private var fetching: Set<EntityID> = []
    @ObservationIgnored private var missing: Set<EntityID> = []

    var pending: [ApprovalRequest] { pendingIds.compactMap { records[$0] } }
    var count: Int { pendingIds.count }

    /// The pending requests of one post.
    func pending(contentId: EntityID) -> [ApprovalRequest] { pending.filter { $0.contentId == contentId } }

    func reset() {
        records = [:]
        pendingIds = []
        loadedBrandId = nil
        hasLoaded = false
        error = nil
        busy = []
        fetching = []
        missing = []
    }

    /// The current brand's pending list.
    func load() async {
        guard let app else { return }
        let brandId = app.currentBrandId
        isLoading = true
        defer { isLoading = false }
        do {
            let list = try await app.dataService.approvals(brandId: brandId, contentId: nil, conversationId: nil, status: .pending)
            guard brandId == app.currentBrandId else { return }
            for approval in list { records[approval.id] = approval }
            pendingIds = list.filter(\.isPending).sorted { $0.createdAt > $1.createdAt }.map(\.id)
            loadedBrandId = brandId
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
        hasLoaded = true
    }

    /// A request a chat card shows: known now, or read once in the background.
    func approval(_ id: EntityID) -> ApprovalRequest? {
        if let found = records[id] { return found }
        fetch(id)
        return nil
    }

    /// The card could not read it (removed, an older Mac).
    func isMissing(_ id: EntityID) -> Bool { missing.contains(id) }

    private func fetch(_ id: EntityID) {
        guard let app, !fetching.contains(id), !missing.contains(id) else { return }
        fetching.insert(id)
        let service = app.dataService
        Task { [weak self] in
            do {
                let found = try await service.approval(id)
                self?.apply(found)
            } catch {
                self?.missing.insert(id)
            }
            self?.fetching.remove(id)
        }
    }

    /// A request changed (the job feed, a decision made here or elsewhere).
    func apply(_ approval: ApprovalRequest) {
        let previous = records[approval.id]
        records[approval.id] = approval
        missing.remove(approval.id)
        let belongs = approval.brandId == (loadedBrandId ?? app?.currentBrandId)
        if approval.isPending && belongs {
            if !pendingIds.contains(approval.id) {
                pendingIds.append(approval.id)
                pendingIds.sort { (records[$0]?.createdAt ?? .distantPast) > (records[$1]?.createdAt ?? .distantPast) }
            }
        } else {
            pendingIds.removeAll { $0 == approval.id }
        }
        // The post's "Onay bekliyor" follows (and an approved picture lands in its slot).
        if previous?.status != approval.status, let contentId = approval.contentId, let posts = app?.posts, posts.card(contentId) != nil {
            Task { await posts.refresh(contentId: contentId) }
        }
    }

    // MARK: Decisions

    /// "Onayla" (`assetId`: which candidate; nil = the first). Returns why it failed.
    func approve(_ approval: ApprovalRequest, assetId: EntityID? = nil) async -> String? {
        await decide(approval) { service in try await service.approveApproval(approval.id, assetId: assetId) }
    }

    /// "Reddet" with an optional note.
    func reject(_ approval: ApprovalRequest, note: String?) async -> String? {
        await decide(approval) { service in try await service.rejectApproval(approval.id, note: note) }
    }

    /// "Yeniden üret" / "Etiketi birebir koruyarak yerleştir": the owner's consent (paid).
    func regenerate(_ approval: ApprovalRequest, preserveLabel: Bool, instructions: String?) async -> String? {
        await decide(approval) { service in
            try await service.regenerateApproval(approval.id, ApprovalRegenerate(preserveLabelComposite: preserveLabel, instructions: instructions))
        }
    }

    private func decide(_ approval: ApprovalRequest, _ work: @escaping (any StudioDataService) async throws -> ApprovalActionResult) async -> String? {
        guard let app, !busy.contains(approval.id) else { return nil }
        busy.insert(approval.id)
        defer { busy.remove(approval.id) }
        do {
            let result = try await work(app.dataService)
            apply(result.approval)
            if let content = result.content, app.posts.card(content.id) != nil {
                await app.posts.refresh(contentId: content.id)
            }
            return nil
        } catch {
            // Decided elsewhere meanwhile (409): show what it is now.
            if (error as? StudioAPIError)?.code == .conflict, let fresh = try? await app.dataService.approval(approval.id) {
                apply(fresh)
                return "Bu kayıt başka bir yerde karara bağlanmış: \(fresh.status.label)."
            }
            return IOSAppModel.describe(error)
        }
    }

    // MARK: Names for lists and cards

    /// "Venta Borinc" (the post's title) or the product's name when known.
    func subject(of approval: ApprovalRequest) -> String? {
        if let contentId = approval.contentId, let title = app?.posts.card(contentId)?.title { return title }
        if let productId = approval.productId, let name = app?.mentionCandidates.first(where: { $0.kind == .product && $0.id == productId })?.label { return name }
        return nil
    }
}
