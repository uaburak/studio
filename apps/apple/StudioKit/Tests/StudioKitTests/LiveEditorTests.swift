import Foundation
import Testing
@testable import StudioKit

/// The post editor end to end against a LOCAL API with a connected Mac worker (Chromium).
/// Skipped unless `STUDIO_LIVE_EDITOR_API_URL` is set (e.g. http://127.0.0.1:8797). It
/// creates its own brand and post. `STUDIO_LIVE_EDITOR_AI=1` also runs one real AI
/// revision ("Neyi değiştireyim?"), which spends one model call.
enum LiveEditor {
    static var baseURL: URL? {
        guard let raw = ProcessInfo.processInfo.environment["STUDIO_LIVE_EDITOR_API_URL"], let url = URL(string: raw),
              url.host == "127.0.0.1" || url.host == "localhost" else { return nil }
        return url
    }

    static var runsAI: Bool { ProcessInfo.processInfo.environment["STUDIO_LIVE_EDITOR_AI"] == "1" }

    /// `packages/design-kit/test/fixtures/slides/<name>` in this repository.
    static func fixture(_ name: String) throws -> String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() } // Tests/StudioKitTests/<file> -> apps/apple/StudioKit -> apps
        let file = url.deletingLastPathComponent().appendingPathComponent("packages/design-kit/test/fixtures/slides/\(name)")
        return try String(contentsOf: file, encoding: .utf8)
    }
}

@Suite("Live post editor", .enabled(if: LiveEditor.baseURL != nil), .serialized)
struct LiveEditorTests {
    private struct NewContent: Encodable { var brandId: String; var type = "post"; var title: String; var targetPlatforms = ["instagram"]; var caption: String }
    private struct NewVersion: Encodable { var origin = "generated"; var slides: [Slide] }
    private struct Slide: Encodable { var html: String; var width = 1080; var height = 1350 }

    private func log(_ line: String) { print("[canlı editör] \(line)") }

    @Test func editRenderFillApproveAndExport() async throws {
        let client = APIClient(baseURL: LiveEditor.baseURL!)
        let service = RemoteStudioDataService(client: client)
        let stamp = Int(Date().timeIntervalSince1970)
        let brand = try await service.createBrand(BrandCreate(name: "P1 Canlı Editör \(stamp)", slug: "p1-canli-editor-\(stamp)"))
        var content = try await client.send(
            Content.self, .post, "/api/contents",
            body: NewContent(brandId: brand.id, title: "Venta Borinç canlı", caption: "Bor ve çinko bir arada. #venta #borinc"))
        let html = try LiveEditor.fixture("image-slot.html")
        let v1 = try await client.send(ContentVersion.self, .post, "/api/contents/\(content.id)/versions", body: NewVersion(slides: [Slide(html: html)]))
        log("post \(content.id) v\(v1.version) oluşturuldu")

        // 1. First render: JPEG + measured layer boxes on v1.
        var job = try await service.render(contentId: content.id, ContentRenderRequest(version: 1))
        job = try await service.waitForJob(job.id, timeout: .seconds(120))
        let rendered1 = try await service.version(contentId: content.id, version: 1)
        let render1 = try #require(rendered1.slides[0].renderedAssetId)
        let boxes = try #require(rendered1.slides[0].layers)
        let headline = try #require(boxes.first { $0.id == "headline" })
        #expect(headline.w > 0 && headline.h > 0)
        log("v1 render \(render1), \(boxes.count) katman kutusu (headline \(headline.rect))")

        // 2. Edit a text layer and move it: new manual_edit version, new render.
        let moved = LayerTransformMath.moved(.identity, by: CGSize(width: 24, height: -12))
        job = try await service.render(contentId: content.id, ContentRenderRequest(version: 1, patches: [
            DesignPatch(slide: 0, .setText(layer: "headline", text: "Yeni başlık")),
            DesignPatch(slide: 0, .transform(layer: "headline", translate: moved.translate, scale: moved.scale)),
        ]))
        job = try await service.waitForJob(job.id, timeout: .seconds(120))
        let out2 = ContentRenderOutput(job.output)
        let v2 = try await service.version(contentId: content.id, version: try #require(out2.version))
        #expect(v2.version == 2 && v2.origin == .manualEdit)
        let render2 = try #require(v2.slides[0].renderedAssetId)
        #expect(render2 != render1)
        #expect(SlideLayerScanner.layers(in: v2.slides).first { $0.layerId == "headline" }?.text == "Yeni başlık")
        let movedBox = try #require(v2.slides[0].layers?.first { $0.id == "headline" })
        #expect(abs(movedBox.x - (headline.x + 24)) < 1.5 && abs(movedBox.y - (headline.y - 12)) < 1.5)
        log("v2 render \(render2), headline \(movedBox.rect)")

        // 3. Fill the image slot with an uploaded picture.
        let png = try #require(SampleImages.png(seed: "canli-editor", width: 800, height: 600))
        let asset = try await service.uploadImage(UploadFile(filename: "tarla.png", mimeType: "image/png", data: png, width: 800, height: 600), brandId: brand.id) { _ in }
        job = try await service.render(contentId: content.id, ContentRenderRequest(version: 2, patches: [
            DesignPatch(slide: 0, .fillSlot(layer: "field-photo", src: DesignPatch.mediaSource(assetId: asset.id, mimeType: asset.mimeType))),
        ]))
        job = try await service.waitForJob(job.id, timeout: .seconds(120))
        let v3 = try await service.version(contentId: content.id, version: try #require(ContentRenderOutput(job.output).version))
        #expect(SlotScanner.slots(in: v3.slides).first?.state == .filled)
        #expect(v3.slides[0].renderedAssetId != render2)
        log("v3 yuva dolu (\(asset.id)), render \(v3.slides[0].renderedAssetId ?? "-")")

        // 4. Approve by the hash of the version we looked at.
        content = try await service.content(content.id)
        let hash = ContentHash.compute(v3.slides)
        #expect(content.currentVersion?.contentHash == hash)
        content = try await service.approve(contentId: content.id, hash: hash)
        #expect(content.status == .approved)
        log("onaylandı: \(hash.prefix(12))…")

        // 5. Export JPEG, PNG and PDF files.
        let exporter = PostExporter(service: service)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("studio-live-export-\(stamp)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for format in PostExportFormat.allCases {
            let files = try await exporter.export(content: content, version: v3, format: format)
            for file in files {
                let url = folder.appendingPathComponent(file.filename)
                try file.data.write(to: url)
                log("dışa aktarıldı: \(url.path) (\(file.data.count) bayt)")
            }
            let head = [UInt8](try #require(files.first).data.prefix(4))
            switch format {
            case .jpeg: #expect(head.prefix(2) == [0xFF, 0xD8])
            case .png: #expect(head == [0x89, 0x50, 0x4E, 0x47])
            case .pdf: #expect(head == Array("%PDF".utf8))
            }
        }

        // 6. Restore v1 (exact copy, same hash, renders reused) and duplicate + delete.
        let restored = try await service.restoreVersion(contentId: content.id, version: 1)
        #expect(restored.contentHash == v1.contentHash)
        #expect(restored.slides[0].renderedAssetId == render1)
        #expect(try await service.content(content.id).status == .draft)
        let copy = try await service.duplicateContent(content.id)
        #expect(copy.currentVersion?.contentHash == restored.contentHash)
        try await service.deleteContent(copy.id)
        log("v\(restored.version) = v1 geri yüklendi; kopya oluşturulup silindi")

        // 7. Optional: one real AI revision of the restored version.
        guard LiveEditor.runsAI else { return }
        let current = try await service.content(content.id)
        job = try await service.requestRevision(of: current, baseVersion: restored.version, instructions: "Başlığı biraz küçült, geri kalan her şey aynı kalsın.")
        job = try await service.waitForJob(job.id, timeout: .seconds(900), interval: .seconds(2)) { [self] progress in
            if let message = progress.progressMessage { log("AI: \(message)") }
        }
        let revised = try await service.version(contentId: content.id, version: try #require(job.output?["version"]?.doubleValue.map { Int($0) }))
        #expect(revised.origin == .aiEdit)
        #expect(revised.slides[0].renderedAssetId != nil)
        #expect(revised.slides[0].layers?.isEmpty == false)
        log("AI düzenleme v\(revised.version): \(revised.note ?? "")")
    }
}
