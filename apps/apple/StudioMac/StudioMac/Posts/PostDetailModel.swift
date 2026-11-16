import AppKit
import Foundation
import Observation
import StudioKit

/// An opened post (06) and its editor.
///
/// Every design change goes through the API's patch path: the edit becomes design-kit
/// patch ops, a `content.render` job stores a new `manual_edit` version and renders it,
/// and the model swaps in the new version when the job is done. Undo restores the
/// previous version (a new version with the same hash), redo restores the edited one.
@MainActor
@Observable
final class PostDetailModel {
    enum Tab: Int, CaseIterable {
        case post, edit, versions

        var label: String {
            switch self {
            case .post: "Post"
            case .edit: "Düzenle"
            case .versions: "Sürümler"
            }
        }
    }

    /// What the post is busy with (the canvas shows it; edits queue behind it).
    enum Activity: Equatable {
        case idle
        case uploading(Double)
        case rendering(String)
        case measuring
        case revising(String)
        case restoring

        var isBusy: Bool { self != .idle }

        /// Busy with something that changes the version (measuring boxes does not).
        var changesVersion: Bool { self != .idle && self != .measuring }

        var message: String {
            switch self {
            case .idle: ""
            case .uploading(let p): "Görsel yükleniyor %\(Int(p * 100))"
            case .rendering(let m): m.isEmpty ? "Render ediliyor" : m
            case .measuring: "Katmanlar ölçülüyor"
            case .revising(let m): m.isEmpty ? "AI düzenliyor" : m
            case .restoring: "Sürüm geri yükleniyor"
            }
        }
    }

    /// Strong on purpose: loads and renders outlive a closed overlay, and the app model lives
    /// as long as the app (the `app.detail` cycle ends when the overlay closes).
    let app: AppModel
    private(set) var card: PostCard
    /// Where the card sat on screen (window coordinates), for the zoom transition.
    let sourceFrame: CGRect

    var tab: Tab = .post
    private(set) var selectedSlideIndex = 0
    /// Selected layer of the current slide (`data-layer` id).
    var selectedLayerId: String?

    // Versions
    private(set) var versionSummaries: [ContentVersionSummary] = []
    private(set) var displayedVersion: ContentVersion?

    // Caption
    var captionDraft: String
    var hashtagsDraft: String
    var isEditingCaption = false
    private(set) var isSavingCaption = false

    // "Neyi değiştireyim?"
    var instruction = ""
    private(set) var revisionJobId: EntityID?

    // Edit pipeline
    private(set) var activity: Activity = .idle
    /// Boxes (artboard px) of layers moved or resized while their render runs.
    private(set) var previewBoxes: [String: CGRect] = [:]
    /// Transforms sent but not yet in a loaded version (so queued edits build on them).
    private var pendingTransforms: [String: LayerTransform] = [:]
    private var queuedPatches: [DesignPatch] = []
    private var queuedName = ""
    private var measuredVersionIds: Set<EntityID> = []
    private var nudgeTask: Task<Void, Never>?
    private var nudgeDelta: CGSize = .zero
    let undoManager = UndoManager()

    // Approve & schedule
    private(set) var isApproving = false
    var schedulePresented = false
    var scheduleDate: Date
    var scheduleAccounts: Set<EntityID> = []
    private(set) var isScheduling = false

    // Export
    private(set) var isExporting = false
    private(set) var exportMessage: String?
    /// Files written by the last export (for "Finder'da göster").
    private(set) var lastExportURLs: [URL] = []

    var error: String?
    /// Short confirmation under the panel ("Açıklama kopyalandı").
    var notice: String?

    // Reels
    var showReelVideo: Bool
    private(set) var videoPreviewURL: URL?

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
                .map(\.id))
        undoManager.levelsOfUndo = 50
        Task { [weak self] in await self?.loadInitialDetails() }
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

    // MARK: - Derived

    var content: Content { card.content }
    var activeVersion: ContentVersion? { displayedVersion ?? card.version }
    var slides: [Slide] { activeVersion?.slides ?? [] }
    var currentSlide: Slide? { slides.indices.contains(selectedSlideIndex) ? slides[selectedSlideIndex] : nil }
    var artboardSize: CGSize { CGSize(width: currentSlide?.width ?? 1080, height: currentSlide?.height ?? 1350) }

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
        guard let current = content.currentVersion?.version, let shown = activeVersion?.version else { return true }
        return current == shown
    }

    var canApprove: Bool { isViewingCurrentVersion && card.approvableHash != nil && !isApproving && !activity.changesVersion }

    var approveHelp: String {
        if content.status.hasApproval { return "Bu post onaylandı." }
        if activity.changesVersion { return "Değişiklik render edilirken onaylanamaz." }
        if !isViewingCurrentVersion { return "Eski bir sürümü görüntülüyorsun; onaylamak için güncel sürüme geç ya da bu sürümü geri yükle." }
        if content.currentVersion == nil { return "Henüz bir sürüm yok." }
        if card.version == nil { return "Sürüm yükleniyor." }
        if card.approvableHash == nil { return "Gösterilen sürüm sunucudakiyle eşleşmiyor; yenile." }
        return "Bu sürümü onayla (⌘↩)"
    }

    var schedulableAccounts: [SocialAccount] {
        app.accounts(of: content.brandId).filter { $0.status != .disabled && content.targetPlatforms.contains($0.platform) }
    }

    var hasVideoCapability: Bool { content.type == .reel || videoPreviewURL != nil }

    /// Why the design cannot be edited right now (nil = it can).
    var editBlocker: String? {
        if content.type == .reel { return "Reels düzenleme henüz bu ekranda yok." }
        if content.status.isLocked { return "Yayındaki post düzenlenemez." }
        guard activeVersion != nil else { return "Henüz bir tasarım sürümü yok." }
        if !isViewingCurrentVersion { return "Eski bir sürümü görüntülüyorsun; düzenlemek için önce geri yükle." }
        if case .revising = activity { return "AI düzenlemesi sürüyor." }
        if activity == .restoring { return "Sürüm geri yükleniyor." }
        return nil
    }

    var canEdit: Bool { editBlocker == nil }

    /// `[data-layer]` elements of the current slide, in document order.
    var layers: [SlideLayer] {
        guard let slide = currentSlide else { return [] }
        return SlideLayerScanner.layers(inHTML: slide.html, slideIndex: selectedSlideIndex)
    }

    /// Measured boxes of the current slide (nil until a render measured them).
    var layerBoxes: [SlideLayerBox]? { currentSlide?.layers }

    var selectedLayer: SlideLayer? { selectedLayerId.flatMap { id in layers.first { $0.layerId == id } } }

    func box(for layerId: String) -> CGRect? {
        if let preview = previewBoxes[layerId] { return preview }
        return layerBoxes?.first { $0.id == layerId }?.rect
    }

    /// The editor transform a layer has, including edits still rendering.
    func transform(of layerId: String) -> LayerTransform {
        pendingTransforms["\(selectedSlideIndex):\(layerId)"] ?? layers.first { $0.layerId == layerId }?.transform ?? .identity
    }

    var captionUsage: [CaptionLimits.Usage] {
        CaptionLimits.usage(caption: composedCaption, platforms: content.targetPlatforms)
    }

    private var composedCaption: String {
        CaptionParts(
            body: captionDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            hashtags: CaptionParts.parseHashtags(hashtagsDraft)
        ).caption
    }

    // MARK: - Loading & versions

    private func loadInitialDetails() async {
        await refreshVersionList()
        if displayedVersion == nil, let ref = content.currentVersion {
            if let version = try? await app.dataService.version(contentId: content.id, version: ref.version) {
                displayedVersion = version
            }
        }
        if content.type == .reel {
            await resolveVideoPreviewIfAvailable()
        }
        ensureLayouts()
    }

    private func refreshVersionList() async {
        if let summaries = try? await app.dataService.versions(contentId: content.id) {
            versionSummaries = summaries
        }
    }

    /// A content job for this post finished outside this screen (chat, AI image, another device).
    func reloadVersionsAndContent() async {
        guard !activity.isBusy else { return }
        guard let fresh = try? await app.dataService.content(content.id) else { return }
        let wasCurrent = isViewingCurrentVersion
        card.content = fresh
        if wasCurrent, let ref = fresh.currentVersion, ref.version != displayedVersion?.version {
            await adopt(versionNumber: ref.version)
        } else {
            await refreshVersionList()
        }
    }

    /// Compatibility entry for screens that reload the posts board themselves.
    func reloadAfterRender(freshCard: PostCard) async {
        guard !activity.isBusy else { return }
        card = freshCard
        displayedVersion = freshCard.version
        clampSlide()
        await refreshVersionList()
        ensureLayouts()
    }

    /// Show another version (read only unless it is the current one).
    func selectVersion(_ versionNumber: Int) async {
        do {
            let loaded = try await app.dataService.version(contentId: content.id, version: versionNumber)
            displayedVersion = loaded
            clampSlide()
            if selectedLayerId != nil, !layers.contains(where: { $0.layerId == selectedLayerId }) { selectedLayerId = nil }
            error = nil
            ensureLayouts()
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func selectSlide(_ index: Int) {
        let clamped = max(0, min(index, max(0, slides.count - 1)))
        guard clamped != selectedSlideIndex else { return }
        selectedSlideIndex = clamped
        selectedLayerId = nil
        ensureLayouts()
    }

    private func clampSlide() {
        if selectedSlideIndex >= slides.count { selectedSlideIndex = max(0, slides.count - 1) }
    }

    /// Load `versionNumber` as the post's new current version (after an edit, restore or AI revision).
    private func adopt(versionNumber: Int) async {
        do {
            async let loadedVersion = app.dataService.version(contentId: content.id, version: versionNumber)
            async let loadedContent = app.dataService.content(content.id)
            let version = try await loadedVersion
            let fresh = try await loadedContent
            app.posts.store(version, content: fresh)
            if let updated = app.posts.card(fresh.id) { card = updated }
            card.content = fresh
            if version.version == fresh.currentVersion?.version { card.version = version }
            displayedVersion = version
            pendingTransforms = [:]
            previewBoxes = [:]
            clampSlide()
            if let selected = selectedLayerId, !layers.contains(where: { $0.layerId == selected }) { selectedLayerId = nil }
            await refreshVersionList()
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// Versions rendered before layer boxes were stored get measured once (needs the Mac worker).
    func ensureLayouts() {
        guard let version = activeVersion, isViewingCurrentVersion, content.type != .reel,
              version.slides.contains(where: { $0.layers == nil }),
              !measuredVersionIds.contains(version.id), activity == .idle,
              app.isSample || app.isOnline
        else { return }
        measuredVersionIds.insert(version.id)
        activity = .measuring
        let service = app.dataService
        let contentId = content.id
        Task {
            defer { if activity == .measuring { activity = .idle } }
            do {
                let job = try await service.render(contentId: contentId, ContentRenderRequest(version: version.version, format: .jpeg))
                _ = try await service.waitForJob(job.id, timeout: .seconds(180))
                let measured = try await service.version(contentId: contentId, version: version.version)
                if displayedVersion?.id == measured.id { displayedVersion = measured }
                if card.version?.id == measured.id { card.version = measured }
                app.posts.store(measured)
            } catch {
                // The editor still works from the layer list; boxes appear after the next render.
            }
        }
    }

    // MARK: - Editing (design patches -> new version)

    func select(layer id: String?) {
        selectedLayerId = id
        if id != nil, tab == .post { tab = .edit }
        ensureLayouts()
    }

    func setText(_ layerId: String, _ text: String) {
        guard let layer = layers.first(where: { $0.layerId == layerId }), layer.text != text else { return }
        submit([DesignPatch(slide: selectedSlideIndex, .setText(layer: layerId, text: text))], name: "Metni değiştir")
    }

    func setHidden(_ layerId: String, _ hidden: Bool) {
        submit([DesignPatch(slide: selectedSlideIndex, .setVisibility(layer: layerId, hidden: hidden))], name: hidden ? "Katmanı gizle" : "Katmanı göster")
    }

    /// Move a layer by `delta` artboard px (drag end, arrow keys, inspector).
    func move(_ layerId: String, by delta: CGSize) {
        guard delta != .zero else { return }
        let current = transform(of: layerId)
        let next = LayerTransformMath.moved(current, by: delta)
        applyTransform(layerId, from: current, to: next, name: "Taşı")
    }

    /// Resize a layer by `factor` with its top-left corner fixed (corner handle, inspector).
    func resize(_ layerId: String, factor: Double) {
        guard factor > 0, abs(factor - 1) > 0.001, let box = box(for: layerId) else { return }
        let current = transform(of: layerId)
        let next = LayerTransformMath.resized(current, box: box, factor: factor)
        applyTransform(layerId, from: current, to: next, name: "Boyutlandır")
    }

    /// Set the absolute editor transform (inspector fields); `nil` keeps a component.
    func setTransform(_ layerId: String, translate: CGPoint? = nil, scale: Double? = nil) {
        let current = transform(of: layerId)
        var next = current
        if let translate { next.translate = translate }
        if let scale { next.scale = min(20, max(0.05, scale)) }
        guard next != current else { return }
        if let scale, let box = box(for: layerId), translate == nil {
            next = LayerTransformMath.resized(current, box: box, factor: scale / max(current.scale, 0.0001))
        }
        applyTransform(layerId, from: current, to: next, name: scale != nil ? "Boyutlandır" : "Taşı")
    }

    /// Restore the layer's original placement (translate and scale removed).
    func resetTransform(_ layerId: String) {
        let current = transform(of: layerId)
        guard current != .identity else { return }
        applyTransform(layerId, from: current, to: .identity, name: "Konumu sıfırla")
    }

    /// Arrow-key nudges, sent as one edit once the keys rest.
    func nudge(_ layerId: String, dx: CGFloat, dy: CGFloat) {
        nudgeDelta.width += dx
        nudgeDelta.height += dy
        if let box = box(for: layerId) { previewBoxes[layerId] = box.offsetBy(dx: dx, dy: dy) }
        nudgeTask?.cancel()
        nudgeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled, let self else { return }
            let delta = self.nudgeDelta
            self.nudgeDelta = .zero
            self.previewBoxes[layerId] = nil
            self.move(layerId, by: delta)
        }
    }

    private func applyTransform(_ layerId: String, from current: LayerTransform, to next: LayerTransform, name: String) {
        guard canEdit else {
            error = editBlocker
            return
        }
        if let box = box(for: layerId) {
            previewBoxes[layerId] = LayerTransformMath.previewBox(box, from: current, to: next)
        }
        pendingTransforms["\(selectedSlideIndex):\(layerId)"] = next
        submit([DesignPatch(slide: selectedSlideIndex, .transform(layer: layerId, translate: next.translate, scale: next.scale))], name: name)
    }

    /// Put a picture from disk into an image layer (replace) or a slot (fill).
    func placeImage(from url: URL, into layerId: String) {
        do {
            placeImage(try ImageImport.from(url: url), into: layerId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func placeImage(_ image: ImportedImage, into layerId: String) {
        guard canEdit else {
            error = editBlocker
            return
        }
        guard let layer = layers.first(where: { $0.layerId == layerId }) else { return }
        guard layer.kind == .slot || layer.kind == .image else {
            error = layer.kind == .logo ? "Logo marka kitinden gelir; buradan değiştirilemez." : "Bu katman bir görsel değil."
            return
        }
        let slide = selectedSlideIndex
        let service = app.dataService
        let brandId = content.brandId
        activity = .uploading(0)
        Task {
            do {
                let asset = try await service.uploadImage(image.file, brandId: brandId) { progress in
                    Task { @MainActor in if case .uploading = self.activity { self.activity = .uploading(progress) } }
                }
                app.images.seed(image.thumbnail, for: asset.id)
                activity = .idle
                let src = DesignPatch.mediaSource(assetId: asset.id, mimeType: asset.mimeType)
                let op: DesignPatch.Operation = layer.kind == .slot ? .fillSlot(layer: layerId, src: src) : .replaceImage(layer: layerId, src: src)
                submit([DesignPatch(slide: slide, op)], name: layer.kind == .slot ? "Yuvayı doldur" : "Görseli değiştir")
            } catch {
                activity = .idle
                self.error = AppModel.describe(error)
            }
        }
    }

    /// A picture dropped on the canvas at an artboard point: the slot or image under it,
    /// else the only empty slot of the slide.
    func dropImage(_ url: URL, at point: CGPoint?) {
        let target = dropTarget(at: point)
        guard let target else {
            error = "Görseli bir görsel yuvasının ya da görsel katmanının üzerine bırak."
            return
        }
        placeImage(from: url, into: target)
    }

    func dropTarget(at point: CGPoint?) -> String? {
        let imageLayers = layers.filter { $0.kind == .slot || $0.kind == .image }
        if let point, let boxes = layerBoxes {
            let candidates = boxes.filter { box in imageLayers.contains { $0.layerId == box.id } }
            if let hit = SlideCanvasGeometry.hitTest(point, in: candidates) { return hit.id }
        }
        let empty = imageLayers.filter { $0.kind == .slot && $0.slotState != .filled }
        if empty.count == 1 { return empty[0].layerId }
        return point == nil ? (empty.first ?? imageLayers.first)?.layerId : nil
    }

    func clearSlot(_ layerId: String) {
        submit([DesignPatch(slide: selectedSlideIndex, .clearSlot(layer: layerId))], name: "Yuvayı boşalt")
    }

    /// AI image for a slot (the media screen's generator fills it when done).
    func openAISlotGenerator(slotId: String? = nil) {
        let resolved = slotId ?? PostsModel.targetSlot(card.slots)?.layerId ?? "photo"
        let prompt = card.planItem?.imageBrief ?? (content.brief.isEmpty ? content.title : content.brief)
        app.aiGeneratorTarget = AIGeneratorTarget(
            brandId: content.brandId, targetContentId: content.id, targetSlotId: resolved, initialPrompt: prompt)
    }

    /// Send an edit; while another edit renders, it waits and goes out right after on the new version.
    private func submit(_ patches: [DesignPatch], name: String) {
        guard canEdit else {
            error = editBlocker
            return
        }
        if activity.changesVersion {
            queuedPatches += patches
            queuedName = name
            return
        }
        start(patches, name: name)
    }

    private func start(_ patches: [DesignPatch], name: String) {
        guard let base = activeVersion?.version else { return }
        activity = .rendering("Render ediliyor")
        error = nil
        let service = app.dataService
        let contentId = content.id
        Task {
            do {
                let job = try await service.render(contentId: contentId, ContentRenderRequest(version: base, patches: patches))
                let done = try await service.waitForJob(job.id, timeout: .seconds(180)) { job in
                    Task { @MainActor in
                        if case .rendering = self.activity, let message = job.progressMessage, !message.isEmpty {
                            self.activity = .rendering(message)
                        }
                    }
                }
                let output = ContentRenderOutput(done.output)
                if !output.unchanged, let number = output.version, number != base {
                    await adopt(versionNumber: number)
                    registerUndo(from: base, to: number, name: name)
                } else {
                    previewBoxes = [:]
                    pendingTransforms = [:]
                }
            } catch {
                previewBoxes = [:]
                pendingTransforms = [:]
                self.error = "\(name): \(AppModel.describe(error))"
            }
            activity = .idle
            if !queuedPatches.isEmpty {
                let next = queuedPatches
                let nextName = queuedName
                queuedPatches = []
                start(next, name: nextName)
            }
        }
    }

    // MARK: - Undo / redo (versions)

    var canUndo: Bool { undoManager.canUndo && !activity.changesVersion }
    var canRedo: Bool { undoManager.canRedo && !activity.changesVersion }

    func undo() {
        guard canUndo else { return }
        undoManager.undo()
    }

    func redo() {
        guard canRedo else { return }
        undoManager.redo()
    }

    private func registerUndo(from base: Int, to edited: Int, name: String) {
        undoManager.registerUndo(withTarget: self) { model in
            model.restoreForUndo(base, inverse: edited, name: name)
        }
        undoManager.setActionName(name)
    }

    /// Undo and redo both restore a version; each registers the opposite restore.
    private func restoreForUndo(_ target: Int, inverse other: Int, name: String) {
        undoManager.registerUndo(withTarget: self) { model in
            model.restoreForUndo(other, inverse: target, name: name)
        }
        undoManager.setActionName(name)
        Task { await restore(version: target) }
    }

    /// "Bu sürümü geri yükle": add a copy of `version` as the new current version.
    func restoreDisplayedVersion() async {
        guard let shown = activeVersion?.version, let current = content.currentVersion?.version, shown != current else { return }
        if let restored = await restore(version: shown) {
            registerUndo(from: current, to: restored, name: "v\(shown) geri yükle")
        }
    }

    @discardableResult
    private func restore(version: Int) async -> Int? {
        guard !content.status.isLocked else {
            error = "Yayındaki postun sürümü değiştirilemez."
            return nil
        }
        activity = .restoring
        defer { activity = .idle }
        do {
            let restored = try await app.dataService.restoreVersion(contentId: content.id, version: version)
            await adopt(versionNumber: restored.version)
            error = nil
            return restored.version
        } catch {
            self.error = AppModel.describe(error)
            return nil
        }
    }

    // MARK: - "Neyi değiştireyim?" (AI revision)

    func sendInstruction() async {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let base = activeVersion?.version, isViewingCurrentVersion else {
            error = activeVersion == nil ? "Henüz bir tasarım yok." : "Eski bir sürümü görüntülüyorsun; önce geri yükle."
            return
        }
        guard !activity.changesVersion else {
            error = "Önceki değişiklik bitince yeniden dene."
            return
        }
        activity = .revising("İstek Mac'e gönderiliyor")
        error = nil
        let service = app.dataService
        do {
            let job = try await service.requestRevision(of: content, baseVersion: base, instructions: text)
            revisionJobId = job.id
            instruction = ""
            let done = try await service.waitForJob(job.id, timeout: .seconds(1200), interval: .seconds(1.5)) { job in
                Task { @MainActor in
                    let message = job.status == .queued
                        ? (self.app.isOnline ? "Sırada" : "Mac'teki işçiyi bekliyor")
                        : (job.progressMessage ?? "AI düzenliyor")
                    if case .revising = self.activity { self.activity = .revising(message) }
                }
            }
            if let number = done.output?["version"]?.doubleValue.map({ Int($0) }), number != base {
                await adopt(versionNumber: number)
                registerUndo(from: base, to: number, name: "AI düzenlemesi")
                notice = "AI düzenlemesi v\(number) olarak kaydedildi."
            }
        } catch {
            self.error = "AI düzenlemesi: \(AppModel.describe(error))"
            if instruction.isEmpty { instruction = text }
        }
        revisionJobId = nil
        activity = .idle
    }

    func cancelRevision() async {
        guard let id = revisionJobId else { return }
        _ = try? await app.dataService.cancelJob(id)
    }

    // MARK: - Caption, approve, schedule

    func refresh(_ updated: Content) {
        card.content = updated
        app.posts.update(updated)
        if let fresh = app.posts.card(updated.id) { card = fresh }
    }

    func saveCaption() async {
        let caption = composedCaption
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

    func cancelCaptionEdit() {
        let parts = CaptionParts(caption: content.caption)
        captionDraft = parts.body
        hashtagsDraft = parts.hashtags.joined(separator: " ")
        isEditingCaption = false
    }

    func approve() async {
        guard canApprove, let hash = card.approvableHash else { return }
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

    // MARK: - Export, share, copy

    /// Export `format` for `slides` (nil = all) into `folder`; returns the written files.
    @discardableResult
    func export(_ format: PostExportFormat, slides: [Int]?, to folder: URL) async -> [URL] {
        guard let version = activeVersion else {
            error = "Dışa aktarılacak bir sürüm yok."
            return []
        }
        isExporting = true
        exportMessage = "\(format.label) hazırlanıyor"
        defer { isExporting = false }
        do {
            let exporter = PostExporter(service: app.dataService)
            let files = try await exporter.export(content: content, version: version, format: format, slides: slides) { message in
                Task { @MainActor in self.exportMessage = message }
            }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var urls: [URL] = []
            for file in files {
                let url = Self.uniqueURL(folder.appendingPathComponent(file.filename))
                try file.data.write(to: url, options: .atomic)
                urls.append(url)
            }
            lastExportURLs = urls
            exportMessage = urls.count == 1 ? "\(urls[0].lastPathComponent) kaydedildi" : "\(urls.count) dosya kaydedildi"
            error = nil
            return urls
        } catch {
            exportMessage = nil
            self.error = "Dışa aktarma: \(AppModel.describe(error))"
            return []
        }
    }

    /// Export to one chosen file (single slide or PDF).
    @discardableResult
    func export(_ format: PostExportFormat, slides: [Int]?, toFile url: URL) async -> URL? {
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("studio-export-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temp) }
        guard let written = await export(format, slides: slides, to: temp).first else { return nil }
        do {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            try FileManager.default.moveItem(at: written, to: url)
            lastExportURLs = [url]
            exportMessage = "\(url.lastPathComponent) kaydedildi"
            return url
        } catch {
            self.error = "Dışa aktarma: \(error.localizedDescription)"
            return nil
        }
    }

    /// Default file name for a single-file export.
    func suggestedFilename(_ format: PostExportFormat, slide: Int?) -> String {
        let base = PostExporter.baseName(title: content.title, version: activeVersion?.version ?? 1)
        if let slide, slides.count > 1 { return "\(base)-\(slide + 1).\(format.fileExtension)" }
        return "\(base).\(format.fileExtension)"
    }

    /// JPEGs of every slide in a cache folder, for the share sheet.
    func shareableFiles() async -> [URL] {
        let folder = Self.shareFolder.appendingPathComponent("\(content.id)-v\(activeVersion?.version ?? 0)")
        try? FileManager.default.removeItem(at: folder)
        return await export(.jpeg, slides: nil, to: folder)
    }

    static var shareFolder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Studio/Paylaş", isDirectory: true)
    }

    func copyCaption() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(content.caption, forType: .string)
        notice = "Açıklama kopyalandı."
    }

    func revealLastExport() {
        guard !lastExportURLs.isEmpty else { return }
        NSWorkspace.shared.activateFileViewerSelecting(lastExportURLs)
    }

    static func uniqueURL(_ url: URL) -> URL {
        guard FileManager.default.fileExists(atPath: url.path) else { return url }
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        for n in 2...999 {
            let candidate = url.deletingLastPathComponent().appendingPathComponent("\(base) \(n)").appendingPathExtension(ext)
            if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return url
    }

    // MARK: - Duplicate & delete

    /// Duplicate and open the copy.
    func duplicate() async {
        if let copy = await app.posts.duplicate(card), let copyCard = app.posts.card(copy.id) {
            app.detail = PostDetailModel(app: app, card: copyCard, sourceFrame: .zero)
        } else if let message = app.posts.error {
            error = message
        }
    }

    var deletionBlocker: String? { PostsModel.deletionBlocker(card) }

    func delete() async {
        await app.posts.delete(card)
        if app.detail === self, let message = app.posts.error { error = message }
    }

    // MARK: - Reels

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
}
