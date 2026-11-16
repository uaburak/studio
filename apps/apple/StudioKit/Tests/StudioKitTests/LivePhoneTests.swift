import Foundation
import Testing
@testable import StudioKit

/// The iPhone's paths end to end, as a paired phone sees them: pairing through the LAN
/// gateway, then every request with the device token. Skipped unless
/// `STUDIO_LIVE_PHONE_LOCAL` (the Mac's own API, e.g. http://127.0.0.1:8790, used only to
/// issue the pairing code and revoke the device) and `STUDIO_LIVE_PHONE_GATEWAY` (e.g.
/// http://192.168.1.10:8791) are set. `STUDIO_LIVE_PHONE_AI=1` also runs two real chat
/// turns (Claude Haiku on the Mac's subscription). It creates its own brand, posts and
/// conversation, archives / deletes them afterwards and revokes the test device.
enum LivePhone {
    static var localURL: URL? { url("STUDIO_LIVE_PHONE_LOCAL") { $0 == "127.0.0.1" || $0 == "localhost" } }
    static var gatewayURL: URL? {
        url("STUDIO_LIVE_PHONE_GATEWAY") { host in
            host == "127.0.0.1" || host.hasPrefix("192.168.") || host.hasPrefix("10.") || host.hasSuffix(".local")
        }
    }

    static var runsAI: Bool { ProcessInfo.processInfo.environment["STUDIO_LIVE_PHONE_AI"] == "1" }
    static var enabled: Bool { localURL != nil && gatewayURL != nil }

    private static func url(_ key: String, allow: (String) -> Bool) -> URL? {
        guard let raw = ProcessInfo.processInfo.environment[key], let url = URL(string: raw), let host = url.host, allow(host) else { return nil }
        return url
    }

    static func log(_ line: String) { print("[canlı telefon] \(line)") }
}

@Suite("Live phone paths (paired device)", .enabled(if: LivePhone.enabled), .serialized)
@MainActor
struct LivePhoneTests {
    private struct NewContent: Encodable { var brandId: String; var type = "post"; var title: String; var targetPlatforms = ["instagram"]; var caption: String }
    private struct NewVersion: Encodable { var origin = "generated"; var slides: [NewSlide] }
    private struct NewSlide: Encodable { var html: String; var width = 1080; var height = 1350 }
    private struct BrandArchive: Encodable { var status = "archived" }

    @Test func pairChatEditFillApproveAndConsent() async throws {
        let local = APIClient(baseURL: LivePhone.localURL!)
        let gateway = LivePhone.gatewayURL!
        let stamp = Int(Date().timeIntervalSince1970)

        // 1. Pairing: code from the Mac, claim through the LAN gateway like the phone.
        let code = try await local.createPairingCode().code
        let store = InMemoryDeviceTokenStore()
        let pairing = PairingClient(store: store)
        let device = try await pairing.pair(baseURL: gateway, serverName: "P5 canlı test", code: code, deviceName: "P5 canlı test \(stamp)")
        LivePhone.log("eşleşti: cihaz \(device.id) @ \(gateway.absoluteString)")
        let cleanup = LiveCleanup()
        cleanup.add {
            let revoked = try? await local.revokeDevice(device.id)
            LivePhone.log("cihaz anahtarı iptal edildi: \(revoked?.isRevoked == true)")
        }
        do {
            try await flow(local: local, gateway: gateway, store: store, stamp: stamp, cleanup: cleanup)
        } catch {
            await cleanup.run()
            throw error
        }
        await cleanup.run()
    }

    private func flow(local: APIClient, gateway: URL, store: InMemoryDeviceTokenStore, stamp: Int, cleanup: LiveCleanup) async throws {
        let anonymous = APIClient(baseURL: gateway)
        await #expect(throws: StudioAPIError.self) { _ = try await anonymous.brands() }
        let phone = APIClient(baseURL: gateway, auth: DeviceTokenAuth(store: store))
        let data = RemoteStudioDataService(client: phone)
        let chat = RemoteConversationService(client: phone)
        #expect(try await phone.health().status == "ok")
        await #expect(throws: StudioAPIError.self) { _ = try await phone.createPairingCode() }
        let presence = try await data.presence()
        LivePhone.log("Mac: \(AssistantStatus.macLine(presence)) · Claude: \(AssistantStatus.claudeLine(presence))")

        // 2. A brand of our own.
        let brand = try await data.createBrand(BrandCreate(name: "P5 Telefon \(stamp)", slug: "p5-telefon-\(stamp)"))
        cleanup.add {
            _ = try? await phone.send(Brand.self, .patch, "/api/brands/\(brand.id)", body: BrandArchive())
            LivePhone.log("marka arşivlendi")
        }

        // 3. Post editor through the phone: measure, edit text, fill the slot, approve.
        var content = try await phone.send(Content.self, .post, "/api/contents", body: NewContent(brandId: brand.id, title: "Telefon editör \(stamp)", caption: "Telefondan düzenlendi. #studio"))
        let editorId = content.id
        cleanup.add {
            try? await phone.deleteContent(editorId)
            LivePhone.log("editör postu silindi")
        }
        let html = try LiveEditor.fixture("image-slot.html")
        let v1 = try await phone.send(ContentVersion.self, .post, "/api/contents/\(content.id)/versions", body: NewVersion(slides: [NewSlide(html: html)]))
        content = try await data.content(content.id)
        let session = PostEditSession(service: data, card: PostCard(content: content, version: v1))
        session.jobTimeout = .seconds(180)
        await session.load()
        await session.waitUntilIdle(timeout: .seconds(200))
        let measured = try #require(session.layerBoxes)
        LivePhone.log("v1 ölçüldü: \(measured.count) katman kutusu, render \(session.currentSlide?.renderedAssetId ?? "-")")
        let textLayer = try #require(session.editableLayers.first { $0.kind == .text })
        session.setText(textLayer.layerId, "Telefondan yeni başlık")
        await session.waitUntilIdle(timeout: .seconds(200))
        #expect(session.error == nil, "metin: \(session.error ?? "")")
        #expect(session.content.currentVersion?.version == 2)
        #expect(session.layers.first { $0.layerId == textLayer.layerId }?.text == "Telefondan yeni başlık")
        LivePhone.log("metin düzenlendi → v\(session.content.currentVersion?.version ?? 0)")

        let png = try #require(SampleImages.png(seed: "p5-slot-\(stamp)", width: 600, height: 750))
        #expect(session.targetSlot?.isEmpty == true)
        session.fillSlot(with: UploadFile(filename: "telefon.png", mimeType: "image/png", data: png, width: 600, height: 750))
        await session.waitUntilIdle(timeout: .seconds(200))
        #expect(session.error == nil, "yuva: \(session.error ?? "")")
        #expect(session.content.currentVersion?.version == 3)
        #expect(session.slots.allSatisfy { !$0.isEmpty })
        #expect(session.currentSlide?.renderedAssetId != nil)
        LivePhone.log("yuva dolduruldu → v3, render \(session.currentSlide?.renderedAssetId ?? "-")")

        session.nudge(textLayer.layerId, dx: 10, dy: 0)
        session.flushNudge(textLayer.layerId)
        await session.waitUntilIdle(timeout: .seconds(200))
        #expect(session.content.currentVersion?.version == 4)
        await session.undo()
        #expect(session.content.currentVersion?.version == 5)
        #expect(session.transform(of: textLayer.layerId) == .identity)
        LivePhone.log("kaydır + geri al → v5")

        #expect(session.canApprove)
        #expect(await session.approve())
        #expect(session.content.status == .approved)
        #expect(session.content.approval?.contentHash == session.content.currentVersion?.contentHash)
        LivePhone.log("hash ile onaylandı: \(session.content.approval?.contentHash.prefix(12) ?? "")…")

        // 4. Chat with an image and an @mention (requested alias), over the device token.
        let conversation = try await chat.createConversation(brandId: brand.id, title: "P5 telefon \(stamp)")
        cleanup.add {
            _ = try? await chat.archiveConversation(conversation.id)
            LivePhone.log("sohbet arşivlendi")
        }
        let progress = ProgressBox()
        let photo = try #require(SampleImages.png(seed: "p5-chat-\(stamp)", width: 300, height: 375))
        let asset = try await chat.uploadImage(UploadFile(filename: "urun.png", mimeType: "image/png", data: photo, width: 300, height: 375), brandId: brand.id) { progress.add($0) }
        #expect(progress.values.last == 1)

        let live = LiveStateBox()
        let consumer = Task {
            for await event in chat.observe(conversation.id) {
                if case .conversation(let s) = event { live.set(s) }
            }
        }
        defer { consumer.cancel() }
        var state = await live.wait(timeout: 30) { _ in true }
        #expect(state?.conversation.id == conversation.id)

        let text = LivePhone.runsAI
            ? "@urun görseline bak ve tek cümleyle ne gördüğünü yaz. Araç kullanma."
            : "@urun bu ürünün fotoğrafı."
        let sent = try await chat.send(OutgoingMessage(
            text: text, attachments: [OutgoingAttachment(assetId: asset.id, alias: "urun")],
            model: .haiku, effort: .low), to: conversation.id)
        #expect(sent.message.mentions?.first?.alias == "urun")
        #expect(sent.message.mentions?.first?.assetId == asset.id)
        #expect(sent.run.requestedModel == .haiku)
        LivePhone.log("mesaj gönderildi: @urun → \(asset.id), tur \(sent.run.id) (\(sent.run.status.rawValue))")

        if !LivePhone.runsAI {
            _ = try await chat.cancelRun(sent.run.id)
            return
        }

        // Wait for the reply (streamed text) on the conversation stream.
        state = await live.wait(timeout: 240) { state in
            state.activeRun == nil && state.messages.contains { $0.role == .assistant && $0.status != .streaming && !$0.plainText.isEmpty }
        }
        let reply = state?.messages.last { $0.role == .assistant }
        LivePhone.log("yanıt (\(reply?.status.rawValue ?? "-")): \(reply?.plainText.prefix(160) ?? "")")
        #expect(reply?.status == .complete)

        // 5. Consent: ask the agent to approve a draft post; allow the card from the phone.
        var draft = try await phone.send(Content.self, .post, "/api/contents", body: NewContent(brandId: brand.id, title: "Onay deneme \(stamp)", caption: "Onay kartı denemesi."))
        let draftId = draft.id
        cleanup.add {
            try? await phone.deleteContent(draftId)
            LivePhone.log("onay postu silindi")
        }
        _ = try await phone.send(ContentVersion.self, .post, "/api/contents/\(draft.id)/versions", body: NewVersion(slides: [NewSlide(html: html)]))
        _ = try await chat.send(OutgoingMessage(
            text: "“Onay deneme \(stamp)” başlıklı postu (id: \(draft.id)) approve_content aracıyla onayla. Başka bir şey yapma.",
            model: .haiku, effort: .low), to: conversation.id)
        state = await live.wait(timeout: 240) { state in
            state.messages.contains { $0.parts.contains { if case .consent(let c) = $0 { c.state == .pending } else { false } } }
                || (state.activeRun == nil && state.messages.last?.role == .assistant && state.messages.last?.status != .streaming)
        }
        guard let card = state?.messages.lazy.compactMap({ message -> (Message, ConsentPart)? in
            for part in message.parts { if case .consent(let c) = part, c.state == .pending { return (message, c) } }
            return nil
        }).first else {
            Issue.record("ajan onay kartı açmadı: \(state?.messages.last?.plainText.prefix(200) ?? "")")
            return
        }
        LivePhone.log("onay kartı: \(card.1.title) [\(card.1.tool)]")
        var tracker = ActivityNoticeTracker()
        #expect(tracker.waitingNotices(in: state!).first?.kind == .waitingOnYou)
        let decided = try await chat.decideConsent(conversationId: conversation.id, messageId: card.0.id, ConsentDecisionCreate(consentId: card.1.consentId, allow: true))
        #expect(decided.message.parts.contains { if case .consent(let c) = $0 { c.consentId == card.1.consentId && c.state == .allowed } else { false } })
        state = await live.wait(timeout: 180) { state in state.activeRun == nil }
        draft = try await data.content(draft.id)
        LivePhone.log("izin verildi → post durumu: \(draft.status.rawValue)")
        #expect(draft.status == .approved)
    }
}

/// Cleanup steps, run newest first after the test (awaited, unlike `defer`).
@MainActor
final class LiveCleanup {
    private var steps: [@MainActor () async -> Void] = []
    func add(_ step: @escaping @MainActor () async -> Void) { steps.append(step) }
    func run() async {
        for step in steps.reversed() { await step() }
        steps = []
    }
}

/// Latest conversation state from a stream consumer, polled by the test.
final class LiveStateBox: @unchecked Sendable {
    private let lock = NSLock()
    private var state: ConversationState?

    func set(_ new: ConversationState) { lock.withLock { state = new } }
    func get() -> ConversationState? { lock.withLock { state } }

    @MainActor func wait(timeout: Double, until done: (ConversationState) -> Bool) async -> ConversationState? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let current = get(), done(current) { return current }
            try? await Task.sleep(for: .milliseconds(250))
        }
        Issue.record("zaman aşımı (\(Int(timeout)) sn)")
        return get()
    }
}
