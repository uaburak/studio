import AppKit
import Foundation
import Observation
import StudioKit

/// An opened post (06): caption and hashtag editing, approve, schedule, AI edit request,
/// real slot-fill (`fillSlotAndRender`), AI slot fill, direct `[data-layer]` editing,
/// version switcher, JPEG / LinkedIn PDF Carousel export, and Reels video playback.
@MainActor
@Observable
final class PostDetailModel {
    enum PanelTab: Int, Equatable {
        case details = 0
        case layers = 1
    }

    unowned let app: AppModel
    private(set) var card: PostCard
    /// Where the card sat on screen (window coordinates), for the zoom transition.
    let sourceFrame: CGRect

    var activeTab: PanelTab = .details
    var selectedSlideIndex = 0

    var captionDraft: String
    var hashtagsDraft: String
    var isEditingCaption = false
    var isSavingCaption = false
    var instruction = ""
    var isSendingInstruction = false
    var instructionSent: Job?
    var isApproving = false
    var error: String?

    // Versions & Layer editor
    private(set) var versionSummaries: [ContentVersionSummary] = []
    private(set) var displayedVersion: ContentVersion?
    private(set) var originalLayers: [SlideLayer] = []
    var editableLayers: [SlideLayer] = []
    private(set) var isApplyingLayers = false

    // Export
    private(set) var isExporting = false
    var exportStatusMessage: String?

    // Reels video playback
    var showReelVideo: Bool
    private(set) var videoPreviewURL: URL?

    // Schedule
    var schedulePresented = false
    var scheduleDate: Date
    var scheduleAccounts: Set<EntityID> = []
    var isScheduling = false

    // Slot image
    enum SlotUpload: Equatable {
        case none
        case uploading(Double)
        case rendering(EntityID)
        case failed(String)
    }

    var slotUpload: SlotUpload = .none
    var slotImage: NSImage?
    private var lastImport: ImportedImage?

    init(app: AppModel, card: PostCard, sourceFrame: CGRect) {
        self.app = app
        self.card = card
        self.sourceFrame = sourceFrame
        self.displayedVersion = card.version
        self.showReelVideo = card.content.type == .reel
        let parts = CaptionParts(caption: card.content.caption)
        captionDraft = parts.body
        hashtagsDraft = parts.hashtags.joined(separator: " ")
        scheduleDate = Self.defaultScheduleDate(for: card)
        scheduleAccounts = Set(
            app.accounts(of: card.content.brandId)
                .filter { $0.status != .disabled && card.content.targetPlatforms.contains($0.platform) }
                .map(\.id)
        )
        syncLayersFromCurrentSlide()
        Task { [weak self] in
            await self?.loadInitialDetails()
        }
    }

    static func defaultScheduleDate(for card: PostCard) -> Date {
        if let schedule = card.schedule { return schedule.scheduledAt }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let base = card.planItem?.date.map { $0.date() } ?? Date().addingTimeInterval(86_400)
        var parts = calendar.dateComponents([.year, .month, .day], from: base)
        parts.hour = 9
        let date = calendar.date(from: parts) ?? base
        return max(date, Date().addingTimeInterval(3600))
    }

    var content: Content { card.content }
    var activeVersion: ContentVersion? { displayedVersion ?? card.version }
    var slides: [Slide] { activeVersion?.slides ?? [] }

    var brandAccount: SocialAccount? {
        app.accounts(of: content.brandId).first { $0.platform == .instagram } ?? app.accounts(of: content.brandId).first
    }

    var handle: String {
        brandAccount.map { $0.handle.hasPrefix("@") ? String($0.handle.dropFirst()) : $0.handle } ?? (app.brand(content.brandId)?.slug ?? "")
    }

    var dateText: String {
        if let schedule = card.schedule { return TurkishFormat.dayAndTime(schedule.scheduledAt) }
        if let day = card.planItem?.date { return TurkishFormat.longDay(day) + ", 09:00" }
        return "Tarih yok"
    }

    var typeText: String { TurkishFormat.typeLabel(content.type, slides: slides) }

    var isViewingCurrentVersion: Bool {
        guard let currentNum = content.currentVersion?.version else { return true }
        guard let shownNum = activeVersion?.version else { return true }
        return currentNum == shownNum
    }

    var canApprove: Bool { isViewingCurrentVersion && card.approvableHash != nil && !isApproving }

    var approveHelp: String {
        if content.status.hasApproval { return "Bu post onaylandı." }
        if !isViewingCurrentVersion { return "Eski bir sürümü görüntülüyorsun; onaylamak için güncel sürüme geç." }
        if content.currentVersion == nil { return "Henüz bir sürüm yok." }
        if card.version == nil { return "Sürüm yükleniyor." }
        if card.approvableHash == nil { return "Gösterilen sürüm sunucudakiyle eşleşmiyor; yenile." }
        return "Bu sürümü onayla (⌘↩)"
    }

    var schedulableAccounts: [SocialAccount] {
        app.accounts(of: content.brandId).filter { $0.status != .disabled && content.targetPlatforms.contains($0.platform) }
    }

    var hasPendingLayerEdits: Bool {
        !SlideLayerScanner.diff(from: originalLayers, to: editableLayers).isEmpty
    }

    var hasVideoCapability: Bool {
        content.type == .reel || videoPreviewURL != nil
    }

    // MARK: - Loading & Versions

    private func loadInitialDetails() async {
        if let summaries = try? await app.dataService.versions(contentId: content.id) {
            versionSummaries = summaries
        }
        if displayedVersion == nil, let ref = content.currentVersion {
            if let v = try? await app.dataService.version(contentId: content.id, version: ref.version) {
                displayedVersion = v
                syncLayersFromCurrentSlide()
            }
        }
        if content.type == .reel {
            await resolveVideoPreviewIfAvailable()
        }
    }

    func reloadVersionsAndContent() async {
        await app.posts.load()
        if let fresh = app.posts.card(content.id) {
            await reloadAfterRender(freshCard: fresh)
        }
    }

    func reloadAfterRender(freshCard: PostCard) async {
        card = freshCard
        displayedVersion = freshCard.version
        if selectedSlideIndex >= slides.count { selectedSlideIndex = max(0, slides.count - 1) }
        if let summaries = try? await app.dataService.versions(contentId: content.id) {
            versionSummaries = summaries
        }
        slotUpload = .none
        syncLayersFromCurrentSlide()
    }

    func selectVersion(_ versionNumber: Int) async {
        do {
            let loaded = try await app.dataService.version(contentId: content.id, version: versionNumber)
            displayedVersion = loaded
            selectedSlideIndex = min(selectedSlideIndex, max(0, loaded.slides.count - 1))
            syncLayersFromCurrentSlide()
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func selectSlide(_ index: Int) {
        let clamped = max(0, min(index, max(0, slides.count - 1)))
        guard clamped != selectedSlideIndex else { return }
        selectedSlideIndex = clamped
        syncLayersFromCurrentSlide()
    }

    func syncLayersFromCurrentSlide() {
        guard slides.indices.contains(selectedSlideIndex) else {
            originalLayers = []
            editableLayers = []
            return
        }
        let scanned = SlideLayerScanner.layers(inHTML: slides[selectedSlideIndex].html, slideIndex: selectedSlideIndex)
        originalLayers = scanned
        editableLayers = scanned
    }

    private func resolveVideoPreviewIfAvailable() async {
        guard let videos = try? await app.dataService.assets(brandId: content.brandId, kind: .video),
              let firstVideo = videos.first else { return }
        if !app.isSample, let url = try? app.settings.makeClient().assetContentURL(firstVideo.id) {
            videoPreviewURL = url
            return
        }
        if let bytes = try? await app.dataService.imageData(assetId: firstVideo.id) {
            let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("studio-reel-\(firstVideo.id).mp4")
            try? bytes.write(to: tempURL)
            videoPreviewURL = tempURL
        }
    }

    // MARK: - Actions

    func refresh(_ updated: Content) {
        card.content = updated
        app.posts.update(updated)
        if let fresh = app.posts.card(updated.id) { card = fresh }
    }

    func saveCaption() async {
        let caption = CaptionParts(
            body: captionDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            hashtags: CaptionParts.parseHashtags(hashtagsDraft)
        ).caption
        guard caption != content.caption else {
            isEditingCaption = false
            return
        }
        isSavingCaption = true
        defer { isSavingCaption = false }
        do {
            refresh(try await app.dataService.updateCaption(contentId: content.id, caption: caption))
            let parts = CaptionParts(caption: content.caption)
            captionDraft = parts.body
            hashtagsDraft = parts.hashtags.joined(separator: " ")
            isEditingCaption = false
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func approve() async {
        guard let hash = card.approvableHash else { return }
        isApproving = true
        defer { isApproving = false }
        do {
            refresh(try await app.dataService.approve(contentId: content.id, hash: hash))
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// Approve first when needed, then one schedule per selected account.
    func schedule() async {
        isScheduling = true
        defer { isScheduling = false }
        do {
            if !content.status.isSchedulable {
                guard let hash = card.approvableHash else {
                    error = "Zamanlamak için önce bu sürümün onaylanması gerekiyor."
                    return
                }
                refresh(try await app.dataService.approve(contentId: content.id, hash: hash))
            }
            for accountId in scheduleAccounts {
                let schedule = try await app.dataService.createSchedule(ScheduleCreate(contentId: content.id, socialAccountId: accountId, scheduledAt: scheduleDate))
                app.posts.scheduleCreated(schedule)
            }
            refresh(try await app.dataService.content(content.id))
            schedulePresented = false
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// "Neyi değiştireyim?": queue a content.generate job with the instruction.
    func sendInstruction() async {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isSendingInstruction = true
        defer { isSendingInstruction = false }
        do {
            instructionSent = try await app.dataService.requestEdit(of: content, instructions: text)
            instruction = ""
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// Apply `[data-layer]` edits (`set_text`, `set_visible`) and re-render!
    func applyLayerEdits() async {
        let patches = SlideLayerScanner.diff(from: originalLayers, to: editableLayers)
        guard !patches.isEmpty, !isApplyingLayers else { return }
        isApplyingLayers = true
        defer { isApplyingLayers = false }
        do {
            let job = try await app.dataService.patchLayersAndRender(contentId: content.id, patches: patches)
            if job.status == .succeeded {
                await reloadVersionsAndContent()
            } else {
                instructionSent = job
                originalLayers = editableLayers
            }
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    // MARK: - Export (JPEG & LinkedIn PDF Carousel)

    func exportJPEG() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(Brand.slugify(content.title))-s\(selectedSlideIndex + 1).jpg"
        guard panel.runModal() == .OK, let dest = panel.url else { return }
        Task {
            isExporting = true
            defer { isExporting = false }
            do {
                if slides.indices.contains(selectedSlideIndex), let renderedId = slides[selectedSlideIndex].renderedAssetId {
                    let bytes = try await app.dataService.imageData(assetId: renderedId)
                    try bytes.write(to: dest)
                    exportStatusMessage = "JPEG kaydedildi: \(dest.lastPathComponent)"
                    return
                }
                let job = try await app.dataService.exportContent(contentId: content.id, format: "jpeg")
                if let arr = job.output?["jpegAssetIds"]?.arrayValue,
                   let firstId = arr.first?.stringValue {
                    let bytes = try await app.dataService.imageData(assetId: firstId)
                    try bytes.write(to: dest)
                    exportStatusMessage = "JPEG kaydedildi: \(dest.lastPathComponent)"
                } else {
                    exportStatusMessage = "JPEG çıktısı kuyruğa alındı (\(job.id))."
                }
            } catch {
                self.error = AppModel.describe(error)
            }
        }
    }

    func exportPDFCarousel() {
        Task {
            isExporting = true
            defer { isExporting = false }
            do {
                let job = try await app.dataService.exportContent(contentId: content.id, format: "pdf")
                if let pdfAssetId = job.output?["pdfAssetId"]?.stringValue {
                    let bytes = try await app.dataService.imageData(assetId: pdfAssetId)
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = "\(Brand.slugify(content.title))-carousel.pdf"
                    if panel.runModal() == .OK, let dest = panel.url {
                        try bytes.write(to: dest)
                        exportStatusMessage = "LinkedIn PDF Carousel kaydedildi: \(dest.lastPathComponent)"
                    }
                } else {
                    exportStatusMessage = "LinkedIn PDF Carousel üretimi kuyruğa alındı (\(job.id)). Medya kütüphanesinden indirebilirsin."
                }
            } catch {
                self.error = AppModel.describe(error)
            }
        }
    }

    // MARK: - Slot Image & AI Slot Fill

    func openAISlotGenerator(slotId: String? = nil) {
        let resolvedSlot = slotId ?? card.slots.first(where: \.isEmpty)?.layerId ?? card.slots.first?.layerId ?? "photo"
        let prompt = card.planItem?.imageBrief ?? (content.brief.isEmpty ? content.title : content.brief)
        app.aiGeneratorTarget = AIGeneratorTarget(
            brandId: content.brandId,
            targetContentId: content.id,
            targetSlotId: resolvedSlot,
            initialPrompt: prompt
        )
    }

    func importSlotImage(urls: [URL], slotId: String? = nil) {
        guard let url = urls.first else { return }
        do {
            uploadSlotImage(try ImageImport.from(url: url), slotId: slotId)
        } catch {
            slotUpload = .failed(error.localizedDescription)
        }
    }

    func uploadSlotImage(_ image: ImportedImage, slotId: String? = nil) {
        lastImport = image
        slotImage = image.thumbnail
        slotUpload = .uploading(0)
        let service = app.dataService
        let brandId = content.brandId
        let contentId = content.id
        let version = content.currentVersion?.version
        let targetSlot = slotId ?? card.slots.first(where: \.isEmpty)?.layerId ?? card.slots.first?.layerId ?? "photo"
        Task {
            do {
                let asset = try await service.uploadImage(image.file, brandId: brandId) { progress in
                    Task { @MainActor in
                        if case .uploading = self.slotUpload { self.slotUpload = .uploading(progress) }
                    }
                }
                app.images.seed(image.thumbnail, for: asset.id)
                app.pendingImages.save(PendingSlotImage(contentId: contentId, assetId: asset.id, forVersion: version, uploadedAt: .now))
                slotUpload = .rendering(asset.id)
                let job = try await service.fillSlotAndRender(contentId: contentId, slotId: targetSlot, assetId: asset.id)
                await app.posts.load()
                if let fresh = app.posts.card(contentId) {
                    await reloadAfterRender(freshCard: fresh)
                }
                if job.status != .succeeded && card.needsImage {
                    slotUpload = .rendering(asset.id)
                } else {
                    slotUpload = .none
                }
            } catch {
                slotUpload = .failed(AppModel.describe(error))
            }
        }
    }

    func retrySlotUpload() {
        if let lastImport { uploadSlotImage(lastImport) }
    }
}

private extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case .array(let arr) = self { return arr }
        return nil
    }
}
