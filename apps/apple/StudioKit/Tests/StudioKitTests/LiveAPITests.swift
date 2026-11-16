import Foundation
import Testing
@testable import StudioKit

/// End-to-end checks against a running, seeded LOCAL API. Skipped unless
/// `STUDIO_LIVE_API_URL` is set (e.g. http://127.0.0.1:8787). They change data
/// (one message, one approval), so never point them at a deployed API.
enum LiveAPI {
    static var baseURL: URL? {
        guard let raw = ProcessInfo.processInfo.environment["STUDIO_LIVE_API_URL"], let url = URL(string: raw),
              url.host == "127.0.0.1" || url.host == "localhost" else { return nil }
        return url
    }
}

@Suite("Live local API", .enabled(if: LiveAPI.baseURL != nil), .serialized)
struct LiveAPITests {
    private var client: APIClient { APIClient(baseURL: LiveAPI.baseURL!) }

    @Test func conversationStreamSendWithAliasAndMentions() async throws {
        let conversations = RemoteConversationService(client: client)
        let data = RemoteStudioDataService(client: client)
        let brand = try #require(try await data.brands().first { $0.slug == "mtm-agro" })
        let conversation = try await conversations.createConversation(brandId: brand.id, title: "StudioKit canlı test")

        // Upload an image and send it with a requested alias and a mention.
        let png = try #require(SampleImages.png(seed: "live-test", width: 60, height: 75))
        let progress = ProgressBox()
        let asset = try await conversations.uploadImage(UploadFile(filename: "canli.png", mimeType: "image/png", data: png, width: 60, height: 75), brandId: brand.id) { progress.add($0) }
        #expect(progress.values.last == 1)

        let stream = conversations.observe(conversation.id)
        var iterator = stream.makeAsyncIterator()
        var state: ConversationState?
        while state == nil, let event = await iterator.next() {
            if case .conversation(let s) = event { state = s }
        }
        #expect(state?.conversation.id == conversation.id)

        let result = try await conversations.send(
            OutgoingMessage(text: "@tarla-foto görselini kapakta kullan", attachments: [OutgoingAttachment(assetId: asset.id, alias: "tarla-foto")]),
            to: conversation.id)
        #expect(result.run.status == .queued)
        #expect(result.message.mentions?.map(\.alias) == ["tarla-foto"])

        // The stream delivers the message, the alias and the queued run.
        var sawMessage = false, sawAlias = false, sawRun = false
        let deadline = Date().addingTimeInterval(10)
        while !(sawMessage && sawAlias && sawRun), Date() < deadline, let event = await iterator.next() {
            guard case .conversation(let s) = event else { continue }
            sawMessage = s.messages.contains { $0.id == result.message.id }
            sawAlias = s.aliases.contains { $0.alias == "tarla-foto" && $0.assetId == asset.id }
            sawRun = s.activeRun?.id == result.run.id
        }
        #expect(sawMessage && sawAlias && sawRun)

        // A second message while the run is active: 409.
        await #expect(throws: StudioAPIError.self) {
            _ = try await conversations.send(OutgoingMessage(text: "tekrar"), to: conversation.id)
        }
        // Rename keeps the old name reserved.
        let alias = try #require(try await conversations.aliases(conversationId: conversation.id).first)
        let renamed = try await conversations.renameAlias(conversationId: conversation.id, aliasId: alias.id, to: "kapak")
        #expect(renamed.previousAliases == ["tarla-foto"])
        _ = try await conversations.cancelRun(result.run.id)
        _ = try await conversations.archiveConversation(conversation.id)
    }

    @Test func approveAReadyPostByItsVerifiedHash() async throws {
        let data = RemoteStudioDataService(client: client)
        let brand = try #require(try await data.brands().first { $0.slug == "mtm-agro" })
        let contents = try await data.contents(brandId: brand.id)
        var versions: [EntityID: ContentVersion] = [:]
        for content in contents {
            if let ref = content.currentVersion { versions[content.id] = try await data.version(contentId: content.id, version: ref.version) }
        }
        let board = PostBoard(contents: contents, versions: versions, plans: try await data.plans(brandId: brand.id), schedules: try await data.schedules(brandId: brand.id))
        #expect(PostBoard.counts(board.cards)[.imageNeeded] == 6)
        guard let card = PostBoard.approvable(board.cards).first, let hash = card.approvableHash else {
            Issue.record("no ready post left to approve (re-seed the API)")
            return
        }
        // A wrong hash is refused with the contract's code.
        do {
            _ = try await data.approve(contentId: card.id, hash: String(repeating: "0", count: 64))
            Issue.record("expected hash_mismatch")
        } catch let error as StudioAPIError {
            #expect(error.code == .hashMismatch)
        }
        let approved = try await data.approve(contentId: card.id, hash: hash)
        #expect(approved.status == .approved)
        #expect(approved.approval?.contentHash == hash)
    }

    @Test func jobStreamDeliversASnapshot() async throws {
        let stream = JobStream(client: client).events()
        var gotSnapshot = false
        for await event in stream {
            if case .message(.snapshot) = event { gotSnapshot = true; break }
        }
        #expect(gotSnapshot)
    }
}
