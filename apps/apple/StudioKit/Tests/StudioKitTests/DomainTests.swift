import Foundation
import Testing
@testable import StudioKit

@Suite("Aliases and mentions")
struct MentionTests {
    @Test func aliasRulesMatchTheContract() {
        #expect(ImageAlias.isValid("image"))
        #expect(ImageAlias.isValid("image-1"))
        #expect(ImageAlias.isValid("a"))
        #expect(!ImageAlias.isValid("1image"))
        #expect(!ImageAlias.isValid("image-"))
        #expect(!ImageAlias.isValid("Image"))
        #expect(!ImageAlias.isValid(""))
        #expect(!ImageAlias.isValid(String(repeating: "a", count: 41)))
        #expect(ImageAlias.normalize("Tarla Fotoğrafı") == "tarla-fotografi")
        #expect(ImageAlias.normalize("  2. Çekim!! ") == "cekim")
        #expect(ImageAlias.normalize("ŞUBAT ışık") == "subat-isik")
    }

    @Test func allocatorNumbersForwardAndNeverReuses() throws {
        var allocator = AliasAllocator()
        #expect(allocator.next() == "image")
        #expect(allocator.next() == "image-1")
        let third = allocator.next()
        #expect(third == "image-2")
        allocator.release(third)
        #expect(allocator.next() == "image-3")
        try allocator.rename("image-1", to: "tarla")
        #expect(allocator.isAvailable("image-1"))
        #expect(throws: AliasAllocator.RenameError.taken) { try allocator.rename("image-3", to: "tarla") }
        #expect(throws: AliasAllocator.RenameError.invalid) { try allocator.rename("image-3", to: "Kötü İsim") }
        #expect(allocator.next() == "image-4")

        // Existing aliases (including previous names) are respected.
        let existing = ConversationAlias(id: "1", conversationId: "c", alias: "depo", previousAliases: ["image-6"], assetId: "a", mimeType: "image/png", createdAt: .now, updatedAt: .now)
        var fromServer = AliasAllocator(aliases: [existing])
        #expect(fromServer.next() == "image-7")
        #expect(!fromServer.isAvailable("depo"))
    }

    @Test func tokensFollowTheServerRules() {
        func names(_ text: String) -> [String] { MentionText.scanTokens(text).map(\.alias) }
        #expect(names("@image tarladan") == ["image"])
        #expect(names("mail a@image.com") == [])
        #expect(names("@image-10 ve @image-1") == ["image-10", "image-1"])
        #expect(names("@imageım") == [])
        #expect(names("@image, @image-1'i (@image)") == ["image", "image-1", "image"])
        #expect(names("@image- son") == ["image"])
        #expect(names("@Image") == ["image"])
        #expect(names("@1abc @") == [])
    }

    @Test func offsetsAreUTF16() {
        let text = "👩‍🌾 @image-1 çok iyi"
        let token = try! #require(MentionText.scanTokens(text).first)
        let ns = text as NSString
        #expect(ns.substring(with: NSRange(location: token.start, length: token.end - token.start)) == "@image-1")
    }

    @Test func resolvesCurrentAndPreviousNamesOnly() {
        let targets = [
            MentionText.Target(id: "al1", alias: "tarla", previousAliases: ["image"], assetId: "a1"),
            MentionText.Target(id: "al2", alias: "image-1", assetId: "a2"),
        ]
        let mentions = MentionText.resolve("@image ve @tarla, @image-1; @bilinmeyen", aliases: targets)
        #expect(mentions.map(\.aliasId) == ["al1", "al1", "al2"])
        #expect(mentions.map(\.alias) == ["image", "tarla", "image-1"])
        let segments = MentionText.segments("@image ve @tarla, @image-1; @bilinmeyen", mentions: mentions)
        #expect(segments.count == 6)
        #expect(segments.last == .text("; @bilinmeyen"))
    }

    @Test func activeQueryForAutocomplete() {
        #expect(MentionText.activeQuery(in: "şunu @ima", cursor: ("şunu @ima" as NSString).length)?.query == "ima")
        #expect(MentionText.activeQuery(in: "@", cursor: 1)?.query == "")
        #expect(MentionText.activeQuery(in: "a@ima", cursor: 5) == nil)
        #expect(MentionText.activeQuery(in: "@image ", cursor: 7) == nil)
    }
}

@Suite("Posts board")
struct PostBoardTests {
    private func board(_ sample: SampleData = SampleData()) -> PostBoard {
        PostBoard(contents: sample.contents, versions: sample.versions, plans: sample.plans, schedules: sample.schedules, jobs: sample.jobs)
    }

    @Test func countsMatchTheDraft() {
        let cards = board().cards(in: MonthKey(year: 2026, month: 11), timeZone: TimeZone(identifier: "Europe/Istanbul")!)
        let counts = PostBoard.counts(cards)
        #expect(counts[.all] == 12)
        #expect(counts[.ready] == 3)
        #expect(counts[.imageNeeded] == 6)
        #expect(counts[.approved] == 3)
        #expect(cards.prefix(8).map(\.title) == ["Venta Borinc", "Doğru saklama rehberi", "Bor ve çinko", "Bayi buluşması", "Uygulama zamanı", "Tarladan", "Soru cevap", "Ay sonu"])
        #expect(cards.first?.eyebrow == "YENİ ÜRÜN")
        #expect(cards.first?.placeholderTone == .muted)
        #expect(cards[1].placeholderTone == .dark)
        #expect(cards[2].placeholderTone == .light)
    }

    @Test func approvableCardsCarryAVerifiedHash() {
        let ready = PostBoard.approvable(board().cards)
        #expect(ready.count == 3)
        #expect(ready.allSatisfy { $0.approvableHash == $0.content.currentVersion?.contentHash })
    }

    @Test func aTamperedVersionIsNotApprovable() {
        var sample = SampleData()
        let id = "post-02a"
        sample.versions[id]?.slides[0].html += "<!-- changed -->"
        let card = board(sample).cards.first { $0.id == id }!
        #expect(card.state == .ready)
        #expect(card.approvableHash == nil)
    }

    @Test func uploadedImageMovesToPending() {
        let sample = SampleData()
        let pending = PendingSlotImage(contentId: "post-01", assetId: "x", forVersion: 1, uploadedAt: .now)
        let board = PostBoard(contents: sample.contents, versions: sample.versions, plans: sample.plans, schedules: sample.schedules, pendingImages: ["post-01": pending])
        #expect(board.cards.first { $0.id == "post-01" }?.state == .imageUploaded)
    }

    @Test func slotScannerReadsAttributesInAnyOrder() {
        let html = #"<div class=a data-slot-label='Ürün &amp; tarla' data-type="slot" data-slot-ratio=4:5 data-slot-state="filled"><img data-slot-image src="x"></div><div data-type="text">x</div>"#
        let slots = SlotScanner.slots(inHTML: html)
        #expect(slots.count == 1)
        #expect(slots[0].state == .filled)
        #expect(slots[0].ratio == "4:5")
        #expect(slots[0].label == "Ürün & tarla")
        #expect(slots[0].aspect == 0.8)
    }

    @Test func captionSplitsHashtags() {
        let parts = CaptionParts(caption: "Bor ve çinko bir arada.\nAyrıntılar için bayinize danışın.\n\n#mtmagro #venta\n#bor")
        #expect(parts.body == "Bor ve çinko bir arada.\nAyrıntılar için bayinize danışın.")
        #expect(parts.hashtags == ["#mtmagro", "#venta", "#bor"])
        #expect(CaptionParts(body: parts.body, hashtags: parts.hashtags).caption == "Bor ve çinko bir arada.\nAyrıntılar için bayinize danışın.\n\n#mtmagro #venta #bor")
        #expect(CaptionParts.parseHashtags("venta, #bor  çinko") == ["#venta", "#bor", "#çinko"])
        #expect(CaptionParts(caption: "#tek").body == "")
    }

    @Test func contentHashMatchesJSONStringify() {
        // JSON.stringify([{width:1,height:2,html:"a\"b\\c\n\u0001ç/"}]) hashed with SHA-256 (computed in Node).
        let slide = Slide(html: "a\"b\\c\n\u{01}ç/\u{2028}", width: 1, height: 2)
        #expect(ContentHash.jsonString(slide.html) == "\"a\\\"b\\\\c\\n\\u0001ç/\u{2028}\"")
        // node -e 'crypto.createHash("sha256").update(JSON.stringify([{width:1,height:2,html:"a\"b\\c\n\u0001ç/ "}]))'
        #expect(ContentHash.compute([slide]) == "18f8150ca5936392d9e51de8c5d77c05ed3b32acbcba881f8e22104414851f4c")
    }

    @Test func turkishFormatting() {
        #expect(TurkishFormat.shortDay(CalendarDay(year: 2026, month: 11, day: 4)) == "4 Kas")
        #expect(TurkishFormat.upper("yeni ürün") == "YENİ ÜRÜN")
        #expect(TurkishFormat.ratio(width: 1080, height: 1350) == "4:5")
        #expect(TurkishFormat.typeLabel(.post, slides: [Slide(html: "", width: 1080, height: 1350)]) == "Tek görsel · 4:5")
        let start = Date(timeIntervalSince1970: 0)
        #expect(TurkishFormat.elapsed(from: start, to: start.addingTimeInterval(150)) == "2 dk")
    }
}

@Suite("Sample backend behaves like the API without a worker")
struct SampleBackendTests {
    @Test func sendingAllocatesAliasesAndQueuesARun() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        let conversation = try await backend.createConversation(brandId: SampleData.mtm, title: nil)
        let file = UploadFile(filename: "a.png", mimeType: "image/png", data: Data([1, 2, 3]))
        let a1 = try await backend.uploadImage(file, brandId: SampleData.mtm) { _ in }
        let a2 = try await backend.uploadImage(file, brandId: SampleData.mtm) { _ in }
        let result = try await backend.send(OutgoingMessage(
            text: "@image ve @depo birlikte", attachments: [OutgoingAttachment(assetId: a1.id, alias: nil), OutgoingAttachment(assetId: a2.id, alias: "depo")]),
            to: conversation.id)
        #expect(result.run.status == .queued)
        #expect(result.message.mentions?.map(\.alias) == ["image", "depo"])
        let aliases = try await backend.aliases(conversationId: conversation.id)
        #expect(aliases.map(\.alias) == ["image", "depo"])
        // Another message while the run is active: 409, like the API.
        await #expect(throws: StudioAPIError.self) {
            _ = try await backend.send(OutgoingMessage(text: "tekrar"), to: conversation.id)
        }
        _ = try await backend.cancelRun(result.run.id)
        // A requested alias that is taken: 409.
        let a3 = try await backend.uploadImage(file, brandId: SampleData.mtm) { _ in }
        await #expect(throws: StudioAPIError.self) {
            _ = try await backend.send(OutgoingMessage(text: "x", attachments: [OutgoingAttachment(assetId: a3.id, alias: "depo")]), to: conversation.id)
        }
        // Rename keeps the old name reserved.
        let renamed = try await backend.renameAlias(conversationId: conversation.id, aliasId: aliases[0].id, to: "tarla")
        #expect(renamed.previousAliases == ["image"])
        await #expect(throws: StudioAPIError.self) {
            _ = try await backend.renameAlias(conversationId: conversation.id, aliasId: aliases[1].id, to: "image")
        }
    }

    @Test func approvingNeedsTheCurrentHash() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        await #expect(throws: StudioAPIError.self) { _ = try await backend.approve(contentId: "post-02a", hash: "nope") }
        let content = try await backend.content("post-02a")
        let approved = try await backend.approve(contentId: content.id, hash: content.currentVersion!.contentHash)
        #expect(approved.status == .approved)
        let edited = try await backend.updateCaption(contentId: content.id, caption: "yeni")
        #expect(edited.status == .draft)
        #expect(edited.approval == nil)
    }

    @Test func observeDeliversStateAndUpdates() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        let stream = backend.observe(SampleData.kasimConversation)
        var iterator = stream.makeAsyncIterator()
        #expect(await iterator.next() == .state(.live))
        guard case .conversation(let state)? = await iterator.next() else {
            Issue.record("state expected")
            return
        }
        #expect(state.openPlan?.items.count == 12)
        #expect(state.messages.count == 2)
    }
}
