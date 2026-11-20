import Foundation
import Testing
@testable import StudioKit

/// Approval requests, `@product` / `@post` names, the brand's engine (docs/URETIM-RESIM.md Faz 0).
@Suite("Approvals and mentions")
struct ApprovalTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try StudioJSON.decoder().decode(type, from: Data(json.utf8))
    }

    private static let approvalJSON = #"""
    {"id":"apr_1","brandId":"b1","contentId":"c1","productId":"p1","conversationId":"conv1","messageId":"m1",
     "kind":"product_image","assetIds":["a1","a2"],
     "checkReport":{"passed":false,"items":[{"aspect":"Etiket yazısı","ok":true,"note":""},{"aspect":"Kapak rengi","ok":false,"note":"gri"}],"summary":""},
     "status":"pending","slotId":"photo","replacesAssetId":null,"approvedAssetId":null,"sourceJobId":"j1","regenerateJobId":null,
     "canRegenerate":true,"decisionNote":null,"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z","decidedAt":null}
    """#

    // MARK: Decoding

    @Test func decodesApprovalRequest() throws {
        let approval = try decode(ApprovalRequest.self, Self.approvalJSON)
        #expect(approval.kind == .productImage)
        #expect(approval.assetIds == ["a1", "a2"])
        #expect(approval.isPending)
        #expect(approval.canRegenerate)
        #expect(approval.hasProblems)
        #expect(approval.checkReport?.failed.map(\.aspect) == ["Kapak rengi"])
        #expect(approval.checkLine == "1 sorun: Kapak rengi")
        #expect(approval.slotId == "photo")
    }

    @Test func decodesMinimalAndNewerApprovals() throws {
        // Fields a server may leave out decode with defaults; unknown kinds and statuses stay readable.
        let minimal = try decode(ApprovalRequest.self, #"{"id":"a","brandId":"b","kind":"mystery","status":"later","createdAt":"2026-11-20T10:00:00Z"}"#)
        #expect(minimal.kind == .unknown)
        #expect(minimal.status == .unknown)
        #expect(minimal.assetIds.isEmpty)
        #expect(minimal.checkReport == nil)
        #expect(minimal.checkLine == "Kontrol yapılmadı")
        #expect(minimal.canRegenerate == false)
        #expect(minimal.updatedAt == minimal.createdAt)

        let page = try decode(Page<ApprovalRequest>.self, "{\"items\":[\(Self.approvalJSON)],\"nextCursor\":null}")
        #expect(page.items.count == 1)
    }

    @Test func decodesActionResult() throws {
        let json = "{\"approval\":\(Self.approvalJSON),\"content\":null,\"product\":null,\"job\":null}"
        let result = try decode(ApprovalActionResult.self, json)
        #expect(result.approval.id == "apr_1")
        #expect(result.content == nil && result.job == nil)
    }

    @Test func outcomeTexts() throws {
        var approval = try decode(ApprovalRequest.self, Self.approvalJSON)
        approval.status = .approved
        approval.approvedAssetId = "a2"
        #expect(approval.outcomeText == "Onaylandı · 2. görsel kullanıldı")
        approval.status = .rejected
        approval.decisionNote = "ışık soğuk"
        #expect(approval.outcomeText == "Reddedildi: ışık soğuk")
        approval.status = .superseded
        #expect(approval.outcomeText.hasPrefix("Yeniden üretiliyor"))
    }

    @Test func newFieldsOnOlderAndNewerServers() throws {
        let content = #"{"id":"c1","brandId":"b1","type":"post","title":"T","brief":"","status":"draft","targetPlatforms":["instagram"],"caption":"","currentVersion":null,"createdAt":"2026-11-20T10:00:00Z","updatedAt":"2026-11-20T10:00:00Z"}"#
        let old = try decode(Content.self, content)
        #expect(old.pendingApprovals == nil)
        #expect(old.waitingApprovals == 0)
        let newer = try decode(Content.self, content.replacingOccurrences(of: "\"brief\"", with: "\"pendingApprovals\":2,\"brief\""))
        #expect(newer.waitingApprovals == 2)

        let brand = #"{"id":"b1","name":"MTM","slug":"mtm","defaultLanguage":"tr","status":"active","createdAt":"2026-11-20T10:00:00Z","updatedAt":"2026-11-20T10:00:00Z"}"#
        #expect(try decode(Brand.self, brand).defaultEngine == nil)
        let withEngine = try decode(Brand.self, brand.replacingOccurrences(of: "\"status\"", with: "\"defaultEngine\":\"html\",\"imageStylePreset\":\"vintage\",\"status\""))
        #expect(withEngine.defaultEngine == .html)
        #expect(withEngine.imageStylePreset == "vintage")
        let asks = try decode(Brand.self, brand.replacingOccurrences(of: "\"status\"", with: "\"defaultEngine\":null,\"status\""))
        #expect(asks.defaultEngine == nil)

        let product = #"{"id":"p1","brandId":"b1","name":"Boro","createdAt":"2026-11-20T10:00:00Z","updatedAt":"2026-11-20T10:00:00Z","slug":"boro"}"#
        #expect(try decode(BrandProduct.self, product).slug == "boro")
    }

    @Test func brandUpdateSendsNullForAsk() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let ask = String(decoding: try encoder.encode(BrandUpdate.engine(nil)), as: UTF8.self)
        #expect(ask == #"{"defaultEngine":null}"#)
        let html = String(decoding: try encoder.encode(BrandUpdate.engine(.html)), as: UTF8.self)
        #expect(html == #"{"defaultEngine":"html"}"#)
        let style = String(decoding: try encoder.encode(BrandUpdate(imageStylePreset: "  retro  ")), as: UTF8.self)
        #expect(style == #"{"imageStylePreset":"retro"}"#)
        // Name-only updates say nothing about the engine.
        #expect(String(decoding: try encoder.encode(BrandUpdate(name: "A")), as: UTF8.self) == #"{"name":"A"}"#)
        #expect(GenerationEngine.listed.filter(\.isReady) == [.wecra, .html, .svg, .code])
    }

    @Test func messagePartsAndEntityMentions() throws {
        let json = #"""
        {"id":"m1","conversationId":"c1","role":"assistant","status":"complete","runId":null,
         "parts":[{"type":"text","text":"Hazır"},{"type":"approval_request","approvalId":"apr_1"}],
         "entityMentions":[{"kind":"product","id":"p1","name":"boro","start":0,"end":5}],
         "createdAt":"2026-11-20T10:00:00Z","updatedAt":"2026-11-20T10:00:00Z"}
        """#
        let message = try decode(Message.self, json)
        #expect(message.parts.count == 2)
        #expect(message.parts[1] == .approvalRequest(approvalId: "apr_1"))
        #expect(message.approvalIds == ["apr_1"])
        #expect(message.entityMentions?.first?.kind == .product)
        // Round trip keeps the part.
        let encoded = try JSONEncoder().encode(message.parts[1])
        #expect(try JSONDecoder().decode(MessagePart.self, from: encoded) == .approvalRequest(approvalId: "apr_1"))
    }

    @Test func jobStreamCarriesApprovalUpdates() throws {
        let frame = "{\"type\":\"approval.updated\",\"approval\":\(Self.approvalJSON)}"
        guard case .approvalUpdated(let approval) = try JobStreamMessage.decode(frame) else {
            Issue.record("approval.updated expected")
            return
        }
        #expect(approval.id == "apr_1")
        var board = JobBoard()
        board.apply(.message(.approvalUpdated(approval)))
        #expect(board.jobs.isEmpty)
    }

    @Test func decodesMentionCandidates() throws {
        let json = #"{"items":[{"kind":"product","id":"p1","slug":"boro","label":"Boro","imageAssetId":"a1","detail":"Gübre","pendingApprovals":0},{"kind":"content","id":"c1","slug":"hasat","label":"Hasat","imageAssetId":null,"detail":"draft","pendingApprovals":1},{"broken":true}]}"#
        let list = try decode(EntityMentionCandidateList.self, json)
        #expect(list.items.map(\.slug) == ["boro", "hasat"])
        #expect(list.items[1].pendingApprovals == 1)
    }

    // MARK: Names

    @Test func mentionNamesFollowTheContract() {
        #expect(EntityMentionNames.base("Venta Boro", kind: .product) == "venta-boro")
        #expect(EntityMentionNames.base("Hasat Bayramı", kind: .content) == "hasat-bayrami")
        #expect(EntityMentionNames.base("2026 Kış", kind: .content) == "post-2026-kis")
        #expect(EntityMentionNames.base("Image", kind: .product) == "image-urun")
        #expect(EntityMentionNames.base("!!!", kind: .product) == "urun")
        var taken: Set<String> = []
        let names = EntityMentionNames.allocate([("p1", "Boro"), ("p2", "Boro")], kind: .product, taken: &taken)
        #expect(names["p1"] == "boro")
        #expect(names["p2"] == "boro-2")

        let candidates = [EntityMentionCandidate(kind: .product, id: "p1", slug: "boro", label: "Boro")]
        let text = "@boro ile @image ve e@boro"
        let hits = EntityMentionNames.resolve(text, candidates: candidates, skip: ["image"])
        #expect(hits.map(\.id) == ["p1"])
        #expect(hits.first?.start == 0 && hits.first?.end == 5)
    }

    @Test func composerSuggestionsMixAliasesAndEntities() {
        let aliases = [MentionCandidate(alias: "image", assetId: "a1", isDraft: false)]
        let entities = [
            EntityMentionCandidate(kind: .product, id: "p1", slug: "venta-borinc", label: "Venta Borinc"),
            EntityMentionCandidate(kind: .content, id: "c1", slug: "image", label: "Image"),
            EntityMentionCandidate(kind: .content, id: "c2", slug: "hasat-bayrami", label: "Hasat Bayramı"),
        ]
        let merged = MentionText.merge(aliases: aliases, entities: entities)
        // The file alias wins over the post named the same.
        #expect(merged.map(\.alias) == ["image", "venta-borinc", "hasat-bayrami"])
        #expect(MentionText.suggestions(merged, query: "ven").map(\.alias) == ["venta-borinc"])
        // A post's title matches too ("bayram" is in "Hasat Bayramı").
        #expect(MentionText.suggestions(merged, query: "bayram").map(\.alias) == ["hasat-bayrami"])
        #expect(merged[1].title == "Venta Borinc")
        #expect(merged[0].title == "@image")
    }

    @Test func segmentsWithEntityMentions() {
        let text = "@image ve @boro"
        let file = MessageMention(alias: "image", aliasId: "al1", assetId: "a1", start: 0, end: 6)
        let entity = MessageEntityMention(kind: .product, id: "p1", name: "boro", start: 10, end: 15)
        let segments = MentionText.segments(text, mentions: [file], entityMentions: [entity])
        #expect(segments == [.mention(file), .text(" ve "), .entity(entity)])
    }

    // MARK: Sample backend

    @Test func sampleListsPendingApprovalsAndCounts() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        let pending = try await backend.pendingApprovals(brandId: SampleData.mtm)
        #expect(Set(pending.map(\.id)) == ["apr-venta", "apr-tarla", "apr-boro"])
        #expect(pending.first?.id == "apr-tarla") // newest first
        let post = try await backend.content("post-01")
        #expect(post.waitingApprovals == 1)
        let contents = try await backend.contents(brandId: SampleData.mtm)
        #expect(contents.filter { $0.waitingApprovals > 0 }.map(\.id).sorted() == ["post-01", "post-06"])
        // The chat shows them as cards.
        let state = try #require(await backend.state(of: SampleData.gorselConversation))
        #expect(state.messages.flatMap(\.approvalIds) == ["apr-venta", "apr-tarla"])
        #expect(state.messages.first?.entityMentions?.map(\.id) == ["product-venta", "post-01", "post-06"])
        // Candidates exist as assets (pictures load).
        let assets = try await backend.assets(brandId: SampleData.mtm, kind: .image)
        #expect(pending.flatMap(\.assetIds).allSatisfy { id in assets.contains { $0.id == id } })
    }

    @Test func sampleApproveRejectAndAnnounce() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        var feed = backend.jobFeed().makeAsyncIterator()
        // Listening before deciding.
        let first = await feed.next()
        #expect(first == .state(.live))
        let approved = try await backend.approveApproval("apr-venta", assetId: "asset-aday-venta-2")
        #expect(approved.approval.status == .approved)
        #expect(approved.approval.approvedAssetId == "asset-aday-venta-2")
        #expect(approved.content?.waitingApprovals == 0)
        #expect(approved.job?.type == .contentRender)
        // The picture fills the post's slot.
        #expect(try await backend.content("post-01").currentVersion?.version == 2)
        // Deciding twice is refused (409).
        await #expect(throws: StudioAPIError.self) { _ = try await backend.rejectApproval("apr-venta", note: nil) }

        let rejected = try await backend.rejectApproval("apr-tarla", note: "  ışık soğuk ")
        #expect(rejected.approval.status == .rejected)
        #expect(rejected.approval.decisionNote == "ışık soğuk")

        let upgrade = try await backend.approveApproval("apr-boro", assetId: nil)
        #expect(upgrade.product?.imageAssetIds == ["asset-boro-yeni"])

        var updates: [ApprovalRequest] = []
        while updates.count < 3, let event = await feed.next() {
            if case .message(.approvalUpdated(let approval)) = event { updates.append(approval) }
        }
        #expect(updates.map(\.id) == ["apr-venta", "apr-tarla", "apr-boro"])
        #expect(try await backend.pendingApprovals(brandId: SampleData.mtm).isEmpty)
    }

    @Test func sampleRegenerateMakesANewRequest() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        let result = try await backend.regenerateApproval("apr-venta", ApprovalRegenerate(preserveLabelComposite: true, instructions: "daha sıcak ışık"))
        #expect(result.approval.status == .superseded)
        #expect(result.job?.type == .imageGenerate)
        let pending = try await backend.pendingApprovals(brandId: SampleData.mtm)
        let fresh = try #require(pending.first { $0.contentId == "post-01" })
        #expect(fresh.id != "apr-venta")
        #expect(fresh.assetIds.count == 2)
        #expect(fresh.conversationId == SampleData.gorselConversation)
        let state = try #require(await backend.state(of: SampleData.gorselConversation))
        #expect(state.messages.last?.approvalIds == [fresh.id])
        #expect(state.messages.last?.plainText.contains("daha sıcak ışık") == true)
    }

    @Test func sampleMentionCandidatesAndSentMentions() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        let candidates = try await backend.mentionCandidates(brandId: SampleData.mtm)
        #expect(candidates.prefix(2).map(\.slug) == ["venta-borinc", "boro"])
        #expect(candidates.contains { $0.kind == .content && $0.slug == "venta-borinc-2" && $0.pendingApprovals == 1 })
        let sent = try await backend.send(OutgoingMessage(text: "@boro için yeni görsel"), to: SampleData.hasatConversation)
        #expect(sent.message.entityMentions?.map(\.id) == ["product-boro"])
    }
}
