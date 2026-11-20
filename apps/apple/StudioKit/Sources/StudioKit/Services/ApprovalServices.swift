import Foundation

/// Approval and `@` name defaults: other conformers keep compiling; lists come back empty and
/// decisions say they cannot be made here.
extension StudioDataService {
    public func approvals(brandId: EntityID?, contentId: EntityID?, conversationId: EntityID?, status: ApprovalStatusFilter) async throws -> [ApprovalRequest] { [] }
    public func approval(_ id: EntityID) async throws -> ApprovalRequest {
        throw StudioAPIError.server(status: 404, code: .notFound, message: "approval \(id) not found", issues: [])
    }
    public func approveApproval(_ id: EntityID, assetId: EntityID?) async throws -> ApprovalActionResult {
        throw StudioAPIError.invalidConfiguration("Onay bu bağlantıda verilemiyor.")
    }
    public func rejectApproval(_ id: EntityID, note: String?) async throws -> ApprovalActionResult {
        throw StudioAPIError.invalidConfiguration("Onay bu bağlantıda verilemiyor.")
    }
    public func regenerateApproval(_ id: EntityID, _ input: ApprovalRegenerate) async throws -> ApprovalActionResult {
        throw StudioAPIError.invalidConfiguration("Yeniden üretim bu bağlantıda başlatılamıyor.")
    }
    public func mentionCandidates(brandId: EntityID) async throws -> [EntityMentionCandidate] { [] }

    /// The brand's pending requests, newest first.
    public func pendingApprovals(brandId: EntityID?) async throws -> [ApprovalRequest] {
        try await approvals(brandId: brandId, contentId: nil, conversationId: nil, status: .pending)
    }
}

extension RemoteStudioDataService {
    public func approvals(brandId: EntityID?, contentId: EntityID?, conversationId: EntityID?, status: ApprovalStatusFilter) async throws -> [ApprovalRequest] {
        try await client.approvals(brandId: brandId, contentId: contentId, conversationId: conversationId, status: status)
    }
    public func approval(_ id: EntityID) async throws -> ApprovalRequest { try await client.approval(id) }
    public func approveApproval(_ id: EntityID, assetId: EntityID?) async throws -> ApprovalActionResult {
        try await client.approveApproval(id, ApprovalApprove(assetId: assetId))
    }
    public func rejectApproval(_ id: EntityID, note: String?) async throws -> ApprovalActionResult {
        try await client.rejectApproval(id, ApprovalReject(note: note))
    }
    public func regenerateApproval(_ id: EntityID, _ input: ApprovalRegenerate) async throws -> ApprovalActionResult {
        try await client.regenerateApproval(id, input)
    }
    public func mentionCandidates(brandId: EntityID) async throws -> [EntityMentionCandidate] {
        try await client.mentionCandidates(brandId: brandId)
    }
}
