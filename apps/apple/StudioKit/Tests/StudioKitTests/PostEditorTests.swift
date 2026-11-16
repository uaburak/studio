import CoreGraphics
import Foundation
import Testing
@testable import StudioKit

@Suite("Post editor: design patches, geometry, captions, filters, exports")
struct PostEditorTests {
    @Test func designPatchesUseDesignKitOpNamesWithTheSlideIndex() {
        #expect(DesignPatch(slide: 1, .setText(layer: "headline", text: "Yeni\nsatır")).toJSONObject() == [
            "slide": .number(1), "op": .string("setText"), "layer": .string("headline"), "text": .string("Yeni\nsatır"),
        ])
        #expect(DesignPatch(slide: 0, .setVisibility(layer: "badge", hidden: true)).toJSONObject() == [
            "slide": .number(0), "op": .string("setVisibility"), "layer": .string("badge"), "hidden": .bool(true),
        ])
        // Translate rounds to 0.1 px; scale 1 and zero translate remove the properties.
        #expect(DesignPatch(slide: 0, .transform(layer: "logo", translate: CGPoint(x: 12.04, y: -8.26), scale: 1.25)).toJSONObject() == [
            "slide": .number(0), "op": .string("transform"), "layer": .string("logo"),
            "translate": .object(["x": .number(12), "y": .number(-8.3)]), "scale": .number(1.25),
        ])
        #expect(DesignPatch(slide: 0, .transform(layer: "logo", translate: .zero, scale: 1)).toJSONObject() == [
            "slide": .number(0), "op": .string("transform"), "layer": .string("logo"), "translate": .null, "scale": .null,
        ])
        #expect(DesignPatch(slide: 2, .fillSlot(layer: "photo", src: "/media/a.png")).toJSONObject()["src"] == .string("/media/a.png"))
        #expect(DesignPatch(slide: 0, .clearSlot(layer: "photo")).toJSONObject() == [
            "slide": .number(0), "op": .string("clearSlot"), "layer": .string("photo"),
        ])
        #expect(DesignPatch.mediaSource(assetId: "01a-b", mimeType: "image/png") == "/media/01a-b.png")
        #expect(DesignPatch.mediaSource(assetId: "x", mimeType: nil) == "/media/x.jpg")

        // The older layer patch type now speaks the same wire format.
        #expect(SlideLayerPatch.setVisible(layer: "badge", visible: true, slideIndex: 0).toJSONObject() == [
            "slide": .number(0), "op": .string("setVisibility"), "layer": .string("badge"), "hidden": .bool(false),
        ])
    }

    @Test func requestPayloadCarriesEditsExportsAndSlides() {
        let request = ContentRenderRequest(
            version: 3, format: .png, patches: [DesignPatch(slide: 0, .setText(layer: "a", text: "b"))],
            slotAssignments: ["photo": "asset-1"], slides: [0, 2], force: true, note: "Elle")
        let payload = request.payload
        #expect(payload["format"] == .string("png"))
        #expect(payload["version"] == .number(3))
        #expect(payload["slides"] == .array([.number(0), .number(2)]))
        #expect(payload["force"] == .bool(true))
        #expect(payload["note"] == .string("Elle"))
        #expect(payload["slotAssignments"] == .object(["photo": .string("asset-1")]))
        #expect(payload["patches"]?.arrayValue?.count == 1)
        #expect(ContentRenderRequest().payload == ["format": .string("jpeg")])

        let output = ContentRenderOutput([
            "version": .number(4), "versionId": .string("v4"), "renderedAssetIds": .array([.string("r1"), .null]),
            "pngAssetIds": .array([.null, .string("p2")]), "pdfAssetId": .string("pdf"), "unchanged": .bool(true),
        ])
        #expect(output.version == 4 && output.versionId == "v4" && output.pdfAssetId == "pdf" && output.unchanged)
        #expect(output.renderedAssetIds == ["r1", nil])
        #expect(output.pngAssetIds == [nil, "p2"])
    }

    @Test func layerTransformParsesTheEditorsInlineProperties() {
        let t = LayerTransform(style: "position:absolute; left:72px; translate: 12px -8.5px; scale: 1.2")
        #expect(t.translate == CGPoint(x: 12, y: -8.5))
        #expect(t.scale == 1.2)
        #expect(LayerTransform(style: "left:0").translate == .zero)
        #expect(LayerTransform(style: nil) == .identity)
        #expect(LayerTransform(style: "scale: 0.5 0.5").scale == 0.5)

        let html = #"<main data-artboard><h1 data-layer="headline" data-type="text" style="left:10px; translate: 4px 6px">A</h1></main>"#
        let layer = SlideLayerScanner.layers(inHTML: html).first
        #expect(layer?.transform.translate == CGPoint(x: 4, y: 6))
    }

    @Test func canvasGeometryMapsBetweenTheViewAndTheArtboard() {
        let geometry = SlideCanvasGeometry.fitting(artboard: CGSize(width: 1080, height: 1350), in: CGRect(x: 0, y: 0, width: 600, height: 600))
        #expect(geometry.imageRect == CGRect(x: 60, y: 0, width: 480, height: 600))
        #expect(abs(geometry.scale - 480.0 / 1080.0) < 0.0001)
        let view = geometry.viewRect(CGRect(x: 108, y: 135, width: 540, height: 270))
        #expect(view == CGRect(x: 108, y: 60, width: 240, height: 120))
        let point = geometry.artboardPoint(CGPoint(x: 300, y: 300))
        #expect(abs(point.x - 540) < 0.001 && abs(point.y - 675) < 0.001)
        #expect(geometry.artboardDelta(CGSize(width: 48, height: -24)) == CGSize(width: 108, height: -54))

        let boxes = [
            SlideLayerBox(id: "bg", type: "shape", role: "background", x: 0, y: 0, w: 1080, h: 1350),
            SlideLayerBox(id: "copy", type: "group", x: 72, y: 900, w: 900, h: 300),
            SlideLayerBox(id: "headline", type: "text", parent: "copy", x: 72, y: 900, w: 600, h: 120),
            SlideLayerBox(id: "hidden", type: "text", x: 72, y: 900, w: 10, h: 10, visible: false),
        ]
        #expect(SlideCanvasGeometry.hitTest(CGPoint(x: 100, y: 950), in: boxes)?.id == "headline")
        #expect(SlideCanvasGeometry.hitTest(CGPoint(x: 800, y: 1100), in: boxes)?.id == "copy")
        #expect(SlideCanvasGeometry.hitTest(CGPoint(x: 10, y: 10), in: boxes)?.id == "bg")
        #expect(SlideCanvasGeometry.hitTest(CGPoint(x: 100, y: 950), in: boxes, skipping: ["headline"])?.id == "copy")
    }

    @Test func movesAndCornerResizesBecomeAbsoluteTransforms() {
        let current = LayerTransform(translate: CGPoint(x: 10, y: 0), scale: 1)
        #expect(LayerTransformMath.moved(current, by: CGSize(width: 5, height: -3)) == LayerTransform(translate: CGPoint(x: 15, y: -3), scale: 1))

        // Doubling a 100×50 box with its top-left fixed: centre moves by half the growth.
        let box = CGRect(x: 100, y: 100, width: 100, height: 50)
        let resized = LayerTransformMath.resized(current, box: box, factor: 2)
        #expect(resized.scale == 2)
        #expect(resized.translate == CGPoint(x: 60, y: 25))
        let preview = LayerTransformMath.previewBox(box, from: current, to: resized)
        #expect(preview == CGRect(x: 100, y: 100, width: 200, height: 100))
        #expect(LayerTransformMath.resized(current, box: box, factor: 1000).scale == 20)
    }

    @Test func designPatchesApplyLocallyForTheSampleBackend() {
        let html = #"<body><h1 data-layer="title" data-type="text" style="left:0">ESKİ</h1><figure data-layer="photo" data-type="slot" data-slot-state="empty"></figure></body>"#
        var out = SlideLayerScanner.apply(designPatch: DesignPatch(slide: 0, .setText(layer: "title", text: "YENİ")), toHTML: html)
        out = SlideLayerScanner.apply(designPatch: DesignPatch(slide: 0, .transform(layer: "title", translate: CGPoint(x: 5, y: 6), scale: 1.5)), toHTML: out)
        out = SlideLayerScanner.apply(designPatch: DesignPatch(slide: 0, .fillSlot(layer: "photo", src: "/media/p.png")), toHTML: out)
        let layers = SlideLayerScanner.layers(inHTML: out)
        #expect(layers[0].text == "YENİ")
        #expect(layers[0].transform == LayerTransform(translate: CGPoint(x: 5, y: 6), scale: 1.5))
        #expect(layers[1].slotState == .filled)
        #expect(layers[1].src == "/media/p.png")
        let cleared = SlideLayerScanner.apply(designPatch: DesignPatch(slide: 0, .clearSlot(layer: "photo")), toHTML: out)
        #expect(SlideLayerScanner.layers(inHTML: cleared)[1].slotState == .empty)
        let hidden = SlideLayerScanner.apply(designPatch: DesignPatch(slide: 0, .setVisibility(layer: "title", hidden: true)), toHTML: out)
        #expect(SlideLayerScanner.layers(inHTML: hidden)[0].isHidden)
    }

    @Test func captionLimitsPerPlatform() {
        let caption = String(repeating: "a", count: 2_190) + " #bir #iki 🌾"
        let usage = CaptionLimits.usage(caption: caption, platforms: [.instagram, .linkedin])
        #expect(usage.map(\.platform) == [.instagram, .linkedin])
        #expect(usage[0].characters == caption.count)
        #expect(usage[0].limit == 2_200 && usage[0].isOverLimit)
        #expect(usage[1].limit == 3_000 && !usage[1].isOverLimit)
        #expect(usage[0].hashtags == 2)
        #expect(usage[0].label == "2.202 / 2.200")
        let tags = (1...31).map { "#t\($0)" }.joined(separator: " ")
        #expect(CaptionLimits.usage(caption: tags, platforms: [.instagram])[0].isOverLimit)
        #expect(CaptionLimits.usage(caption: "", platforms: [])[0].platform == .instagram)
    }

    @Test func postListFilterSeparatesApprovedScheduledAndPublished() {
        #expect(PostListFilter.allCases.map(\.label) == ["Tümü", "Hazır", "Görsel bekliyor", "Onaylandı", "Zamanlandı", "Yayınlandı"])
        #expect(PostListFilter.approved.matches(.approved) && !PostListFilter.approved.matches(.scheduled))
        #expect(PostListFilter.scheduled.matches(.publishing))
        #expect(PostListFilter.published.matches(.published))
        #expect(PostListFilter.imageNeeded.matches(.imageUploaded))
        #expect(!PostListFilter.ready.matches(.failed) && PostListFilter.all.matches(.failed))
    }

    @Test func slideLayoutsDecodeAndStayOutOfTheHash() throws {
        let json = #"{"html":"<p>a</p>","width":1080,"height":1350,"renderedAssetId":"r1","layers":[{"id":"headline","type":"text","role":"headline","parent":null,"x":72,"y":120.5,"w":600,"h":140,"visible":true}]}"#
        let slide = try StudioJSON.decoder().decode(Slide.self, from: Data(json.utf8))
        #expect(slide.layers?.first?.rect == CGRect(x: 72, y: 120.5, width: 600, height: 140))
        let older = try StudioJSON.decoder().decode(Slide.self, from: Data(#"{"html":"<p>a</p>","width":1080,"height":1350,"renderedAssetId":null}"#.utf8))
        #expect(older.layers == nil)
        var bare = slide
        bare.layers = nil
        bare.renderedAssetId = nil
        #expect(ContentHash.compute([slide]) == ContentHash.compute([bare]))
    }

    @Test func apiClientEditorEndpointsWireCorrectly() async throws {
        let host = uniqueHost()
        let now = "2026-11-16T10:00:00.000Z"
        let content = #"{"id":"c2","brandId":"b1","type":"post","title":"Kopya","brief":"","status":"draft","targetPlatforms":["instagram"],"caption":"","currentVersion":null,"approval":null,"createdAt":"\#(now)","updatedAt":"\#(now)"}"#
        let version = #"{"id":"v3","contentId":"c1","version":3,"origin":"manual_edit","contentHash":"\#(String(repeating: "a", count: 64))","slideCount":1,"note":"v1 geri yüklendi.","jobId":null,"createdAt":"\#(now)","updatedAt":"\#(now)","slides":[{"html":"x","width":1080,"height":1350,"renderedAssetId":"r1","layers":null}]}"#
        let job = #"{"id":"j1","type":"content.render","status":"queued","payload":{},"contentId":"c1","createdAt":"\#(now)","updatedAt":"\#(now)"}"#
        let session = StubURLProtocol.session(host: host) { req, _ in
            let p = req.url!.path
            if req.httpMethod == "DELETE" { return .init(status: 204, body: Data()) }
            if p.hasSuffix("/duplicate") { return .init(status: 201, body: Data(content.utf8)) }
            if p.hasSuffix("/restore") { return .init(status: 201, body: Data(version.utf8)) }
            return .init(status: 201, body: Data(job.utf8))
        }
        let api = APIClient(baseURL: URL(string: "http://\(host):8787")!, session: session)
        try await api.deleteContent("c1")
        #expect(try await api.duplicateContent("c1").title == "Kopya")
        #expect(try await api.restoreContentVersion(contentId: "c1", version: 1).note == "v1 geri yüklendi.")
        _ = try await api.renderContent(contentId: "c1", ContentRenderRequest(version: 1, patches: [DesignPatch(slide: 0, .setText(layer: "h", text: "t"))]))
        let base = Content(id: "c1", brandId: "b1", type: .post, title: "Başlık", status: .draft, targetPlatforms: [.instagram], caption: "", currentVersion: nil, createdAt: .now, updatedAt: .now)
        _ = try await api.requestRevision(of: base, baseVersion: 2, instructions: "Başlığı küçült")

        let recorded = StubURLProtocol.recorded(host: host)
        #expect(recorded.map { "\($0.0.httpMethod!) \($0.0.url!.path)" } == [
            "DELETE /api/contents/c1",
            "POST /api/contents/c1/duplicate",
            "POST /api/contents/c1/versions/1/restore",
            "POST /api/jobs",
            "POST /api/jobs",
        ])
        let render = try JSONSerialization.jsonObject(with: recorded[3].1) as? [String: Any]
        #expect(render?["type"] as? String == "content.render")
        let renderPayload = render?["payload"] as? [String: Any]
        #expect((renderPayload?["patches"] as? [[String: Any]])?.first?["op"] as? String == "setText")
        let revise = try JSONSerialization.jsonObject(with: recorded[4].1) as? [String: Any]
        let revisePayload = revise?["payload"] as? [String: Any]
        #expect(revise?["type"] as? String == "content.generate")
        #expect(revisePayload?["baseVersion"] as? Int == 2)
        #expect(revisePayload?["instructions"] as? String == "Başlığı küçült")
    }

    @Test func sampleBackendEditsRestoresDuplicatesAndDeletes() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        let before = try await backend.content("post-02a")
        let ref = try #require(before.currentVersion)
        let base = try await backend.version(contentId: "post-02a", version: ref.version)

        // An edit stores a manual_edit version with a render and measured boxes for the changed slide.
        let titleId = try #require(SlideLayerScanner.layers(in: base.slides).first { $0.kind == .text }?.layerId)
        let job = try await backend.render(contentId: "post-02a", ContentRenderRequest(version: ref.version, patches: [
            DesignPatch(slide: 0, .setText(layer: titleId, text: "DÜZENLENDİ")),
        ]))
        #expect(job.status == .succeeded)
        let edited = try await backend.version(contentId: "post-02a", version: ref.version + 1)
        #expect(edited.origin == .manualEdit)
        #expect(SlideLayerScanner.layers(in: edited.slides).first { $0.layerId == titleId }?.text == "DÜZENLENDİ")
        #expect(edited.slides[0].renderedAssetId != nil)
        #expect(edited.slides[0].layers?.contains { $0.id == titleId } == true)

        // Restoring the base copies it exactly (same hash).
        let restored = try await backend.restoreVersion(contentId: "post-02a", version: ref.version)
        #expect(restored.version == ref.version + 2)
        #expect(restored.contentHash == base.contentHash)

        // AI revision completes with an ai_edit version.
        let revision = try await backend.requestRevision(of: try await backend.content("post-02a"), baseVersion: restored.version, instructions: "Daha sade")
        #expect(revision.status == .succeeded)
        #expect(try await backend.content("post-02a").currentVersion?.version == restored.version + 1)

        // Duplicate, then delete the copy.
        let copy = try await backend.duplicateContent("post-02a")
        #expect(copy.title.hasSuffix("(kopya)"))
        #expect(copy.currentVersion?.version == 1)
        try await backend.deleteContent(copy.id)
        await #expect(throws: StudioAPIError.self) { _ = try await backend.content(copy.id) }
    }

    @Test func exporterProducesJpegPngAndPdfFiles() async throws {
        let backend = SampleBackend(uploadDelay: .zero)
        let content = try await backend.content("post-02a")
        let version = try await backend.version(contentId: "post-02a", version: try #require(content.currentVersion).version)
        let exporter = PostExporter(service: backend, interval: .milliseconds(5))

        let jpegs = try await exporter.export(content: content, version: version, format: .jpeg)
        #expect(jpegs.count == version.slides.count)
        #expect(jpegs.first?.filename.hasSuffix(".jpg") == true)
        #expect(jpegs.allSatisfy { !$0.data.isEmpty })

        let pngs = try await exporter.export(content: content, version: version, format: .png, slides: [0])
        #expect(pngs.count == 1)
        #expect(pngs[0].filename.hasSuffix(".png"))

        let pdf = try await exporter.export(content: content, version: version, format: .pdf)
        #expect(pdf.count == 1)
        #expect(String(decoding: pdf[0].data.prefix(5), as: UTF8.self) == "%PDF-")
        #expect(PostExporter.baseName(title: "Venta Borinç", version: 3) == "venta-borinc-v3")
    }
}
