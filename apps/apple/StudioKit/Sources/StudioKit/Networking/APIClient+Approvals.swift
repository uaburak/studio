import Foundation

// Approval requests (`/api/approvals`, apps/api/src/routes/approvals.ts) and the composer's `@`
// candidates (`/api/brands/{brandId}/mention-candidates`), docs/URETIM-RESIM.md Faz 0.

extension APIClient {
    /// One page, newest first (`status` defaults to `pending` on the server).
    public func approvalsPage(
        brandId: EntityID? = nil, contentId: EntityID? = nil, conversationId: EntityID? = nil,
        status: ApprovalStatusFilter = .pending, limit: Int = 50, cursor: String? = nil
    ) async throws(StudioAPIError) -> Page<ApprovalRequest> {
        try await get(Page<ApprovalRequest>.self, "/api/approvals", query: [
            "brandId": brandId, "contentId": contentId, "conversationId": conversationId,
            "status": status.rawValue, "limit": String(limit), "cursor": cursor,
        ])
    }

    /// Every page (at most a few hundred records).
    public func approvals(
        brandId: EntityID? = nil, contentId: EntityID? = nil, conversationId: EntityID? = nil, status: ApprovalStatusFilter = .pending
    ) async throws(StudioAPIError) -> [ApprovalRequest] {
        try await all(ApprovalRequest.self, "/api/approvals", query: [
            "brandId": brandId, "contentId": contentId, "conversationId": conversationId, "status": status.rawValue,
        ], maxPages: 10)
    }

    public func approval(_ id: EntityID) async throws(StudioAPIError) -> ApprovalRequest {
        try await get(ApprovalRequest.self, "/api/approvals/\(Self.enc(id))")
    }

    /// 409 unless pending.
    public func approveApproval(_ id: EntityID, _ input: ApprovalApprove = ApprovalApprove()) async throws(StudioAPIError) -> ApprovalActionResult {
        try await send(ApprovalActionResult.self, .post, "/api/approvals/\(Self.enc(id))/approve", body: input)
    }

    /// 409 unless pending.
    public func rejectApproval(_ id: EntityID, _ input: ApprovalReject = ApprovalReject()) async throws(StudioAPIError) -> ApprovalActionResult {
        try await send(ApprovalActionResult.self, .post, "/api/approvals/\(Self.enc(id))/reject", body: input)
    }

    /// 409 for decided requests or when the original request is unknown.
    public func regenerateApproval(_ id: EntityID, _ input: ApprovalRegenerate = ApprovalRegenerate()) async throws(StudioAPIError) -> ApprovalActionResult {
        try await send(ApprovalActionResult.self, .post, "/api/approvals/\(Self.enc(id))/regenerate", body: input)
    }

    public func mentionCandidates(brandId: EntityID) async throws(StudioAPIError) -> [EntityMentionCandidate] {
        try await get(EntityMentionCandidateList.self, "/api/brands/\(Self.enc(brandId))/mention-candidates").items
    }
}
