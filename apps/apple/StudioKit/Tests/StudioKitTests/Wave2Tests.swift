import Foundation
import Testing
@testable import StudioKit

@Suite("Wave 2B: StudioKit models, SlideLayers, API endpoints & SampleBackend")
struct Wave2Tests {
    @Test func assetKindsAndJobTypesMirrorWave1() throws {
        #expect(AssetKind.knownCases.contains(.document))
        #expect(AssetKind.knownCases.contains(.audio))
        #expect(AssetKind(rawValue: "document") == .document)
        #expect(AssetKind.document.label == "Belge (PDF)")

        #expect(JobType.imageGenerate.rawValue == "image.generate")
        #expect(JobType.imageGenerate.label == "AI görsel üretimi")
        #expect(JobType.schedulePublish.rawValue == "schedule.publish")
        #expect(JobType.schedulePublish.label == "Zamanlı yayın")

        #expect(Brand.slugify("MTM Agro / Venta Şirketi") == "mtm-agro-venta-sirketi")
    }

    @Test func socialAccountTokenVaultAndSchedulePermalinkDecode() throws {
        let json = """
        {
          "id": "acc-1",
          "brandId": "b-1",
          "platform": "linkedin",
          "handle": "MTM Agro",
          "externalId": "urn:li:person:123",
          "status": "connected",
          "createdAt": "2026-11-16T10:00:00.000Z",
          "updatedAt": "2026-11-16T10:00:00.000Z",
          "hasToken": true,
          "tokenExpiresAt": "2026-12-16T10:00:00.000Z",
          "tokenScopes": ["w_member_social"],
          "tokenHealth": "expiring_soon",
          "tokenCheckedAt": "2026-11-16T10:00:00.000Z"
        }
        """
        let account = try StudioJSON.decoder().decode(SocialAccount.self, from: Data(json.utf8))
        #expect(account.hasToken == true)
        #expect(account.tokenHealth == .expiringSoon)
        #expect(account.tokenHealth?.label == "Yakında doluyor")
        #expect(account.tokenScopes == ["w_member_social"])

        let scheduleJSON = """
        {
          "id": "s-1",
          "contentId": "c-1",
          "brandId": "b-1",
          "platform": "linkedin",
          "socialAccountId": "acc-1",
          "versionId": "v-1",
          "contentHash": "\(String(repeating: "a", count: 64))",
          "scheduledAt": "2026-11-30T09:00:00.000Z",
          "status": "published",
          "permalink": "https://www.linkedin.com/feed/update/urn:li:share:1/",
          "cancelledAt": null,
          "createdAt": "2026-11-16T10:00:00.000Z",
          "updatedAt": "2026-11-16T10:00:00.000Z"
        }
        """
        let schedule = try StudioJSON.decoder().decode(Schedule.self, from: Data(scheduleJSON.utf8))
        #expect(schedule.permalink == "https://www.linkedin.com/feed/update/urn:li:share:1/")

        let logJSON = """
        {
          "id": "l-1",
          "scheduleId": "s-1",
          "attempt": 1,
          "status": "succeeded",
          "externalPostId": "urn:li:share:1",
          "permalink": "https://www.linkedin.com/feed/update/urn:li:share:1/",
          "error": null,
          "startedAt": "2026-11-30T09:00:00.000Z",
          "finishedAt": "2026-11-30T09:00:04.000Z",
          "createdAt": "2026-11-30T09:00:04.000Z"
        }
        """
        let log = try StudioJSON.decoder().decode(PublishLog.self, from: Data(logJSON.utf8))
        #expect(log.status == .succeeded)
        #expect(log.permalink?.contains("linkedin.com") == true)
    }

    @Test func slideLayerScannerExtractsDiffsAndPatchesHTML() throws {
        let html = """
        <!doctype html><html lang="tr"><body>
        <p data-layer="eyebrow" data-type="text">YENİ ÜRÜN</p>
        <h1 data-layer="headline" data-type="text">Bor &amp; Çinko<br>Bir Arada</h1>
        <img data-layer="brand-logo" data-type="logo" src="/media/logo.png" alt="">
        <figure data-layer="hero-photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="Ürün fotoğrafı"></figure>
        <div data-layer="badge" data-type="shape" data-hidden></div>
        </body></html>
        """
        let layers = SlideLayerScanner.layers(inHTML: html)
        #expect(layers.map(\.layerId) == ["eyebrow", "headline", "brand-logo", "hero-photo", "badge"])
        #expect(layers[0].kind == .text)
        #expect(layers[0].text == "YENİ ÜRÜN")
        #expect(layers[1].text == "Bor & Çinko\nBir Arada")
        #expect(layers[2].kind == .logo)
        #expect(layers[2].src == "/media/logo.png")
        #expect(layers[3].kind == .slot)
        #expect(layers[3].slotState == .empty)
        #expect(layers[4].kind == .shape)
        #expect(layers[4].isHidden == true)

        var edited = layers
        edited[1].text = "Venta Borinc\nŞimdi Bayilerde"
        edited[4].isHidden = false
        let patches = SlideLayerScanner.diff(from: layers, to: edited)
        #expect(patches == [
            .setText(layer: "headline", text: "Venta Borinc\nŞimdi Bayilerde", slideIndex: 0),
            .setVisible(layer: "badge", visible: true, slideIndex: 0),
        ])
        #expect(patches[0].toJSONObject() == [
            "op": .string("set_text"),
            "layer": .string("headline"),
            "text": .string("Venta Borinc\nŞimdi Bayilerde"),
        ])
        #expect(patches[1].toJSONObject() == [
            "op": .string("set_visible"),
            "layer": .string("badge"),
            "visible": .bool(true),
        ])

        let patchedHTML = SlideLayerScanner.apply(patches: patches, toHTML: html)
        let rescanned = SlideLayerScanner.layers(inHTML: patchedHTML)
        #expect(rescanned[1].text == "Venta Borinc\nŞimdi Bayilerde")
        #expect(rescanned[4].isHidden == false)

        let slotFilled = SlideLayerScanner.fillSlot(inHTML: patchedHTML, slotId: "hero-photo", assetId: "asset-42")
        let filledSlots = SlotScanner.slots(inHTML: slotFilled)
        #expect(filledSlots.first?.state == .filled)
        #expect(SlideLayerScanner.layers(inHTML: slotFilled)[3].src == "/media/asset-42.jpg")
    }

    @Test func apiClientWave2EndpointsWireCorrectly() async throws {
        let host = uniqueHost()
        let now = "2026-11-16T10:00:00.000Z"
        let brandJSON = #"{"id":"b-new","name":"Yeni","slug":"yeni","defaultLanguage":"tr","status":"active","createdAt":"\#(now)","updatedAt":"\#(now)"}"#
        let profileJSON = ##"{"id":"bp-1","brandId":"b-new","version":1,"status":"approved","isCurrent":true,"tokens":{"primary":"#FF6A00"},"designRules":"kural","voice":"ton","createdAt":"\##(now)","updatedAt":"\##(now)","approvedAt":"\##(now)"}"##
        let accountJSON = #"{"id":"sa-1","brandId":"b-new","platform":"linkedin","handle":"Yeni","externalId":"urn:li:person:1","status":"connected","createdAt":"\#(now)","updatedAt":"\#(now)","hasToken":true,"tokenHealth":"valid"}"#
        let jobJSON = #"{"id":"j-1","type":"image.generate","status":"queued","payload":{},"brandId":"b-new","createdAt":"\#(now)","updatedAt":"\#(now)"}"#
        let discoverJSON = #"{"pages":[{"pageId":"1","pageName":"Sayfa","canPublish":true,"instagram":{"igUserId":"2","username":"sayfa"}}],"connectedAccounts":[\#(accountJSON)]}"#

        let session = StubURLProtocol.session(host: host) { req, _ in
            let p = req.url!.path
            if p == "/api/brands" { return .init(status: 201, body: Data(brandJSON.utf8)) }
            if p.contains("/profiles") { return .init(status: 200, body: Data(profileJSON.utf8)) }
            if p.hasSuffix("/meta/discover") { return .init(status: 200, body: Data(discoverJSON.utf8)) }
            if p.contains("/social-accounts") { return .init(status: 200, body: Data(accountJSON.utf8)) }
            return .init(status: 201, body: Data(jobJSON.utf8))
        }
        let api = APIClient(baseURL: URL(string: "http://\(host):8787")!, session: session)

        let created = try await api.createBrand(BrandCreate(name: "Yeni", slug: "yeni"))
        #expect(created.slug == "yeni")
        let current = try await api.currentBrandProfile(brandId: "b-new")
        #expect(current?.isCurrent == true)
        let meta = try await api.discoverMetaAccounts(MetaDiscoverInput(brandId: "b-new", userAccessToken: "EAA12345678"))
        #expect(meta.pages.count == 1)
        let li = try await api.connectLinkedInAccount(LinkedInConnectInput(brandId: "b-new", handle: "Yeni", personUrn: "urn:li:person:1", accessToken: "AQV12345678"))
        #expect(li.tokenHealth == .valid)
        _ = try await api.generateAIImage(brandId: "b-new", prompt: "Ürün çekimi", aspectRatio: "4:5", imageSize: "2K", referenceAssetIds: ["a-1"], preserveProductLabel: true)
        _ = try await api.fillSlotAndRender(contentId: "post-01", slotId: "photo", assetId: "a-1")
        _ = try await api.exportContent(contentId: "post-01", format: "pdf")

        let paths = StubURLProtocol.recorded(host: host).map { "\($0.0.httpMethod!) \($0.0.url!.path)" }
        #expect(paths == [
            "POST /api/brands",
            "GET /api/brands/b-new/profiles/current",
            "POST /api/social-accounts/meta/discover",
            "POST /api/social-accounts/linkedin/connect",
            "POST /api/jobs",
            "POST /api/jobs",
            "POST /api/jobs",
        ])
    }

    @Test func sampleBackendSimulatesSlotFillLayerPatchAIImageAndBrandProfiles() async throws {
        let backend = SampleBackend(uploadDelay: .zero)

        // Slot fill moves post-01 from empty slot to filled version v2 ready for approval
        let before = try await backend.version(contentId: "post-01", version: 1)
        #expect(SlotScanner.slots(in: before.slides).first?.isEmpty == true)

        _ = try await backend.fillSlotAndRender(contentId: "post-01", slotId: "photo", assetId: "asset-tarla")
        let updatedContent = try await backend.content("post-01")
        #expect(updatedContent.currentVersion?.version == 2)
        let v2 = try await backend.version(contentId: "post-01", version: 2)
        #expect(SlotScanner.slots(in: v2.slides).first?.state == .filled)
        #expect(v2.slides.first?.renderedAssetId == "asset-tarla")

        // Patch layers creates v3
        _ = try await backend.patchLayersAndRender(contentId: "post-01", patches: [.setText(layer: "title", text: "YENİ BAŞLIK")])
        let versions = try await backend.versions(contentId: "post-01")
        #expect(versions.map(\.version) == [3, 2, 1])
        let v3 = try await backend.version(contentId: "post-01", version: 3)
        #expect(SlideLayerScanner.layers(in: v3.slides).first { $0.layerId == "title" }?.text == "YENİ BAŞLIK")

        // AI image generation creates generated asset
        let aiJob = try await backend.generateAIImage(
            brandId: SampleData.mtm, prompt: "Güneşli tarlada gübre torbası",
            aspectRatio: "4:5", imageSize: "2K", referenceAssetIds: ["asset-tarla"],
            preserveProductLabel: true, targetContentId: nil, targetSlotId: nil
        )
        let aiAssetId = try #require(aiJob.output?["assetId"]?.stringValue)
        let assets = try await backend.assets(brandId: SampleData.mtm, kind: .image)
        #expect(assets.contains { $0.id == aiAssetId && $0.source == .generated })

        // Brand profile approval switches current version
        let approved = try await backend.approveBrandProfile(brandId: SampleData.mtm, version: 2)
        #expect(approved.isCurrent == true)
        #expect(try await backend.currentBrandProfile(brandId: SampleData.mtm)?.version == 2)
    }
}
