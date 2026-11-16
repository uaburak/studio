import AppKit
import StudioKit
import Testing
@testable import StudioMac

@MainActor
private func makeApp() async -> AppModel {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.editor.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    app.posts.month = MonthKey(year: 2026, month: 11)
    await app.posts.load()
    return app
}

@MainActor
private func waitUntil(_ condition: () -> Bool, timeout: Double = 4) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(15)) }
}

@MainActor
private func openDetail(_ app: AppModel, _ id: EntityID) async throws -> PostDetailModel {
    let card = try #require(app.posts.card(id))
    let detail = PostDetailModel(app: app, card: card, sourceFrame: .zero)
    app.detail = detail
    // The sample versions have no measured boxes: opening measures them once.
    await waitUntil { !detail.versionSummaries.isEmpty && detail.activity == .idle && detail.layerBoxes != nil }
    return detail
}

@MainActor
private func waitForVersion(_ detail: PostDetailModel, _ version: Int) async {
    await waitUntil { detail.content.currentVersion?.version == version && detail.activity == .idle && detail.activeVersion?.version == version }
}

@Suite("Mac posts screen and post editor (sample backend, no windows)")
@MainActor
struct PostEditorMacTests {
    @Test func filtersCountSelectionAndMonthNavigation() async throws {
        let app = await makeApp()
        let posts = app.posts
        let counts = posts.counts
        #expect(counts[.all] == 12)
        #expect(counts[.approved] == 2)
        #expect(counts[.scheduled] == 1)
        #expect(counts[.published] == 0)
        #expect(counts[.imageNeeded] == 6)
        posts.filter = .approved
        #expect(posts.visibleCards.allSatisfy { $0.state == .approved })
        posts.filter = .all

        posts.moveSelection(by: 1)
        let first = posts.visibleCards[0].id
        #expect(posts.selectedId == first)
        posts.moveSelection(by: 4)
        #expect(posts.selectedId == posts.visibleCards[4].id)
        posts.moveSelection(by: -100)
        #expect(posts.selectedId == first)
        #expect(posts.selectedCard?.id == first)

        posts.showNextMonth()
        #expect(posts.month == MonthKey(year: 2026, month: 12))
        #expect(posts.visibleCards.isEmpty)
        #expect(posts.selectedId == nil)
        posts.showAdjacentMonthWithPosts(-1)
        #expect(posts.month == MonthKey(year: 2026, month: 11))
    }

    @Test func duplicateAndDeleteWithTheScheduledGuard() async throws {
        let app = await makeApp()
        let original = try #require(app.posts.card("post-02a"))
        let copy = try #require(await app.posts.duplicate(original))
        #expect(copy.title == "Doğru saklama rehberi (kopya)")
        #expect(app.posts.selectedId == copy.id)
        let copyCard = try #require(app.posts.card(copy.id))
        #expect(copyCard.version?.contentHash == original.version?.contentHash)

        await app.posts.delete(copyCard)
        #expect(app.posts.card(copy.id) == nil)
        #expect(app.posts.error == nil)

        let scheduled = try #require(app.posts.card("post-12a"))
        #expect(PostsModel.deletionBlocker(scheduled) != nil)
        await app.posts.delete(scheduled)
        #expect(app.posts.card("post-12a") != nil)
        #expect(app.posts.error?.contains("Zamanlanmış") == true)
    }

    @Test func editsBecomeVersionsAndUndoRedoRestoreThem() async throws {
        let app = await makeApp()
        let detail = try await openDetail(app, "post-02a")
        let v1 = try #require(detail.activeVersion)
        #expect(detail.canEdit)
        #expect(detail.layerBoxes?.contains { $0.id == "title" } == true)

        // Click-select on the canvas resolves to the title box.
        let titleBox = try #require(detail.layerBoxes?.first { $0.id == "title" })
        let hit = SlideCanvasGeometry.hitTest(CGPoint(x: titleBox.rect.midX, y: titleBox.rect.midY), in: detail.layerBoxes ?? [])
        #expect(hit?.id == "title")
        detail.select(layer: "title")
        #expect(detail.tab == .edit)

        detail.setText("title", "SAKLAMA REHBERİ")
        await waitForVersion(detail, 2)
        #expect(detail.layers.first { $0.layerId == "title" }?.text == "SAKLAMA REHBERİ")
        #expect(detail.activeVersion?.origin == .manualEdit)
        #expect(detail.currentSlide?.renderedAssetId != nil)
        let v2Hash = try #require(detail.activeVersion?.contentHash)
        #expect(detail.canUndo)
        #expect(detail.undoManager.undoActionName == "Metni değiştir")

        detail.undo()
        await waitForVersion(detail, 3)
        #expect(detail.activeVersion?.contentHash == v1.contentHash)
        #expect(detail.canRedo)

        detail.redo()
        await waitForVersion(detail, 4)
        #expect(detail.activeVersion?.contentHash == v2Hash)

        // Move and corner-resize write the editor transform.
        detail.move("title", by: CGSize(width: 12, height: -6))
        await waitForVersion(detail, 5)
        #expect(detail.transform(of: "title") == LayerTransform(translate: CGPoint(x: 12, y: -6), scale: 1))
        detail.resize("title", factor: 2)
        await waitForVersion(detail, 6)
        #expect(detail.transform(of: "title").scale == 2)

        // Hide, then the inspector's reset puts the layer back where the design had it.
        detail.setHidden("title", true)
        await waitForVersion(detail, 7)
        #expect(detail.layers.first { $0.layerId == "title" }?.isHidden == true)
        detail.resetTransform("title")
        await waitForVersion(detail, 8)
        #expect(detail.transform(of: "title") == .identity)
    }

    @Test func editsWhileRenderingQueueOnTheNewVersion() async throws {
        let app = await makeApp()
        let detail = try await openDetail(app, "post-02a")
        detail.setText("title", "BİR")
        detail.setText("eyebrow", "İKİ")
        await waitUntil { detail.activity == .idle && (detail.content.currentVersion?.version ?? 0) >= 3 }
        await waitForVersion(detail, 3)
        #expect(detail.layers.first { $0.layerId == "title" }?.text == "BİR")
        #expect(detail.layers.first { $0.layerId == "eyebrow" }?.text == "İKİ")
    }

    @Test func slotsFillFromPickedOrDroppedPictures() async throws {
        let app = await makeApp()
        let detail = try await openDetail(app, "post-01")
        #expect(detail.card.needsImage)
        #expect(detail.dropTarget(at: nil) == "photo")
        let slotBox = try #require(detail.layerBoxes?.first { $0.id == "photo" })
        #expect(detail.dropTarget(at: CGPoint(x: slotBox.rect.midX, y: slotBox.rect.midY)) == "photo")

        let image = try ImageImport.from(data: try #require(SampleImages.png(seed: "tarla")), filename: "tarla.png")
        detail.placeImage(image, into: "photo")
        await waitForVersion(detail, 2)
        #expect(!detail.card.needsImage)
        #expect(detail.layers.first { $0.layerId == "photo" }?.slotState == .filled)
        #expect(detail.layers.first { $0.layerId == "photo" }?.src?.hasPrefix("/media/") == true)
        #expect(detail.canApprove)
        await detail.approve()
        #expect(detail.content.status == .approved)
        #expect(app.posts.card("post-01")?.state == .approved)

        // Logos and text layers are not picture targets.
        detail.placeImage(image, into: "title")
        #expect(detail.error == "Bu katman bir görsel değil.")
    }

    @Test func oldVersionsAreReadOnlyUntilRestored() async throws {
        let app = await makeApp()
        let detail = try await openDetail(app, "post-02a")
        let v1 = try #require(detail.activeVersion)
        detail.setText("title", "DEĞİŞTİ")
        await waitForVersion(detail, 2)

        await detail.selectVersion(1)
        #expect(!detail.isViewingCurrentVersion)
        #expect(detail.editBlocker?.contains("geri yükle") == true)
        #expect(!detail.canApprove)
        detail.setText("title", "OLMAZ")
        #expect(detail.error != nil)

        await detail.restoreDisplayedVersion()
        await waitForVersion(detail, 3)
        #expect(detail.isViewingCurrentVersion)
        #expect(detail.activeVersion?.contentHash == v1.contentHash)
        #expect(detail.versionSummaries.first?.note == "v1 geri yüklendi.")
        #expect(detail.undoManager.undoActionName == "v1 geri yükle")
    }

    @Test func aiRevisionAddsAnAIEditVersion() async throws {
        let app = await makeApp()
        let detail = try await openDetail(app, "post-02a")
        detail.instruction = "Başlığı daha sade yap"
        await detail.sendInstruction()
        await waitForVersion(detail, 2)
        #expect(detail.activeVersion?.origin == .aiEdit)
        #expect(detail.instruction.isEmpty)
        #expect(detail.notice?.contains("v2") == true)
        #expect(detail.canUndo)
    }

    @Test func exportsWriteJpegPngAndPdfFiles() async throws {
        let app = await makeApp()
        let detail = try await openDetail(app, "post-02a")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("studio-mac-export-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }

        let jpegs = await detail.export(.jpeg, slides: nil, to: folder)
        #expect(jpegs.count == 1)
        #expect(FileManager.default.fileExists(atPath: jpegs[0].path))
        #expect(detail.lastExportURLs == jpegs)
        #expect(detail.exportMessage?.contains("kaydedildi") == true)

        let pdfURL = folder.appendingPathComponent("rehber.pdf")
        let written = await detail.export(.pdf, slides: nil, toFile: pdfURL)
        #expect(written == pdfURL)
        #expect(String(decoding: (try Data(contentsOf: pdfURL)).prefix(5), as: UTF8.self) == "%PDF-")

        let pngs = await detail.export(.png, slides: [0], to: folder)
        #expect(pngs.first?.pathExtension == "png")
        // A second export never overwrites the first file.
        let again = await detail.export(.jpeg, slides: nil, to: folder)
        #expect(again.first != jpegs.first)

        #expect(detail.suggestedFilename(.jpeg, slide: nil).hasSuffix("-v1.jpg"))
        detail.copyCaption()
        #expect(NSPasteboard.general.string(forType: .string) == detail.content.caption)
    }

    @Test func captionCountersFollowTheDraft() async throws {
        let app = await makeApp()
        let detail = try await openDetail(app, "post-02a")
        #expect(detail.captionUsage.map(\.platform) == [.instagram, .facebook])
        detail.captionDraft = String(repeating: "a", count: 2_300)
        #expect(detail.captionUsage.first?.isOverLimit == true)
        #expect(detail.captionUsage.last?.isOverLimit == false)
        detail.cancelCaptionEdit()
        #expect(detail.captionUsage.first?.isOverLimit == false)
    }

    @Test func exportMenuOffersSlidesAndPdf() async throws {
        let menu = PostFileExport.menu(target: NSObject(), action: #selector(NSObject.copy), slideCount: 3, currentSlide: 1, disabledReason: nil)
        #expect(menu.items.map(\.title) == [
            "JPEG — bu slayt (2)", "JPEG — tüm slaytlar (3)", "PNG — bu slayt (2)", "PNG — tüm slaytlar (3)", "PDF — carousel (3 sayfa)",
        ])
        let single = PostFileExport.menu(target: NSObject(), action: #selector(NSObject.copy), slideCount: 1, currentSlide: nil, disabledReason: "Yok")
        #expect(single.items.map(\.title) == ["JPEG", "PNG", "PDF"])
        #expect(single.items.allSatisfy { !$0.isEnabled })
        #expect(PostFileExport.fileCount(ExportChoice(format: .pdf, slides: nil), slideCount: 3) == 1)
        #expect(PostFileExport.fileCount(ExportChoice(format: .png, slides: nil), slideCount: 3) == 3)
    }
}
