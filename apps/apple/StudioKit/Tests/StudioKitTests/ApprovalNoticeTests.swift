import Foundation
import Testing
@testable import StudioKit

/// Notifications for new approval requests ("Onay bekleyen görsel"), each once.
@Suite("Approval notices")
struct ApprovalNoticeTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func approval(
        _ id: String, kind: ApprovalKind = .productImage, status: ApprovalStatus = .pending,
        report: ApprovalCheckReport? = ApprovalCheckReport(passed: true), age: TimeInterval = 10,
        conversationId: String? = "conv1", messageId: String? = "m1"
    ) -> ApprovalRequest {
        ApprovalRequest(
            id: id, brandId: "b1", contentId: "c1", productId: "p1", conversationId: conversationId, messageId: messageId,
            kind: kind, assetIds: ["a1"], checkReport: report, status: status,
            createdAt: now.addingTimeInterval(-age), updatedAt: now.addingTimeInterval(-age))
    }

    @Test func buildsTitleAndBody() throws {
        let clean = try #require(ActivityNoticeTracker.approvalNotice(for: approval("a"), subject: "Venta Borinc"))
        #expect(clean.id == "approval:a")
        #expect(clean.kind == .approvalPending)
        #expect(clean.kind.category == .waiting)
        #expect(clean.title == "Onay bekleyen görsel")
        #expect(clean.body == "Venta Borinc · Kontrol temiz")
        #expect(clean.conversationId == "conv1")
        #expect(clean.messageId == "m1")
        #expect(clean.contentId == "c1")
        #expect(clean.brandId == "b1")

        let report = ApprovalCheckReport(passed: false, items: [
            ApprovalCheckItem(aspect: "Etiket yazısı", ok: false, note: "bozuk"),
            ApprovalCheckItem(aspect: "Kapak", ok: false, note: "gri"),
            ApprovalCheckItem(aspect: "Renkler", ok: true),
        ], summary: "Şu kısımlar hatalı geldi")
        let upgrade = try #require(ActivityNoticeTracker.approvalNotice(for: approval("b", kind: .productPhotoUpgrade, report: report), subject: "Boro"))
        #expect(upgrade.title == "Ürün fotoğrafı iyileştirildi")
        #expect(upgrade.body == "Boro · 2 sorun: Etiket yazısı, Kapak")

        // No name known: the kind; no check: said so.
        let unnamed = try #require(ActivityNoticeTracker.approvalNotice(for: approval("c", kind: .variant, report: nil), subject: "  "))
        #expect(unnamed.title == "Onay bekleyen varyant")
        #expect(unnamed.body == "Varyant · Kontrol yapılmadı")

        #expect(ActivityNoticeTracker.checkSummary(ApprovalCheckReport(passed: false, summary: "Işık sert")) == "Işık sert")
        #expect(ActivityNoticeTracker.checkSummary(ApprovalCheckReport(passed: false)) == "Kontrol sorun buldu")
        #expect(ActivityNoticeTracker.approvalNotice(for: approval("d", status: .approved)) == nil)
    }

    @Test func announcesEachNewPendingOnce() {
        var tracker = ActivityNoticeTracker()
        #expect(tracker.approvalNotices(for: approval("a"), now: now).count == 1)
        // The same request updated again (a re-check) stays quiet.
        #expect(tracker.approvalNotices(for: approval("a"), now: now).isEmpty)
        // Old requests (listed long ago) are not news.
        #expect(tracker.approvalNotices(for: approval("old", age: 3600), now: now).isEmpty)
        // Decided requests never ring.
        #expect(tracker.approvalNotices(for: approval("done", status: .approved), now: now).isEmpty)
        #expect(tracker.approvalNotices(for: approval("done"), now: now).isEmpty)
    }

    @Test func settledRequestsStayQuiet() {
        var tracker = ActivityNoticeTracker()
        // Listed at load, or decided on this device before the feed's event arrived.
        tracker.settleApprovals(["listed", "decided"])
        #expect(tracker.approvalNotices(for: approval("listed"), now: now).isEmpty)
        #expect(tracker.approvalNotices(for: approval("decided"), now: now).isEmpty)
        #expect(tracker.approvalNotices(for: approval("fresh"), now: now).map(\.id) == ["approval:fresh"])
    }

    @Test func backgroundListsRequestsCreatedSinceLastCheck() {
        let since = now.addingTimeInterval(-600)
        let list = [
            approval("late", age: 30), approval("early", age: 300), approval("before", age: 900),
            approval("decided", status: .rejected, age: 60),
        ]
        let notices = ActivityNoticeTracker.approvalNotices(for: list, createdAfter: since) { $0.id == "late" ? "Boro" : nil }
        #expect(notices.map(\.id) == ["approval:early", "approval:late"])
        #expect(notices.last?.body.hasPrefix("Boro · ") == true)
    }
}
